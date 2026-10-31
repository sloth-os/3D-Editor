import type { Mat4, Quat, Vec3 } from './types';

/*
 * Column-major 4x4 matrices (three.js layout): element (row r, column c) is m[c * 4 + r].
 * Rotations use Blender's Euler 'XYZ' convention: R = Rz · Ry · Rx (X is applied first).
 * In three.js terms this corresponds to Euler order 'ZYX'.
 */

export function identity4(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function clone4(m: Readonly<Mat4>): Mat4 {
  return m.slice();
}

/** Returns a · b. */
export function multiply4(a: Readonly<Mat4>, b: Readonly<Mat4>): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  return out;
}

/** Rotation matrix (3x3 embedded in 4x4) from Blender XYZ Euler angles in radians. */
export function rotationFromEuler(e: Readonly<Vec3>): Mat4 {
  const ca = Math.cos(e[0]);
  const sa = Math.sin(e[0]);
  const cb = Math.cos(e[1]);
  const sb = Math.sin(e[1]);
  const cc = Math.cos(e[2]);
  const sc = Math.sin(e[2]);
  // Row-major entries of Rz·Ry·Rx
  const r00 = cc * cb;
  const r01 = -sc * ca + cc * sb * sa;
  const r02 = sc * sa + cc * sb * ca;
  const r10 = sc * cb;
  const r11 = cc * ca + sc * sb * sa;
  const r12 = -cc * sa + sc * sb * ca;
  const r20 = -sb;
  const r21 = cb * sa;
  const r22 = cb * ca;
  return [r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, 0, 0, 0, 1];
}

/** Composes T · R · S. */
export function compose4(location: Readonly<Vec3>, rotation: Readonly<Vec3>, scale: Readonly<Vec3>): Mat4 {
  const m = rotationFromEuler(rotation);
  m[0] *= scale[0];
  m[1] *= scale[0];
  m[2] *= scale[0];
  m[4] *= scale[1];
  m[5] *= scale[1];
  m[6] *= scale[1];
  m[8] *= scale[2];
  m[9] *= scale[2];
  m[10] *= scale[2];
  m[12] = location[0];
  m[13] = location[1];
  m[14] = location[2];
  return m;
}

/** Extracts Blender XYZ Euler angles from a pure rotation matrix. */
export function eulerFromRotation(m: Readonly<Mat4>): Vec3 {
  const r00 = m[0];
  const r10 = m[1];
  const r20 = m[2];
  const r01 = m[4];
  const r11 = m[5];
  const r21 = m[6];
  const r22 = m[10];
  const y = Math.asin(-Math.max(-1, Math.min(1, r20)));
  if (Math.abs(r20) < 0.9999999) {
    return [Math.atan2(r21, r22), y, Math.atan2(r10, r00)];
  }
  return [Math.atan2(-r20 * r01, r11), y, 0];
}

export function determinant4(m: Readonly<Mat4>): number {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

/** Decomposes an affine matrix into location, Blender XYZ Euler rotation and scale. */
export function decompose4(m: Readonly<Mat4>): { location: Vec3; rotation: Vec3; scale: Vec3 } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (determinant4(m) < 0) sx = -sx;
  const r = identity4();
  const isx = sx !== 0 ? 1 / sx : 0;
  const isy = sy !== 0 ? 1 / sy : 0;
  const isz = sz !== 0 ? 1 / sz : 0;
  r[0] = m[0] * isx;
  r[1] = m[1] * isx;
  r[2] = m[2] * isx;
  r[4] = m[4] * isy;
  r[5] = m[5] * isy;
  r[6] = m[6] * isy;
  r[8] = m[8] * isz;
  r[9] = m[9] * isz;
  r[10] = m[10] * isz;
  return { location: [m[12], m[13], m[14]], rotation: eulerFromRotation(r), scale: [sx, sy, sz] };
}

/** General 4x4 inverse. Returns identity for singular matrices. */
export function invert4(m: Readonly<Mat4>): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity4();
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

export function transpose4(m: Readonly<Mat4>): Mat4 {
  return [
    m[0],
    m[4],
    m[8],
    m[12],
    m[1],
    m[5],
    m[9],
    m[13],
    m[2],
    m[6],
    m[10],
    m[14],
    m[3],
    m[7],
    m[11],
    m[15],
  ];
}

/** Matrix for transforming normals: inverse-transpose of the upper 3x3, returned as a 4x4. */
export function normalMatrix4(m: Readonly<Mat4>): Mat4 {
  const n = transpose4(invert4(m));
  n[3] = n[7] = n[11] = n[12] = n[13] = n[14] = 0;
  n[15] = 1;
  return n;
}

export function translation4(t: Readonly<Vec3>): Mat4 {
  const m = identity4();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}

export function scaling4(s: Readonly<Vec3>): Mat4 {
  const m = identity4();
  m[0] = s[0];
  m[5] = s[1];
  m[10] = s[2];
  return m;
}

/** Rotation matrix from a unit quaternion [x, y, z, w]. */
export function fromQuat4(q: Readonly<Quat>): Mat4 {
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
  return [
    1 - (yy + zz),
    xy + wz,
    xz - wy,
    0,
    xy - wz,
    1 - (xx + zz),
    yz + wx,
    0,
    xz + wy,
    yz - wx,
    1 - (xx + yy),
    0,
    0,
    0,
    0,
    1,
  ];
}

/** Rotation of `angle` radians around a (unit) axis. */
export function axisAngle4(axis: Readonly<Vec3>, angle: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** View matrix (world → camera) for a camera at `eye` looking at `target` with the given up vector. */
export function lookAt4(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3>): Mat4 {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-9) {
    // up parallel to view direction: pick another up
    xx = 1;
    xy = 0;
    xz = 0;
    len = 1;
  }
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return [
    xx,
    yx,
    zx,
    0,
    xy,
    yy,
    zy,
    0,
    xz,
    yz,
    zz,
    0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ];
}

/** OpenGL-style perspective projection (clip z in [-1, 1]). `fovY` in radians. */
export function perspective4(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

/** OpenGL-style orthographic projection. */
export function ortho4(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  return [
    -2 * lr,
    0,
    0,
    0,
    0,
    -2 * bt,
    0,
    0,
    0,
    0,
    2 * nf,
    0,
    (left + right) * lr,
    (top + bottom) * bt,
    (far + near) * nf,
    1,
  ];
}

export function getTranslation4(m: Readonly<Mat4>): Vec3 {
  return [m[12], m[13], m[14]];
}

export function equals4(a: Readonly<Mat4>, b: Readonly<Mat4>, eps = 1e-6): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}
