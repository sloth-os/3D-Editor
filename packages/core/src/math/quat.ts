import type { Quat, Vec3 } from './types';
import { eulerFromRotation, fromQuat4 } from './mat4';

export function identityQuat(): Quat {
  return [0, 0, 0, 1];
}

/** Hamilton product a · b (applies b first, then a). */
export function multiplyQuat(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatFromAxisAngle(axis: Readonly<Vec3>, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** Quaternion from Blender XYZ Euler angles (X applied first): q = qz · qy · qx. */
export function quatFromEuler(e: Readonly<Vec3>): Quat {
  const qx = quatFromAxisAngle([1, 0, 0], e[0]);
  const qy = quatFromAxisAngle([0, 1, 0], e[1]);
  const qz = quatFromAxisAngle([0, 0, 1], e[2]);
  return multiplyQuat(qz, multiplyQuat(qy, qx));
}

export function eulerFromQuat(q: Readonly<Quat>): Vec3 {
  return eulerFromRotation(fromQuat4(q));
}

export function normalizeQuat(q: Readonly<Quat>): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function rotateVec3ByQuat(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

export function slerpQuat(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (1 - cos > 1e-6) {
    const omega = Math.acos(cos);
    const sin = Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) / sin;
    s1 = Math.sin(t * omega) / sin;
  } else {
    s0 = 1 - t;
    s1 = t;
  }
  return normalizeQuat([s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw]);
}
