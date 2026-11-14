import type { FCurve, ObjectData } from '../doc/types';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { documentSimulationBodies, documentSimulationBytes } from '../physics/memory';
import { rigidBodyCacheBytes } from '../physics/rigid-body';
import { MAX_SIMULATED_FRAMES, sanitizeRigidBody, sanitizeRigidBodyWorld } from '../physics/settings';
import {
  DRIVER_STORED_BYTES,
  FCURVE_STORED_BYTES,
  KEYFRAME_STORED_BYTES,
  OBJECT_JSON_ADD_BYTES,
  OBJECT_JSON_STORED_BYTES,
  driverExtraJsonChars,
  projectStoredBytes,
  saveBytes,
} from './memory-objects';

/*
 * The heap of operators that write keyframes, for the estimates of operators/memory.ts. A keyframe
 * is a small JSON object in its F-curve, which the document keeps as one value per channel (about
 * 80 bytes per key kept, counted at KEYFRAME_STORED_BYTES), but bakes write millions of them: a bake
 * of 500 objects over 5,000 frames (22.5 million keyframes) ended a server on Node's default heap
 * during the operator, one of 100 objects over 10,000 frames in the save after it. Measured with
 * --trace-gc (garbage included, beyond the young generation's 32 MB, OPERATOR_FIXED_BYTES) on
 * linked cubes in core (heaps of 3 and 4 GB; the rigid bodies fall on a floor but in the last run), and
 * rounded up so that every run stays at least 10% below its estimate (the estimates of the bakes
 * include the garbage of their frame states, {@link frameSamplingBytes}):
 *
 * | run                                                  | keyframes   | peak (MB) | estimate (MB) |
 * | ---------------------------------------------------- | ----------- | --------- | ------------- |
 * | anim.bake_transforms, 100 objects × 1,000 frames     | 900,000     | 135–178   | 380           |
 * | 1,000 objects × 100 frames                           | 900,000     | 202–205   | 407           |
 * | 10,000 objects × 10 frames                           | 900,000     | 370–372   | 678           |
 * | 100 objects × 3,000 frames                           | 2,700,000   | 337–472   | 1,045         |
 * | location only, 100 objects × 3,000 frames            | 900,000     | 312–316   | 734           |
 * | location only, 1,000 objects × 300 frames            | 900,000     | 338       | 769           |
 * | rigidbody.bake_to_keyframes, 100 bodies × 200 frames | ≤ 120,000   | 106–135   | 205           |
 * | 100 bodies × 500 frames                              | ≤ 300,000   | 142–174   | 269           |
 * | 400 bodies × 500 frames                              | ≤ 1,200,000 | 258–263   | 594           |
 * | 100 bodies × 5,000 frames                            | ≤ 3,000,000 | 356–383   | 997           |
 * | anim.keyframes_insert_many, 100,000 keyframes        | 100,000     | 31–45     | 51            |
 * | 100,000 between the 100,000 keyframes of a curve     | 100,000     | 64–73     | 89            |
 * | anim.keyframe_insert, 10,000 objects (LocRotScale)   | 90,000      | 129–133   | 150           |
 * | anim.keyframe_insert into 900 curves of 1,000 keys   | 900         | 147–154   | 188           |
 *
 * The bakes sample every frame with a frame state of its own (eval/frame-state.ts), which leaves what
 * it evaluated as garbage ({@link frameSamplingBytes}); the frame states of a document share one
 * reading of its objects, F-curves and drivers (eval/frame-input.ts), so that garbage does not grow
 * with the keyframes the document holds: the second table.
 */

/** Peak heap per keyframe an operator adds: 93–172 bytes measured (see the table above), rounded up. */
export const KEYFRAME_ADD_BYTES = 180;

/**
 * Peak heap per F-curve anim.keyframe_insert and anim.keyframes_insert_many write (its copy, sorted
 * and stored, a Yjs entry and its key in the update): about 930 bytes measured (10,000 objects keyed
 * on 9 channels each), rounded up.
 */
export const FCURVE_ADD_BYTES = 1_200;

/**
 * Peak heap per F-curve a bake writes, beyond its keyframes: it builds every keyframe of the curve
 * before it stores it, about 2,900–3,300 bytes measured (10,000 objects × 9 curves of 10 keys),
 * rounded up.
 */
export const BAKE_FCURVE_BYTES = 3_500;

/**
 * Peak heap per object and frame anim.bake_transforms samples (the object's evaluated transform at
 * the frame, kept until every frame is sampled): 645–860 bytes measured (baking location only, so
 * that the keyframes take a third of the run), rounded up.
 */
export const BAKE_BYTES_PER_OBJECT_FRAME = 1_000;

/**
 * Peak heap per keyframe of the F-curves an operator rewrites to add keys to them or change them
 * (each is copied, sorted and stored again): 48–135 bytes measured (anim.interpolation_type,
 * anim.keyframe_delete, a move with 900 animated channels, anim.keyframe_insert into curves of 1,000
 * keys each), rounded up.
 */
export const KEYFRAME_REWRITE_BYTES = 180;

/**
 * Peak heap of rigidbody.bake_to_keyframes besides its frames: building the bodies and their collision
 * shapes, and the garbage of stepping the world and of its contacts, which V8 collects late in a large
 * heap (100 bodies falling on a floor for 200 frames took 123 MB beyond OPERATOR_FIXED_BYTES in a heap
 * of 4 GB, 20,000 body frames; bakes of 25 to 400 bodies needed up to 80 MB beyond their frames in a
 * heap of 3 GB); the frames: per body and baked frame, its sampled transform, the six keyframes it may
 * write and the contacts of its substeps, 600–1,700 bytes measured (100 to 500,000 body frames),
 * rounded up.
 */
export const RIGID_BODY_BAKE_BYTES = 128 * 1024 * 1024;
export const RIGID_BODY_BAKE_BYTES_PER_BODY_FRAME = 1_200;

/** Most frames anim.bake_transforms samples (operators/driver.ts MAX_BAKE_FRAMES; more fail by themselves). */
export const BAKE_TRANSFORMS_MAX_FRAMES = 10_000;

/**
 * Peak heap per keyframe anim.keyframes_insert_many adds, and per keyframe of the F-curve it adds them
 * to (merged with them, sorted and stored again): 100,000 keyframes into an empty curve peaked at
 * 31–45 MiB, between the 100,000 keyframes of a curve at 64–73.8 MiB (OPERATOR_FIXED_BYTES included;
 * a listener on the document's updates, as the server's, encodes the transaction's update); rounded
 * up so that both stay 10% below the estimate (51 and 89 MiB), and the second a quarter below it with
 * V8's --predictable, whose collections fall at the same points in every run (68.2 MiB in every run
 * with Node 22.23.4).
 */
export const INSERT_MANY_BYTES_PER_KEYFRAME = 200;
export const INSERT_MANY_REWRITE_BYTES = 400;

/**
 * Heap a sampled frame takes per keyframe of the document: none. The frame states of a document read
 * its objects, F-curves and drivers once per document state and share them (eval/frame-input.ts), and
 * a frame finds its keys by binary search; every frame state copied every F-curve before (80–84 bytes
 * per keyframe measured).
 */
export const FRAME_STATE_BYTES_PER_KEYFRAME = 0;

/**
 * Heap the frame states of a sampled frame leave per object, bone of an armature object (each is
 * posed), constraint (of an object or a pose bone) and driver of the document: their copies of what
 * they evaluate, with its matrices and poses, garbage once the frame is sampled. Measured as the peak
 * of sampling alone (--trace-gc; a frame state per frame reading every object's matrices, as a bake
 * does; nothing kept), per object and frame: 0.69–1.18 KB for 100 to 5,000 linked cubes, 1.42 KB keyed
 * on 9 channels, 1.57 KB with a constraint each, 1.41–1.48 KB with a driver each, 3.69 KB for 8
 * walking actors (175 objects, 175 bones); rounded up per term, but for the keyed cubes, whose bakes'
 * estimates hold their peaks with 1 KB (the tables above).
 */
export const FRAME_STATE_BYTES_PER_OBJECT = 1_000;
export const FRAME_STATE_BYTES_PER_POSE_BONE = 3_000;
export const FRAME_STATE_BYTES_PER_CONSTRAINT = 600;
export const FRAME_STATE_BYTES_PER_DRIVER = 1_000;

/**
 * The frame states' garbage (FRAME_STATE_BYTES_PER_*) can live long enough for V8 to move it into its
 * old generation, where it piles up until a full collection, which V8 starts when the heap has grown to
 * about this many times what it keeps. Measured with --trace-gc, the garbage of one sampled frame times
 * the frames, or this many times what the heap kept meanwhile (the document, one frame's garbage and
 * the process's own, {@link BAKE_HEAP_BYTES}), whichever is less, held every peak of the table below
 * (and of the first one). When every frame state copied every F-curve, these bakes peaked at 82 MB
 * (the first row) to 915 MB (the last), and the last took 412 s instead of 3.3 s.
 *
 * | bake (anim.bake_transforms; heap of 4 GB)    | keyframes in the document | peak (MB) | estimate (MB) |
 * | -------------------------------------------- | ------------------------- | --------- | ------------- |
 * | 1 object × 30 frames, 101 objects            | 27,000                    | 16        | 35            |
 * | 1 object × 300 frames, 11 objects            | 2,700                     | 17        | 36            |
 * | 1 object × 300 frames, 13 objects            | 3,240                     | 17        | 37            |
 * | 1 object × 300 frames, 51 objects            | 13,500                    | 27        | 47            |
 * | 1 object × 300 frames, 101 objects           | 27,000                    | 38        | 62            |
 * | 1 object × 1,000 frames, 101 objects         | 27,000                    | 93        | 131           |
 * | 1 object × 300 frames, 101 objects           | 270,000                   | 38        | 62            |
 * | 100 objects × 300 frames again (a re-bake)   | 270,000                   | 84–85     | 185           |
 * | 100 objects × 1,000 frames again (a re-bake) | 900,000                   | 250–252   | 535           |
 */
export const BAKE_GARBAGE_GROWTH = 4;

/**
 * Heap the process keeps besides the document and the bake, counted in what V8 grows over
 * ({@link BAKE_GARBAGE_GROWTH}): 39–42 MB in the measured runs, rounded up.
 */
export const BAKE_HEAP_BYTES = 64 * 1024 * 1024;

/** A stored datablock: a Y.Map of its fields (SceneDoc.createBlock), read in place. */
type StoredBlock = { get(key: string): unknown };

/**
 * Heap one frame state of `doc` leaves while a frame is sampled: what it evaluates of the document's
 * objects, the bones of their armatures (every bone is posed, eval/frame-state.ts), their constraints
 * and the bones', and its drivers (FRAME_STATE_BYTES_PER_*), whatever the document's keyframes.
 * Counted without copying: a pass over the stored objects, whose fields are read in place.
 */
export function frameStateBytes(doc: SceneDoc): number {
  let drivers = 0;
  for (const item of doc.map('drivers')._map.values()) if (!item.deleted) drivers++;
  const armatures = doc.map('armatures');
  let objects = 0;
  let bones = 0;
  let constraints = 0;
  for (const v of doc.map('objects').values()) {
    objects++;
    const y = v as StoredBlock;
    const own = y.get('constraints');
    if (Array.isArray(own)) constraints += own.length;
    if (y.get('type') !== 'ARMATURE') continue;
    const data = y.get('data');
    const arm = typeof data === 'string' ? (armatures.get(data) as StoredBlock | undefined) : undefined;
    const armBones = arm?.get('bones');
    if (Array.isArray(armBones)) bones += armBones.length;
    const pose = y.get('pose') as Partial<ObjectData['pose']> | null | undefined;
    if (pose?.bones && typeof pose.bones === 'object')
      for (const b of Object.values(pose.bones))
        if (Array.isArray(b?.constraints)) constraints += b.constraints.length;
  }
  return (
    FRAME_STATE_BYTES_PER_OBJECT * objects +
    FRAME_STATE_BYTES_PER_POSE_BONE * bones +
    FRAME_STATE_BYTES_PER_CONSTRAINT * constraints +
    FRAME_STATE_BYTES_PER_DRIVER * drivers
  );
}

/**
 * The garbage of sampling `frames` frames of `doc` with `copies` frame states each (the bakes; a
 * simulation with animated bodies builds one more per frame it steps): the copies of every frame, at
 * most {@link BAKE_GARBAGE_GROWTH} times what the heap keeps meanwhile (the document, one frame's
 * copies and {@link BAKE_HEAP_BYTES}).
 */
export function frameSamplingBytes(doc: SceneDoc, frames: number, copies = 1): number {
  const perFrame = copies * frameStateBytes(doc);
  return Math.min(
    Math.max(0, frames) * perFrame,
    BAKE_GARBAGE_GROWTH * (BAKE_HEAP_BYTES + projectStoredBytes(doc) + perFrame),
  );
}

/** Frame states a bake builds per sampled frame: one, two when the simulation has animated bodies. */
function frameStatesPerFrame(doc: SceneDoc): number {
  if (!sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).enabled) return 1;
  return documentSimulationBodies(doc).kinematic > 0 ? 2 : 1;
}

/**
 * Bytes of the rigid body frames a bake of `doc` to frame `end` simulates and its cache keeps beyond
 * what it holds already (physics/memory.ts, physics/rigid-body.ts rigidBodyCacheBytes).
 */
function newSimulationBytes(doc: SceneDoc, end: number): number {
  return Math.max(0, documentSimulationBytes(doc, end) - rigidBodyCacheBytes(doc));
}

/** What an operator that writes keyframes takes (bytes beyond OPERATOR_FIXED_BYTES) and adds. */
export interface KeyframeWrites {
  /** Peak heap beyond OPERATOR_FIXED_BYTES. */
  bytes: number;
  /** Keyframes it adds (at most). */
  keys: number;
  /** Heap the document keeps of them: KEYFRAME_STORED_BYTES each, FCURVE_STORED_BYTES per new F-curve. */
  stored: number;
  /** Heap a save takes for them for a moment beyond `stored` (memory-objects.ts saveBytes). */
  save: number;
  /**
   * Bytes of rigid body frames it simulates that the document's cache keeps afterwards (not part of
   * `stored`, not saved; 0 or absent: none).
   */
  simulation?: number;
  /** What to lower, completing "Lower …". */
  lower: string;
}

/** The stored F-curve of a channel, read in place (no copy of its keyframes). */
function storedCurve(
  doc: SceneDoc,
  ref: Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'>,
): FCurve | null {
  const v = doc.map('fcurves').get(fcurveKey(ref)) as FCurve | undefined;
  return v && Array.isArray(v.keyframes) ? v : null;
}

/**
 * Keyframes added to the channels `refs` (`perChannel` each): their peak and what the document keeps,
 * with the keyframes the F-curves already hold rewritten (copied and stored again) and new F-curves
 * counted. `fcurveBytes`: the peak per F-curve written. With `replaces` (a bake of frames `start` …
 * `end`), the keyframes the curves hold in that range are replaced: the document keeps only the
 * keyframes beyond them (`keys`: those).
 */
function channelWrites(
  doc: SceneDoc,
  refs: readonly Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'>[],
  perChannel: number,
  fcurveBytes: number,
  replaces?: { start: number; end: number },
): { bytes: number; keys: number; stored: number } {
  let rewritten = 0;
  let fresh = 0;
  let added = 0;
  for (const ref of refs) {
    const fc = storedCurve(doc, ref);
    if (!fc) {
      fresh++;
      added += perChannel;
      continue;
    }
    rewritten += fc.keyframes.length;
    let replaced = 0;
    // driver.ts and physics.ts keep the keys outside the baked range (1e-3 frames of tolerance)
    if (replaces)
      for (const k of fc.keyframes)
        if (k && k.frame >= replaces.start - 1e-3 && k.frame <= replaces.end + 1e-3) replaced++;
    added += Math.max(0, perChannel - replaced);
  }
  return {
    bytes:
      KEYFRAME_ADD_BYTES * refs.length * perChannel +
      fcurveBytes * refs.length +
      KEYFRAME_REWRITE_BYTES * rewritten,
    keys: added,
    stored: KEYFRAME_STORED_BYTES * added + FCURVE_STORED_BYTES * fresh,
  };
}

const writes = (w: { bytes: number; keys: number; stored: number }, lower: string): KeyframeWrites => ({
  ...w,
  save: saveBytes(w.stored),
  lower,
});

/** The three channels of each transform path of `ids`. */
function transformChannels(ids: readonly string[], paths: readonly string[]) {
  const out: Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'>[] = [];
  for (const id of ids)
    for (const path of paths)
      for (let index = 0; index < 3; index++) out.push({ target_type: 'object', target_id: id, path, index });
  return out;
}

const TRANSFORM_PATHS = ['location', 'rotation_euler', 'scale'] as const;

/**
 * anim.bake_transforms of objects `ids` over frames `start`…`end` every `step` frames: a keyframe
 * per object, frame and channel (3 per baked transform path; all three paths with clear_parents; the
 * keyframes the channels hold in the range are replaced), the transforms sampled first with a frame
 * state per frame ({@link frameSamplingBytes}), and the rigid body simulation to `end` when the scene
 * has rigid bodies (physics/memory.ts; its cache keeps the frames). Null when the range fails by
 * itself (empty, or more than BAKE_TRANSFORMS_MAX_FRAMES frames).
 */
export function bakeTransformsWrites(
  doc: SceneDoc,
  ids: readonly string[],
  p: { start: number; end: number; step: number; channels: readonly string[]; clearParents: boolean },
): KeyframeWrites | null {
  if (!ids.length || !(p.end >= p.start) || !(p.step >= 1)) return null;
  const frames = Math.floor((p.end - p.start) / p.step) + 1;
  if (frames > BAKE_TRANSFORMS_MAX_FRAMES) return null;
  const paths = p.clearParents ? TRANSFORM_PATHS : [...new Set(p.channels)];
  const w = channelWrites(doc, transformChannels(ids, paths), frames, BAKE_FCURVE_BYTES, p);
  w.bytes +=
    BAKE_BYTES_PER_OBJECT_FRAME * ids.length * frames +
    frameSamplingBytes(doc, frames, frameStatesPerFrame(doc)) +
    documentSimulationBytes(doc, p.end);
  return {
    ...writes(
      w,
      'the frame range (frame_start to frame_end, or a larger step) or the number of objects to bake (objects, or the selected objects)',
    ),
    simulation: newSimulationBytes(doc, p.end),
  };
}

/**
 * rigidbody.bake_to_keyframes of the ACTIVE rigid bodies among `objects` over frames `start`…`end`
 * every `step` frames: at most six keyframes per body and frame (location and rotation; the bake
 * drops those equal to both neighbours, which cannot be known before the simulation), the bodies and
 * the simulation of the world to `end` (physics/memory.ts). Null when it fails by itself (the world
 * disabled, an empty or too long range, no ACTIVE body).
 */
export function rigidBodyBakeWrites(
  doc: SceneDoc,
  objects: readonly ObjectData[],
  p: { start: number; end: number; step: number },
): KeyframeWrites | null {
  if (!sanitizeRigidBodyWorld(doc.getScene().rigidbody_world).enabled) return null;
  if (!(p.end >= p.start) || p.end - p.start + 1 > MAX_SIMULATED_FRAMES || !(p.step >= 1)) return null;
  const bodies = objects.filter((o) => sanitizeRigidBody(o.rigid_body)?.type === 'ACTIVE').map((o) => o.id);
  if (!bodies.length) return null;
  const frames = Math.floor((p.end - p.start) / p.step) + 1;
  const w = channelWrites(
    doc,
    transformChannels(bodies, ['location', 'rotation_euler']),
    frames,
    BAKE_FCURVE_BYTES,
    p,
  );
  // the frames' keyframes are part of the cost per body frame
  w.bytes +=
    RIGID_BODY_BAKE_BYTES +
    RIGID_BODY_BAKE_BYTES_PER_BODY_FRAME * bodies.length * frames -
    KEYFRAME_ADD_BYTES * bodies.length * 6 * frames +
    frameSamplingBytes(doc, frames, frameStatesPerFrame(doc)) +
    documentSimulationBytes(doc, p.end);
  return {
    ...writes(
      w,
      'the frame range (frame_start to frame_end, or a larger step) or the number of rigid bodies to bake (objects, or the selected objects)',
    ),
    simulation: newSimulationBytes(doc, p.end),
  };
}

/**
 * anim.keyframes_insert_many: `keys` keyframes on one channel (`ref`, null when its target is not
 * resolved here: then as a new F-curve), the keyframes it holds rewritten unless `replace`.
 */
export function insertManyWrites(
  doc: SceneDoc,
  ref: Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'> | null,
  keys: number,
  replace: boolean,
): KeyframeWrites {
  const fc = ref ? storedCurve(doc, ref) : null;
  const rewritten = fc && !replace ? fc.keyframes.length : 0;
  return writes(
    {
      bytes: INSERT_MANY_BYTES_PER_KEYFRAME * keys + FCURVE_ADD_BYTES + INSERT_MANY_REWRITE_BYTES * rewritten,
      keys,
      stored: KEYFRAME_STORED_BYTES * keys + (fc ? 0 : FCURVE_STORED_BYTES),
    },
    'the number of frames and values',
  );
}

/**
 * `keys` keyframes an operator writes into `fcurves` F-curves without reading the channels first (the
 * director's desk operators: camera moves, actor poses and gaits, launches, tethers; memory-desk.ts):
 * per keyframe what an insert adds at the peak ({@link KEYFRAME_ADD_BYTES}), per F-curve what a bake
 * builds before it stores it ({@link BAKE_FCURVE_BYTES}), and kept as new keyframes and new F-curves.
 * `rewritten`: keyframes the channels already hold, copied and stored again
 * ({@link KEYFRAME_REWRITE_BYTES}).
 */
export function newKeyframesWrites(
  keys: number,
  fcurves: number,
  lower: string,
  rewritten = 0,
): KeyframeWrites {
  const k = Math.max(0, Math.ceil(keys));
  const f = Math.max(0, Math.ceil(fcurves));
  return writes(
    {
      bytes: KEYFRAME_ADD_BYTES * k + BAKE_FCURVE_BYTES * f + KEYFRAME_REWRITE_BYTES * Math.max(0, rewritten),
      keys: k,
      stored: KEYFRAME_STORED_BYTES * k + FCURVE_STORED_BYTES * f,
    },
    lower,
  );
}

/** Channels of each keying set of anim.keyframe_insert (Available: the object's own F-curves). */
const KEYING_SETS: Readonly<Record<string, readonly string[]>> = {
  LocRotScale: TRANSFORM_PATHS,
  Location: ['location'],
  Rotation: ['rotation_euler'],
  Scale: ['scale'],
};

/**
 * anim.keyframe_insert on `objects` with keying set `type`: a keyframe per channel of the set (the
 * object's own F-curves with Available), each F-curve copied with its keyframes and stored again.
 */
export function keyframeInsertWrites(
  doc: SceneDoc,
  objects: readonly ObjectData[],
  type: string,
): KeyframeWrites {
  let refs: Pick<FCurve, 'target_type' | 'target_id' | 'path' | 'index'>[];
  if (type === 'Available') {
    const ids = new Set(objects.map((o) => o.id));
    refs = [];
    for (const v of doc.map('fcurves').values()) {
      const fc = v as FCurve;
      if (fc?.target_type === 'object' && ids.has(fc.target_id)) refs.push(fc);
    }
  } else
    refs = transformChannels(
      objects.map((o) => o.id),
      KEYING_SETS[type] ?? TRANSFORM_PATHS,
    );
  return writes(channelWrites(doc, refs, 1, FCURVE_ADD_BYTES), 'the number of selected objects');
}

/**
 * Peak heap per keyframe an operator copies to a new F-curve (anim.ts copyAnimation): the F-curve
 * read, sorted and stored again, and the update of the transaction. Measured with --trace-gc on
 * object.duplicate of animated cubes (three location F-curves each, linked), the objects' and
 * F-curves' share taken off: 84 bytes per keyframe (1,000 objects × 1,000 keys, 3 million
 * keyframes, 263 MB at the peak), 103 (100 objects × 3,000 keys with a driver each, 96 MB); rounded up.
 */
export const KEYFRAME_COPY_BYTES = 130;

/**
 * Peak heap per driver an operator copies (anim.ts copyAnimation): its JSON cloned, its variables
 * remapped and stored, and the update of the transaction (with 10,000 duplicated objects of 30
 * keyframes and a driver each, 191 MB at the peak, the objects most of it); not measured apart,
 * set at three times what the document keeps of one (memory-objects.ts DRIVER_STORED_BYTES).
 */
export const DRIVER_ADD_BYTES = 3_000;

/** The animation the document stores for one datablock: its F-curves, their keyframes and its drivers. */
export interface StoredAnimation {
  fcurves: number;
  keys: number;
  /** Driver keys (to read their JSON with memory-objects.ts driverExtraJsonChars). */
  drivers: string[];
}

/**
 * The animation of every animated datablock of the document, by `<type>:<id>` (as F-curves and
 * drivers name their targets): one pass over the stored F-curves and drivers, read in place.
 */
export function animationByTarget(doc: SceneDoc): Map<string, StoredAnimation> {
  const out = new Map<string, StoredAnimation>();
  const of = (type: unknown, id: unknown) => {
    const key = `${String(type)}:${String(id)}`;
    let a = out.get(key);
    if (!a) out.set(key, (a = { fcurves: 0, keys: 0, drivers: [] }));
    return a;
  };
  for (const v of doc.map('fcurves').values()) {
    const fc = v as Partial<FCurve> | null;
    if (!fc) continue;
    const a = of(fc.target_type, fc.target_id);
    a.fcurves++;
    a.keys += Array.isArray(fc.keyframes) ? fc.keyframes.length : 0;
  }
  for (const [key, v] of doc.map('drivers').entries()) {
    const d = v as { target_type?: unknown; target_id?: unknown } | null;
    if (d) of(d.target_type, d.target_id).drivers.push(key);
  }
  return out;
}

/**
 * The animation an operator copies to new datablocks (anim.ts copyAnimation, object.duplicate): the
 * F-curves, keyframes and drivers of the datablocks `sources` names (`<type>:<id>`, each once) as
 * their copies get them; null when none of them is animated. Peak per keyframe
 * {@link KEYFRAME_COPY_BYTES}, per F-curve an insert's, per driver {@link DRIVER_ADD_BYTES}; kept as
 * the project counts them afterwards
 * (memory-objects.ts KEYFRAME_STORED_BYTES, FCURVE_STORED_BYTES, DRIVER_STORED_BYTES and the
 * drivers' JSON).
 */
export function copiedAnimationWrites(
  doc: SceneDoc,
  sources: Iterable<string>,
  byTarget: Map<string, StoredAnimation> = animationByTarget(doc),
): (KeyframeWrites & { fcurves: number; drivers: number }) | null {
  let fcurves = 0;
  let keys = 0;
  let drivers = 0;
  let driverJson = 0;
  for (const key of new Set(sources)) {
    const a = byTarget.get(key);
    if (!a) continue;
    fcurves += a.fcurves;
    keys += a.keys;
    drivers += a.drivers.length;
    for (const d of a.drivers) driverJson += driverExtraJsonChars(doc, d);
  }
  if (!fcurves && !drivers) return null;
  const stored =
    KEYFRAME_STORED_BYTES * keys +
    FCURVE_STORED_BYTES * fcurves +
    DRIVER_STORED_BYTES * drivers +
    OBJECT_JSON_STORED_BYTES * driverJson;
  return {
    bytes:
      KEYFRAME_COPY_BYTES * keys +
      FCURVE_ADD_BYTES * fcurves +
      DRIVER_ADD_BYTES * drivers +
      OBJECT_JSON_ADD_BYTES * driverJson,
    keys,
    fcurves,
    drivers,
    stored,
    save: saveBytes(stored),
    lower: 'the number of selected objects (or their animation)',
  };
}
