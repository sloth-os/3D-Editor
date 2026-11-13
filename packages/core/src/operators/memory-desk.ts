import type { SceneDoc } from '../doc/scene-doc';
import type { ShotData } from '../doc/types';
import { MAX_SHOT_FRAME, findShotIndex, getShots } from '../desk/shots';
import { sanitizeRigidBody, sanitizeRigidBodyWorld } from '../physics/settings';
import type { OperatorContext } from './context';
import {
  OPERATOR_FIXED_BYTES,
  decodedFaces,
  keyframeEstimate,
  refObjects,
  withObjects,
  type Estimator,
  type OperatorEstimate,
} from './memory-base';
import {
  frameSamplingBytes,
  newKeyframesWrites,
  rigidBodyBakeWrites,
  type KeyframeWrites,
} from './memory-keyframes';
import type { NewObjects } from './memory-objects';

/*
 * Memory estimates of the director's desk and model store operators (operators/desk-shots.ts,
 * desk-actors.ts, desk-motion.ts, store.ts), spread into operators/memory.ts OPERATOR_ESTIMATES,
 * UNESTIMATED_OPERATORS and BOUNDED_GROWTH_PARAMETERS. Each workstream owns its table here
 * (DESK-CORE the shots, CHARACTERS the actors, MOTION the physics, CATALOG the store) and tunes it
 * as it implements its operators. store.insert_files is an import and is estimated next to the
 * import_* operators in memory.ts. This module imports nothing of memory.ts (memory-base.ts holds
 * what they share), so that memory.ts can spread these tables without an import cycle.
 *
 * Not measured yet: the constants below are upper bounds of what the spec describes (actors of 22
 * bones with a mesh part per bone, built-in models of up to 30 parts, gaits keyed about five times a
 * cycle, camera moves keyed every frame when they follow a subject), and the costs per keyframe, per
 * face and per sampled frame are those measured for keyframe bakes (memory-keyframes.ts) and
 * generated objects (memory.ts GENERATOR_BYTES_PER_FACE). An operator's owner measures it with
 * --trace-gc (test/operator-memory-child.ts) and lowers what errs too far on the safe side.
 */

/** Objects an actor adds at most: its armature, a mesh part per bone (22 bones) and a nose or visor. */
export const DESK_ACTOR_MAX_OBJECTS = 24;

/** Faces of an actor's mesh parts at most (low-poly segmented mannequins). */
export const DESK_ACTOR_MAX_FACES = 16_000;

/**
 * Channels an actor's animation keys at most: the rotation of each of its 22 bones (four quaternion
 * channels), the hips' location, and the armature object's location and rotation.
 */
export const DESK_ACTOR_MAX_CHANNELS = 22 * 4 + 3 + 6;

/** Keyframes per channel and second of a gait: about five per cycle (spec §8), up to 2.5 cycles a second. */
export const DESK_GAIT_KEYS_PER_SECOND = 12.5;

/** Keyframes per channel a pose writes at most: the blend into it, the pose, its hold and the way out. */
export const DESK_POSE_KEYS = 4;

/** Speed (m/s) assumed for a path with neither speed_mps nor frame_end: slower than any default gait. */
export const DESK_SLOWEST_MPS = 1;

/**
 * Peak heap per face of the parts an actor or a built-in model builds, beyond their decoded size: what
 * a generated object takes (memory.ts GENERATOR_BYTES_PER_FACE).
 */
export const DESK_BUILD_BYTES_PER_FACE = 1_100;

/** Objects a built-in store model adds at most: its EMPTY root and named parts (body, wheels, pivots …). */
export const STORE_MODEL_MAX_OBJECTS = 30;

/** Faces of a built-in store model at most (its size parameters included). */
export const STORE_MODEL_MAX_FACES = 50_000;

/** Materials an actor or a built-in model adds at most. */
export const DESK_MAX_MATERIALS = 4;

/** Channels a shot's camera keys at most: location, rotation, the lens and the focus distance. */
export const DESK_CAMERA_CHANNELS = 8;

/** Keyframes per channel of a camera move that is not keyed on every frame (an orbit keys 8 points or more). */
export const DESK_MOVE_KEYS = 16;

/** Frames a check, a solve or an export of the blocking evaluates per shot: its first, middle and last. */
export const DESK_FRAMES_PER_SHOT = 3;

/** Objects a tether adds at most: the string and the segments of the tail. */
export const DESK_TETHER_MAX_OBJECTS = 12;

/** Channels a tether keys on every frame: the location and rotation of the flyer and of each object it adds. */
export const DESK_TETHER_CHANNELS = 6 * (DESK_TETHER_MAX_OBJECTS + 1);

/** Channels a drive keys on every frame: the vehicle's location and rotation, the wheels' spin and steering. */
export const DESK_VEHICLE_CHANNELS = 6 + 4 + 2;

/** Objects desk.set_build adds at most: the ground, the sun lamp and four walls. */
export const DESK_SET_MAX_OBJECTS = 6;

/** Moves that key the camera on every frame of the shot (they follow its first subject). */
const PER_FRAME_MOVES: ReadonlySet<string> = new Set(['tracking_follow', 'steadicam_walk']);

/** Length of a shot that gives neither frame_end nor duration_s (spec §4), and of an unknown range. */
const DEFAULT_SHOT_SECONDS = 5;

// ---------------------------------------------------------------- helpers

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const length = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Frames of a range: at least 1, at most a shot's longest (MAX_SHOT_FRAME). */
const clampFrames = (frames: number): number =>
  Math.min(MAX_SHOT_FRAME, Math.max(1, Math.ceil(Number.isFinite(frames) ? frames : 1)));

/** The scene's frame rate. */
function fps(doc: SceneDoc): number {
  return Math.max(1, num(doc.getScene().fps, 24));
}

/**
 * Frames of a range given as frame_start and frame_end (frame_end alone: from the scene's start), else
 * as duration_s (default `seconds`) at the scene's frame rate.
 */
function rangeFrames(doc: SceneDoc, p: Record<string, unknown>, seconds = DEFAULT_SHOT_SECONDS): number {
  if (typeof p.frame_end === 'number') {
    const start = num(p.frame_start, Math.min(p.frame_end, doc.getScene().frame_start));
    return clampFrames(p.frame_end - start + 1);
  }
  return clampFrames(num(p.duration_s, seconds) * fps(doc));
}

/** The id of the object `ref` names (an id or a name), or null. */
function objectId(ctx: OperatorContext, ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  return (ctx.doc.getObject(ref) ?? ctx.doc.resolveObject(ref))?.id ?? null;
}

/** The stored shot `ref` names (an id or a name), or null. */
function storedShot(doc: SceneDoc, ref: unknown): ShotData | null {
  if (typeof ref !== 'string') return null;
  const shots = getShots(doc);
  const i = findShotIndex(shots, ref);
  return i >= 0 ? shots[i] : null;
}

/** The shots `refs` names (each once), or every enabled shot without any. */
function targetShots(doc: SceneDoc, refs: unknown): ShotData[] {
  const shots = getShots(doc);
  if (!Array.isArray(refs) || !refs.length) return shots.filter((s) => s.enabled);
  const out: ShotData[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const i = findShotIndex(shots, String(ref));
    if (i < 0 || seen.has(shots[i].id)) continue;
    seen.add(shots[i].id);
    out.push(shots[i]);
  }
  return out;
}

/** Keyframes the F-curves of objects `ids` hold (an operator that keys their channels rewrites them). */
function keysOf(doc: SceneDoc, ids: Iterable<string | null | undefined>): number {
  const want = new Set<string>();
  for (const id of ids) if (id) want.add(id);
  if (!want.size) return 0;
  let keys = 0;
  for (const v of doc.map('fcurves').values()) {
    const fc = v as { target_type?: unknown; target_id?: unknown; keyframes?: unknown } | null;
    if (fc?.target_type === 'object' && want.has(String(fc.target_id)) && Array.isArray(fc.keyframes))
      keys += fc.keyframes.length;
  }
  return keys;
}

/**
 * Keyframes of a shot's camera over `frames` frames: a key at both ends of each channel, a move's
 * keys, and a key on every frame for the moves that follow a subject.
 */
function cameraKeys(move: unknown, frames: number): number {
  const perChannel =
    typeof move !== 'string' || move === 'locked_off'
      ? 2
      : PER_FRAME_MOVES.has(move)
        ? frames + 1
        : DESK_MOVE_KEYS;
  return DESK_CAMERA_CHANNELS * perChannel;
}

/** Frames a solve evaluates for a shot of `frames` frames: three, and each frame of a move that follows a subject. */
function solveFrames(move: unknown, frames: number): number {
  return DESK_FRAMES_PER_SHOT + (typeof move === 'string' && PER_FRAME_MOVES.has(move) ? frames : 0);
}

/** Frames of a move along `p.points` from where object `from` stands, at speed_mps or until frame_end. */
function pathFrames(ctx: OperatorContext, p: Record<string, unknown>, from: string | null): number {
  if (typeof p.frame_end === 'number' && typeof p.frame_start === 'number')
    return clampFrames(p.frame_end - p.frame_start + 1);
  let prev: readonly number[] | null = (from ? ctx.doc.getObject(from)?.location : null) ?? null;
  let metres = 0;
  for (const q of Array.isArray(p.points) ? p.points : []) {
    if (!Array.isArray(q) || q.length !== 3 || !q.every((x) => typeof x === 'number' && Number.isFinite(x)))
      continue;
    if (prev) metres += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
    prev = q as number[];
  }
  const speed = Math.max(1e-3, num(p.speed_mps, DESK_SLOWEST_MPS));
  return clampFrames((metres / speed) * fps(ctx.doc));
}

/** What an operator of the desk takes and adds. */
interface DeskCost {
  /** The keyframes it writes (memory-keyframes.ts newKeyframesWrites). */
  keys?: KeyframeWrites | null;
  /** Faces of the meshes it builds (an actor's parts, a model's), counted as a generated object's. */
  faces?: number;
  /** Peak heap besides (frames it samples). */
  extra?: number;
  /** The objects and datablocks it adds. */
  adds?: NewObjects;
  lower: string;
}

/** The estimate of a {@link DeskCost}; null when it builds, samples, keys and adds nothing. */
function deskEstimate(c: DeskCost): OperatorEstimate | null {
  const faces = Math.max(0, Math.ceil(c.faces ?? 0));
  const stored = faces ? decodedFaces(faces) : 0;
  const k = c.keys ?? null;
  const extra = Math.max(0, c.extra ?? 0);
  const base: OperatorEstimate | null =
    k || faces || extra
      ? {
          ...(k ? keyframeEstimate(k) : null),
          bytes: OPERATOR_FIXED_BYTES + (k?.bytes ?? 0) + DESK_BUILD_BYTES_PER_FACE * faces + stored + extra,
          faces,
          addedStoredBytes: (k?.stored ?? 0) + stored,
          addedSaveBytes: k?.save ?? 0,
          lower: c.lower,
        }
      : null;
  return c.adds ? withObjects(base, c.adds, c.lower) : base;
}

/** Peak heap of reading the scene at `frames` frames (frame states: memory-keyframes.ts), nothing added. */
function sampling(doc: SceneDoc, frames: number, lower: string): OperatorEstimate | null {
  if (!(frames > 0)) return null;
  return {
    bytes: OPERATOR_FIXED_BYTES + frameSamplingBytes(doc, frames),
    faces: 0,
    addedStoredBytes: 0,
    lower,
  };
}

// ---------------------------------------------------------------- shots (DESK-CORE)

const SHOT_LOWER =
  'the length of the shot (frame_start to frame_end, or duration_s), or a move that keys every frame (tracking_follow, steadicam_walk)';
const SOLVE_LOWER = 'the number of shots (shots), or their moves that key every frame';
const IMPORT_LOWER = 'the number of shots, cast members and props of the blocking';

/** A shot's camera keyed over its range (desk.shot_add, desk.shot_update, desk.camera_move). */
function shotCamera(
  ctx: OperatorContext,
  move: unknown,
  frames: number,
  camera: string | null | undefined,
  solve: boolean,
  lower: string,
): DeskCost {
  return {
    keys: newKeyframesWrites(
      cameraKeys(move, frames),
      DESK_CAMERA_CHANNELS,
      lower,
      keysOf(ctx.doc, [camera]),
    ),
    extra: solve ? frameSamplingBytes(ctx.doc, solveFrames(move, frames)) : 0,
    lower,
  };
}

export const DESK_SHOT_ESTIMATES: Readonly<Record<string, Estimator>> = {
  /** A camera (unless `camera` names one), keyed over the shot; a solve samples the shot's frames. */
  'desk.shot_add': (ctx, p) =>
    deskEstimate({
      ...shotCamera(
        ctx,
        p.move,
        rangeFrames(ctx.doc, p),
        objectId(ctx, p.camera),
        p.solve !== false,
        SHOT_LOWER,
      ),
      adds: p.camera === undefined ? { objects: 1, datablocks: { cameras: 1 } } : undefined,
    }),
  /** The shot's camera keyed again over its (new) range. */
  'desk.shot_update': (ctx, p) => {
    const shot = storedShot(ctx.doc, p.shot);
    const range =
      p.frame_end !== undefined || p.duration_s !== undefined
        ? {
            frame_start: p.frame_start ?? shot?.frame_start,
            frame_end: p.frame_end,
            duration_s: p.duration_s,
          }
        : { frame_start: p.frame_start ?? shot?.frame_start, frame_end: shot?.frame_end };
    const camera = typeof p.camera === 'string' ? objectId(ctx, p.camera) : shot?.camera;
    return deskEstimate(
      shotCamera(
        ctx,
        p.move !== undefined ? p.move : shot?.move,
        rangeFrames(ctx.doc, range),
        camera,
        p.resolve !== false,
        SHOT_LOWER,
      ),
    );
  },
  /** Every shot solved: its camera keyed (a new one when it has none) and its frames sampled. */
  'desk.shot_solve': (ctx, p) => {
    const shots = targetShots(ctx.doc, p.shots);
    if (!shots.length) return null;
    let keys = 0;
    let frames = 0;
    let cameras = 0;
    for (const s of shots) {
      const n = clampFrames(s.frame_end - s.frame_start + 1);
      keys += cameraKeys(s.move, n);
      frames += solveFrames(s.move, n);
      if (!s.camera) cameras++;
    }
    return deskEstimate({
      keys: newKeyframesWrites(
        keys,
        DESK_CAMERA_CHANNELS * shots.length,
        SOLVE_LOWER,
        keysOf(
          ctx.doc,
          shots.map((s) => s.camera),
        ),
      ),
      extra: frameSamplingBytes(ctx.doc, frames),
      adds: cameras ? { objects: cameras, datablocks: { cameras } } : undefined,
      lower: SOLVE_LOWER,
    });
  },
  /** Reads the scene at three frames of every shot it checks. */
  'desk.check': (ctx, p) =>
    sampling(
      ctx.doc,
      DESK_FRAMES_PER_SHOT * targetShots(ctx.doc, p.shots).length,
      'the number of shots checked (shots)',
    ),
  /** The ground, the sun and (interior) four walls. */
  'desk.set_build': (_ctx, p) =>
    deskEstimate({
      adds:
        p.interior === true
          ? {
              objects: DESK_SET_MAX_OBJECTS,
              datablocks: { meshes: DESK_SET_MAX_OBJECTS - 1, lights: 1, materials: 2 },
            }
          : { objects: 2, datablocks: { meshes: 1, lights: 1, materials: 1 } },
      lower: '',
    }),
  /** The camera keyed over the range (the shot's, else the scene's). */
  'desk.camera_move': (ctx, p) => {
    const shot = storedShot(ctx.doc, p.shot);
    const scene = ctx.doc.getScene();
    const frames = rangeFrames(ctx.doc, {
      frame_start: p.frame_start ?? shot?.frame_start ?? scene.frame_start,
      frame_end: p.frame_end ?? shot?.frame_end ?? scene.frame_end,
    });
    const camera = typeof p.camera === 'string' ? objectId(ctx, p.camera) : shot?.camera;
    return deskEstimate(
      shotCamera(
        ctx,
        p.move,
        frames,
        camera,
        typeof p.move === 'string' && PER_FRAME_MOVES.has(p.move),
        'the frame range (frame_start to frame_end), or a move that does not key every frame',
      ),
    );
  },
  /**
   * The whole blocking: an actor per cast member (each walking through every shot), a store model
   * per prop (a tether for kites and balloons), a primitive per landmark, a camera per shot, the set,
   * and three sampled frames per shot.
   */
  'desk.import_rideo_blocking': (ctx, p) => {
    const blocking = record(p.blocking);
    const props = Array.isArray(blocking.props) ? blocking.props : [];
    const actors = Math.max(length(blocking.actors), length(p.characters));
    const landmarks = length(record(blocking.set).landmarks);
    const shots = Array.isArray(p.shots) ? p.shots : [];
    const rate = Math.max(1, num(record(p.settings).fps, fps(ctx.doc)));
    const preRoll = Math.max(0, num(p.pre_roll_frames, 12));
    let frames = 0;
    let cameraKeyCount = 0;
    for (const s of shots) {
      const n = clampFrames(num(record(s).duration_s, DEFAULT_SHOT_SECONDS) * rate);
      frames += n + preRoll;
      // a camera imported with an end or a move from the shot's spec: keyed as a move
      cameraKeyCount += cameraKeys(record(s).move ?? 'push_in', n);
    }
    const kites = props.filter((pr) => /kite|balloon/i.test(String(record(pr).label ?? ''))).length;
    const seconds = frames / rate;
    const keys =
      actors *
        DESK_ACTOR_MAX_CHANNELS *
        (Math.ceil(DESK_GAIT_KEYS_PER_SECOND * seconds) + DESK_POSE_KEYS * Math.max(1, shots.length)) +
      cameraKeyCount +
      kites * DESK_TETHER_CHANNELS * (frames + 1);
    const fcurves =
      actors * DESK_ACTOR_MAX_CHANNELS + shots.length * DESK_CAMERA_CHANNELS + kites * DESK_TETHER_CHANNELS;
    const objects =
      actors * DESK_ACTOR_MAX_OBJECTS +
      props.length * STORE_MODEL_MAX_OBJECTS +
      kites * DESK_TETHER_MAX_OBJECTS +
      landmarks +
      shots.length +
      DESK_SET_MAX_OBJECTS;
    return deskEstimate({
      keys: newKeyframesWrites(keys, fcurves, IMPORT_LOWER),
      faces: actors * DESK_ACTOR_MAX_FACES + props.length * STORE_MODEL_MAX_FACES,
      extra: frameSamplingBytes(ctx.doc, DESK_FRAMES_PER_SHOT * shots.length + kites * frames),
      adds: {
        objects,
        datablocks: {
          meshes: Math.max(0, objects - actors - shots.length),
          armatures: actors,
          cameras: shots.length,
          lights: 1,
          materials: DESK_MAX_MATERIALS * (actors + props.length) + landmarks + 2,
        },
      },
      lower: IMPORT_LOWER,
    });
  },
  /** Reads the scene at the first and last frame of every enabled shot. */
  'desk.export_rideo_blocking': (ctx) =>
    sampling(ctx.doc, 2 * targetShots(ctx.doc, null).length, 'the number of shots'),
};

// ---------------------------------------------------------------- actors (CHARACTERS)

const POSE_LOWER = "the actor's animation (a pose rewrites the actor's keyframes)";

export const DESK_ACTOR_ESTIMATES: Readonly<Record<string, Estimator>> = {
  /** An armature and its parts (and the pose's keys). */
  'desk.actor_add': (_ctx, p) =>
    deskEstimate({
      faces: DESK_ACTOR_MAX_FACES,
      keys:
        p.pose !== undefined
          ? newKeyframesWrites(DESK_ACTOR_MAX_CHANNELS, DESK_ACTOR_MAX_CHANNELS, '')
          : null,
      adds: {
        objects: DESK_ACTOR_MAX_OBJECTS,
        datablocks: { meshes: DESK_ACTOR_MAX_OBJECTS - 1, armatures: 1, materials: DESK_MAX_MATERIALS },
      },
      lower: '',
    }),
  /** A pose keyed on every channel (blend, pose, hold); the actor's keys rewritten. */
  'desk.actor_pose': (ctx, p) =>
    deskEstimate({
      keys: newKeyframesWrites(
        DESK_ACTOR_MAX_CHANNELS * (DESK_POSE_KEYS + (p.hold_frames !== undefined ? 1 : 0)),
        DESK_ACTOR_MAX_CHANNELS,
        POSE_LOWER,
        keysOf(ctx.doc, [objectId(ctx, p.actor)]),
      ),
      lower: POSE_LOWER,
    }),
  /** A gait keyed on every channel for every cycle of the move, blended in and out. */
  'desk.actor_move': (ctx, p) => {
    const actor = objectId(ctx, p.actor);
    const frames = pathFrames(ctx, p, actor);
    const perChannel =
      Math.min(frames + 1, Math.ceil((DESK_GAIT_KEYS_PER_SECOND * frames) / fps(ctx.doc))) +
      2 * DESK_POSE_KEYS;
    const lower = 'the length of the move (frame_end, a higher speed_mps or a shorter path)';
    return deskEstimate({
      keys: newKeyframesWrites(
        DESK_ACTOR_MAX_CHANNELS * perChannel,
        DESK_ACTOR_MAX_CHANNELS,
        lower,
        keysOf(ctx.doc, [actor]),
      ),
      lower,
    });
  },
  /** A turn: the armature object's rotation keyed before and after it. */
  'desk.actor_face': (ctx, p) =>
    deskEstimate({
      keys: newKeyframesWrites(12, 4, POSE_LOWER, keysOf(ctx.doc, [objectId(ctx, p.actor)])),
      lower: POSE_LOWER,
    }),
  /** A head constraint with its influence keyed. */
  'desk.actor_look_at': () => deskEstimate({ keys: newKeyframesWrites(4, 1, ''), lower: '' }),
  /** A CHILD_OF constraint on the prop (influence keyed) and its visual transform keyed at the release. */
  'desk.actor_hold': (ctx, p) =>
    deskEstimate({
      keys: newKeyframesWrites(
        4 + 2 * 9,
        1 + 9,
        "the prop's animation",
        keysOf(ctx.doc, [objectId(ctx, p.prop)]),
      ),
      lower: "the prop's animation",
    }),
  /** The rider's CHILD_OF on the saddle (influence keyed) and the ride pose. */
  'desk.actor_mount': (ctx, p) =>
    deskEstimate({
      keys: newKeyframesWrites(
        DESK_ACTOR_MAX_CHANNELS * DESK_POSE_KEYS + 4,
        DESK_ACTOR_MAX_CHANNELS + 1,
        POSE_LOWER,
        keysOf(ctx.doc, [objectId(ctx, p.rider)]),
      ),
      lower: POSE_LOWER,
    }),
};

// ---------------------------------------------------------------- physics (MOTION)

const BODY_LOWER = 'the number of objects (objects)';

/** Keys held before a release on each object (a lift, a hold before a throw): location and rotation. */
function releaseKeys(ctx: OperatorContext, ids: (string | null)[]): DeskCost {
  const n = ids.filter(Boolean).length;
  return {
    keys: n ? newKeyframesWrites(12 * n, 6 * n, BODY_LOWER, keysOf(ctx.doc, ids)) : null,
    lower: BODY_LOWER,
  };
}

export const DESK_MOTION_ESTIMATES: Readonly<Record<string, Estimator>> = {
  /** Rigid body settings (a few hundred bytes each), and a ground collider. */
  'desk.physics_setup': (_ctx, p) =>
    p.ground === false ? null : deskEstimate({ adds: { objects: 1, datablocks: { meshes: 1 } }, lower: '' }),
  'desk.physics_drop': (ctx, p) =>
    deskEstimate(
      releaseKeys(
        ctx,
        refObjects(ctx, p.objects).map((o) => o.id),
      ),
    ),
  'desk.physics_throw': (ctx, p) => deskEstimate(releaseKeys(ctx, [objectId(ctx, p.object)])),
  'desk.physics_push': (ctx, p) => deskEstimate(releaseKeys(ctx, [objectId(ctx, p.object)])),
  /** A bake of the simulation to keyframes (memory-keyframes.ts rigidBodyBakeWrites; the world's range by default). */
  'desk.physics_bake': (ctx, p) => {
    const world = sanitizeRigidBodyWorld(ctx.doc.getScene().rigidbody_world);
    const objects =
      Array.isArray(p.objects) && p.objects.length
        ? refObjects(ctx, p.objects)
        : ctx.doc.listObjects().filter((o) => sanitizeRigidBody(o.rigid_body)?.type === 'ACTIVE');
    return keyframeEstimate(
      rigidBodyBakeWrites(ctx.doc, objects, {
        start: num(p.frame_start, world.frame_start),
        end: num(p.frame_end, world.frame_end),
        step: 1,
      }),
    );
  },
  /** The flyer, its string and tail keyed on every frame, the anchor sampled on every frame. */
  'desk.tether_fly': (ctx, p) => {
    const frames = clampFrames(num(p.frame_end, 0) - num(p.frame_start, 0) + 1 + num(p.launch_frames, 0));
    const added = (p.string === false ? 0 : 1) + (p.tail === false ? 0 : DESK_TETHER_MAX_OBJECTS - 1);
    const lower = 'the frame range (frame_start to frame_end)';
    return deskEstimate({
      keys: newKeyframesWrites(
        DESK_TETHER_CHANNELS * (frames + 1),
        DESK_TETHER_CHANNELS,
        lower,
        keysOf(ctx.doc, [objectId(ctx, p.flyer)]),
      ),
      extra: frameSamplingBytes(ctx.doc, frames),
      adds: added ? { objects: added, datablocks: { meshes: added } } : undefined,
      lower,
    });
  },
  /** The vehicle, its wheels' spin and steering keyed on every frame of the drive. */
  'desk.vehicle_drive': (ctx, p) => {
    const vehicle = objectId(ctx, p.vehicle);
    const frames = pathFrames(ctx, p, vehicle);
    const lower = 'the length of the drive (frame_end, a higher speed_mps or a shorter path)';
    return deskEstimate({
      keys: newKeyframesWrites(
        DESK_VEHICLE_CHANNELS * (frames + 1),
        DESK_VEHICLE_CHANNELS,
        lower,
        keysOf(ctx.doc, [vehicle]),
      ),
      lower,
    });
  },
};

// ---------------------------------------------------------------- store (CATALOG)

export const STORE_ESTIMATES: Readonly<Record<string, Estimator>> = {
  /** A built-in model: its root and parts (store.insert_files: memory.ts, as an import). */
  'store.add': () =>
    deskEstimate({
      faces: STORE_MODEL_MAX_FACES,
      adds: {
        objects: STORE_MODEL_MAX_OBJECTS,
        datablocks: { meshes: STORE_MODEL_MAX_OBJECTS - 1, materials: DESK_MAX_MATERIALS },
      },
      lower: "the model's size parameters (params)",
    }),
};

/** Desk and store operators without an estimate, and why (see memory.ts UNESTIMATED_OPERATORS). */
export const DESK_UNESTIMATED_OPERATORS: readonly { match: string; reason: string }[] = [
  { match: 'desk.shot_remove', reason: 'removes the shots it names (and with delete_cameras their cameras)' },
  { match: 'desk.shot_move', reason: 'moves a shot in the cut: the same shots, stored again' },
  { match: 'store.search', reason: 'reads the built-in catalog, changes nothing' },
];

/**
 * Parameters of {@link DESK_UNESTIMATED_OPERATORS} whose names say they count something, and why
 * they stay small (see memory.ts BOUNDED_GROWTH_PARAMETERS); none so far.
 */
export const DESK_BOUNDED_GROWTH_PARAMETERS: Readonly<Record<string, string>> = {};
