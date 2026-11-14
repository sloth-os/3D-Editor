import type { Mat4, Quat, Vec3 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { RigidBodyData } from '../doc/types';
import { Body } from './body';
import { meshKey } from './mesh-key';
import { buildCollisionShape, cachedCollisionShape, type ShapeBuild } from './shapes';
import {
  LATE_RELEASE_RUN_SECONDS,
  MAX_SIMULATED_FRAMES,
  RELEASE_JUMP_MIN_ANGULAR,
  RELEASE_JUMP_MIN_LINEAR,
  RELEASE_MAX_ACCELERATION,
  RELEASE_MAX_ANGULAR_ACCELERATION,
  RELEASE_TRACKED_STEPS,
  delayedStartFrame,
  motionMode,
  simulatedFrameEnd,
  type MotionMode,
  type WorldParams,
} from './settings';
import { PhysicsWorld } from './world';
import { composeRigid, decomposeRigid, isFiniteVec, mat3ToQuat, quatToMat3, slerpQ } from './vmath';

/*
 * One rigid body simulation run (Blender's point cache of a rigid body world): the bodies are
 * built from the scene at frame_start, then the world is stepped one frame at a time
 * (`substeps_per_frame` steps of time_scale / fps / substeps seconds each). The pose of every
 * ACTIVE, non-animated body is recorded per frame, so going back in time is a lookup.
 *
 * A body whose start_frame is after the world's frame_start (a held prop thrown or dropped later,
 * see RigidBodyData.start_frame) is "delayed". Until RELEASE_TRACKED_STEPS frames before its start
 * frame it is dormant: parked at its frame_start pose, it collides with nothing and its transform
 * is not read (a held prop does not push bodies before its release; an animated collider, a
 * PASSIVE body with "Animated" on, does). There it is placed at its animated pose, and it follows
 * its animated / parented / constrained transform as an animated (KINEMATIC) body up to and
 * including its start frame; then it is released into its own motion mode with the velocity of its
 * last animated step (when inherit_velocity) plus its initial velocities. When its last two animated
 * steps differ by more than a hand could change its velocity (RELEASE_MAX_ACCELERATION), one of them
 * is a jump of the animation rather than a motion: the body keeps the slower one and a warning names
 * the jump. Its transforms are recorded and verified on those few frames only, so a release late in
 * a long world costs a few evaluations of the scene, not one per frame before it. `matrices` leaves
 * it out up to its start frame, so the scene shows its own transform until the simulation takes
 * over. A body released at or after the world's frame_end keeps the world running until it has come
 * to rest (`runLimit`), and a start frame before the world's start is reported. Bodies that start
 * with the world (start_frame null or not after frame_start) get their initial velocities at
 * frame_start; without start frames and velocities a run is exactly what it was before they existed.
 */

/** A delayed body and what it becomes at its start frame. */
interface Release {
  body: Body;
  /** Last frame the body follows its animation; the simulation moves it from the next one. */
  frame: number;
  /** First frame whose animated transform drives it (it is dormant before when that is after frame_start). */
  track: number;
  mode: MotionMode;
  linear: Vec3;
  angular: Vec3;
  inherit: boolean;
  /** Velocity of its animated step before the last one (null: it did not follow its animation that long). */
  before: { linear: Vec3; angular: Vec3 } | null;
}

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

const speed = (v: Readonly<Vec3>): number => Math.hypot(v[0], v[1], v[2]);
const fmt = (v: number): string => String(Math.round(v * 100) / 100);

export class Simulation {
  readonly world: PhysicsWorld;
  readonly frameStart: number;
  /** frame_end: the last frame that is simulated, unless late releases keep the world running (`runLimit`). */
  frameEnd: number;
  /**
   * The last frame the world may run to: frame_end, or past it while bodies released at or after
   * frame_end (late releases) are pending or moving, at most LATE_RELEASE_RUN_SECONDS after the last
   * of them (and MAX_SIMULATED_FRAMES after frame_start). Later frames hold the state of the run's end.
   */
  runLimit: number;
  readonly substeps: number;
  /** Length of one step in seconds. */
  readonly dt: number;
  readonly bodies: readonly Body[];
  /**
   * Bodies whose transform the simulation drives (ACTIVE and not animated, delayed ones included:
   * from their start frame on), in solver order.
   */
  readonly outputs: readonly Body[];
  /** Animated ("kinematic") bodies following their animation for the whole run, in solver order. */
  readonly kinematic: readonly Body[];
  /** Bodies released at their start frame (see the module comment), in solver order. */
  readonly delayed: readonly Body[];
  /**
   * Bodies whose animated transforms drive the simulation at some frame (the animated bodies, and
   * the delayed ones on the frames before their start, see `trackedAt`), in solver order:
   * `animationInputsKey` and the frame-by-frame verification of the cache cover them.
   */
  readonly tracked: readonly Body[];
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
  /**
   * Per frame: world matrices (16 per body) that drove the tracked bodies animated at that frame
   * (`trackedAt`), null when none was.
   */
  private readonly kinematicInputs: (Float64Array | null)[] = [null];
  /** Matrices recorded in `kinematicInputs` so far (16 numbers each). */
  kinematicRecords = 0;
  /** The release of each delayed body. */
  private readonly releases = new Map<Body, Release>();
  /** Delayed bodies not released yet, by start frame (then solver order). */
  private readonly pending: Release[] = [];
  /** Releases at or after frame_end (they keep the world running, see `runLimit`), in body order. */
  private late: Release[] = [];
  /** Per simulated frame: whether every late release has happened and its body has come to rest there. */
  private readonly lateRested: boolean[] = [];
  /** The run's last frame for the current frame_end once the run has reached it (see `endFrame`). */
  private end: number | null = null;
  /** Next frame to check for the run's end. */
  private scan: number;
  /** Delayed bodies whose start frame is before the world's start (they start with it), for `rangeIssues`. */
  private readonly early: { id: string; start: number }[] = [];
  /** The issues about the world's range (refreshed when frame_end moves). */
  private readonly rangeIssueSet = new Set<RigidBodyIssue>();
  private readonly fps: number;

  constructor(inputs: readonly BodyInput[], params: WorldParams, opts: SimulationOptions = {}) {
    this.frameStart = params.frameStart;
    this.frameEnd = simulatedFrameEnd(params);
    this.substeps = params.substeps;
    this.dt = params.timeScale / params.fps / params.substeps;
    this.fps = params.fps;
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
    this.pending.sort((a, b) => a.frame - b.frame || a.body.index - b.body.index);
    this.delayed = bodies.filter((b) => this.releases.has(b));
    this.outputs = bodies.filter((b) => b.mode === 'DYNAMIC' || b.mode === 'FROZEN' || this.releases.has(b));
    this.kinematic = bodies.filter((b) => b.mode === 'KINEMATIC' && !this.releases.has(b));
    this.tracked = bodies.filter((b) => b.mode === 'KINEMATIC');
    this.world = new PhysicsWorld(bodies, {
      gravity: params.gravity,
      iterations: params.iterations,
      sleeping: opts.sleeping,
    });
    this.late = this.lateReleases(this.frameEnd);
    this.runLimit = this.lateRunLimit();
    this.scan = this.frameEnd;
    this.poses.push(this.capture());
    this.lateRested.push(this.lateAtRest());
    this.findEnd();
    this.refreshRangeIssues();
  }

  /**
   * The start frame of a delayed body (the last frame it follows its animation), or null for a body
   * that is not delayed or not in the simulation.
   */
  releaseFrameOf(id: string): number | null {
    for (const [b, r] of this.releases) if (b.id === id) return r.frame;
    return null;
  }

  /** The start frame of every delayed body, by object id. */
  releaseFrames(): Map<string, number> {
    return new Map([...this.releases.values()].map((r) => [r.body.id, r.frame]));
  }

  /** The tracked bodies whose animated transform drives the step to `frame` (see `tracked`). */
  private trackedAt(frame: number): Body[] {
    if (!this.delayed.length) return this.kinematic as Body[];
    return this.tracked.filter((b) => {
      const r = this.releases.get(b);
      return !r || (frame >= r.track && frame <= r.frame);
    });
  }

  /** Whether stepping to `frame` needs the scene's unsimulated transforms (some body follows its animation). */
  needsTransforms(frame: number): boolean {
    if (this.kinematic.length) return true;
    for (const r of this.releases.values()) if (frame >= r.track && frame <= r.frame) return true;
    return false;
  }

  /** Matrices the steps to frames `from` … `to` record (each 16 numbers: the animated transforms read). */
  recordsBetween(from: number, to: number): number {
    if (to < from) return 0;
    let n = this.kinematic.length * (to - from + 1);
    for (const r of this.releases.values())
      n += Math.max(0, Math.min(to, r.frame) - Math.max(from, r.track) + 1);
    return n;
  }

  /** Whether the animated transforms that drove the step to `frame` were recorded (see `kinematicMatches`). */
  recordedAt(frame: number): boolean {
    return !!this.kinematicInputs[frame - this.frameStart];
  }

  /**
   * Moves frame_end (frame_end changed, nothing else): later frames are stepped from the current
   * state when the end grows; frames simulated beyond a smaller end stay cached (they do not depend
   * on the end), and evaluations stop at the new end. False (nothing changed) when other bodies are
   * released at or after the new end than at the old one: the run must start over.
   */
  setFrameEnd(params: Pick<WorldParams, 'frameStart' | 'frameEnd'>): boolean {
    const end = simulatedFrameEnd(params);
    const late = this.lateReleases(end);
    if (late.length !== this.late.length || late.some((r, i) => r !== this.late[i])) return false;
    this.frameEnd = end;
    this.runLimit = this.lateRunLimit();
    this.end = null;
    this.scan = end;
    this.findEnd();
    this.refreshRangeIssues();
    return true;
  }

  /**
   * The run's last frame for the current frame_end: frame_end itself, or the first frame after it
   * at which every late release has happened and its body is at rest (at most `runLimit`); null
   * while the run has not reached it. Evaluations of later frames show that frame's state.
   */
  endFrame(): number | null {
    return this.end;
  }

  /** Whether the run has reached its last frame (see `endFrame`): stepping on changes nothing shown. */
  get ended(): boolean {
    return this.end !== null && this.current >= this.end;
  }

  /** The releases at or after `end` (in body order). */
  private lateReleases(end: number): Release[] {
    return [...this.releases.values()].filter((r) => r.frame >= end);
  }

  private lateRunLimit(): number {
    if (!this.late.length) return this.frameEnd;
    const last = Math.max(...this.late.map((r) => r.frame));
    const limit = last + Math.ceil(LATE_RELEASE_RUN_SECONDS * this.fps);
    return Math.max(this.frameEnd, Math.min(this.frameStart + MAX_SIMULATED_FRAMES, limit));
  }

  /** Whether every late release has happened and its body rests (asleep, or not dynamic) at the current frame. */
  private lateAtRest(): boolean {
    for (const r of this.late) {
      if (this.pending.includes(r)) return false;
      if (r.body.mode === 'DYNAMIC' && r.body.awake) return false;
    }
    return true;
  }

  /** Finds the run's end among the frames simulated so far (see `endFrame`). */
  private findEnd(): void {
    while (this.end === null && this.scan <= this.current) {
      const f = this.scan;
      if (f >= this.runLimit || this.lateRested[f - this.frameStart]) this.end = f;
      else this.scan++;
    }
  }

  /** Issues about bodies the world's range does not fit: released before its start, or at or after its end. */
  private refreshRangeIssues(): void {
    for (let i = this.issues.length - 1; i >= 0; i--)
      if (this.rangeIssueSet.has(this.issues[i])) this.issues.splice(i, 1);
    this.rangeIssueSet.clear();
    const add = (objectId: string, message: string) => {
      const issue: RigidBodyIssue = { objectId, level: 'WARNING', message };
      this.issues.push(issue);
      this.rangeIssueSet.add(issue);
    };
    const remedy =
      'fit the rigid body world to it (rigidbody.world_set frame_start / frame_end, or run a desk.physics_* ' +
      'preset again)';
    for (const { id, start } of this.early)
      add(
        id,
        `its start_frame ${start} is before the rigid body world's frame_start ${this.frameStart}: it keeps ` +
          `its own transform until then and starts with the world there; ${remedy}`,
      );
    const cap = this.frameStart + MAX_SIMULATED_FRAMES;
    for (const r of this.late)
      add(
        r.body.id,
        r.frame >= cap
          ? `its start_frame ${r.frame} is past the ${MAX_SIMULATED_FRAMES}-frame limit of a simulation from ` +
              `frame ${this.frameStart}: it is never released; ${remedy}`
          : `its start_frame ${r.frame} is at or after the rigid body world's frame_end ${this.frameEnd}: the ` +
              `world runs on until it has come to rest, at most to frame ${this.runLimit}; ${remedy}`,
      );
  }

  /** Releases the delayed bodies whose start frame is at or before `frame` (before stepping past it). */
  private releaseDue(frame: number): void {
    while (this.pending.length && this.pending[0].frame <= frame) {
      const r = this.pending.shift()!;
      const b = r.body;
      // a body never placed (no valid transform on its tracked frames) starts where it is parked
      b.dormant = false;
      b.mode = r.mode;
      if (r.mode === 'DYNAMIC') {
        // the velocity of its last animated step (world.ts integrateVelocities), plus the initial ones
        let linear: Vec3 = r.inherit ? [b.vx, b.vy, b.vz] : [0, 0, 0];
        let angular: Vec3 = r.inherit ? [b.wx, b.wy, b.wz] : [0, 0, 0];
        if (r.inherit && r.before) [linear, angular] = this.withoutJump(r, linear, angular);
        b.vx = linear[0] + r.linear[0];
        b.vy = linear[1] + r.linear[1];
        b.vz = linear[2] + r.linear[2];
        b.wx = angular[0] + r.angular[0];
        b.wy = angular[1] + r.angular[1];
        b.wz = angular[2] + r.angular[2];
      } else b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
      b.awake = true;
      b.sleepTime = 0;
      b.updateMassState();
    }
  }

  /**
   * The velocities a body inherits at its release: those of its last animated step, unless its last
   * two steps differ by more than a hand could change them in a frame (RELEASE_MAX_ACCELERATION): then
   * its animated transform jumps there (a release pose keyed for another motion of the holder, or a
   * hold let go a frame early), and the slower of the two steps is the hand's motion while the faster
   * one is the jump that would launch it. It keeps the slower one, and a warning names the jump.
   */
  private withoutJump(r: Release, linear: Vec3, angular: Vec3): [Vec3, Vec3] {
    const before = r.before!;
    const frameTime = this.dt * this.substeps;
    if (!(frameTime > 0)) return [linear, angular];
    const dv = speed([
      linear[0] - before.linear[0],
      linear[1] - before.linear[1],
      linear[2] - before.linear[2],
    ]);
    const dw = speed([
      angular[0] - before.angular[0],
      angular[1] - before.angular[1],
      angular[2] - before.angular[2],
    ]);
    const linearJump = dv > Math.max(RELEASE_JUMP_MIN_LINEAR, RELEASE_MAX_ACCELERATION * frameTime);
    const angularJump = dw > Math.max(RELEASE_JUMP_MIN_ANGULAR, RELEASE_MAX_ANGULAR_ACCELERATION * frameTime);
    if (!linearJump && !angularJump) return [linear, angular];
    const slower = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 =>
      [...(speed(a) <= speed(b) ? a : b)] as Vec3;
    const keptLinear = linearJump ? slower(before.linear, linear) : linear;
    const keptAngular = angularJump ? slower(before.angular, angular) : angular;
    const what = [
      linearJump
        ? `${fmt(speed(before.linear))} then ${fmt(speed(linear))} m/s (kept ${fmt(speed(keptLinear))})`
        : '',
      angularJump
        ? `${fmt(speed(before.angular))} then ${fmt(speed(angular))} rad/s (kept ${fmt(speed(keptAngular))})`
        : '',
    ].filter(Boolean);
    this.issue(
      r.body.id,
      'WARNING',
      `its animated transform jumps at its release (frame ${r.frame}): its last two animated steps move it at ` +
        `${what.join(' and ')}, so it is released with the slower one; key its release pose where it is held ` +
        'then (desk.actor_hold again after changing the holder) or move its start_frame',
    );
    return [keptLinear, keptAngular];
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
    const mode = motionMode(rb);
    const start = delayedStartFrame(rb, this.frameStart);
    const body = new Body({
      id,
      index,
      shape: built.shape,
      shapeType: built.type,
      com: c,
      scale,
      unitInertia: built.inertia,
      // a delayed body follows its animation until its start frame
      mode: start === null ? mode : 'KINEMATIC',
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
    if (start !== null) {
      // dormant (parked, colliding with nothing) until it is placed at its animated pose a few frames before
      const placed = start - RELEASE_TRACKED_STEPS;
      body.dormant = placed > this.frameStart;
      const release: Release = {
        body,
        frame: start,
        track: Math.max(this.frameStart + 1, placed),
        mode,
        linear: [...rb.initial_linear_velocity],
        angular: [...rb.initial_angular_velocity],
        inherit: rb.inherit_velocity,
        before: null,
      };
      this.releases.set(body, release);
      this.pending.push(release);
    } else {
      if (mode === 'DYNAMIC') {
        // a body that starts with the world: its initial velocities (none by default)
        [body.vx, body.vy, body.vz] = rb.initial_linear_velocity;
        [body.wx, body.wy, body.wz] = rb.initial_angular_velocity;
      }
      if (
        rb.type === 'ACTIVE' &&
        !rb.kinematic &&
        rb.start_frame !== null &&
        rb.start_frame < this.frameStart
      )
        this.early.push({ id, start: rb.start_frame });
    }
    return body;
  }

  private capture(): Float64Array {
    const out = new Float64Array(this.outputs.length * 7);
    this.outputs.forEach((b, i) => {
      out.set([b.px, b.py, b.pz, b.qx, b.qy, b.qz, b.qw], i * 7);
    });
    return out;
  }

  /** Centre-of-mass position and orientation of body `b` with the object world matrix `m`. */
  private bodyPose(b: Body, m: Readonly<Mat4>): { p: Vec3; q: Quat } {
    const { position: o, rotation: R } = decomposeRigid(m as Mat4);
    const c = b.com;
    return {
      p: [
        o[0] + R[0] * c[0] + R[1] * c[1] + R[2] * c[2],
        o[1] + R[3] * c[0] + R[4] * c[1] + R[5] * c[2],
        o[2] + R[6] * c[0] + R[7] * c[1] + R[8] * c[2],
      ],
      q: mat3ToQuat(R),
    };
  }

  /**
   * Simulates the next frame. `transforms` are the unsimulated world matrices at that frame
   * (needed when a body follows its animation there, see `needsTransforms`; missing or invalid ones
   * keep the body in place). Delayed bodies whose start frame is the current frame are released
   * first: the simulation moves them from this step on. A dormant body is placed at its animated
   * pose at the end of the step (it takes no part in the step itself).
   */
  advance(transforms: ReadonlyMap<string, Mat4> | null): void {
    const frame = this.current + 1;
    this.releaseDue(this.current);
    const driven = this.trackedAt(frame);
    const placed: { b: Body; p: Vec3; q: Quat }[] = [];
    const stepped: Body[] = [];
    if (driven.length) {
      const record = new Float64Array(driven.length * 16).fill(NaN);
      driven.forEach((b, i) => {
        const m = transforms?.get(b.id);
        if (m) for (let k = 0; k < 16; k++) record[i * 16 + k] = m[k];
        const valid = !!m && m.length >= 16 && isFiniteVec(m);
        if (b.dormant) {
          if (valid) placed.push({ b, ...this.bodyPose(b, m) });
          return;
        }
        if (!valid) {
          this.world.setKinematicTarget(b, [b.px, b.py, b.pz], b.orientation);
          return;
        }
        const { p, q } = this.bodyPose(b, m);
        this.world.setKinematicTarget(b, p, q);
        stepped.push(b);
      });
      this.kinematicInputs.push(record);
      this.kinematicRecords += driven.length;
    } else this.kinematicInputs.push(null);
    for (let i = 0; i < this.substeps; i++) this.world.step(this.dt, (i + 1) / this.substeps);
    for (const { b, p, q } of placed) {
      b.setPose(p, q);
      b.k0p = [...p];
      b.k1p = [...p];
      b.k0q = [...q];
      b.k1q = [...q];
      b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
      b.dormant = false;
    }
    // the velocity of the animated step before a release's last one (the jump check of `withoutJump`)
    for (const b of stepped) {
      const r = this.releases.get(b);
      if (r && r.frame === frame + 1) r.before = { linear: [b.vx, b.vy, b.vz], angular: [b.wx, b.wy, b.wz] };
    }
    this.current++;
    this.poses.push(this.capture());
    this.lateRested.push(this.lateAtRest());
    this.findEnd();
  }

  /** Whether the animated bodies' transforms at `frame` are the ones the cache was built with. */
  kinematicMatches(frame: number, transforms: ReadonlyMap<string, Mat4>): boolean {
    const record = this.kinematicInputs[frame - this.frameStart];
    if (!record) return true;
    const driven = this.trackedAt(frame);
    for (let i = 0; i < driven.length; i++) {
      const m = transforms.get(driven[i].id);
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
   * scale at frame_start. A delayed body is left out up to and including its start frame (the
   * scene shows its own, animated transform there).
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
      const release = this.releases.get(body);
      if (release && f <= release.frame) return;
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
