import { PathFilm, type PathTile, type SceneDoc } from '@3d-editor/core';
import {
  estimateRender,
  estimatedNeeds,
  pageHeapEstimate,
  planRenderThreads,
  renderMemory,
  tabMemory,
  type RenderEstimate,
  type TabMemory,
} from './memory';
import { DocumentSnapshot, resetThreadDocument, type RenderPool, type RenderThread } from './pool';
import {
  RenderCancelledError,
  RenderMemoryError,
  StaleDocumentError,
  filmTransferables,
  sceneBuffers,
  type FilmBuffers,
  type PathTraceFrameOptions,
  type PixelImage,
  type PreparedInfo,
  type SharedTrace,
} from './protocol';
import { filmRowsToRGBA8 } from './preview';
import { nextPassSize, passSamples, planPass } from './schedule';

/*
 * A progressive, parallel path traced render in the browser. The first worker of the pool
 * evaluates the document snapshot, compiles the scene and starts rendering; the other workers get a
 * copy of the compiled scene, one after the other, and join as soon as they have it (only one
 * worker holds the document and the evaluated scene). How many workers render depends on the
 * tab's memory (`memory.ts`); only the workers it leaves room for start. A render that cannot fit
 * even one worker is refused with an explanation instead of ending the tab: before any worker starts
 * when the estimate from the document shows it, else by the first worker, before a modifier that
 * would not fit runs (`guard.ts`) or once it evaluated the scene, before it compiles it.
 * Bands of rows are handed out pass by pass (see
 * `schedule.ts`), the tiles are added to one film on the main thread and the preview is converted
 * row by row on demand (`takeDirtyRows`). At the end a worker denoises and tone maps the mean film.
 * Without a time limit the image is identical to core `renderSceneSoftware` with the same options,
 * whatever the number of workers.
 */

/** Options of a path traced render. */
export interface PathTraceOptions extends PathTraceFrameOptions {
  /**
   * Wall-clock budget in seconds for preparing, sampling and the estimated denoising (0 / unset =
   * none). The first sample of every pixel is always rendered.
   */
  timeLimit?: number;
  /** The tab's memory (default: {@link tabMemory} when the render starts). */
  memory?: TabMemory;
}

export type PathTracePhase = 'preparing' | 'rendering' | 'finishing' | 'done' | 'cancelled' | 'failed';

/** Progress of a path traced render. */
export interface PathTraceStatus {
  phase: PathTracePhase;
  /** Samples per pixel every pixel has. */
  samples: number;
  /** Samples per pixel requested (0 until the scene is prepared). */
  total: number;
  /** Share of all samples rendered, 0..1. */
  fraction: number;
  /** Milliseconds since the render started. */
  elapsedMs: number;
  /** Workers rendering. */
  threads: number;
  /** True when the tab's memory allows fewer workers than the pool has (see memory.ts). */
  limitedByMemory: boolean;
  /** Failure message (phase 'failed'). */
  error?: string;
}

/** A finished (or cancelled) path traced render. */
export interface PathTraceResult extends PixelImage {
  /** Samples per pixel every pixel has. */
  samples: number;
  /** Samples per pixel requested. */
  total: number;
  /** Why sampling stopped. */
  stopped: 'done' | 'time' | 'cancelled';
  denoised: boolean;
  elapsedMs: number;
  /** Milliseconds until the first worker was ready. */
  prepareMs: number;
  threads: number;
  /** True when the tab's memory allowed fewer workers than the pool has. */
  limitedByMemory: boolean;
  warnings: string[];
}

/** Time reserved after sampling when a time limit is set, per pixel (core renderPathTracedImage). */
const DENOISE_MS_PER_PIXEL = 1.5e-3;
const DISPLAY_MS_PER_PIXEL = 0.2e-3;

let nextJob = 1;
const now = () => performance.now();

/**
 * After a render, the workers that adopted a copy of its compiled scene are stopped when the copies
 * take this part of the render budget or more (1/8): see the end of `PathTraceJob.render`.
 */
export const ADOPTER_COPIES_STOP = 8;

/** What the path traced renders running now hold, by job (their {@link renderMemory}). */
const running = new Map<number, { total: number; heap: number }>();

/** `memory` with what the renders running now, other than `job`, hold. */
function withRunning(memory: TabMemory, job: number): TabMemory {
  const held = { ...memory.held };
  for (const [id, m] of running)
    if (id !== job) {
      held.total += m.total;
      held.heap += m.heap;
    }
  return { ...memory, held };
}

/** The frame options sent to the workers (drops main-thread-only settings and unset values). */
function frameOptions(o: PathTraceOptions): PathTraceFrameOptions {
  const out: PathTraceFrameOptions = {
    width: Math.max(1, Math.round(o.width)),
    height: Math.max(1, Math.round(o.height)),
    frame: o.frame,
  };
  if (o.cameraId !== undefined) out.cameraId = o.cameraId;
  if (o.viewSpec) out.viewSpec = o.viewSpec;
  if (o.view) out.view = o.view;
  if (o.samples !== undefined) out.samples = o.samples;
  if (o.max_bounces !== undefined) out.max_bounces = o.max_bounces;
  if (o.denoise !== undefined) out.denoise = o.denoise;
  if (o.seed !== undefined) out.seed = o.seed;
  if (o.background) out.background = o.background;
  return out;
}

/** A running path traced render; see {@link startPathTrace}. */
export class PathTraceJob {
  readonly id = nextJob++;
  readonly width: number;
  readonly height: number;
  /** Display pixels (RGBA8, top row first): the progressive preview, then the final image. */
  readonly pixels: Uint8ClampedArray;
  status: PathTraceStatus;
  /** Resolves when the render is finished or cancelled; rejects when it fails. */
  readonly result: Promise<PathTraceResult>;
  private readonly listeners = new Set<() => void>();
  private readonly options: PathTraceOptions;
  private readonly t0 = now();
  private cancelled = false;
  private wake: (() => void) | null = null;
  private onCancel: (() => void) | null = null;
  private film: PathFilm | null = null;
  private info: PreparedInfo | null = null;
  private dirty: [number, number] | null = null;
  /** True once `pixels` hold the final image (no more preview conversion). */
  private final = false;
  /** What the document needed when the render started, estimated (see `estimateRender`). */
  private readonly estimate: RenderEstimate;
  /** The page's own heap, estimated from its scene (see `pageHeapEstimate`). */
  private readonly pageHeap: number;

  constructor(
    private readonly pool: RenderPool,
    doc: SceneDoc,
    options: PathTraceOptions,
  ) {
    this.options = options;
    this.width = Math.max(1, Math.round(options.width));
    this.height = Math.max(1, Math.round(options.height));
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    this.status = {
      phase: 'preparing',
      samples: 0,
      total: 0,
      fraction: 0,
      elapsedMs: 0,
      threads: 0,
      limitedByMemory: false,
    };
    // the document as it is now (later edits do not change this render)
    const snapshot = new DocumentSnapshot(doc);
    this.estimate = estimateRender(doc);
    this.pageHeap = options.memory ? 0 : pageHeapEstimate(doc);
    this.result = this.run(snapshot);
    this.result.catch(() => undefined);
  }

  /** Calls `fn` after every change of the status or the pixels; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Non-fatal problems reported while preparing the scene (e.g. undecodable images). */
  get warnings(): readonly string[] {
    return this.info?.warnings ?? [];
  }

  /** True while the render has not finished, failed or been cancelled. */
  get running(): boolean {
    const p = this.status.phase;
    return p === 'preparing' || p === 'rendering' || p === 'finishing';
  }

  /**
   * Milliseconds since the render started: live while it runs (`status.elapsedMs` only changes
   * with the status, e.g. not while the scene is being prepared), the final time afterwards.
   */
  get elapsedMs(): number {
    return this.running ? now() - this.t0 : this.status.elapsedMs;
  }

  /**
   * Stops sampling: the result keeps the samples rendered so far (not denoised), like cancelling
   * a render in Blender.
   */
  cancel(): void {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.wake?.();
    this.onCancel?.();
  }

  /**
   * Converts the rows changed since the last call into `pixels` and returns them as [y0, y1), or
   * null when nothing changed. Call it when drawing (e.g. once per animation frame).
   */
  takeDirtyRows(): [number, number] | null {
    const d = this.dirty;
    if (!d) return null;
    this.dirty = null;
    if (!this.final && this.film && this.info) filmRowsToRGBA8(this.film, d[0], d[1], this.info, this.pixels);
    return d;
  }

  private markDirty(y0: number, y1: number): void {
    this.dirty = this.dirty ? [Math.min(this.dirty[0], y0), Math.max(this.dirty[1], y1)] : [y0, y1];
  }

  private emit(patch: Partial<PathTraceStatus> = {}): void {
    const film = this.film;
    let samples = this.status.samples;
    let fraction = this.status.fraction;
    if (film && this.info) {
      samples = film.samples;
      let sum = 0;
      for (let y = 0; y < film.height; y++) sum += Math.min(film.rowSamples[y], this.info.samples);
      fraction = Math.min(1, sum / Math.max(1, film.height * this.info.samples));
    }
    this.status = { ...this.status, samples, fraction, elapsedMs: now() - this.t0, ...patch };
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }

  /** Rejects with a RenderCancelledError as soon as the render is cancelled. */
  private untilCancelled<T>(p: Promise<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(new RenderCancelledError());
    return new Promise<T>((resolve, reject) => {
      this.onCancel = () => reject(new RenderCancelledError());
      p.then(resolve, reject).finally(() => (this.onCancel = null));
    });
  }

  private async run(snapshot: DocumentSnapshot): Promise<PathTraceResult> {
    try {
      return await this.render(snapshot, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ phase: 'failed', error: message });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Prepares the render on a thread (re-sending the whole document when it lost track of it); the
   * thread refuses it when one render thread does not fit `memory` (RenderMemoryError).
   */
  private async prepare(
    t: RenderThread,
    snapshot: DocumentSnapshot,
    memory: TabMemory,
  ): Promise<PreparedInfo> {
    const options = frameOptions(this.options);
    const estimate = this.estimate;
    const send = () =>
      t.call<PreparedInfo>({
        type: 'prepare',
        job: this.id,
        doc: snapshot.payload(t),
        options,
        memory,
        estimate,
      });
    try {
      return await send();
    } catch (err) {
      // the worker has the document: it only found the scene too large
      if (err instanceof RenderMemoryError) throw err;
      // what the worker has is unknown now: the next document it gets is the whole state
      resetThreadDocument(t);
      if (err instanceof StaleDocumentError) return await send();
      throw err;
    }
  }

  private cancelledResult(threads: number, warnings: string[], prepareMs: number): PathTraceResult {
    if (this.film && this.info) {
      this.dirty = [0, this.height];
      this.takeDirtyRows();
    }
    this.final = true;
    const r: PathTraceResult = {
      width: this.width,
      height: this.height,
      data: this.pixels.slice(),
      samples: this.film?.samples ?? 0,
      total: this.info?.samples ?? 0,
      stopped: 'cancelled',
      denoised: false,
      elapsedMs: now() - this.t0,
      prepareMs,
      threads,
      limitedByMemory: this.status.limitedByMemory,
      warnings,
    };
    this.markDirty(0, this.height);
    this.emit({ phase: 'cancelled', threads });
    return r;
  }

  /**
   * Copies the compiled scene of the first worker to the others, one after the other (each copy is
   * the size of the compiled scene), and marks each ready when it has it; the last one gets the
   * main thread's copy itself. Stops when the render is over (`over`).
   */
  private async adopt(
    threads: RenderThread[],
    ready: Set<number>,
    fail: (i: number, err: unknown) => void,
    over: () => boolean,
  ): Promise<void> {
    if (threads.length < 2 || over()) return;
    const job = this.id;
    let trace: SharedTrace;
    try {
      trace = await threads[0].call<SharedTrace>({ type: 'share', job });
    } catch (err) {
      for (let i = 1; i < threads.length; i++) fail(i, err);
      return;
    }
    for (let i = 1; i < threads.length && !over(); i++) {
      const t = threads[i];
      const last = i === threads.length - 1;
      try {
        await t.call(
          { type: 'adopt', job, trace },
          last && t.kind === 'worker' ? sceneBuffers(trace.scene) : [],
        );
        if (over()) return;
        ready.add(i);
        this.wake?.();
      } catch (err) {
        fail(i, err);
      }
    }
  }

  private async render(snapshot: DocumentSnapshot, mayRetry: boolean): Promise<PathTraceResult> {
    const job = this.id;
    const tab = this.options.memory ?? tabMemory(this.pageHeap);
    // a render that cannot fit one worker (estimated from the document, its evaluation included)
    // next to the path traced renders running now is not started
    const estimated = estimatedNeeds(this.estimate, this.width * this.height);
    const estimate = planRenderThreads(estimated, 1, withRunning(tab, job));
    if (estimate.refusal) throw new Error(estimate.refusal);
    /** Set when the render is over: no more copies of the compiled scene are sent. */
    let over = false;
    const all: RenderThread[] = [];
    try {
      // what this render holds while its first worker prepares, for renders that start meanwhile
      running.set(job, renderMemory(estimated, 1));
      // the workers the estimate leaves room for start now (they load meanwhile); the first evaluates
      // and compiles the scene, and refuses it when it does not fit one render thread
      const expected = planRenderThreads(estimated, this.pool.threadCount, withRunning(tab, job)).threads;
      for (let i = 0; i < Math.min(Math.max(1, expected), this.pool.threadCount); i++)
        all.push(this.pool.thread(i));
      const prepared = this.prepare(all[0], snapshot, withRunning(tab, job));
      prepared.catch(() => undefined);
      this.emit({ phase: 'preparing' });
      let info: PreparedInfo;
      try {
        info = await this.untilCancelled(prepared);
      } catch (err) {
        if (err instanceof RenderCancelledError) return this.cancelledResult(0, [], now() - this.t0);
        // workers that cannot start make the pool fall back to the main thread: try once more there
        if (mayRetry && this.pool.inProcess && all[0].kind === 'worker')
          return await this.render(snapshot, false);
        throw err instanceof Error ? err : new Error(String(err));
      }
      const prepareMs = now() - this.t0;
      this.info = info;
      // the workers that fit the tab's memory, with the scene as compiled
      const needs = {
        triangles: info.triangles,
        evaluatedTriangles: info.evaluatedTriangles,
        instances: info.instances,
        sceneBytes: info.sceneBytes,
        pixels: info.width * info.height,
      };
      const plan = planRenderThreads(needs, this.pool.threadCount, withRunning(tab, job));
      if (plan.refusal) throw new Error(plan.refusal);
      running.set(job, renderMemory(needs, plan.threads));
      // the compiled scene may leave room for more workers than the estimate did: they start now
      while (all.length < Math.min(plan.threads, this.pool.threadCount))
        all.push(this.pool.thread(all.length));
      const threads = all.slice(0, plan.threads);
      const W = info.width;
      const H = info.height;
      const film = new PathFilm(W, H);
      this.film = film;
      const total = info.samples;

      // threads able to render; a failed thread drops out and its band is handed out again
      const ready = new Set<number>([0]);
      const dead = new Set<number>();
      let lastError: Error | null = null;
      const fail = (i: number, err: unknown) => {
        dead.add(i);
        lastError = err instanceof Error ? err : new Error(String(err));
        this.wake?.();
      };
      void this.adopt(threads, ready, fail, () => over || this.cancelled);
      this.emit({ phase: 'rendering', total, threads: 1, limitedByMemory: plan.limited });

      const tRender = now();
      // a time limit covers preparing, sampling and the estimated denoising and display conversion
      let limit = 0;
      const timeLimit = this.options.timeLimit ?? 0;
      if (timeLimit > 0) {
        const reserve = W * H * ((info.denoise ? DENOISE_MS_PER_PIXEL : 0) + DISPLAY_MS_PER_PIXEL);
        limit = Math.max(1, timeLimit * 1000 - (tRender - this.t0) - reserve);
      }

      /** Brings every row to `target` samples; with `timed`, stops handing out bands at the limit. */
      const runPass = (target: number, timed: boolean) =>
        new Promise<{ rendered: number; complete: boolean }>((resolve, reject) => {
          const queue = planPass(film.rowSamples, W, target, threads.length);
          const busy = new Set<number>();
          let rendered = 0;
          let complete = true;
          let finished = false;
          const finish = (err?: Error) => {
            if (finished) return;
            finished = true;
            this.wake = null;
            if (err) reject(err);
            else resolve({ rendered, complete });
          };
          const pump = () => {
            if (finished) return;
            if (this.cancelled) {
              // bands in flight are dropped: the film keeps whole bands only
              complete = false;
              return finish();
            }
            if (timed && queue.length && now() - tRender >= limit) {
              queue.length = 0;
              complete = false;
            }
            for (const i of ready) {
              if (!queue.length) break;
              if (busy.has(i) || dead.has(i)) continue;
              const band = queue.shift()!;
              const [y0, y1, start] = band;
              busy.add(i);
              threads[i]
                .call<PathTile>({
                  type: 'rows',
                  job,
                  y0,
                  y1,
                  sampleStart: start,
                  sampleCount: target - start,
                })
                .then(
                  (tile) => {
                    busy.delete(i);
                    if (finished) return;
                    try {
                      film.add(tile);
                    } catch (err) {
                      return finish(err instanceof Error ? err : new Error(String(err)));
                    }
                    rendered += (y1 - y0) * (target - start);
                    this.markDirty(y0, y1);
                    this.emit({ threads: ready.size });
                    pump();
                  },
                  (err: unknown) => {
                    busy.delete(i);
                    ready.delete(i);
                    dead.add(i);
                    lastError = err instanceof Error ? err : new Error(String(err));
                    queue.unshift(band);
                    pump();
                  },
                );
            }
            if (!queue.length && busy.size === 0) return finish();
            if (dead.size === threads.length) finish(lastError ?? new Error('Render workers failed'));
          };
          this.wake = pump;
          pump();
        });

      // progressive passes like PathTracer.render; with a time limit, passes after the first shrink
      // to what the measured speed says still fits
      let done = 0;
      let pass = 1;
      let stopped: PathTraceResult['stopped'] = 'done';
      let msPerSample = 0;
      while (done < total) {
        const timed = limit > 0 && done > 0;
        const count = passSamples(pass, done, total, timed ? limit - (now() - tRender) : null, msPerSample);
        if (count < 1) {
          stopped = 'time';
          break;
        }
        const target = done + count;
        const tp = now();
        const { rendered, complete } = await runPass(target, timed);
        if (this.cancelled) return this.cancelledResult(ready.size, info.warnings, prepareMs);
        if (!complete) {
          stopped = 'time';
          break;
        }
        if (rendered > 0) msPerSample = ((now() - tp) * H) / rendered;
        done = target;
        pass = nextPassSize(pass);
        if (limit > 0 && now() - tRender >= limit && done < total) {
          stopped = 'time';
          break;
        }
      }

      // the mean film is denoised and tone mapped on a worker (seconds for large images)
      over = true;
      this.emit({ phase: 'finishing' });
      const mean = film.resolve();
      const buffers: FilmBuffers = {
        width: mean.width,
        height: mean.height,
        color: mean.color,
        emission: mean.emission,
        variance: mean.variance,
        albedo: mean.albedo,
        normal: mean.normal,
        depth: mean.depth,
      };
      const finisher = threads[[...ready].find((i) => !dead.has(i)) ?? 0];
      let img: PixelImage;
      try {
        img = await this.untilCancelled(
          finisher.call<PixelImage>(
            {
              type: 'finish',
              film: buffers,
              options: {
                denoise: info.denoise,
                exposure: info.exposure,
                viewTransform: info.viewTransform,
                displayBackground: info.displayBackground,
              },
            },
            finisher.kind === 'worker' ? filmTransferables(buffers) : [],
          ),
        );
      } catch (err) {
        if (err instanceof RenderCancelledError)
          return this.cancelledResult(ready.size, info.warnings, prepareMs);
        throw err;
      }
      this.final = true;
      this.pixels.set(img.data.subarray(0, this.pixels.length));
      this.markDirty(0, H);
      const result: PathTraceResult = {
        width: W,
        height: H,
        data: this.pixels.slice(),
        samples: film.samples,
        total,
        stopped,
        denoised: info.denoise,
        elapsedMs: now() - this.t0,
        prepareMs,
        threads: ready.size,
        limitedByMemory: plan.limited,
        warnings: info.warnings,
      };
      this.emit({ phase: 'done', threads: ready.size });
      return result;
    } finally {
      over = true;
      running.delete(job);
      for (const t of all) t.notify({ type: 'release', job });
      // the other workers hold nothing but their copy of the compiled scene, which stays in their
      // memory after the release until they collect garbage, unseen by the next render's plan:
      // copies that take an eighth of the budget or more go at once with their workers (they start
      // again for the next render), unless another render uses the workers
      const info = this.info;
      if (!running.size && info && (all.length - 1) * info.sceneBytes >= tab.budget / ADOPTER_COPIES_STOP)
        for (const t of all.slice(1)) t.stop();
    }
  }
}

/** Starts a path traced render of `doc` (as it is now) on the pool's workers. */
export function startPathTrace(pool: RenderPool, doc: SceneDoc, options: PathTraceOptions): PathTraceJob {
  return new PathTraceJob(pool, doc, options);
}
