import { signal } from '@preact/signals';
import { telemetry } from './telemetry';

/** Live frame statistics for the status bar and diagnostics. */
export const fps = signal(0);
export const frameTimeMs = signal(0);

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
