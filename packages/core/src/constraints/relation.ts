import type { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { identity4, multiply4 } from '../math/mat4';
import { add3, dot3, sub3 } from '../math/vec3';
import type { childOfSchema, floorSchema, pivotSchema } from './schemas';
import {
  axisLengths,
  composeLocEulerSize,
  invertSafe,
  isFiniteMatrix,
  linearPart,
  matrixToAxisAngle,
  matrixToEuler,
  normalizedAxes,
  transformVector,
  translationOf,
  withTranslation,
} from './math';
import type { SolveEnv } from './targets';

type ChildOfParams = z.infer<typeof childOfSchema>;

const IDENTITY = identity4();

/** The stored inverse matrix (identity when malformed). */
function storedInverse(p: ChildOfParams): Mat4 {
  return isFiniteMatrix(p.inverse_matrix) ? p.inverse_matrix.slice() : IDENTITY.slice();
}

/**
 * Parent and inverse matrices of Child Of with the disabled channels removed: when not every
 * channel is used, both are rebuilt from location / euler / scale with the disabled ones reset.
 */
export function childOfMatrices(target: Mat4, p: ChildOfParams): { parent: Mat4; inverse: Mat4 } {
  const inverse = storedInverse(p);
  const loc = [p.use_location_x, p.use_location_y, p.use_location_z];
  const rot = [p.use_rotation_x, p.use_rotation_y, p.use_rotation_z];
  const scl = [p.use_scale_x, p.use_scale_y, p.use_scale_z];
  if ([...loc, ...rot, ...scl].every(Boolean)) return { parent: target.slice(), inverse };
  const tl = translationOf(target);
  const te = matrixToEuler(target);
  const ts = axisLengths(target);
  const il = translationOf(inverse);
  const ie = matrixToEuler(inverse);
  const is = axisLengths(inverse);
  for (let i = 0; i < 3; i++) {
    if (!loc[i]) tl[i] = il[i] = 0;
    if (!rot[i]) te[i] = ie[i] = 0;
    if (!scl[i]) ts[i] = is[i] = 1;
  }
  return { parent: composeLocEulerSize(tl, te, ts), inverse: composeLocEulerSize(il, ie, is) };
}

/** "Set Inverse": the inverse of the (channel filtered) target matrix, so the owner keeps its place. */
export function childOfInverseMatrix(target: Mat4, p: ChildOfParams): Mat4 {
  return invertSafe(childOfMatrices(target, p).parent);
}

export function solveChildOf(m: Mat4, p: ChildOfParams, env: SolveEnv): Mat4 {
  const { parent, inverse } = childOfMatrices(env.target('WORLD', 0), p);
  const out = multiply4(parent, multiply4(inverse, m));
  // disabled location channels keep the owner's own value (rotation/scale of the parent would
  // otherwise still move it)
  const loc = [p.use_location_x, p.use_location_y, p.use_location_z];
  for (let i = 0; i < 3; i++) if (!loc[i]) out[12 + i] = m[12 + i];
  return out;
}

const FLOOR_AXIS: Record<z.infer<typeof floorSchema>['floor_location'], [number, boolean]> = {
  FLOOR_X: [0, false],
  FLOOR_Y: [1, false],
  FLOOR_Z: [2, false],
  FLOOR_NEGATIVE_X: [0, true],
  FLOOR_NEGATIVE_Y: [1, true],
  FLOOR_NEGATIVE_Z: [2, true],
};

export function solveFloor(m: Mat4, p: z.infer<typeof floorSchema>, env: SolveEnv): Mat4 {
  const target = env.target(p.target_space, 0);
  // with use_rotation the test happens in the target's frame (tilted floor)
  const own = p.use_rotation ? multiply4(invertSafe(target), m) : m.slice();
  const floor = p.use_rotation ? identity4() : target;
  const [axis, negative] = FLOOR_AXIS[p.floor_location];
  const floorValue = floor[12 + axis];
  const ownValue = own[12 + axis] - p.offset;
  const violated = negative ? ownValue > floorValue : floorValue > ownValue;
  if (!violated) return m;
  own[12 + axis] = floorValue + p.offset;
  return p.use_rotation ? multiply4(target, own) : withTranslation(m, translationOf(own));
}

const PIVOT_RANGE: Record<string, [number, boolean]> = {
  NX: [0, true],
  NY: [1, true],
  NZ: [2, true],
  X: [0, false],
  Y: [1, false],
  Z: [2, false],
};

export function solvePivot(m: Mat4, p: z.infer<typeof pivotSchema>, env: SolveEnv): Mat4 {
  const range = PIVOT_RANGE[p.rotation_range];
  if (range) {
    // only pivot while the rotation around the axis is in the chosen half (negative / positive)
    const rot = matrixToEuler(m);
    const [axis, negative] = range;
    if (negative ? rot[axis] > 0 : rot[axis] < 0) return m;
  }
  const loc = translationOf(m);
  const offset: Vec3 = [p.offset[0], p.offset[1], p.offset[2]];
  let pivot: Vec3;
  if (env.hasTarget()) pivot = add3(translationOf(env.target('WORLD', p.head_tail)), offset);
  else pivot = p.use_relative_location ? add3(loc, offset) : offset;
  const rotMat = normalizedAxes(linearPart(m));
  const { axis, angle } = matrixToAxisAngle(rotMat);
  if (angle) {
    // only the pivot's offset perpendicular to the rotation axis matters (else it translates)
    const v = sub3(pivot, loc);
    const d = dot3(v, axis);
    pivot = [pivot[0] - axis[0] * d, pivot[1] - axis[1] * d, pivot[2] - axis[2] * d];
  }
  return withTranslation(m, add3(pivot, transformVector(rotMat, sub3(loc, pivot))));
}
