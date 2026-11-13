import {
  FrameState,
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
  type ModifierEstimate,
  type ObjectData,
  type SceneDoc,
  type ShapeKeyData,
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
 *   own heap, within the part of the tab's limit a render may fill ({@link usableHeap});
 * - the tab's memory budget ({@link renderMemoryBudget}): the first worker (evaluated scene,
 *   compiled scene and what compiling leaves behind), a compiled scene per other worker, the
 *   page's copy of it while it hands it out, and the film, preview and denoising of the image.
 * The first worker evaluates every mesh, curve and text object at its render settings, those hidden
 * in renders too (core `SceneEvaluator` evaluates them all; they stay in its heap), and compiles the
 * geometry of the objects shown in renders and of the objects they instance. Four checks keep a
 * render from ending the tab:
 * - before any worker starts, an estimate from the document at the render's frame ({@link
 *   estimateRender}: meshes by their stored counts, curve and text surfaces counted from their
 *   splines and glyphs, all through their modifiers, the instances of particle systems and
 *   collections, with the animated and driven values of that frame; and the decoded image
 *   textures), with the heap the modifiers take while the first worker evaluates them;
 * - on the first worker, while it evaluates the scene, every modifier right before it runs, from its
 *   real input (guard.ts: what the estimate cannot see, such as the edges a Bevel limited by angle
 *   bevels);
 * - on the first worker, once it evaluated the scene and before it compiles it, the same check with
 *   the exact triangles and instances (`RenderWorkerEngine.prepare`);
 * - with the exact compiled scene, the number of workers.
 * A render that does not fit one worker is not path traced: the first three checks refuse it with an
 * explanation instead of ending the tab.
 *
 * A RASTER render (F12, Render Animation, agents' renders with the WebGL rasterizer) evaluates the
 * scene at its render settings on the page itself, next to the viewport's evaluation: the geometry
 * it builds (curve and text surfaces, modifier and shape key results) must fit the room the tab's
 * heap has, or running out of it ends the tab. It is checked the same way, before the evaluation
 * from the estimate at the frame it renders ({@link rasterNeeds}, {@link rasterRefusal}) and during it
 * every modifier right before it runs (guard.ts `RasterEvaluationGuard`); a path tracing refusal
 * suggests the RASTER engine only where that check passes. A RASTER render that builds nothing
 * beyond what the page holds (meshes as the document stores them, no particle or collection
 * instances) is not refused: the page lives with its own heap, whatever its estimate says.
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

/**
 * The JavaScript heap core's Bevel modifier takes at its peak in Chrome, above its input (bytes):
 * per face it adds; per edge it bevels and per vertex it patches (its records of edges, corners and
 * profiles); per face or vertex of its input, the larger (the topology it builds, also when it
 * bevels nothing). Fitted to the smallest --max-old-space-size with which a dedicated worker of
 * Chrome 153 evaluated a Bevel that only renders: the default cube as 20 to 4,000 copies (1, 2, 8,
 * 30 and 100 segments, by angle) and subdivided (all edges, 1 and 2 segments), 80 to 447 MB, and
 * 218 MB for a smooth input of 196,608 faces that it bevels nothing of; 360, 370–760 and 1,110
 * bytes, and a quarter more. core's own figures (MODIFIER_BYTES_PER_RESULT_FACE.BEVEL_ADDED,
 * MODIFIER_BYTES_PER_INPUT_FACE.BEVEL) were measured in Node: they come to 1.6 GB for the cube as
 * 160 copies with 30 segments, which a worker here evaluates in 331 MB.
 */
export const BEVEL_HEAP_BYTES = { face: 450, element: 950, input: 1400 } as const;

/**
 * The heap a Bevel takes in the browser ({@link BEVEL_HEAP_BYTES}) on an input of `input`'s size,
 * adding `added` faces at `elements` edges and vertices.
 */
export function bevelHeap(input: MeshSize, added: number, elements: number): number {
  return (
    BEVEL_HEAP_BYTES.input * Math.max(input.faces, input.vertices) +
    BEVEL_HEAP_BYTES.element * elements +
    BEVEL_HEAP_BYTES.face * added
  );
}

/**
 * core `estimateModifier` with the browser's heap for a Bevel ({@link bevelHeap}) on its faces as
 * core counts them: every edge and vertex with limit_method NONE, none by angle (which edges those
 * are the check of the first worker's evaluation counts from its real input, guard.ts).
 */
export function modifierEstimate(
  mod: Parameters<typeof estimateModifier>[0],
  input: MeshSize,
  ctx: Parameters<typeof estimateModifier>[2],
): ModifierEstimate {
  const e = estimateModifier(mod, input, ctx);
  if (mod.type !== 'BEVEL' || !e.bytes) return e;
  const added = Math.max(0, e.result.faces - input.faces);
  return { ...e, bytes: bevelHeap(input, added, added ? input.corners / 2 + input.vertices : 0) };
}

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

/**
 * The part of the JavaScript heap limit V8 keeps for its young generation (bytes): a worker runs out
 * of memory when its old generation is full, and the jsHeapSizeLimit Chrome reports is 97–136 MB
 * above that (--max-old-space-size from 112 to 1024 MB, Chrome 153). A tab with a small limit can
 * fill less than {@link JS_HEAP_SHARE} of it: 0.36 GB of a 0.49 GB limit (--max-old-space-size=400).
 */
export const YOUNG_GENERATION_BYTES = 136 * MB;

/**
 * The JavaScript heap a render may fill in a tab whose limit is `limit` (bytes): {@link JS_HEAP_SHARE}
 * of it, and never the part kept for the young generation ({@link YOUNG_GENERATION_BYTES}).
 */
export function usableHeap(limit: number): number {
  return Math.max(0, Math.min(limit * JS_HEAP_SHARE, limit - YOUNG_GENERATION_BYTES));
}

/**
 * The editor page's own JavaScript heap (bytes), as Chrome 153 holds it (headless, software WebGL;
 * the page's heap after a garbage collection, read with the DevTools protocol's
 * Runtime.getHeapUsage), for {@link pageHeapEstimate}:
 * - `base`: a new project (its cube, camera and light): 11.9 MiB;
 * - `object`: per object of the document (its data and the editor's records of it): 30.7 and 34.0
 *   KB with 2,000 and 8,000 linked copies of a cube;
 * - `triangle`: per triangle the page keeps (the meshes the document stores, decoded, and the
 *   geometry its evaluation for the viewport builds, a modifier stack's input kept besides its
 *   result): 84 bytes with one and with two 720×720 grids (1,036,800 triangles each), 85 with a
 *   360×360 grid subdivided once in the viewport (its 259,200 triangles and the 1,036,800 of the
 *   result), 89 with the surface of a curve (1,079,308 triangles).
 * A quarter more, rounded up.
 */
export const PAGE_HEAP_BYTES = { base: 16 * MB, object: 43_000, triangle: 112 } as const;

/** The tab's memory as the browser reports it. */
export interface TabMemory {
  /** Memory the page and its render workers may use for a render (bytes, see {@link renderMemoryBudget}). */
  budget: number;
  /** The JavaScript heap limit of the tab (bytes): performance.memory.jsHeapSizeLimit, else 4 GB. */
  heapLimit: number;
  /**
   * The page's own JavaScript heap (bytes), estimated from its scene ({@link pageHeapEstimate}).
   * Not performance.memory.usedJSHeapSize: Chrome counts the page's ArrayBuffers in it, which the
   * heap limit does not hold (with three 720×720 grids it said 631 MiB, for a heap of 262 MiB and
   * 340 MiB of ArrayBuffers; a page that made a 200 MiB ArrayBuffer read 210 MB more there, its
   * heap 0.04 MB more), and in the headless Chromium of the tests it kept the figure of its first
   * read (10,000,000 bytes after the page allocated 200 MiB of ArrayBuffers and 1 million objects).
   */
  heapUsed: number;
  /** The device memory the budget comes from (GB, navigator.deviceMemory), null when unknown. */
  deviceGB: number | null;
  /**
   * What the other path traced renders running in the tab hold (bytes, their {@link renderMemory}):
   * a render gets the budget and the heap they leave.
   */
  held: { total: number; heap: number };
  /**
   * The part of `heapUsed` that the evaluator of RASTER final renders keeps from its last render
   * (bytes, its geometry; `ViewportEngine`). A path traced render counts it; a RASTER render does
   * not ({@link rasterRefusal}): the evaluator lets it go first where it and the new render's
   * geometry do not fit together.
   */
  rasterKept?: number;
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
 * The tab's memory now (Chrome's performance.memory.jsHeapSizeLimit, navigator.deviceMemory);
 * `pageHeap` is the page's own heap estimated from its scene ({@link pageHeapEstimate}), and
 * `rasterKept` what the evaluator of RASTER final renders keeps besides ({@link TabMemory.rasterKept}).
 */
export function tabMemory(pageHeap = 0, rasterKept = 0): TabMemory {
  const perf = (globalThis.performance as { memory?: { jsHeapSizeLimit?: number } })?.memory;
  const nav = (globalThis as { navigator?: { deviceMemory?: number } }).navigator;
  const deviceGB = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
  const limit = perf?.jsHeapSizeLimit;
  const kept = rasterKept > 0 ? rasterKept : 0;
  return {
    budget: renderMemoryBudget(deviceGB),
    heapLimit: typeof limit === 'number' && limit > 0 ? limit : 4 * GB,
    heapUsed: (pageHeap > 0 ? pageHeap : 0) + kept,
    deviceGB,
    held: { total: 0, heap: 0 },
    rasterKept: kept,
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

/** A curve datablock by id: as stored, or as an evaluation of one frame reads it (see {@link estimateRender}). */
type CurveReader = (id: string) => CurveData | null;

/** The bevel profiles core sweeps along the splines of `curve` (points, closed). */
function curveProfiles(
  doc: SceneDoc,
  curve: CurveData,
  is2D: boolean,
  forRender: boolean,
  curveOf: CurveReader,
): Contour[] {
  if (curve.bevel_mode === 'OBJECT') {
    const bo = curve.bevel_object ? doc.getObject(curve.bevel_object) : null;
    const bc = bo?.type === 'CURVE' && bo.data ? curveOf(bo.data) : null;
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
 * would take gigabytes is counted in microseconds. `curveOf` reads the curve of a bevel object
 * (default: as stored).
 */
export function curveSurfaceSize(
  doc: SceneDoc,
  curve: CurveData,
  isText: boolean,
  forRender = true,
  curveOf: CurveReader = (id) => doc.getCurve(id),
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
  let profiles = curveProfiles(doc, curve, is2D, forRender, curveOf);
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
   * The part of `instances` the evaluation makes: particle instances and the objects of collections
   * instanced whole (the rest are the objects shown in renders).
   */
  builtInstances: number;
  /**
   * The largest JavaScript heap the evaluation of one object takes while it runs (bytes): the sum of
   * the peaks of its modifiers, results included ({@link modifierEstimate}: core `estimateModifier`,
   * as the server counts them, a Bevel's as Chrome takes it), and for text the glyphs (core
   * TEXT_BYTES_PER_CHARACTER). The first worker needs it on top of the evaluated scene until the
   * evaluation is over.
   */
  evaluationHeap: number;
  /**
   * Bytes of the image textures the compiled scene holds, decoded (4 per pixel, by the size the
   * document stores): every image of a material, and the world's.
   */
  imageBytes: number;
  /**
   * Triangles of the geometry the evaluation builds and keeps itself: the surfaces of curves and
   * text, and the results of modifier stacks and of shape keys. The rest of `evaluatedTriangles` are
   * meshes as the document stores them, which the page has decoded already: what a RASTER render
   * adds to the page's heap is this ({@link rasterNeeds}).
   */
  builtTriangles: number;
  /**
   * The part of `builtTriangles` that no modifier makes: the surfaces of curves and text (core
   * builds them before their modifiers), and meshes with shape keys and no modifier. The check of a
   * RASTER render's evaluation (guard.ts) adds what the modifiers make.
   */
  builtBaseTriangles: number;
  /**
   * Triangles of the meshes the document stores that the objects show or feed to their modifiers,
   * each mesh once, as stored: what the page has decoded ({@link pageHeapEstimate}).
   */
  meshTriangles: number;
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
 * What a path traced render of `doc` at `frame` evaluates, compiles and instances, estimated without
 * evaluating it (the viewport's evaluation with `forRender` false): each mesh by its stored counts,
 * each curve and text by the surface core builds for it ({@link curveSurfaceSize}), through its
 * modifiers enabled for renders ({@link modifierEstimate}). A mesh's geometry is shared by the
 * objects that show it unmodified; one with modifiers is evaluated per object, as core does.
 *
 * The scene is read as core's evaluation of `frame` reads it (core `FrameState`): with the animated
 * and driven values of objects (modifier and particle settings), curves (bevel depth, extrusion,
 * resolutions, …) and shape keys. A curve stored without a bevel whose bevel depth is keyed has a
 * surface at that frame, which the first worker builds before any modifier runs. Without `frame`,
 * the values as stored.
 */
export function estimateRender(doc: SceneDoc, forRender = true, frame?: number): RenderEstimate {
  const fs = frame !== undefined && Number.isFinite(frame) ? new FrameState(doc, frame) : null;
  const objects = fs ? fs.objects : doc.listObjects();
  const curveOf: CurveReader = fs ? (id) => fs.curve(id) : (id) => doc.getCurve(id);
  const shapeKeysOf = (mesh: string): readonly Pick<ShapeKeyData, 'mute' | 'value'>[] =>
    fs ? (fs.get<{ shape_keys?: ShapeKeyData[] }>('mesh', mesh)?.shape_keys ?? []) : doc.getShapeKeys(mesh);
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
    /** Triangles the evaluation builds and keeps (see {@link RenderEstimate.builtTriangles}). */
    built: number;
    /** The part of `built` no modifier makes (see {@link RenderEstimate.builtBaseTriangles}). */
    builtBase: number;
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
    // triangles the evaluation builds before any modifier: a curve's or text's surface, a mesh's
    // shape keys applied (core keeps them as the evaluated mesh when no modifier follows)
    let builtBase = 0;
    if (o.type === 'MESH') {
      const counts = doc.meshCounts(o.data);
      if (!counts) return null;
      size = counts;
      const keyed = shapeKeysOf(o.data).some((k) => !k.mute && k.value !== 0);
      // users of a mesh share it unless modifiers or shape keys make one per object
      if (!mods.length && !((meshUsers.get(o.data) ?? 0) > 1 && keyed)) key = `mesh:${o.data}`;
      if (!mods.length && keyed) builtBase = triangles(size);
      // Array with FIT_LENGTH counts its copies from the mesh's size
      if (mods.some((m) => m.type === 'ARRAY' && m.params?.fit_type === 'FIT_LENGTH')) {
        const mesh = doc.getMesh(o.data);
        if (mesh) size = sizeWithExtent(mesh);
      }
    } else {
      const curve = curveOf(o.data);
      if (!curve) return null;
      const built = curveSurfaceSize(doc, curve, o.type === 'FONT', forRender, curveOf);
      size = built.surface;
      peak += built.glyphs * TEXT_BYTES_PER_CHARACTER;
      // a curve without a surface feeds its wire to its modifiers, and shows nothing without them
      if (!size.faces) {
        if (!mods.length || o.type !== 'CURVE') return null;
        size = { faces: 0, corners: 0, vertices: built.wirePoints };
      }
      builtBase = triangles(size);
    }
    // what the evaluation holds without running a modifier: the mesh as stored when it has none, a
    // curve's or text's surface (core builds it before the modifiers)
    const stored = o.type !== 'MESH' || !mods.length ? triangles(size) : 0;
    const extent = size.extent;
    // whether a modifier makes a mesh of its own (one that does nothing, e.g. Subdivision Surface at
    // level 0, hands its input on)
    let modified = false;
    for (const m of mods) {
      const e = modifierEstimate(m, size, {
        forRender,
        operandFaces: (id) => {
          const other = byId.get(id) ?? byName.get(id);
          return other ? (evaluate(other)?.size.faces ?? null) : null;
        },
      });
      peak += e.bytes;
      if (e.bytes > 0) modified = true;
      size = { ...e.result, extent };
    }
    // the result of the modifiers is kept besides what they started from (core caches both)
    const built = builtBase + (modified ? triangles(size) : 0);
    return { key, size, peak, stored, built, builtBase };
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
  const builtInstances = instances;

  const evaluated = new Map<string, number>();
  const stored = new Map<string, number>();
  const built = new Map<string, number>();
  const builtBase = new Map<string, number>();
  const compiled = new Map<string, number>();
  const meshes = new Map<string, number>();
  let evaluationHeap = 0;
  for (const o of objects) {
    const e = evaluate(o);
    if (!e) continue;
    if (o.type === 'MESH' && o.data && !meshes.has(o.data)) {
      const counts = doc.meshCounts(o.data);
      if (counts) meshes.set(o.data, triangles(counts));
    }
    const tris = triangles(e.size);
    evaluated.set(e.key, tris);
    stored.set(e.key, e.stored);
    built.set(e.key, e.built);
    builtBase.set(e.key, e.builtBase);
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
    builtInstances,
    evaluationHeap,
    imageBytes: imageBytesOf(doc),
    builtTriangles: sum(built),
    builtBaseTriangles: sum(builtBase),
    meshTriangles: sum(meshes),
  };
}

/**
 * The page's own JavaScript heap, estimated from its scene at `frame` ({@link PAGE_HEAP_BYTES}):
 * the editor keeps the document's objects and decoded meshes, and evaluates every object for the
 * viewport, keeping the geometry that evaluation builds and the evaluated instances.
 */
export function pageHeapEstimate(doc: SceneDoc, frame?: number): number {
  const e = estimateRender(doc, false, frame);
  return (
    PAGE_HEAP_BYTES.base +
    doc.objectIds().length * PAGE_HEAP_BYTES.object +
    (e.meshTriangles + e.builtTriangles) * PAGE_HEAP_BYTES.triangle +
    e.instances * INSTANCE_BYTES.heap
  );
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
  /**
   * A RASTER render of the scene fits the page's heap ({@link rasterRefusal}): a refusal then
   * suggests the RASTER engine, and only then.
   */
  rasterFits?: boolean;
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

/** Figures of a refusal as printed (gigabytes): see {@link refusalFigures}. */
export interface RefusalFigures {
  need: string;
  total: string;
  used: string;
  /** The room: the printed total less the printed use; null when that leaves none. */
  room: string | null;
  /** Decimals of the figures. */
  digits: number;
}

/**
 * The figures of a refusal in gigabytes, printed so that they add up and the need never prints like
 * the room: `need`, and the room left of `total` once `used` is taken (the need is larger), with
 * `digits` decimals; more decimals, at most three, where a figure that is not 0 (the room included)
 * would print as 0, or the need would print no larger than the room. The room printed is the total
 * printed less the use printed. Where three decimals are not enough, the need and the use are
 * rounded up and the total down, so that a need or a use that is not 0 prints as 0.001 GB at least.
 */
export function refusalFigures(need: number, total: number, used: number, digits = 1): RefusalFigures {
  const units = (b: number, d: number, round: (x: number) => number = Math.round) =>
    round((Math.max(0, b) / GB) * 10 ** d);
  const at = (d: number) => [units(need, d), units(total, d), units(used, d)];
  let d = Math.max(0, Math.min(3, Math.floor(digits)));
  let [n, t, s] = at(d);
  const zero = () => [need, total, used].some((b) => b > 0 && units(b, d) === 0) || (total > used && t <= s);
  while (d < 3 && (zero() || n <= t - s)) [n, t, s] = at(++d);
  if (zero() || n <= t - s)
    [n, t, s] = [units(need, d, Math.ceil), units(total, d, Math.floor), units(used, d, Math.ceil)];
  const text = (u: number) => (u / 10 ** d).toFixed(d);
  return { need: text(n), total: text(t), used: text(s), room: t - s > 0 ? text(t - s) : null, digits: d };
}

/**
 * Why `subject` (e.g. "its render thread") does not fit with `need` bytes of JavaScript heap: the
 * room a render has in the tab's heap is the share of its limit a render may fill ({@link
 * usableHeap}) less what the page, and the path traced renders running in it, use. That use is an
 * estimate ({@link TabMemory.heapUsed}: from the page's scene, with a quarter more; the renders'
 * {@link renderMemory}), and the message says so: it can exceed what the heap holds.
 */
function heapReason(subject: string, need: number, mem: TabMemory): string {
  const used = mem.heapUsed + mem.held.heap;
  const f = refusalFigures(need, usableHeap(mem.heapLimit), used, 2);
  const users =
    mem.held.heap > 0
      ? 'the page and the path traced renders running in it are estimated to use'
      : 'the page is estimated to use';
  const share =
    `a render may fill ${f.total} GB of its ${gbText(mem.heapLimit, f.digits)} GB heap limit, the rest ` +
    "being kept free for V8's young generation and for the page to keep working";
  const left =
    f.room === null
      ? 'and the tab has none left for it'
      : `more than the ${f.room} GB the tab has left for it`;
  const use = used > 0 ? `, and ${users} ${f.used} GB${f.room === null ? '' : ' of that'}` : '';
  return `${subject} needs about ${f.need} GB of JavaScript heap, ${left}: ${share}${use}`;
}

/** Whether `threads` workers fit the tab's memory. */
function fits(n: RenderNeeds, threads: number, mem: TabMemory): boolean {
  const m = renderMemory(n, threads);
  return (
    m.total + mem.held.total <= mem.budget &&
    mem.heapUsed + mem.held.heap + m.heap <= usableHeap(mem.heapLimit)
  );
}

/** A triangle count for messages: "1.2 million", "12,345". */
const triangleCount = (t: number): string =>
  t >= 100_000 ? `${(t / 1e6).toFixed(1)} million` : Math.round(t).toLocaleString('en-US');

/** The sentence a refusal says about the modifier it did not run (guard.ts), or ''. */
function causeSentence(c: RenderNeeds['cause']): string {
  return c
    ? ` ${c.name[0].toUpperCase()}${c.name.slice(1)} would make ${triangleCount(c.triangles)} of these ` +
        `triangles (lower ${c.lower}).`
    : '';
}

/** What to lower for fewer triangles, for the refusals. */
const LOWER_TRIANGLES =
  'the triangles (subdivision render levels, curve and text render resolution, objects in the scene)';

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
  const overBudget = m.total + mem.held.total > mem.budget;
  let reason: string;
  if (overBudget) {
    // the budget, less what the renders running in the tab hold
    const f = refusalFigures(m.total, mem.budget, mem.held.total, 1);
    const device = mem.deviceGB
      ? `the device memory the browser reports, ${mem.deviceGB} GB`
      : `the device memory, taken as ${DEFAULT_DEVICE_GB} GB where the browser does not report it`;
    const budget = `a render may use in this tab (half ${device}, at most ${gbText(MAX_RENDER_BUDGET)} GB)`;
    const needs1 = `it needs about ${f.need} GB of memory with one render thread`;
    reason = !(mem.held.total > 0)
      ? `${needs1}, more than the ${f.total} GB ${budget}`
      : f.room === null
        ? `${needs1}, and none is left of the ${f.total} GB ${budget}: other path traced renders running ` +
          `in it hold ${f.used} GB`
        : `${needs1}, more than the ${f.room} GB left of the ${f.total} GB ${budget}, ${f.used} GB of which ` +
          'other path traced renders running in it hold';
  } else reason = heapReason('its render thread', m.heap, mem);
  // every triangle the render evaluates; objects hidden in renders are evaluated all the same: say so
  // when they hold much of it
  const tris = triangleCount(Math.max(needs.triangles, needs.evaluatedTriangles ?? 0));
  const hidden = Math.max(0, (needs.evaluatedTriangles ?? 0) - needs.triangles);
  const hiddenPart =
    hidden >= 100_000 && hidden >= needs.triangles / 10
      ? `${triangleCount(hidden)} of them in objects hidden in renders, which are evaluated all the same, `
      : '';
  // the image counts towards the memory of the tab, not towards the heap; the RASTER engine only
  // where a RASTER render of the scene fits the page (rasterRefusal)
  const lower = overBudget ? `the resolution or ${LOWER_TRIANGLES}` : LOWER_TRIANGLES;
  return {
    threads: 0,
    limited: true,
    refusal:
      `Path tracing was not started: ${reason} (about ${tris} triangles, ` +
      `${hiddenPart}${needs.pixels.toLocaleString('en-US')} pixels), and running out of memory would end the ` +
      `tab.${causeSentence(needs.cause)} Lower ${lower}` +
      (needs.rasterFits ? ', or render with the RASTER engine.' : '.'),
  };
}

/**
 * The JavaScript heap a RASTER render (F12, Render Animation and agents' renders with the WebGL
 * rasterizer) adds on the page per triangle of the geometry its evaluation builds (bytes). Measured
 * in Chrome 153 (headless, software WebGL), F12 with the RASTER engine on a curve whose surface only
 * renders, the page holding 18–22 MB before: 3,237,900 and 3,777,548 triangles rendered with
 * --max-old-space-size=400 (a heap limit of 497 MB); 4,317,196 ended the tab with 400 and rendered
 * with 425: 88–94 bytes per triangle; a quarter more, rounded up. Modifiers count with core's
 * estimates of their peak, measured in Node, more than Chrome needed: a grid of 129,600 faces
 * subdivided once in renders (518,400 faces; core: 346 MB) rendered with --max-old-space-size=250,
 * subdivided twice (2,073,600 faces; core: 1,384 MB) with 850, not with 700.
 */
export const RASTER_BYTES_PER_TRIANGLE = 120;

/** What a RASTER render adds to the page's heap while it evaluates the scene. */
export interface RasterNeeds {
  /** Triangles of the geometry its evaluation builds ({@link RenderEstimate.builtTriangles}). */
  triangles: number;
  /** Bytes of JavaScript heap: that geometry, the evaluated instances, and the evaluation running. */
  heap: number;
  /** The instances it evaluates ({@link RenderEstimate.instances}), for a refusal without geometry. */
  instances?: number;
  /**
   * The render builds nothing beyond what the page holds: no geometry (no curve or text surface, no
   * modifier or shape key result: its meshes are the page's, as the document stores them) and no
   * particle or collection instances, only a record of each object it evaluates (about 400 bytes,
   * {@link INSTANCE_BYTES}; the page holds about a hundred times as much for each object). It is
   * not refused ({@link rasterRefusal}): the page already lives with what it renders, whatever the
   * estimate of the page's own heap says (an estimate with a margin, which can exceed the share of
   * the heap a render may fill when the page itself is near its heap limit).
   */
  buildsNothing?: boolean;
  /** The modifier whose evaluation does not fit (guard.ts), as in {@link RenderNeeds.cause}. */
  cause?: RenderNeeds['cause'];
}

/**
 * The JavaScript heap a RASTER render of a document adds on the page, from its estimate at the
 * frame it renders: the render evaluates the scene at its render settings with an evaluator of its
 * own (the viewport's evaluation stays), which keeps the geometry it builds ({@link
 * RenderEstimate.builtTriangles}, {@link RASTER_BYTES_PER_TRIANGLE}) and the evaluated instances, and
 * needs the heap of the evaluation of the heaviest object while it runs ({@link
 * RenderEstimate.evaluationHeap}). Meshes as the document stores them are the page's already: the
 * viewport shows them. A render without geometry, particle or collection instances or a modifier
 * to run builds nothing beyond what the page holds ({@link RasterNeeds.buildsNothing}).
 */
export function rasterNeeds(e: RenderEstimate): RasterNeeds {
  return {
    triangles: e.builtTriangles,
    heap: e.builtTriangles * RASTER_BYTES_PER_TRIANGLE + e.instances * INSTANCE_BYTES.heap + e.evaluationHeap,
    instances: e.instances,
    buildsNothing: e.builtTriangles === 0 && e.builtInstances === 0 && e.evaluationHeap === 0,
  };
}

/** What to lower for fewer instances, for a RASTER refusal without geometry. */
const LOWER_INSTANCES = 'the instances (particle counts, instanced collections, objects in the scene)';

/**
 * Why a RASTER render of `needs` is not started: its geometry does not fit the room the tab's heap
 * has for a render (see {@link usableHeap}, next to the page and the path traced renders running in
 * it), and running out of it would end the tab; null when it fits, and for a render that builds
 * nothing beyond what the page holds ({@link RasterNeeds.buildsNothing}). The geometry the evaluator
 * of RASTER renders keeps from its last render is not counted ({@link TabMemory.rasterKept}): it goes
 * first where it and this render's do not fit together.
 */
export function rasterRefusal(needs: RasterNeeds, memory: TabMemory): string | null {
  if (needs.buildsNothing) return null;
  const kept = Math.min(memory.heapUsed, Math.max(0, memory.rasterKept ?? 0));
  const mem: TabMemory = kept > 0 ? { ...memory, heapUsed: memory.heapUsed - kept, rasterKept: 0 } : memory;
  if (mem.heapUsed + mem.held.heap + needs.heap <= usableHeap(mem.heapLimit)) return null;
  // no geometry: its heap is the instances it evaluates
  const what =
    needs.triangles > 0
      ? `about ${triangleCount(needs.triangles)} triangles: curve and text surfaces, modifier and shape key results`
      : `about ${triangleCount(needs.instances ?? 0)} instances of objects, particles and collections, and no ` +
        'curve or text surface, modifier or shape key result';
  return (
    'The RASTER render was not started: ' +
    heapReason('the geometry it evaluates at the render settings', needs.heap, mem) +
    ` (${what}), and running out of memory would end the tab.${causeSentence(needs.cause)} ` +
    `Lower ${needs.triangles > 0 ? LOWER_TRIANGLES : LOWER_INSTANCES}.`
  );
}
