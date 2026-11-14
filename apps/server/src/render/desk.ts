import {
  FrameState,
  actorKeypoints,
  defaultAoRadius,
  depthToBytes,
  drawLines,
  edgesToBytes,
  encodePNG,
  evaluatedBounds,
  hiddenByScale,
  normalToRGB,
  renderItems,
  renderSceneSoftware,
  resolveView,
  type EvaluatedScene,
  type Mat4,
  type RenderItem,
  type SceneDoc,
  type SceneEvaluator,
  type ScreenLine,
  type SoftwareAovName,
  type SoftwareRenderOptions,
  type Vec3,
} from '@3d-editor/core';
import {
  ScreenBoxBuilder,
  cameraOfView,
  drawLineRGB,
  drawSkeleton,
  maskFromObjects,
  projectPoint,
  projectSegment,
  stringPolyline,
  worldPositions,
  type Projection,
  type ScreenPoint,
} from './passes';
import type {
  DeskFrameOptions,
  DeskShotInfo,
  DeskShotOptions,
  FrameMeta,
  ImageResult,
  PassName,
  Vec3Tuple,
} from './protocol';

/*
 * Director's desk renders in the render process (video exports, SPEC §9): the frame is rasterized
 * with the desk look (shadows, ambient occlusion, MSAA-style shading, tone-mapped resolve, dither)
 * and the per-pixel passes the export asked for; the passes, the strings drawn as lines, the actors'
 * skeletons, the camera and the subjects' screen boxes are computed here from the same evaluation,
 * so the server's event loop only writes bytes to ffmpeg.
 *
 * Objects hidden by their scale (core `hiddenByScale`: the scale-1e-8 keys of desk.tether_fly's
 * after: 'hide' and of the rideo import, which also collapse their children) are not in the frame:
 * no skeleton, no string line, no subject box (the subject reads `hidden`), and they count in none of
 * a shot's measurements. Their collapsed triangles cover no pixel (the rasterizer drops them), so
 * the per-pixel passes have none of them either.
 */

/** Objects larger than this (m, horizontally) are grounds or sky domes: left out of shadow boxes. */
const HUGE_OBJECT_M = 50;
/** Size of the depth probe renders of `desk-shot` (pixels). */
const PROBE_WIDTH = 96;
/** Frames `desk-shot` samples at most. */
const MAX_SHOT_SAMPLES = 8;

/** A document of the render thread, as the engine caches it. */
export interface DeskDocument {
  doc: SceneDoc;
  evaluator: SceneEvaluator;
  /** The rigid body matrices of `frame` the render uses (null: nothing simulated). */
  simulated(frame: number): ReadonlyMap<string, Mat4> | null;
}

/** The ancestry of each evaluated object: itself, its parents and its actor (desk_actor). */
class Ancestry {
  private readonly memo = new Map<string, string[]>();
  constructor(private readonly scene: EvaluatedScene) {}

  of(id: string): string[] {
    let out = this.memo.get(id);
    if (out) return out;
    out = [];
    const seen = new Set<string>();
    for (let cur: string | null = id; cur && !seen.has(cur);) {
      seen.add(cur);
      out.push(cur);
      const o = this.scene.byId.get(cur);
      const actor = o?.data.custom_props?.desk_actor;
      if (typeof actor === 'string' && actor && !seen.has(actor)) {
        // an actor's part belongs to its actor first (parts are BONE-parented to it anyway)
        out.push(...this.of(actor).filter((a) => !seen.has(a)));
        break;
      }
      cur = o?.data.parent ?? null;
    }
    this.memo.set(id, out);
    return out;
  }

  /** Ancestors-or-self of a render item: of its owner (the instancer) and of its object. */
  ofItem(item: RenderItem): string[] {
    if (item.ownerId === item.object.id) return this.of(item.ownerId);
    return [...new Set([...this.of(item.ownerId), ...this.of(item.object.id)])];
  }
}

/**
 * World-space points of the polyline a string object runs along at this frame (none: empty, also
 * when the string is hidden by its scale: a long one would still leave a dot of its line width).
 */
export function stringPoints(scene: EvaluatedScene, objectId: string): Vec3[] {
  const o = scene.byId.get(objectId);
  if (!o || !o.renderVisible || hiddenByScale(o.worldMatrix)) return [];
  const local = o.mesh && o.mesh.positions.length >= 6 ? o.mesh.positions : o.lines;
  if (!local || local.length < 6) return [];
  return stringPolyline(worldPositions(local, o.worldMatrix));
}

/**
 * The segment `a`–`b` with its ends in the order they appear from left to right on screen (seen
 * through `viewProj`, after the near-plane clip core drawLines makes: z ≥ −w). Core drawLines
 * covers only part of a segment whose screen x decreases from its first end to its second (its
 * per-row column span is taken from the ends in the given order), so strings running right to left
 * came out thin and broken in the beauty image and the passes; the order changes nothing else.
 */
export function leftToRight(viewProj: ArrayLike<number>, a: Vec3, b: Vec3): [Vec3, Vec3] {
  const M = viewProj;
  const clipX = (p: Vec3) => M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12];
  const clipW = (p: Vec3) => M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
  // z + w: how far in front of the near plane (negative: behind it)
  const front = (p: Vec3) => M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14] + clipW(p);
  let xa = clipX(a);
  let wa = clipW(a);
  let xb = clipX(b);
  let wb = clipW(b);
  const ea = front(a);
  const eb = front(b);
  if (ea < 0 && eb < 0) return [a, b];
  if (ea < 0 || eb < 0) {
    // the end behind the near plane moves onto it, as drawLines clips it
    const t = ea / (ea - eb);
    const x = xa + (xb - xa) * t;
    const w = wa + (wb - wa) * t;
    if (ea < 0) {
      xa = x;
      wa = w;
    } else {
      xb = x;
      wb = w;
    }
  }
  if (!(wa > 0) || !(wb > 0)) return [a, b];
  return xa / wa > xb / wb ? [b, a] : [a, b];
}

/**
 * The core renderer options of a desk frame (RASTER, the desk look; lines and AOVs added by the
 * caller). A frame whose beauty image is not wanted (an export of depth, mask, pose… passes only)
 * is rendered without shadows and ambient occlusion: they only change the image's colours, never
 * the per-pixel passes (depth, normal, object), which stay exactly those of a frame with its
 * beauty image. The look and the samples stay: the look decides alpha clipping and bump normals,
 * the samples which surface each pixel's passes take. The shot's shadow box and occlusion reach
 * (`shadowFit`, `aoRadius`) hold shadows and occlusion still within a shot.
 */
export function deskRenderOptions(
  base: SoftwareRenderOptions,
  desk: DeskFrameOptions,
  beauty = true,
): SoftwareRenderOptions {
  return {
    ...base,
    engine: 'RASTER',
    look: desk.look,
    shadows: beauty && desk.shadows,
    ao: beauty && desk.ao,
    aoRadius: desk.aoRadius,
    msaa: desk.msaa,
    shadowFit: desk.shadowFit,
    resolve: 'tonemap',
    dither: true,
  };
}

/** The AOVs a desk frame needs for its passes (and for depth-testing strings in them). */
export function deskAovs(passes: ReadonlySet<PassName>, strings: boolean): SoftwareAovName[] {
  const out: SoftwareAovName[] = [];
  if (passes.has('depth') || passes.has('edges') || (strings && (passes.has('mask') || passes.has('pose'))))
    out.push('depth');
  if (passes.has('normal') || passes.has('edges')) out.push('normal');
  if (passes.has('mask') || passes.has('edges')) out.push('object');
  return out;
}

const toByte = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 255)));

/** Whether object `id` is hidden by its scale at the evaluated frame (unknown objects are not). */
function hiddenObject(scene: EvaluatedScene, id: string): boolean {
  const o = scene.byId.get(id);
  return !!o && hiddenByScale(o.worldMatrix);
}

/**
 * Renders one desk frame: the beauty image (`data`, when asked for or for `png`), the passes and the
 * metadata. Warnings (a pass the renderer could not make, a pose that failed) come back per frame;
 * the export reports each once.
 */
export function renderDeskFrame(
  d: DeskDocument,
  base: SoftwareRenderOptions & { frame: number },
  desk: DeskFrameOptions,
  png = false,
): ImageResult {
  const { doc, evaluator } = d;
  const width = Math.round(base.width);
  const height = Math.round(base.height);
  const passes = new Set<PassName>(desk.passes);
  const warnings = new Set<string>();
  // the evaluation the renderer makes too (meshes and simulation are cached by the evaluator)
  const scene = evaluator.evaluate(base.frame, { forRender: true });
  const items = renderItems(scene, { forRender: true });
  const drawn = items.filter((o) => o.mesh.faces.length > 0);
  const resolved = resolveView(doc, scene, base, width / height, evaluatedBounds(drawn));

  const strings = (desk.lines ?? [])
    .map((line) => ({ line, points: stringPoints(scene, line.object) }))
    .filter((s) => s.points.length >= 2);
  /**
   * Every string's segments (world space, at least 2 px wide, ends left to right on screen: see
   * `leftToRight`) with the string's object.
   */
  const segments: { object: string; line: ScreenLine }[] = [];
  for (const s of strings)
    for (let i = 1; i < s.points.length; i++) {
      const [a, b] = leftToRight(resolved.viewProj, s.points[i - 1], s.points[i]);
      segments.push({
        object: s.line.object,
        line: { a, b, width_px: Math.max(2, s.line.width_px), color: s.line.color },
      });
    }
  const screenLines = segments.map((s) => s.line);

  const aovNames = deskAovs(passes, strings.length > 0);
  // the beauty image (and the strings drawn into it) only when it is wanted; no rasterizing at all
  // when no pass needs it either (a pose pass without strings: skeletons come from the evaluation)
  const beauty = passes.has('beauty') || png;
  const img =
    beauty || aovNames.length
      ? renderSceneSoftware(doc, {
          ...deskRenderOptions(base, desk, beauty),
          evaluator,
          aovs: aovNames.length ? aovNames : undefined,
          lines: beauty && screenLines.length ? screenLines : undefined,
        })
      : null;
  const aovs = img?.aovs ?? {};
  // the view the image was rendered with (the renderer returns it with passes or lines)
  const view = img?.view ?? resolved;
  const proj: Projection = {
    viewProj: view.viewProj,
    view: view.view,
    ortho: view.ortho,
    near: view.near,
    width,
    height,
  };
  const n = width * height;
  const missing = (pass: PassName, what: string) =>
    warnings.add(`${pass} pass: the renderer returned no ${what} pass, so the ${pass} images are blank`);

  /**
   * Draws the strings into a one-byte pass, each with the byte `valueOf(object)` (null: not drawn):
   * core drawLines, as the renderer draws them into the beauty image (the same projection,
   * near-plane clipping and depth test against the surfaces in front), setting the pixels at least
   * half covered (the mask and edges passes hold palette indices and black, nothing to blend).
   */
  const drawStrings = (pass: Uint8Array, valueOf: (object: string) => number | null) => {
    const toDraw: ScreenLine[] = [];
    for (const s of segments) {
      const v = valueOf(s.object);
      if (v !== null) toDraw.push({ ...s.line, color: [v / 255, 0, 0] });
    }
    if (toDraw.length)
      drawLines(pass, width, height, toDraw, view, { channels: 1, depth: aovs.depth, antialias: false });
  };

  // the strings projected into the frame for the pose pass (the parts in front of the near plane),
  // drawn over the skeletons where no surface is in front of them (as in the beauty image)
  const lines = strings.map((s) => {
    const segs: [ScreenPoint, ScreenPoint][] = [];
    for (let i = 1; i < s.points.length; i++) {
      const seg = projectSegment(proj, s.points[i - 1], s.points[i]);
      if (seg) segs.push(seg);
    }
    return { line: s.line, segs };
  });

  const out: Partial<Record<PassName, Uint8Array>> = {};
  if (passes.has('depth')) {
    if (!aovs.depth) missing('depth', 'depth');
    const [near, far] = desk.depthRange ?? [view.near, view.far];
    out.depth = aovs.depth ? depthToBytes(aovs.depth, near, far) : new Uint8Array(n);
  }
  if (passes.has('normal')) {
    if (!aovs.normal) missing('normal', 'normal');
    out.normal = aovs.normal ? normalToRGB(aovs.normal) : new Uint8Array(n * 3);
  }
  if (passes.has('mask')) {
    const palette = Object.keys(desk.objectPalette ?? {});
    const index = new Map(palette.slice(0, 255).map((id, i) => [id, i + 1]));
    const ancestry = new Ancestry(scene);
    const groupOf = (id: string): number => {
      for (const a of ancestry.of(id)) {
        const k = index.get(a);
        if (k) return k;
      }
      return 0;
    };
    if (aovs.object && aovs.objectTable) {
      const table = aovs.objectTable;
      const lut = new Uint8Array(table.length);
      for (let i = 1; i < table.length; i++) lut[i] = table[i] ? groupOf(table[i]) : 0;
      out.mask = maskFromObjects(aovs.object, lut);
    } else {
      missing('mask', 'object');
      out.mask = new Uint8Array(n);
    }
    // a string of no group is not in the mask
    drawStrings(out.mask, (object) => groupOf(object) || null);
  }
  if (passes.has('edges')) {
    if (!aovs.depth) missing('edges', 'depth');
    out.edges = aovs.depth
      ? edgesToBytes(aovs.object ?? null, aovs.depth, aovs.normal ?? null, width, height)
      : new Uint8Array(n).fill(255);
    drawStrings(out.edges, () => 0);
  }
  if (passes.has('pose')) {
    const rgb = new Uint8Array(n * 3);
    // an actor shrunk to a point by a hide key (and its parts with it) has no skeleton to draw: its
    // keypoints would all fall on one point, a blot of joint colours where nobody stands
    const actors = (desk.poseActors ?? []).filter((id) => !hiddenObject(scene, id));
    if (actors.length) {
      let fs: FrameState | null = null;
      for (const actor of actors) {
        try {
          fs ??= new FrameState(doc, base.frame, d.simulated(base.frame));
          const k = actorKeypoints(fs, doc, actor);
          const points = k.points.map((p) => (p ? projectPoint(proj, p) : null));
          drawSkeleton(rgb, width, height, k.format, points);
        } catch (err) {
          // the frame keeps what was drawn (black where nothing was); the export reports it once
          warnings.add(`pose pass: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    for (const l of lines) {
      const color: [number, number, number] = [
        toByte(l.line.color[0]),
        toByte(l.line.color[1]),
        toByte(l.line.color[2]),
      ];
      for (const [a, b] of l.segs)
        drawLineRGB(rgb, width, height, a, b, l.line.width_px / 2, color, 1, aovs.depth, view.ortho);
    }
    out.pose = rgb;
  }

  const meta: FrameMeta = { camera: cameraOfView(view), subjects: {} };
  const subjects = desk.subjects ?? [];
  if (subjects.length) {
    const ancestry = new Ancestry(scene);
    const builders = new Map(subjects.map((s) => [s, new ScreenBoxBuilder(proj)]));
    const shown = new Set<string>();
    const hidden = new Set<string>();
    for (const item of drawn) {
      const mine = ancestry.ofItem(item).filter((a) => builders.has(a));
      if (!mine.length) continue;
      // a part hidden by its scale is not seen: its collapsed vertices would make a 1 px box
      if (hiddenByScale(item.worldMatrix)) {
        for (const s of mine) hidden.add(s);
        continue;
      }
      const world = worldPositions(item.mesh.positions, item.worldMatrix);
      for (const s of mine) {
        builders.get(s)!.add(world);
        shown.add(s);
      }
    }
    for (const s of subjects)
      meta.subjects[s] = shown.has(s)
        ? builders.get(s)!.box()
        : hidden.has(s) || hiddenObject(scene, s)
          ? { x: 0, y: 0, w: 0, h: 0, visible: false, hidden: true }
          : null;
  }

  const result: ImageResult = { width: img?.width ?? width, height: img?.height ?? height, meta };
  if (png && img) result.png = encodePNG(img);
  else if (passes.has('beauty') && img) result.data = img.data;
  if (Object.keys(out).length) result.passes = out;
  if (warnings.size) result.warnings = [...warnings];
  return result;
}

/** Evenly spread sample frames of a shot (its first and last frame included). */
export function sampleShotFrames(frames: readonly number[], max = MAX_SHOT_SAMPLES): number[] {
  if (frames.length <= max) return [...frames];
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(frames[Math.round((i * (frames.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/**
 * Measures a shot (request `desk-shot`): the depth range from small depth renders of its sampled
 * frames (the nearest and farthest surface the camera sees, with margins), else from the rendered
 * bounds; the shadow box from the bounds of everything but huge objects, widened by the shadows'
 * reach; the ambient occlusion reach of the whole shot from what its first frame draws (core
 * `defaultAoRadius`, as the renderer would choose for that frame). Objects hidden by their scale
 * count in none of these. The rigid body simulation is not run for these samples (bodies at their
 * animated places; the occlusion reach depends on sizes only).
 */
export function deskShotInfo(
  d: Pick<DeskDocument, 'doc' | 'evaluator'>,
  o: DeskShotOptions,
  noPhysics: (frame: number) => void,
): DeskShotInfo {
  const t0 = performance.now();
  const { doc, evaluator } = d;
  const camObj = doc.resolveObject(o.cameraId);
  let near = Infinity;
  let far = 0;
  let clipStart = 0.1;
  let clipEnd = 1000;
  let probeNear = Infinity;
  let probeFar = 0;
  let aoRadius: number | undefined;
  const fitMin: Vec3 = [Infinity, Infinity, Infinity];
  const fitMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const frame of sampleShotFrames(o.frames)) {
    const scene = evaluator.evaluate(frame, { forRender: true, noPhysics: true });
    const cam = camObj ? scene.byId.get(camObj.id) : undefined;
    if (!cam || cam.type !== 'CAMERA' || !cam.camera) throw new Error(`Camera '${o.cameraId}' not found`);
    clipStart = Math.max(1e-6, cam.camera.clip_start);
    clipEnd = Math.max(clipStart * 1.001, cam.camera.clip_end);
    const eye: Vec3 = [cam.worldMatrix[12], cam.worldMatrix[13], cam.worldMatrix[14]];
    // what the renderer draws (renderSceneSoftware's items: render-visible meshes with faces), but
    // for what hide keys shrank to a point: it is not seen, and a kite put away high above the set
    // would stretch the shadow box, or its tiny size shorten the occlusion reach
    const drawn = renderItems(scene, { forRender: true }).filter(
      (item) => item.mesh.faces.length > 0 && !hiddenByScale(item.worldMatrix),
    );
    // the first sampled frame is the shot's first: one reach for every frame of the shot
    aoRadius ??= defaultAoRadius(drawn);
    for (const item of drawn) {
      const b = evaluatedBounds([item]);
      if (!b) continue;
      const [dn, df] = boxDistances(eye, b.min, b.max);
      near = Math.min(near, dn);
      far = Math.max(far, df);
      if (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) > HUGE_OBJECT_M) continue;
      for (let k = 0; k < 3; k++) {
        fitMin[k] = Math.min(fitMin[k], b.min[k]);
        fitMax[k] = Math.max(fitMax[k], b.max[k]);
      }
    }
    // the surfaces the camera sees, from a small depth render (when the renderer makes depth passes)
    try {
      noPhysics(frame);
      const h = Math.max(8, Math.round(PROBE_WIDTH / Math.max(0.1, o.aspect)));
      const img = renderSceneSoftware(doc, {
        width: PROBE_WIDTH,
        height: h,
        frame,
        engine: 'RASTER',
        shading: 'SOLID',
        samples: 1,
        cameraId: o.cameraId,
        evaluator,
        aovs: ['depth'],
      });
      const depth = img.aovs?.depth;
      if (depth)
        for (let i = 0; i < depth.length; i++) {
          const z = depth[i];
          if (!(z > 0) || z === Infinity) continue;
          if (z < probeNear) probeNear = z;
          if (z > probeFar) probeFar = z;
        }
    } catch {
      // the bounds give the range
    }
  }
  let range: [number, number];
  if (probeFar > 0 && probeNear < Infinity) {
    // margins: surfaces between the samples' pixels and frames come a little nearer or farther
    range = [Math.max(clipStart, probeNear * 0.8), Math.min(clipEnd, probeFar * 1.1)];
  } else range = [Math.max(clipStart, near), Math.min(clipEnd, far)];
  if (!(range[0] < range[1]) || !Number.isFinite(range[0]) || !Number.isFinite(range[1]))
    range = [clipStart, clipEnd];
  let shadowFit: DeskShotInfo['shadowFit'] = null;
  if (fitMin.every(Number.isFinite) && fitMax.every(Number.isFinite)) {
    // shadows fall up to ~2.5 heights away (a sun at 22° elevation) on the ground around the casters
    const reach = Math.min(20, Math.max(1, 2.5 * (fitMax[2] - fitMin[2])));
    shadowFit = {
      min: [fitMin[0] - reach, fitMin[1] - reach, Math.min(0, fitMin[2]) - 0.1] as Vec3Tuple,
      max: [fitMax[0] + reach, fitMax[1] + reach, fitMax[2] + 0.1] as Vec3Tuple,
    };
  }
  return {
    depthRange: range,
    shadowFit,
    ...(aoRadius !== undefined ? { aoRadius } : {}),
    ms: Math.round(performance.now() - t0),
  };
}

/** The nearest and farthest distances from `p` to the box min–max (0 nearest when inside). */
export function boxDistances(p: Readonly<Vec3>, min: Readonly<Vec3>, max: Readonly<Vec3>): [number, number] {
  let n2 = 0;
  let f2 = 0;
  for (let k = 0; k < 3; k++) {
    const d = p[k] < min[k] ? min[k] - p[k] : p[k] > max[k] ? p[k] - max[k] : 0;
    n2 += d * d;
    const f = Math.max(Math.abs(p[k] - min[k]), Math.abs(p[k] - max[k]));
    f2 += f * f;
  }
  return [Math.sqrt(n2), Math.sqrt(f2)];
}
