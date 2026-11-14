import type { Vec3 } from '../../math/types';
import type { FCurve, Interpolation, Keyframe, ObjectData, PoseBone } from '../../doc/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import { createFCurve } from '../../anim/fcurve';
import { poseBonePath } from '../../armature/edit';
import { FrameState } from '../../eval/frame-state';

/*
 * Keyframe writing for the actor animations: keys are collected per channel and each F-curve is
 * rewritten once (an F-curve's keyframes are one last-writer-wins value in the document), with
 * the keys of a frame range cleared first so a new pose or move replaces what was there.
 */

const SAME_FRAME = 1e-3;

interface Channel {
  target: string;
  path: string;
  index: number;
  keys: Keyframe[];
  clear: [number, number][];
}

/** Collects keys of object channels (object F-curves) and writes them in one go. */
export class KeyWriter {
  private readonly channels = new Map<string, Channel>();

  private channel(target: string, path: string, index: number): Channel {
    const k = `${target}\u0000${path}\u0000${index}`;
    let c = this.channels.get(k);
    if (!c) this.channels.set(k, (c = { target, path, index, keys: [], clear: [] }));
    return c;
  }

  /** Adds (or replaces, at the same frame) a key of `target`'s channel `path[index]`. */
  key(
    target: string,
    path: string,
    index: number,
    frame: number,
    value: number,
    interp: Interpolation = 'BEZIER',
  ): void {
    if (!Number.isFinite(frame) || !Number.isFinite(value)) return;
    const c = this.channel(target, path, index);
    const i = c.keys.findIndex((k) => Math.abs(k.frame - frame) <= SAME_FRAME);
    const key: Keyframe = { frame, value, interpolation: interp };
    if (i >= 0) c.keys[i] = key;
    else c.keys.push(key);
  }

  /** Keys the three channels of a vector property. */
  key3(
    target: string,
    path: string,
    frame: number,
    value: Readonly<Vec3>,
    interp: Interpolation = 'BEZIER',
  ): void {
    for (let i = 0; i < 3; i++) this.key(target, path, i, frame, value[i], interp);
  }

  /** Removes the existing keys of the channel with a frame in (from, to] when written. */
  clear(target: string, path: string, index: number, from: number, to: number): void {
    this.channel(target, path, index).clear.push([from, to]);
  }

  clear3(target: string, path: string, from: number, to: number): void {
    for (let i = 0; i < 3; i++) this.clear(target, path, i, from, to);
  }

  /** Removes the existing key of the channel at `frame` (within SAME_FRAME) when written. */
  drop(target: string, path: string, index: number, frame: number): void {
    this.clear(target, path, index, frame - 2 * SAME_FRAME, frame);
  }

  /** Number of keys collected. */
  get size(): number {
    let n = 0;
    for (const c of this.channels.values()) n += c.keys.length;
    return n;
  }

  /** Whether a key or clear of the channel has been collected. */
  has(target: string, path: string, index: number): boolean {
    return this.channels.has(`${target}\u0000${path}\u0000${index}`);
  }

  /**
   * The F-curve the channel will have once written (its kept keys and the collected ones, in frame
   * order; CONSTANT extrapolation), to evaluate before committing; null when nothing was collected
   * for it or it will have no keys.
   */
  curve(doc: SceneDoc, target: string, path: string, index: number): FCurve | null {
    const c = this.channels.get(`${target}\u0000${path}\u0000${index}`);
    if (!c) return null;
    const fc = this.written(doc, c).fc;
    return fc.keyframes.length ? fc : null;
  }

  private written(doc: SceneDoc, c: Channel): { fc: FCurve; old: FCurve | null } {
    const base = { target_type: 'object' as const, target_id: c.target, path: c.path, index: c.index };
    const old = doc.getFCurve(fcurveKey(base));
    const fc: FCurve = old ?? createFCurve(base);
    const kept = fc.keyframes.filter(
      (k) =>
        !c.clear.some(([a, b]) => k.frame > a + SAME_FRAME && k.frame <= b + SAME_FRAME) &&
        !c.keys.some((n) => Math.abs(n.frame - k.frame) <= SAME_FRAME),
    );
    const keys = [...kept, ...c.keys].sort((a, b) => a.frame - b.frame);
    return { fc: { ...fc, keyframes: keys, extrapolation: 'CONSTANT' }, old };
  }

  /** Writes every channel (CONSTANT extrapolation); a channel left without keys loses its F-curve. */
  commit(doc: SceneDoc): void {
    for (const c of this.channels.values()) {
      const { fc, old } = this.written(doc, c);
      if (!fc.keyframes.length) {
        if (old) doc.removeFCurve(fcurveKey(fc));
        continue;
      }
      doc.setFCurve(fc);
    }
  }
}

/** The keys of an object channel, sorted by frame ([] when it has none). */
export function channelKeys(doc: SceneDoc, target: string, path: string, index: number): Keyframe[] {
  const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: target, path, index }));
  return fc ? [...fc.keyframes].sort((a, b) => a.frame - b.frame) : [];
}

/** The first key after `frame` of an object channel (null when none). */
export function nextKey(
  doc: SceneDoc,
  target: string,
  path: string,
  index: number,
  frame: number,
): Keyframe | null {
  const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: target, path, index }));
  if (!fc) return null;
  let best: Keyframe | null = null;
  for (const k of fc.keyframes) if (k.frame > frame + SAME_FRAME && (!best || k.frame < best.frame)) best = k;
  return best;
}

/** The actor object as animated at `frame` (location, rotation and pose channels). */
export function animatedObject(doc: SceneDoc, id: string, frame: number): ObjectData | null {
  return new FrameState(doc, frame).get<ObjectData>('object', id);
}

/** Animated pose bones of an armature object at `frame`. */
export function animatedPose(doc: SceneDoc, id: string, frame: number): Record<string, PoseBone> {
  return animatedObject(doc, id, frame)?.pose?.bones ?? {};
}

/** Path of a pose bone channel ("pose.bones[\"hips\"].rotation_euler"). */
export const bonePath = (bone: string, channel: 'rotation_euler' | 'location'): string =>
  poseBonePath(bone, channel);
