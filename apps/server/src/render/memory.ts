import { constants as bufferConstants } from 'node:buffer';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  decodedMeshBytes,
  estimateModifier,
  isMeshMemoryError,
  meshSize,
  setGeometryMemoryCheck,
  setMeshMemoryCheck,
  setOperatorMemoryCheck,
  type GeometryMemoryCheck,
  type GeometryMemoryRequest,
  type MeshData,
  type MeshLayout,
  type MeshMemoryCheck,
  type MeshMemoryRequest,
  type MeshSize,
  type OperatorMemoryCheck,
  type OperatorMemoryRequest,
  type SceneDoc,
} from '@3d-editor/core';
import { OUT_OF_MEMORY_PREFIX, RenderOutOfMemoryError } from './protocol';

/*
 * The server's own process shares one JavaScript heap with every editor connection, agent session
 * and project room, and V8 aborts the whole process when that heap runs out (a fatal error, not an
 * exception). These guards keep its own work from doing that:
 *
 * - Operators (MCP tools and the REST API): before an operator runs, the core registry asks
 *   `operatorCheck` with its estimated peak heap (core operators/memory.ts). One that does not fit
 *   into the free heap, less SERVER_HEAP_RESERVE_BYTES, fails with code OUT_OF_MEMORY and says what
 *   to lower; so does one that adds geometry beyond what the server keeps decoded for one project
 *   ({@link maxProjectMeshBytes}).
 * - Decoding stored meshes (scene summaries, mesh data, operators, exports in the server's process):
 *   `decodeCheck` refuses a mesh whose decoded arrays do not fit (core mesh/memory.ts); scene
 *   summaries then list its stored counts, other calls fail and say why.
 * - Modifier evaluations and curve and text surfaces (scene summaries, mesh data, operators such
 *   as Apply and Convert of MCP tools and the REST API): every modifier, and the surface of every
 *   curve and text object, asks `geometryCheck` before it is built (core eval/memory.ts); one whose
 *   estimated peak heap does not fit into the free heap, less SERVER_HEAP_RESERVE_BYTES, is skipped
 *   and reported as that modifier's (or curve's) error. Installed by `installGeometryMemoryGuard` when
 *   the server's render module loads (index.ts); render processes do not install it (running out
 *   of memory there ends only the render process).
 * - Project snapshots (REST GET /api/projects/:id/snapshot): the server copies every mesh and
 *   serializes the copy to JSON in its own heap; `snapshotRefusal` refuses one that does not fit
 *   into the free heap, less SERVER_HEAP_RESERVE_BYTES, or that no JavaScript string can hold.
 * - Renders and exports in the server's own process (single-thread mode: RENDER_WORKERS=0, or
 *   render processes could not start): refused first when their estimated heap need does not fit
 *   (`checkMainThreadRender`). The estimate is cheap (no evaluation): the triangles of the meshes
 *   shown in renders from their stored counts at RENDER_HEAP_BYTES_PER_TRIANGLE, plus the peak heap
 *   of their modifiers and the render of their result (the same modifier estimates). Other geometry
 *   (curves, text, particle and collection instances) is not counted.
 *
 * Before refusing, both run a full garbage collection and measure again: the heap in use counts
 * garbage not collected yet.
 */

/**
 * JavaScript heap a render takes per triangle of a mesh without modifiers, the decoded mesh
 * included: 307 bytes measured (a grid of 980,000 triangles, raster and path traced, 320×180),
 * rounded up.
 */
export const RENDER_HEAP_BYTES_PER_TRIANGLE = 320;

/** Heap kept free for the rest of the server (requests, rooms, other agents). */
export const SERVER_HEAP_RESERVE_BYTES = 256 * 1024 * 1024;

const MB = 1024 * 1024;

const triangles = (s: MeshSize): number => Math.max(0, s.corners - 2 * s.faces);

/**
 * Heap a render of `scene` takes, estimated without evaluating it: each mesh shown in renders
 * (its modifier stack counted once when objects share both) by its stored counts, its modifiers
 * enabled for renders by their estimates (core `estimateModifier`), and the render of the result.
 */
export function estimateRenderMemory(scene: SceneDoc): { triangles: number; bytes: number } {
  const seen = new Set<string>();
  let tris = 0;
  let bytes = 0;
  for (const o of scene.listObjects()) {
    if (o.type !== 'MESH' || !o.data || o.hide_render) continue;
    const mods = o.modifiers.filter((m) => m.show_render !== false);
    const key = `${o.data}|${JSON.stringify(mods.map((m) => [m.type, m.params]))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const counts = scene.meshCounts(o.data);
    if (!counts) continue;
    let size: MeshSize = counts;
    // Array with FIT_LENGTH counts its copies from the mesh's size: decode it (the render will)
    if (mods.some((m) => m.type === 'ARRAY' && m.params?.fit_type === 'FIT_LENGTH')) {
      const mesh = scene.getMesh(o.data);
      if (mesh) size = meshSize(mesh, true);
    }
    const base = triangles(size) * RENDER_HEAP_BYTES_PER_TRIANGLE;
    let peaks = 0;
    for (const m of mods) {
      const e = estimateModifier(m, size, { forRender: true });
      peaks += e.bytes;
      size = { ...e.result, extent: size.extent };
    }
    // the decoded mesh stays while the modifiers run; then their result is rendered
    const result = mods.length ? triangles(size) * RENDER_HEAP_BYTES_PER_TRIANGLE : 0;
    tris += triangles(size);
    bytes += base + Math.max(peaks, result);
  }
  return { triangles: tris, bytes };
}

/** Triangles of the meshes a render of `scene` shows, after their modifiers (estimated). */
export function estimateRenderTriangles(scene: SceneDoc): number {
  return estimateRenderMemory(scene).triangles;
}

/** Free JavaScript heap of this process (bytes): its limit minus what is in use. */
export function freeHeapBytes(): number {
  const h = v8.getHeapStatistics();
  return h.heap_size_limit - h.used_heap_size;
}

/** This process's JavaScript heap limit in MB. */
function heapLimitMb(): number {
  return Math.round(v8.getHeapStatistics().heap_size_limit / MB);
}

let gcFunction: (() => void) | null | undefined;

/**
 * Runs a full garbage collection (the heap in use counts garbage until one runs). Uses `gc` when
 * the process was started with --expose-gc, else exposes it at run time (V8's `gc` of a new
 * context). Returns whether a collection ran.
 */
export function collectGarbage(): boolean {
  if (gcFunction === undefined) {
    const own = (globalThis as { gc?: () => void }).gc;
    if (own) gcFunction = own;
    else {
      try {
        v8.setFlagsFromString('--expose-gc');
        const fn: unknown = runInNewContext('gc');
        gcFunction = typeof fn === 'function' ? (fn as () => void) : null;
      } catch {
        gcFunction = null;
      }
    }
  }
  if (!gcFunction) return false;
  gcFunction();
  return true;
}

/** Whether `need` bytes fit into the free heap less the reserve (after a garbage collection when needed). */
function fits(need: number, heapFree: () => number, collect: () => unknown): { ok: boolean; free: number } {
  let free = heapFree();
  if (need <= free - SERVER_HEAP_RESERVE_BYTES) return { ok: true, free };
  collect();
  free = heapFree();
  return { ok: need <= free - SERVER_HEAP_RESERVE_BYTES, free };
}

const n = (v: number): string => Math.round(v).toLocaleString('en-US');

/**
 * The error of a modifier, or a curve or text surface, the server skips for memory (see
 * `geometryCheck`; `free` and `limit`: the free heap and the heap limit, in bytes).
 */
export function skippedModifierMessage(
  req: GeometryMemoryRequest,
  free: number,
  limit = v8.getHeapStatistics().heap_size_limit,
): string {
  const e = req.estimate;
  return (
    `skipped on the server: this ${req.label} would need about ${n(e.bytes / MB)} MB of JavaScript heap for ` +
    `a result of about ${n(e.result.faces)} faces, and the server's process has ${n(Math.max(0, free) / MB)} MB ` +
    `of its ${n(limit / MB)} MB heap free and keeps ${n(SERVER_HEAP_RESERVE_BYTES / MB)} MB of it for its ` +
    `other work. Lower ${e.lower} to evaluate it on the server (a browser editor evaluates it itself)`
  );
}

/**
 * The server's check of modifier evaluations and of curve and text surfaces (core
 * `setGeometryMemoryCheck`): skips one whose estimated peak heap does not fit into the free heap less
 * SERVER_HEAP_RESERVE_BYTES.
 */
export function geometryCheck(
  opts: { heapFree?: () => number; collect?: () => unknown; heapLimit?: () => number } = {},
): GeometryMemoryCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const heapLimit = opts.heapLimit ?? (() => v8.getHeapStatistics().heap_size_limit);
  return (req) => {
    const { ok, free } = fits(req.estimate.bytes, heapFree, collect);
    return ok ? null : skippedModifierMessage(req, free, heapLimit());
  };
}

/**
 * Decoded meshes of one project the server keeps at most (bytes): half of its heap less the reserve,
 * so that the project's meshes, decoded, leave room for the operators that edit them and for other
 * projects (with Node's default heap of 2,096 MB: 920 MB, about 7.8 million triangles of grids with
 * UVs at 124 bytes each).
 */
export function maxProjectMeshBytes(limit = v8.getHeapStatistics().heap_size_limit): number {
  return Math.max(0, (limit - SERVER_HEAP_RESERVE_BYTES) / 2);
}

const mb = (bytes: number): string => n(Math.max(0, bytes) / MB);

/** This process's JavaScript heap limit (bytes). */
const heapLimitBytes = (): number => v8.getHeapStatistics().heap_size_limit;

/**
 * The error of an operator the server does not run because its peak heap does not fit (`free`:
 * the free heap, `limit`: the heap limit, in bytes).
 */
export function refusedOperatorMessage(
  req: OperatorMemoryRequest,
  free: number,
  limit = heapLimitBytes(),
): string {
  const e = req.estimate;
  return (
    `not run on the server: it would need about ${mb(e.bytes)} MB of JavaScript heap` +
    `${e.faces ? ` for a mesh of about ${n(e.faces)} faces` : ''}, and the server's process has ${mb(free)} MB ` +
    `of its ${mb(limit)} MB heap free and keeps ${mb(SERVER_HEAP_RESERVE_BYTES)} MB of it for its other ` +
    'work. ' +
    (e.lower
      ? `Lower ${e.lower} to run it on the server (a browser editor runs it in its own memory)`
      : 'A browser editor runs it in its own memory')
  );
}

/**
 * The error of an operator the server does not run because the project's meshes would not fit
 * decoded (`limit`: the heap limit in bytes, see {@link maxProjectMeshBytes}).
 */
export function storedMeshesMessage(req: OperatorMemoryRequest, limit = heapLimitBytes()): string {
  const e = req.estimate;
  return (
    `not run on the server: the project's meshes would then take about ${mb(req.storedBytes + e.addedStoredBytes)} ` +
    `MB of JavaScript heap decoded (now ${mb(req.storedBytes)} MB), more than the ` +
    `${mb(maxProjectMeshBytes(limit))} MB the server's process keeps for the meshes of one project (half of ` +
    `its ${mb(limit)} MB heap less the ${mb(SERVER_HEAP_RESERVE_BYTES)} MB it keeps for its other work). ` +
    (e.lower ? `Lower ${e.lower}, or delete` : 'Delete') +
    ' meshes the project no longer needs'
  );
}

/** The error of a stored mesh the server does not decode (see `decodeCheck`; bytes as above). */
export function refusedDecodeMessage(req: MeshMemoryRequest, free: number, limit = heapLimitBytes()): string {
  const l = req.layout;
  return (
    `this mesh of ${n(Math.max(0, l.corners - 2 * l.faces))} triangles was not loaded on the server: decoding it ` +
    `needs about ${mb(req.bytes)} MB of JavaScript heap, and the server's process has ${mb(free)} MB of its ` +
    `${mb(limit)} MB heap free and keeps ${mb(SERVER_HEAP_RESERVE_BYTES)} MB of it for its other work ` +
    '(the open projects keep their meshes decoded). Delete or simplify large meshes, or work on it in a browser ' +
    'editor that has the project open, which loads it in its own memory'
  );
}

/**
 * The server's check of operators (core `setOperatorMemoryCheck`): refuses one that adds geometry
 * beyond {@link maxProjectMeshBytes}, or whose estimated peak heap does not fit into the free heap
 * less SERVER_HEAP_RESERVE_BYTES.
 */
export function operatorCheck(
  opts: { heapFree?: () => number; collect?: () => unknown; heapLimit?: () => number } = {},
): OperatorMemoryCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const heapLimit = opts.heapLimit ?? heapLimitBytes;
  return (req) => {
    const e = req.estimate;
    const limit = heapLimit();
    if (e.addedStoredBytes > 0 && req.storedBytes + e.addedStoredBytes > maxProjectMeshBytes(limit))
      return storedMeshesMessage(req, limit);
    const { ok, free } = fits(e.bytes, heapFree, collect);
    return ok ? null : refusedOperatorMessage(req, free, limit);
  };
}

/** The server's check of decoding stored meshes (core `setMeshMemoryCheck`). */
export function decodeCheck(
  opts: { heapFree?: () => number; collect?: () => unknown; heapLimit?: () => number } = {},
): MeshMemoryCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const heapLimit = opts.heapLimit ?? heapLimitBytes;
  return (req) => {
    const { ok, free } = fits(req.bytes, heapFree, collect);
    return ok ? null : refusedDecodeMessage(req, free, heapLimit());
  };
}

/**
 * Installs the server's memory checks for this process (the server's process only): modifier
 * evaluations ({@link geometryCheck}), operators ({@link operatorCheck}) and decoding stored meshes
 * ({@link decodeCheck}).
 */
export function installGeometryMemoryGuard(): void {
  setGeometryMemoryCheck(geometryCheck());
  setOperatorMemoryCheck(operatorCheck());
  setMeshMemoryCheck(decodeCheck());
}

/** Most characters a JavaScript string holds (V8 on 64-bit: 2^29 − 24); longer JSON cannot be built. */
export const MAX_STRING_CHARS = bufferConstants.MAX_STRING_LENGTH;

/**
 * Characters of a mesh in the JSON of a project snapshot, at most: 24 per coordinate (a float32
 * value printed as a double, its sign, exponent and comma), 8 per vertex index of a face or a loose
 * edge, 12 per face (brackets, material index, smooth flag), 48 per face corner of a UV layer, 96
 * per vertex color, 64 per edge attribute. A grid with UVs prints 230 per face (measured), this
 * gives 307.
 */
export function snapshotMeshChars(l: MeshLayout): number {
  return (
    72 * l.vertices +
    8 * l.corners +
    12 * l.faces +
    (l.uvs ? 48 * l.corners + 3 * l.faces : 0) +
    (l.colors ? 96 * l.vertices : 0) +
    64 * (l.edgeAttrs ?? 0) +
    16 * (l.looseEdges ?? 0) +
    256
  );
}

/** Characters of `bytes` bytes in base64. */
const base64Chars = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/** Characters JSON.stringify writes for number `x`. */
const numberChars = (x: number): number => (Number.isFinite(x) ? String(x).length : 4);

/** Characters of a JSON array of numbers (brackets and commas included). */
function numbersChars(a: ArrayLike<number>): number {
  let c = 2 + Math.max(0, a.length - 1);
  for (let i = 0; i < a.length; i++) c += numberChars(a[i]);
  return c;
}

/** Characters of a JSON array of arrays of numbers. */
function nestedChars(a: readonly ArrayLike<number>[]): number {
  let c = 2 + Math.max(0, a.length - 1);
  for (const x of a) c += numbersChars(x);
  return c;
}

/**
 * Characters of `mesh` in the JSON of a project snapshot, counted from its values (what
 * JSON.stringify writes, its 98 characters of keys and braces rounded up to 128): exact where
 * {@link snapshotMeshChars}, the bound from the counts alone, says the JSON may not fit into a
 * JavaScript string. A string per number, no copy of the mesh: about a second per million faces.
 */
export function meshJsonChars(mesh: MeshData): number {
  let smooth = 2 + Math.max(0, mesh.faceSmooth.length - 1);
  for (const b of mesh.faceSmooth) smooth += b ? 4 : 5;
  return (
    128 +
    numbersChars(mesh.positions) +
    nestedChars(mesh.faces) +
    numbersChars(mesh.faceMaterials) +
    smooth +
    (mesh.uvs ? nestedChars(mesh.uvs) : 4) +
    (mesh.colors ? numbersChars(mesh.colors) : 4) +
    JSON.stringify(mesh.edgeAttrs).length +
    numbersChars(mesh.looseEdges)
  );
}

/**
 * Why the server does not build the snapshot of `scene` (GET /api/projects/:id/snapshot; null:
 * build it). The snapshot copies every mesh decoded and the server serializes it to one JSON
 * string, all in its own heap: a copy of the meshes plus the JSON (one byte per character), at
 * most {@link snapshotMeshChars} per mesh and base64 of the shape keys, vertex groups and images
 * (a grid of 640,000 faces took 1.93 times its decoded size at the peak, measured; this estimate
 * gives 2.24). Refused when that does not fit into the free heap less SERVER_HEAP_RESERVE_BYTES,
 * when the JSON would be longer than a JavaScript string can be, or when a stored mesh is not
 * decoded (the decode check's message). Reading the meshes decodes those not decoded yet.
 */
export function snapshotRefusal(
  scene: SceneDoc,
  opts: {
    heapFree?: () => number;
    collect?: () => unknown;
    heapLimit?: () => number;
    /** Longest JSON (characters; default {@link MAX_STRING_CHARS}). */
    maxChars?: number;
  } = {},
): string | null {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const limit = (opts.heapLimit ?? heapLimitBytes)();
  const maxChars = opts.maxChars ?? MAX_STRING_CHARS;
  let copies = 0;
  let chars = 0;
  /** Characters of everything but the meshes' own arrays (shape keys, vertex groups, images). */
  let other = 0;
  const meshes: MeshData[] = [];
  try {
    for (const b of scene.listMeshBlocks()) {
      const mesh = scene.getMesh(b.id);
      const c = scene.meshCounts(b.id);
      if (!mesh || !c) continue;
      meshes.push(mesh);
      const layout: MeshLayout = {
        ...c,
        uvs: !!mesh.uvs,
        colors: !!mesh.colors,
        edgeAttrs: Object.keys(mesh.edgeAttrs).length,
        looseEdges: mesh.looseEdges.length / 2,
      };
      copies += decodedMeshBytes(layout);
      chars += snapshotMeshChars(layout);
      for (const k of scene.getShapeKeys(b.id)) other += base64Chars(k.data.byteLength) + 256;
      for (const g of scene.getVertexGroups(b.id)) other += base64Chars(g.weights.byteLength) + 256;
    }
  } catch (err) {
    if (isMeshMemoryError(err)) return err.message;
    throw err;
  }
  for (const im of scene.listImages())
    other += base64Chars(scene.getImageBytes(im.id)?.byteLength ?? 0) + 256;
  chars += other;
  const advice =
    'Export the meshes instead (GET /api/projects/:id/export builds the file in a render process), or delete ' +
    'meshes the project no longer needs';
  // the bound from the counts allows the longest number for every value: count the values
  // themselves before refusing a snapshot that may fit
  if (chars > maxChars) {
    chars = other;
    for (const m of meshes) chars += meshJsonChars(m) + 256;
  }
  if (chars > maxChars)
    return (
      `not built on the server: the snapshot would be ${n(Math.ceil(chars / MB))} MB of JSON, more than the ` +
      `${mb(maxChars)} MB a JavaScript string can hold. ${advice}`
    );
  const need = copies + chars;
  const { ok, free } = fits(need, heapFree, collect);
  if (ok) return null;
  return (
    `not built on the server: it would need about ${mb(need)} MB of JavaScript heap (a copy of the meshes and up ` +
    `to ${mb(chars)} MB of JSON), and the server's process has ${mb(free)} MB of its ${mb(limit)} MB heap free ` +
    `and keeps ${mb(SERVER_HEAP_RESERVE_BYTES)} MB of it for its other work. ${advice}`
  );
}

/**
 * Throws a RenderOutOfMemoryError (reason 'refused') when a render (or export) of `scene` in the
 * server's own process would not fit into its free heap (`heapFree`, bytes) with
 * {@link SERVER_HEAP_RESERVE_BYTES} left for the rest of the server.
 */
export function checkMainThreadRender(
  scene: SceneDoc,
  heapFree: () => number = freeHeapBytes,
  collect: () => unknown = collectGarbage,
  what: 'render' | 'export' = 'render',
): void {
  const est = estimateRenderMemory(scene);
  const { ok, free } = fits(est.bytes, heapFree, collect);
  if (ok) return;
  const limit = heapLimitMb();
  throw new RenderOutOfMemoryError(
    `${OUT_OF_MEMORY_PREFIX}this ${what} was not started: it needs about ${Math.ceil(est.bytes / MB)} MB of JavaScript heap ` +
      `(about ${est.triangles.toLocaleString('en-US')} triangles), and ${what}s run in the server's own process ` +
      `(its render processes are off: RENDER_WORKERS=0, or they could not start), which has ` +
      `${Math.max(0, Math.floor(free / MB))} MB of its ${limit} MB heap free; running out of it would stop the server`,
    limit,
    'refused',
  );
}
