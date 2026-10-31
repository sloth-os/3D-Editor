import type { Mat4, Quat, Vec3 } from '../math/types';

/*
 * Small math helpers for the rigid body engine. Rotations are row-major 3x3 matrices
 * (`m[r * 3 + c]`, world = R · local) and quaternions [x, y, z, w]. Hot loops of the solver use
 * scalar fields instead of these helpers to avoid allocations.
 */

/** Row-major 3x3 matrix. */
export type Mat3 = number[];

export function isFiniteVec(v: ArrayLike<number>): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

export function identity3(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** Rotation matrix of a unit quaternion (written into `out` when given). */
export function quatToMat3(q: Readonly<Quat>, out: Mat3 = new Array<number>(9)): Mat3 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy - wz;
  out[2] = xz + wy;
  out[3] = xy + wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz - wx;
  out[6] = xz - wy;
  out[7] = yz + wx;
  out[8] = 1 - (xx + yy);
  return out;
}

/** Unit quaternion of a rotation matrix (Shepperd's method; robust for all rotations). */
export function mat3ToQuat(m: Readonly<Mat3>): Quat {
  const m00 = m[0];
  const m11 = m[4];
  const m22 = m[8];
  const tr = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[7] - m[5]) / s;
    y = (m[2] - m[6]) / s;
    z = (m[3] - m[1]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m[7] - m[5]) / s;
    x = 0.25 * s;
    y = (m[1] + m[3]) / s;
    z = (m[2] + m[6]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m[2] - m[6]) / s;
    x = (m[1] + m[3]) / s;
    y = 0.25 * s;
    z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m[3] - m[1]) / s;
    x = (m[2] + m[6]) / s;
    y = (m[5] + m[7]) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  // canonical sign (w >= 0) so equal rotations produce identical quaternions
  const sgn = w < 0 ? -1 / l : 1 / l;
  return [x * sgn, y * sgn, z * sgn, w * sgn];
}

export function mulMat3(a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
}

export function transpose3(m: Readonly<Mat3>): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mulMat3Vec(m: Readonly<Mat3>, v: Readonly<Vec3>): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Rᵀ · v (inverse rotation). */
export function mulMat3TVec(m: Readonly<Mat3>, v: Readonly<Vec3>): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function determinant3(m: Readonly<Mat3>): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Inverse of a 3x3 matrix, or null when it is (nearly) singular. */
export function invert3(m: Readonly<Mat3>): Mat3 | null {
  const c00 = m[4] * m[8] - m[5] * m[7];
  const c01 = m[5] * m[6] - m[3] * m[8];
  const c02 = m[3] * m[7] - m[4] * m[6];
  const det = m[0] * c00 + m[1] * c01 + m[2] * c02;
  const scale = Math.max(...m.map(Math.abs));
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-30 * Math.max(1e-300, scale * scale * scale)) return null;
  const id = 1 / det;
  return [
    c00 * id,
    (m[2] * m[7] - m[1] * m[8]) * id,
    (m[1] * m[5] - m[2] * m[4]) * id,
    c01 * id,
    (m[0] * m[8] - m[2] * m[6]) * id,
    (m[2] * m[3] - m[0] * m[5]) * id,
    c02 * id,
    (m[1] * m[6] - m[0] * m[7]) * id,
    (m[0] * m[4] - m[1] * m[3]) * id,
  ];
}

/** R · D · Rᵀ for a symmetric local tensor `d` (world-space inertia from a local one). */
export function rotateTensor(r: Readonly<Mat3>, d: Readonly<Mat3>, out: Mat3 = new Array<number>(9)): Mat3 {
  // t = R · D
  const t0 = r[0] * d[0] + r[1] * d[3] + r[2] * d[6];
  const t1 = r[0] * d[1] + r[1] * d[4] + r[2] * d[7];
  const t2 = r[0] * d[2] + r[1] * d[5] + r[2] * d[8];
  const t3 = r[3] * d[0] + r[4] * d[3] + r[5] * d[6];
  const t4 = r[3] * d[1] + r[4] * d[4] + r[5] * d[7];
  const t5 = r[3] * d[2] + r[4] * d[5] + r[5] * d[8];
  const t6 = r[6] * d[0] + r[7] * d[3] + r[8] * d[6];
  const t7 = r[6] * d[1] + r[7] * d[4] + r[8] * d[7];
  const t8 = r[6] * d[2] + r[7] * d[5] + r[8] * d[8];
  // out = t · Rᵀ
  out[0] = t0 * r[0] + t1 * r[1] + t2 * r[2];
  out[1] = t0 * r[3] + t1 * r[4] + t2 * r[5];
  out[2] = t0 * r[6] + t1 * r[7] + t2 * r[8];
  out[3] = t3 * r[0] + t4 * r[1] + t5 * r[2];
  out[4] = t3 * r[3] + t4 * r[4] + t5 * r[5];
  out[5] = t3 * r[6] + t4 * r[7] + t5 * r[8];
  out[6] = t6 * r[0] + t7 * r[1] + t8 * r[2];
  out[7] = t6 * r[3] + t7 * r[4] + t8 * r[5];
  out[8] = t6 * r[6] + t7 * r[7] + t8 * r[8];
  return out;
}

/** Normalized quaternion; identity for degenerate input. */
export function normalizeQ(q: Readonly<Quat>): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 1e-12) || !Number.isFinite(l)) return [0, 0, 0, 1];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Hamilton product a · b. */
export function mulQ(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function conjugateQ(q: Readonly<Quat>): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Normalized linear interpolation along the shortest arc (good enough for small steps). */
export function nlerpQ(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  return normalizeQ([
    a[0] + (s * b[0] - a[0]) * t,
    a[1] + (s * b[1] - a[1]) * t,
    a[2] + (s * b[2] - a[2]) * t,
    a[3] + (s * b[3] - a[3]) * t,
  ]);
}

/** Spherical interpolation along the shortest arc. */
export function slerpQ(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) return nlerpQ(a, [bx, by, bz, bw], t);
  const omega = Math.acos(Math.min(1, cos));
  const sin = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / sin;
  const s1 = Math.sin(t * omega) / sin;
  return normalizeQ([s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw]);
}

/**
 * Angular velocity (rad/s, world space) that rotates `from` into `to` in `dt` seconds along the
 * shortest arc.
 */
export function angularVelocityBetween(from: Readonly<Quat>, to: Readonly<Quat>, dt: number): Vec3 {
  let d = mulQ(to, conjugateQ(from));
  if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const s = Math.hypot(d[0], d[1], d[2]);
  if (s < 1e-12 || !(dt > 0)) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, d[3]);
  const k = angle / (s * dt);
  return [d[0] * k, d[1] * k, d[2] * k];
}

/**
 * Splits an affine world matrix into translation, a proper rotation (det +1) and per-axis scale
 * (negative X scale for mirrored matrices, like `decompose4`). Shear is discarded by
 * re-orthonormalising the rotation. Zero-length axes are rebuilt from the others.
 */
export function decomposeRigid(m: Readonly<Mat4>): { position: Vec3; rotation: Mat3; scale: Vec3 } {
  const c0: Vec3 = [m[0], m[1], m[2]];
  const c1: Vec3 = [m[4], m[5], m[6]];
  const c2: Vec3 = [m[8], m[9], m[10]];
  let sx = Math.hypot(c0[0], c0[1], c0[2]);
  const sy = Math.hypot(c1[0], c1[1], c1[2]);
  const sz = Math.hypot(c2[0], c2[1], c2[2]);
  const det =
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  if (det < 0) sx = -sx;
  const unit = (v: Vec3, l: number): Vec3 | null =>
    Math.abs(l) > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  let x = unit(c0, sx);
  let y = unit(c1, sy);
  let z = unit(c2, sz);
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (v: Vec3): Vec3 | null => unit(v, Math.hypot(v[0], v[1], v[2]));
  // rebuild missing axes (flat / collapsed objects)
  if (!x && y && z) x = norm(cross(y, z));
  if (!y && z && x) y = norm(cross(z, x));
  if (!z && x && y) z = norm(cross(x, y));
  if (!x || !y || !z) {
    const known = x ?? y ?? z;
    if (!known) {
      x = [1, 0, 0];
      y = [0, 1, 0];
      z = [0, 0, 1];
    } else {
      const helper: Vec3 = Math.abs(known[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const a = norm(cross(known, helper))!;
      const b = cross(known, a);
      if (x) {
        y = a;
        z = b;
      } else if (y) {
        z = a;
        x = b;
      } else {
        x = a;
        y = b;
      }
    }
  }
  // Gram-Schmidt (removes shear), keeping X then Y as primary axes
  x = norm(x!) ?? [1, 0, 0];
  const dy = y![0] * x[0] + y![1] * x[1] + y![2] * x[2];
  y = norm([y![0] - dy * x[0], y![1] - dy * x[1], y![2] - dy * x[2]]) ?? norm(cross(z!, x)) ?? [0, 1, 0];
  z = cross(x, y);
  const rotation: Mat3 = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  const fix = (s: number) => (Number.isFinite(s) ? s : 1);
  return { position: [m[12], m[13], m[14]], rotation, scale: [fix(sx), fix(sy), fix(sz)] };
}

/** Column-major world matrix T(position) · R · S. */
export function composeRigid(position: Readonly<Vec3>, rotation: Readonly<Mat3>, scale: Readonly<Vec3>): Mat4 {
  const r = rotation;
  return [
    r[0] * scale[0],
    r[3] * scale[0],
    r[6] * scale[0],
    0,
    r[1] * scale[1],
    r[4] * scale[1],
    r[7] * scale[1],
    0,
    r[2] * scale[2],
    r[5] * scale[2],
    r[8] * scale[2],
    0,
    position[0],
    position[1],
    position[2],
    1,
  ];
}

/** A unit vector perpendicular to the unit vector n, chosen deterministically. */
export function perpendicular(nx: number, ny: number, nz: number): Vec3 {
  // Bullet's btPlaneSpace1 style: avoid the dominant axis
  if (Math.abs(nz) > Math.SQRT1_2) {
    const k = 1 / Math.sqrt(ny * ny + nz * nz);
    return [0, -nz * k, ny * k];
  }
  const k = 1 / Math.sqrt(nx * nx + ny * ny);
  return [-ny * k, nx * k, 0];
}

/** Deterministic, roughly uniform unit directions on the sphere (spherical Fibonacci lattice). */
export function sphereDirections(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const a = golden * i;
    out.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  return out;
}
