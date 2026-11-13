import type { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { distance3 } from '../math/vec3';
import type {
  limitDistanceSchema,
  limitLocationSchema,
  limitRotationSchema,
  limitScaleSchema,
} from './schemas';
import {
  FLT_EPSILON,
  axisLengths,
  composeLocEulerSize,
  matrixToEuler,
  orthogonalizeStable,
  scaleColumn,
  translationOf,
  withTranslation,
} from './math';
import { resolveEulerOrder } from './copy';
import type { SolveEnv } from './targets';

type MinMax = {
  use_min_x: boolean;
  use_min_y: boolean;
  use_min_z: boolean;
  use_max_x: boolean;
  use_max_y: boolean;
  use_max_z: boolean;
  min_x: number;
  min_y: number;
  min_z: number;
  max_x: number;
  max_y: number;
  max_z: number;
};

/** Applies the enabled per-axis minimum/maximum limits to `v` (in place). */
function clampAxes(v: Vec3, p: MinMax): void {
  const axes = ['x', 'y', 'z'] as const;
  for (let i = 0; i < 3; i++) {
    const a = axes[i];
    if (p[`use_min_${a}`]) v[i] = Math.max(v[i], p[`min_${a}`]);
    if (p[`use_max_${a}`]) v[i] = Math.min(v[i], p[`max_${a}`]);
  }
}

export function solveLimitLocation(m: Mat4, p: z.infer<typeof limitLocationSchema>): Mat4 {
  const loc = translationOf(m);
  clampAxes(loc, p);
  return withTranslation(m, loc);
}

/** Wraps an angle into [-π, π). */
function wrapAngle(a: number): number {
  const b = a / (2 * Math.PI) + 0.5;
  return (b - Math.floor(b) - 0.5) * 2 * Math.PI;
}

/**
 * Clamps an angle to the directed range [min, max] on the circle (so 350° counts as -10°), which is
 * what Limit Rotation does unless `use_legacy_behavior` is on. Ranges of a full turn or more never
 * clamp; an empty or inverted range returns `min`.
 */
export function clampAngle(angle: number, min: number, max: number): number {
  if (max - min >= 2 * Math.PI) return angle;
  if (max <= min) return min;
  // relative to the angle, wrapped into [-π, π): the angle itself sits at 0
  const lo = wrapAngle(min - angle);
  const hi = wrapAngle(max - angle);
  if (lo < hi) return angle + Math.min(Math.max(0, lo), hi);
  // the range crosses the ±π seam: inside unless 0 lies strictly between hi and lo
  if (hi >= 0 || lo <= 0) return angle;
  return angle + (Math.abs(hi) < Math.abs(lo) ? hi : lo);
}

export function solveLimitRotation(m: Mat4, p: z.infer<typeof limitRotationSchema>): Mat4 {
  // euler limits do not cope with shear; Y is kept as the main axis like Blender (bones)
  const ortho = orthogonalizeStable(m, 1, false);
  const use = [p.use_limit_x, p.use_limit_y, p.use_limit_z];
  if (!use.some(Boolean)) return ortho;
  const order = resolveEulerOrder(p.euler_order);
  const eul = matrixToEuler(ortho, order);
  const min = [p.min_x, p.min_y, p.min_z];
  const max = [p.max_x, p.max_y, p.max_z];
  for (let i = 0; i < 3; i++) {
    if (!use[i]) continue;
    if (p.use_legacy_behavior) eul[i] = eul[i] < min[i] ? min[i] : eul[i] > max[i] ? max[i] : eul[i];
    else eul[i] = clampAngle(eul[i], min[i], max[i]);
  }
  return composeLocEulerSize(translationOf(ortho), eul, axisLengths(ortho), order);
}

export function solveLimitScale(m: Mat4, p: z.infer<typeof limitScaleSchema>): Mat4 {
  const own = axisLengths(m);
  const size: Vec3 = [own[0], own[1], own[2]];
  clampAxes(size, p);
  const out = m.slice();
  for (let i = 0; i < 3; i++) if (own[i] !== 0) scaleColumn(out, i, size[i] / own[i]);
  return out;
}

export function solveLimitDistance(m: Mat4, p: z.infer<typeof limitDistanceSchema>, env: SolveEnv): Mat4 {
  const target = translationOf(env.target(p.target_space, p.head_tail));
  const loc = translationOf(m);
  const dist = distance3(loc, target);
  // 0 = "not initialised yet": Blender adopts the current distance (operators store it)
  const limit = p.distance > 0 ? p.distance : dist;
  const clamp =
    p.limit_mode === 'LIMITDIST_OUTSIDE'
      ? dist <= limit
      : p.limit_mode === 'LIMITDIST_ONSURFACE'
        ? !(Math.abs(dist - limit) < FLT_EPSILON)
        : dist >= limit;
  if (!clamp) return m;
  // move along the line target → owner until the distance matches (an owner sitting exactly on
  // the target has no direction and stays put)
  const s = dist !== 0 ? limit / dist : 1;
  return withTranslation(m, [
    target[0] + (loc[0] - target[0]) * s,
    target[1] + (loc[1] - target[1]) * s,
    target[2] + (loc[2] - target[2]) * s,
  ]);
}
