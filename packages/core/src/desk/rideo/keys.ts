import type { FCurve, Interpolation, Keyframe } from '../../doc/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import { createFCurve, evaluateFCurve } from '../../anim/fcurve';

/*
 * Keyframe writing of the rideo import: single keys on object channels, keys removed from a frame on
 * (a cut that replaces what an earlier move left behind), whole animations cleared on re-import, the
 * hidden spans of props (scale keys, as desk.tether_fly hides a string before its flight), and the
 * keys set aside while later shots are keyed (KeyArchive).
 */

/** Scale of an object hidden for a span of frames: shrunk to a point (desk.tether_fly's TETHER_HIDDEN_SCALE). */
export const HIDDEN_SCALE = 1e-8;

const SAME_FRAME = 1e-3;

/** Object channels a cut replaces on an actor: its transform and its bones' (not constraint influences). */
const MOTION_PATH =
  /^(location|rotation_euler|scale|pose\.bones\[(["']).+\2\]\.(location|rotation_euler|scale))$/;

const ref = (target: string, path: string, index: number) => ({
  target_type: 'object' as const,
  target_id: target,
  path,
  index,
});

/** Sets (or replaces, at the same frame) one key of an object channel; CONSTANT extrapolation. */
export function setKey(
  doc: SceneDoc,
  target: string,
  path: string,
  index: number,
  frame: number,
  value: number,
  interpolation: Interpolation = 'CONSTANT',
): void {
  if (!Number.isFinite(frame) || !Number.isFinite(value)) return;
  const r = ref(target, path, index);
  const fc: FCurve = doc.getFCurve(fcurveKey(r)) ?? createFCurve(r);
  const keys = fc.keyframes.filter((k) => Math.abs(k.frame - frame) > SAME_FRAME);
  keys.push({ frame, value, interpolation });
  keys.sort((a, b) => a.frame - b.frame);
  doc.setFCurve({ ...fc, keyframes: keys, extrapolation: 'CONSTANT' });
}

/** Replaces an object channel's keys in [from, to] with `keys` (sorted; CONSTANT extrapolation). */
export function replaceKeys(
  doc: SceneDoc,
  target: string,
  path: string,
  index: number,
  from: number,
  to: number,
  keys: readonly Keyframe[],
): void {
  const r = ref(target, path, index);
  const old = doc.getFCurve(fcurveKey(r));
  const fc: FCurve = old ?? createFCurve(r);
  const kept = fc.keyframes.filter((k) => k.frame < from - SAME_FRAME || k.frame > to + SAME_FRAME);
  const all = [...kept, ...keys].sort((a, b) => a.frame - b.frame);
  if (!all.length && !old) return;
  doc.setFCurve({ ...fc, keyframes: all, extrapolation: 'CONSTANT' });
}

/** Removes the keys an actor's motion channels have at `frame` and after; returns how many went. */
export function truncateMotion(doc: SceneDoc, target: string, frame: number): number {
  let removed = 0;
  for (const fc of doc.listFCurves(target)) {
    if (fc.target_type !== 'object' || !MOTION_PATH.test(fc.path)) continue;
    const keys = fc.keyframes.filter((k) => k.frame < frame - SAME_FRAME);
    if (keys.length === fc.keyframes.length) continue;
    removed += fc.keyframes.length - keys.length;
    if (keys.length) doc.setFCurve({ ...fc, keyframes: keys });
    else doc.removeFCurve(fcurveKey(fc));
  }
  return removed;
}

/** Removes every animation curve of an object (its own channels, its bones', its constraints'). */
export function clearAnimation(doc: SceneDoc, target: string): void {
  for (const fc of doc.listFCurves(target)) doc.removeFCurve(fcurveKey(fc));
}

/**
 * Hides an object over the spans given (inclusive frames) by keying its scale to a point there
 * (CONSTANT, the keys the spans cover replaced) and, after each span, back to `restore` — or, with
 * 'keep', to the keys the channel already has from the frame after the span (a string keyed on every
 * frame of its flight). The frame before a span keeps the value it had, so that nothing before the
 * span is hidden by the curve's constant extrapolation. A span with no end hides it for good.
 */
export function hideSpans(
  doc: SceneDoc,
  target: string,
  restore: readonly [number, number, number] | 'keep',
  spans: readonly { from: number; to: number | null }[],
): number {
  let keys = 0;
  const stored = doc.getObject(target)?.scale ?? [1, 1, 1];
  for (const span of spans)
    for (let i = 0; i < 3; i++) {
      const fc = doc.getFCurve(fcurveKey(ref(target, 'scale', i)));
      const before = (fc ? evaluateFCurve(fc, span.from - 1) : undefined) ?? stored[i];
      const list: Keyframe[] = [
        { frame: span.from - 1, value: before, interpolation: 'CONSTANT' },
        { frame: span.from, value: HIDDEN_SCALE, interpolation: 'CONSTANT' },
      ];
      let to = span.to === null ? Infinity : span.to;
      if (span.to !== null && restore !== 'keep') {
        list.push({ frame: span.to + 1, value: restore[i], interpolation: 'CONSTANT' });
        to = span.to + 1;
      }
      replaceKeys(doc, target, 'scale', i, span.from - 1, to, list);
      keys += list.length;
    }
  return keys;
}

/**
 * The keys of objects' curves set aside while their later shots are keyed, and put back after.
 * Every key writer reads and writes a channel's whole curve (SceneDoc copies it each way), so keying
 * a film shot after shot into curves that keep all its keys costs as much per shot as the film keyed
 * so far: over a long clip, the import's time grows with the square of its length. Before an
 * object's shot is keyed from frame `from` on, `shelve` takes out the keys more than two keys before
 * `from - 2`: the keys left evaluate exactly as all of them would from the last two kept keys on
 * (auto-clamped handles read a key's neighbours only), and nothing keyed from `from - 1` on reads an
 * earlier frame. `restore` puts every key back, in order, in front of the keys written since.
 */
export class KeyArchive {
  private readonly held = new Map<string, { curve: FCurve; keys: Keyframe[] }>();

  constructor(private readonly doc: SceneDoc) {}

  /** Sets aside the keys of `target`'s curves that lie well before frame `from` (see the class). */
  shelve(target: string, from: number): void {
    for (const fc of this.doc.listFCurves(target)) {
      const keys = fc.keyframes;
      let last = -1;
      while (last + 1 < keys.length && keys[last + 1].frame < from - 2) last++;
      // keys[0 .. last-2] go; keys[last-1] and keys[last] stay as the neighbours of what follows
      const cut = last - 1;
      if (cut <= 0) continue;
      const k = fcurveKey(fc);
      const entry = this.held.get(k);
      if (entry) entry.keys.push(...keys.slice(0, cut));
      else this.held.set(k, { curve: { ...fc, keyframes: [] }, keys: keys.slice(0, cut) });
      this.doc.setFCurve({ ...fc, keyframes: keys.slice(cut) });
    }
  }

  /** Puts every key set aside back in front of its curve's keys (the curve made again if it went). */
  restore(): void {
    for (const [k, { curve, keys }] of this.held) {
      const now = this.doc.getFCurve(k) ?? curve;
      const after = keys.length ? keys[keys.length - 1].frame : -Infinity;
      this.doc.setFCurve({ ...now, keyframes: [...keys, ...now.keyframes.filter((x) => x.frame > after)] });
    }
    this.held.clear();
  }
}
