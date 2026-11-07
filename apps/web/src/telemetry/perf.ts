import { signal } from '@preact/signals';
import { telemetry } from './telemetry';

/** Live frame statistics for the status bar and diagnostics. */
export const fps = signal(0);
export const frameTimeMs = signal(0);
/**
 * How long the viewport's last frame took to draw (until the next one could start), when that was
 * longer than {@link SLOW_FRAME_MS}; 0 otherwise. Rendered shading of a heavy scene in software
 * WebGL can take many seconds per frame: the viewport says so instead of looking frozen.
 */
export const slowFrameMs = signal(0);
/**
 * Whether that slow frame compiled shaders (the first frame in Material Preview or Rendered shading
 * of a scene, or after its lights or materials changed): later frames are faster.
 */
export const slowFrameCompiled = signal(false);
/** A frame slower than this is reported ({@link slowFrameMs}). */
export const SLOW_FRAME_MS = 2000;

let frames = 0;
let acc = 0;
let last = 0;
let windowStart = 0;

/** Call once per rendered frame. */
export function recordFrame(now = performance.now()): void {
  if (last) {
    const dt = now - last;
    acc += dt;
    frames++;
    if (dt < 1000) telemetry.histogram('editor.frame_time_ms', dt);
  }
  last = now;
  if (!windowStart) windowStart = now;
  if (now - windowStart >= 1000) {
    fps.value = Math.round((frames * 1000) / (now - windowStart));
    frameTimeMs.value = frames ? acc / frames : 0;
    telemetry.gauge('editor.fps', fps.value);
    frames = 0;
    acc = 0;
    windowStart = now;
  }
}

/** Marks the viewport idle (no continuous rendering) so FPS is not misreported. */
export function resetFrameClock(): void {
  last = 0;
}
