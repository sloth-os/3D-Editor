import type { Mat4, Quat, Vec3 } from '../math/types';
import { axisAngle4, determinant4, fromQuat4, identity4, invert4, multiply4 } from '../math/mat4';
import { slerpQuat } from '../math/quat';
import { cross3, dot3, length3, normalize3 } from '../math/vec3';

/*
 * Matrix helpers used by the constraint solvers. Matrices are column-major Mat4 (three.js layout):
 * column `c` (an axis vector, or the translation for c = 3) occupies m[c*4 .. c*4+2] and element
 * (row r, column c) is m[c*4 + r]. Rotation-only helpers work on the upper 3x3 and leave or zero
 * the translation as documented.
 */

/** Euler rotation orders (letters in application order: 'XYZ' applies X first, R = Rz·Ry·Rx). */
export type EulerOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';

/** Axis indices in application order and whether they form an odd permutation of XYZ. */
const ORDER_AXES: Record<EulerOrder, { axes: [number, number, number]; odd: boolean }> = {
  XYZ: { axes: [0, 1, 2], odd: false },
  XZY: { axes: [0, 2, 1], odd: true },
  YXZ: { axes: [1, 0, 2], odd: true },
  YZX: { axes: [1, 2, 0], odd: false },
  ZXY: { axes: [2, 0, 1], odd: false },
  ZYX: { axes: [2, 1, 0], odd: true },
};

const UNIT_AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Smallest positive normal float32, used where Blender compares against FLT_EPSILON. */
export const FLT_EPSILON = 1.1920929e-7;

/** Axis vector `c` (0 = X, 1 = Y, 2 = Z) or the translation (c = 3) of a matrix. */
export function column(m: Readonly<Mat4>, c: number): Vec3 {
  return [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
}

export function setColumn(m: Mat4, c: number, v: Readonly<Vec3>): void {
  m[c * 4] = v[0];
  m[c * 4 + 1] = v[1];
  m[c * 4 + 2] = v[2];
}

export function translationOf(m: Readonly<Mat4>): Vec3 {
  return [m[12], m[13], m[14]];
}

/** Copy of `m` with its translation replaced. */
export function withTranslation(m: Readonly<Mat4>, t: Readonly<Vec3>): Mat4 {
  const out = m.slice();
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  return out;
}

/** Lengths of the three axis vectors (Blender `mat4_to_size`; always >= 0). */
export function axisLengths(m: Readonly<Mat4>): Vec3 {
  return [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
}

/** Determinant of the upper 3x3 (the volume scale of the transform). */
export function determinant3(m: Readonly<Mat4>): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

export function isFiniteMatrix(m: Readonly<Mat4> | null | undefined): m is Mat4 {
  if (!m || m.length !== 16) return false;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}

/** Upper 3x3 of `m` as a Mat4 with zero translation. */
export function linearPart(m: Readonly<Mat4>): Mat4 {
  const out = m.slice();
  out[12] = out[13] = out[14] = 0;
  out[3] = out[7] = out[11] = 0;
  out[15] = 1;
  return out;
}

/** Copy of `m` whose axis vectors are scaled to unit length (zero axes stay zero). */
export function normalizedAxes(m: Readonly<Mat4>, keepTranslation = true): Mat4 {
  const out = m.slice();
  for (let c = 0; c < 3; c++) {
    const v = normalize3(column(m, c));
    setColumn(out, c, v);
  }
  if (!keepTranslation) out[12] = out[13] = out[14] = 0;
  return out;
}

/** Scales axis vector `c` of `m` in place. */
export function scaleColumn(m: Mat4, c: number, s: number): void {
  m[c * 4] *= s;
  m[c * 4 + 1] *= s;
  m[c * 4 + 2] *= s;
}

/** Transforms a point by `m` (affine; no perspective divide). */
export function transformPoint(m: Readonly<Mat4>, p: Readonly<Vec3>): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Transforms a direction by the upper 3x3 of `m`. */
export function transformVector(m: Readonly<Mat4>, v: Readonly<Vec3>): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

/** Rotation matrix (zero translation) whose columns are the given axis vectors. */
export function matrixFromAxes(x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>): Mat4 {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

/**
 * Inverse that never fails: singular matrices (e.g. a zero scale axis) get their degenerate axes
 * replaced by unit vectors perpendicular to the remaining ones before inverting.
 */
export function invertSafe(m: Readonly<Mat4>): Mat4 {
  const axes = [0, 1, 2].map((c) => column(m, c));
  const lens = axes.map((a) => length3(a));
  const volume = lens[0] * lens[1] * lens[2];
  if (volume > 0 && Math.abs(determinant4(m)) > 1e-12 * volume) return invert4(m);
  const fixed = m.slice();
  const ok = lens.map((l) => l > 1e-12);
  // Rebuild degenerate axes from the healthy ones (keeps the healthy scale and direction).
  const nonZero = [0, 1, 2].filter((c) => ok[c]);
  if (nonZero.length === 0) {
    for (let c = 0; c < 3; c++) setColumn(fixed, c, UNIT_AXES[c]);
  } else if (nonZero.length === 1) {
    const a = normalize3(axes[nonZero[0]]);
    const p = anyPerpendicular(a);
    const q = cross3(a, p);
    const free = [0, 1, 2].filter((c) => !ok[c]);
    // keep a right-handed ordering of the replacement axes
    const ordered = (nonZero[0] + 1) % 3 === free[0] ? [p, q] : [q, p];
    setColumn(fixed, free[0], ordered[0]);
    setColumn(fixed, free[1], ordered[1]);
  } else if (nonZero.length === 2) {
    const c = [0, 1, 2].find((k) => !ok[k])!;
    const n = normalize3(cross3(axes[(c + 1) % 3], axes[(c + 2) % 3]));
    setColumn(fixed, c, length3(n) > 0 ? n : anyPerpendicular(normalize3(axes[(c + 1) % 3])));
  } else {
    // All axes non-zero but coplanar: replace the shortest one by the plane normal.
    const c = lens.indexOf(Math.min(...lens));
    const n = normalize3(cross3(axes[(c + 1) % 3], axes[(c + 2) % 3]));
    setColumn(fixed, c, length3(n) > 0 ? n : UNIT_AXES[c]);
  }
  return Math.abs(determinant4(fixed)) > 1e-24 ? invert4(fixed) : identity4();
}

function anyPerpendicular(n: Readonly<Vec3>): Vec3 {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const other: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize3(cross3(n, other));
}

// ---------------------------------------------------------------- loc / rot / size

/**
 * Splits a matrix into location, rotation axes and per-axis size (Blender's
 * `mat4_to_loc_rot_size`): sizes are axis lengths; when the matrix mirrors (negative
 * determinant) the rotation and all three sizes are negated so `rot` stays a proper rotation.
 * `rot` is not orthogonalised (shear stays in it).
 */
export function decomposeLocRotSize(m: Readonly<Mat4>): { loc: Vec3; rot: Mat4; size: Vec3 } {
  const size = axisLengths(m);
  const rot = identity4();
  for (let c = 0; c < 3; c++) {
    const s = size[c];
    const a = column(m, c);
    setColumn(rot, c, s > 0 ? [a[0] / s, a[1] / s, a[2] / s] : [0, 0, 0]);
  }
  if (determinant3(rot) < 0) {
    for (let i = 0; i < 11; i++) if (i % 4 !== 3) rot[i] = -rot[i];
    size[0] = -size[0];
    size[1] = -size[1];
    size[2] = -size[2];
  }
  return { loc: translationOf(m), rot, size };
}

/** Inverse of `decomposeLocRotSize`: T · R · S. */
export function composeLocRotSize(loc: Readonly<Vec3>, rot: Readonly<Mat4>, size: Readonly<Vec3>): Mat4 {
  const out = linearPart(rot);
  for (let c = 0; c < 3; c++) scaleColumn(out, c, size[c]);
  out[12] = loc[0];
  out[13] = loc[1];
  out[14] = loc[2];
  return out;
}

// ---------------------------------------------------------------- euler angles

/** Rotation matrix from euler angles (`e[0]` is always the X angle) in the given order. */
export function eulerToMatrix(e: Readonly<Vec3>, order: EulerOrder = 'XYZ'): Mat4 {
  const [i, j, k] = ORDER_AXES[order].axes;
  // first axis applied first: R = R_k · R_j · R_i
  return multiply4(
    axisAngle4(UNIT_AXES[k], e[k]),
    multiply4(axisAngle4(UNIT_AXES[j], e[j]), axisAngle4(UNIT_AXES[i], e[i])),
  );
}

/**
 * Gimbal lock threshold of Blender's euler conversions (EULER_HYPOT_EPSILON in Blender 4.1 and
 * later; up to 4.0 it was 16 × FLT_EPSILON, 1.9e-6), which {@link matrixToEuler} and
 * {@link matrixToCompatibleEuler} use as Blender does: when the cosine of the middle angle (Y for
 * 'XYZ') of a rotation with unit axes is at most this (the middle angle is within 0.00215° of
 * ±90°), Blender's mat3_normalized_to_eulO takes only the sum or the difference of the first and
 * last angles from the matrix, as the first angle, and sets the last angle to 0. The matrices of the
 * rotations it returns there are up to twice this off the given ones (7.50e-5 measured on 480,000
 * rotations in the six orders with the cosine between 1e-6 and this).
 */
export const EULER_GIMBAL_LOCK = 0.0000375;

/**
 * Gimbal lock of {@link matrixToStoredEuler}, the euler angles a transform stores: only when the
 * cosine of the middle angle is at most this (the middle angle within 5.7e-12° of ±90°, which
 * rounding of a matrix in exact gimbal lock stays far below) does it set the last angle to 0 as
 * Blender does. The matrix of what it returns is then at most twice this off the given one.
 */
const STORED_GIMBAL_LOCK = 1e-13;

/**
 * Below this cosine of the middle angle (within 0.57° of ±90°) {@link matrixToStoredEuler} reads
 * the difference (middle angle near 90°) or the sum (near −90°) of the first and last angles from
 * the matrix entries that do not shrink with the cosine (see {@link eulerPair}).
 */
const NEAR_GIMBAL_LOCK = 0.01;

/** `a` plus or minus a multiple of 2π, between −π and π. */
function wrapAngle(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

/**
 * Whether a matrix with unit axes is a rotation up to rounding: its axes perpendicular to within
 * 1e-12 (products of rotation matrices stay near 1e-16) and right-handed.
 */
function isRotation(m: Readonly<Mat4>): boolean {
  const c = [0, 1, 2].map((k) => column(m, k));
  return (
    Math.abs(dot3(c[0], c[1])) <= 1e-12 &&
    Math.abs(dot3(c[0], c[2])) <= 1e-12 &&
    Math.abs(dot3(c[1], c[2])) <= 1e-12 &&
    determinant3(m) > 0
  );
}

/**
 * Both euler solutions of a rotation matrix with unit axes (identical in gimbal lock), as Blender's
 * mat3_normalized_to_eulo2 computes them: the first and last angles from the matrix entries that
 * scale with the cosine of the middle angle, and in gimbal lock (cosine at most
 * {@link EULER_GIMBAL_LOCK}) the first from the others, with 0 as the last. Near gimbal lock those
 * entries are small and carry the rounding of the matrix: an error ε in them is an error of
 * ε / cos in the first and last angles, and up to that much in the matrix of the result.
 *
 * With `precise` (the angles a transform stores, {@link matrixToStoredEuler}) and a rotation matrix
 * ({@link isRotation}; Blender's formulas are what define the angles of other matrices), gimbal lock
 * is only a cosine of at most {@link STORED_GIMBAL_LOCK}, and below {@link NEAR_GIMBAL_LOCK} the
 * difference or sum of the first and last angles, which the matrix depends on almost alone there,
 * comes from the entries that do not shrink (the identities below hold for rotations only).
 * Measured on 480,000 rotations for each of nine ranges of the cosine between 1e-17 and 1 (the six
 * orders, angles within ±π, half of the matrices made as products A·Aᵀ·R, whose small entries carry
 * the rounding of the products): the matrix of the result was within 1.7e-15 of the given one for
 * cosines from 1e-13 to 0.01 (Blender's formulas: up to 1.3e-11 just above their threshold, 7.5e-5
 * below it), within 4.5e-14 above 0.01 (Blender's formulas, unchanged there) and within 2.0e-13 in
 * exact gimbal lock, where the last angle is set to 0. Whole turns in the angles add the rounding of
 * the larger angles (up to 3.6e-15 with two turns).
 */
function eulerPair(m: Readonly<Mat4>, order: EulerOrder, precise = false): [Vec3, Vec3] {
  const { axes, odd } = ORDER_AXES[order];
  const [i, j, k] = axes;
  // the matrix in the order's axes (Blender's mat[axes[c]][axes[r]]), for which the formulas below
  // give the angles of the even orders and the negated angles of the odd ones
  const M = (r: number, c: number) => m[axes[c] * 4 + axes[r]];
  const cy = Math.hypot(M(0, 0), M(1, 0));
  const e1: Vec3 = [0, 0, 0];
  const e2: Vec3 = [0, 0, 0];
  // the entries used below only hold for a rotation: of other matrices (sheared ones, mirrors)
  // Blender's formulas read the angles, which is what they are then
  precise &&= isRotation(m);
  const locked = !(cy > (precise ? STORED_GIMBAL_LOCK : EULER_GIMBAL_LOCK));
  if (!locked) {
    e1[i] = Math.atan2(M(2, 1), M(2, 2));
    e1[j] = Math.atan2(-M(2, 0), cy);
    e1[k] = Math.atan2(M(1, 0), M(0, 0));
    e2[i] = Math.atan2(-M(2, 1), -M(2, 2));
    e2[j] = Math.atan2(-M(2, 0), -cy);
    e2[k] = Math.atan2(-M(1, 0), -M(0, 0));
    if (precise && cy < NEAR_GIMBAL_LOCK) {
      // M(0,1) − M(1,2) = (1 + sin b)·sin(a − c), M(1,1) + M(0,2) = (1 + sin b)·cos(a − c),
      // −(M(0,1) + M(1,2)) = (1 − sin b)·sin(a + c), M(1,1) − M(0,2) = (1 − sin b)·cos(a + c)
      const up = M(2, 0) <= 0;
      const combined = up
        ? Math.atan2(M(0, 1) - M(1, 2), M(1, 1) + M(0, 2))
        : Math.atan2(-(M(0, 1) + M(1, 2)), M(1, 1) - M(0, 2));
      for (const e of [e1, e2]) {
        const d = wrapAngle(combined - (up ? e[i] - e[k] : e[i] + e[k])) / 2;
        e[i] += d;
        e[k] += up ? -d : d;
      }
    }
  } else {
    e1[i] = Math.atan2(-M(1, 2), M(1, 1));
    e1[j] = Math.atan2(-M(2, 0), cy);
  }
  if (odd)
    for (let n = 0; n < 3; n++) {
      e1[n] = -e1[n];
      e2[n] = -e2[n];
    }
  if (locked) {
    e1[k] = 0;
    e2[i] = e1[i];
    e2[j] = e1[j];
  }
  return [e1, e2];
}

/**
 * Euler angles of a rotation (axes are normalised first; shear is ignored). Of the two possible
 * solutions the one with the smallest angles is returned, like Blender's `mat4_to_eulO` (also in
 * gimbal lock, see {@link EULER_GIMBAL_LOCK}).
 */
export function matrixToEuler(m: Readonly<Mat4>, order: EulerOrder = 'XYZ'): Vec3 {
  const [e1, e2] = eulerPair(normalizedAxes(m), order);
  const d1 = Math.abs(e1[0]) + Math.abs(e1[1]) + Math.abs(e1[2]);
  const d2 = Math.abs(e2[0]) + Math.abs(e2[1]) + Math.abs(e2[2]);
  return d1 > d2 ? e2 : e1;
}

/**
 * Shifts euler angles by multiples of 2π so they are as close as possible to `old` (avoids
 * flips in animation and constraint results): Blender's compatible_eul as of Blender 3.6. Each
 * angle more than π from its old value moves by the whole turns that bring it closest; then an
 * angle still more than π away while the other two are within π/2 moves by one more turn towards
 * it. (Up to Blender 3.5 those limits were 5.1 for whole turns and 3.2 and 1.6 for the extra turn.)
 */
export function compatibleEuler(e: Readonly<Vec3>, old: Readonly<Vec3>): Vec3 {
  const TWO_PI = Math.PI * 2;
  const out: Vec3 = [e[0], e[1], e[2]];
  const d: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    d[i] = out[i] - old[i];
    if (d[i] > Math.PI) {
      out[i] -= Math.floor(d[i] / TWO_PI + 0.5) * TWO_PI;
      d[i] = out[i] - old[i];
    } else if (d[i] < -Math.PI) {
      out[i] += Math.floor(-d[i] / TWO_PI + 0.5) * TWO_PI;
      d[i] = out[i] - old[i];
    }
  }
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    // an axis that is still more than half a turn away while the others are close is wrapped
    if (Math.abs(d[i]) > Math.PI && Math.abs(d[j]) < Math.PI / 2 && Math.abs(d[k]) < Math.PI / 2)
      out[i] += d[i] > 0 ? -TWO_PI : TWO_PI;
  }
  return out;
}

/**
 * Of the two euler solutions `pair`, each moved by {@link compatibleEuler} towards `old`, the one
 * with the smaller sum of differences to `old` (the first on a tie).
 */
function closestEuler([p1, p2]: [Vec3, Vec3], old: Readonly<Vec3>): Vec3 {
  const e1 = compatibleEuler(p1, old);
  const e2 = compatibleEuler(p2, old);
  const d1 = Math.abs(e1[0] - old[0]) + Math.abs(e1[1] - old[1]) + Math.abs(e1[2] - old[2]);
  const d2 = Math.abs(e2[0] - old[0]) + Math.abs(e2[1] - old[1]) + Math.abs(e2[2] - old[2]);
  return d1 > d2 ? e2 : e1;
}

/**
 * Euler angles of a rotation chosen to be closest to `old`, as Blender's mat3_to_compatible_eulO
 * computes them: the axes are normalised first; of the two solutions, each moved by
 * {@link compatibleEuler} towards `old`, the one with the smaller sum of differences to `old` is
 * returned (the first on a tie); in gimbal lock (see {@link EULER_GIMBAL_LOCK}) the last angle is 0
 * before the compatible turns. Copy Rotation uses it as Blender's does (constraints/copy.ts), and
 * so do the operators that set an object's channels from its evaluated world matrix
 * (worldMatrixToTransform in constraints/bake.ts: Apply Constraint, Apply Visual Transform, Bake
 * Transforms, the rigid body bake and its report) and the copies Array Place and Scatter on Surface
 * make (decomposeCompatible in generate/layout.ts), as Blender's BKE_object_apply_mat4 does. What
 * transforms store comes from {@link matrixToStoredEuler}.
 */
export function matrixToCompatibleEuler(
  m: Readonly<Mat4>,
  old: Readonly<Vec3>,
  order: EulerOrder = 'XYZ',
): Vec3 {
  return closestEuler(eulerPair(normalizedAxes(m), order), old);
}

/**
 * The euler angles a transform stores for a new rotation (Rotate, and the turns of Look At and of
 * Drop to Ground and Snap to Surface with Align to Normal, through SceneDoc.transformObject and
 * scene-tools.ts; the operators that set world matrices through SceneDoc.setWorldMatrix):
 * {@link matrixToCompatibleEuler} computed as precisely as a rotation matrix allows near and in
 * gimbal lock (see {@link eulerPair}). Only in exact gimbal lock (the cosine of the middle angle at
 * most 1e-13) is the last angle set to 0 (before the compatible turns), where Blender does it below
 * a cosine of {@link EULER_GIMBAL_LOCK} (within 0.00215° of ±90°), which leaves its stored rotations
 * up to 7.5e-5 off their matrices. Of other matrices (axes not perpendicular, or mirroring) it
 * reads what Blender's formulas read, as matrixToCompatibleEuler does.
 */
export function matrixToStoredEuler(m: Readonly<Mat4>, old: Readonly<Vec3>, order: EulerOrder = 'XYZ'): Vec3 {
  return closestEuler(eulerPair(normalizedAxes(m), order, true), old);
}

/** T · R(euler) · S with the given euler order. */
export function composeLocEulerSize(
  loc: Readonly<Vec3>,
  euler: Readonly<Vec3>,
  size: Readonly<Vec3>,
  order: EulerOrder = 'XYZ',
): Mat4 {
  return composeLocRotSize(loc, eulerToMatrix(euler, order), size);
}

// ---------------------------------------------------------------- quaternions

/** Unit quaternion [x, y, z, w] of a proper rotation matrix (upper 3x3, unit axes). */
export function quatFromMatrix(m: Readonly<Mat4>): Quat {
  const m00 = m[0];
  const m10 = m[1];
  const m20 = m[2];
  const m01 = m[4];
  const m11 = m[5];
  const m21 = m[6];
  const m02 = m[8];
  const m12 = m[9];
  const m22 = m[10];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(Math.max(0, 1 + m00 - m11 - m22)) * 2 || 1;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(Math.max(0, 1 + m11 - m00 - m22)) * 2 || 1;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(Math.max(0, 1 + m22 - m00 - m11)) * 2 || 1;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rotation axis (unit) and angle (0..π) of a rotation matrix with unit axes. */
export function matrixToAxisAngle(m: Readonly<Mat4>): { axis: Vec3; angle: number } {
  let q = quatFromMatrix(m);
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  const s = Math.hypot(q[0], q[1], q[2]);
  if (s < 1e-12) return { axis: [0, 1, 0], angle: 0 };
  return { axis: [q[0] / s, q[1] / s, q[2] / s], angle: 2 * Math.atan2(s, q[3]) };
}

// ---------------------------------------------------------------- polar decomposition / blending

/** 3x3 helpers on column-major 9-element arrays. */
type M3 = number[];

function m3From(m: Readonly<Mat4>): M3 {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

function m3Det(a: M3): number {
  return (
    a[0] * (a[4] * a[8] - a[7] * a[5]) -
    a[3] * (a[1] * a[8] - a[7] * a[2]) +
    a[6] * (a[1] * a[5] - a[4] * a[2])
  );
}

/** Inverse-transpose of a 3x3 (cofactor matrix / determinant). */
function m3InvTranspose(a: M3, det: number): M3 {
  const id = 1 / det;
  // cofactors C[r][c]; column-major storage of the cofactor matrix == inverse transposed
  return [
    (a[4] * a[8] - a[7] * a[5]) * id,
    -(a[3] * a[8] - a[6] * a[5]) * id,
    (a[3] * a[7] - a[6] * a[4]) * id,
    -(a[1] * a[8] - a[7] * a[2]) * id,
    (a[0] * a[8] - a[6] * a[2]) * id,
    -(a[0] * a[7] - a[6] * a[1]) * id,
    (a[1] * a[5] - a[4] * a[2]) * id,
    -(a[0] * a[5] - a[3] * a[2]) * id,
    (a[0] * a[4] - a[3] * a[1]) * id,
  ];
}

/** a^T · b for 3x3 column-major matrices. */
function m3TransposeMul(a: M3, b: M3): M3 {
  const out = new Array<number>(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++)
      out[c * 3 + r] = a[r * 3] * b[c * 3] + a[r * 3 + 1] * b[c * 3 + 1] + a[r * 3 + 2] * b[c * 3 + 2];
  return out;
}

/** Orthonormal frame from the columns of `a` (largest first), robust to degenerate input. */
function orthonormalFallback(a: M3): M3 {
  const cols: Vec3[] = [0, 1, 2].map((c) => [a[c * 3], a[c * 3 + 1], a[c * 3 + 2]]);
  const order = [0, 1, 2].sort((x, y) => length3(cols[y]) - length3(cols[x]));
  const out: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const first = normalize3(cols[order[0]]);
  out[order[0]] = length3(first) > 0 ? first : [...UNIT_AXES[order[0]]];
  const v = cols[order[1]];
  const proj = dot3(v, out[order[0]]);
  let second = normalize3([
    v[0] - out[order[0]][0] * proj,
    v[1] - out[order[0]][1] * proj,
    v[2] - out[order[0]][2] * proj,
  ]);
  if (length3(second) === 0) second = anyPerpendicular(out[order[0]]);
  out[order[1]] = second;
  const c = order[2];
  out[c] = cross3(out[(c + 1) % 3], out[(c + 2) % 3]);
  return [...out[0], ...out[1], ...out[2]];
}

/**
 * Right polar decomposition of the upper 3x3: M = U · P with U a proper rotation and P the
 * stretch (scale/shear) in U's frame. Mirroring is moved into P (U is flipped when det < 0) so U
 * can always be represented by a quaternion.
 */
export function polarDecompose(m: Readonly<Mat4>): { u: Mat4; p: Mat4 } {
  const a = m3From(m);
  let u = a.slice();
  let det = m3Det(u);
  const scale = Math.max(...a.map(Math.abs));
  if (!(Math.abs(det) > 1e-12 * scale * scale * scale) || !Number.isFinite(det)) {
    u = orthonormalFallback(a);
  } else {
    // scaled Newton iteration U ← (ζU + U^-T/ζ) / 2 converges quadratically to the polar factor
    for (let iter = 0; iter < 40; iter++) {
      const zeta = Math.cbrt(1 / Math.abs(det));
      const it = m3InvTranspose(u, det);
      let diff = 0;
      const next = new Array<number>(9);
      for (let n = 0; n < 9; n++) {
        next[n] = 0.5 * (zeta * u[n] + it[n] / zeta);
        diff = Math.max(diff, Math.abs(next[n] - u[n]));
      }
      u = next;
      det = m3Det(u);
      if (diff < 1e-14 || !Number.isFinite(det) || Math.abs(det) < 1e-300) break;
    }
    if (!u.every(Number.isFinite)) u = orthonormalFallback(a);
  }
  let p = m3TransposeMul(u, a);
  if (m3Det(u) < 0) {
    u = u.map((x) => -x);
    p = p.map((x) => -x);
  }
  const toMat4 = (x: M3): Mat4 => [x[0], x[1], x[2], 0, x[3], x[4], x[5], 0, x[6], x[7], x[8], 0, 0, 0, 0, 1];
  return { u: toMat4(u), p: toMat4(p) };
}

/**
 * Interpolates two transforms (Blender's `interp_m4_m4m4`): location linearly, rotation by
 * quaternion slerp and scale/shear linearly (polar decomposition), so `t = 0` gives `a`, `t = 1`
 * gives `b` and intermediate values never squash the object.
 */
export function blendMatrices(a: Readonly<Mat4>, b: Readonly<Mat4>, t: number): Mat4 {
  if (t <= 0) return a.slice();
  if (t >= 1) return b.slice();
  const pa = polarDecompose(a);
  const pb = polarDecompose(b);
  const q = slerpQuat(quatFromMatrix(pa.u), quatFromMatrix(pb.u), t);
  const p = identity4();
  for (const n of [0, 1, 2, 4, 5, 6, 8, 9, 10]) p[n] = pa.p[n] + (pb.p[n] - pa.p[n]) * t;
  const out = multiply4(fromQuat4(q), p);
  out[12] = a[12] + (b[12] - a[12]) * t;
  out[13] = a[13] + (b[13] - a[13]) * t;
  out[14] = a[14] + (b[14] - a[14]) * t;
  return out;
}

// ---------------------------------------------------------------- shear removal

/**
 * Removes shear while keeping the direction of the primary axis (Blender's
 * `orthogonalize_m4_stable`): the other two axes are projected off the primary one and then
 * rotated symmetrically towards each other until perpendicular. With `normalize` all axes become
 * unit vectors; otherwise lengths are kept (scaled to preserve the area of the sheared pair).
 */
export function orthogonalizeStable(m: Readonly<Mat4>, primary: 0 | 1 | 2, normalize: boolean): Mat4 {
  const out = m.slice();
  const others = primary === 0 ? [1, 2] : primary === 1 ? [0, 2] : [0, 1];
  const v1 = column(m, primary);
  const v2 = column(m, others[0]);
  const v3 = column(m, others[1]);
  const len1Sq = dot3(v1, v1);
  if (len1Sq > 0) {
    const k2 = dot3(v2, v1) / len1Sq;
    const k3 = dot3(v3, v1) / len1Sq;
    for (let n = 0; n < 3; n++) {
      v2[n] -= v1[n] * k2;
      v3[n] -= v1[n] * k3;
    }
    if (normalize) {
      const l = Math.sqrt(len1Sq);
      for (let n = 0; n < 3; n++) v1[n] /= l;
    }
  }
  const len2 = length3(v2);
  const len3 = length3(v3);
  let n2 = normalize3(v2);
  let n3 = normalize3(v3);
  const cosA = dot3(n2, n3);
  const absCos = Math.abs(cosA);
  let r2 = v2;
  let r3 = v3;
  if (absCos > 1e-4 && absCos < 1 - FLT_EPSILON) {
    const angle = Math.acos(cosA);
    const target = angle + (Math.PI / 2 - angle) / 2;
    // rotate n2 within the (n2, n3) plane to `target` radians from n3 …
    const perp = normalize3([n2[0] - n3[0] * cosA, n2[1] - n3[1] * cosA, n2[2] - n3[2] * cosA]);
    n2 = [
      perp[0] * Math.sin(target) + n3[0] * Math.cos(target),
      perp[1] * Math.sin(target) + n3[1] * Math.cos(target),
      perp[2] * Math.sin(target) + n3[2] * Math.cos(target),
    ];
    // … and make n3 perpendicular to it within the same plane
    n3 = normalize3(cross3(cross3(n2, n3), n2));
    if (!normalize) {
      const f = Math.sqrt(Math.sin(angle));
      r2 = [n2[0] * len2 * f, n2[1] * len2 * f, n2[2] * len2 * f];
      r3 = [n3[0] * len3 * f, n3[1] * len3 * f, n3[2] * len3 * f];
    }
  }
  if (normalize) {
    r2 = n2;
    r3 = n3;
  }
  setColumn(out, primary, v1);
  setColumn(out, others[0], r2);
  setColumn(out, others[1], r3);
  return out;
}
