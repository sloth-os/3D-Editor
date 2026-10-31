import type { Quat, Vec3 } from '../math/types';
import type { Body } from './body';
import { SweepAndPrune } from './broadphase';
import type { ContactCandidate } from './manifold';
import { collide } from './narrowphase';
import {
  LINEAR_SLOP,
  Manifold,
  applyRestitution,
  prepareManifold,
  solvePosition,
  solveVelocity,
  warmStart,
} from './solver';
import { angularVelocityBetween, slerpQ } from './vmath';

/*
 * The dynamics world. One fixed time step:
 *   1. kinematic bodies get the velocity that carries them to this step's target pose; awake
 *      dynamic bodies get gravity and damping (Bullet's v *= (1 - damping)^dt),
 *   2. broad phase: sweep and prune over bounds fattened by the collision margin and swept along
 *      the velocity,
 *   3. narrow phase into persistent manifolds (accumulated impulses carried over for warm
 *      starting); speculative contacts up to the margin + the distance moved this step,
 *   4. islands: sleeping bodies touched by awake (or moving kinematic) bodies wake up,
 *   5. sequential impulses: warm start, friction + non-penetration iterations, restitution,
 *   6. semi-implicit Euler integration (exact rotation by ω·dt),
 *   7. non-linear Gauss-Seidel penetration correction (does not add velocity),
 *   8. sleep bookkeeping: islands at rest for TIME_TO_SLEEP stop being simulated.
 * Bodies are ordered by object id and pairs / manifolds by body index, so a run is a pure
 * function of its inputs.
 */

/** Bodies slower than this (m/s) … */
export const SLEEP_LINEAR_SPEED = 0.03;
/** … and turning slower than this (rad/s) … */
export const SLEEP_ANGULAR_SPEED = 0.04;
/** … for this long (s, whole island) fall asleep. */
export const TIME_TO_SLEEP = 0.5;
/** Speed limit guarding against blow-ups (m/s). */
const MAX_LINEAR_SPEED = 1000;
/** Rotation limit per step (rad), like Box2D. */
const MAX_ROTATION_PER_STEP = 0.25 * Math.PI;
/** Contacts closer than this link bodies into one island (m). */
const ISLAND_CONTACT_DISTANCE = 0.01;

export interface WorldOptions {
  /** Gravity acceleration, m/s². */
  gravity: Vec3;
  /** Velocity iterations per step (Blender `solver_iterations`). */
  iterations: number;
  /** Penetration correction iterations per step (default: half the velocity iterations, ≥ 2). */
  positionIterations?: number;
  /** Let resting islands sleep (default true). */
  sleeping?: boolean;
}

const awakeDynamic = (b: Body) => b.mode === 'DYNAMIC' && b.awake;

/** Pairs worth a narrow phase test: a dynamic body involved and something moves. */
const pairFilter = (a: Body, b: Body) => (a.dynamic || b.dynamic) && (a.moving || b.moving);

export class PhysicsWorld {
  readonly bodies: readonly Body[];
  gravity: Vec3;
  iterations: number;
  positionIterations: number;
  sleeping: boolean;
  /** Steps taken so far. */
  steps = 0;
  private readonly sap = new SweepAndPrune();
  private readonly manifolds = new Map<number, Manifold>();
  private stamp = 0;
  private readonly parent: Int32Array;
  /** Per body: pose at the start of the step (blow-up recovery), x y z qx qy qz qw. */
  private readonly saved: Float64Array;
  /** Per body: kinematic target of the current step, x y z qx qy qz qw. */
  private readonly targets: Float64Array;
  private readonly contacts: ContactCandidate[] = [];

  constructor(bodies: Body[], opts: WorldOptions) {
    bodies.forEach((b, i) => {
      if (b.index !== i) throw new Error('body indices must match their order');
    });
    this.bodies = bodies;
    this.gravity = [...opts.gravity];
    this.iterations = Math.max(1, Math.round(opts.iterations));
    this.positionIterations = Math.max(
      1,
      Math.round(opts.positionIterations ?? Math.max(2, Math.ceil(this.iterations / 2))),
    );
    this.sleeping = opts.sleeping ?? true;
    this.parent = new Int32Array(bodies.length);
    this.saved = new Float64Array(bodies.length * 7);
    this.targets = new Float64Array(bodies.length * 7);
  }

  /** Persistent contact manifolds (for diagnostics and tests), ordered by pair. */
  contactManifolds(): Manifold[] {
    return [...this.manifolds.values()].sort((p, q) => p.key - q.key);
  }

  /**
   * Sets where a kinematic body must be at the end of the current frame. Within the frame the
   * body moves from its current pose along a straight line / shortest-arc rotation, so it pushes
   * dynamic bodies with a well-defined velocity (Blender interpolates kinematic substeps too).
   */
  setKinematicTarget(body: Body, position: Readonly<Vec3>, orientation: Readonly<Quat>): void {
    body.k0p = [body.px, body.py, body.pz];
    body.k0q = body.orientation;
    body.k1p = [position[0], position[1], position[2]];
    body.k1q = [orientation[0], orientation[1], orientation[2], orientation[3]];
  }

  /**
   * Advances the world by `dt` seconds. `alpha` (0..1] is how far through the current frame
   * the end of this step is (kinematic bodies reach `alpha` of the way to their target).
   */
  step(dt: number, alpha = 1): void {
    const bodies = this.bodies;
    this.stamp++;
    this.steps++;
    const t = Math.min(1, Math.max(0, alpha));
    if (!(dt > 0)) {
      // no simulated time passes (time_scale 0): kinematic bodies are placed directly
      for (const b of bodies)
        if (b.mode === 'KINEMATIC') {
          this.kinematicTarget(b, t);
          this.placeKinematic(b);
          b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
        }
      return;
    }
    this.integrateVelocities(dt, t);

    // ---- collision detection
    for (const b of bodies) b.updateBounds(b.margin, dt);
    const pairs = this.sap.pairs(bodies, pairFilter);
    const n = bodies.length;
    const contacts = this.contacts;
    for (const [ia, ib] of pairs) {
      const a = bodies[ia];
      const b = bodies[ib];
      const key = ia * n + ib;
      contacts.length = 0;
      collide(a, b, Math.max(a.margin, b.margin) + sweepDistance(a, b, dt), contacts);
      let m = this.manifolds.get(key);
      if (contacts.length === 0) {
        if (m) this.manifolds.delete(key);
        continue;
      }
      if (!m) {
        m = new Manifold(a, b, key);
        this.manifolds.set(key, m);
      }
      m.update(contacts, this.stamp);
    }
    // pairs that were not tested: gone apart (one of them moves) or resting (keep the contacts)
    for (const [key, m] of this.manifolds)
      if (m.stamp !== this.stamp && (m.a.moving || m.b.moving)) this.manifolds.delete(key);
    const list = this.contactManifolds();
    if (this.sleeping) this.buildIslands(list, true);

    // ---- velocity solver
    const active = list.filter((m) => awakeDynamic(m.a) || awakeDynamic(m.b));
    for (const m of active) prepareManifold(m, dt);
    for (const m of active) warmStart(m);
    for (let it = 0; it < this.iterations; it++) for (const m of active) solveVelocity(m);
    for (const m of active) applyRestitution(m);

    // ---- positions
    this.integratePositions(dt);
    for (let it = 0; it < this.positionIterations; it++) {
      let minSep = 0;
      for (const m of active) minSep = Math.min(minSep, solvePosition(m));
      if (minSep >= -3 * LINEAR_SLOP) break;
    }
    for (const b of bodies) if (awakeDynamic(b)) b.updateWorldInertia();
    this.recoverBlowUps();
    if (this.sleeping) this.updateSleep(list, dt);
  }

  // ---------------------------------------------------------------- integration

  private kinematicTarget(b: Body, t: number): void {
    const o = b.index * 7;
    const tg = this.targets;
    for (let k = 0; k < 3; k++) tg[o + k] = b.k0p[k] + (b.k1p[k] - b.k0p[k]) * t;
    const q = t >= 1 ? b.k1q : slerpQ(b.k0q, b.k1q, t);
    tg[o + 3] = q[0];
    tg[o + 4] = q[1];
    tg[o + 5] = q[2];
    tg[o + 6] = q[3];
  }

  private placeKinematic(b: Body): void {
    const o = b.index * 7;
    const tg = this.targets;
    b.setPose([tg[o], tg[o + 1], tg[o + 2]], [tg[o + 3], tg[o + 4], tg[o + 5], tg[o + 6]]);
  }

  private integrateVelocities(dt: number, t: number): void {
    const [gx, gy, gz] = this.gravity;
    const tg = this.targets;
    for (const b of this.bodies) {
      if (b.mode === 'KINEMATIC') {
        // the velocity that carries the body to this step's target (used by contacts)
        this.kinematicTarget(b, t);
        const o = b.index * 7;
        b.vx = (tg[o] - b.px) / dt;
        b.vy = (tg[o + 1] - b.py) / dt;
        b.vz = (tg[o + 2] - b.pz) / dt;
        const w = angularVelocityBetween(b.orientation, [tg[o + 3], tg[o + 4], tg[o + 5], tg[o + 6]], dt);
        b.wx = w[0];
        b.wy = w[1];
        b.wz = w[2];
        continue;
      }
      if (!awakeDynamic(b)) continue;
      b.vx += gx * dt;
      b.vy += gy * dt;
      b.vz += gz * dt;
      // Bullet's damping: the fraction of velocity lost per second
      const ld = Math.pow(1 - b.linearDamping, dt);
      const ad = Math.pow(1 - b.angularDamping, dt);
      b.vx *= ld;
      b.vy *= ld;
      b.vz *= ld;
      b.wx *= ad;
      b.wy *= ad;
      b.wz *= ad;
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      if (speed > MAX_LINEAR_SPEED) {
        const k = MAX_LINEAR_SPEED / speed;
        b.vx *= k;
        b.vy *= k;
        b.vz *= k;
      }
    }
  }

  private integratePositions(dt: number): void {
    const saved = this.saved;
    for (const b of this.bodies) {
      const o = b.index * 7;
      saved[o] = b.px;
      saved[o + 1] = b.py;
      saved[o + 2] = b.pz;
      saved[o + 3] = b.qx;
      saved[o + 4] = b.qy;
      saved[o + 5] = b.qz;
      saved[o + 6] = b.qw;
      if (b.mode === 'KINEMATIC') {
        this.placeKinematic(b);
        continue;
      }
      if (!awakeDynamic(b)) continue;
      let w = Math.hypot(b.wx, b.wy, b.wz);
      if (w * dt > MAX_ROTATION_PER_STEP) {
        const k = MAX_ROTATION_PER_STEP / (w * dt);
        b.wx *= k;
        b.wy *= k;
        b.wz *= k;
        w *= k;
      }
      b.px += b.vx * dt;
      b.py += b.vy * dt;
      b.pz += b.vz * dt;
      const angle = w * dt;
      if (angle > 1e-15) {
        // exact rotation by the angle-axis ω·dt: q ← Δq ⊗ q
        const s = Math.sin(angle / 2) / w;
        const dx = b.wx * s;
        const dy = b.wy * s;
        const dz = b.wz * s;
        const dw = Math.cos(angle / 2);
        const { qx, qy, qz, qw } = b;
        b.qx = dw * qx + dx * qw + dy * qz - dz * qy;
        b.qy = dw * qy - dx * qz + dy * qw + dz * qx;
        b.qz = dw * qz + dx * qy - dy * qx + dz * qw;
        b.qw = dw * qw - dx * qx - dy * qy - dz * qz;
        b.updateRotation();
      }
    }
  }

  /** Bodies whose state became non-finite go back to the start of the step, at rest. */
  private recoverBlowUps(): void {
    const saved = this.saved;
    for (const b of this.bodies) {
      if (b.mode !== 'DYNAMIC') continue;
      const ok =
        Number.isFinite(b.px + b.py + b.pz + b.qx + b.qy + b.qz + b.qw) &&
        Number.isFinite(b.vx + b.vy + b.vz + b.wx + b.wy + b.wz);
      if (ok) continue;
      const o = b.index * 7;
      b.setPose(
        [saved[o], saved[o + 1], saved[o + 2]],
        [saved[o + 3], saved[o + 4], saved[o + 5], saved[o + 6]],
      );
      b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
      b.updateWorldInertia();
    }
  }

  // ---------------------------------------------------------------- islands and sleeping

  private find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }

  /**
   * Groups dynamic bodies connected by touching contacts into islands; with `wake`, islands
   * containing an awake body (or touching a moving kinematic body) wake up as a whole.
   */
  private buildIslands(list: readonly Manifold[], wake: boolean): void {
    const p = this.parent;
    for (let i = 0; i < p.length; i++) p[i] = i;
    for (const m of list) {
      if (!(m.a.dynamic && m.b.dynamic) || !touching(m)) continue;
      const ra = this.find(m.a.index);
      const rb = this.find(m.b.index);
      if (ra !== rb) p[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    if (!wake) return;
    const awake = new Uint8Array(p.length);
    for (const b of this.bodies) if (awakeDynamic(b)) awake[this.find(b.index)] = 1;
    for (const m of list) {
      if (!touching(m)) continue;
      if (m.a.mode === 'KINEMATIC' && m.a.moving && m.b.dynamic) awake[this.find(m.b.index)] = 1;
      if (m.b.mode === 'KINEMATIC' && m.b.moving && m.a.dynamic) awake[this.find(m.a.index)] = 1;
    }
    for (const b of this.bodies)
      if (b.dynamic && !b.awake && awake[this.find(b.index)]) {
        b.awake = true;
        b.sleepTime = 0;
      }
  }

  private updateSleep(list: readonly Manifold[], dt: number): void {
    const lin2 = SLEEP_LINEAR_SPEED * SLEEP_LINEAR_SPEED;
    const ang2 = SLEEP_ANGULAR_SPEED * SLEEP_ANGULAR_SPEED;
    for (const b of this.bodies) {
      if (!awakeDynamic(b)) continue;
      const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
      const w2 = b.wx * b.wx + b.wy * b.wy + b.wz * b.wz;
      b.sleepTime = v2 > lin2 || w2 > ang2 ? 0 : b.sleepTime + dt;
    }
    // bodies carried or pushed by animated bodies stay awake
    for (const m of list) {
      if (!touching(m)) continue;
      if (m.a.mode === 'KINEMATIC' && m.a.moving) m.b.sleepTime = 0;
      if (m.b.mode === 'KINEMATIC' && m.b.moving) m.a.sleepTime = 0;
    }
    const minSleep = new Float64Array(this.bodies.length).fill(Infinity);
    for (const b of this.bodies) {
      if (!b.dynamic) continue;
      const r = this.find(b.index);
      // a sleeping member counts as rested
      minSleep[r] = Math.min(minSleep[r], b.awake ? b.sleepTime : Infinity);
    }
    for (const b of this.bodies) {
      if (!awakeDynamic(b) || minSleep[this.find(b.index)] < TIME_TO_SLEEP) continue;
      b.awake = false;
      b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
    }
  }
}

/** True when a manifold has a contact that (nearly) touches or pushed last step. */
function touching(m: Manifold): boolean {
  for (const p of m.points) if (p.s <= ISLAND_CONTACT_DISTANCE || p.normalImpulse > 0) return true;
  return false;
}

/** Upper bound of how far the surfaces of a and b can approach each other during dt. */
function sweepDistance(a: Body, b: Body, dt: number): number {
  const lin = Math.hypot(b.vx - a.vx, b.vy - a.vy, b.vz - a.vz);
  const ang =
    Math.hypot(a.wx, a.wy, a.wz) * a.boundingRadius + Math.hypot(b.wx, b.wy, b.wz) * b.boundingRadius;
  return (lin + ang) * dt;
}
