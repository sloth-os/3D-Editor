import type { Vec3 } from '../math/types';
import { distance3, lerp3, normalize3, sub3 } from '../math/vec3';
import type { CurveData } from '../doc/types';
import { evaluateCurveSplines, type EvaluatedSpline } from './spline';
import { computeFrames, type TwistMode } from './frames';

/** A point on a curve path (curve object space). */
export interface CurveSample {
  position: Vec3;
  /**
   * Unit tangent in the direction of increasing t: the polyline direction for POLY splines, the
   * (interpolated) analytic tangent for BEZIER and NURBS splines.
   */
  tangent: Vec3;
  tilt: number;
  radius: number;
  /**
   * Unit "up" axis of the curve's twist frame (perpendicular to `tangent`, tilt already applied):
   * where a bevel profile's +Y points. The side axis is `up × tangent`. Optional for paths built
   * elsewhere; consumers fall back to a Z-up frame rotated by `tilt`.
   */
  up?: Vec3;
}

/** Arc-length parameterised path along one spline of a curve (used by Follow Path, Curve deform…). */
export interface CurvePath {
  readonly length: number;
  readonly cyclic: boolean;
  /** Sample at normalised arc length t (0 = start, 1 = end); wraps when cyclic, clamps otherwise. */
  sample(t: number): CurveSample;
}

export interface PathOptions {
  /** Twist mode used for the `up` frames (default MINIMUM, Blender's default). */
  twistMode?: TwistMode;
  /** 2D curves keep +Z as up and ignore tilt. */
  is2D?: boolean;
}

/** Builds an arc-length path from a sampled spline (null when it has fewer than 2 distinct points). */
export function pathFromSpline(s: EvaluatedSpline, opts: PathOptions = {}): CurvePath | null {
  const pts = s.cyclic ? [...s.points, s.points[0]] : s.points;
  const tilts = s.cyclic ? [...s.tilts, s.tilts[0]] : s.tilts;
  const radii = s.cyclic ? [...s.radii, s.radii[0]] : s.radii;
  const tans =
    s.tangents && s.tangents.length === s.points.length
      ? s.cyclic
        ? [...s.tangents, s.tangents[0]]
        : s.tangents
      : null;
  // straight spans (Bezier segments between VECTOR handles) keep their own direction
  const straight = s.straight && s.straight.length === s.points.length ? s.straight : null;
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance3(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const segTangent = (i: number): Vec3 => {
    // skip zero-length segments so the tangent is always defined
    for (let k = i; k + 1 < pts.length; k++) {
      const d = normalize3(sub3(pts[k + 1], pts[k]));
      if (d[0] || d[1] || d[2]) return d;
    }
    for (let k = i; k > 0; k--) {
      const d = normalize3(sub3(pts[k], pts[k - 1]));
      if (d[0] || d[1] || d[2]) return d;
    }
    return [1, 0, 0];
  };
  const ups = pathUps(s, opts);
  const upAt = (u: Vec3[], i: number): Vec3 => u[s.cyclic && i === pts.length - 1 ? 0 : i];
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
      let tangent = segTangent(lo);
      if (tans && !straight?.[lo]) {
        const smooth = normalize3(lerp3(tans[lo], tans[hi], f));
        if (smooth[0] || smooth[1] || smooth[2]) tangent = smooth;
      }
      const sample: CurveSample = {
        position: lerp3(pts[lo], pts[hi], f),
        tangent,
        tilt: tilts[lo] + (tilts[hi] - tilts[lo]) * f,
        radius: radii[lo] + (radii[hi] - radii[lo]) * f,
      };
      if (ups) {
        const a = upAt(ups, lo);
        const b = upAt(ups, hi);
        const raw = lerp3(a, b, f);
        const dt = raw[0] * tangent[0] + raw[1] * tangent[1] + raw[2] * tangent[2];
        const up = normalize3([raw[0] - dt * tangent[0], raw[1] - dt * tangent[1], raw[2] - dt * tangent[2]]);
        if (up[0] || up[1] || up[2]) sample.up = up;
      }
      return sample;
    },
  };
}

/** Twist-frame up vectors at every sampled point (null when the spline has < 2 distinct points). */
function pathUps(s: EvaluatedSpline, opts: PathOptions): Vec3[] | null {
  const n = s.points.length;
  // frames need distinct consecutive points: map every sample to its deduplicated twin
  const keep: number[] = [];
  const map = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const last = keep.length ? s.points[keep[keep.length - 1]] : null;
    if (!last || distance3(last, s.points[i]) > 1e-12) keep.push(i);
    map[i] = keep.length - 1;
  }
  if (s.cyclic && keep.length > 2 && distance3(s.points[keep[0]], s.points[keep[keep.length - 1]]) <= 1e-12) {
    keep.pop();
    for (let i = 0; i < n; i++) if (map[i] >= keep.length) map[i] = 0;
  }
  if (keep.length < 2) return null;
  const frames = computeFrames(
    keep.map((i) => s.points[i]),
    s.cyclic && keep.length > 2,
    keep.map((i) => s.tilts[i] ?? 0),
    opts.twistMode ?? 'MINIMUM',
    !!opts.is2D,
  );
  return map.map((k) => frames.ups[k]);
}

/** Path along spline `splineIndex` of a curve (null if missing or degenerate). */
export function buildCurvePath(curve: CurveData, splineIndex = 0): CurvePath | null {
  const s = evaluateCurveSplines(curve)[splineIndex];
  return s ? pathFromSpline(s, { twistMode: curve.twist_mode, is2D: curve.dimensions === '2D' }) : null;
}
