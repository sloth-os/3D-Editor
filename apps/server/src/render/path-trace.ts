import { PathFilm, type PathTile } from '@3d-editor/core';
import type { RenderThread } from './pool';
import {
  RenderCancelledError,
  type DocRef,
  type FilmBuffers,
  type FrameOptions,
  type ImageResult,
  type PreparedInfo,
} from './protocol';

/*
 * Parallel path tracing over leased render threads. Every thread evaluates the document and
 * compiles the scene itself (`prepare`), then renders bands of rows for ranges of sample indices.
 * The main thread accumulates the tiles into one film, then resolves, denoises and tone maps it.
 *
 * Progressive passes follow `PathTracer.render` (1, 2, 4, 8, then 16 samples per pass, every pass
 * over the whole image, tiles of a pass added before the next pass starts; with a time limit,
 * passes shrink to what still fits and stop between bands at the limit). Samples are pure
 * functions of pixel, sample index and seed, so without a time limit the image is bit-identical to
 * a single-thread render with the same options, whatever the number of threads or the band size.
 */

/** Progress of a path traced render (after every pass). */
export interface PathTraceProgress {
  samples: number;
  total: number;
  elapsedMs: number;
}

export interface ParallelPathTraceOptions {
  signal?: AbortSignal;
  onProgress?: (p: PathTraceProgress) => void;
  /** Return the PNG file (encoded on a render thread) instead of the pixels. */
  png?: boolean;
}

/** A path traced image with statistics. */
export interface ParallelPathTraceResult extends ImageResult {
  pathtrace: NonNullable<ImageResult['pathtrace']> & {
    threads: number;
    prepareMs: number;
    renderMs: number;
    resolveMs: number;
  };
}

/** Samples (pixels × samples per pixel) of one band task: keeps tasks around 10–100 ms. */
const TASK_SAMPLES = 24_576;
/** Bands per thread and pass at least (load balancing at the end of a pass). */
const BANDS_PER_THREAD = 3;
const MAX_BAND_ROWS = 32;
/** Time reserved after sampling, per pixel (the estimate of core renderPathTracedImage). */
const DENOISE_MS_PER_PIXEL = 1.5e-3;
const DISPLAY_MS_PER_PIXEL = 0.2e-3;

let nextJob = 1;
/** A job id unique in this process (jobs keep state on render threads, freed by `release(job)`). */
export function newJobId(): number {
  return nextJob++;
}
const now = () => performance.now();

/** Races `p` against `signal` (rejects with a RenderCancelledError when it aborts first). */
export function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new RenderCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RenderCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function bandRows(width: number, height: number, count: number, threads: number): number {
  const bySamples = Math.ceil(TASK_SAMPLES / Math.max(1, width * count));
  const byBalance = Math.ceil(height / Math.max(1, threads * BANDS_PER_THREAD));
  return Math.max(1, Math.min(MAX_BAND_ROWS, bySamples, byBalance));
}

/**
 * Path traces `doc` with the given threads (all of them prepare the scene; threads join as soon as
 * they are ready). Honours the time limit like `PathTracer.render` (passes are only started when
 * they are expected to finish in time; at least one sample per pixel). Rejects with a
 * RenderCancelledError when `signal` aborts.
 */
export async function pathTraceParallel(
  threads: readonly RenderThread[],
  doc: DocRef,
  options: FrameOptions,
  opts: ParallelPathTraceOptions = {},
): Promise<ParallelPathTraceResult> {
  if (!threads.length) throw new Error('no render threads');
  const { signal } = opts;
  if (signal?.aborted) throw new RenderCancelledError();
  const job = newJobId();
  const t0 = now();
  const prepared = threads.map((t) => t.call<PreparedInfo>({ type: 'prepare', job, doc, options }));
  for (const p of prepared) p.catch(() => undefined);
  try {
    let info: PreparedInfo;
    try {
      info = await abortable(Promise.any(prepared), signal);
    } catch (err) {
      const first = err instanceof AggregateError ? err.errors[0] : err;
      throw first instanceof Error ? first : new Error(String(first));
    }
    const W = info.width;
    const H = info.height;
    const film = new PathFilm(W, H);
    const total = info.samples;

    // threads able to render (prepared); a failed thread drops out, its band is requeued
    const ready = new Set<number>();
    const dead = new Set<number>();
    let lastError: Error | null = null;
    let wake: (() => void) | null = null;
    prepared.forEach((p, i) =>
      p.then(
        () => {
          ready.add(i);
          wake?.();
        },
        (err: unknown) => {
          dead.add(i);
          lastError = err instanceof Error ? err : new Error(String(err));
          wake?.();
        },
      ),
    );

    const tRender = now();
    // like core renderSceneSoftware, a time limit covers compiling, sampling and the estimated
    // denoising and display conversion (not loading and evaluating the scene): sampling gets what
    // is left (the first pass always runs)
    let limit = 0;
    if (info.timeLimit > 0) {
      const reserve = W * H * ((info.denoise ? DENOISE_MS_PER_PIXEL : 0) + DISPLAY_MS_PER_PIXEL);
      const used = Math.max(0, tRender - t0 - info.setupMs);
      limit = Math.max(1, info.timeLimit * 1000 - used - reserve);
    }
    /**
     * Brings every row of the film to `target` samples (bands of rows with equal counts continue
     * from their own count). With `timed`, stops handing out bands once the time limit is reached.
     * Resolves with the row-samples rendered and whether every band was rendered.
     */
    const runPass = (target: number, timed: boolean) =>
      new Promise<{ rendered: number; complete: boolean }>((resolve, reject) => {
        const counts = film.rowSamples;
        const queue: [number, number, number][] = [];
        for (let y = 0; y < H;) {
          const start = counts[y];
          const rows = bandRows(W, H, Math.max(1, target - start), threads.length);
          let end = y + 1;
          while (end < H && end - y < rows && counts[end] === start) end++;
          if (start < target) queue.push([y, end, start]);
          y = end;
        }
        const busy = new Set<number>();
        let rendered = 0;
        let complete = true;
        let finished = false;
        const finish = (err?: Error) => {
          if (finished) return;
          finished = true;
          wake = null;
          signal?.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve({ rendered, complete });
        };
        const onAbort = () => finish(new RenderCancelledError());
        signal?.addEventListener('abort', onAbort, { once: true });
        const pump = () => {
          if (finished) return;
          if (signal?.aborted) return finish(new RenderCancelledError());
          // out of time: the bands rendered keep their samples, the others are skipped
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
              .call<PathTile>({ type: 'rows', job, y0, y1, sampleStart: start, sampleCount: target - start })
              .then(
                (tile) => {
                  busy.delete(i);
                  if (finished) return;
                  film.add(tile);
                  rendered += (y1 - y0) * (target - start);
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
          if (dead.size === threads.length) return finish(lastError ?? new Error('render threads failed'));
        };
        wake = pump;
        pump();
      });

    // progressive passes like PathTracer.render: 1, 2, 4, 8, then 16 samples per pass; with a
    // time limit, passes after the first shrink to what the measured speed says still fits
    let done = 0;
    let pass = 1;
    let stopped: 'done' | 'time' = 'done';
    /** Measured wall time of one sample per pixel over the whole image (0 = unknown). */
    let msPerSample = 0;
    while (done < total) {
      let count = Math.min(pass, total - done);
      const timed = limit > 0 && done > 0;
      if (timed && msPerSample > 0) {
        const fit = Math.floor((limit - (now() - tRender)) / msPerSample);
        if (fit < 1) {
          stopped = 'time';
          break;
        }
        if (fit < count) count = fit;
      }
      const target = done + count;
      const tp = now();
      const { rendered, complete } = await runPass(target, timed);
      if (!complete) {
        stopped = 'time';
        break;
      }
      if (rendered > 0) msPerSample = ((now() - tp) * H) / rendered;
      done = target;
      pass = Math.min(pass * 2, 16);
      opts.onProgress?.({ samples: done, total, elapsedMs: now() - t0 });
      if (limit > 0 && now() - tRender >= limit && done < total) {
        stopped = 'time';
        break;
      }
    }
    done = film.samples;
    const renderMs = now() - tRender;

    // the mean film is denoised and tone mapped on a render thread (seconds for large images,
    // which must not block the event loop); single-thread mode does it between event loop turns
    const tResolve = now();
    const mean = film.resolve();
    const finisher = threads[[...ready].find((i) => !dead.has(i)) ?? 0];
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
    const transfer =
      finisher.kind === 'worker'
        ? [mean.color, mean.emission, mean.variance, mean.albedo, mean.normal, mean.depth].map(
            (a) => a.buffer as ArrayBuffer,
          )
        : [];
    const finished = await abortable(
      finisher.call<ImageResult>(
        {
          type: 'finish',
          film: buffers,
          options: {
            denoise: info.denoise,
            exposure: info.exposure,
            viewTransform: info.viewTransform,
            displayBackground: info.displayBackground,
            png: !!opts.png,
          },
        },
        transfer,
      ),
      signal,
    );
    return {
      ...finished,
      width: W,
      height: H,
      warnings: info.warnings,
      pathtrace: {
        samples: done,
        requested: total,
        stopped,
        threads: ready.size,
        prepareMs: Math.round(info.prepareMs),
        renderMs: Math.round(renderMs),
        resolveMs: Math.round(now() - tResolve),
      },
    };
  } finally {
    for (const t of threads) t.release(job);
  }
}
