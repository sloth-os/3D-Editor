import type { Mat4 } from '../math/types';
import { determinant4, identity4, invert4 } from '../math/mat4';

/*
 * Small matrix helpers for instancing. 3x3 matrices are column-major `number[9]`; 4x4 matrices are
 * the usual column-major `Mat4`. All helpers are total: degenerate input yields a sensible
 * fallback instead of NaN.
 */

export type Mat3 = number[];

/** Upper-left 3x3 (linear part) of an affine matrix. */
export function linear3(m: Readonly<Mat4>): Mat3 {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

export function det3(a: Readonly<Mat3>): number {
  return (
    a[0] * (a[4] * a[8] - a[7] * a[5]) -
    a[3] * (a[1] * a[8] - a[7] * a[2]) +
    a[6] * (a[1] * a[5] - a[4] * a[2])
  );
}

/** Cofactor matrix cof(A) = det(A)·A⁻ᵀ (defined for singular matrices too). */
export function cofactor3(a: Readonly<Mat3>): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  // columns of A: c0 = (a0,a1,a2), c1 = (a3,a4,a5), c2 = (a6,a7,a8); cof columns: c1×c2, c2×c0, c0×c1
  return [
    a4 * a8 - a5 * a7,
    a5 * a6 - a3 * a8,
    a3 * a7 - a4 * a6,
    a7 * a2 - a8 * a1,
    a8 * a0 - a6 * a2,
    a6 * a1 - a7 * a0,
    a1 * a5 - a2 * a4,
    a2 * a3 - a0 * a5,
    a0 * a4 - a1 * a3,
  ];
}

/**
 * Matrix taking object-space normals to world-space normal directions (sign-corrected cofactor,
 * i.e. proportional to A⁻ᵀ): works for mirrored and even singular (flattened) transforms.
 */
export function normalMatrix3(a: Readonly<Mat3>): Mat3 {
  const c = cofactor3(a);
  return det3(a) < 0 ? c.map((x) => -x) : c;
}

function norm3(x: number, y: number, z: number): [number, number, number] | null {
  const l = Math.hypot(x, y, z);
  return l > 1e-12 && Number.isFinite(l) ? [x / l, y / l, z / l] : null;
}

/**
 * Rotation part (proper orthonormal, column-major 3x3) of a linear map: Gram-Schmidt on the X and Y
 * columns with Z = X × Y. Mirroring is attributed to the X axis like `decompose4`; degenerate
 * columns fall back to the remaining ones (identity when everything is degenerate).
 */
export function rotation3(a: Readonly<Mat3>): Mat3 {
  const flip = det3(a) < 0 ? -1 : 1;
  let x = norm3(a[0] * flip, a[1] * flip, a[2] * flip);
  let y = norm3(a[3], a[4], a[5]);
  const z0 = norm3(a[6], a[7], a[8]);
  if (!x && y && z0)
    x = norm3(y[1] * z0[2] - y[2] * z0[1], y[2] * z0[0] - y[0] * z0[2], y[0] * z0[1] - y[1] * z0[0]);
  if (!x) x = [1, 0, 0];
  if (y) y = norm3(y[0] - x[0] * dot(x, y), y[1] - x[1] * dot(x, y), y[2] - x[2] * dot(x, y));
  if (!y && z0)
    y = norm3(z0[1] * x[2] - z0[2] * x[1], z0[2] * x[0] - z0[0] * x[2], z0[0] * x[1] - z0[1] * x[0]);
  if (!y) {
    const o = Math.abs(x[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t = norm3(o[0] - x[0] * dot(x, o), o[1] - x[1] * dot(x, o), o[2] - x[2] * dot(x, o))!;
    y = t;
  }
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Per-axis scale of a linear map (column lengths; X negative when the map mirrors). */
export function scale3(a: Readonly<Mat3>): [number, number, number] {
  const sx = Math.hypot(a[0], a[1], a[2]);
  return [det3(a) < 0 ? -sx : sx, Math.hypot(a[3], a[4], a[5]), Math.hypot(a[6], a[7], a[8])];
}

/** Embeds a 3x3 linear map into an affine 4x4 with the given translation. */
export function affine4(l: Readonly<Mat3>, tx = 0, ty = 0, tz = 0): Mat4 {
  return [l[0], l[1], l[2], 0, l[3], l[4], l[5], 0, l[6], l[7], l[8], 0, tx, ty, tz, 1];
}

/** Product of two affine 4x4 matrices (the bottom row is assumed to be 0 0 0 1). */
export function mulAffine(a: Readonly<Mat4>, b: Readonly<Mat4>): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 3; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2;
    out[c * 4 + 3] = 0;
  }
  const t0 = b[12];
  const t1 = b[13];
  const t2 = b[14];
  out[12] = a[0] * t0 + a[4] * t1 + a[8] * t2 + a[12];
  out[13] = a[1] * t0 + a[5] * t1 + a[9] * t2 + a[13];
  out[14] = a[2] * t0 + a[6] * t1 + a[10] * t2 + a[14];
  out[15] = 1;
  return out;
}

/** Inverse of an affine matrix, or null when it is singular or not finite. */
export function invertAffine(m: Readonly<Mat4>): Mat4 | null {
  const d = determinant4(m);
  if (!Number.isFinite(d)) return null;
  const scale = Math.max(
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[4], m[5], m[6]),
    Math.hypot(m[8], m[9], m[10]),
    1e-300,
  );
  if (Math.abs(d) <= 1e-12 * scale * scale * scale) return null;
  return invert4(m);
}

/** True when every entry is a finite number. */
export function isFiniteMatrix(m: Readonly<Mat4>): boolean {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}

/** Exact cache key of a matrix (full precision). */
export function matrixKey(m: Readonly<Mat4> | null | undefined): string {
  return m ? m.join(',') : 'none';
}

/** Translation matrix. */
export function translate4(x: number, y: number, z: number): Mat4 {
  const m = identity4();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** True when `m` is (numerically) the identity. */
export function isIdentity4(m: Readonly<Mat4>, eps = 1e-12): boolean {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - id[i]) > eps) return false;
  return true;
}
