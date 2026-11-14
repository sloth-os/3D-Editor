import { shotAtSequenceFrame, shotOutputFrames, type ShotData } from '@3d-editor/core';
import { shotCovers } from '../../viewport/follow-shots';

/*
 * The cut as the sequence strip shows it: the enabled shots in cut order, each as long as the frames
 * it contributes (frame_end − frame_start + 1; core desk/shots.ts), one after the other. Sequence
 * frame s (0 = the first frame of the first enabled shot) maps to a shot and a scene frame
 * (shotAtSequenceFrame); a scene frame maps back to the sequence frame of the shot showing it.
 */

/** A shot of the cut as a block of the strip. */
export interface SequenceBlock {
  shot: ShotData;
  /** The shot's index in the shot list (disabled shots counted). */
  index: number;
  /** Its first sequence frame. */
  start: number;
  /** Its output frames. */
  frames: number;
}

/** The enabled shots of the cut, in cut order, with where each starts in the sequence. */
export function sequenceBlocks(shots: readonly ShotData[]): SequenceBlock[] {
  const out: SequenceBlock[] = [];
  let start = 0;
  shots.forEach((shot, index) => {
    if (!shot.enabled) return;
    const frames = shotOutputFrames(shot);
    if (frames <= 0) return;
    out.push({ shot, index, start, frames });
    start += frames;
  });
  return out;
}

/** Frames of the whole cut. */
export function sequenceTotal(blocks: readonly SequenceBlock[]): number {
  const last = blocks[blocks.length - 1];
  return last ? last.start + last.frames : 0;
}

/** Where sequence frame `s` is: its block, and the scene frame it shows; null outside the cut. */
export function sequencePosition(
  shots: readonly ShotData[],
  s: number,
): { shot: ShotData; sceneFrame: number; offset: number } | null {
  const at = shotAtSequenceFrame(shots, s);
  return at ? { shot: at.shot, sceneFrame: at.sceneFrame, offset: at.offset } : null;
}

/**
 * The sequence frame showing scene frame `frame`: in the pinned shot while it covers the frame (the
 * shot the strip put the viewport in), else in the first enabled shot covering it; null when no shot
 * of the cut shows it.
 */
export function sequenceFrameOf(
  blocks: readonly SequenceBlock[],
  frame: number,
  pinned: string | null,
): number | null {
  const at = (b: SequenceBlock) => b.start + Math.min(b.frames - 1, Math.floor(frame) - b.shot.frame_start);
  const pin = pinned ? blocks.find((b) => b.shot.id === pinned) : undefined;
  if (pin && shotCovers(pin.shot, frame)) return at(pin);
  const first = blocks.find((b) => shotCovers(b.shot, frame));
  return first ? at(first) : null;
}

/** The sequence frame under x on a strip `width` pixels wide showing `total` frames (clamped into the cut). */
export function sequenceFrameAtX(x: number, width: number, total: number): number {
  if (total <= 0 || !(width > 0)) return 0;
  const s = Math.floor((x / width) * total);
  return Math.max(0, Math.min(total - 1, Number.isFinite(s) ? s : 0));
}

/** The x (pixels) where sequence frame `s` starts on a strip `width` pixels wide showing `total` frames. */
export function xOfSequenceFrame(s: number, width: number, total: number): number {
  return total > 0 ? (s / total) * width : 0;
}

/** The block holding sequence frame `s`, or null. */
export function blockAt(blocks: readonly SequenceBlock[], s: number): SequenceBlock | null {
  return blocks.find((b) => s >= b.start && s < b.start + b.frames) ?? null;
}

/** A frame count as timecode minutes:seconds:frames (hours first when there are any), e.g. 01:02:05. */
export function timecode(frames: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.floor(frames));
  const ff = f % rate;
  const total = Math.floor(f / rate);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${hh ? `${two(hh)}:` : ''}${two(mm)}:${two(ss)}:${two(ff)}`;
}

/** A length in seconds for the shot list (one decimal; whole seconds without one). */
export function seconds(frames: number, fps: number): string {
  const s = frames / Math.max(1, fps);
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}
