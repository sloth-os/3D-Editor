import type { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { axisAngle4, identity4, multiply4 } from '../math/mat4';
import { cross3, dot3, length3, normalize3, sub3 } from '../math/vec3';
import type {
  dampedTrackSchema,
  lockedTrackSchema,
  trackToSchema,
  LockAxis,
  TrackAxis,
  UpAxis,
} from './schemas';
import {
  FLT_EPSILON,
  axisLengths,
  column,
  determinant3,
  invertSafe,
  linearPart,
  normalizedAxes,
  scaleColumn,
  setColumn,
  transformVector,
  translationOf,
  withTranslation,
} from './math';
import { ConstraintSolveError, type SolveEnv } from './targets';

/** Signed axis index of a track axis: 0..2 = +X/+Y/+Z, 3..5 = -X/-Y/-Z (Blender's TRACK_* order). */
export const TRACK_INDEX: Record<TrackAxis, number> = {
  TRACK_X: 0,
  TRACK_Y: 1,
  TRACK_Z: 2,
  TRACK_NEGATIVE_X: 3,
  TRACK_NEGATIVE_Y: 4,
  TRACK_NEGATIVE_Z: 5,
};
export const UP_INDEX: Record<UpAxis, number> = { UP_X: 0, UP_Y: 1, UP_Z: 2 };
const LOCK_INDEX: Record<LockAxis, number> = { LOCK_X: 0, LOCK_Y: 1, LOCK_Z: 2 };

/** Unit vectors of the signed axes (same indexing as TRACK_INDEX). */
export const SIGNED_AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];

/** Fills in the third axis of a frame so it is right handed: col[c] = col[c+1] × col[c+2]. */
export function completeFrame(m: Mat4, missing: number): void {
  setColumn(m, missing, cross3(column(m, (missing + 1) % 3), column(m, (missing + 2) % 3)));
}

/**
 * Rotation of Track To (Blender's `vectomat`): `away` is the vector from the target to the owner.
 * The tracking axis gets the direction to the target (or away from it for negative axes), the
 * up axis the projection of `up` onto the plane perpendicular to it.
 */
export function trackToRotation(
  away: Readonly<Vec3>,
  up: Readonly<Vec3>,
  track: number,
  upAxis: number,
): Mat4 {
  let n = normalize3(away);
  if (length3(n) === 0) n = [0, 0, 1];
  let axis = track;
  if (axis > 2) axis -= 3;
  else n = [-n[0], -n[1], -n[2]];
  const out = identity4();
  if (axis === upAxis) return out;
  const d = dot3(up, n);
  let proj = normalize3([up[0] - n[0] * d, up[1] - n[1] * d, up[2] - n[2] * d]);
  if (length3(proj) === 0) proj = [0, 1, 0];
  setColumn(out, upAxis, proj);
  setColumn(out, axis, n);
  completeFrame(out, 3 - axis - upAxis);
  return out;
}

export function solveTrackTo(m: Mat4, p: z.infer<typeof trackToSchema>, env: SolveEnv): Mat4 {
  const track = TRACK_INDEX[p.track_axis];
  const up = UP_INDEX[p.up_axis];
  if (track % 3 === up) throw new ConstraintSolveError('track_axis and up_axis must be different axes');
  const t = env.target(p.target_space, p.head_tail);
  const size = axisLengths(m);
  const upVec: Vec3 = p.use_target_z ? column(t, 2) : [0, 0, 1];
  const out = trackToRotation(sub3(translationOf(m), translationOf(t)), upVec, track, up);
  for (let c = 0; c < 3; c++) scaleColumn(out, c, size[c]);
  return withTranslation(out, translationOf(m));
}

/**
 * Damped Track: rotates `m` by the smallest rotation that makes its `track` axis point along
 * `toTarget` (location is kept).
 */
export function dampedTrackMatrix(m: Mat4, toTarget: Readonly<Vec3>, track: number): Mat4 {
  const tar = normalize3(toTarget);
  if (length3(tar) === 0) return m;
  let ob = normalize3(transformVector(m, SIGNED_AXES[track]));
  if (length3(ob) === 0) ob = SIGNED_AXES[track].slice() as Vec3;
  let axis = cross3(ob, tar);
  let angle = Math.acos(Math.max(-1, Math.min(1, dot3(ob, tar))));
  const norm = length3(axis);
  if (norm < FLT_EPSILON) {
    // parallel: nothing to do; anti-parallel: turn half way around another owner axis
    if (Math.abs(angle) < Math.PI - 0.01) return m;
    angle = Math.PI;
    axis = normalize3(cross3(ob, transformVector(m, SIGNED_AXES[(track + 1) % 6])));
    if (length3(axis) === 0) return m;
  } else {
    // near 0 and π asin is far more precise than acos
    if (norm < 0.1) angle = angle > Math.PI / 2 ? Math.PI - Math.asin(norm) : Math.asin(norm);
    axis = [axis[0] / norm, axis[1] / norm, axis[2] / norm];
  }
  return withTranslation(multiply4(axisAngle4(axis, angle), linearPart(m)), translationOf(m));
}

export function solveDampedTrack(m: Mat4, p: z.infer<typeof dampedTrackSchema>, env: SolveEnv): Mat4 {
  const t = env.target('WORLD', p.head_tail);
  return dampedTrackMatrix(m, sub3(translationOf(t), translationOf(m)), TRACK_INDEX[p.track_axis]);
}

export function solveLockedTrack(m: Mat4, p: z.infer<typeof lockedTrackSchema>, env: SolveEnv): Mat4 {
  const lock = LOCK_INDEX[p.lock_axis];
  const track = TRACK_INDEX[p.track_axis];
  const trackAxis = track % 3;
  if (trackAxis === lock) throw new ConstraintSolveError('track_axis and lock_axis must be different axes');
  const t = env.target('WORLD', p.head_tail);
  const vec = sub3(translationOf(t), translationOf(m));
  const lockVec = column(m, lock);
  const lockLenSq = dot3(lockVec, lockVec);
  // direction to the target projected onto the plane perpendicular to the locked axis
  const k = lockLenSq > 0 ? dot3(vec, lockVec) / lockLenSq : 0;
  let dir = normalize3([vec[0] - lockVec[0] * k, vec[1] - lockVec[1] * k, vec[2] - lockVec[2] * k]);
  if (track > 2) dir = [-dir[0], -dir[1], -dir[2]];
  const frame = identity4();
  setColumn(frame, lock, normalize3(lockVec));
  setColumn(frame, trackAxis, dir);
  completeFrame(frame, 3 - lock - trackAxis);
  // rotate the owner from its current orientation to the new frame (keeps its scale)
  let delta = multiply4(frame, invertSafe(normalizedAxes(linearPart(m))));
  if (determinant3(delta) === 0 || length3(dir) === 0) delta = identity4();
  return withTranslation(multiply4(delta, linearPart(m)), translationOf(m));
}
