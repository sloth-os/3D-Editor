import type { Mat4, Vec3 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { RigidBodyData } from '../doc/types';
import { Body } from './body';
import { meshKey } from './mesh-key';
import { buildCollisionShape, cachedCollisionShape, type ShapeBuild } from './shapes';
import { motionMode, simulatedFrameEnd, type WorldParams } from './settings';
import { PhysicsWorld } from './world';
import { composeRigid, decomposeRigid, isFiniteVec, mat3ToQuat, quatToMat3, slerpQ } from './vmath';

/*
 * One rigid body simulation run (Blender's point cache of a rigid body world): the bodies are
 * built from the scene at frame_start, then the world is stepped one frame at a time
 * (`substeps_per_frame` steps of time_scale / fps / substeps seconds each). The pose of every
 * ACTIVE, non-animated body is recorded per frame, so going back in time is a lookup.
 */

/** A problem with one rigid body object, reported instead of failing the evaluation. */
export interface RigidBodyIssue {
  objectId: string;
  /** 'ERROR': the object is left out of the simulation; 'WARNING': simulated with a fallback. */
  level: 'ERROR' | 'WARNING';
  message: string;
}

/** A rigid body object as read from the scene at frame_start. */
export interface BodyInput {
  id: string;
  /** Object name (orders bodies that start at the same pose, see `compareBodyOrder`). */
  name?: string;
  /** Validated rigid body settings. */
  rb: RigidBodyData;
  /** Unsimulated world matrix at frame_start (null when unavailable). */
  matrix: Mat4 | null;
  /** Object-space mesh the collision shape is built from (null for non-mesh objects). */
  mesh: MeshData | null;
}

/** Collision shapes (or the reason none could be built) by their inputs, see `shapeKey`. */
export type ShapeCache = Map<string, ShapeBuild | { error: string }>;

export interface SimulationOptions {
  /** Let resting bodies sleep (default true). */
  sleeping?: boolean;
  /**
   * An earlier simulation of the same scene whose collision shapes are reused where their inputs
   * are unchanged, so editing one body does not rebuild every shape: building a dense MESH
   * collider (triangulation, welding, BVH) can take seconds.
   */
  reuse?: Pick<Simulation, 'shapes' | 'spareShapes'> | null;
}

/**
 * Everything a collision shape is built from: the mesh content, the shape type, whether the body
 * is dynamic (MESH falls back to CONVEX_HULL) and the exact world scale at frame_start. Equal
 * keys give identical shapes, so reusing them keeps a simulation a pure function of its inputs.
 */
export function shapeKey(mesh: MeshData, rb: RigidBodyData, scale: Readonly<Vec3>): string {
  const dynamic = rb.type === 'ACTIVE' && !rb.kinematic;
  return `${meshKey(mesh)}|${rb.collision_shape}|${dynamic ? 1 : 0}|${scale[0]},${scale[1]},${scale[2]}`;
}

/** Matrix elements compared for the solver order: the translation first, then the rotation / scale. */
const ORDER_KEYS = [12, 13, 14, 0, 1, 2, 4, 5, 6, 8, 9, 10, 3, 7, 11, 15];

/**
 * Solver order of rigid bodies: by their world matrix at frame_start (location x, y, z first),
 * then by name and id for bodies that start at exactly the same pose. The order changes the result
 * of the sequential-impulse solver slightly; object ids are random, so ordering by id made two
 * builds of the same scene simulate differently. Ordered by their start poses, identical scenes
 * simulate identically whatever their object ids and names, and renaming changes nothing.
 */
export function compareBodyOrder(a: BodyInput, b: BodyInput): number {
  const ma = a.matrix;
  const mb = b.matrix;
  if (ma && mb) {
    for (const k of ORDER_KEYS) {
      const x = ma[k];
      const y = mb[k];
      if (x < y) return -1;
      if (x > y) return 1;
    }
  } else if (ma || mb) return ma ? -1 : 1;
  const na = a.name ?? a.id;
  const nb = b.name ?? b.id;
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class Simulation {
  readonly world: PhysicsWorld;
  readonly frameStart: number;
  /** Last frame that is simulated (later frames hold its state). */
  readonly frameEnd: number;
  readonly substeps: number;
  /** Length of one step in seconds. */
  readonly dt: number;
  readonly bodies: readonly Body[];
  /** Bodies whose transform the simulation drives (ACTIVE and not animated), in solver order. */
  readonly outputs: readonly Body[];
  /** Animated ("kinematic") bodies following their animation, in solver order. */
  readonly kinematic: readonly Body[];
  readonly issues: RigidBodyIssue[] = [];
  /** Collision shapes of this simulation's bodies, by `shapeKey`. */
  readonly shapes: ShapeCache = new Map();
  /**
   * Shapes of the simulation this one was built from that it does not use, kept for one more
   * generation (an undone removal or a setting switched back finds them again).
   */
  readonly spareShapes: ShapeCache = new Map();
  /** Last simulated frame (the world's state is the state at this frame). */
  current: number;
  /** Per frame (index = frame − frameStart): centre of mass xyz + quaternion xyzw of each output. */
  private readonly poses: Float64Array[] = [];
  /** Per frame: world matrices (16 per kinematic body) that drove the kinematic bodies. */
  private readonly kinematicInputs: (Float64Array | null)[] = [null];

  constructor(inputs: readonly BodyInput[], params: WorldParams, opts: SimulationOptions = {}) {
    this.frameStart = params.frameStart;
    this.frameEnd = simulatedFrameEnd(params);
    this.substeps = params.substeps;
    this.dt = params.timeScale / params.fps / params.substeps;
    this.current = this.frameStart;
    const bodies: Body[] = [];
    const sorted = [...inputs].sort(compareBodyOrder);
    const reuse = opts.reuse ?? null;
    for (const input of sorted) {
      const body = this.createBody(input, bodies.length, reuse);
      if (body) bodies.push(body);
    }
    if (reuse) for (const [k, v] of reuse.shapes) if (!this.shapes.has(k)) this.spareShapes.set(k, v);
    this.bodies = bodies;
    this.outputs = bodies.filter((b) => b.mode === 'DYNAMIC' || b.mode === 'FROZEN');
    this.kinematic = bodies.filter((b) => b.mode === 'KINEMATIC');
    this.world = new PhysicsWorld(bodies, {
      gravity: params.gravity,
      iterations: params.iterations,
      sleeping: opts.sleeping,
    });
    this.poses.push(this.capture());
  }

  private issue(objectId: string, level: RigidBodyIssue['level'], message: string): void {
    this.issues.push({ objectId, level, message });
  }

  private createBody(input: BodyInput, index: number, reuse: SimulationOptions['reuse'] | null): Body | null {
    const { id, rb, matrix, mesh } = input;
    if (!mesh) {
      this.issue(id, 'ERROR', 'rigid bodies need a mesh object; left out of the simulation');
      return null;
    }
    if (!matrix || matrix.length < 16 || !isFiniteVec(matrix)) {
      this.issue(
        id,
        'ERROR',
        'the object has no valid transform at the start frame; left out of the simulation',
      );
      return null;
    }
    const { position: origin, rotation: R, scale } = decomposeRigid(matrix);
    const key = shapeKey(mesh, rb, scale);
    let built = this.shapes.get(key) ?? reuse?.shapes.get(key) ?? reuse?.spareShapes.get(key);
    built ??= cachedCollisionShape(key, mesh, () =>
      buildCollisionShape(rb.collision_shape, mesh, scale, {
        dynamic: rb.type === 'ACTIVE' && !rb.kinematic,
      }),
    );
    this.shapes.set(key, built);
    if ('error' in built) {
      this.issue(id, 'ERROR', `${built.error}; left out of the simulation`);
      return null;
    }
    for (const note of built.notes) this.issue(id, 'WARNING', note);
    const c = built.com;
    return new Body({
      id,
      index,
      shape: built.shape,
      shapeType: built.type,
      com: c,
      scale,
      unitInertia: built.inertia,
      mode: motionMode(rb),
      mass: rb.mass,
      friction: rb.friction,
      restitution: rb.restitution,
      margin: rb.collision_margin,
      linearDamping: rb.linear_damping,
      angularDamping: rb.angular_damping,
      position: [
        origin[0] + R[0] * c[0] + R[1] * c[1] + R[2] * c[2],
        origin[1] + R[3] * c[0] + R[4] * c[1] + R[5] * c[2],
        origin[2] + R[6] * c[0] + R[7] * c[1] + R[8] * c[2],
      ],
      orientation: mat3ToQuat(R),
    });
  }

  private capture(): Float64Array {
    const out = new Float64Array(this.outputs.length * 7);
    this.outputs.forEach((b, i) => {
      out.set([b.px, b.py, b.pz, b.qx, b.qy, b.qz, b.qw], i * 7);
    });
    return out;
  }

  /**
   * Simulates the next frame. `transforms` are the unsimulated world matrices at that frame
   * (needed when there are animated bodies; missing or invalid ones keep the body in place).
   */
  advance(transforms: ReadonlyMap<string, Mat4> | null): void {
    if (this.kinematic.length) {
      const record = new Float64Array(this.kinematic.length * 16).fill(NaN);
      this.kinematic.forEach((b, i) => {
        const m = transforms?.get(b.id);
        if (m) for (let k = 0; k < 16; k++) record[i * 16 + k] = m[k];
        if (!m || m.length < 16 || !isFiniteVec(m)) {
          this.world.setKinematicTarget(b, [b.px, b.py, b.pz], b.orientation);
          return;
        }
        const { position: o, rotation: R } = decomposeRigid(m);
        const c = b.com;
        this.world.setKinematicTarget(
          b,
          [
            o[0] + R[0] * c[0] + R[1] * c[1] + R[2] * c[2],
            o[1] + R[3] * c[0] + R[4] * c[1] + R[5] * c[2],
            o[2] + R[6] * c[0] + R[7] * c[1] + R[8] * c[2],
          ],
          mat3ToQuat(R),
        );
      });
      this.kinematicInputs.push(record);
    } else this.kinematicInputs.push(null);
    for (let i = 0; i < this.substeps; i++) this.world.step(this.dt, (i + 1) / this.substeps);
    this.current++;
    this.poses.push(this.capture());
  }

  /** Whether the animated bodies' transforms at `frame` are the ones the cache was built with. */
  kinematicMatches(frame: number, transforms: ReadonlyMap<string, Mat4>): boolean {
    const record = this.kinematicInputs[frame - this.frameStart];
    if (!record) return true;
    for (let i = 0; i < this.kinematic.length; i++) {
      const m = transforms.get(this.kinematic[i].id);
      for (let k = 0; k < 16; k++) {
        const a = m && m.length >= 16 ? m[k] : NaN;
        const b = record[i * 16 + k];
        if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return false;
      }
    }
    return true;
  }

  /**
   * World matrices of the output bodies at a (possibly fractional) simulated frame in
   * [frameStart, current]; between frames poses are interpolated. Scale is the object's world
   * scale at frame_start.
   */
  matrices(frame: number): Map<string, Mat4> {
    const f = Math.min(Math.max(frame, this.frameStart), this.current);
    const lo = Math.floor(f);
    const hi = Math.min(Math.ceil(f), this.current);
    const t = f - lo;
    const a = this.poses[lo - this.frameStart];
    const b = this.poses[hi - this.frameStart];
    const out = new Map<string, Mat4>();
    this.outputs.forEach((body, i) => {
      const o = i * 7;
      let px = a[o];
      let py = a[o + 1];
      let pz = a[o + 2];
      let q: [number, number, number, number] = [a[o + 3], a[o + 4], a[o + 5], a[o + 6]];
      if (t > 0 && hi !== lo) {
        px += (b[o] - px) * t;
        py += (b[o + 1] - py) * t;
        pz += (b[o + 2] - pz) * t;
        q = slerpQ(q, [b[o + 3], b[o + 4], b[o + 5], b[o + 6]], t);
      }
      const R = quatToMat3(q);
      const c = body.com;
      const origin: Vec3 = [
        px - (R[0] * c[0] + R[1] * c[1] + R[2] * c[2]),
        py - (R[3] * c[0] + R[4] * c[1] + R[5] * c[2]),
        pz - (R[6] * c[0] + R[7] * c[1] + R[8] * c[2]),
      ];
      out.set(body.id, composeRigid(origin, R, body.scale));
    });
    return out;
  }
}
