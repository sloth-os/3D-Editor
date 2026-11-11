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
 *   into the free heap, less the reserve, fails with code OUT_OF_MEMORY and says what
 *   to lower; so does one that adds geometry beyond what the server keeps decoded for one project
 *   ({@link maxProjectMeshBytes}).
 * - Decoding stored meshes (scene summaries, mesh data, operators, exports in the server's process):
 *   `decodeCheck` refuses a mesh whose decoded arrays do not fit (core mesh/memory.ts); scene
 *   summaries then list its stored counts, other calls fail and say why.
 * - Modifier evaluations and curve and text surfaces (scene summaries, mesh data, operators such
 *   as Apply and Convert of MCP tools and the REST API): every modifier, and the surface of every
 *   curve and text object, asks `geometryCheck` before it is built (core eval/memory.ts); one whose
 *   estimated peak heap does not fit into the free heap, less the reserve, is skipped
 *   and reported as that modifier's (or curve's) error. Installed by `installGeometryMemoryGuard` when
 *   the server's render module loads (index.ts); render processes do not install it (running out
 *   of memory there ends only the render process).
 * - Project snapshots (REST GET /api/projects/:id/snapshot): the server copies every mesh and
 *   serializes the copy to JSON in its own heap; `snapshotRefusal` refuses one that does not fit
 *   into the free heap, less the reserve, or that no JavaScript string can hold.
 * - Renders and exports in the server's own process (single-thread mode: RENDER_WORKERS=0, or
 *   render processes could not start): refused first when their estimated heap need does not fit
 *   (`checkMainThreadRender`). The estimate is cheap (no evaluation): the triangles of the meshes
 *   shown in renders from their stored counts at RENDER_HEAP_BYTES_PER_TRIANGLE, plus the peak heap
 *   of their modifiers and the render of their result (the same modifier estimates). Other geometry
 *   (curves, text, particle and collection instances) is not counted.
 *
 * Each keeps a quarter of the heap free for the rest of the server, at least 256 MB
 * ({@link serverHeapReserve}). Before refusing, they run a full garbage collection and measure
 * again (the heap in use counts garbage not collected yet), at most one a second
 * ({@link collectGarbage}).
 */

/**
 * JavaScript heap a render takes per triangle of a mesh without modifiers, the decoded mesh
 * included: 307 bytes measured (a grid of 980,000 triangles, raster and path traced, 320×180),
 * rounded up.
 */
export const RENDER_HEAP_BYTES_PER_TRIANGLE = 320;

/** Least heap the guards keep free for the rest of the server (requests, rooms, other agents). */
export const SERVER_HEAP_RESERVE_BYTES = 256 * 1024 * 1024;

/** Share of its heap limit the server keeps free at least (see {@link serverHeapReserve}). */
export const SERVER_HEAP_RESERVE_SHARE = 0.25;

const MB = 1024 * 1024;

/** This process's JavaScript heap limit (bytes). */
const heapLimitBytes = (): number => v8.getHeapStatistics().heap_size_limit;

/**
 * Heap the guards keep free for the rest of the server in a heap of `limit` bytes: a quarter of it,
 * at least {@link SERVER_HEAP_RESERVE_BYTES} (524 MB of Node's default heap of 2,096 MB). V8 ends a
 * process ("Ineffective mark-compacts near heap limit") when four full garbage collections in a
 * row leave its old generation at 80% of its limit or more while the program ran for less than 40%
 * of the time between them: with the guards letting the heap fill up to its limit less 256 MB (88%
 * of the default heap), the collections of requests refused in a row ended the server that way.
 * What the guards let in now stays below that mark: 75% of the limit, which includes the 48 MB
 * young generation, so at most 79% of the old generation's limit.
 */
export function serverHeapReserve(limit: number = heapLimitBytes()): number {
  return Math.max(SERVER_HEAP_RESERVE_BYTES, Math.ceil(limit * SERVER_HEAP_RESERVE_SHARE));
}

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

let gcFunction: (() => void) | null | undefined;

/**
 * Runs a full garbage collection now. Uses `gc` when the process was started with --expose-gc,
 * else exposes it at run time (V8's `gc` of a new context). Returns whether a collection ran.
 */
function fullGarbageCollection(): boolean {
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

/** Least time between two full garbage collections of the guards (ms, see {@link collectGarbage}). */
export const GC_MIN_INTERVAL_MS = 1000;

/** After a collection, the guards wait at least this many times as long as it took before the next. */
export const GC_INTERVAL_PER_DURATION = 4;

/**
 * A full garbage collection for the guards, at most one per {@link GC_MIN_INTERVAL_MS} (and
 * {@link GC_INTERVAL_PER_DURATION} times the last one's duration, when longer): a request refused
 * soon after the last collection is decided on the heap as it is. Returns whether one ran. `gc` runs
 * the collection (default: V8's); `now` is the clock in milliseconds.
 */
export function throttledGarbageCollector(
  opts: { gc?: () => boolean; now?: () => number } = {},
): () => boolean {
  const gc = opts.gc ?? fullGarbageCollection;
  const now = opts.now ?? (() => performance.now());
  let next = -Infinity;
  return () => {
    const start = now();
    if (start < next) return false;
    const ran = gc();
    const end = now();
    next = end + Math.max(GC_MIN_INTERVAL_MS, GC_INTERVAL_PER_DURATION * (end - start));
    return ran;
  };
}

/**
 * Runs a full garbage collection before a guard refuses (the heap in use counts garbage until one
 * runs), shared by all the guards and at most one a second, so that requests refused in a row
 * leave the program most of its time: one collection of a full default heap took 0.5–0.6 s, and
 * V8 ends a process whose full collections in a row leave it less than 40% of the time near its
 * heap limit (see {@link serverHeapReserve}). Returns whether one ran.
 */
export const collectGarbage: () => boolean = throttledGarbageCollector();

/**
 * Whether `need` bytes fit into the free heap less the reserve of a heap of `limit` bytes (after a
 * garbage collection when needed and when one could make room for them).
 */
function fits(
  need: number,
  heapFree: () => number,
  collect: () => unknown,
  limit: number,
): { ok: boolean; free: number; reserve: number } {
  const reserve = serverHeapReserve(limit);
  let free = heapFree();
  // no collection makes room for more than the whole heap less the reserve
  if (need <= free - reserve || need > limit - reserve) return { ok: need <= free - reserve, free, reserve };
  collect();
  free = heapFree();
  return { ok: need <= free - reserve, free, reserve };
}

const n = (v: number): string => Math.round(v).toLocaleString('en-US');

const mb = (bytes: number): string => n(Math.max(0, bytes) / MB);

/** "…, and the server's process has F MB of its L MB heap free and keeps R MB of it for its other work". */
const heapClause = (free: number, limit: number): string =>
  `the server's process has ${mb(free)} MB of its ${mb(limit)} MB heap free and keeps ` +
  `${mb(serverHeapReserve(limit))} MB of it for its other work`;

/**
 * The error of a modifier, or a curve or text surface, the server skips for memory (see
 * `geometryCheck`; `free` and `limit`: the free heap and the heap limit, in bytes).
 */
export function skippedModifierMessage(
  req: GeometryMemoryRequest,
  free: number,
  limit = heapLimitBytes(),
): string {
  const e = req.estimate;
  return (
    `skipped on the server: this ${req.label} would need about ${n(e.bytes / MB)} MB of JavaScript heap for ` +
    `a result of about ${n(e.result.faces)} faces, and ${heapClause(free, limit)}. Lower ${e.lower} to ` +
    'evaluate it on the server (a browser editor evaluates it itself)'
  );
}

/**
 * The server's check of modifier evaluations and of curve and text surfaces (core
 * `setGeometryMemoryCheck`): skips one whose estimated peak heap does not fit into the free heap less
 * the reserve ({@link serverHeapReserve}).
 */
export function geometryCheck(
  opts: { heapFree?: () => number; collect?: () => unknown; heapLimit?: () => number } = {},
): GeometryMemoryCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const heapLimit = opts.heapLimit ?? heapLimitBytes;
  return (req) => {
    const limit = heapLimit();
    const { ok, free } = fits(req.estimate.bytes, heapFree, collect, limit);
    return ok ? null : skippedModifierMessage(req, free, limit);
  };
}

/**
 * Decoded meshes of one project the server keeps at most (bytes): half of its heap less the reserve,
 * so that the project's meshes, decoded, leave room for the operators that edit them and for other
 * projects (with Node's default heap of 2,096 MB: 786 MB, about 6.6 million triangles of grids with
 * UVs at 124 bytes each).
 */
export function maxProjectMeshBytes(limit = heapLimitBytes()): number {
  return Math.max(0, (limit - serverHeapReserve(limit)) / 2);
}

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
    `${e.faces ? ` for a mesh of about ${n(e.faces)} faces` : ''}, and ${heapClause(free, limit)}. ` +
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
    `its ${mb(limit)} MB heap less the ${mb(serverHeapReserve(limit))} MB it keeps for its other work). ` +
    (e.lower ? `Lower ${e.lower}, or delete` : 'Delete') +
    ' meshes the project no longer needs'
  );
}

/** The error of a stored mesh the server does not decode (see `decodeCheck`; bytes as above). */
export function refusedDecodeMessage(req: MeshMemoryRequest, free: number, limit = heapLimitBytes()): string {
  const l = req.layout;
  return (
    `this mesh of ${n(Math.max(0, l.corners - 2 * l.faces))} triangles was not loaded on the server: decoding it ` +
    `needs about ${mb(req.bytes)} MB of JavaScript heap, and ${heapClause(free, limit)} ` +
    '(the open projects keep their meshes decoded). Delete or simplify large meshes, or work on it in a browser ' +
    'editor that has the project open, which loads it in its own memory'
  );
}

/**
 * The server's check of operators (core `setOperatorMemoryCheck`): refuses one that adds geometry
 * beyond {@link maxProjectMeshBytes}, or whose estimated peak heap does not fit into the free heap
 * less the reserve ({@link serverHeapReserve}).
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
    const { ok, free } = fits(e.bytes, heapFree, collect, limit);
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
    const limit = heapLimit();
    const { ok, free } = fits(req.bytes, heapFree, collect, limit);
    return ok ? null : refusedDecodeMessage(req, free, limit);
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
 * The count stops after the part of the mesh (positions, faces, UVs …) that takes it past
 * `budget`, and is then less than the mesh's.
 */
export function meshJsonChars(mesh: MeshData, budget = Infinity): number {
  const parts: (() => number)[] = [
    () => numbersChars(mesh.positions),
    () => nestedChars(mesh.faces),
    () => numbersChars(mesh.faceMaterials),
    () => {
      let smooth = 2 + Math.max(0, mesh.faceSmooth.length - 1);
      for (const b of mesh.faceSmooth) smooth += b ? 4 : 5;
      return smooth;
    },
    () => (mesh.uvs ? nestedChars(mesh.uvs) : 4),
    () => (mesh.colors ? numbersChars(mesh.colors) : 4),
    () => JSON.stringify(mesh.edgeAttrs).length,
    () => numbersChars(mesh.looseEdges),
  ];
  let chars = 128;
  for (const part of parts) {
    chars += part();
    if (chars > budget) break;
  }
  return chars;
}

/**
 * Why the server does not build the snapshot of `scene` (GET /api/projects/:id/snapshot; null:
 * build it). The snapshot copies every mesh decoded and the server serializes it to one JSON
 * string, all in its own heap: a copy of the meshes plus the JSON (one byte per character), at
 * most {@link snapshotMeshChars} per mesh and base64 of the shape keys, vertex groups and images
 * (a grid of 640,000 faces took 1.93 times its decoded size at the peak, measured; this estimate
 * gives 2.24). Refused when that does not fit into the free heap less the reserve,
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
  // themselves before refusing a snapshot that may fit, until the count is past the limit
  if (chars > maxChars) {
    chars = other;
    for (const m of meshes) {
      chars += meshJsonChars(m, maxChars - chars) + 256;
      if (chars > maxChars) break;
    }
  }
  if (chars > maxChars)
    return (
      `not built on the server: the snapshot would be more than the ${mb(maxChars)} MB of JSON a JavaScript ` +
      `string can hold. ${advice}`
    );
  const need = copies + chars;
  const { ok, free } = fits(need, heapFree, collect, limit);
  if (ok) return null;
  return (
    `not built on the server: it would need about ${mb(need)} MB of JavaScript heap (a copy of the meshes and up ` +
    `to ${mb(chars)} MB of JSON), and ${heapClause(free, limit)}. ${advice}`
  );
}

/**
 * Throws a RenderOutOfMemoryError (reason 'refused') when a render (or export) of `scene` in the
 * server's own process would not fit into its free heap (`heapFree`, bytes) with
 * the reserve ({@link serverHeapReserve}) left for the rest of the server.
 */
export function checkMainThreadRender(
  scene: SceneDoc,
  heapFree: () => number = freeHeapBytes,
  collect: () => unknown = collectGarbage,
  what: 'render' | 'export' = 'render',
  heapLimit: () => number = heapLimitBytes,
): void {
  const est = estimateRenderMemory(scene);
  const limitBytes = heapLimit();
  const { ok, free } = fits(est.bytes, heapFree, collect, limitBytes);
  if (ok) return;
  const limit = Math.round(limitBytes / MB);
  throw new RenderOutOfMemoryError(
    `${OUT_OF_MEMORY_PREFIX}this ${what} was not started: it needs about ${Math.ceil(est.bytes / MB)} MB of JavaScript heap ` +
      `(about ${est.triangles.toLocaleString('en-US')} triangles), and ${what}s run in the server's own process ` +
      `(its render processes are off: RENDER_WORKERS=0, or they could not start), which has ` +
      `${Math.max(0, Math.floor(free / MB))} MB of its ${limit} MB heap free; running out of it would stop the server`,
    limit,
    'refused',
  );
}
