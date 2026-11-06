import type { Quat, Vec3 } from '../math/types';
import type { CollisionShape } from '../doc/types';
import type { MotionMode } from './settings';
import type { Shape } from './shapes';
import { boundingRadius, coreRadius, shapeBounds, thinHalfExtent } from './shapes';
import { invert3, quatToMat3, rotateTensor, type Mat3 } from './vmath';

/*
 * A simulated rigid body. The body origin is its centre of mass; `com` maps it back to the
 * object's origin (object = body · translate(-com) · scale). Hot solver state is kept in plain
 * number fields.
 */

export interface BodyInit {
  id: string;
  index: number;
  shape: Shape;
  shapeType: CollisionShape;
  /** Centre of mass in scaled object coordinates. */
  com: Vec3;
  /** World scale of the object at frame_start (signed). */
  scale: Vec3;
  /** Inertia about the centre of mass for 1 kg (body axes). */
  unitInertia: Mat3;
  mode: MotionMode;
  mass: number;
  friction: number;
  restitution: number;
  margin: number;
  linearDamping: number;
  angularDamping: number;
  position: Vec3;
  orientation: Quat;
}

export class Body {
  readonly id: string;
  readonly index: number;
  readonly shape: Shape;
  readonly shapeType: CollisionShape;
  readonly com: Vec3;
  readonly scale: Vec3;
  readonly unitInertia: Mat3;
  /** Core radius (spheres / capsules) and radius of an origin-centred bounding sphere. */
  readonly radius: number;
  readonly boundingRadius: number;
  /** Half thickness in the thinnest direction (Infinity for triangle meshes), see `thinHalfExtent`. */
  readonly thinHalf: number;
  /** Body-space bounds of the shape (for the narrow phase against triangle meshes). */
  readonly localMin: Vec3;
  readonly localMax: Vec3;

  mode: MotionMode;
  mass = 0;
  invMass = 0;
  inertia: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  invInertiaLocal: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  invInertiaWorld: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  friction: number;
  restitution: number;
  margin: number;
  linearDamping: number;
  angularDamping: number;

  // pose
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  R: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // velocities (world)
  vx = 0;
  vy = 0;
  vz = 0;
  wx = 0;
  wy = 0;
  wz = 0;
  // fattened world bounds
  minX = 0;
  minY = 0;
  minZ = 0;
  maxX = 0;
  maxY = 0;
  maxZ = 0;
  // sleeping (dynamic bodies): asleep bodies are not integrated until their island is touched
  awake = true;
  /** Seconds the body has been slower than the sleep thresholds. */
  sleepTime = 0;
  // kinematic targets of the current frame (start and end pose)
  k0p: Vec3 = [0, 0, 0];
  k0q: Quat = [0, 0, 0, 1];
  k1p: Vec3 = [0, 0, 0];
  k1q: Quat = [0, 0, 0, 1];

  constructor(init: BodyInit) {
    this.id = init.id;
    this.index = init.index;
    this.shape = init.shape;
    this.shapeType = init.shapeType;
    this.com = init.com;
    this.scale = init.scale;
    this.unitInertia = init.unitInertia;
    this.radius = coreRadius(init.shape);
    this.boundingRadius = boundingRadius(init.shape);
    this.thinHalf = thinHalfExtent(init.shape);
    const b = shapeBounds(init.shape);
    this.localMin = b.min;
    this.localMax = b.max;
    this.mode = init.mode;
    this.friction = init.friction;
    this.restitution = init.restitution;
    this.margin = init.margin;
    this.linearDamping = init.linearDamping;
    this.angularDamping = init.angularDamping;
    [this.px, this.py, this.pz] = init.position;
    [this.qx, this.qy, this.qz, this.qw] = init.orientation;
    this.updateRotation();
    this.setMass(init.mass);
    this.k0p = [...init.position];
    this.k1p = [...init.position];
    this.k0q = [...init.orientation];
    this.k1q = [...init.orientation];
  }

  get dynamic(): boolean {
    return this.mode === 'DYNAMIC';
  }

  /** Mass (kg) and inertia; non-dynamic bodies get zero inverse mass. */
  setMass(mass: number): void {
    this.mass = mass;
    const ui = this.unitInertia;
    this.inertia = ui.map((v) => v * mass);
    let inv = invert3(this.inertia);
    if (!inv || !inv.every(Number.isFinite)) {
      // degenerate inertia (collapsed shapes): regularise with a small sphere-like term
      const reg = mass * 1e-6 + 1e-12;
      inv = invert3(this.inertia.map((v, i) => (i % 4 === 0 ? v + reg : v))) ?? [0, 0, 0, 0, 0, 0, 0, 0, 0];
    }
    this.invInertiaLocal = inv;
    this.updateMassState();
  }

  /** Recomputes inverse mass / inertia after a mode change. */
  updateMassState(): void {
    this.invMass = this.dynamic && this.mass > 0 ? 1 / this.mass : 0;
    this.updateWorldInertia();
  }

  updateRotation(): void {
    let l = Math.hypot(this.qx, this.qy, this.qz, this.qw);
    if (!(l > 1e-12) || !Number.isFinite(l)) {
      this.qx = this.qy = this.qz = 0;
      this.qw = 1;
      l = 1;
    }
    this.qx /= l;
    this.qy /= l;
    this.qz /= l;
    this.qw /= l;
    quatToMat3([this.qx, this.qy, this.qz, this.qw], this.R);
  }

  updateWorldInertia(): void {
    if (!this.dynamic) {
      this.invInertiaWorld.fill(0);
      return;
    }
    rotateTensor(this.R, this.invInertiaLocal, this.invInertiaWorld);
  }

  /** World bounds fattened by `extra` (and by the distance travelled in dt for moving bodies). */
  updateBounds(extra: number, dt: number): void {
    const R = this.R;
    const cx = (this.localMin[0] + this.localMax[0]) / 2;
    const cy = (this.localMin[1] + this.localMax[1]) / 2;
    const cz = (this.localMin[2] + this.localMax[2]) / 2;
    const ex = (this.localMax[0] - this.localMin[0]) / 2;
    const ey = (this.localMax[1] - this.localMin[1]) / 2;
    const ez = (this.localMax[2] - this.localMin[2]) / 2;
    const wx = this.px + R[0] * cx + R[1] * cy + R[2] * cz;
    const wy = this.py + R[3] * cx + R[4] * cy + R[5] * cz;
    const wz = this.pz + R[6] * cx + R[7] * cy + R[8] * cz;
    const hx = Math.abs(R[0]) * ex + Math.abs(R[1]) * ey + Math.abs(R[2]) * ez + extra;
    const hy = Math.abs(R[3]) * ex + Math.abs(R[4]) * ey + Math.abs(R[5]) * ez + extra;
    const hz = Math.abs(R[6]) * ex + Math.abs(R[7]) * ey + Math.abs(R[8]) * ez + extra;
    // sweep along the velocity (speculative contacts for fast bodies)
    const sx = this.vx * dt;
    const sy = this.vy * dt;
    const sz = this.vz * dt;
    const rot = Math.hypot(this.wx, this.wy, this.wz) * dt * this.boundingRadius;
    this.minX = wx - hx - rot + Math.min(0, sx);
    this.minY = wy - hy - rot + Math.min(0, sy);
    this.minZ = wz - hz - rot + Math.min(0, sz);
    this.maxX = wx + hx + rot + Math.max(0, sx);
    this.maxY = wy + hy + rot + Math.max(0, sy);
    this.maxZ = wz + hz + rot + Math.max(0, sz);
  }

  /** Pose quaternion [x, y, z, w]. */
  get orientation(): Quat {
    return [this.qx, this.qy, this.qz, this.qw];
  }

  setPose(p: Readonly<Vec3>, q: Readonly<Quat>): void {
    this.px = p[0];
    this.py = p[1];
    this.pz = p[2];
    this.qx = q[0];
    this.qy = q[1];
    this.qz = q[2];
    this.qw = q[3];
    this.updateRotation();
  }

  /** True when the body moves this step (dynamic and awake, or a moving kinematic body). */
  get moving(): boolean {
    if (this.mode === 'DYNAMIC') return this.awake;
    if (this.mode !== 'KINEMATIC') return false;
    return this.vx !== 0 || this.vy !== 0 || this.vz !== 0 || this.wx !== 0 || this.wy !== 0 || this.wz !== 0;
  }

  /** World position of the object's origin (the centre of mass offset removed). */
  objectOrigin(): Vec3 {
    const R = this.R;
    const [cx, cy, cz] = this.com;
    return [
      this.px - (R[0] * cx + R[1] * cy + R[2] * cz),
      this.py - (R[3] * cx + R[4] * cy + R[5] * cz),
      this.pz - (R[6] * cx + R[7] * cy + R[8] * cz),
    ];
  }
}
