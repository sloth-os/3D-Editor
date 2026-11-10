import {
  MAX_INSTANCES,
  TEXT_BYTES_PER_CHARACTER,
  estimateModifier,
  extrudeProfile,
  glyphOutline,
  isModifierEnabled,
  isSplineCyclic,
  meshSize,
  normalizeParticleSettings,
  roundBevelProfile,
  sanitizeSpline,
  splineResolution,
  type BevelFillType,
  type CurveData,
  type MeshSize,
  type ObjectData,
  type SceneDoc,
  type Spline,
} from '@3d-editor/core';

/*
 * The memory of a path traced render in the browser, and how many render workers it may use.
 *
 * A tab is one renderer process: the page and its render workers share its memory. In Chrome all
 * their JavaScript heaps share one pointer-compression cage of 4 GB (the page's
 * performance.memory.jsHeapSizeLimit is 3,760,000,000 bytes; a worker reserves 1.9 GB of address
 * space, not a cage of its own), and its ArrayBuffers one pool of 16 GB of address space (measured
 * in Chrome 153: a worker allocated 15.75 GB of them, then none was left for the page). An
 * allocation that does not fit ends the whole tab (V8's out-of-memory crash, "Target crashed" in
 * Playwright), not just the render. A tab ended that way in round 9, about 12 s after F12 with
 * examples/domino-cascade and a grid of 1,036,800 triangles, while each of its 4 workers evaluated
 * and compiled the scene. Two runs on the code with typed-array render buffers did not crash: each
 * worker held 156–158 MB of heap and 508 MB of ArrayBuffers (of which the compiled scene 158 MB and
 * the tracer's film 53 MB), and the tab peaked at 3.0–3.3 GB. The likely cause is the render
 * buffers of the code before (JavaScript arrays: 2.8 GB of heap for 2 million triangles in Node),
 * which four such workers could not fit into the cage; a larger scene or image can still exhaust
 * the tab's memory the same way.
 *
 * So one worker (the first) evaluates and compiles the scene; the others get a copy of the
 * compiled scene (plain typed arrays, `PathTracer` is built from it) and hold nothing else: 7–16 MB
 * of heap and 212–214 MB of ArrayBuffers each in that render, whose tab then peaked at 1.9–2.0 GB
 * (three runs). The number of workers is the largest that fits:
 * - the JavaScript heap: the page's heap, the first worker's evaluated scene and every worker's
 *   own heap, within {@link JS_HEAP_SHARE} of the tab's limit;
 * - the tab's memory budget ({@link renderMemoryBudget}): the first worker (evaluated scene,
 *   compiled scene and what compiling leaves behind), a compiled scene per other worker, the
 *   page's copy of it while it hands it out, and the film, preview and denoising of the image.
 * The first worker evaluates every mesh, curve and text object at its render settings, those hidden
 * in renders too (core `SceneEvaluator` evaluates them all; they stay in its heap), and compiles the
 * geometry of the objects shown in renders and of the objects they instance. Four checks keep a
 * render from ending the tab:
 * - before any worker starts, an estimate from the document ({@link estimateRender}: meshes by their
 *   stored counts, curve and text surfaces counted from their splines and glyphs, all through their
 *   modifiers, the instances of particle systems and collections, and the decoded image textures),
 *   with the heap the modifiers take while the first worker evaluates them;
 * - on the first worker, while it evaluates the scene, every modifier right before it runs, from its
 *   real input (guard.ts: what the estimate cannot see, such as the edges a Bevel limited by angle
 *   bevels);
 * - on the first worker, once it evaluated the scene and before it compiles it, the same check with
 *   the exact triangles and instances (`RenderWorkerEngine.prepare`);
 * - with the exact compiled scene, the number of workers.
 * A render that does not fit one worker is not path traced: the first three checks refuse it with an
 * explanation instead of ending the tab.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * What a worker that evaluates and compiles the scene holds per triangle (bytes): in its JavaScript
 * heap the document and the evaluated meshes, per triangle it evaluated; and the ArrayBuffers
 * compiling leaves behind until a garbage collection (render buffers, the boxes and centroids the BVH
 * is built from; in the render above they went 100 s later), per triangle it compiled. Measured with
 * the 1,045,750 triangles of examples/domino-cascade and the grid, beyond the domino scene alone:
 * 138 MB of heap and 297 MB of ArrayBuffers (508 MB less the compiled scene and the film); rounded
 * up. The surface of a curve takes as much: 273 MB of heap for 2,088,960 triangles (131 bytes each),
 * 158 bytes each at the peak of building it (Node, core curveToMesh).
 */
export const PREPARE_BYTES_PER_TRIANGLE = { heap: 160, buffers: 320 } as const;

/**
 * Bytes of a compiled scene per triangle, for the estimate before the first worker reports the
 * exact size: 159 measured (166,164,585 bytes for 1,045,750 triangles), rounded up.
 */
export const COMPILED_BYTES_PER_TRIANGLE = 200;

/**
 * Bytes per instance (each object shown in renders, each particle and collection instance): in the
 * compiled scene (its transforms and the top level of the BVH), and in the heap of the first worker
 * (the evaluated instances). Measured with 200,000 particles of one cube: 380 and 311; rounded up.
 */
export const INSTANCE_BYTES = { scene: 400, heap: 400 } as const;

/** A render worker that holds no scene: its JavaScript heap and code (measured 7–27 MB, rounded up). */
export const WORKER_BASE_BYTES = 32 * MB;

/**
 * Bytes per pixel of the image on the page: the film tiles are added to (60), the preview (its
 * pixels and the canvas's), what making the mean film for the denoising worker leaves behind and the
 * PNG of the result. With {@link FINISH_BYTES_PER_PIXEL}, 228 bytes per pixel were measured: the tab
 * grew by 2,052 MB path tracing examples/domino-cascade at 4096×2304 (the four workers' compiled
 * scenes included); rounded up.
 */
export const PAGE_BYTES_PER_PIXEL = 96;

/**
 * Bytes per pixel on the worker that denoises the image: the mean film (60), denoising (69), the
 * image (4). (Each worker's tracer also has a film of 60 bytes per pixel that it never writes: address
 * space of the 16 GB pool, not memory.)
 */
export const FINISH_BYTES_PER_PIXEL = 133;

/** Share of the tab's JavaScript heap limit a render may fill (the page needs the rest to keep working). */
export const JS_HEAP_SHARE = 0.85;

/** The tab's memory as the browser reports it. */
export interface TabMemory {
  /** Memory the page and its render workers may use for a render (bytes, see {@link renderMemoryBudget}). */
  budget: number;
  /** The JavaScript heap limit of the tab (bytes): performance.memory.jsHeapSizeLimit, else 4 GB. */
  heapLimit: number;
  /**
   * The page's JavaScript heap (bytes): the larger of performance.memory.usedJSHeapSize and the
   * page's own evaluated scene ({@link pageHeapEstimate}). Chrome refreshes usedJSHeapSize at most
   * every 20 minutes in a page that is not cross-origin isolated, as the editor's is not (it stayed
   * at 10 MB after the page allocated 300 MB), so the estimate is what follows the scene.
   */
  heapUsed: number;
  /** The device memory the budget comes from (GB, navigator.deviceMemory), null when unknown. */
  deviceGB: number | null;
  /**
   * What the other path traced renders running in the tab hold (bytes, their {@link renderMemory}):
   * a render gets the budget and the heap they leave.
   */
  held: { total: number; heap: number };
}

/** Largest budget of a render (bytes). */
export const MAX_RENDER_BUDGET = 4 * GB;
/** Device memory assumed where the browser does not report it (GB). */
export const DEFAULT_DEVICE_GB = 8;

/**
 * The memory a render may use: half the device memory the browser reports (navigator.deviceMemory,
 * a power of two: 16 in Chrome 153 on a machine with 15.7 GB; {@link DEFAULT_DEVICE_GB} when
 * unknown), so that the browser, its GPU process, other tabs and the system keep the other half, and
 * at most {@link MAX_RENDER_BUDGET} on any device (the largest render measured here,
 * examples/domino-cascade at the 4096×2304 cap, peaked at 2.3 GB for the whole tab). The page's own
 * memory is not part of it.
 */
export function renderMemoryBudget(deviceGB: number | null): number {
  const gb = deviceGB && Number.isFinite(deviceGB) && deviceGB > 0 ? deviceGB : DEFAULT_DEVICE_GB;
  return Math.min(MAX_RENDER_BUDGET, (gb / 2) * GB);
}

/**
 * The tab's memory now (Chrome's performance.memory, navigator.deviceMemory); `pageHeap` is the
 * page's own heap estimated from its scene ({@link pageHeapEstimate}), the floor of `heapUsed`.
 */
export function tabMemory(pageHeap = 0): TabMemory {
  const perf = (globalThis.performance as { memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number } })
    ?.memory;
  const nav = (globalThis as { navigator?: { deviceMemory?: number } }).navigator;
  const deviceGB = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
  const limit = perf?.jsHeapSizeLimit;
  const used = perf?.usedJSHeapSize;
  return {
    budget: renderMemoryBudget(deviceGB),
    heapLimit: typeof limit === 'number' && limit > 0 ? limit : 4 * GB,
    heapUsed: Math.max(typeof used === 'number' && used > 0 ? used : 0, pageHeap > 0 ? pageHeap : 0),
    deviceGB,
    held: { total: 0, heap: 0 },
  };
}

const triangles = (s: MeshSize): number => Math.max(0, s.corners - 2 * s.faces);
const finite = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Core spline.ts: most points sampled from one spline (its resolution is lowered beyond). */
const MAX_SAMPLES_PER_SPLINE = 250_000;
/** Core to-mesh.ts: the largest swept curve surface (vertices); a denser curve gets none. */
const MAX_CURVE_SURFACE_VERTICES = 3_000_000;

/** A sampled spline or glyph outline: its points, and whether it is closed. */
interface Contour {
  points: number;
  cyclic: boolean;
}

/**
 * The points core `evaluateSpline` samples from spline `raw` of `curve` (its resolution, or the
 * curve's render resolution for renders), counted without sampling it.
 */
export function splineSampleCount(curve: CurveData, raw: Partial<Spline>, forRender = true): Contour {
  const s = sanitizeSpline(raw);
  const n = s.points.length;
  let res = splineResolution(curve, s, forRender);
  if (n * res > MAX_SAMPLES_PER_SPLINE)
    res = Math.max(1, Math.floor(MAX_SAMPLES_PER_SPLINE / Math.max(1, n)));
  if (s.type === 'BEZIER' && n > 1) {
    const cyclic = isSplineCyclic(s);
    let points = cyclic ? 0 : 1;
    for (let i = 0; i < (cyclic ? n : n - 1); i++) {
      // a segment between two VECTOR handles is straight: sampled with its start point only
      const straight =
        s.points[i].handle_right_type === 'VECTOR' && s.points[(i + 1) % n].handle_left_type === 'VECTOR';
      points += straight ? 1 : res;
    }
    return { points, cyclic };
  }
  if (s.type === 'NURBS' && n > 1) {
    const cyclic = s.use_cyclic_u && n > 2;
    return { points: cyclic ? res * n : res * (n - 1) + 1, cyclic };
  }
  return { points: n, cyclic: isSplineCyclic(s) };
}

/** The fill of a curve as core to-mesh.ts reads `fill_mode` (2D fill side, bevel profile part). */
function fillOf(
  curve: CurveData,
  is2D: boolean,
): { fill2D: 'NONE' | 'FRONT' | 'BACK' | 'BOTH'; bevel: BevelFillType } {
  const mode = curve.fill_mode;
  const fill2D = mode === 'NONE' ? 'NONE' : mode === 'FRONT' ? 'FRONT' : mode === 'BACK' ? 'BACK' : 'BOTH';
  if (is2D) return { fill2D, bevel: fill2D === 'NONE' ? 'FULL' : fill2D === 'BOTH' ? 'HALF' : fill2D };
  const bevel =
    mode === 'HALF' || mode === 'BOTH'
      ? 'HALF'
      : mode === 'FRONT'
        ? 'FRONT'
        : mode === 'BACK'
          ? 'BACK'
          : 'FULL';
  return { fill2D, bevel };
}

/** The bevel profiles core sweeps along the splines of `curve` (points, closed). */
function curveProfiles(doc: SceneDoc, curve: CurveData, is2D: boolean, forRender: boolean): Contour[] {
  if (curve.bevel_mode === 'OBJECT') {
    const bo = curve.bevel_object ? doc.getObject(curve.bevel_object) : null;
    const bc = bo?.type === 'CURVE' && bo.data ? doc.getCurve(bo.data) : null;
    if (!bc) return [];
    return (Array.isArray(bc.splines) ? bc.splines : [])
      .map((s) => splineSampleCount(bc, s, forRender))
      .filter((p) => p.points >= 2)
      .map((p) => ({ points: p.points, cyclic: p.cyclic && p.points > 2 }));
  }
  const depth = Math.max(0, finite(curve.bevel_depth, 0));
  const extrude = Math.max(0, finite(curve.extrude, 0));
  const resolution = Math.max(0, Math.min(32, Math.round(finite(curve.bevel_resolution, 4))));
  const p =
    depth > 0
      ? roundBevelProfile(depth, extrude, resolution, fillOf(curve, is2D).bevel)
      : extrudeProfile(extrude);
  return p ? [{ points: p.points.length, cyclic: p.closed }] : [];
}

/** The size of what core `curveToMesh` builds for a curve or text, counted without building it. */
export interface CurveSurfaceSize {
  /** The surface (swept profiles, caps and 2D fills); faces, corners and vertices 0 when it has none. */
  surface: MeshSize;
  /** The wire (a vertex per sampled point), what a curve without a surface feeds to its modifiers. */
  wirePoints: number;
  /** Characters with a glyph (text). */
  glyphs: number;
}

/**
 * The size of the surface core `curveToMesh` builds for `curve` (text when `isText`): its splines,
 * or the glyphs of its body, sampled at the render resolution (the viewport's when `forRender` is
 * false), swept by the bevel profile, with end caps and 2D fills; none when it would pass core's
 * limit of 3,000,000 vertices, as core builds none then. Counted, not built: a curve whose surface
 * would take gigabytes is counted in microseconds.
 */
export function curveSurfaceSize(
  doc: SceneDoc,
  curve: CurveData,
  isText: boolean,
  forRender = true,
): CurveSurfaceSize {
  const contours: Contour[] = [];
  let glyphs = 0;
  if (isText) {
    const res = forRender && curve.render_resolution_u > 0 ? curve.render_resolution_u : curve.resolution_u;
    const seg = Math.max(2, Math.min(64, Math.round(finite(res, 12))));
    const outlines = new Map<string, number[]>();
    for (const ch of typeof curve.body === 'string' ? curve.body : '') {
      if (/\s/.test(ch)) continue;
      glyphs++;
      let lengths = outlines.get(ch);
      if (!lengths) outlines.set(ch, (lengths = glyphOutline(ch, seg).contours.map((c) => c.length)));
      for (const n of lengths) contours.push({ points: n, cyclic: n >= 3 });
    }
  } else
    for (const s of Array.isArray(curve.splines) ? curve.splines : []) {
      const c = splineSampleCount(curve, s, forRender);
      // core drops empty splines, and closes none of fewer than 3 points
      if (c.points > 0) contours.push({ points: c.points, cyclic: c.cyclic && c.points >= 3 });
    }
  const wirePoints = contours.reduce((sum, c) => sum + c.points, 0);
  const surface: MeshSize = { faces: 0, corners: 0, vertices: 0 };
  if (!contours.length) return { surface, wirePoints, glyphs };
  const is2D = isText || curve.dimensions === '2D';
  let profiles = curveProfiles(doc, curve, is2D, forRender);
  let vertices = 0;
  for (const c of contours) for (const p of profiles) vertices += c.points * p.points;
  // core counts the points it kept (duplicates dropped, at most a few): within 5% of its limit the
  // surface is counted, beyond it core builds none
  if (vertices > MAX_CURVE_SURFACE_VERTICES * 1.05) profiles = [];
  for (const c of contours) {
    if (c.points < 2) continue;
    for (const p of profiles) {
      const quads = (c.cyclic ? c.points : c.points - 1) * (p.cyclic ? p.points : p.points - 1);
      surface.faces += quads;
      surface.corners += 4 * quads;
      surface.vertices += c.points * p.points;
      // end caps of open sweeps (use_fill_caps)
      if (curve.use_fill_caps && !c.cyclic && p.points >= 3) {
        surface.faces += 2;
        surface.corners += 2 * p.points;
      }
    }
  }
  // 2D fills: the closed contours filled, on the profile's back and front or flat without one
  const { fill2D } = fillOf(curve, is2D);
  const closed = contours.filter((c) => c.cyclic);
  if (is2D && fill2D !== 'NONE' && closed.length) {
    const main = profiles[0];
    const caps = !main
      ? 1
      : main.cyclic
        ? 0
        : (fill2D === 'BACK' || fill2D === 'BOTH' ? 1 : 0) +
          (fill2D === 'FRONT' || fill2D === 'BOTH' ? 1 : 0);
    const points = closed.reduce((sum, c) => sum + c.points, 0);
    // a region of k points and h holes fills with k + 2h − 2 triangles: at most k + 2 per contour
    const tris = caps * (points + 2 * closed.length);
    surface.faces += tris;
    surface.corners += 3 * tris;
    surface.vertices += caps * points;
  }
  return { surface, wirePoints, glyphs };
}

/** What a path traced render of a document needs, estimated without evaluating it. */
export interface RenderEstimate {
  /**
   * Triangles of the compiled scene: each geometry of the objects shown in renders, and of the
   * objects they instance, once.
   */
  triangles: number;
  /**
   * Triangles of every geometry the first worker evaluates and keeps while it renders: core
   * evaluates every mesh, curve and text object, those hidden in renders too, at its render
   * settings.
   */
  evaluatedTriangles: number;
  /**
   * The part of `evaluatedTriangles` the first worker does not build with modifiers: meshes without
   * modifiers, and the surfaces of curves and text (before their modifiers). The check of its
   * evaluation (guard.ts) adds what the modifiers make.
   */
  storedTriangles: number;
  /** Instances of the compiled scene: the objects shown in renders, and particle and collection instances. */
  instances: number;
  /**
   * The largest JavaScript heap the evaluation of one object takes while it runs (bytes): the sum of
   * core `estimateModifier` peaks over its modifiers, results included, as the server counts them,
   * and for text the glyphs (core TEXT_BYTES_PER_CHARACTER). The first worker needs it on top of the
   * evaluated scene until the evaluation is over.
   */
  evaluationHeap: number;
  /**
   * Bytes of the image textures the compiled scene holds, decoded (4 per pixel, by the size the
   * document stores): every image of a material, and the world's.
   */
  imageBytes: number;
}

/** Bytes per pixel of a decoded image texture (RGBA8). */
export const IMAGE_BYTES_PER_PIXEL = 4;

/** Bytes of the decoded images materials and the world use (see {@link RenderEstimate.imageBytes}). */
function imageBytesOf(doc: SceneDoc): number {
  const ids = new Set<string>();
  for (const m of doc.listMaterials())
    for (const slot of Object.values(m.textures ?? {}))
      if (slot && typeof slot === 'object' && slot.image && !slot.procedural) ids.add(slot.image);
  const w = doc.getWorld();
  if (w.environment === 'IMAGE' && w.environment_image) ids.add(w.environment_image);
  let bytes = 0;
  for (const id of ids) {
    const im = doc.getImage(id);
    if (im)
      bytes += Math.max(0, finite(im.width, 0)) * Math.max(0, finite(im.height, 0)) * IMAGE_BYTES_PER_PIXEL;
  }
  return bytes;
}

/** The size of a mesh with its extent (Array with FIT_LENGTH), once per decoded mesh. */
const sizesWithExtent = new WeakMap<object, MeshSize>();
function sizeWithExtent(mesh: Parameters<typeof meshSize>[0]): MeshSize {
  let s = sizesWithExtent.get(mesh);
  if (!s) sizesWithExtent.set(mesh, (s = meshSize(mesh, true)));
  return s;
}

/** The collections in `ids` and all their child collections. */
function collectionTrees(doc: SceneDoc, ids: Iterable<string>): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of doc.listCollections())
    if (c.parent) {
      const list = children.get(c.parent);
      if (list) list.push(c.id);
      else children.set(c.parent, [c.id]);
    }
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * What a path traced render of `doc` evaluates, compiles and instances, estimated without evaluating
 * it (the viewport's evaluation with `forRender` false): each mesh by its stored counts, each curve
 * and text by the surface core builds for it ({@link curveSurfaceSize}), through its modifiers
 * enabled for renders (core `estimateModifier`). A mesh's geometry is shared by the objects that
 * show it unmodified; one with modifiers is evaluated per object, as core does.
 */
export function estimateRender(doc: SceneDoc, forRender = true): RenderEstimate {
  const objects = doc.listObjects();
  const byId = new Map(objects.map((o) => [o.id, o]));
  const byName = new Map(objects.map((o) => [o.name, o]));
  const meshUsers = new Map<string, number>();
  for (const o of objects)
    if (o.type === 'MESH' && o.data) meshUsers.set(o.data, (meshUsers.get(o.data) ?? 0) + 1);

  interface Evaluated {
    /** The geometry: shared by unmodified users of a mesh, else one per object. */
    key: string;
    size: MeshSize;
    /** Heap at the peak of evaluating it (bytes). */
    peak: number;
    /** Triangles not made by modifiers: the mesh without modifiers, a curve's or text's surface. */
    stored: number;
  }
  const done = new Map<string, Evaluated | null>();
  const visiting = new Set<string>();
  /** The geometry of `o` (memoized; null for objects without one, and in a dependency cycle). */
  const evaluate = (o: ObjectData): Evaluated | null => {
    if (done.has(o.id)) return done.get(o.id)!;
    if (visiting.has(o.id)) return null;
    visiting.add(o.id);
    let result: Evaluated | null;
    try {
      result = geometry(o);
    } finally {
      visiting.delete(o.id);
    }
    done.set(o.id, result);
    return result;
  };
  const geometry = (o: ObjectData): Evaluated | null => {
    if (!o.data || (o.type !== 'MESH' && o.type !== 'CURVE' && o.type !== 'FONT')) return null;
    const mods = o.modifiers.filter((m) => isModifierEnabled(m, { forRender, editMode: false }));
    let size: MeshSize;
    let peak = 0;
    let key = o.id;
    if (o.type === 'MESH') {
      const counts = doc.meshCounts(o.data);
      if (!counts) return null;
      size = counts;
      // users of a mesh share it unless modifiers or shape keys make one per object
      if (
        !mods.length &&
        !((meshUsers.get(o.data) ?? 0) > 1 && doc.getShapeKeys(o.data).some((k) => !k.mute && k.value !== 0))
      )
        key = `mesh:${o.data}`;
      // Array with FIT_LENGTH counts its copies from the mesh's size
      if (mods.some((m) => m.type === 'ARRAY' && m.params?.fit_type === 'FIT_LENGTH')) {
        const mesh = doc.getMesh(o.data);
        if (mesh) size = sizeWithExtent(mesh);
      }
    } else {
      const curve = doc.getCurve(o.data);
      if (!curve) return null;
      const built = curveSurfaceSize(doc, curve, o.type === 'FONT', forRender);
      size = built.surface;
      peak += built.glyphs * TEXT_BYTES_PER_CHARACTER;
      // a curve without a surface feeds its wire to its modifiers, and shows nothing without them
      if (!size.faces) {
        if (!mods.length || o.type !== 'CURVE') return null;
        size = { faces: 0, corners: 0, vertices: built.wirePoints };
      }
    }
    // what the evaluation holds without running a modifier: the mesh as stored when it has none, a
    // curve's or text's surface (core builds it before the modifiers)
    const stored = o.type !== 'MESH' || !mods.length ? triangles(size) : 0;
    const extent = size.extent;
    for (const m of mods) {
      const e = estimateModifier(m, size, {
        forRender,
        operandFaces: (id) => {
          const other = byId.get(id) ?? byName.get(id);
          return other ? (evaluate(other)?.size.faces ?? null) : null;
        },
      });
      peak += e.bytes;
      size = { ...e.result, extent };
    }
    return { key, size, peak, stored };
  };

  // what the objects instance: the objects of instanced collections, particle instance objects
  const instancedCollections: string[] = [];
  const instancedObjects = new Set<string>();
  const collectionId = (ref: unknown): string | null => {
    if (typeof ref !== 'string' || !ref) return null;
    return doc.getCollection(ref)?.id ?? doc.listCollections().find((c) => c.name === ref)?.id ?? null;
  };
  /** Particle instances, and for every collection instanced whole, its objects per instance. */
  const wholeCollections: { collection: string; times: number }[] = [];
  let particles = 0;
  for (const o of objects) {
    if (o.instance_type === 'COLLECTION') {
      const c = collectionId(o.instance_collection);
      if (c) {
        instancedCollections.push(c);
        wholeCollections.push({ collection: c, times: 1 });
      }
    }
    for (const ps of o.particle_systems ?? []) {
      if (forRender ? ps.show_render === false : ps.show_viewport === false) continue;
      const s = normalizeParticleSettings(ps.settings).settings;
      if (s.instance_type === 'NONE') continue;
      let count =
        s.distribution === 'GRID'
          ? Math.min(MAX_INSTANCES, Math.max(1, s.grid_resolution) ** 3)
          : Math.min(MAX_INSTANCES, Math.max(0, s.count));
      if (!forRender) count = Math.ceil((count * Math.max(0, Math.min(100, s.display_percentage))) / 100);
      if (s.instance_type === 'OBJECT') {
        const target = s.instance_object
          ? (byId.get(s.instance_object) ?? byName.get(s.instance_object))
          : null;
        if (target) instancedObjects.add(target.id);
        particles += count;
      } else {
        const c = collectionId(s.instance_collection);
        if (!c) continue;
        instancedCollections.push(c);
        if (s.use_whole_collection) wholeCollections.push({ collection: c, times: count });
        else particles += count;
      }
    }
  }
  const instancedTree = collectionTrees(doc, instancedCollections);
  let instances = particles;
  for (const w of wholeCollections) {
    const tree = collectionTrees(doc, [w.collection]);
    instances += w.times * objects.filter((o) => tree.has(o.collection)).length;
  }

  const evaluated = new Map<string, number>();
  const stored = new Map<string, number>();
  const compiled = new Map<string, number>();
  let evaluationHeap = 0;
  for (const o of objects) {
    const e = evaluate(o);
    if (!e) continue;
    const tris = triangles(e.size);
    evaluated.set(e.key, tris);
    stored.set(e.key, e.stored);
    evaluationHeap = Math.max(evaluationHeap, e.peak);
    const shown = !o.hide_render && doc.isCollectionVisible(o.collection);
    if (shown) instances++;
    if (shown || instancedObjects.has(o.id) || instancedTree.has(o.collection)) compiled.set(e.key, tris);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    triangles: sum(compiled),
    evaluatedTriangles: sum(evaluated),
    storedTriangles: sum(stored),
    instances,
    evaluationHeap,
    imageBytes: imageBytesOf(doc),
  };
}

/**
 * The page's own JavaScript heap, estimated from its scene: the editor evaluates every object for the
 * viewport and keeps the document and the evaluated meshes, as a render's first worker does.
 */
export function pageHeapEstimate(doc: SceneDoc): number {
  const e = estimateRender(doc, false);
  return e.evaluatedTriangles * PREPARE_BYTES_PER_TRIANGLE.heap + e.instances * INSTANCE_BYTES.heap;
}

/** What a render needs, per role (bytes). */
export interface RenderNeeds {
  /** Triangles of the compiled scene (exact once the first worker reported them). */
  triangles: number;
  /** Triangles the first worker evaluates and keeps (default `triangles`; see {@link RenderEstimate}). */
  evaluatedTriangles?: number;
  /** Instances of the compiled scene (default 0). */
  instances?: number;
  /** Bytes of the compiled scene (exact once the first worker reported them). */
  sceneBytes: number;
  /** Image pixels. */
  pixels: number;
  /** Heap of the evaluation still to come on the first worker ({@link RenderEstimate}); 0 once it is over. */
  evaluationHeap?: number;
  /**
   * The modifier whose evaluation does not fit (guard.ts), for the refusal: `name` ("the Bevel modifier
   * 'Bev' of 'Cube'"), what to lower ("its segments") and the triangles it would make.
   */
  cause?: { name: string; lower: string; triangles: number };
}

/** The needs of a render of `pixels` pixels from the estimate of its document (before any worker reports). */
export function estimatedNeeds(e: RenderEstimate, pixels: number): RenderNeeds {
  return {
    triangles: e.triangles,
    evaluatedTriangles: e.evaluatedTriangles,
    instances: e.instances,
    sceneBytes: e.triangles * COMPILED_BYTES_PER_TRIANGLE + e.instances * INSTANCE_BYTES.scene + e.imageBytes,
    pixels,
    evaluationHeap: e.evaluationHeap,
  };
}

/** The memory of a render with `threads` workers (bytes). */
export function renderMemory(n: RenderNeeds, threads: number): { total: number; heap: number } {
  // the first worker's heap: the document and the geometry it evaluated, its instances, and the
  // evaluation still to come
  const firstHeap =
    Math.max(n.triangles, n.evaluatedTriangles ?? 0) * PREPARE_BYTES_PER_TRIANGLE.heap +
    (n.instances ?? 0) * INSTANCE_BYTES.heap +
    (n.evaluationHeap ?? 0);
  const first =
    WORKER_BASE_BYTES + n.sceneBytes + firstHeap + n.triangles * PREPARE_BYTES_PER_TRIANGLE.buffers;
  const others = Math.max(0, threads - 1);
  // the page's copy of the compiled scene while it hands it out, and one copy on its way
  const handing = others ? 2 * n.sceneBytes : 0;
  const image = n.pixels * (PAGE_BYTES_PER_PIXEL + FINISH_BYTES_PER_PIXEL);
  return {
    total: first + others * (WORKER_BASE_BYTES + n.sceneBytes) + handing + image,
    heap: firstHeap + threads * WORKER_BASE_BYTES,
  };
}

/** How many workers a render may use, or why it cannot start. */
export interface ThreadPlan {
  /** Workers to render with (0 when the render cannot start). */
  threads: number;
  /** True when memory allows fewer workers than the pool has. */
  limited: boolean;
  /** Why the render cannot start (threads 0), for the user and for agents; null otherwise. */
  refusal: string | null;
}

/** Bytes as gigabytes for messages, with `digits` decimals. */
const gbText = (b: number, digits = 1) => (b / GB).toFixed(digits);

/**
 * The memory a render needs and the room it is refused for (need > room), as gigabytes that never
 * print the same: one decimal, more where one would print both alike (0.53 GB more than 0.50 GB),
 * and at three decimals the need rounded up and the room down.
 */
function apart(need: number, room: number): [string, string] {
  for (let digits = 1; digits <= 3; digits++) {
    const texts: [string, string] = [gbText(need, digits), gbText(room, digits)];
    if (texts[0] !== texts[1]) return texts;
  }
  return [
    (Math.ceil((need / GB) * 1000) / 1000).toFixed(3),
    (Math.floor((room / GB) * 1000) / 1000).toFixed(3),
  ];
}

/** Whether `threads` workers fit the tab's memory. */
function fits(n: RenderNeeds, threads: number, mem: TabMemory): boolean {
  const m = renderMemory(n, threads);
  return (
    m.total + mem.held.total <= mem.budget &&
    mem.heapUsed + mem.held.heap + m.heap <= mem.heapLimit * JS_HEAP_SHARE
  );
}

/** A triangle count for messages: "1.2 million", "12,345". */
const triangleCount = (t: number): string =>
  t >= 100_000 ? `${(t / 1e6).toFixed(1)} million` : Math.round(t).toLocaleString('en-US');

/**
 * The workers a render of `needs` may use, at most `maxThreads`: the largest number that fits the
 * tab's memory (see the module comment), or a refusal when even one does not.
 */
export function planRenderThreads(needs: RenderNeeds, maxThreads: number, mem: TabMemory): ThreadPlan {
  const max = Math.max(1, Math.floor(maxThreads));
  let threads = 0;
  while (threads < max && fits(needs, threads + 1, mem)) threads++;
  if (threads > 0) return { threads, limited: threads < max, refusal: null };
  const m = renderMemory(needs, 1);
  const used = mem.heapUsed + mem.held.heap;
  const heapRoom = mem.heapLimit * JS_HEAP_SHARE - used;
  const overBudget = m.total + mem.held.total > mem.budget;
  // the need and the room the reason compares never print the same; other figures with one decimal
  const need = overBudget ? m.total : m.heap;
  const roomLeft = overBudget ? Math.max(0, mem.budget - mem.held.total) : Math.max(0, heapRoom);
  const [needText, roomText] = apart(need, roomLeft);
  const gb = (b: number) => (b === need ? needText : b === roomLeft ? roomText : gbText(b));
  const device = mem.deviceGB
    ? `the device memory the browser reports, ${mem.deviceGB} GB`
    : `the device memory, taken as ${DEFAULT_DEVICE_GB} GB where the browser does not report it`;
  const budget = `a render may use in this tab (half ${device}, at most ${gbText(MAX_RENDER_BUDGET)} GB)`;
  const room =
    mem.held.total > 0
      ? `the ${gb(Math.max(0, mem.budget - mem.held.total))} GB left of the ${gb(mem.budget)} GB ${budget}, ` +
        `${gb(mem.held.total)} GB of which other path traced renders running in it hold`
      : `the ${gb(mem.budget)} GB ${budget}`;
  const reason = overBudget
    ? `it needs about ${gb(m.total)} GB of memory with one render thread, more than ${room}`
    : `its render thread needs about ${gb(m.heap)} GB of JavaScript heap, and the tab, which already uses ` +
      `${gb(used)} GB, has ${gb(Math.max(0, heapRoom))} GB of its ${gb(mem.heapLimit)} GB left for it`;
  // every triangle the render evaluates; objects hidden in renders are evaluated all the same: say so
  // when they hold much of it
  const tris = triangleCount(Math.max(needs.triangles, needs.evaluatedTriangles ?? 0));
  const hidden = Math.max(0, (needs.evaluatedTriangles ?? 0) - needs.triangles);
  const hiddenPart =
    hidden >= 100_000 && hidden >= needs.triangles / 10
      ? `${triangleCount(hidden)} of them in objects hidden in renders, which are evaluated all the same, `
      : '';
  // the modifier the first worker did not run (guard.ts): what it would make and what to lower
  const c = needs.cause;
  const cause = c
    ? ` ${c.name[0].toUpperCase()}${c.name.slice(1)} would make ${triangleCount(c.triangles)} of these ` +
      `triangles (lower ${c.lower}).`
    : '';
  return {
    threads: 0,
    limited: true,
    refusal:
      `Path tracing was not started: ${reason} (about ${tris} triangles, ` +
      `${hiddenPart}${needs.pixels.toLocaleString('en-US')} pixels), and running out of memory would end the ` +
      `tab.${cause} Lower the resolution or the triangles (subdivision render levels, curve and text render ` +
      'resolution, objects in the scene), or render with the RASTER engine.',
  };
}
