import type { Body } from './body';
import type { ContactCandidate } from './manifold';
import { perpendicular } from './vmath';

/*
 * Contact constraints solved with sequential impulses (Catto): accumulated normal impulses
 * clamped to ≥ 0, Coulomb friction on two tangent directions clamped to a friction circle,
 * warm starting from matched contacts of the previous step, speculative contacts (bodies may
 * approach a separated contact only by its gap per step), restitution as a separate pass after
 * the velocity iterations (applied only to contacts that actually collided), and non-linear
 * Gauss-Seidel position correction on the body-local contact anchors.
 *
 * Per step each contact caches r × d and I⁻¹(r × d) for its normal and tangents, so an
 * iteration only needs a few dot products; body velocities are kept in locals while a manifold
 * is solved.
 */

/** Allowed penetration before position correction acts (m). */
export const LINEAR_SLOP = 0.002;
/** Fraction of the remaining penetration removed per position iteration. */
const BAUMGARTE = 0.2;
/** Largest position correction per contact and iteration (m). */
const MAX_CORRECTION = 0.2;
/** Normal approach speed below which restitution is ignored (m/s, like Bullet). */
export const RESTITUTION_THRESHOLD = 0.2;
/** Distance within which a new contact inherits the impulses of an old one (m). */
const MATCH_DISTANCE = 0.02;

export class ContactPoint {
  // anchors on A and B in their body frames
  lax = 0;
  lay = 0;
  laz = 0;
  lbx = 0;
  lby = 0;
  lbz = 0;
  /** World normal A → B at detection and the same normal in the reference body's frame. */
  nx = 0;
  ny = 0;
  nz = 0;
  lnx = 0;
  lny = 0;
  lnz = 0;
  /** Separation at detection (negative = penetration). */
  s = 0;
  /** World midpoint at detection (for matching against the next step's contacts). */
  mx = 0;
  my = 0;
  mz = 0;
  // tangent basis (world)
  t1x = 0;
  t1y = 0;
  t1z = 0;
  t2x = 0;
  t2y = 0;
  t2z = 0;
  // r × d for d = n, t1, t2 (A: a*, B: b*)
  anx = 0;
  any = 0;
  anz = 0;
  bnx = 0;
  bny = 0;
  bnz = 0;
  a1x = 0;
  a1y = 0;
  a1z = 0;
  b1x = 0;
  b1y = 0;
  b1z = 0;
  a2x = 0;
  a2y = 0;
  a2z = 0;
  b2x = 0;
  b2y = 0;
  b2z = 0;
  // I⁻¹ (r × d): angular velocity change per unit impulse
  ianx = 0;
  iany = 0;
  ianz = 0;
  ibnx = 0;
  ibny = 0;
  ibnz = 0;
  ia1x = 0;
  ia1y = 0;
  ia1z = 0;
  ib1x = 0;
  ib1y = 0;
  ib1z = 0;
  ia2x = 0;
  ia2y = 0;
  ia2z = 0;
  ib2x = 0;
  ib2y = 0;
  ib2z = 0;
  normalMass = 0;
  t1Mass = 0;
  t2Mass = 0;
  normalImpulse = 0;
  t1Impulse = 0;
  t2Impulse = 0;
  /** Normal relative velocity before the solve (for restitution). */
  relVel = 0;
  maxImpulse = 0;
  bias = 0;
  /** Friction impulse (world vector) carried over from the matched old contact, if any. */
  fx = 0;
  fy = 0;
  fz = 0;
  carried = false;
}

export class Manifold {
  points: ContactPoint[] = [];
  /** Step stamp of the last narrow phase update. */
  stamp = -1;
  readonly friction: number;
  readonly restitution: number;
  /** Normal stored in B's frame (B static/kinematic) instead of A's. */
  readonly refB: boolean;

  constructor(
    readonly a: Body,
    readonly b: Body,
    readonly key: number,
  ) {
    // Bullet / Blender combine friction and restitution multiplicatively
    this.friction = Math.min(10, a.friction * b.friction);
    this.restitution = a.restitution * b.restitution;
    this.refB = !b.dynamic && a.dynamic;
  }

  /** Replaces the contact points, carrying accumulated impulses over from matching old points. */
  update(cands: readonly ContactCandidate[], stamp: number): void {
    const a = this.a;
    const b = this.b;
    const old = this.points;
    const used = old.length ? new Uint8Array(old.length) : null;
    const next: ContactPoint[] = [];
    const RR = (this.refB ? b : a).R;
    const Ra = a.R;
    const Rb = b.R;
    for (const c of cands) {
      const [nx, ny, nz] = c.n;
      const mx = (c.pa[0] + c.pb[0]) / 2;
      const my = (c.pa[1] + c.pb[1]) / 2;
      const mz = (c.pa[2] + c.pb[2]) / 2;
      // warm start from the nearest unmatched old contact (the object is reused)
      let best = -1;
      let bestD = MATCH_DISTANCE * MATCH_DISTANCE;
      for (let i = 0; i < old.length; i++) {
        if (used![i]) continue;
        const o = old[i];
        if (o.nx * nx + o.ny * ny + o.nz * nz < 0.9) continue;
        const d = (o.mx - mx) ** 2 + (o.my - my) ** 2 + (o.mz - mz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      let p: ContactPoint;
      if (best >= 0) {
        used![best] = 1;
        p = old[best];
        // friction impulse as a world vector, re-projected onto the new tangents in prepare
        p.fx = p.t1Impulse * p.t1x + p.t2Impulse * p.t2x;
        p.fy = p.t1Impulse * p.t1y + p.t2Impulse * p.t2y;
        p.fz = p.t1Impulse * p.t1z + p.t2Impulse * p.t2z;
        p.carried = true;
      } else p = new ContactPoint();
      const dax = c.pa[0] - a.px;
      const day = c.pa[1] - a.py;
      const daz = c.pa[2] - a.pz;
      p.lax = Ra[0] * dax + Ra[3] * day + Ra[6] * daz;
      p.lay = Ra[1] * dax + Ra[4] * day + Ra[7] * daz;
      p.laz = Ra[2] * dax + Ra[5] * day + Ra[8] * daz;
      const dbx = c.pb[0] - b.px;
      const dby = c.pb[1] - b.py;
      const dbz = c.pb[2] - b.pz;
      p.lbx = Rb[0] * dbx + Rb[3] * dby + Rb[6] * dbz;
      p.lby = Rb[1] * dbx + Rb[4] * dby + Rb[7] * dbz;
      p.lbz = Rb[2] * dbx + Rb[5] * dby + Rb[8] * dbz;
      p.nx = nx;
      p.ny = ny;
      p.nz = nz;
      p.lnx = RR[0] * nx + RR[3] * ny + RR[6] * nz;
      p.lny = RR[1] * nx + RR[4] * ny + RR[7] * nz;
      p.lnz = RR[2] * nx + RR[5] * ny + RR[8] * nz;
      p.s = c.s;
      p.mx = mx;
      p.my = my;
      p.mz = mz;
      next.push(p);
    }
    this.points = next;
    this.stamp = stamp;
  }
}

/** Inverse effective mass of a body at offset r along unit direction u (for position correction). */
function invMassAlong(
  body: Body,
  rx: number,
  ry: number,
  rz: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  if (!body.dynamic) return 0;
  const cx = ry * uz - rz * uy;
  const cy = rz * ux - rx * uz;
  const cz = rx * uy - ry * ux;
  const I = body.invInertiaWorld;
  const ix = I[0] * cx + I[1] * cy + I[2] * cz;
  const iy = I[3] * cx + I[4] * cy + I[5] * cz;
  const iz = I[6] * cx + I[7] * cy + I[8] * cz;
  return body.invMass + cx * ix + cy * iy + cz * iz;
}

/** Computes lever arms, effective masses, tangents and speculative biases for one step. */
export function prepareManifold(m: Manifold, dt: number): void {
  const a = m.a;
  const b = m.b;
  const Ra = a.R;
  const Rb = b.R;
  const Ia = a.invInertiaWorld;
  const Ib = b.invInertiaWorld;
  const ima = a.invMass;
  const imb = b.invMass;
  const invDt = dt > 0 ? 1 / dt : 0;
  for (const p of m.points) {
    const pax = a.px + Ra[0] * p.lax + Ra[1] * p.lay + Ra[2] * p.laz;
    const pay = a.py + Ra[3] * p.lax + Ra[4] * p.lay + Ra[5] * p.laz;
    const paz = a.pz + Ra[6] * p.lax + Ra[7] * p.lay + Ra[8] * p.laz;
    const pbx = b.px + Rb[0] * p.lbx + Rb[1] * p.lby + Rb[2] * p.lbz;
    const pby = b.py + Rb[3] * p.lbx + Rb[4] * p.lby + Rb[5] * p.lbz;
    const pbz = b.pz + Rb[6] * p.lbx + Rb[7] * p.lby + Rb[8] * p.lbz;
    const cx = (pax + pbx) / 2;
    const cy = (pay + pby) / 2;
    const cz = (paz + pbz) / 2;
    const rax = cx - a.px;
    const ray = cy - a.py;
    const raz = cz - a.pz;
    const rbx = cx - b.px;
    const rby = cy - b.py;
    const rbz = cz - b.pz;
    const { nx, ny, nz } = p;
    const [t1x, t1y, t1z] = perpendicular(nx, ny, nz);
    const t2x = ny * t1z - nz * t1y;
    const t2y = nz * t1x - nx * t1z;
    const t2z = nx * t1y - ny * t1x;
    if (p.carried) {
      p.t1Impulse = p.fx * t1x + p.fy * t1y + p.fz * t1z;
      p.t2Impulse = p.fx * t2x + p.fy * t2y + p.fz * t2z;
      p.carried = false;
    }
    p.t1x = t1x;
    p.t1y = t1y;
    p.t1z = t1z;
    p.t2x = t2x;
    p.t2y = t2y;
    p.t2z = t2z;
    // r × d
    p.anx = ray * nz - raz * ny;
    p.any = raz * nx - rax * nz;
    p.anz = rax * ny - ray * nx;
    p.bnx = rby * nz - rbz * ny;
    p.bny = rbz * nx - rbx * nz;
    p.bnz = rbx * ny - rby * nx;
    p.a1x = ray * t1z - raz * t1y;
    p.a1y = raz * t1x - rax * t1z;
    p.a1z = rax * t1y - ray * t1x;
    p.b1x = rby * t1z - rbz * t1y;
    p.b1y = rbz * t1x - rbx * t1z;
    p.b1z = rbx * t1y - rby * t1x;
    p.a2x = ray * t2z - raz * t2y;
    p.a2y = raz * t2x - rax * t2z;
    p.a2z = rax * t2y - ray * t2x;
    p.b2x = rby * t2z - rbz * t2y;
    p.b2y = rbz * t2x - rbx * t2z;
    p.b2z = rbx * t2y - rby * t2x;
    // I⁻¹ (r × d) (zero for static and kinematic bodies)
    p.ianx = Ia[0] * p.anx + Ia[1] * p.any + Ia[2] * p.anz;
    p.iany = Ia[3] * p.anx + Ia[4] * p.any + Ia[5] * p.anz;
    p.ianz = Ia[6] * p.anx + Ia[7] * p.any + Ia[8] * p.anz;
    p.ibnx = Ib[0] * p.bnx + Ib[1] * p.bny + Ib[2] * p.bnz;
    p.ibny = Ib[3] * p.bnx + Ib[4] * p.bny + Ib[5] * p.bnz;
    p.ibnz = Ib[6] * p.bnx + Ib[7] * p.bny + Ib[8] * p.bnz;
    p.ia1x = Ia[0] * p.a1x + Ia[1] * p.a1y + Ia[2] * p.a1z;
    p.ia1y = Ia[3] * p.a1x + Ia[4] * p.a1y + Ia[5] * p.a1z;
    p.ia1z = Ia[6] * p.a1x + Ia[7] * p.a1y + Ia[8] * p.a1z;
    p.ib1x = Ib[0] * p.b1x + Ib[1] * p.b1y + Ib[2] * p.b1z;
    p.ib1y = Ib[3] * p.b1x + Ib[4] * p.b1y + Ib[5] * p.b1z;
    p.ib1z = Ib[6] * p.b1x + Ib[7] * p.b1y + Ib[8] * p.b1z;
    p.ia2x = Ia[0] * p.a2x + Ia[1] * p.a2y + Ia[2] * p.a2z;
    p.ia2y = Ia[3] * p.a2x + Ia[4] * p.a2y + Ia[5] * p.a2z;
    p.ia2z = Ia[6] * p.a2x + Ia[7] * p.a2y + Ia[8] * p.a2z;
    p.ib2x = Ib[0] * p.b2x + Ib[1] * p.b2y + Ib[2] * p.b2z;
    p.ib2y = Ib[3] * p.b2x + Ib[4] * p.b2y + Ib[5] * p.b2z;
    p.ib2z = Ib[6] * p.b2x + Ib[7] * p.b2y + Ib[8] * p.b2z;
    const kn =
      ima +
      imb +
      p.anx * p.ianx +
      p.any * p.iany +
      p.anz * p.ianz +
      p.bnx * p.ibnx +
      p.bny * p.ibny +
      p.bnz * p.ibnz;
    p.normalMass = kn > 0 ? 1 / kn : 0;
    const k1 =
      ima +
      imb +
      p.a1x * p.ia1x +
      p.a1y * p.ia1y +
      p.a1z * p.ia1z +
      p.b1x * p.ib1x +
      p.b1y * p.ib1y +
      p.b1z * p.ib1z;
    p.t1Mass = k1 > 0 ? 1 / k1 : 0;
    const k2 =
      ima +
      imb +
      p.a2x * p.ia2x +
      p.a2y * p.ia2y +
      p.a2z * p.ia2z +
      p.b2x * p.ib2x +
      p.b2y * p.ib2y +
      p.b2z * p.ib2z;
    p.t2Mass = k2 > 0 ? 1 / k2 : 0;
    p.relVel =
      (b.vx - a.vx) * nx +
      (b.vy - a.vy) * ny +
      (b.vz - a.vz) * nz +
      b.wx * p.bnx +
      b.wy * p.bny +
      b.wz * p.bnz -
      (a.wx * p.anx + a.wy * p.any + a.wz * p.anz);
    p.maxImpulse = 0;
    // speculative contact: the gap may close within this step, but not more
    p.bias = p.s > 0 ? p.s * invDt : 0;
  }
}

/** Applies the impulses accumulated in the previous step. */
export function warmStart(m: Manifold): void {
  const a = m.a;
  const b = m.b;
  const ima = a.invMass;
  const imb = b.invMass;
  for (const p of m.points) {
    const ln = p.normalImpulse;
    const l1 = p.t1Impulse;
    const l2 = p.t2Impulse;
    if (ln === 0 && l1 === 0 && l2 === 0) continue;
    const px = ln * p.nx + l1 * p.t1x + l2 * p.t2x;
    const py = ln * p.ny + l1 * p.t1y + l2 * p.t2y;
    const pz = ln * p.nz + l1 * p.t1z + l2 * p.t2z;
    if (a.dynamic) {
      a.vx -= ima * px;
      a.vy -= ima * py;
      a.vz -= ima * pz;
      a.wx -= ln * p.ianx + l1 * p.ia1x + l2 * p.ia2x;
      a.wy -= ln * p.iany + l1 * p.ia1y + l2 * p.ia2y;
      a.wz -= ln * p.ianz + l1 * p.ia1z + l2 * p.ia2z;
    }
    if (b.dynamic) {
      b.vx += imb * px;
      b.vy += imb * py;
      b.vz += imb * pz;
      b.wx += ln * p.ibnx + l1 * p.ib1x + l2 * p.ib2x;
      b.wy += ln * p.ibny + l1 * p.ib1y + l2 * p.ib2y;
      b.wz += ln * p.ibnz + l1 * p.ib1z + l2 * p.ib2z;
    }
  }
}

/** One velocity iteration: friction first, then the (more important) normal constraints. */
export function solveVelocity(m: Manifold): void {
  const a = m.a;
  const b = m.b;
  const ima = a.invMass;
  const imb = b.invMass;
  let avx = a.vx;
  let avy = a.vy;
  let avz = a.vz;
  let awx = a.wx;
  let awy = a.wy;
  let awz = a.wz;
  let bvx = b.vx;
  let bvy = b.vy;
  let bvz = b.vz;
  let bwx = b.wx;
  let bwy = b.wy;
  let bwz = b.wz;
  const mu = m.friction;
  const points = m.points;
  if (mu > 0)
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const dvx = bvx - avx;
      const dvy = bvy - avy;
      const dvz = bvz - avz;
      const vt1 =
        dvx * p.t1x +
        dvy * p.t1y +
        dvz * p.t1z +
        bwx * p.b1x +
        bwy * p.b1y +
        bwz * p.b1z -
        (awx * p.a1x + awy * p.a1y + awz * p.a1z);
      const vt2 =
        dvx * p.t2x +
        dvy * p.t2y +
        dvz * p.t2z +
        bwx * p.b2x +
        bwy * p.b2y +
        bwz * p.b2z -
        (awx * p.a2x + awy * p.a2y + awz * p.a2z);
      let n1 = p.t1Impulse - p.t1Mass * vt1;
      let n2 = p.t2Impulse - p.t2Mass * vt2;
      const max = mu * p.normalImpulse;
      const len2 = n1 * n1 + n2 * n2;
      if (len2 > max * max) {
        const k = len2 > 0 ? max / Math.sqrt(len2) : 0;
        n1 *= k;
        n2 *= k;
      }
      const l1 = n1 - p.t1Impulse;
      const l2 = n2 - p.t2Impulse;
      p.t1Impulse = n1;
      p.t2Impulse = n2;
      const px = l1 * p.t1x + l2 * p.t2x;
      const py = l1 * p.t1y + l2 * p.t2y;
      const pz = l1 * p.t1z + l2 * p.t2z;
      avx -= ima * px;
      avy -= ima * py;
      avz -= ima * pz;
      awx -= l1 * p.ia1x + l2 * p.ia2x;
      awy -= l1 * p.ia1y + l2 * p.ia2y;
      awz -= l1 * p.ia1z + l2 * p.ia2z;
      bvx += imb * px;
      bvy += imb * py;
      bvz += imb * pz;
      bwx += l1 * p.ib1x + l2 * p.ib2x;
      bwy += l1 * p.ib1y + l2 * p.ib2y;
      bwz += l1 * p.ib1z + l2 * p.ib2z;
    }
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const vn =
      (bvx - avx) * p.nx +
      (bvy - avy) * p.ny +
      (bvz - avz) * p.nz +
      bwx * p.bnx +
      bwy * p.bny +
      bwz * p.bnz -
      (awx * p.anx + awy * p.any + awz * p.anz);
    const next = Math.max(p.normalImpulse - p.normalMass * (vn + p.bias), 0);
    const l = next - p.normalImpulse;
    p.normalImpulse = next;
    if (next > p.maxImpulse) p.maxImpulse = next;
    avx -= ima * l * p.nx;
    avy -= ima * l * p.ny;
    avz -= ima * l * p.nz;
    awx -= l * p.ianx;
    awy -= l * p.iany;
    awz -= l * p.ianz;
    bvx += imb * l * p.nx;
    bvy += imb * l * p.ny;
    bvz += imb * l * p.nz;
    bwx += l * p.ibnx;
    bwy += l * p.ibny;
    bwz += l * p.ibnz;
  }
  if (a.dynamic) {
    a.vx = avx;
    a.vy = avy;
    a.vz = avz;
    a.wx = awx;
    a.wy = awy;
    a.wz = awz;
  }
  if (b.dynamic) {
    b.vx = bvx;
    b.vy = bvy;
    b.vz = bvz;
    b.wx = bwx;
    b.wy = bwy;
    b.wz = bwz;
  }
}

/** Restitution pass: bounces contacts that collided faster than the threshold. */
export function applyRestitution(m: Manifold): void {
  const e = m.restitution;
  if (!(e > 0)) return;
  const a = m.a;
  const b = m.b;
  const ima = a.invMass;
  const imb = b.invMass;
  for (const p of m.points) {
    if (p.relVel > -RESTITUTION_THRESHOLD || p.maxImpulse === 0) continue;
    const vn =
      (b.vx - a.vx) * p.nx +
      (b.vy - a.vy) * p.ny +
      (b.vz - a.vz) * p.nz +
      b.wx * p.bnx +
      b.wy * p.bny +
      b.wz * p.bnz -
      (a.wx * p.anx + a.wy * p.any + a.wz * p.anz);
    const next = Math.max(p.normalImpulse - p.normalMass * (vn + e * p.relVel), 0);
    const l = next - p.normalImpulse;
    p.normalImpulse = next;
    if (l === 0) continue;
    if (a.dynamic) {
      a.vx -= ima * l * p.nx;
      a.vy -= ima * l * p.ny;
      a.vz -= ima * l * p.nz;
      a.wx -= l * p.ianx;
      a.wy -= l * p.iany;
      a.wz -= l * p.ianz;
    }
    if (b.dynamic) {
      b.vx += imb * l * p.nx;
      b.vy += imb * l * p.ny;
      b.vz += imb * l * p.nz;
      b.wx += l * p.ibnx;
      b.wy += l * p.ibny;
      b.wz += l * p.ibnz;
    }
  }
}

/** Rotates a body by the small rotation vector θ (q ← q + ½ θ ⊗ q). */
export function rotateBody(body: Body, tx: number, ty: number, tz: number): void {
  const { qx, qy, qz, qw } = body;
  body.qx += 0.5 * (qw * tx + ty * qz - tz * qy);
  body.qy += 0.5 * (qw * ty + tz * qx - tx * qz);
  body.qz += 0.5 * (qw * tz + tx * qy - ty * qx);
  body.qw -= 0.5 * (tx * qx + ty * qy + tz * qz);
  body.updateRotation();
}

/**
 * One non-linear Gauss-Seidel position iteration: recomputes each contact's separation from the
 * current poses and pushes penetrating bodies apart. Returns the smallest separation seen.
 */
export function solvePosition(m: Manifold): number {
  const a = m.a;
  const b = m.b;
  let minSep = 0;
  const ref = m.refB ? b : a;
  for (const p of m.points) {
    if (p.s > 0 && p.normalImpulse === 0) continue;
    const Ra = a.R;
    const Rb = b.R;
    const RR = ref.R;
    const nx = RR[0] * p.lnx + RR[1] * p.lny + RR[2] * p.lnz;
    const ny = RR[3] * p.lnx + RR[4] * p.lny + RR[5] * p.lnz;
    const nz = RR[6] * p.lnx + RR[7] * p.lny + RR[8] * p.lnz;
    const pax = a.px + Ra[0] * p.lax + Ra[1] * p.lay + Ra[2] * p.laz;
    const pay = a.py + Ra[3] * p.lax + Ra[4] * p.lay + Ra[5] * p.laz;
    const paz = a.pz + Ra[6] * p.lax + Ra[7] * p.lay + Ra[8] * p.laz;
    const pbx = b.px + Rb[0] * p.lbx + Rb[1] * p.lby + Rb[2] * p.lbz;
    const pby = b.py + Rb[3] * p.lbx + Rb[4] * p.lby + Rb[5] * p.lbz;
    const pbz = b.pz + Rb[6] * p.lbx + Rb[7] * p.lby + Rb[8] * p.lbz;
    const sep = (pbx - pax) * nx + (pby - pay) * ny + (pbz - paz) * nz;
    if (sep < minSep) minSep = sep;
    const C = Math.min(0, Math.max(-MAX_CORRECTION, BAUMGARTE * (sep + LINEAR_SLOP)));
    if (C === 0) continue;
    const cx = (pax + pbx) / 2;
    const cy = (pay + pby) / 2;
    const cz = (paz + pbz) / 2;
    const rax = cx - a.px;
    const ray = cy - a.py;
    const raz = cz - a.pz;
    const rbx = cx - b.px;
    const rby = cy - b.py;
    const rbz = cz - b.pz;
    const k = invMassAlong(a, rax, ray, raz, nx, ny, nz) + invMassAlong(b, rbx, rby, rbz, nx, ny, nz);
    if (!(k > 0)) continue;
    const impulse = -C / k;
    const px = impulse * nx;
    const py = impulse * ny;
    const pz = impulse * nz;
    if (a.dynamic) {
      a.px -= a.invMass * px;
      a.py -= a.invMass * py;
      a.pz -= a.invMass * pz;
      const I = a.invInertiaWorld;
      const ux = ray * pz - raz * py;
      const uy = raz * px - rax * pz;
      const uz = rax * py - ray * px;
      rotateBody(
        a,
        -(I[0] * ux + I[1] * uy + I[2] * uz),
        -(I[3] * ux + I[4] * uy + I[5] * uz),
        -(I[6] * ux + I[7] * uy + I[8] * uz),
      );
    }
    if (b.dynamic) {
      b.px += b.invMass * px;
      b.py += b.invMass * py;
      b.pz += b.invMass * pz;
      const I = b.invInertiaWorld;
      const ux = rby * pz - rbz * py;
      const uy = rbz * px - rbx * pz;
      const uz = rbx * py - rby * px;
      rotateBody(
        b,
        I[0] * ux + I[1] * uy + I[2] * uz,
        I[3] * ux + I[4] * uy + I[5] * uz,
        I[6] * ux + I[7] * uy + I[8] * uz,
      );
    }
  }
  return minSep;
}
