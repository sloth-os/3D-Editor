import { PathFilm, type PathTile, type SceneDoc } from '@3d-editor/core';
import { DocumentSnapshot, resetThreadDocument, type RenderPool, type RenderThread } from './pool';
import {
  RenderCancelledError,
  StaleDocumentError,
  filmTransferables,
  type FilmBuffers,
  type PathTraceFrameOptions,
  type PixelImage,
  type PreparedInfo,
} from './protocol';
import { filmRowsToRGBA8 } from './preview';
import { nextPassSize, passSamples, planPass } from './schedule';

/*
 * A progressive, parallel path traced render in the browser. Every worker of the pool evaluates
 * the document snapshot and compiles the scene itself; the first one ready starts rendering and the
 * others join as soon as they are. Bands of rows are handed out pass by pass (see `schedule.ts`),
 * the tiles are added to one film on the main thread and the preview is converted row by row on
 * demand (`takeDirtyRows`). At the end a worker denoises and tone maps the mean film. Without a time
 * limit the image is identical to core `renderSceneSoftware` with the same options, whatever the
 * number of workers.
 */

/** Options of a path traced render. */
export interface PathTraceOptions extends PathTraceFrameOptions {
  /**
   * Wall-clock budget in seconds for preparing, sampling and the estimated denoising (0 / unset =
   * none). The first sample of every pixel is always rendered.
   */
  timeLimit?: number;
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
  warnings: string[];
}

/** Time reserved after sampling when a time limit is set, per pixel (core renderPathTracedImage). */
const DENOISE_MS_PER_PIXEL = 1.5e-3;
const DISPLAY_MS_PER_PIXEL = 0.2e-3;

let nextJob = 1;
const now = () => performance.now();

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

  constructor(
    private readonly pool: RenderPool,
    doc: SceneDoc,
    options: PathTraceOptions,
  ) {
    this.options = options;
    this.width = Math.max(1, Math.round(options.width));
    this.height = Math.max(1, Math.round(options.height));
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    this.status = { phase: 'preparing', samples: 0, total: 0, fraction: 0, elapsedMs: 0, threads: 0 };
    // the document as it is now (later edits do not change this render)
    const snapshot = new DocumentSnapshot(doc);
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

  /** Prepares the render on a thread (re-sending the whole document when it lost track of it). */
  private async prepare(t: RenderThread, snapshot: DocumentSnapshot): Promise<PreparedInfo> {
    const options = frameOptions(this.options);
    const send = () =>
      t.call<PreparedInfo>({ type: 'prepare', job: this.id, doc: snapshot.payload(t), options });
    try {
      return await send();
    } catch (err) {
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
      warnings,
    };
    this.markDirty(0, this.height);
    this.emit({ phase: 'cancelled', threads });
    return r;
  }

  private async render(snapshot: DocumentSnapshot, mayRetry: boolean): Promise<PathTraceResult> {
    const threads = this.pool.acquire();
    const job = this.id;
    const prepared = threads.map((t) => this.prepare(t, snapshot));
    for (const p of prepared) p.catch(() => undefined);
    this.emit({ phase: 'preparing' });
    try {
      let info: PreparedInfo;
      try {
        info = await this.untilCancelled(Promise.any(prepared));
      } catch (err) {
        if (err instanceof RenderCancelledError) return this.cancelledResult(0, [], now() - this.t0);
        // workers that cannot start make the pool fall back to the main thread: try once more there
        if (mayRetry && this.pool.inProcess && threads.some((t) => t.kind === 'worker'))
          return await this.render(snapshot, false);
        const first = err instanceof AggregateError ? err.errors[0] : err;
        throw first instanceof Error ? first : new Error(String(first));
      }
      const prepareMs = now() - this.t0;
      this.info = info;
      const W = info.width;
      const H = info.height;
      const film = new PathFilm(W, H);
      this.film = film;
      const total = info.samples;

      // threads able to render; a failed thread drops out and its band is handed out again
      const ready = new Set<number>();
      const dead = new Set<number>();
      let lastError: Error | null = null;
      prepared.forEach((p, i) =>
        p.then(
          () => {
            ready.add(i);
            this.wake?.();
          },
          (err: unknown) => {
            dead.add(i);
            lastError = err instanceof Error ? err : new Error(String(err));
            this.wake?.();
          },
        ),
      );
      this.emit({ phase: 'rendering', total, threads: 1 });

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
        warnings: info.warnings,
      };
      this.emit({ phase: 'done', threads: ready.size });
      return result;
    } finally {
      for (const t of threads) t.notify({ type: 'release', job });
    }
  }
}

/** Starts a path traced render of `doc` (as it is now) on the pool's workers. */
export function startPathTrace(pool: RenderPool, doc: SceneDoc, options: PathTraceOptions): PathTraceJob {
  return new PathTraceJob(pool, doc, options);
}
