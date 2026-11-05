import type { GIFDither } from '@3d-editor/core';
import type { RenderPool } from './pool';
import type { PathTraceJob } from './path-trace';
import type { EncodeFormat, EncodedFile, PixelImage } from './protocol';

/*
 * Animation rendering in the browser: frames are rendered one after the other by a frame renderer
 * (the WebGL rasterizer or a path traced render on the worker pool) and streamed to an encoder on a
 * render worker (core APNG / GIF encoders), so the main thread keeps no frames. Cancelling keeps the
 * frames finished so far, like Blender.
 */

/** One frame being rendered. */
export interface FrameRender {
  /** The frame's pixels (rejects when the frame fails). */
  done: Promise<PixelImage>;
  /** Stops rendering the frame (the animation is being cancelled). */
  cancel(): void;
  /** The frame's path traced render, for a progressive preview. */
  job?: PathTraceJob;
}

export interface AnimationRenderOptions {
  format: EncodeFormat;
  /** Frame numbers to render, in order. */
  frames: number[];
  width: number;
  height: number;
  /** Playback rate in frames per second. */
  fps: number;
  /** Number of plays, 0 = forever (default). */
  loop?: number;
  /** GIF dithering (default FLOYD_STEINBERG). */
  dither?: GIFDither;
  /** Starts rendering one frame. */
  renderFrame: (frame: number) => FrameRender;
}

export type AnimationPhase = 'rendering' | 'encoding' | 'done' | 'cancelled' | 'failed';

export interface AnimationStatus {
  phase: AnimationPhase;
  /** Frames finished. */
  index: number;
  total: number;
  /** Frame number being rendered. */
  frame: number;
  elapsedMs: number;
  error?: string;
}

/** An encoded animation. */
export interface AnimationResult {
  data: Uint8Array;
  mime: string;
  /** File name extension (APNG files are PNG files). */
  extension: 'png' | 'gif';
  width: number;
  height: number;
  fps: number;
  /** The frames in the file. */
  frames: number[];
  /** True when the render was cancelled before its last frame. */
  cancelled: boolean;
  elapsedMs: number;
}

/** Most pixels (all frames together) of a GIF, which the encoder keeps until the end (core limit). */
export const MAX_GIF_PIXELS = 1 << 26;
/** Most frames of one animation render. */
export const MAX_ANIMATION_FRAMES = 10_000;

/** Frame numbers `start`, `start + step`, … up to `end` (inclusive). */
export function animationFrames(start: number, end: number, step = 1): number[] {
  const s = Math.max(1, Math.floor(step));
  const a = Math.round(start);
  const b = Math.round(end);
  const out: number[] = [];
  for (let f = a; f <= b && out.length < MAX_ANIMATION_FRAMES; f += s) out.push(f);
  return out;
}

/** Why an animation cannot be rendered with these settings, or null. */
export function animationProblem(
  format: EncodeFormat,
  width: number,
  height: number,
  frames: number,
): string | null {
  if (frames < 1) return 'The frame range is empty (End must not be before Start)';
  if (frames > MAX_ANIMATION_FRAMES) return `At most ${MAX_ANIMATION_FRAMES} frames can be rendered at once`;
  if (format === 'GIF' && width * height * frames > MAX_GIF_PIXELS)
    return (
      `A GIF keeps every frame until it is encoded: ${frames} frames of ${width}×${height} are too many ` +
      '(lower the resolution or the frame count, or use APNG)'
    );
  return null;
}

let nextSession = 1;
const now = () => performance.now();

/** A running animation render; see {@link startAnimationRender}. */
export class AnimationJob {
  status: AnimationStatus;
  /** The frame being rendered (its path traced job shows a progressive preview). */
  current: FrameRender | null = null;
  /** The last finished frame. */
  lastFrame: PixelImage | null = null;
  /** The encoded animation; null when cancelled before the first frame was finished. */
  readonly result: Promise<AnimationResult | null>;
  private readonly listeners = new Set<() => void>();
  private readonly t0 = now();
  private cancelled = false;

  constructor(
    private readonly pool: RenderPool,
    private readonly options: AnimationRenderOptions,
  ) {
    this.status = {
      phase: 'rendering',
      index: 0,
      total: options.frames.length,
      frame: options.frames[0] ?? 0,
      elapsedMs: 0,
    };
    this.result = this.run().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ phase: 'failed', error: message });
      throw err instanceof Error ? err : new Error(message);
    });
    this.result.catch(() => undefined);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get running(): boolean {
    return this.status.phase === 'rendering' || this.status.phase === 'encoding';
  }

  /** Milliseconds since the render started: live while it runs, the final time afterwards. */
  get elapsedMs(): number {
    return this.running ? now() - this.t0 : this.status.elapsedMs;
  }

  /** Stops after the frames finished so far (the frame being rendered is dropped). */
  cancel(): void {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.current?.cancel();
  }

  private emit(patch: Partial<AnimationStatus> = {}): void {
    this.status = { ...this.status, elapsedMs: now() - this.t0, ...patch };
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }

  private async run(): Promise<AnimationResult | null> {
    const o = this.options;
    const problem = animationProblem(o.format, o.width, o.height, o.frames.length);
    if (problem) throw new Error(problem);
    const encoder = this.pool.thread(0);
    const session = nextSession++;
    await encoder.call({
      type: 'encode-begin',
      session,
      options: {
        format: o.format,
        width: o.width,
        height: o.height,
        fps: o.fps,
        loop: o.loop,
        dither: o.dither,
      },
    });
    let closed = false;
    /** The first encoder failure (frames are encoded while the next ones render). */
    const failure: { error: Error | null } = { error: null };
    const encoding: Promise<unknown>[] = [];
    try {
      const rendered: number[] = [];
      for (let i = 0; i < o.frames.length && !this.cancelled; i++) {
        const frame = o.frames[i];
        this.emit({ index: i, frame });
        const fr = o.renderFrame(frame);
        this.current = fr;
        this.emit();
        let img: PixelImage;
        try {
          img = await fr.done;
        } catch (err) {
          if (this.cancelled) break;
          throw err;
        } finally {
          this.current = null;
        }
        // a frame stopped by the cancellation is incomplete: it is not part of the animation
        if (this.cancelled) break;
        if (failure.error) throw failure.error;
        if (img.width !== o.width || img.height !== o.height)
          throw new Error(`Frame ${frame} is ${img.width}×${img.height}, expected ${o.width}×${o.height}`);
        this.lastFrame = img;
        // the encoder gets its own copy (transferred), the preview keeps the frame
        const data = new Uint8ClampedArray(img.data);
        encoding.push(
          encoder
            .call<{ ok: true }>(
              { type: 'encode-frame', session, frame: { width: img.width, height: img.height, data } },
              encoder.kind === 'worker' ? [data.buffer] : [],
            )
            .catch((err: unknown) => {
              failure.error ??= err instanceof Error ? err : new Error(String(err));
            }),
        );
        rendered.push(frame);
        this.emit({ index: i + 1 });
      }
      await Promise.all(encoding);
      if (failure.error) throw failure.error;
      if (!rendered.length) {
        closed = true;
        encoder.notify({ type: 'encode-abort', session });
        this.emit({ phase: 'cancelled' });
        return null;
      }
      this.emit({ phase: 'encoding' });
      const file = await encoder.call<EncodedFile>({ type: 'encode-end', session });
      closed = true;
      const result: AnimationResult = {
        data: file.data,
        mime: o.format === 'GIF' ? 'image/gif' : 'image/apng',
        extension: o.format === 'GIF' ? 'gif' : 'png',
        width: o.width,
        height: o.height,
        fps: o.fps,
        frames: rendered,
        cancelled: this.cancelled,
        elapsedMs: now() - this.t0,
      };
      this.emit({ phase: this.cancelled ? 'cancelled' : 'done' });
      return result;
    } finally {
      if (!closed) encoder.notify({ type: 'encode-abort', session });
    }
  }
}

/** Starts rendering and encoding an animation (encoder on the pool's first worker). */
export function startAnimationRender(pool: RenderPool, options: AnimationRenderOptions): AnimationJob {
  return new AnimationJob(pool, options);
}
