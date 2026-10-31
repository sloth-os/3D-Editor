import type { Vec3 } from '../math/types';
import { distance3, lerp3, normalize3, sub3 } from '../math/vec3';
import type { CurveData } from '../doc/types';
import { evaluateCurveSplines, type EvaluatedSpline } from './spline';

/** A point on a curve path (curve object space). */
export interface CurveSample {
  position: Vec3;
  /** Unit tangent in the direction of increasing t. */
  tangent: Vec3;
  tilt: number;
  radius: number;
}

/** Arc-length parameterised path along one spline of a curve (used by Follow Path, Curve deform…). */
export interface CurvePath {
  readonly length: number;
  readonly cyclic: boolean;
  /** Sample at normalised arc length t (0 = start, 1 = end); wraps when cyclic, clamps otherwise. */
  sample(t: number): CurveSample;
}

/** Builds an arc-length path from a sampled spline (null when it has fewer than 2 points). */
export function pathFromSpline(s: EvaluatedSpline): CurvePath | null {
  const pts = s.cyclic ? [...s.points, s.points[0]] : s.points;
  const tilts = s.cyclic ? [...s.tilts, s.tilts[0]] : s.tilts;
  const radii = s.cyclic ? [...s.radii, s.radii[0]] : s.radii;
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance3(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const segTangent = (i: number): Vec3 => normalize3(sub3(pts[i + 1], pts[i]));
  return {
    length: total,
    cyclic: s.cyclic,
    sample(t: number): CurveSample {
      let u = s.cyclic ? t - Math.floor(t) : Math.min(1, Math.max(0, t));
      if (!Number.isFinite(u)) u = 0;
      const d = u * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= d) lo = mid;
        else hi = mid;
      }
      const span = cum[hi] - cum[lo] || 1;
      const f = Math.min(1, Math.max(0, (d - cum[lo]) / span));
      return {
        position: lerp3(pts[lo], pts[hi], f),
        tangent: segTangent(lo),
        tilt: tilts[lo] + (tilts[hi] - tilts[lo]) * f,
        radius: radii[lo] + (radii[hi] - radii[lo]) * f,
      };
    },
  };
}

/** Path along spline `splineIndex` of a curve (null if missing or degenerate). */
export function buildCurvePath(curve: CurveData, splineIndex = 0): CurvePath | null {
  const s = evaluateCurveSplines(curve)[splineIndex];
  return s ? pathFromSpline(s) : null;
}
