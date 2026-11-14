import { signal } from '@preact/signals';
import { session as sessionSignal } from '../../app/store';
import type { ProjectSession } from '../../project/session';
import { shotPin, shotsOf } from '../../viewport/follow-shots';
import { sequenceBlocks, sequenceFrameOf, sequencePosition, sequenceTotal } from './sequence';

/*
 * Playing and scrubbing the cut (the sequence strip): each sequence frame is shown at the scene
 * frame of the shot holding it, through that shot's camera. The viewport follows the shots (Follow
 * Shots, camera view) with the shot pinned, so overlapping shots (coverage) each show their own
 * camera. Playback runs in real time at the scene's frame rate, skipping frames when the viewport is
 * slower, and stops at the end of the cut, when the timeline starts playing, when the frame is moved
 * elsewhere, or when the project closes.
 */

/** Whether the sequence strip plays the cut. */
export const sequencePlaying = signal(false);

/**
 * Shows sequence frame `k`: the scene frame of the shot holding it, through that shot's camera.
 * Returns that scene frame, or null outside the cut.
 */
export function showSequenceFrame(s: ProjectSession, k: number): number | null {
  const pos = sequencePosition(shotsOf(s.doc), k);
  if (!pos) return null;
  const v = s.view;
  shotPin(v).value = pos.shot.id;
  v.followShots.value = true;
  v.cameraView.value = true;
  s.state.frame = pos.sceneFrame;
  return pos.sceneFrame;
}

/**
 * Looks through a shot at its first frame (its camera, Follow Shots on, the shot pinned); stops the
 * sequence playback. False when there is no such enabled shot.
 */
export function showShot(s: ProjectSession, shotId: string): boolean {
  const shot = shotsOf(s.doc).find((x) => x.id === shotId);
  if (!shot?.enabled) return false;
  stopSequence();
  const v = s.view;
  shotPin(v).value = shot.id;
  v.followShots.value = true;
  v.cameraView.value = true;
  s.state.frame = shot.frame_start;
  return true;
}

/** The sequence frame the viewport shows now; null when no shot of the cut shows the current frame. */
export function currentSequenceFrame(s: ProjectSession): number | null {
  return sequenceFrameOf(sequenceBlocks(shotsOf(s.doc)), s.state.frame, shotPin(s.view).peek());
}

interface Run {
  session: ProjectSession;
  /** Clock time of sequence frame s0. */
  t0: number;
  s0: number;
  /** The scene frame shown last: another one means someone moved the frame. */
  shown: number;
}

let run: Run | null = null;
let raf = 0;

// a playback of a project that closed stops at once (its next frame may never come in a hidden tab,
// and the run would keep the closed session reachable meanwhile)
sessionSignal.subscribe((open) => {
  if (run && run.session !== open) stopSequence();
});

/**
 * Plays the cut from the sequence frame shown now (from its start when that is the last frame or
 * outside the cut). Stops the timeline's playback.
 */
export function playSequence(s: ProjectSession, now = performance.now()): void {
  stopSequence();
  const total = sequenceTotal(sequenceBlocks(shotsOf(s.doc)));
  if (!total) return;
  let s0 = currentSequenceFrame(s) ?? 0;
  if (s0 >= total - 1) s0 = 0;
  s.view.playing.value = false;
  const shown = showSequenceFrame(s, s0);
  if (shown === null) return;
  run = { session: s, t0: now, s0, shown };
  sequencePlaying.value = true;
  raf = requestAnimationFrame(tickSequence);
}

/** Stops the sequence playback (the frame stays where it is). */
export function stopSequence(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  run = null;
  if (sequencePlaying.peek()) sequencePlaying.value = false;
}

/** Plays or stops the cut. */
export function toggleSequence(s: ProjectSession): void {
  if (run?.session === s) stopSequence();
  else playSequence(s);
}

/**
 * One step of the playback at clock time `now`: shows the sequence frame due then; stops at the end
 * of the cut and when something else took over the frame. Returns whether it plays on.
 */
export function tickSequence(now: number): boolean {
  raf = 0;
  const r = run;
  if (!r) return false;
  const s = r.session;
  if (sessionSignal.peek() !== s || s.view.playing.peek() || s.state.frame !== r.shown) {
    stopSequence();
    return false;
  }
  const total = sequenceTotal(sequenceBlocks(shotsOf(s.doc)));
  const fps = Math.max(1, s.doc.getScene().fps || 24);
  const k = r.s0 + Math.max(0, Math.floor(((now - r.t0) * fps) / 1000));
  const last = k >= total - 1;
  const shown = showSequenceFrame(s, Math.min(k, total - 1));
  if (shown === null || last) {
    stopSequence();
    return false;
  }
  r.shown = shown;
  raf = requestAnimationFrame(tickSequence);
  return true;
}
