import * as Y from 'yjs';
import {
  MAX_ANIMATION_FRAMES,
  contactSheetLayout,
  type AnimationFormat,
  type ExportFormat,
  type GIFDither,
  type SceneDoc,
} from '@3d-editor/core';
import { renderAnimationParallel, type AnimationOutput, type AnimationProgress } from './animation';
import { pathTraces } from './engine';
import { checkMainThreadRender, collectGarbage, freeHeapBytes, installGeometryMemoryGuard } from './memory';
import { abortable, pathTraceParallel } from './path-trace';
import {
  RenderPool,
  defaultRenderThreads,
  type RenderPoolLog,
  type RenderPoolOptions,
  type RenderThread,
} from './pool';
import {
  RenderCancelledError,
  isCancelled,
  type DocRef,
  type ExportJobOptions,
  type ExportedFile,
  type FrameOptions,
  type ImageResult,
  type PhysicsFrame,
  type SimulatedFrames,
} from './protocol';

export { RenderPool, defaultRenderThreads, MAX_SHARED_RENDERS } from './pool';
export type { LeaseOptions, RenderPoolOptions, RenderLease, RenderThread } from './pool';
export { RENDER_HEAP_BYTES_PER_TRIANGLE, estimateRenderMemory, estimateRenderTriangles } from './memory';
export { RenderCancelledError, RenderOutOfMemoryError, isCancelled, isOutOfMemory } from './protocol';
export type { ExportJobOptions, ExportedFile, FrameOptions, ViewSpecInput } from './protocol';
export type { AnimationOutput, AnimationProgress } from './animation';

// the server's evaluations (scene summaries, mesh data, operators of MCP tools and the REST API)
// skip a modifier whose result would not fit into the server's free heap instead of running the
// whole server out of memory (memory.ts); render processes do not load this module
installGeometryMemoryGuard();

/*
 * Server-side rendering for MCP tools and the REST API, off the event loop: raster stills run on
 * one free render thread (interactive leases: they never wait for long renders), path traced
 * images on all render threads (bands of rows, see path-trace.ts) and animations frame by frame in
 * parallel (see animation.ts); two long renders share the threads (see pool.ts). Render threads
 * are render processes (`RENDER_WORKERS`, default: CPU cores up to 8, plus one for interactive
 * renders; a render that runs out of memory ends only its process) or, with RENDER_WORKERS=0 or
 * when render processes cannot start, the main thread (one band or frame per event loop turn),
 * where a render that would not fit into the server's free heap is refused (memory.ts).
 */

/** Largest path traced image (pixels): film, denoiser and display buffers take ~150 bytes per pixel. */
export const MAX_PATHTRACE_PIXELS = 2048 * 1280;
/** Largest raster image (pixels). */
export const MAX_RASTER_PIXELS = 4096 * 4096;
/** Most pixels of all frames of a GIF or contact sheet (every frame is kept in memory). */
export const MAX_ANIMATION_KEPT_PIXELS = 1 << 25;
/** Largest contact sheet image (pixels). */
export const MAX_CONTACT_SHEET_PIXELS = 1 << 24;
/** Concurrent path traced renders (each holds a film; others wait). */
const MAX_CONCURRENT_PATHTRACE = 2;
/**
 * Most numbers of rigid body matrices (frames × bodies × 16) shared per document: 16 MB. Larger
 * simulations are not shared (every render thread simulates for itself).
 */
const MAX_PHYSICS_NUMBERS = 2_000_000;

/** Error for invalid render requests (shown to the caller as is). */
export class RenderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderRequestError';
  }
}

/** Progress of a render (path tracing: samples; animations: frames). */
export interface RenderProgress {
  progress: number;
  total: number;
  message: string;
}

/** One image to render (see {@link Renderer.renderImage}). */
export interface RenderImageRequest {
  scene: SceneDoc;
  /** Project id (part of the render threads' document cache key). */
  projectId: string;
  options: FrameOptions;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
}

/** A rendered PNG with what was rendered and how. */
export interface RenderImageResult {
  png: Uint8Array;
  width: number;
  height: number;
  engine: 'RASTER' | 'PATHTRACER';
  /** Render threads used and where they run. */
  threads: number;
  mode: 'processes' | 'main-thread';
  elapsedMs: number;
  pathtrace?: {
    samples: number;
    requested: number;
    stopped: 'done' | 'time' | 'cancelled';
    prepare_ms?: number;
    render_ms?: number;
    resolve_ms?: number;
  };
  warnings: string[];
}

/** A file to export (see {@link Renderer.exportScene}). */
export interface ExportRequest {
  scene: SceneDoc;
  projectId: string;
  format: ExportFormat;
  options: ExportJobOptions;
  signal?: AbortSignal;
}

/** An exported file, with where and how long it took. */
export interface ExportResult extends ExportedFile {
  mode: 'processes' | 'main-thread';
  elapsedMs: number;
}

/** An animation to render (see {@link Renderer.renderAnimation}). */
export interface RenderAnimationRequest {
  scene: SceneDoc;
  projectId: string;
  format: AnimationFormat;
  frame_start: number;
  frame_end: number;
  frame_step: number;
  width: number;
  height: number;
  /** Playback rate (default: scene fps / frame_step). */
  fps?: number;
  /** Shared frame options (engine explicit). */
  base: Omit<FrameOptions, 'frame' | 'time_limit' | 'width' | 'height'>;
  /**
   * A camera per rendered frame (frame_start, frame_start + frame_step, …; undefined entries use
   * `base.cameraId`): the shot cameras of camera 'shots'.
   */
  cameras?: readonly (string | undefined)[];
  /** PATHTRACER: time budget per frame (seconds). */
  frame_time_limit?: number;
  /** Total time budget (seconds, 0 = none). */
  time_limit?: number;
  animated_seed?: boolean;
  loop?: number;
  dither?: GIFDither;
  colors?: number;
  columns?: number;
  /** Most frames accepted (default MAX_ANIMATION_FRAMES of core). */
  max_frames?: number;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
}

interface DocState {
  key: string;
  /** Version of the current document state, null after a change. */
  version: number | null;
  /** The encoded state of `version` while something still holds it. */
  buffer: WeakRef<Uint8Array> | null;
  /** Rigid body matrices simulated for a version of the document, by frame. */
  physics: { version: number; frames: Map<number, PhysicsFrame>; numbers: number } | null;
}

/** Whether evaluating the scene runs the rigid body simulation (as `SceneEvaluator` decides). */
function simulatesRigidBodies(scene: SceneDoc): boolean {
  return (
    !!scene.getScene().rigidbody_world?.enabled && scene.listObjects().some((o) => o.rigid_body?.enabled)
  );
}

let nextVersion = 1;

/** A counting semaphore with abortable, first-come first-served waits (slots are handed over). */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RenderCancelledError();
    if (this.active < this.max) this.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.waiting.indexOf(grant);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new RenderCancelledError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(grant);
      });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Options of a {@link Renderer}. */
export interface RendererOptions {
  /**
   * The free JavaScript heap of the server's process in bytes (default: from V8), which a render in
   * single-thread mode must fit into (see memory.ts).
   */
  heapFree?: () => number;
  /** Runs a full garbage collection before a render is refused (default: memory.ts `collectGarbage`). */
  collectGarbage?: () => unknown;
  /** The JavaScript heap limit of the server's process in bytes (default: from V8). */
  heapLimit?: () => number;
}

/** Renders scenes on a {@link RenderPool}. */
export class Renderer {
  private readonly states = new WeakMap<Y.Doc, DocState>();
  private readonly pathtraceSlots = new Semaphore(MAX_CONCURRENT_PATHTRACE);
  private readonly heapFree: () => number;
  private readonly collectGarbage: () => unknown;
  private readonly heapLimit: (() => number) | undefined;

  constructor(
    readonly pool: RenderPool,
    opts: RendererOptions = {},
  ) {
    this.heapFree = opts.heapFree ?? freeHeapBytes;
    this.collectGarbage = opts.collectGarbage ?? collectGarbage;
    this.heapLimit = opts.heapLimit;
  }

  /**
   * Refuses a render of `scene` on the server's main thread (single-thread mode) that would not
   * fit into the server's free heap (a RenderOutOfMemoryError), instead of running it out of
   * memory and stopping the server. Render processes need no such check: running out of memory
   * there ends only the render process.
   */
  private guardMainThread(
    threads: readonly RenderThread[],
    scene: SceneDoc,
    what: 'render' | 'export' = 'render',
  ): void {
    if (threads.some((t) => t.kind === 'main'))
      checkMainThreadRender(scene, this.heapFree, this.collectGarbage, what, this.heapLimit);
  }

  /**
   * The state of `scene` for render threads: encoded once per document change (and again only
   * when the encoded state was garbage collected meanwhile); render processes that already have
   * this version get the request without it (see `DocRef`).
   */
  docRef(projectId: string, scene: SceneDoc): DocRef {
    const ydoc = scene.ydoc;
    let s = this.states.get(ydoc);
    if (!s) {
      const state: DocState = {
        key: `${projectId}:${ydoc.guid}`,
        version: null,
        buffer: null,
        physics: null,
      };
      ydoc.on('update', () => {
        state.version = null;
        state.buffer = null;
      });
      this.states.set(ydoc, state);
      s = state;
    }
    let buffer = s.buffer?.deref();
    if (s.version === null || !buffer) {
      buffer = Y.encodeStateAsUpdate(ydoc);
      s.buffer = new WeakRef(buffer);
      // the same content keeps its version when only the buffer was collected
      s.version ??= nextVersion++;
    }
    return { key: s.key, version: s.version, update: buffer };
  }

  /**
   * The rigid body simulation at `frames`, for every render thread of a render: simulated once on
   * `thread` (incrementally, with that thread's simulation cache) and kept for this version of the
   * document, so later renders of the same frames — on any thread, also after threads dropped
   * their caches or were restarted — do not simulate again. Null when the scene has no rigid body
   * simulation, or when it is too large to share (each thread then simulates for itself).
   */
  async physics(
    scene: SceneDoc,
    doc: DocRef,
    frames: readonly number[],
    thread: RenderThread,
    signal?: AbortSignal,
  ): Promise<Map<number, PhysicsFrame> | null> {
    if (!simulatesRigidBodies(scene)) return null;
    const state = this.states.get(scene.ydoc);
    if (!state) return null;
    let cache = state.physics;
    if (!cache || cache.version !== doc.version)
      cache = state.physics = { version: doc.version, frames: new Map(), numbers: 0 };
    const out = new Map<number, PhysicsFrame>();
    const missing: number[] = [];
    for (const f of new Set(frames)) {
      const cached = cache.frames.get(f);
      if (cached) out.set(f, cached);
      else missing.push(f);
    }
    if (missing.length) {
      const bodies = scene.listObjects().filter((o) => o.rigid_body?.enabled).length;
      const size = missing.length * bodies * 16;
      if (size > MAX_PHYSICS_NUMBERS) return null;
      if (cache.numbers + size > MAX_PHYSICS_NUMBERS) {
        cache.frames.clear();
        cache.numbers = 0;
        for (const f of out.keys()) missing.push(f);
        out.clear();
      }
      let res: SimulatedFrames;
      try {
        res = await abortable(
          thread.call<SimulatedFrames>({ type: 'simulate', doc, frames: missing }),
          signal,
        );
      } catch (err) {
        if (isCancelled(err)) throw err;
        // render threads evaluate (and report) the simulation themselves
        return null;
      }
      // the document may have changed meanwhile: only keep results for the version they belong to
      const keep = state.physics === cache;
      for (const f of res.frames) {
        out.set(f.frame, f);
        if (keep) {
          cache.frames.set(f.frame, f);
          cache.numbers += f.matrices.length;
        }
      }
    }
    return out;
  }

  /** Renders one image (PNG). */
  async renderImage(req: RenderImageRequest): Promise<RenderImageResult> {
    const o = req.options;
    const t0 = performance.now();
    const pt = pathTraces(o);
    const pixels = o.width * o.height;
    if (!(o.width >= 1 && o.height >= 1)) throw new RenderRequestError('width and height must be at least 1');
    if (pt && pixels > MAX_PATHTRACE_PIXELS)
      throw new RenderRequestError(
        `A path traced image of ${o.width}×${o.height} is too large (at most ${MAX_PATHTRACE_PIXELS} pixels, e.g. 2048×1280): render smaller`,
      );
    if (pixels > MAX_RASTER_PIXELS)
      throw new RenderRequestError(`Render size ${o.width}×${o.height} exceeds ${MAX_RASTER_PIXELS} pixels`);
    const doc = this.docRef(req.projectId, req.scene);
    if (pt) {
      const releaseSlot = await this.pathtraceSlots.acquire(req.signal);
      try {
        const lease = await this.pool.lease(Infinity, req.signal);
        try {
          this.guardMainThread(lease.threads, req.scene);
          // the rigid body simulation runs once (not on every thread)
          const physics = await this.physics(req.scene, doc, [o.frame], lease.threads[0], req.signal);
          const options = physics?.has(o.frame) ? { ...o, physics: physics.get(o.frame) } : o;
          const r = await pathTraceParallel(lease.threads, doc, options, {
            signal: req.signal,
            png: true,
            onProgress: (p) =>
              req.onProgress?.({
                progress: p.samples,
                total: p.total,
                message: `path tracing: ${p.samples}/${p.total} samples per pixel`,
              }),
          });
          return {
            png: r.png!,
            width: r.width,
            height: r.height,
            engine: 'PATHTRACER',
            threads: lease.threads.length,
            mode: this.pool.mode,
            elapsedMs: Math.round(performance.now() - t0),
            pathtrace: {
              samples: r.pathtrace.samples,
              requested: r.pathtrace.requested,
              stopped: r.pathtrace.stopped,
              prepare_ms: r.pathtrace.prepareMs,
              render_ms: r.pathtrace.renderMs,
              resolve_ms: r.pathtrace.resolveMs,
            },
            warnings: r.warnings ?? [],
          };
        } finally {
          lease.release();
        }
      } finally {
        releaseSlot();
      }
    }
    const lease = await this.pool.lease(1, req.signal, { interactive: true });
    try {
      this.guardMainThread(lease.threads, req.scene);
      const physics = await this.physics(req.scene, doc, [o.frame], lease.threads[0], req.signal);
      const options = physics?.has(o.frame) ? { ...o, physics: physics.get(o.frame) } : o;
      const img = await abortable(
        lease.threads[0].call<ImageResult>({ type: 'image', doc, options, png: true }),
        req.signal,
      );
      return {
        png: img.png!,
        width: img.width,
        height: img.height,
        engine: 'RASTER',
        threads: 1,
        mode: this.pool.mode,
        elapsedMs: Math.round(performance.now() - t0),
        warnings: img.warnings ?? [],
      };
    } finally {
      lease.release();
    }
  }

  /**
   * Exports the scene (glTF, OBJ, STL, PLY) on a render thread, like a raster still (one free
   * thread; it never waits for long renders): a glTF export samples the animation frame by frame
   * and bakes procedural textures, which takes seconds on large scenes and used to hold up the
   * event loop that serves every editor and agent. The thread exports the document state of the
   * moment of the call. In single-thread mode (RENDER_WORKERS=0) it runs on the main thread.
   */
  async exportScene(req: ExportRequest): Promise<ExportResult> {
    const t0 = performance.now();
    const doc = this.docRef(req.projectId, req.scene);
    const lease = await this.pool.lease(1, req.signal, { interactive: true });
    try {
      this.guardMainThread(lease.threads, req.scene, 'export');
      const file = await abortable(
        lease.threads[0].call<ExportedFile>({
          type: 'export',
          doc,
          format: req.format,
          options: req.options,
        }),
        req.signal,
      );
      return { ...file, mode: this.pool.mode, elapsedMs: Math.round(performance.now() - t0) };
    } finally {
      lease.release();
    }
  }

  /** Renders an animation (validated like core `renderAnimation`, with stricter memory limits). */
  async renderAnimation(req: RenderAnimationRequest): Promise<AnimationOutput> {
    const { format, frame_start: start, frame_end: end, frame_step: step, width, height } = req;
    if (!Number.isFinite(start) || !Number.isFinite(end))
      throw new RenderRequestError('frame_start and frame_end must be numbers');
    if (end < start) throw new RenderRequestError(`frame_end (${end}) is before frame_start (${start})`);
    if (!(Number.isInteger(step) && step >= 1))
      throw new RenderRequestError(`frame_step must be a whole number >= 1 (got ${step})`);
    const total = Math.floor((end - start) / step) + 1;
    const maxFrames = Math.min(req.max_frames ?? MAX_ANIMATION_FRAMES, MAX_ANIMATION_FRAMES);
    if (total > maxFrames)
      throw new RenderRequestError(
        `Too many frames (${total}, at most ${maxFrames}): shorten the range or raise frame_step`,
      );
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
      throw new RenderRequestError(`Invalid frame size ${width}×${height}`);
    const pt = pathTraces(req.base);
    if (pt && width * height > MAX_PATHTRACE_PIXELS)
      throw new RenderRequestError(`Path traced frames of ${width}×${height} are too large`);
    if (
      (format === 'GIF' || format === 'CONTACT_SHEET') &&
      width * height * total > MAX_ANIMATION_KEPT_PIXELS
    )
      throw new RenderRequestError(
        `A ${format === 'GIF' ? 'GIF' : 'contact sheet'} of ${total} frames at ${width}×${height} is too large ` +
          `(at most ${MAX_ANIMATION_KEPT_PIXELS} pixels in all): reduce the size or the number of frames (frame_step)`,
      );
    if (format === 'CONTACT_SHEET') {
      const sheet = contactSheetLayout(total, width, height, { columns: req.columns });
      if (sheet.width * sheet.height > MAX_CONTACT_SHEET_PIXELS)
        throw new RenderRequestError(
          `A contact sheet of ${total} frames at ${width}×${height} would be ${sheet.width}×${sheet.height} pixels ` +
            `(at most ${MAX_CONTACT_SHEET_PIXELS}): use smaller frames or fewer of them`,
        );
    }
    const fps = req.fps ?? (req.scene.getScene().fps || 24) / step;
    if (!(Number.isFinite(fps) && fps > 0)) throw new RenderRequestError(`fps must be positive (got ${fps})`);
    const frames = Array.from({ length: total }, (_, i) => start + i * step);
    const doc = this.docRef(req.projectId, req.scene);
    const releaseSlot = pt ? await this.pathtraceSlots.acquire(req.signal) : () => undefined;
    try {
      const lease = await this.pool.lease(Infinity, req.signal);
      try {
        this.guardMainThread(lease.threads, req.scene);
        return await renderAnimationParallel(
          lease.threads,
          doc,
          {
            format,
            frames,
            width,
            height,
            fps,
            base: req.base,
            cameras: req.cameras,
            frameTimeLimit: req.frame_time_limit,
            timeLimit: req.time_limit,
            animatedSeed: req.animated_seed,
            loop: req.loop,
            dither: req.dither,
            colors: req.colors,
            columns: req.columns,
          },
          {
            signal: req.signal,
            onProgress: (p: AnimationProgress) =>
              req.onProgress?.({
                progress: p.done,
                total: p.total,
                message: `rendered frame ${p.frame} (${p.done}/${p.total})`,
              }),
            // the rigid body simulation of all frames runs once, on one thread
            physics: (thread, list) => this.physics(req.scene, doc, list, thread, req.signal),
          },
        );
      } finally {
        lease.release();
      }
    } finally {
      releaseSlot();
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/** Render processes configured by `RENDER_WORKERS` (0 = main thread; default: CPU cores up to 8). */
export function renderThreadsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RENDER_WORKERS?.trim();
  if (!raw) return defaultRenderThreads();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`RENDER_WORKERS must be a whole number >= 0 (got '${raw}')`);
  return Math.min(64, n);
}

/**
 * The JavaScript heap limit of each render process configured by `RENDER_WORKER_MEMORY_MB` (MB,
 * at least 64), or undefined for Node's default (2096 MB on a machine with 16 GB of memory).
 */
export function renderMemoryFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.RENDER_WORKER_MEMORY_MB?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 64)
    throw new Error(`RENDER_WORKER_MEMORY_MB must be a whole number of megabytes >= 64 (got '${raw}')`);
  return n;
}

let shared: Renderer | null = null;

/**
 * Stops the process-wide renderer's render processes (server shutdown): a busy render process
 * would otherwise run on until its request ends.
 */
export async function closeSharedRenderer(): Promise<void> {
  const r = shared;
  shared = null;
  await r?.close();
}

/**
 * The process-wide renderer (render processes are a machine resource shared by every app
 * instance). Created on first use; its render processes start lazily and stop when idle.
 */
export function sharedRenderer(opts: { log?: RenderPoolLog } & RenderPoolOptions = {}): Renderer {
  if (!shared) {
    let threads = opts.threads;
    if (threads === undefined) {
      try {
        threads = renderThreadsFromEnv();
      } catch (err) {
        opts.log?.warn({ err: String(err) }, 'invalid RENDER_WORKERS, using the default');
        threads = defaultRenderThreads();
      }
    }
    let heapLimitMb = opts.heapLimitMb;
    if (heapLimitMb === undefined) {
      try {
        heapLimitMb = renderMemoryFromEnv();
      } catch (err) {
        opts.log?.warn({ err: String(err) }, "invalid RENDER_WORKER_MEMORY_MB, using Node's default");
      }
    }
    shared = new Renderer(new RenderPool({ ...opts, threads, heapLimitMb }));
  }
  return shared;
}
