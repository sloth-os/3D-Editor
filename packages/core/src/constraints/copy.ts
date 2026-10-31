import type { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { multiply4 } from '../math/mat4';
import type {
  copyLocationSchema,
  copyRotationSchema,
  copyScaleSchema,
  copyTransformsSchema,
} from './schemas';
import type { ConstraintEulerOrder } from './schemas';
import {
  axisLengths,
  compatibleEuler,
  composeLocRotSize,
  decomposeLocRotSize,
  determinant3,
  eulerToMatrix,
  matrixToCompatibleEuler,
  matrixToEuler,
  orthogonalizeStable,
  scaleColumn,
  transformPoint,
  translationOf,
  withTranslation,
  type EulerOrder,
} from './math';
import type { SolveEnv } from './targets';

/** Euler order of a constraint (`AUTO` = the owner's order; objects always use XYZ here). */
export function resolveEulerOrder(order: ConstraintEulerOrder): EulerOrder {
  return order === 'AUTO' ? 'XYZ' : order;
}

export function solveCopyLocation(m: Mat4, p: z.infer<typeof copyLocationSchema>, env: SolveEnv): Mat4 {
  const t = translationOf(env.target(p.target_space, p.head_tail));
  const loc = translationOf(m);
  const offset: Vec3 = p.use_offset ? [loc[0], loc[1], loc[2]] : [0, 0, 0];
  const use = [p.use_x, p.use_y, p.use_z];
  const invert = [p.invert_x, p.invert_y, p.invert_z];
  for (let i = 0; i < 3; i++) if (use[i]) loc[i] = (invert[i] ? -t[i] : t[i]) + offset[i];
  return withTranslation(m, loc);
}

/** Euler `e` rotated by `angle` around one of its own axes (Blender's `rotate_eulO`). */
function rotateEuler(e: Vec3, order: EulerOrder, axis: number, angle: number): Vec3 {
  const delta: Vec3 = [0, 0, 0];
  delta[axis] = angle;
  return matrixToEuler(multiply4(eulerToMatrix(e, order), eulerToMatrix(delta, order)), order);
}

export function solveCopyRotation(m: Mat4, p: z.infer<typeof copyRotationSchema>, env: SolveEnv): Mat4 {
  const target = env.target(p.target_space, 0);
  const order = resolveEulerOrder(p.euler_order);
  const { loc, rot: oldRot, size } = decomposeLocRotSize(m);
  const ownEuler = matrixToEuler(m, order);
  // euler math does not cope with shear: use the target's orthogonalised rotation
  let eul = matrixToCompatibleEuler(orthogonalizeStable(target, 1, true), ownEuler, order);
  const legacyOffset = p.mix_mode === 'OFFSET';
  const fallback: Vec3 = p.mix_mode === 'REPLACE' || legacyOffset ? ownEuler : [0, 0, 0];
  const use = [p.use_x, p.use_y, p.use_z];
  const invert = [p.invert_x, p.invert_y, p.invert_z];
  for (let i = 0; i < 3; i++) {
    if (!use[i]) {
      eul[i] = fallback[i];
      continue;
    }
    if (legacyOffset) eul = rotateEuler(eul, order, i, ownEuler[i]);
    if (invert[i]) eul[i] = -eul[i];
  }
  if (p.mix_mode === 'ADD') eul = [eul[0] + ownEuler[0], eul[1] + ownEuler[1], eul[2] + ownEuler[2]];
  eul = compatibleEuler(eul, ownEuler);
  let rot = eulerToMatrix(eul, order);
  if (p.mix_mode === 'BEFORE') rot = multiply4(rot, oldRot);
  else if (p.mix_mode === 'AFTER') rot = multiply4(oldRot, rot);
  return composeLocRotSize(loc, rot, size);
}

export function solveCopyScale(m: Mat4, p: z.infer<typeof copyScaleSchema>, env: SolveEnv): Mat4 {
  const target = env.target(p.target_space, 0);
  const own = axisLengths(m);
  const use = [p.use_x, p.use_y, p.use_z];
  let size: Vec3;
  if (p.use_make_uniform) {
    // one uniform factor carrying the copied change in volume
    let total = 1;
    if (use.every(Boolean)) total = Math.abs(determinant3(target));
    else {
      const ts = axisLengths(target);
      for (let i = 0; i < 3; i++) if (use[i]) total *= ts[i];
    }
    const u = Math.cbrt(total);
    size = [u, u, u];
  } else size = axisLengths(target);
  size = size.map((s) => Math.pow(s, p.power)) as Vec3;
  if (p.use_offset) {
    // scale is multiplicative; the additive mode only exists for 2.7x compatibility
    size = (p.use_add ? size.map((s, i) => s + own[i] - 1) : size.map((s, i) => s * own[i])) as Vec3;
  }
  const out = m.slice();
  for (let i = 0; i < 3; i++)
    if ((use[i] || p.use_make_uniform) && own[i] !== 0) scaleColumn(out, i, size[i] / own[i]);
  return out;
}

/** a ∘ b treating location fully but rotation and scale as separate channels ("Aligned"). */
function mulAligned(a: Mat4, b: Mat4): Mat4 {
  const A = decomposeLocRotSize(a);
  const B = decomposeLocRotSize(b);
  return composeLocRotSize(transformPoint(a, B.loc), multiply4(A.rot, B.rot), [
    A.size[0] * B.size[0],
    A.size[1] * B.size[1],
    A.size[2] * B.size[2],
  ]);
}

/** a ∘ b combining location, rotation and scale independently ("Split Channels"). */
function mulSplit(a: Mat4, b: Mat4): Mat4 {
  const A = decomposeLocRotSize(a);
  const B = decomposeLocRotSize(b);
  return composeLocRotSize(
    [A.loc[0] + B.loc[0], A.loc[1] + B.loc[1], A.loc[2] + B.loc[2]],
    multiply4(A.rot, B.rot),
    [A.size[0] * B.size[0], A.size[1] * B.size[1], A.size[2] * B.size[2]],
  );
}

export function solveCopyTransforms(m: Mat4, p: z.infer<typeof copyTransformsSchema>, env: SolveEnv): Mat4 {
  let t = env.target(p.target_space, p.head_tail);
  if (p.remove_target_shear) t = orthogonalizeStable(t, 1, false);
  switch (p.mix_mode) {
    case 'BEFORE_FULL':
      return multiply4(t, m);
    case 'AFTER_FULL':
      return multiply4(m, t);
    case 'BEFORE':
      return mulAligned(t, m);
    case 'AFTER':
      return mulAligned(m, t);
    case 'BEFORE_SPLIT':
      return mulSplit(t, m);
    case 'AFTER_SPLIT':
      return mulSplit(m, t);
    default:
      return t.slice();
  }
}
