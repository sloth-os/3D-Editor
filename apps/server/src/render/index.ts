import * as Y from 'yjs';
import {
  MAX_ANIMATION_FRAMES,
  contactSheetLayout,
  type AnimationFormat,
  type GIFDither,
  type SceneDoc,
} from '@3d-editor/core';
import { renderAnimationParallel, type AnimationOutput, type AnimationProgress } from './animation';
import { pathTraces } from './engine';
import { abortable, pathTraceParallel } from './path-trace';
import { RenderPool, defaultRenderThreads, type RenderPoolLog, type RenderPoolOptions } from './pool';
import { RenderCancelledError, type DocRef, type FrameOptions, type ImageResult } from './protocol';

export { RenderPool, defaultRenderThreads } from './pool';
export type { RenderPoolOptions, RenderLease, RenderThread } from './pool';
export { RenderCancelledError, isCancelled } from './protocol';
export type { FrameOptions, ViewSpecInput } from './protocol';
export type { AnimationOutput, AnimationProgress } from './animation';

/*
 * Server-side rendering for MCP tools and the REST API, off the event loop: raster renders run on
 * one render thread, path traced renders on all of them (bands of rows, see path-trace.ts) and
 * animations frame by frame in parallel (see animation.ts). Render threads are worker threads
 * (`RENDER_WORKERS`, default: CPU cores up to 8) or, with RENDER_WORKERS=0 or when workers cannot
 * start, the main thread (one band or frame per event loop turn).
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
  mode: 'workers' | 'main-thread';
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
  buffer: WeakRef<SharedArrayBuffer> | null;
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

/** Renders scenes on a {@link RenderPool}. */
export class Renderer {
  private readonly states = new WeakMap<Y.Doc, DocState>();
  private readonly pathtraceSlots = new Semaphore(MAX_CONCURRENT_PATHTRACE);

  constructor(readonly pool: RenderPool) {}

  /**
   * The state of `scene` for render threads: encoded once per document change and shared with
   * every thread (threads that already have this version skip it).
   */
  docRef(projectId: string, scene: SceneDoc): DocRef {
    const ydoc = scene.ydoc;
    let s = this.states.get(ydoc);
    if (!s) {
      const state: DocState = { key: `${projectId}:${ydoc.guid}`, version: null, buffer: null };
      ydoc.on('update', () => {
        state.version = null;
        state.buffer = null;
      });
      this.states.set(ydoc, state);
      s = state;
    }
    let buffer = s.buffer?.deref();
    if (s.version === null || !buffer) {
      const update = Y.encodeStateAsUpdate(ydoc);
      buffer = new SharedArrayBuffer(update.byteLength);
      new Uint8Array(buffer).set(update);
      s.buffer = new WeakRef(buffer);
      // the same content keeps its version when only the buffer was collected
      s.version ??= nextVersion++;
    }
    return { key: s.key, version: s.version, update: buffer };
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
          const r = await pathTraceParallel(lease.threads, doc, o, {
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
    const lease = await this.pool.lease(1, req.signal);
    try {
      const img = await abortable(
        lease.threads[0].call<ImageResult>({ type: 'image', doc, options: o, png: true }),
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

/** Render threads configured by `RENDER_WORKERS` (0 = main thread; default: CPU cores up to 8). */
export function renderThreadsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RENDER_WORKERS?.trim();
  if (!raw) return defaultRenderThreads();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`RENDER_WORKERS must be a whole number >= 0 (got '${raw}')`);
  return Math.min(64, n);
}

let shared: Renderer | null = null;

/**
 * The process-wide renderer (render threads are a machine resource shared by every app instance).
 * Created on first use; its worker threads start lazily and stop when idle.
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
    shared = new Renderer(new RenderPool({ ...opts, threads }));
  }
  return shared;
}
