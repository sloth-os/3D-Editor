import type { Easing, FCurve, Interpolation, Keyframe } from '../doc/types';

/*
 * Animation curve evaluation. Bezier segments use automatically computed, clamped handles
 * (Blender's default "Auto Clamped" handle type): extremes and plateaus get flat tangents, so
 * curves never overshoot neighbouring key values.
 */

function sortedKeys(fc: FCurve): Keyframe[] {
  const k = fc.keyframes;
  for (let i = 1; i < k.length; i++)
    if (k[i].frame < k[i - 1].frame) return [...k].sort((a, b) => a.frame - b.frame);
  return k;
}

/** Auto-clamped tangent (slope dv/dframe) at key i. */
function autoSlope(keys: Keyframe[], i: number): number {
  const k = keys[i];
  const prev = keys[i - 1];
  const next = keys[i + 1];
  if (!prev && !next) return 0;
  if (!prev) return 0;
  if (!next) return 0;
  // Clamp: local extremum or plateau → flat
  if ((k.value >= prev.value && k.value >= next.value) || (k.value <= prev.value && k.value <= next.value))
    return 0;
  return (next.value - prev.value) / (next.frame - prev.frame);
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const it = 1 - t;
  return it * it * it * p0 + 3 * it * it * t * p1 + 3 * it * t * t * p2 + t * t * t * p3;
}

/** Solves the bezier x(t) = x for t in [0, 1] (x monotonic in t for valid handles). */
function solveBezierT(x0: number, x1: number, x2: number, x3: number, x: number): number {
  let lo = 0;
  let hi = 1;
  let t = (x - x0) / (x3 - x0 || 1);
  for (let i = 0; i < 30; i++) {
    const xt = cubicBezier(x0, x1, x2, x3, t);
    if (Math.abs(xt - x) < 1e-7) break;
    if (xt < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return t;
}

function easeValue(t: number, easing: Easing | undefined): number {
  switch (easing) {
    case 'EASE_IN':
      return t * t;
    case 'EASE_OUT':
      return 1 - (1 - t) * (1 - t);
    case 'EASE_IN_OUT':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default:
      return t;
  }
}

/** Evaluates a curve at a (possibly fractional) frame. Returns undefined for empty curves. */
export function evaluateFCurve(fc: FCurve, frame: number): number | undefined {
  const keys = sortedKeys(fc);
  if (keys.length === 0) return undefined;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (frame <= first.frame) {
    if (fc.extrapolation === 'LINEAR' && keys.length > 1 && first.interpolation !== 'CONSTANT') {
      const s = (keys[1].value - first.value) / (keys[1].frame - first.frame);
      return first.value + s * (frame - first.frame);
    }
    return first.value;
  }
  if (frame >= last.frame) {
    if (fc.extrapolation === 'LINEAR' && keys.length > 1) {
      const p = keys[keys.length - 2];
      if (p.interpolation === 'CONSTANT') return last.value;
      const s = (last.value - p.value) / (last.frame - p.frame);
      return last.value + s * (frame - last.frame);
    }
    return last.value;
  }
  // binary search for the segment
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  switch (a.interpolation) {
    case 'CONSTANT':
      return a.value;
    case 'LINEAR': {
      const t = easeValue((frame - a.frame) / span, a.easing);
      return a.value + (b.value - a.value) * t;
    }
    case 'BEZIER':
    default: {
      const sa = autoSlope(keys, lo);
      const sb = autoSlope(keys, hi);
      const h = span / 3;
      const x0 = a.frame;
      const x1 = a.frame + h;
      const x2 = b.frame - h;
      const x3 = b.frame;
      const y0 = a.value;
      const y1 = a.value + sa * h;
      const y2 = b.value - sb * h;
      const y3 = b.value;
      const t = solveBezierT(x0, x1, x2, x3, frame);
      return cubicBezier(y0, y1, y2, y3, t);
    }
  }
}

/** Inserts or replaces a keyframe (keys within 0.001 frames are considered the same). */
export function insertKeyframe(
  fc: FCurve,
  frame: number,
  value: number,
  interpolation: Interpolation = 'BEZIER',
): FCurve {
  const keys = fc.keyframes.filter((k) => Math.abs(k.frame - frame) > 1e-3);
  const existing = fc.keyframes.find((k) => Math.abs(k.frame - frame) <= 1e-3);
  keys.push({
    frame,
    value,
    interpolation: existing?.interpolation ?? interpolation,
    easing: existing?.easing,
  });
  keys.sort((x, y) => x.frame - y.frame);
  return { ...fc, keyframes: keys };
}

export function removeKeyframe(fc: FCurve, frame: number): FCurve {
  return { ...fc, keyframes: fc.keyframes.filter((k) => Math.abs(k.frame - frame) > 1e-3) };
}

export function hasKeyframeAt(fc: FCurve, frame: number): boolean {
  return fc.keyframes.some((k) => Math.abs(k.frame - frame) <= 1e-3);
}

export function createFCurve(init: Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'>): FCurve {
  return { ...init, keyframes: [], extrapolation: 'CONSTANT', mute: false };
}
