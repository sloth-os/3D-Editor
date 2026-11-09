import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  estimateModifier,
  meshSize,
  setGeometryMemoryCheck,
  type GeometryMemoryCheck,
  type GeometryMemoryRequest,
  type MeshSize,
  type SceneDoc,
} from '@3d-editor/core';
import { RenderOutOfMemoryError } from './protocol';

/*
 * The server's own process shares one JavaScript heap with every editor connection, agent session
 * and project room, and V8 aborts the whole process when that heap runs out (a fatal error, not an
 * exception). Two guards keep its own work from doing that:
 *
 * - Modifier evaluations (scene summaries, mesh data, operators such as Apply of MCP tools and
 *   the REST API): every modifier asks `geometryCheck` before it runs (core eval/memory.ts); one
 *   whose estimated peak heap does not fit into the free heap, less SERVER_HEAP_RESERVE_BYTES, is
 *   skipped and reported as that modifier's error. Installed by `installGeometryMemoryGuard` when
 *   the server's render module loads (index.ts); render processes do not install it (running out
 *   of memory there ends only the render process).
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

/** The error of a modifier the server skips for memory (see `geometryCheck`). */
export function skippedModifierMessage(req: GeometryMemoryRequest, free: number): string {
  const e = req.estimate;
  return (
    `skipped on the server: this ${req.label} would need about ${n(e.bytes / MB)} MB of JavaScript heap for ` +
    `a result of about ${n(e.result.faces)} faces, and the server's process has ${n(Math.max(0, free) / MB)} MB ` +
    `of its ${n(heapLimitMb())} MB heap free and keeps ${n(SERVER_HEAP_RESERVE_BYTES / MB)} MB of it for its ` +
    `other work. Lower ${e.lower} to evaluate it on the server (a browser editor evaluates it itself)`
  );
}

/**
 * The server's check of modifier evaluations (core `setGeometryMemoryCheck`): skips a modifier
 * whose estimated peak heap does not fit into the free heap less SERVER_HEAP_RESERVE_BYTES.
 */
export function geometryCheck(
  opts: { heapFree?: () => number; collect?: () => unknown } = {},
): GeometryMemoryCheck {
  const heapFree = opts.heapFree ?? freeHeapBytes;
  const collect = opts.collect ?? collectGarbage;
  return (req) => {
    const { ok, free } = fits(req.estimate.bytes, heapFree, collect);
    return ok ? null : skippedModifierMessage(req, free);
  };
}

/** Installs {@link geometryCheck} for this process's evaluations (the server's process only). */
export function installGeometryMemoryGuard(): void {
  setGeometryMemoryCheck(geometryCheck());
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
    `this ${what} was not started: it needs about ${Math.ceil(est.bytes / MB)} MB of JavaScript heap ` +
      `(about ${est.triangles.toLocaleString('en-US')} triangles), and ${what}s run in the server's own process ` +
      `(its render processes are off: RENDER_WORKERS=0, or they could not start), which has ` +
      `${Math.max(0, Math.floor(free / MB))} MB of its ${limit} MB heap free; running out of it would stop the server`,
    limit,
    'refused',
  );
}
