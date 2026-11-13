import type { Mat4, Quat, Vec3 } from '../math/types';
import { axisAngle4, fromQuat4, identity4, multiply4, translation4 } from '../math/mat4';
import { normalizeQuat, slerpQuat } from '../math/quat';

/*
 * Bone math in Blender's conventions. A bone's rest frame has its origin at the head and its +Y
 * axis pointing from head to tail; the X/Z axes come from the shortest rotation taking +Y onto
 * the bone direction, followed by `roll` radians about the bone's own Y axis (right-handed).
 * Matrices are column-major (three.js layout).
 */

/** Numeric thresholds for bones pointing (almost) straight down -Y, where the roll is undefined. */
const NEG_Y_THETA = 6.1e-3;
const NEG_Y_XZ_SQ = 2.5e-4 * 2.5e-4;

/** Rotation (in a 4x4 matrix) taking +Y onto the unit vector `d` along the shortest arc. */
export function alignYToVector(d: Readonly<Vec3>): Mat4 {
  const [x, y, z] = d;
  const xz = x * x + z * z;
  if (1 + y <= NEG_Y_THETA && xz <= NEG_Y_XZ_SQ) {
    // Pointing down -Y: any half turn works; use the one about Z (X and Y flip, Z stays).
    return [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  // (1 + y), evaluated without cancellation when y is close to -1 (d is unit length).
  const den = y >= 0 ? 1 + y : xz / (1 + Math.sqrt(Math.max(0, 1 - xz)));
  const r00 = 1 - (x * x) / den;
  const r22 = 1 - (z * z) / den;
  const r02 = (-x * z) / den;
  // columns: X = (r00, -x, r02), Y = d, Z = (r02, -z, r22)
  return [r00, -x, r02, 0, x, y, z, 0, r02, -z, r22, 0, 0, 0, 0, 1];
}

function normalized(v: Readonly<Vec3>): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/** Bone rotation for a (unit) direction and roll: shortest arc from +Y, then `roll` about Y. */
export function boneRotation(dir: Readonly<Vec3>, roll: number): Mat4 {
  const b = alignYToVector(dir);
  if (!roll) return b;
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  // R = B · RotY(roll): X' = c·X − s·Z, Z' = s·X + c·Z
  const out = b.slice();
  for (let k = 0; k < 3; k++) {
    out[k] = c * b[k] - s * b[8 + k];
    out[8 + k] = s * b[k] + c * b[8 + k];
  }
  return out;
}

/**
 * Rest matrix of a bone in armature space (origin at the head, +Y towards the tail). Degenerate
 * (zero-length) bones use `fallbackDir` (default +Y) as their direction.
 */
export function boneRestMatrix(
  head: Readonly<Vec3>,
  tail: Readonly<Vec3>,
  roll: number,
  fallbackDir: Readonly<Vec3> = [0, 1, 0],
): { matrix: Mat4; length: number } {
  const v: Vec3 = [tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]];
  const length = Math.hypot(v[0], v[1], v[2]);
  const dir = (length > 1e-9 ? normalized(v) : null) ?? normalized(fallbackDir) ?? [0, 1, 0];
  const m = boneRotation(dir, Number.isFinite(roll) ? roll : 0);
  m[12] = head[0];
  m[13] = head[1];
  m[14] = head[2];
  return { matrix: m, length: Number.isFinite(length) ? length : 0 };
}

/**
 * Roll (radians) that makes the local Z axis of a bone from `head` to `tail` point as close as
 * possible to `axis` (like Blender's `EditBone.align_roll`). Returns 0 for degenerate input.
 */
export function rollFromZAxis(head: Readonly<Vec3>, tail: Readonly<Vec3>, axis: Readonly<Vec3>): number {
  const d = normalized([tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]]);
  if (!d) return 0;
  const dot = axis[0] * d[0] + axis[1] * d[1] + axis[2] * d[2];
  const perp: Vec3 = [axis[0] - d[0] * dot, axis[1] - d[1] * dot, axis[2] - d[2] * dot];
  if (!normalized(perp)) return 0;
  const b = alignYToVector(d);
  const px = perp[0] * b[0] + perp[1] * b[1] + perp[2] * b[2];
  const pz = perp[0] * b[8] + perp[1] * b[9] + perp[2] * b[10];
  return Math.atan2(px, pz);
}

/** Roll of a bone whose rest rotation is the (orthonormal) rotation part of `m` (inverse of boneRotation). */
export function rollFromMatrix(m: Readonly<Mat4>): number {
  const d = normalized([m[4], m[5], m[6]]);
  if (!d) return 0;
  const b = alignYToVector(d);
  const cos = m[0] * b[0] + m[1] * b[1] + m[2] * b[2];
  const sin = -(m[0] * b[8] + m[1] * b[9] + m[2] * b[10]);
  return Math.atan2(sin, cos);
}

// ------------------------------------------------------------------ decomposition / blending

/** Orthonormal rotation (proper, det +1) of an affine matrix, prioritising its Y axis (bone axis). */
export function rotationPart(m: Readonly<Mat4>): Mat4 {
  let y = normalized([m[4], m[5], m[6]]);
  let z = normalized([m[8], m[9], m[10]]);
  if (!y) y = [0, 1, 0];
  if (z) {
    const d = z[0] * y[0] + z[1] * y[1] + z[2] * y[2];
    z = normalized([z[0] - y[0] * d, z[1] - y[1] * d, z[2] - y[2] * d]);
  }
  if (!z) {
    // derive Z from X when Z is degenerate (or parallel to Y)
    const x0 = normalized([m[0], m[1], m[2]]) ?? anyPerpendicular(y);
    z = normalized(cross(x0, y)) ?? normalized(cross(anyPerpendicular(y), y))!;
  }
  const x = cross(y, z);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function anyPerpendicular(v: Readonly<Vec3>): Vec3 {
  const a = Math.abs(v[0]) < 0.9 ? ([1, 0, 0] as Vec3) : ([0, 1, 0] as Vec3);
  return normalized(cross(v, a)) ?? [0, 0, 1];
}

/** Unit quaternion [x, y, z, w] of a pure rotation matrix (column-major). */
export function quatFromRotationMatrix(m: Readonly<Mat4>): Quat {
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
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return normalizeQuat(q);
}

export interface TRS {
  location: Vec3;
  /** Proper rotation as a quaternion [x, y, z, w]. */
  rotation: Quat;
  /** Per-axis scale (X negative for mirrored matrices). */
  scale: Vec3;
}

/** Splits an affine matrix into translation, rotation and per-axis scale (shear is dropped). */
export function decomposeTRS(m: Readonly<Mat4>): TRS {
  const r = rotationPart(m);
  const sx = m[0] * r[0] + m[1] * r[1] + m[2] * r[2];
  const sy = m[4] * r[4] + m[5] * r[5] + m[6] * r[6];
  const sz = m[8] * r[8] + m[9] * r[9] + m[10] * r[10];
  return { location: [m[12], m[13], m[14]], rotation: quatFromRotationMatrix(r), scale: [sx, sy, sz] };
}

export function composeTRS(t: TRS): Mat4 {
  const m = fromQuat4(t.rotation);
  for (let k = 0; k < 3; k++) {
    m[k] *= t.scale[0];
    m[4 + k] *= t.scale[1];
    m[8 + k] *= t.scale[2];
  }
  m[12] = t.location[0];
  m[13] = t.location[1];
  m[14] = t.location[2];
  return m;
}

/** Interpolates two affine matrices (lerp translation/scale, slerp rotation); t=0 → a, t=1 → b. */
export function blendMatrices(a: Readonly<Mat4>, b: Readonly<Mat4>, t: number): Mat4 {
  if (t <= 0) return a.slice();
  if (t >= 1) return b.slice();
  const da = decomposeTRS(a);
  const db = decomposeTRS(b);
  const lerp = (x: Vec3, y: Vec3): Vec3 => [
    x[0] + (y[0] - x[0]) * t,
    x[1] + (y[1] - x[1]) * t,
    x[2] + (y[2] - x[2]) * t,
  ];
  return composeTRS({
    location: lerp(da.location, db.location),
    rotation: slerpQuat(da.rotation, db.rotation, t),
    scale: lerp(da.scale, db.scale),
  });
}

/**
 * Shortest rotation (4x4, no translation) turning direction `from` towards `to`, scaled by
 * `amount` (0..1). Identity for degenerate input; a half turn about a perpendicular axis when
 * the directions are opposite.
 */
export function rotationBetween(from: Readonly<Vec3>, to: Readonly<Vec3>, amount = 1): Mat4 {
  const a = normalized(from);
  const b = normalized(to);
  if (!a || !b || amount === 0) return identity4();
  const c = cross(a, b);
  const sin = Math.hypot(c[0], c[1], c[2]);
  const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (sin < 1e-12) {
    if (cos > 0) return identity4();
    return axisAngle4(anyPerpendicular(a), Math.PI * amount);
  }
  return axisAngle4([c[0] / sin, c[1] / sin, c[2] / sin], Math.atan2(sin, cos) * amount);
}

/** Applies a rotation `r` (no translation) to matrix `m` about the point `pivot`: T(p)·R·T(−p)·M. */
export function rotateAbout(m: Readonly<Mat4>, r: Readonly<Mat4>, pivot: Readonly<Vec3>): Mat4 {
  const pr = multiply4(translation4(pivot), r);
  return multiply4(multiply4(pr, translation4([-pivot[0], -pivot[1], -pivot[2]])), m);
}

/** Origin (translation) of a matrix. */
export function originOf(m: Readonly<Mat4>): Vec3 {
  return [m[12], m[13], m[14]];
}

/** Point `len` units along the matrix's Y axis from its origin (a bone's tail). */
export function tailOf(m: Readonly<Mat4>, len: number): Vec3 {
  return [m[12] + m[4] * len, m[13] + m[5] * len, m[14] + m[6] * len];
}

/** Inverse of a rigid transform (rotation + translation, orthonormal 3x3). */
export function invertRigid(m: Readonly<Mat4>): Mat4 {
  const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  out[12] = -(out[0] * m[12] + out[4] * m[13] + out[8] * m[14]);
  out[13] = -(out[1] * m[12] + out[5] * m[13] + out[9] * m[14]);
  out[14] = -(out[2] * m[12] + out[6] * m[13] + out[10] * m[14]);
  return out;
}

/** True when every element is a finite number. */
export function isFiniteMatrix(m: Readonly<Mat4>): boolean {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}
