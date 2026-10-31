import type { Mat4, Vec3 } from './types';

export const EPSILON = 1e-9;

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}
export function clone3(a: Readonly<Vec3>): Vec3 {
  return [a[0], a[1], a[2]];
}
export function add3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale3(a: Readonly<Vec3>, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function mul3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}
export function addScaled3(a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}
export function negate3(a: Readonly<Vec3>): Vec3 {
  return [-a[0], -a[1], -a[2]];
}
export function dot3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function lengthSq3(a: Readonly<Vec3>): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}
export function length3(a: Readonly<Vec3>): number {
  return Math.sqrt(lengthSq3(a));
}
export function distance3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function distanceSq3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
/** Returns a unit-length copy of `a`; returns the zero vector for degenerate input. */
export function normalize3(a: Readonly<Vec3>): Vec3 {
  const l = length3(a);
  return l > EPSILON ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function lerp3(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function min3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}
export function max3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}
export function equals3(a: Readonly<Vec3>, b: Readonly<Vec3>, eps = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}
/** Transforms a point (w = 1) by a column-major 4x4 matrix, including perspective divide. */
export function transformPoint3(m: Readonly<Mat4>, p: Readonly<Vec3>): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = w !== 0 ? 1 / w : 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw,
  ];
}
/** Transforms a direction (w = 0) by the upper 3x3 part of a matrix (no normalization). */
export function transformDirection3(m: Readonly<Mat4>, d: Readonly<Vec3>): Vec3 {
  const x = d[0];
  const y = d[1];
  const z = d[2];
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}
/** Any unit vector perpendicular to `n`. */
export function anyPerpendicular3(n: Readonly<Vec3>): Vec3 {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const other: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize3(cross3(n, other));
}
