import { constants as bufferConstants } from 'node:buffer';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  OPERATOR_FIXED_BYTES,
  SAVE_BYTES_PER_IMAGE_BYTE,
  SAVE_BYTES_PER_KEPT_BYTE,
  SAVE_BYTES_PER_LAYER_BYTE,
  decodedMeshBytes,
  estimateModifier,
  isMeshMemoryError,
  layerBytes,
  modifierRuns,
  meshSize,
  modifierContext,
  projectObjects,
  rigidBodyCacheBytes,
  rigidBodyCachesBytes,
  setGeometryMemoryCheck,
  setMeshMemoryCheck,
  setOperatorMemoryCheck,
  setSimulationMemoryCheck,
  storedMeshBytes,
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
  type SimulationMemoryCheck,
  type SimulationMemoryRequest,
} from '@3d-editor/core';
import { historyKept } from '../mcp/history';
import { OUT_OF_MEMORY_PREFIX, RenderOutOfMemoryError } from './protocol';

/*
 * The server's own process shares one JavaScript heap with every editor connection, agent session
 * and project room, and V8 aborts the whole process when that heap runs out (a fatal error, not an
 * exception). These guards keep its own work from doing that:
 *
 * - Operators (MCP tools and the REST API): before an operator runs, the core registry asks
 *   `operatorCheck` with its estimated peak heap (core operators/memory.ts). One that does not fit
 *   into the free heap, less the reserve, fails with code OUT_OF_MEMORY and says what
 *   to lower; so does one that adds meshes, objects or keyframes beyond what the server keeps for
 *   one project: its meshes decoded, its objects, datablocks and animation, what the agents' undo
 *   histories keep in it ({@link heldByHistories}), and what a save of the project takes for a moment
 *   ({@link maxProjectMeshBytes}); and one that would take what all open
 *   projects keep, with the largest save among them, past what the server keeps for all of them
 *   ({@link maxOpenProjectsBytes}; the projects are those the checks have seen, see
 *   {@link trackOpenProject}). {@link projectGrowthRefusal} asks the same of a change that does not
 *   come from an operator (the sync of a browser editor).
 * - Rigid body simulations (the inspection tools' evaluations, bakes, renders in the server's own
 *   process): before a simulation steps, `simulationCheck` is asked with what the frames still to
 *   simulate will keep (core physics/memory.ts). The frames a document's cache holds stay until its
 *   inputs change (core physics/rigid-body.ts), so they count with what its project keeps; one
 *   simulation that would take its project, or all open projects, past what the server keeps for
 *   them, or that does not fit into the free heap less the reserve, is not simulated (an evaluation
 *   reports it as the rigid body world's problem, an operator fails with code OUT_OF_MEMORY). Their
 *   frames are ArrayBuffers outside the JavaScript heap for the most part: the free heap of every
 *   check is counted without them ({@link freeHeapBytes}).
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
 * (its modifier stack counted once when objects share both) by its stored counts, the modifiers a
 * render runs (core `modifierRuns`: enabled for renders and not disabled by their type's rule) by
 * their estimates (core `estimateModifier`; a Bevel limited by angle by the
 * edges it bevels on the stored mesh when it comes first in the stack, else as if every edge were
 * sharp: core `modifierContext`), and the render of the result.
 */
export function estimateRenderMemory(scene: SceneDoc): { triangles: number; bytes: number } {
  const seen = new Set<string>();
  let tris = 0;
  let bytes = 0;
  for (const o of scene.listObjects()) {
    if (o.type !== 'MESH' || !o.data || o.hide_render) continue;
    // the modifiers a render runs (show_render, and not disabled by their type's rule)
    const mods = o.modifiers.filter((m) => modifierRuns(scene, m, true));
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
    let first = true;
    for (const m of mods) {
      // a Bevel by angle: counted on the stored mesh when it comes first, else every edge
      const e = estimateModifier(m, size, modifierContext(scene, o, m, first, true));
      first = false;
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

/**
 * Free JavaScript heap of this process (bytes): its limit minus what is in use, less the frames that
 * cached rigid body simulations keep outside the heap (core rigidBodyCachesBytes: ArrayBuffers V8's
 * heap statistics leave out, which the process holds all the same).
 */
export function freeHeapBytes(): number {
  const h = v8.getHeapStatistics();
  return h.heap_size_limit - h.used_heap_size - rigidBodyCachesBytes({ outsideHeap: true });
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

/** "1 face", "2 faces": a count and its noun, singular for 1 (as `n` rounds it). */
const counted = (v: number, one: string, many = `${one}s`): string =>
  `${n(v)} ${Math.round(v) === 1 ? one : many}`;

const mb = (bytes: number): string => n(Math.max(0, bytes) / MB);

/** Megabytes rounded up (a need): shown next to a limit rounded down, it never shows as equal to it. */
const mbUp = (bytes: number): string => n(Math.ceil(Math.max(0, bytes) / MB));

/** Megabytes rounded down (a limit). */
const mbDown = (bytes: number): string => n(Math.floor(Math.max(0, bytes) / MB));

/**
 * "…, and the server's process has F MB of its L MB heap free and keeps R MB of it for its other work";
 * while cached rigid body simulations hold C MB outside the heap ({@link freeHeapBytes} leaves them
 * out of `free`): "has F + C MB of its L MB heap free, less the C MB its cached rigid body simulations
 * hold outside it, and keeps …".
 */
function heapClause(free: number, limit: number): string {
  const reserve = `keeps ${mb(serverHeapReserve(limit))} MB of it for its other work`;
  const simulations = rigidBodyCachesBytes({ outsideHeap: true });
  return simulations >= MB
    ? `the server's process has ${mb(free + simulations)} MB of its ${mb(limit)} MB heap free, less the ` +
        `${mb(simulations)} MB its cached rigid body simulations hold outside it, and ${reserve}`
    : `the server's process has ${mb(free)} MB of its ${mb(limit)} MB heap free and ${reserve}`;
}

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
    `a result of about ${counted(e.result.faces, 'face')}, and ${heapClause(free, limit)}. Lower ${e.lower} to ` +
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
 * What the server keeps for one project at most (bytes): its meshes decoded, its objects, datablocks
 * and keyframes (core operators/memory-objects.ts projectStoredBytes), and what a save of the project
 * takes for a moment besides (core saveBytes: three times what its objects, datablocks and keyframes
 * keep; the server saves a project after every change), up to half of its heap less the reserve, so
 * that they leave room for the operators that edit them, the cached evaluations
 * ({@link evaluationCacheBytes}) and other projects. With Node's default heap of 2,096 MB: 786 MB,
 * about 6.6 million triangles of grids with UVs at 124 bytes each, or about 18,700 objects without
 * meshes at 44,000 bytes each (11,000 kept, 33,000 more while the project is saved).
 */
export function maxProjectMeshBytes(limit = heapLimitBytes()): number {
  return Math.max(0, (limit - serverHeapReserve(limit)) / 2);
}

/**
 * Heap the server keeps cached scene evaluations in, for all projects together (bytes): a third of
 * what it keeps for one project ({@link maxProjectMeshBytes}), 262 MB of Node's default heap of
 * 2,096 MB. The inspection tools (get_scene, get_object, get_mesh_data, get_instances) keep the last
 * evaluations of each project by frame (mcp/eval-cache.ts), and one evaluation keeps about 1.6 KB per
 * object (core memory-objects.ts sceneEvaluationBytes): 16 of them for a project of 18,700 objects,
 * which the limit per project allows, would take about 460 MB.
 */
export function evaluationCacheBytes(limit = heapLimitBytes()): number {
  return maxProjectMeshBytes(limit) / 3;
}

/**
 * What the server keeps for all open projects together (bytes): what they keep (their meshes decoded,
 * objects, datablocks and animation, as {@link maxProjectMeshBytes} counts them) and the largest save
 * among them, up to its heap less the reserve and the cached evaluations' budget
 * ({@link evaluationCacheBytes}): 1,310 MB of Node's default heap of 2,096 MB. It counts the largest
 * save once, though saves run one at a time only per project (sync/room.ts): the saves of different
 * projects can overlap. The operators that edit them are checked against the free heap. Without it,
 * eight projects of 15,000 linked cubes each (158 MB kept, 473 MB more while saved, which the limit
 * per project allows every one of) filled the default heap to 1,670–1,683 MB after their saves:
 * every round of saves then stalled the server for up to 9.5 s and a request to get_project took
 * 24–29 s. With it, five of them reached 15,000 cubes and the other three were refused at their
 * first 5,000 (1,314 MB of 1,310 MB); a change in each then stalled the server for up to 4 s and
 * get_project took 0.2 s at most.
 */
export function maxOpenProjectsBytes(limit = heapLimitBytes()): number {
  return Math.max(0, limit - serverHeapReserve(limit) - evaluationCacheBytes(limit));
}

// ---------------------------------------------------------------- open projects

/** What an open project keeps and what a save of it takes for a moment besides (bytes). */
export interface OpenProjectSize {
  /** Project id (the room's), '' when the document is not a room's. */
  id: string;
  name: string;
  /**
   * Heap it keeps: core projectStoredBytes (its meshes decoded, objects, datablocks, animation), its
   * rigid body cache and what the agents' undo histories keep in it.
   */
  kept: number;
  /**
   * Heap a save of it takes for a moment beyond `kept` (core saveBytes of its objects' part, and of
   * what the undo histories keep, {@link heldByHistories}).
   */
  save: number;
  /**
   * Bytes its rigid body cache keeps (core rigidBodyCacheBytes), part of `kept`; absent when it holds
   * none. Not saved.
   */
  simulation?: number;
  /**
   * Bytes the agents' undo histories keep in it (mcp/history.ts historyKept), part of `kept`; absent
   * when they keep none.
   */
  history?: number;
}

/**
 * Heap a save of a project takes for a moment per byte the agents' undo histories keep in it (the
 * content of the deleted items they keep, mcp/history.ts historyKept) and per item they keep: a save
 * encodes the kept items with their content and decodes the stored state into the project's document
 * and into a document of its own (core storage/project-store.ts syncDocument). Measured as the second
 * save of a project against the same project without its history (agents' steps replaying the same
 * changes): per byte kept 3.1 for vertex group weights, 3.1 for shape keys and 5.7 for meshes (53, 53
 * and 63 MB kept; resident memory, the heap does not hold this binary data), rounded up as core
 * SAVE_BYTES_PER_LAYER_BYTE; per item, the locations of objects that 100 moves of 1,000 and 2,000
 * objects replaced (100,000 and 200,000 items of 152 bytes each counted): 1,084–1,171 and
 * 1,116–1,685 bytes of heap at the peak of the save (before its garbage collections; the peak with
 * the history less the peak without it, over 3 and 4 runs of each, which vary with when the save's
 * garbage collections run), of which {@link HISTORY_SAVE_BYTES_PER_BYTE} counts 912: with these
 * 1,000 bytes, 1,912 per item, 13% above the largest.
 */
export const HISTORY_SAVE_BYTES_PER_BYTE = 6;
export const HISTORY_SAVE_BYTES_PER_ITEM = 1_000;

/**
 * What the agents' undo histories keep in the document of `scene` (`kept`, bytes; core counts none of
 * it) and what a save of the project takes for it for a moment besides (`save`). Each history keeps
 * at most MCP_UNDO_MEMORY_MB of replaced or deleted data, each item counted with its share of a save
 * (mcp/history.ts BUDGET_BYTES_PER_ITEM: so its save takes at most 6 times MCP_UNDO_MEMORY_MB), and
 * its newest step, and frees it when its session (or agent id) ends (mcp/history.ts).
 */
export function heldByHistories(scene: SceneDoc): { kept: number; save: number } {
  const h = historyKept(scene.ydoc);
  return {
    kept: h.bytes,
    save: HISTORY_SAVE_BYTES_PER_BYTE * h.bytes + HISTORY_SAVE_BYTES_PER_ITEM * h.items,
  };
}

interface TrackedProject {
  scene: SceneDoc;
  /** Changes seen (bumped by every update of its document). */
  version: number;
  /** What it keeps but its rigid body cache, its save and its objects, at document version `version`. */
  size: { version: number; value: OpenProjectSize; objects: number } | null;
}

/** The open projects the memory checks count, by Y.Doc (see {@link trackOpenProject}). */
const openProjects = new Map<object, TrackedProject>();

/** The project id of a room's scene (its transaction origin is `{ type: 'server', room }`), else ''. */
function projectIdOf(scene: SceneDoc): string {
  const o = scene.origin as { type?: unknown; room?: unknown };
  return o.type === 'server' && typeof o.room === 'string' ? o.room : '';
}

/**
 * Counts `scene` among the projects the server has open, until its document is destroyed (its room
 * closes). The checks track every room whose project they see: the operators run on it, the imports
 * into it, the evaluations of the inspection tools and the changes {@link projectGrowthRefusal} is
 * asked about; the room manager can track a room when it loads it. Calling it again does nothing.
 */
export function trackOpenProject(scene: SceneDoc): void {
  const y = scene.ydoc;
  if (openProjects.has(y)) return;
  const t: TrackedProject = { scene, version: 0, size: null };
  const onUpdate = () => {
    t.version++;
  };
  y.on('update', onUpdate);
  y.on('destroy', () => {
    y.off('update', onUpdate);
    openProjects.delete(y);
  });
  openProjects.set(y, t);
}

/**
 * Tracks a room's scene as open ({@link trackOpenProject}); other documents (tests, scratch documents)
 * only when they are passed to {@link trackOpenProject} itself.
 */
export function trackOpenRoom(scene: SceneDoc | undefined): void {
  if (scene && projectIdOf(scene)) trackOpenProject(scene);
}

/**
 * What `scene` keeps but its rigid body cache, what its save takes and its objects, counted once per
 * version of its document.
 */
function baseSize(t: TrackedProject): NonNullable<TrackedProject['size']> {
  if (t.size?.version !== t.version) {
    const project = projectObjects(t.scene);
    t.size = {
      version: t.version,
      value: {
        id: projectIdOf(t.scene),
        name: t.scene.getMeta().name,
        kept: storedMeshBytes(t.scene) + project.bytes,
        save: project.save,
      },
      objects: project.objects,
    };
  }
  return t.size;
}

/**
 * What `scene` keeps and its save takes: counted once per version of its document, the frames its
 * rigid body cache holds (they change with the frames evaluated, not with the document) and what the
 * agents' undo histories keep (they change when the histories drop or collect steps).
 */
function sizeOf(t: TrackedProject): OpenProjectSize {
  let value = baseSize(t).value;
  const simulation = rigidBodyCacheBytes(t.scene);
  if (simulation > 0) value = { ...value, kept: value.kept + simulation, simulation };
  const history = heldByHistories(t.scene);
  if (history.kept > 0)
    value = {
      ...value,
      kept: value.kept + history.kept,
      save: value.save + history.save,
      history: history.kept,
    };
  return value;
}

/**
 * What the project of `scene` keeps (its rigid body cache, `simulation`, and what the agents' undo
 * histories keep, `history`, included), what its save takes and its objects: counted once per version
 * of its document when it is an open project.
 */
function projectSize(scene: SceneDoc): {
  stored: number;
  save: number;
  objects: number;
  simulation: number;
  history: number;
} {
  const t = openProjects.get(scene.ydoc);
  let stored: number;
  let save: number;
  let objects: number;
  if (t) {
    const size = baseSize(t);
    stored = size.value.kept;
    save = size.value.save;
    objects = size.objects;
  } else {
    const project = projectObjects(scene);
    stored = storedMeshBytes(scene) + project.bytes;
    save = project.save;
    objects = project.objects;
  }
  const simulation = rigidBodyCacheBytes(scene);
  const history = heldByHistories(scene);
  return {
    stored: stored + simulation + history.kept,
    save: save + history.save,
    objects,
    simulation,
    history: history.kept,
  };
}

/** The open projects the checks count but `scene`, largest first. */
export function otherOpenProjects(scene?: SceneDoc): OpenProjectSize[] {
  const out: OpenProjectSize[] = [];
  for (const [y, t] of openProjects) if (y !== scene?.ydoc) out.push(sizeOf(t));
  return out.sort((a, b) => b.kept + b.save - (a.kept + a.save));
}

/**
 * The error of a scene evaluation the server does not run for its inspection tools (`need`: its
 * estimated peak heap; `free`, `limit`: the free heap and the heap limit; bytes).
 */
export function refusedEvaluationMessage(
  objects: number,
  need: number,
  free: number,
  limit = heapLimitBytes(),
): string {
  return (
    `not evaluated on the server: evaluating the scene's ${n(objects)} object${objects === 1 ? '' : 's'} would need ` +
    `about ${mb(need)} MB of JavaScript heap, and ${heapClause(free, limit)}. Delete objects the project no ` +
    'longer needs (a browser editor that has the project open evaluates it in its own memory)'
  );
}

/** Why an evaluation of `objects` objects whose peak heap is `need` bytes is not run (null: run it). */
export type EvaluationCheck = (objects: number, need: number, release: () => void) => string | null;

/**
 * The server's check before it evaluates a scene for its inspection tools (mcp/eval-cache.ts): null
 * when the evaluation's estimated peak heap (`need`, core memory-objects.ts sceneEvaluationBytes) is
 * below the young generation's garbage every operator estimate starts from (core
 * OPERATOR_FIXED_BYTES, 32 MB: about 5,800 objects of the default size), or fits into the free heap
 * less the reserve ({@link serverHeapReserve}), after `release` dropped the cached evaluations and a
 * garbage collection when it did not; else why it is not evaluated. Smaller evaluations ran
 * unchecked before and cannot run the heap out on their own, while the free heap counts garbage until
 * a collection runs (at most one a second, {@link collectGarbage}): checked, the evaluations of a
 * scene of two objects asked for frame after frame were refused while those of other frames filled
 * the heap with garbage.
 */
export function evaluationCheck(
  opts: { heapFree?: () => number; collect?: () => unknown; heapLimit?: () => number } = {},
): EvaluationCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const heapLimit = opts.heapLimit ?? heapLimitBytes;
  return (objects, need, release) => {
    if (need < OPERATOR_FIXED_BYTES) return null;
    const limit = heapLimit();
    if (need <= heapFree() - serverHeapReserve(limit)) return null;
    release();
    const { ok, free } = fits(need, heapFree, collect, limit);
    return ok ? null : refusedEvaluationMessage(objects, need, free, limit);
  };
}

/**
 * What an operator builds, for messages: " for a mesh of about F faces and N new objects" (or less),
 * " for K new keyframes".
 */
function builds(e: OperatorMemoryRequest['estimate']): string {
  const meshes = e.meshes ?? 0;
  const objects = e.objects ?? 0;
  const faces = !e.faces
    ? ''
    : meshes > 1
      ? ` for ${n(meshes)} meshes of about ${counted(e.faces, 'face')} in all`
      : ` for a mesh of about ${counted(e.faces, 'face')}`;
  const built = objects > 1 ? `${faces || ' for'}${faces ? ' and' : ''} ${n(objects)} new objects` : faces;
  const keys = e.keyframes ?? 0;
  const withKeys =
    keys > 0 ? `${built || ' for'}${built ? ' and' : ''} ${counted(keys, 'new keyframe')}` : built;
  // vertex groups and shape keys an operator writes (core memory-layers.ts)
  const layers =
    e.layers && e.layers.bytes > 0 ? ` to write about ${mbUp(e.layers.bytes)} MB of ${e.layers.kind}` : '';
  return `${withKeys}${layers}`;
}

/** " with N new objects" / " with K new keyframes" (or both) of what an operator adds, for messages. */
function adds(e: OperatorMemoryRequest['estimate']): string {
  const parts: string[] = [];
  if ((e.objects ?? 0) > 1) parts.push(`${n(e.objects!)} new objects`);
  if ((e.keyframes ?? 0) > 0) parts.push(counted(e.keyframes!, 'new keyframe'));
  return parts.length ? ` with ${parts.join(' and ')}` : '';
}

/**
 * Where else an operator runs: a browser editor that has the project open runs it in its own
 * memory; an import (import_* operators, MCP import_model) gets there with editor_command
 * run_operator and the file in base64.
 */
export function inBrowserEditor(operator: string | undefined): string {
  return operator?.startsWith('import_')
    ? `a browser editor runs it in its own memory: editor_command {command: 'run_operator', params: {operator: '${operator}', params: {data_base64}}}`
    : 'a browser editor runs it in its own memory';
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
  const browser = inBrowserEditor(req.operator);
  return (
    `not run on the server: it would need about ${mb(e.bytes)} MB of JavaScript heap${builds(e)}, and ` +
    `${heapClause(free, limit)}. ` +
    (e.lower
      ? `Lower ${e.lower} to run it on the server (${browser})`
      : `${browser[0].toUpperCase()}${browser.slice(1)}`)
  );
}

/**
 * The heap the server keeps for a project of `stored` bytes (its meshes decoded, its objects,
 * datablocks and animation) whose save takes `save` bytes more for a moment (core saveBytes), held
 * against {@link maxProjectMeshBytes}.
 */
const projectNeed = (stored: number, save = 0): number => stored + Math.max(0, save);

/**
 * A request held against what the server keeps for one project and for all open projects: an
 * operator's, or a rigid body simulation's frames (`simulating`).
 */
interface ProjectRequest extends OperatorMemoryRequest {
  /** Bytes of the project's rigid body cache (core rigidBodyCacheBytes), part of storedBytes. */
  simulation?: number;
  /** Bytes the agents' undo histories keep in the project ({@link heldByHistories}), part of storedBytes. */
  history?: number;
  /** What it adds is (or holds) rigid body frames: a simulation, or a bake that simulates. */
  simulating?: boolean;
}

/** Whether `req` adds rigid body frames to its project's cache. */
const addsFrames = (req: ProjectRequest): boolean =>
  !!req.simulating || (req.estimate.simulationBytes ?? 0) > 0;

/** What projects keep, for messages: with their rigid body caches when one counts. */
const contents = (caches: boolean, projects = 1): string =>
  caches
    ? `meshes, objects, keyframes, images and rigid body cache${projects > 1 ? 's' : ''}`
    : 'meshes, objects, keyframes and images';

/** The advice to free a rigid body cache a project holds (empty when it holds none). */
const freeCacheAdvice = (held: boolean, projects = 1): string =>
  held
    ? `, or free ${projects > 1 ? 'their rigid body caches' : 'its rigid body cache'} (rigidbody.cache_free)`
    : '';

/**
 * `req` with what core does not count in what its project keeps: its rigid body cache, and what the
 * agents' undo histories keep (with what a save of that takes).
 */
function withHeld(req: OperatorMemoryRequest): ProjectRequest {
  if (!req.doc) return req;
  let r: ProjectRequest = req;
  const simulation = rigidBodyCacheBytes(req.doc);
  if (simulation > 0) r = { ...r, storedBytes: r.storedBytes + simulation, simulation };
  const history = heldByHistories(req.doc);
  if (history.kept > 0)
    r = {
      ...r,
      storedBytes: r.storedBytes + history.kept,
      saveBytes: (r.saveBytes ?? 0) + history.save,
      history: history.kept,
    };
  return r;
}

/**
 * The shares of what a project keeps that its refusals name, from 1 MB: "12 MB of it its rigid body
 * cache", "70 MB of it kept by agents' undo histories".
 */
function heldShares(p: { simulation?: number; history?: number }): string[] {
  const shares: string[] = [];
  if ((p.simulation ?? 0) > 0) shares.push(`${mbUp(p.simulation!)} MB of it its rigid body cache`);
  if ((p.history ?? 0) >= MB) shares.push(`${mbUp(p.history!)} ${HISTORY_SHARE}`);
  return shares;
}

/** The end of the share {@link heldShares} names for what the agents' undo histories keep. */
const HISTORY_SHARE = "MB of it kept by agents' undo histories";

/**
 * The end of a refusal that names what agents' undo histories keep ({@link heldShares}): when the
 * agents get it back (mcp/history.ts; deleting objects moves them into the deleting agent's
 * history; a step is dropped at a later step of its agent, the newest step always kept; agent ids
 * end 6 hours after their last session, or when more than 200 are kept and one without a session
 * is the least recently used, mcp/hub.ts).
 */
export const HISTORY_ADVICE =
  ". What agents' undo histories keep (the objects an agent deletes too) is freed when the agent's " +
  'session ends (for an agent id, 6 hours after its last session, or earlier when the server keeps ' +
  'more than 200 agent ids and this one is the least recently used without a session) or its step is ' +
  "dropped: the oldest steps are, beyond MCP_UNDO_STEPS steps or MCP_UNDO_MEMORY_MB of what they keep, at that agent's next step";

/** {@link HISTORY_ADVICE} when one of `projects` names its undo histories' share (from 1 MB). */
const historyAdvice = (...projects: readonly { history?: number }[]): string =>
  projects.some((p) => (p.history ?? 0) >= MB) ? HISTORY_ADVICE : '';

/**
 * {@link HISTORY_ADVICE} when `clause` (a reason {@link projectGrowthRefusal} gave) names what the
 * agents' undo histories keep in a project, else '': for the refusals of changes that do not come
 * from an operator (sync/project-memory.ts).
 */
export const historyAdviceFor = (clause: string): string =>
  clause.includes(HISTORY_SHARE) ? HISTORY_ADVICE : '';

/**
 * "…, and a save of it about S MB more for a moment (…): T MB in all, " (', ' without a save); `layers`:
 * the save counts vertex groups or shape keys (core SAVE_BYTES_PER_LAYER_BYTE), named only then;
 * `history`: the save counts what agents' undo histories keep ({@link HISTORY_SAVE_BYTES_PER_BYTE}),
 * named only then.
 */
function savingClause(kept: number, saved: number, layers = false, history = false): string {
  if (!(saved > 0)) return ', ';
  const k = Math.ceil(kept / MB);
  const s = Math.ceil(saved / MB);
  const layerPart = layers ? `, ${n(SAVE_BYTES_PER_LAYER_BYTE)} times its vertex groups and shape keys` : '';
  const historyPart = history
    ? `, ${n(HISTORY_SAVE_BYTES_PER_BYTE)} times what agents' undo histories keep and ` +
      `${n(HISTORY_SAVE_BYTES_PER_ITEM)} bytes for each replaced value they keep`
    : '';
  return (
    `, and a save of it about ${n(s)} MB more for a moment (${n(SAVE_BYTES_PER_KEPT_BYTE)} times what its ` +
    `objects, datablocks and keyframes take, ${n(SAVE_BYTES_PER_IMAGE_BYTE)} times its images${layerPart}` +
    `${historyPart}): ${n(k + s)} MB in all, `
  );
}

/** Whether the project of `req` holds vertex groups or shape keys (core layerBytes). */
const holdsLayers = (req: OperatorMemoryRequest): boolean => !!req.doc && layerBytes(req.doc) > 0;

/**
 * Why a project that keeps `req.storedBytes` (its save `req.saveBytes` more) cannot take what
 * `req.estimate` adds (null: it can), held against what the server keeps for one project
 * ({@link maxProjectMeshBytes}): a clause without a verb before it ("the project's meshes, objects,
 * keyframes and images would then take about …"), and whether the project was already past the limit.
 */
function projectLimitReason(req: ProjectRequest, limit: number): { reason: string; already: boolean } | null {
  const e = req.estimate;
  const max = maxProjectMeshBytes(limit);
  const save = req.saveBytes ?? 0;
  const kept = req.storedBytes + e.addedStoredBytes;
  if (projectNeed(kept, save + (e.addedSaveBytes ?? 0)) <= max) return null;
  const simulation = req.simulation ?? 0;
  const what = `the project's ${contents(simulation > 0 || addsFrames(req))}`;
  const now =
    req.objects === undefined ? '' : ` with ${n(req.objects)} object${req.objects === 1 ? '' : 's'}`;
  const shares = heldShares(req).join(', ');
  const history = (req.history ?? 0) > 0;
  const keeps =
    `more than the ${mbDown(max)} MB the server's process keeps for one project (half of its ${mb(limit)} MB heap ` +
    `less the ${mb(serverHeapReserve(limit))} MB it keeps for its other work)`;
  // a project already past it (grown in browser editors): nothing of the operator to lower
  const layers = holdsLayers(req);
  if (projectNeed(req.storedBytes, save) > max)
    return {
      reason:
        `${what} already take about ${mbUp(req.storedBytes)} MB of memory${now}${shares ? ` (${shares})` : ''}` +
        `${savingClause(req.storedBytes, save, layers, history)}${keeps}`,
      already: true,
    };
  return {
    reason:
      `${what} would then take about ${mbUp(kept)} MB of memory${adds(e)} (now ${mb(req.storedBytes)} MB${now}` +
      `${shares ? `, ${shares}` : ''})` +
      `${savingClause(kept, save + (e.addedSaveBytes ?? 0), layers || (e.layers?.bytes ?? 0) > 0, history)}${keeps}`,
    already: false,
  };
}

/**
 * The error of an operator the server does not run because the project would then need more than
 * the server keeps for one: its meshes decoded, its objects, datablocks and animation, and what a
 * save of it takes for a moment (`limit`: the heap limit in bytes, see {@link maxProjectMeshBytes}).
 * `req` must be past that limit (see {@link operatorCheck}).
 */
export function storedMeshesMessage(req: ProjectRequest, limit = heapLimitBytes()): string {
  const r = projectLimitReason(req, limit) ?? {
    reason: projectLimitReason({ ...req, storedBytes: Infinity }, limit)!.reason,
    already: true,
  };
  const free = freeCacheAdvice((req.simulation ?? 0) > 0) + historyAdvice(req);
  if (r.already)
    return `not run on the server: ${r.reason}, and this operator would add to them. Delete objects and meshes the project no longer needs${free}`;
  const e = req.estimate;
  return (
    `not run on the server: ${r.reason}. ` +
    (e.lower ? `Lower ${e.lower}, or delete` : 'Delete') +
    ` objects and meshes the project no longer needs${free}`
  );
}

/** At most this many other open projects are named in a refusal (the rest are summed up). */
export const NAMED_OPEN_PROJECTS = 5;

/**
 * Why what `req.estimate` adds to the project of `req` would take all open projects past what the
 * server keeps for them ({@link maxOpenProjectsBytes}: what they keep and the largest save among
 * them; null: it fits): a clause without a verb before it, naming the other open projects and what
 * they take.
 */
function openProjectsReason(
  req: ProjectRequest,
  others: readonly OpenProjectSize[],
  limit: number,
): string | null {
  if (!others.length) return null;
  const e = req.estimate;
  const kept = req.storedBytes + e.addedStoredBytes;
  const save = (req.saveBytes ?? 0) + (e.addedSaveBytes ?? 0);
  let othersKept = 0;
  let largestSave = save;
  for (const o of others) {
    othersKept += o.kept;
    largestSave = Math.max(largestSave, o.save);
  }
  const max = maxOpenProjectsBytes(limit);
  const all = othersKept + kept;
  if (all + largestSave <= max) return null;
  const named = others.slice(0, NAMED_OPEN_PROJECTS).map((o) => {
    const shares = heldShares(o);
    return `'${o.name}'${o.id ? ` (${o.id})` : ''} ${mbUp(o.kept)} MB${shares.length ? ` (${shares.join(', ')})` : ''}`;
  });
  const rest = others.slice(NAMED_OPEN_PROJECTS);
  if (rest.length) named.push(`${n(rest.length)} more ${mbUp(rest.reduce((t, o) => t + o.kept, 0))} MB`);
  const a = Math.ceil(all / MB);
  const s = Math.ceil(largestSave / MB);
  const caches = heldRigidBodyCaches(req, others) || addsFrames(req);
  return (
    `the open projects' ${contents(caches, 2)} would then take about ${n(a)} MB of ` +
    `memory${adds(e)}, and the largest save among them about ${n(s)} MB more for a moment: ${n(a + s)} MB in ` +
    `all, more than the ${mbDown(max)} MB the server's process keeps for all open projects (its ${mb(limit)} MB ` +
    `heap less the ${mb(serverHeapReserve(limit))} MB it keeps for its other work and the ` +
    `${mb(evaluationCacheBytes(limit))} MB of cached scene evaluations). Other open projects take ` +
    `${mbUp(othersKept)} MB of it: ${named.join(', ')}`
  );
}

/** Whether the project of `req` or one of `others` holds a rigid body cache. */
const heldRigidBodyCaches = (req: ProjectRequest, others: readonly OpenProjectSize[]): boolean =>
  (req.simulation ?? 0) > 0 || others.some((o) => (o.simulation ?? 0) > 0);

/** The advice after {@link openProjectsReason}: what to lower, what to delete, when projects close. */
const OPEN_PROJECTS_ADVICE =
  'objects and meshes the projects no longer need (a project nobody has open, no editor and no MCP session, ' +
  'is unloaded after ROOM_IDLE_TTL_SECONDS, default 3600 s)';

/**
 * The error of an operator the server does not run because all open projects would then need more
 * than it keeps for them ({@link maxOpenProjectsBytes}); `req` must be past that limit with `others`.
 */
export function openProjectsMessage(
  req: ProjectRequest,
  others: readonly OpenProjectSize[],
  limit = heapLimitBytes(),
): string {
  const reason = openProjectsReason(req, others, limit);
  const e = req.estimate;
  return (
    `not run on the server: ${reason}. ` +
    (e.lower ? `Lower ${e.lower}, or delete ` : 'Delete ') +
    OPEN_PROJECTS_ADVICE +
    freeCacheAdvice(heldRigidBodyCaches(req, others), 2) +
    historyAdvice(req, ...others)
  );
}

/**
 * Whether the project of `scene` can take `kept` more bytes that it keeps and `saved` more that a
 * save of it takes for a moment (core memory-objects.ts: KEYFRAME_STORED_BYTES, OBJECT_STORED_BYTES …
 * and saveBytes), for a change that does not come from an operator (the sync of a browser editor):
 * null when it fits, else why not, as a clause the caller completes (e.g. "the project's meshes,
 * objects, keyframes and images would then take about 812 MB of memory (now 700 MB with 15,000
 * objects), and a save of it … more than the 786 MB the server's process keeps for one project (…)",
 * or the same of all open projects, naming the others). Held against the limit per project
 * ({@link maxProjectMeshBytes}) and, with the other open projects, against
 * {@link maxOpenProjectsBytes}; what a project keeps includes its rigid body cache (core
 * rigidBodyCacheBytes; the clause then names it). Tracks `scene` as open ({@link trackOpenProject}).
 * `heapLimit`: the heap limit in bytes (default: this process's).
 */
export function projectGrowthRefusal(
  scene: SceneDoc,
  kept: number,
  saved: number,
  opts: { heapLimit?: () => number } = {},
): string | null {
  trackOpenProject(scene);
  const limit = (opts.heapLimit ?? heapLimitBytes)();
  const project = projectObjects(scene);
  const req = withHeld({
    operator: '',
    estimate: {
      bytes: 0,
      faces: 0,
      addedStoredBytes: Math.max(0, kept),
      addedSaveBytes: Math.max(0, saved),
      lower: '',
    },
    storedBytes: storedMeshBytes(scene) + project.bytes,
    saveBytes: project.save,
    objects: project.objects,
    doc: scene,
  });
  return projectLimitReason(req, limit)?.reason ?? openProjectsReason(req, otherOpenProjects(scene), limit);
}

/** The error of a stored mesh the server does not decode (see `decodeCheck`; bytes as above). */
export function refusedDecodeMessage(req: MeshMemoryRequest, free: number, limit = heapLimitBytes()): string {
  const l = req.layout;
  return (
    `this mesh of ${counted(Math.max(0, l.corners - 2 * l.faces), 'triangle')} was not loaded on the server: decoding it ` +
    `needs about ${mb(req.bytes)} MB of JavaScript heap, and ${heapClause(free, limit)} ` +
    '(the open projects keep their meshes decoded). Delete or simplify large meshes, or work on it in a browser ' +
    'editor that has the project open, which loads it in its own memory'
  );
}

/**
 * The server's check of operators (core `setOperatorMemoryCheck`): refuses one that adds meshes or
 * objects beyond {@link maxProjectMeshBytes} (counted with what a save of the project takes and its
 * rigid body cache) or beyond {@link maxOpenProjectsBytes} with the other open projects, or whose
 * estimated peak heap does not fit into the free heap less the reserve ({@link serverHeapReserve}).
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
    trackOpenRoom(req.doc);
    if (e.addedStoredBytes > 0) {
      const r = withHeld(req);
      if (projectLimitReason(r, limit)) return storedMeshesMessage(r, limit);
      const others = otherOpenProjects(req.doc);
      if (openProjectsReason(r, others, limit)) return openProjectsMessage(r, others, limit);
    }
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
 * "not simulated on the server: simulating N rigid bodies to frame F keeps K more frames of their poses, about X MB"
 * ("1 rigid body … of its pose").
 */
function simulationClause(req: SimulationMemoryRequest): string {
  const bodies = req.bodies.simulated + req.bodies.kinematic;
  const one = Math.round(bodies) === 1;
  return (
    `not simulated on the server: simulating ${counted(bodies, 'rigid body', 'rigid bodies')} to frame ` +
    `${n(req.frame)} keeps ${counted(req.frames, 'more frame')} of ${one ? 'its pose' : 'their poses'}, about ` +
    `${mbUp(req.bytes)} MB`
  );
}

/** What to lower for a simulation the server does not step. */
const SIMULATION_ADVICE =
  "Lower the rigid body world's frame range (rigidbody.world_set frame_end) or the number of rigid bodies to " +
  'simulate it on the server (a browser editor simulates it itself)';

/**
 * The error of a rigid body simulation the server does not step because its frames do not fit into
 * the free heap less the reserve (see `simulationCheck`; `free`, `limit`: the free heap and the heap
 * limit, in bytes).
 */
export function refusedSimulationMessage(
  req: SimulationMemoryRequest,
  free: number,
  limit = heapLimitBytes(),
): string {
  return `${simulationClause(req)}, and ${heapClause(free, limit)}. ${SIMULATION_ADVICE}`;
}

/**
 * The error of a rigid body simulation the server does not step because its frames would take its
 * project past what the server keeps for one (`reason`: the clause of the limit), or all open
 * projects past what it keeps for them (`others`: the other open projects then). Only the caches of
 * other projects are worth freeing: the frames its own cache holds are the first of those it needs.
 */
export function simulationLimitMessage(
  req: SimulationMemoryRequest,
  reason: string,
  others?: readonly OpenProjectSize[],
  history = 0,
): string {
  const held = !!others?.some((o) => (o.simulation ?? 0) > 0);
  return (
    `${simulationClause(req)}, and ${reason}. ${SIMULATION_ADVICE}, or delete ` +
    (others
      ? `${OPEN_PROJECTS_ADVICE}${freeCacheAdvice(held, 2)}`
      : 'objects and meshes the project no longer needs') +
    historyAdvice({ history }, ...(others ?? []))
  );
}

/**
 * The server's check of rigid body simulations (core `setSimulationMemoryCheck`): refuses frames that
 * would take the simulated document's project past what the server keeps for one
 * ({@link maxProjectMeshBytes}: its rigid body cache counts with what it keeps) or, with the other
 * open projects, past {@link maxOpenProjectsBytes}; and frames that do not fit into the free heap
 * less the reserve ({@link serverHeapReserve}): a simulation's frames are ArrayBuffers outside the
 * heap's limit for the most part, which the process holds all the same, so the free heap is counted
 * without those all cached simulations hold ({@link freeHeapBytes}). Tracks a room's document as an
 * open project.
 */
export function simulationCheck(
  opts: { heapFree?: () => number; collect?: () => unknown; heapLimit?: () => number } = {},
): SimulationMemoryCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  const heapLimit = opts.heapLimit ?? heapLimitBytes;
  return (req) => {
    const limit = heapLimit();
    const doc = req.doc;
    if (doc) {
      trackOpenRoom(doc);
      const p = projectSize(doc);
      const r: ProjectRequest = {
        operator: '',
        estimate: { bytes: req.bytes, faces: 0, addedStoredBytes: req.bytes, addedSaveBytes: 0, lower: '' },
        storedBytes: p.stored,
        saveBytes: p.save,
        objects: p.objects,
        doc,
        simulation: p.simulation,
        history: p.history,
        simulating: true,
      };
      const project = projectLimitReason(r, limit);
      if (project) return simulationLimitMessage(req, project.reason, undefined, p.history);
      const others = otherOpenProjects(doc);
      const all = openProjectsReason(r, others, limit);
      if (all) return simulationLimitMessage(req, all, others, p.history);
    }
    const { ok, free } = fits(req.bytes, heapFree, collect, limit);
    return ok ? null : refusedSimulationMessage(req, free, limit);
  };
}

/**
 * Installs the server's memory checks for this process (the server's process only): modifier
 * evaluations ({@link geometryCheck}), operators ({@link operatorCheck}), decoding stored meshes
 * ({@link decodeCheck}) and rigid body simulations ({@link simulationCheck}).
 */
export function installGeometryMemoryGuard(): void {
  setGeometryMemoryCheck(geometryCheck());
  setOperatorMemoryCheck(operatorCheck());
  setMeshMemoryCheck(decodeCheck());
  setSimulationMemoryCheck(simulationCheck());
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
      `(about ${counted(est.triangles, 'triangle')}), and ${what}s run in the server's own process ` +
      `(its render processes are off: RENDER_WORKERS=0, or they could not start), which has ` +
      `${Math.max(0, Math.floor(free / MB))} MB of its ${limit} MB heap free; running out of it would stop the server`,
    limit,
    'refused',
  );
}
