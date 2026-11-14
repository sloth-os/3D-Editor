import { describe, expect, it } from 'vitest';
import type { Easing, FCurve, FModifierData, Interpolation, Keyframe } from '../src/doc/types';
import { evaluateFCurve, sortedKeyframes } from '../src/anim/fcurve';

/*
 * A frame state finds a curve's keys in frame order once per reading of the document and passes
 * them to evaluateFCurve (eval/frame-input.ts), which then finds the frame's segment by binary
 * search instead of checking the order of every key at every frame. The values must not change.
 */

/** A deterministic pseudo-random sequence in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const INTERPOLATIONS: Interpolation[] = ['BEZIER', 'LINEAR', 'CONSTANT'];
const EASINGS: (Easing | undefined)[] = [undefined, 'EASE_IN', 'EASE_OUT', 'EASE_IN_OUT'];
const EXTRAPOLATIONS: FCurve['extrapolation'][] = ['CONSTANT', 'LINEAR', 'CYCLIC'];
const MODIFIERS: (FModifierData[] | undefined)[] = [
  undefined,
  [{ type: 'NOISE', params: { scale: 3, strength: 0.7, phase: 2, offset: 0, depth: 1 } }],
  [{ type: 'STEPPED', params: { frame_step: 3, frame_offset: 1 } }],
  [{ type: 'LIMITS', params: { use_min_x: true, min_x: 4, use_max_y: true, max_y: 1.5 } }],
];

/** Curves of every kind: random keys (sorted or not, some on the same frame), extrapolations, modifiers. */
function curves(): FCurve[] {
  const next = random(7);
  const out: FCurve[] = [];
  for (let c = 0; c < 96; c++) {
    const n = [1, 2, 3, 17, 250][c % 5];
    const keyframes: Keyframe[] = Array.from({ length: n }, (_, i) => ({
      frame: c % 7 === 0 ? Math.floor(next() * 40) : i * (1 + next() * 4) + next(),
      value: (next() - 0.5) * 10,
      interpolation: INTERPOLATIONS[Math.floor(next() * 3)],
      easing: EASINGS[Math.floor(next() * 4)],
    }));
    if (c % 3 === 0) keyframes.reverse();
    out.push({
      target_type: 'object',
      target_id: 'o',
      path: 'location',
      index: c % 3,
      keyframes,
      extrapolation: EXTRAPOLATIONS[c % 3],
      modifiers: MODIFIERS[Math.floor(c / 3) % MODIFIERS.length],
      mute: false,
    });
  }
  return out;
}

const FRAMES = [-1e6, -50, -3.5, 0, 0.25, 1, 2.5, 7, 13.75, 40, 99.5, 250, 999.125, 1e6];

describe('the keys of a curve found once', () => {
  it('give the values of every curve at every frame, bit for bit', () => {
    let compared = 0;
    for (const fc of curves()) {
      const keys = sortedKeyframes(fc);
      const frames = [
        ...FRAMES,
        ...fc.keyframes.map((k) => k.frame),
        ...fc.keyframes.map((k) => k.frame + 0.5),
      ];
      for (const frame of frames) {
        expect(Object.is(evaluateFCurve(fc, frame, keys), evaluateFCurve(fc, frame)), `${frame}`).toBe(true);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(9000);
  });

  it('are the stored keys themselves when they are in frame order, else a sorted copy', () => {
    const sorted: FCurve = {
      target_type: 'object',
      target_id: 'o',
      path: 'location',
      index: 0,
      keyframes: [1, 2, 2, 5].map((frame) => ({ frame, value: frame, interpolation: 'LINEAR' })),
      extrapolation: 'CONSTANT',
      mute: false,
    };
    expect(sortedKeyframes(sorted)).toBe(sorted.keyframes);
    const unsorted = { ...sorted, keyframes: [...sorted.keyframes].reverse() };
    const keys = sortedKeyframes(unsorted);
    expect(keys).not.toBe(unsorted.keyframes);
    expect(keys.map((k) => k.frame)).toEqual([1, 2, 2, 5]);
    // the stored keys are left as they are
    expect(unsorted.keyframes.map((k) => k.frame)).toEqual([5, 2, 2, 1]);
    expect(evaluateFCurve(unsorted, 3.5, keys)).toBe(evaluateFCurve(unsorted, 3.5));
    expect(evaluateFCurve({ ...sorted, keyframes: [] }, 1, [])).toBeUndefined();
  });

  it('read a logarithmic number of keys per frame, where checking their order reads them all', () => {
    const n = 100_000;
    const keyframes: Keyframe[] = Array.from({ length: n }, (_, i) => ({
      frame: i + 1,
      value: Math.sin(i / 50),
      interpolation: 'BEZIER',
    }));
    let reads = 0;
    const counted = new Proxy(keyframes, {
      get(target, p, receiver) {
        if (typeof p === 'string' && /^\d+$/.test(p)) reads++;
        return Reflect.get(target, p, receiver);
      },
    });
    const fc: FCurve = {
      target_type: 'object',
      target_id: 'o',
      path: 'location',
      index: 0,
      keyframes: counted,
      extrapolation: 'CONSTANT',
      mute: false,
    };
    const keys = sortedKeyframes(fc);
    expect(reads).toBeGreaterThanOrEqual(2 * (n - 1));
    reads = 0;
    const value = evaluateFCurve(fc, 54_321.5, keys);
    // binary search (17 steps) and the segment's neighbours for the Bezier handles
    expect(reads).toBeLessThan(64);
    expect(value).toBe(evaluateFCurve({ ...fc, keyframes }, 54_321.5));
  });
});
