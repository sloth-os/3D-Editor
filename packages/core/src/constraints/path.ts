import type { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { identity4, multiply4 } from '../math/mat4';
import { cross3, dot3, length3, normalize3 } from '../math/vec3';
import type { CurveData } from '../doc/types';
import type { CurvePath, CurveSample } from '../curve/path';
import { evaluateCurveSplines } from '../curve/spline';
import type { clampToSchema, followPathSchema, ForwardAxis } from './schemas';
import {
  FLT_EPSILON,
  axisLengths,
  invertSafe,
  scaleColumn,
  setColumn,
  transformPoint,
  translationOf,
  withTranslation,
} from './math';
import { UP_INDEX, completeFrame } from './track';
import { ConstraintSolveError, type SolveEnv } from './targets';

const FORWARD_INDEX: Record<ForwardAxis, number> = {
  FORWARD_X: 0,
  FORWARD_Y: 1,
  FORWARD_Z: 2,
  TRACK_NEGATIVE_X: 3,
  TRACK_NEGATIVE_Y: 4,
  TRACK_NEGATIVE_Z: 5,
};

/**
 * Samples a path at normalised arc length `t`. Cyclic paths wrap; open paths continue in a
 * straight line past their ends (like Blender's `where_on_path` without "Clamp").
 */
export function samplePathExtended(path: CurvePath, t: number): CurveSample {
  const u = Number.isFinite(t) ? t : 0;
  if (path.cyclic || (u >= 0 && u <= 1)) return path.sample(u);
  const end = path.sample(u < 0 ? 0 : 1);
  const over = (u < 0 ? u : u - 1) * path.length;
  return {
    ...end,
    position: [
      end.position[0] + end.tangent[0] * over,
      end.position[1] + end.tangent[1] * over,
      end.position[2] + end.tangent[2] * over,
    ],
  };
}

/** The parts of a path sample that define its orientation (`up` is optional in path samples). */
export interface PathOrientation {
  tangent: Vec3;
  tilt: number;
  /** Twist frame up axis (tilt applied) when the path provides one. */
  up?: Vec3;
}

/**
 * Orientation of a path at a sample (curve space): `forward` is the unit tangent and `up` the
 * path's twist frame up axis when the path provides one; otherwise the curve's Z axis made
 * perpendicular to the tangent and rotated by the tilt around it (Blender's Z-up path frame;
 * vertical tangents fall back to -Y like Blender).
 */
export function pathFrame(sample: PathOrientation): { forward: Vec3; up: Vec3 } {
  let forward = normalize3(sample.tangent);
  if (length3(forward) === 0) forward = [0, 1, 0];
  const given = sample.up;
  if (given && given.every(Number.isFinite)) {
    const k = dot3(given, forward);
    const up = normalize3([given[0] - forward[0] * k, given[1] - forward[1] * k, given[2] - forward[2] * k]);
    if (length3(up) > 0) return { forward, up };
  }
  const ref: Vec3 = Math.hypot(forward[0], forward[1]) > 1e-6 ? [0, 0, 1] : [0, -1, 0];
  const d = dot3(ref, forward);
  let up = normalize3([ref[0] - forward[0] * d, ref[1] - forward[1] * d, ref[2] - forward[2] * d]);
  const tilt = Number.isFinite(sample.tilt) ? sample.tilt : 0;
  if (tilt) {
    // rotate around the tangent (right hand rule); up ⟂ forward so Rodrigues simplifies
    const side = cross3(forward, up);
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    up = [up[0] * c + side[0] * s, up[1] * c + side[1] * s, up[2] * c + side[2] * s];
  }
  return { forward, up };
}

/** Rotation that aligns signed `forwardAxis` (0..5) with the path tangent and `upAxis` with its up. */
export function followPathRotation(sample: PathOrientation, forwardAxis: number, upAxis: number): Mat4 {
  const { forward, up } = pathFrame(sample);
  const f = forwardAxis % 3;
  const sign = forwardAxis > 2 ? -1 : 1;
  const out = identity4();
  setColumn(out, f, [forward[0] * sign, forward[1] * sign, forward[2] * sign]);
  setColumn(out, upAxis, up);
  completeFrame(out, 3 - f - upAxis);
  return out;
}

/** Normalised position along the path used by Follow Path (before wrapping / extrapolation). */
export function followPathTime(p: z.infer<typeof followPathSchema>, curve: CurveData): number {
  if (p.use_fixed_location) return p.offset_factor;
  const duration = Number.isFinite(curve.path_duration) ? Math.max(1, curve.path_duration) : 100;
  const evalTime = Number.isFinite(curve.eval_time) ? curve.eval_time : 0;
  return (evalTime - p.offset) / duration;
}

export function solveFollowPath(m: Mat4, p: z.infer<typeof followPathSchema>, env: SolveEnv): Mat4 {
  const forward = FORWARD_INDEX[p.forward_axis];
  const up = UP_INDEX[p.up_axis];
  if (forward % 3 === up) throw new ConstraintSolveError('forward_axis and up_axis must be different axes');
  const { path, matrix, curve } = env.curveTarget();
  const sample = samplePathExtended(path, followPathTime(p, curve));
  let onPath = p.use_curve_follow ? followPathRotation(sample, forward, up) : identity4();
  if (p.use_curve_radius) {
    const r = Number.isFinite(sample.radius) ? sample.radius : 1;
    for (let c = 0; c < 3; c++) scaleColumn(onPath, c, r);
  }
  onPath = withTranslation(onPath, sample.position);
  // the owner's own transform is applied in the frame of the point on the path
  const out = multiply4(multiply4(matrix, onPath), m);
  if (!p.use_curve_radius) {
    // keep the owner's scale (the curve object's scale must not leak into it)
    const before = axisLengths(m);
    const after = axisLengths(out);
    for (let c = 0; c < 3; c++) if (after[c] !== 0) scaleColumn(out, c, before[c] / after[c]);
  }
  return out;
}

const boundsCache = new WeakMap<CurveData, { min: Vec3; max: Vec3 } | null>();

/** Bounding box of the evaluated splines of a curve (curve space), null when it has no points. */
function curveBounds(curve: CurveData): { min: Vec3; max: Vec3 } | null {
  if (boundsCache.has(curve)) return boundsCache.get(curve)!;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of evaluateCurveSplines(curve))
    for (const p of s.points)
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
  const res = Number.isFinite(min[0]) ? { min, max } : null;
  boundsCache.set(curve, res);
  return res;
}

const CLAMP_AXIS: Record<z.infer<typeof clampToSchema>['main_axis'], number> = {
  CLAMPTO_AUTO: -1,
  CLAMPTO_X: 0,
  CLAMPTO_Y: 1,
  CLAMPTO_Z: 2,
};

/** Path parameter (0..1) Clamp To maps a coordinate to, given the curve's extent along the axis. */
export function clampToTime(value: number, lo: number, hi: number, cyclic: boolean): number {
  const len = hi - lo;
  if (cyclic) {
    if (Math.abs(len) < FLT_EPSILON) return 0;
    if (value < lo) return (value - (lo - Math.ceil((lo - value) / len) * len)) / len;
    if (value > hi) return (value - (hi + Math.trunc((value - hi) / len) * len)) / len;
    return (value - lo) / len;
  }
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return Math.abs(len) >= FLT_EPSILON ? (value - lo) / len : 0;
}

export function solveClampTo(m: Mat4, p: z.infer<typeof clampToSchema>, env: SolveEnv): Mat4 {
  const { path, matrix, curve } = env.curveTarget();
  const bounds = curveBounds(curve);
  if (!bounds) return m;
  // The owner location is compared with the curve's bounding box in curve space (Blender compares
  // the world location with the object-space box, which only agrees for untransformed curves).
  const own = transformPoint(invertSafe(matrix), translationOf(m));
  const ext = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]);
  let axis = CLAMP_AXIS[p.main_axis];
  if (axis < 0) axis = ext[2] > ext[0] && ext[2] > ext[1] ? 2 : ext[1] > ext[0] && ext[1] > ext[2] ? 1 : 0;
  const t = clampToTime(own[axis], bounds.min[axis], bounds.max[axis], p.use_cyclic);
  return withTranslation(m, transformPoint(matrix, path.sample(t).position));
}
