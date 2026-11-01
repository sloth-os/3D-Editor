import {
  APNGEncoder,
  contactSheetGrid,
  sequenceFrameName,
  type AnimationFormat,
  type GIFDither,
} from '@3d-editor/core';
import { pathTraces } from './engine';
import { abortable, pathTraceParallel } from './path-trace';
import type { RenderThread } from './pool';
import {
  RenderCancelledError,
  type AutoViewResult,
  type DocRef,
  type EncodedResult,
  type FrameOptions,
  type ImageResult,
} from './protocol';

/*
 * Animation rendering on render threads with the semantics of core `renderAnimation` (same frames,
 * automatic view, per-frame time limits from the total budget, encoders): frames are rendered in
 * parallel, one per thread, or — when path tracing fewer frames than there are threads — one
 * after the other with every thread path tracing bands of the frame. Frames are bit-identical to
 * core `renderAnimation` either way.
 */

/** An animation render (validated by the caller). */
export interface AnimationJob {
  format: AnimationFormat;
  /** Frame numbers to render, in order. */
  frames: number[];
  width: number;
  height: number;
  fps: number;
  /** Options shared by every frame (frame, view and time_limit are set per frame). */
  base: Omit<FrameOptions, 'frame' | 'time_limit' | 'width' | 'height'>;
  /** PATHTRACER: sampling time budget per frame in seconds (0 / unset = none). */
  frameTimeLimit?: number;
  /** Wall-clock budget of the whole render in seconds (0 / unset = none); see core renderAnimation. */
  timeLimit?: number;
  /** Vary the path tracer noise from frame to frame (seed + frame). */
  animatedSeed?: boolean;
  loop?: number;
  dither?: GIFDither;
  colors?: number;
  columns?: number;
}

export interface AnimationProgress {
  /** Frames finished so far and in total. */
  done: number;
  total: number;
  frame: number;
  elapsedMs: number;
}

/** Result of an animation render (like core `AnimationRenderResult`, plus statistics). */
export interface AnimationOutput {
  format: AnimationFormat;
  /** image/apng, image/gif or image/png. */
  mime: string;
  width: number;
  height: number;
  fps: number;
  frames: number[];
  data?: Uint8Array;
  files?: { frame: number; name: string; data: Uint8Array }[];
  sheet?: { width: number; height: number; columns: number; rows: number };
  view?: { position: [number, number, number]; target: [number, number, number]; fovY: number };
  cancelled: boolean;
  time_limit_reached: boolean;
  undersampled_frames: number[];
  threads: number;
  /** FRAMES: one frame per thread; BANDS: frames in turn, each path traced by all threads. */
  parallelism: 'FRAMES' | 'BANDS';
  elapsedMs: number;
}

const now = () => performance.now();

export async function renderAnimationParallel(
  threads: readonly RenderThread[],
  doc: DocRef,
  job: AnimationJob,
  opts: { signal?: AbortSignal; onProgress?: (p: AnimationProgress) => void } = {},
): Promise<AnimationOutput> {
  const { signal } = opts;
  if (!threads.length) throw new Error('no render threads');
  if (!job.frames.length) throw new Error('no frames to render');
  const t0 = now();
  const total = job.frames.length;
  const budgetMs = job.timeLimit && job.timeLimit > 0 ? job.timeLimit * 1000 : 0;
  const left = () => budgetMs - (now() - t0);
  const expired = () => budgetMs > 0 && left() <= 0;

  // one automatic view for every frame when there is no camera (as core renderAnimation)
  let view: AutoViewResult = null;
  if (!job.base.cameraId && !job.base.view)
    view = await abortable(
      threads[0].call<AutoViewResult>({
        type: 'auto-view',
        doc,
        frames: job.frames,
        aspect: job.width / job.height,
        budgetMs,
      }),
      signal,
    );

  const seed = job.base.seed ?? 0;
  const bands = pathTraces(job.base) && total < threads.length && threads.length > 1;
  /** Frames rendered at the same time. */
  const parallel = bands ? 1 : threads.length;
  const frameOptions = (i: number): { options: FrameOptions; budgetBound: boolean } => {
    const frame = job.frames[i];
    let timeLimit = job.frameTimeLimit;
    let budgetBound = false;
    if (budgetMs > 0) {
      // like core renderAnimation, a path traced frame gets an equal share of the rest of the
      // budget (at least one sample is rendered): here per thread, as frames render in parallel
      const rest = Math.max(1e-3, left() / 1000 / Math.ceil((total - i) / parallel));
      if (!(typeof timeLimit === 'number' && timeLimit > 0 && timeLimit <= rest)) {
        timeLimit = rest;
        budgetBound = true;
      }
    }
    return {
      budgetBound,
      options: {
        ...job.base,
        width: job.width,
        height: job.height,
        frame,
        view: view ?? job.base.view,
        time_limit: timeLimit,
        seed: job.animatedSeed ? seed + Math.round(frame) : seed,
      },
    };
  };

  const apng =
    job.format === 'APNG' ? new APNGEncoder(job.width, job.height, job.fps, { loop: job.loop }) : null;
  const kept: { width: number; height: number; data: Uint8ClampedArray }[] = [];
  const files: { frame: number; name: string; data: Uint8Array }[] = [];
  const undersampled: number[] = [];
  let budgetHit = false;
  let encoded = 0;
  const results = new Map<number, { img: ImageResult; budgetBound: boolean }>();
  const sequence = job.format === 'PNG_SEQUENCE';
  /** Collects finished frames in order (APNG frames are encoded at once, sequence frames are PNGs). */
  const flush = () => {
    for (let r = results.get(encoded); r; r = results.get(encoded)) {
      results.delete(encoded);
      const frame = job.frames[encoded];
      const pt = r.img.pathtrace;
      if (pt && pt.samples < pt.requested) {
        undersampled.push(frame);
        if (r.budgetBound) budgetHit = true;
      }
      if (sequence) {
        // PNG sequences come encoded from the render threads
        if (!r.img.png) throw new Error(`frame ${frame} came back without its PNG`);
        files.push({ frame, name: sequenceFrameName(frame), data: r.img.png });
      } else {
        const pixels = r.img.data;
        if (!pixels) throw new Error(`frame ${frame} came back without pixels`);
        const img = { width: r.img.width, height: r.img.height, data: pixels };
        if (apng) apng.addFrame(img);
        else kept.push(img);
      }
      encoded++;
      opts.onProgress?.({ done: encoded, total, frame, elapsedMs: now() - t0 });
    }
  };

  if (bands) {
    for (let i = 0; i < total; i++) {
      if (i > 0 && expired()) break;
      const { options, budgetBound } = frameOptions(i);
      const img = await pathTraceParallel(threads, doc, options, { signal, png: sequence });
      results.set(i, { img, budgetBound });
      flush();
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      const idle = [...threads];
      /** Frames to render again because their thread stopped (crashed) while rendering them. */
      const retry: number[] = [];
      let next = 0;
      let inFlight = 0;
      let failed = false;
      const fail = (err: unknown) => {
        if (failed) return;
        failed = true;
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onAbort = () => fail(new RenderCancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });
      const pump = () => {
        if (failed) return;
        // no frame starts once the budget is used up (at least one frame is rendered)
        while (idle.length && (retry.length || (next < total && !(next > 0 && expired())))) {
          const i = retry.length ? retry.shift()! : next++;
          const t = idle.shift()!;
          const { options, budgetBound } = frameOptions(i);
          inFlight++;
          t.call<ImageResult>({ type: 'image', doc, options, png: sequence }).then(
            (img) => {
              if (failed) return;
              inFlight--;
              idle.push(t);
              results.set(i, { img, budgetBound });
              try {
                flush();
              } catch (err) {
                fail(err);
                return;
              }
              pump();
            },
            (err: unknown) => {
              if (failed) return;
              inFlight--;
              // a thread that died is dropped and its frame goes to another one; an error the
              // render itself raised (bad data) would happen anywhere: give up
              if (t.alive || !threads.some((x) => x.alive)) return fail(err);
              retry.push(i);
              pump();
            },
          );
        }
        if (inFlight === 0) {
          signal?.removeEventListener('abort', onAbort);
          if (retry.length) fail(new Error('every render thread stopped'));
          else resolve();
        }
      };
      pump();
    });
  }
  if (signal?.aborted) throw new RenderCancelledError();

  const frames = job.frames.slice(0, encoded);
  const cancelled = encoded < total;
  const out: AnimationOutput = {
    format: job.format,
    mime: job.format === 'APNG' ? 'image/apng' : job.format === 'GIF' ? 'image/gif' : 'image/png',
    width: job.width,
    height: job.height,
    fps: job.fps,
    frames,
    cancelled,
    time_limit_reached: budgetHit || (cancelled && budgetMs > 0),
    undersampled_frames: undersampled,
    threads: threads.length,
    parallelism: bands ? 'BANDS' : 'FRAMES',
    elapsedMs: 0,
  };
  if (view) out.view = { position: view.position, target: view.target, fovY: view.fovY };
  if (apng) out.data = apng.finish();
  else if (job.format === 'GIF' || job.format === 'CONTACT_SHEET') {
    // GIF palettes and contact sheets of many frames take seconds: encode on a render thread
    const encoder = threads.find((t) => t.alive) ?? threads[0];
    const result = await abortable(
      encoder.call<EncodedResult>(
        {
          type: 'encode',
          frames: kept,
          options: {
            format: job.format,
            fps: job.fps,
            loop: job.loop,
            dither: job.dither,
            colors: job.colors,
            columns: job.columns,
            labels: frames.map((f) => String(Math.round(f * 100) / 100)),
          },
        },
        encoder.kind === 'worker' ? kept.map((f) => f.data.buffer as ArrayBuffer) : [],
      ),
      signal,
    );
    out.data = result.data;
    if (result.sheet)
      out.sheet = {
        ...result.sheet,
        ...contactSheetGrid(kept.length, job.width, job.height, job.columns),
      };
  } else out.files = files;
  out.elapsedMs = Math.round(now() - t0);
  return out;
}
