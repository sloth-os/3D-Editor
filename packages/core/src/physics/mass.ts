import type { Vec3 } from '../math/types';
import type { Mat3 } from './vmath';

/*
 * Mass properties of collision shapes for a uniform density. Inertia tensors are given about the
 * centre of mass in the shape's axes, per unit mass (multiply by the body mass), as row-major
 * 3x3 matrices.
 */

export interface MassProperties {
  /** Volume in m³ (0 for flat or degenerate shapes). */
  volume: number;
  /** Centre of mass. */
  com: Vec3;
  /** Inertia tensor about the centre of mass for a mass of 1 kg. */
  inertia: Mat3;
}

const diag = (x: number, y: number, z: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, z];

/** Solid box with half extents h. */
export function boxMass(h: Readonly<Vec3>, center: Readonly<Vec3> = [0, 0, 0]): MassProperties {
  const [x, y, z] = h.map((v) => Math.abs(v));
  return {
    volume: 8 * x * y * z,
    com: [...center] as Vec3,
    inertia: diag((y * y + z * z) / 3, (x * x + z * z) / 3, (x * x + y * y) / 3),
  };
}

/** Solid sphere. */
export function sphereMass(r: number, center: Readonly<Vec3> = [0, 0, 0]): MassProperties {
  const i = 0.4 * r * r;
  return { volume: (4 / 3) * Math.PI * r * r * r, com: [...center] as Vec3, inertia: diag(i, i, i) };
}

/** Solid cylinder along Z with radius r and half height h. */
export function cylinderMass(r: number, h: number, center: Readonly<Vec3> = [0, 0, 0]): MassProperties {
  const ixx = (r * r) / 4 + (h * h) / 3;
  return { volume: Math.PI * r * r * 2 * h, com: [...center] as Vec3, inertia: diag(ixx, ixx, (r * r) / 2) };
}

/** Solid cone along Z with base radius r and height H; `com` is its centre of mass (H/4 above the base). */
export function coneMass(r: number, height: number, com: Readonly<Vec3> = [0, 0, 0]): MassProperties {
  const ixx = (3 / 20) * r * r + (3 / 80) * height * height;
  return {
    volume: (Math.PI * r * r * height) / 3,
    com: [...com] as Vec3,
    inertia: diag(ixx, ixx, (3 / 10) * r * r),
  };
}

/** Solid capsule along Z: radius r, cylinder half height h (total height 2h + 2r). */
export function capsuleMass(r: number, h: number, center: Readonly<Vec3> = [0, 0, 0]): MassProperties {
  const vc = Math.PI * r * r * 2 * h;
  const vs = (4 / 3) * Math.PI * r * r * r;
  const volume = vc + vs;
  if (!(volume > 0)) return { volume: 0, com: [...center] as Vec3, inertia: diag(0, 0, 0) };
  const mc = vc / volume;
  const ms = vs / volume;
  const izz = mc * ((r * r) / 2) + ms * 0.4 * r * r;
  const d = h + (3 / 8) * r;
  const ixx = mc * ((r * r) / 4 + (h * h) / 3) + ms * ((83 / 320) * r * r + d * d);
  return { volume, com: [...center] as Vec3, inertia: diag(ixx, ixx, izz) };
}

/**
 * Mass properties of a closed polyhedron given as polygons (counter-clockwise from outside)
 * indexing flat xyz `points`. Returns null when the volume is (nearly) zero.
 */
export function polyhedronMass(
  points: ArrayLike<number>,
  faces: readonly (readonly number[])[],
): MassProperties | null {
  const n = points.length / 3;
  if (n < 4 || faces.length < 4) return null;
  // reference point inside the hull improves conditioning
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let i = 0; i < n; i++) {
    ox += points[i * 3];
    oy += points[i * 3 + 1];
    oz += points[i * 3 + 2];
  }
  ox /= n;
  oy /= n;
  oz /= n;
  let vol = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  // second moment ∫ x xᵀ dV about the reference point
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  for (const f of faces) {
    if (f.length < 3) continue;
    const a = f[0] * 3;
    const ax = points[a] - ox;
    const ay = points[a + 1] - oy;
    const az = points[a + 2] - oz;
    for (let k = 1; k + 1 < f.length; k++) {
      const b = f[k] * 3;
      const c = f[k + 1] * 3;
      const bx = points[b] - ox;
      const by = points[b + 1] - oy;
      const bz = points[b + 2] - oz;
      const qx = points[c] - ox;
      const qy = points[c + 1] - oy;
      const qz = points[c + 2] - oz;
      // tetrahedron (origin, a, b, c)
      const det = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
      const v = det / 6;
      vol += v;
      const sx = ax + bx + qx;
      const sy = ay + by + qy;
      const sz = az + bz + qz;
      cx += v * sx * 0.25;
      cy += v * sy * 0.25;
      cz += v * sz * 0.25;
      const k20 = v / 20;
      xx += k20 * (ax * ax + bx * bx + qx * qx + sx * sx);
      yy += k20 * (ay * ay + by * by + qy * qy + sy * sy);
      zz += k20 * (az * az + bz * bz + qz * qz + sz * sz);
      xy += k20 * (ax * ay + bx * by + qx * qy + sx * sy);
      xz += k20 * (ax * az + bx * bz + qx * qz + sx * sz);
      yz += k20 * (ay * az + by * bz + qy * qz + sy * sz);
    }
  }
  let scale = 0;
  for (let i = 0; i < n; i++)
    scale = Math.max(
      scale,
      Math.abs(points[i * 3] - ox),
      Math.abs(points[i * 3 + 1] - oy),
      Math.abs(points[i * 3 + 2] - oz),
    );
  if (!(vol > 1e-12 * Math.max(1e-30, scale * scale * scale)) || !Number.isFinite(vol)) return null;
  cx /= vol;
  cy /= vol;
  cz /= vol;
  // shift the second moment to the centre of mass
  xx -= vol * cx * cx;
  yy -= vol * cy * cy;
  zz -= vol * cz * cz;
  xy -= vol * cx * cy;
  xz -= vol * cx * cz;
  yz -= vol * cy * cz;
  const iv = 1 / vol;
  const tr = xx + yy + zz;
  return {
    volume: vol,
    com: [cx + ox, cy + oy, cz + oz],
    inertia: [
      (tr - xx) * iv,
      -xy * iv,
      -xz * iv,
      -xy * iv,
      (tr - yy) * iv,
      -yz * iv,
      -xz * iv,
      -yz * iv,
      (tr - zz) * iv,
    ],
  };
}

/**
 * Inertia of a flat or degenerate point set, approximated as a thin box around its bounds
 * (thickness at least `minThickness`), about the bounds' centre.
 */
export function boundsMass(points: ArrayLike<number>, minThickness: number): MassProperties {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], points[i + a]);
      hi[a] = Math.max(hi[a], points[i + a]);
    }
  if (!Number.isFinite(lo[0])) return boxMass([minThickness, minThickness, minThickness]);
  const h: Vec3 = [0, 1, 2].map((a) => Math.max((hi[a] - lo[a]) / 2, minThickness / 2)) as Vec3;
  const c: Vec3 = [0, 1, 2].map((a) => (hi[a] + lo[a]) / 2) as Vec3;
  return { ...boxMass(h, c), volume: 0 };
}
