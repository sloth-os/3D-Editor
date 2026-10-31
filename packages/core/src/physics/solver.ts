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
  // solver state
  rax = 0;
  ray = 0;
  raz = 0;
  rbx = 0;
  rby = 0;
  rbz = 0;
  t1x = 0;
  t1y = 0;
  t1z = 0;
  t2x = 0;
  t2y = 0;
  t2z = 0;
  normalMass = 0;
  t1Mass = 0;
  t2Mass = 0;
  normalImpulse = 0;
  t1Impulse = 0;
  t2Impulse = 0;
  relVel = 0;
  maxImpulse = 0;
  bias = 0;
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
    const used = new Uint8Array(old.length);
    const next: ContactPoint[] = [];
    const ref = this.refB ? b : a;
    const RR = ref.R;
    for (const c of cands) {
      const p = new ContactPoint();
      const Ra = a.R;
      const Rb = b.R;
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
      const [nx, ny, nz] = c.n;
      p.nx = nx;
      p.ny = ny;
      p.nz = nz;
      p.lnx = RR[0] * nx + RR[3] * ny + RR[6] * nz;
      p.lny = RR[1] * nx + RR[4] * ny + RR[7] * nz;
      p.lnz = RR[2] * nx + RR[5] * ny + RR[8] * nz;
      p.s = c.s;
      p.mx = (c.pa[0] + c.pb[0]) / 2;
      p.my = (c.pa[1] + c.pb[1]) / 2;
      p.mz = (c.pa[2] + c.pb[2]) / 2;
      // warm start from the nearest unmatched old contact
      let best = -1;
      let bestD = MATCH_DISTANCE * MATCH_DISTANCE;
      for (let i = 0; i < old.length; i++) {
        if (used[i]) continue;
        const o = old[i];
        if (o.nx * nx + o.ny * ny + o.nz * nz < 0.9) continue;
        const d = (o.mx - p.mx) ** 2 + (o.my - p.my) ** 2 + (o.mz - p.mz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        used[best] = 1;
        const o = old[best];
        p.normalImpulse = o.normalImpulse;
        // re-project the old friction impulse onto the new tangent basis (set in prepare)
        p.t1x = o.t1Impulse * o.t1x + o.t2Impulse * o.t2x;
        p.t1y = o.t1Impulse * o.t1y + o.t2Impulse * o.t2y;
        p.t1z = o.t1Impulse * o.t1z + o.t2Impulse * o.t2z;
        p.t1Impulse = NaN; // marker: friction impulse vector stored in t1
      }
      next.push(p);
    }
    this.points = next;
    this.stamp = stamp;
  }
}

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

/** Applies impulse P at offsets ra (on A, negative) and rb (on B, positive). */
function applyImpulse(
  a: Body,
  b: Body,
  px: number,
  py: number,
  pz: number,
  p: ContactPoint,
): void {
  if (a.dynamic) {
    a.vx -= a.invMass * px;
    a.vy -= a.invMass * py;
    a.vz -= a.invMass * pz;
    const cx = p.ray * pz - p.raz * py;
    const cy = p.raz * px - p.rax * pz;
    const cz = p.rax * py - p.ray * px;
    const I = a.invInertiaWorld;
    a.wx -= I[0] * cx + I[1] * cy + I[2] * cz;
    a.wy -= I[3] * cx + I[4] * cy + I[5] * cz;
    a.wz -= I[6] * cx + I[7] * cy + I[8] * cz;
  }
  if (b.dynamic) {
    b.vx += b.invMass * px;
    b.vy += b.invMass * py;
    b.vz += b.invMass * pz;
    const cx = p.rby * pz - p.rbz * py;
    const cy = p.rbz * px - p.rbx * pz;
    const cz = p.rbx * py - p.rby * px;
    const I = b.invInertiaWorld;
    b.wx += I[0] * cx + I[1] * cy + I[2] * cz;
    b.wy += I[3] * cx + I[4] * cy + I[5] * cz;
    b.wz += I[6] * cx + I[7] * cy + I[8] * cz;
  }
}

/** Relative velocity of B with respect to A at the contact. */
function relativeVelocity(a: Body, b: Body, p: ContactPoint, out: number[]): void {
  out[0] = b.vx + (b.wy * p.rbz - b.wz * p.rby) - a.vx - (a.wy * p.raz - a.wz * p.ray);
  out[1] = b.vy + (b.wz * p.rbx - b.wx * p.rbz) - a.vy - (a.wz * p.rax - a.wx * p.raz);
  out[2] = b.vz + (b.wx * p.rby - b.wy * p.rbx) - a.vz - (a.wx * p.ray - a.wy * p.rax);
}

const dv = [0, 0, 0];

/** Computes lever arms, effective masses, tangents and speculative biases for one step. */
export function prepareManifold(m: Manifold, dt: number): void {
  const a = m.a;
  const b = m.b;
  const Ra = a.R;
  const Rb = b.R;
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
    p.rax = cx - a.px;
    p.ray = cy - a.py;
    p.raz = cz - a.pz;
    p.rbx = cx - b.px;
    p.rby = cy - b.py;
    p.rbz = cz - b.pz;
    const [t1x, t1y, t1z] = perpendicular(p.nx, p.ny, p.nz);
    const t2x = p.ny * t1z - p.nz * t1y;
    const t2y = p.nz * t1x - p.nx * t1z;
    const t2z = p.nx * t1y - p.ny * t1x;
    if (Number.isNaN(p.t1Impulse)) {
      // matched contact: project the carried friction impulse vector onto the new basis
      p.t1Impulse = p.t1x * t1x + p.t1y * t1y + p.t1z * t1z;
      p.t2Impulse = p.t1x * t2x + p.t1y * t2y + p.t1z * t2z;
    }
    p.t1x = t1x;
    p.t1y = t1y;
    p.t1z = t1z;
    p.t2x = t2x;
    p.t2y = t2y;
    p.t2z = t2z;
    const kn =
      invMassAlong(a, p.rax, p.ray, p.raz, p.nx, p.ny, p.nz) +
      invMassAlong(b, p.rbx, p.rby, p.rbz, p.nx, p.ny, p.nz) -
      (a.dynamic ? a.invMass : 0) * 0;
    p.normalMass = kn > 0 ? 1 / kn : 0;
    const k1 = invMassAlong(a, p.rax, p.ray, p.raz, t1x, t1y, t1z) + invMassAlong(b, p.rbx, p.rby, p.rbz, t1x, t1y, t1z);
    p.t1Mass = k1 > 0 ? 1 / k1 : 0;
    const k2 = invMassAlong(a, p.rax, p.ray, p.raz, t2x, t2y, t2z) + invMassAlong(b, p.rbx, p.rby, p.rbz, t2x, t2y, t2z);
    p.t2Mass = k2 > 0 ? 1 / k2 : 0;
    relativeVelocity(a, b, p, dv);
    p.relVel = dv[0] * p.nx + dv[1] * p.ny + dv[2] * p.nz;
    p.maxImpulse = 0;
    // speculative contact: the gap may close within this step, but not more
    p.bias = p.s > 0 ? p.s * invDt : 0;
  }
}

export function warmStart(m: Manifold): void {
  for (const p of m.points) {
    const px = p.normalImpulse * p.nx + p.t1Impulse * p.t1x + p.t2Impulse * p.t2x;
    const py = p.normalImpulse * p.ny + p.t1Impulse * p.t1y + p.t2Impulse * p.t2y;
    const pz = p.normalImpulse * p.nz + p.t1Impulse * p.t1z + p.t2Impulse * p.t2z;
    if (px !== 0 || py !== 0 || pz !== 0) applyImpulse(m.a, m.b, px, py, pz, p);
  }
}

/** One velocity iteration: friction first, then the (more important) normal constraints. */
export function solveVelocity(m: Manifold): void {
  const a = m.a;
  const b = m.b;
  const mu = m.friction;
  if (mu > 0) {
    for (const p of m.points) {
      relativeVelocity(a, b, p, dv);
      const vt1 = dv[0] * p.t1x + dv[1] * p.t1y + dv[2] * p.t1z;
      const vt2 = dv[0] * p.t2x + dv[1] * p.t2y + dv[2] * p.t2z;
      let n1 = p.t1Impulse - p.t1Mass * vt1;
      let n2 = p.t2Impulse - p.t2Mass * vt2;
      const max = mu * p.normalImpulse;
      const len = Math.hypot(n1, n2);
      if (len > max) {
        const k = len > 0 ? max / len : 0;
        n1 *= k;
        n2 *= k;
      }
      const l1 = n1 - p.t1Impulse;
      const l2 = n2 - p.t2Impulse;
      p.t1Impulse = n1;
      p.t2Impulse = n2;
      if (l1 !== 0 || l2 !== 0)
        applyImpulse(a, b, l1 * p.t1x + l2 * p.t2x, l1 * p.t1y + l2 * p.t2y, l1 * p.t1z + l2 * p.t2z, p);
    }
  }
  for (const p of m.points) {
    relativeVelocity(a, b, p, dv);
    const vn = dv[0] * p.nx + dv[1] * p.ny + dv[2] * p.nz;
    const next = Math.max(p.normalImpulse - p.normalMass * (vn + p.bias), 0);
    const l = next - p.normalImpulse;
    p.normalImpulse = next;
    if (next > p.maxImpulse) p.maxImpulse = next;
    if (l !== 0) applyImpulse(a, b, l * p.nx, l * p.ny, l * p.nz, p);
  }
}

/** Restitution pass: bounces contacts that collided faster than the threshold. */
export function applyRestitution(m: Manifold): void {
  const e = m.restitution;
  if (!(e > 0)) return;
  for (const p of m.points) {
    if (p.relVel > -RESTITUTION_THRESHOLD || p.maxImpulse === 0) continue;
    relativeVelocity(m.a, m.b, p, dv);
    const vn = dv[0] * p.nx + dv[1] * p.ny + dv[2] * p.nz;
    const next = Math.max(p.normalImpulse - p.normalMass * (vn + e * p.relVel), 0);
    const l = next - p.normalImpulse;
    p.normalImpulse = next;
    if (l !== 0) applyImpulse(m.a, m.b, l * p.nx, l * p.ny, l * p.nz, p);
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
      rotateBody(a, -(I[0] * ux + I[1] * uy + I[2] * uz), -(I[3] * ux + I[4] * uy + I[5] * uz), -(I[6] * ux + I[7] * uy + I[8] * uz));
    }
    if (b.dynamic) {
      b.px += b.invMass * px;
      b.py += b.invMass * py;
      b.pz += b.invMass * pz;
      const I = b.invInertiaWorld;
      const ux = rby * pz - rbz * py;
      const uy = rbz * px - rbx * pz;
      const uz = rbx * py - rby * px;
      rotateBody(b, I[0] * ux + I[1] * uy + I[2] * uz, I[3] * ux + I[4] * uy + I[5] * uz, I[6] * ux + I[7] * uy + I[8] * uz);
    }
  }
  return minSep;
}
