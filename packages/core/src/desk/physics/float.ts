import type { Mat4, Quat, Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import { buildCollisionShape, cachedCollisionShape } from '../../physics/shapes';
import { shapeKey } from '../../physics/simulation';
import { sanitizeRigidBody } from '../../physics/settings';
import {
  angularVelocityBetween,
  composeRigid,
  decomposeRigid,
  mat3ToQuat,
  mulQ,
  normalizeQ,
  quatToMat3,
  type Mat3,
} from '../../physics/vmath';
import { WATER_LEVEL_M, WATER_TOUCH_M, WATER_UNDER_M, waterAt, type WaterHit } from '../water';

/*
 * Bodies that reach water float (desk.physics_bake's water: 'float', its default). The simulation
 * knows no water: the desk's lakes are flat surfaces at the ground's height, so a ball rolls over a
 * lake as over grass. The bake follows each simulated body and, from the frame its centre comes over
 * a water piece (desk/water.ts) with its bottom at the surface (WATER_TOUCH_M; or reaching it by the
 * next frame, so that a fall the simulation bounces off the ground under the water between two
 * frames still ends in the water), replaces its motion with floating: the impact takes its speed
 * beyond FLOAT_ENTRY_MPS, its horizontal speed decays (FLOAT_DRIFT_S) and stops at the water's edge,
 * its centre eases to where it floats (FLOAT_DEPTH_RADII under the surface, but never deeper than
 * FLOAT_TOP_SHARE of the height its top stands above its centre, so a frisbee's or a book's top stays
 * above the water; a body denser than water sinks to SINK_DEPTH_RADII under it over about a second),
 * it bobs a little (FLOAT_BOB_M at FLOAT_BOB_HZ, floating bodies only, never so much that its top
 * goes under), its spin dies down (FLOAT_SPIN_S) and a flat floating body (FLAT_RATIO) turns to lie
 * flat on the water (FLOAT_TILT_S). Its density is the rigid body's mass over the volume of its
 * collision shape (the shape the simulation builds), its radius the shape's (a sphere's own, else that
 * of the sphere of the same volume). The motion depends on the entry alone (and the water's
 * footprint), so the same bake gives the same keys.
 */

/** What desk.physics_bake does where bodies reach water: float there (default) or move on as simulated. */
export const DESK_BAKE_WATER = ['float', 'ignore'] as const;
export type DeskBakeWater = (typeof DESK_BAKE_WATER)[number];

/**
 * Fastest a body moves on in the water (m/s, horizontally and vertically): the impact takes the rest,
 * so a body drifts at most FLOAT_ENTRY_MPS × FLOAT_DRIFT_S = 1.4 m from where it touches the water
 * (its entry frame may come up to a frame before that touch, the body still flying in it).
 */
export const FLOAT_ENTRY_MPS = 2;
/** Time constant (s) of a floating body's horizontal speed: it drifts about speed × 0.7 s on. */
export const FLOAT_DRIFT_S = 0.7;
/** Time constant (s) of a floating body's spin. */
export const FLOAT_SPIN_S = 0.5;
/** How deep the centre of a body lighter than water floats under the surface, in radii … */
export const FLOAT_DEPTH_RADII = 0.25;
/**
 * … but never deeper than this share of the height its top stands above its centre as it floats: a
 * flat body (a frisbee, a book, a plank) shows its top above the water, as a ball does.
 */
export const FLOAT_TOP_SHARE = 0.5;
/** A floating body whose thinnest extent is at most this share of its largest is flat: it lies flat on the water … */
export const FLAT_RATIO = 0.5;
/** … turning to it with this time constant (s). */
export const FLOAT_TILT_S = 0.5;
/** How deep a body denser than water sinks under the surface, in radii. */
export const SINK_DEPTH_RADII = 2;
/** Density of water (kg/m³): bodies denser than it sink. */
export const WATER_DENSITY = 1000;
/** Largest bob of a floating body (m; a quarter of its radius for small ones) … */
export const FLOAT_BOB_M = 0.015;
/** … and its frequency (Hz). */
export const FLOAT_BOB_HZ = 0.5;
/** Seconds of floating a bake to the simulation's end keys at least (the drift and the spin are over by then). */
export const FLOAT_SETTLE_S = 3;

/** Angular frequency (1/s) of the critically damped ease to the floating depth (settled in about 0.6 s) … */
const FLOAT_OMEGA = 8;
/** … and to the sinking depth (about a second). */
const SINK_OMEGA = 4;
/** Seconds the bob takes to grow at the entry and to die out at the end of the float. */
const BOB_FADE_S = 0.6;
/** Vertices of a body's mesh beyond which its bottom is taken from the corners of its bounds. */
const BOTTOM_VERTICES_MAX = 4096;

/** The water entry of a body: where, when, and what it floats as. */
export interface WaterEntry {
  /** First frame of floating motion. */
  frame: number;
  water: WaterHit;
  /** Denser than water: it sinks. */
  sinks: boolean;
}

/** A body's shape as the floating motion needs it. */
interface FloatShape {
  /** Centre of mass in scaled object coordinates (the body's origin offset). */
  com: Vec3;
  radius: number;
  density: number;
  /** Points whose lowest is the body's bottom (scaled object coordinates). */
  hull: Vec3[];
  /** Its thinnest axis (0, 1, 2: x, y, z of the object) when it is flat (FLAT_RATIO), else -1. */
  thin: number;
}

/**
 * The shape of body `o` (its rigid body and mesh) at world scale `scale`, as the simulation builds it;
 * null when it has none (no mesh, a shape the simulation refuses).
 */
function floatShape(doc: SceneDoc, o: ObjectData, scale: Readonly<Vec3>): FloatShape | null {
  const rb = sanitizeRigidBody(o.rigid_body);
  const mesh = o.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
  if (!rb || !mesh || mesh.positions.length < 3) return null;
  const built = cachedCollisionShape(shapeKey(mesh, rb, scale), mesh, () =>
    buildCollisionShape(rb.collision_shape, mesh, scale, { dynamic: true }),
  );
  if ('error' in built || !(built.volume > 0)) return null;
  const radius =
    built.shape.kind === 'sphere' ? built.shape.radius : Math.cbrt((3 * built.volume) / (4 * Math.PI));
  const P = mesh.positions;
  const n = Math.floor(P.length / 3);
  const hull: Vec3[] = [];
  if (n <= BOTTOM_VERTICES_MAX)
    for (let i = 0; i < n; i++)
      hull.push([P[i * 3] * scale[0], P[i * 3 + 1] * scale[1], P[i * 3 + 2] * scale[2]]);
  else {
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], P[i * 3 + k] * scale[k]);
        hi[k] = Math.max(hi[k], P[i * 3 + k] * scale[k]);
      }
    for (let c = 0; c < 8; c++)
      hull.push([c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  }
  // its extent along each of its own axes: the thinnest, when much thinner than the largest, is
  // the one a floating body lies flat across
  const extent = [0, 1, 2].map((k) => {
    let a = Infinity;
    let b = -Infinity;
    for (const v of hull) {
      a = Math.min(a, v[k]);
      b = Math.max(b, v[k]);
    }
    return b - a;
  });
  const largest = Math.max(...extent);
  const k = extent.indexOf(Math.min(...extent));
  const thin = largest > 0 && extent[k] <= FLAT_RATIO * largest ? k : -1;
  return { com: [...built.com], radius, density: rb.mass / built.volume, hull, thin };
}

/** The rotation that turns unit `a` onto unit `b` (the shortest one). */
function turnOnto(a: Readonly<Vec3>, b: Readonly<Vec3>): Quat {
  const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  let axis: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  if (l < 1e-9) {
    if (c > 0) return [0, 0, 0, 1];
    // opposite: about any axis across `a`
    axis = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]];
  }
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  return axisAngle([axis[0] / n, axis[1] / n, axis[2] / n], Math.acos(c));
}

/**
 * The turn that lays flat body `shape` flat at orientation `q`: its thinnest axis onto the vertical
 * (up or down, whichever is nearer), as an axis and an angle; null for a body that is not flat or
 * already lies flat.
 */
function flatTurn(shape: FloatShape, q: Quat): { axis: Vec3; angle: number } | null {
  if (shape.thin < 0) return null;
  const r = quatToMat3(q);
  const a: Vec3 = [r[shape.thin], r[3 + shape.thin], r[6 + shape.thin]];
  const t = turnOnto(a, [0, 0, a[2] >= 0 ? 1 : -1]);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(t[3])));
  const s = Math.hypot(t[0], t[1], t[2]);
  if (!(angle > 1e-6) || s < 1e-12) return null;
  const sign = t[3] < 0 ? -1 : 1;
  return { axis: [(sign * t[0]) / s, (sign * t[1]) / s, (sign * t[2]) / s], angle };
}

/** The height of body `shape`'s top above its centre of mass at orientation `q`. */
function topAbove(shape: FloatShape, q: Quat): number {
  const r = quatToMat3(q);
  let top = 0;
  for (const v of shape.hull) {
    const d: Vec3 = [v[0] - shape.com[0], v[1] - shape.com[1], v[2] - shape.com[2]];
    top = Math.max(top, r[6] * d[0] + r[7] * d[1] + r[8] * d[2]);
  }
  return top;
}

/** `r` · `v` (`r` row-major, as physics/vmath.ts keeps rotations). */
const apply = (r: Readonly<Mat3>, v: Readonly<Vec3>): Vec3 => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];

/** The centre of mass of a body whose world matrix decomposes into `position` and `rotation`. */
const centreOf = (position: Readonly<Vec3>, rotation: Readonly<Mat3>, com: Readonly<Vec3>): Vec3 => {
  const o = apply(rotation, com);
  return [position[0] + o[0], position[1] + o[1], position[2] + o[2]];
};

/** Rotation of `angle` radians about unit `axis`. */
function axisAngle(axis: Readonly<Vec3>, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** How a bake runs a body's floating motion. */
export interface BodyFloatOptions {
  /** The first frame the simulation moves the body (before it, it is held or animated). */
  release: number;
  /** Seconds of simulation per frame (the world's time_scale / fps). */
  dt: number;
  /** Downward acceleration of gravity (m/s²; 0 without gravity). */
  gravity: number;
  /** The last frame the bake keys once the body floats from frame `entry` (its bob dies out towards it). */
  end: (entry: number) => number;
}

/** A body's floating motion from its entry (times in seconds of simulation after the entry frame). */
interface Floating {
  entry: WaterEntry;
  q0: Quat;
  scale: Vec3;
  /** When its bottom reaches the surface (0: at the entry), falling on until then. */
  touch: number;
  /** Centre height and vertical velocity at the entry. */
  z0: number;
  vz0: number;
  /** Horizontal velocity at the entry, and after the impact (at most FLOAT_ENTRY_MPS). */
  vx: number;
  vy: number;
  wx: number;
  wy: number;
  /** Centre on the floor now; stopped at the water's edge. */
  x: number;
  y: number;
  stopped: boolean;
  /** The ease from the touch: centre height = target + (a + b·s)·e^(−omega·s), s the time after it. */
  target: number;
  a: number;
  b: number;
  omega: number;
  spinAxis: Vec3;
  spinRate: number;
  /** The turn that lays a flat body flat where its spin leaves it (null: none), eased in after the touch. */
  tilt: { axis: Vec3; angle: number } | null;
  bob: number;
  /** Seconds from the touch to the end of the float (the bob dies out towards it). */
  span: number;
}

/**
 * Follows one simulated body through a bake and gives the world matrix to key at each frame: the
 * simulated one until the body reaches water, floating motion from there on (see the module comment).
 */
export class BodyFloat {
  private readonly shape: FloatShape | null;
  private prev: { frame: number; world: Mat4 } | null = null;
  private float: Floating | null = null;

  /** `o`: the body (with its rigid body); `world0`: its world matrix where the bake starts (its scale builds the shape). */
  constructor(
    private readonly doc: SceneDoc,
    o: ObjectData,
    world0: Readonly<Mat4>,
    private readonly opts: BodyFloatOptions,
  ) {
    this.shape = floatShape(doc, o, decomposeRigid(world0).scale);
  }

  /** Where the body entered water (null: it has not). */
  get entry(): WaterEntry | null {
    return this.float?.entry ?? null;
  }

  /**
   * The world matrix to key at `frame` (called for each frame in order) for the simulated `world`
   * (null past the simulation's end: a floating body floats on, any other gives null).
   */
  step(frame: number, world: Readonly<Mat4> | null): Mat4 | null {
    if (!this.float && world && this.shape && frame >= this.opts.release) this.enter(frame, world);
    const out = this.float ? this.floating(frame) : world ? ([...world] as Mat4) : null;
    if (world) this.prev = { frame, world: [...world] as Mat4 };
    return out;
  }

  /**
   * Starts floating at `frame` when the body's centre is over water and its bottom at the surface,
   * or reaching it by the next frame (a fall the simulation would bounce off the ground under the
   * water between two frames).
   */
  private enter(frame: number, world: Readonly<Mat4>): void {
    const shape = this.shape!;
    const { dt, gravity } = this.opts;
    const { position, rotation, scale } = decomposeRigid(world);
    const c = centreOf(position, rotation, shape.com);
    // no water under the centre at all: most frames of most bodies end here
    if (!waterAt(this.doc, [c[0], c[1], c[2] - shape.radius], frame)) return;
    let low = Infinity;
    let high = -Infinity;
    for (const v of shape.hull) {
      const z = rotation[6] * v[0] + rotation[7] * v[1] + rotation[8] * v[2];
      low = Math.min(low, z);
      high = Math.max(high, z);
    }
    const bottom = position[2] + low;
    // the surface nearest the bottom (a fountain's basin, not its bowl above)
    const water = waterAt(this.doc, [c[0], c[1], bottom], frame);
    if (!water || position[2] + high < water.surface_z - WATER_UNDER_M) return;
    const q = mat3ToQuat(rotation);
    // its motion over the last frame (none for a body the bake starts in water)
    let v: Vec3 = [0, 0, 0];
    let spinAxis: Vec3 = [0, 0, 1];
    let spinRate = 0;
    const p = this.prev;
    if (p && frame > p.frame && dt > 0) {
      const t = (frame - p.frame) * dt;
      const d = decomposeRigid(p.world);
      const pc = centreOf(d.position, d.rotation, shape.com);
      v = [(c[0] - pc[0]) / t, (c[1] - pc[1]) / t, (c[2] - pc[2]) / t];
      const w = angularVelocityBetween(mat3ToQuat(d.rotation), q, t);
      spinRate = Math.hypot(w[0], w[1], w[2]);
      if (spinRate > 1e-9) spinAxis = [w[0] / spinRate, w[1] / spinRate, w[2] / spinRate];
      else spinRate = 0;
    }
    const height = bottom - water.surface_z;
    if (Math.min(height, height + v[2] * dt) > WATER_TOUCH_M) return;
    // still above the surface: it falls on (at most a frame) until its bottom reaches it
    let touch = 0;
    if (height > 0) {
      const fall =
        gravity > 0 ? (v[2] + Math.sqrt(v[2] * v[2] + 2 * gravity * height)) / gravity : -height / v[2];
      touch = Math.min(dt, Number.isFinite(fall) && fall > 0 ? fall : dt);
    }
    const zTouch = c[2] + v[2] * touch - 0.5 * gravity * touch * touch;
    const vzTouch = Math.max(-FLOAT_ENTRY_MPS, Math.min(FLOAT_ENTRY_MPS, v[2] - gravity * touch));
    const across = Math.hypot(v[0], v[1]);
    const keep = across > FLOAT_ENTRY_MPS ? FLOAT_ENTRY_MPS / across : 1;
    const sinks = shape.density > WATER_DENSITY;
    // where its spin leaves it, a flat floating body laid flat: how it rests on the water
    const spun = normalizeQ(mulQ(axisAngle(spinAxis, spinRate * (touch + FLOAT_SPIN_S)), q));
    const tilt = sinks ? null : flatTurn(shape, spun);
    const rest = tilt ? normalizeQ(mulQ(axisAngle(tilt.axis, tilt.angle), spun)) : spun;
    const up = topAbove(shape, rest);
    const depth = sinks
      ? SINK_DEPTH_RADII * shape.radius
      : Math.min(FLOAT_DEPTH_RADII * shape.radius, FLOAT_TOP_SHARE * up);
    const target = water.surface_z - depth;
    const omega = sinks ? SINK_OMEGA : FLOAT_OMEGA;
    this.float = {
      entry: { frame, water, sinks },
      q0: q,
      scale,
      touch,
      z0: c[2],
      vz0: v[2],
      vx: v[0],
      vy: v[1],
      wx: v[0] * keep,
      wy: v[1] * keep,
      x: c[0],
      y: c[1],
      stopped: false,
      target,
      a: zTouch - target,
      b: vzTouch + omega * (zTouch - target),
      omega,
      spinAxis,
      spinRate,
      tilt,
      // a bob that never takes its top under the surface
      bob: sinks ? 0 : Math.min(FLOAT_BOB_M, shape.radius / 4, Math.max(0, (up - depth) / 2)),
      span: (this.opts.end(frame) - frame) * dt - touch,
    };
  }

  /** Horizontal distance the floating body covers from `t0` to `t1` seconds after its entry. */
  private drift(t0: number, t1: number): [number, number] {
    const f = this.float!;
    // in the air until it touches the water, at its entry speed
    const air = Math.max(0, Math.min(t1, f.touch) - t0);
    // in the water, at the speed the impact left decaying: the exact distance of an exponential decay
    const from = Math.max(t0, f.touch) - f.touch;
    const to = t1 - f.touch;
    const wet =
      to > from ? FLOAT_DRIFT_S * (Math.exp(-from / FLOAT_DRIFT_S) - Math.exp(-to / FLOAT_DRIFT_S)) : 0;
    return [f.vx * air + f.wx * wet, f.vy * air + f.wy * wet];
  }

  /** The floating body's world matrix at `frame` (called for each frame in order from the entry on). */
  private floating(frame: number): Mat4 {
    const f = this.float!;
    const shape = this.shape!;
    const { dt, gravity } = this.opts;
    const t = (frame - f.entry.frame) * dt;
    if (frame > f.entry.frame && !f.stopped) {
      // it drifts on over the water piece it came into, and stops at its edge
      const [dx, dy] = this.drift(t - dt, t);
      const at = waterAt(this.doc, [f.x + dx, f.y + dy, f.entry.water.surface_z], frame, {
        level: WATER_LEVEL_M,
      });
      if (at && at.id === f.entry.water.id) {
        f.x += dx;
        f.y += dy;
      } else f.stopped = true;
    }
    // falling on until the touch, then easing to its depth (critically damped) with a bob
    const s = t - f.touch;
    let z: number;
    if (s < 0) z = f.z0 + f.vz0 * t - 0.5 * gravity * t * t;
    else {
      const envelope = (1 - Math.exp(-s / BOB_FADE_S)) * Math.min(1, Math.max(0, (f.span - s) / BOB_FADE_S));
      z =
        f.target +
        (f.a + f.b * s) * Math.exp(-f.omega * s) +
        f.bob * envelope * Math.sin(2 * Math.PI * FLOAT_BOB_HZ * s);
    }
    // the spin goes on in the air and dies down in the water, where a flat body turns to lie flat
    const angle =
      f.spinRate * (Math.min(t, f.touch) + FLOAT_SPIN_S * (1 - Math.exp(-Math.max(0, s) / FLOAT_SPIN_S)));
    let q = mulQ(axisAngle(f.spinAxis, angle), f.q0);
    if (f.tilt && s > 0)
      q = mulQ(axisAngle(f.tilt.axis, f.tilt.angle * (1 - Math.exp(-s / FLOAT_TILT_S))), q);
    const r = quatToMat3(normalizeQ(q));
    const offset = apply(r, shape.com);
    return composeRigid([f.x - offset[0], f.y - offset[1], z - offset[2]], r, f.scale);
  }
}
