import type { Mat4, Vec3 } from '../../math/types';
import { compose4, identity4, invert4, multiply4 } from '../../math/mat4';
import { normalize3, sub3, transformDirection3, transformPoint3 } from '../../math/vec3';
import type { ArmatureData, ConstraintData, Keyframe, ObjectData, PoseBone } from '../../doc/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import { computePose } from '../../armature/pose';
import { createConstraint } from '../../constraints/catalogue';
import { axisLengths, matrixToCompatibleEuler, normalizedAxes } from '../../constraints/math';
import { FrameState } from '../../eval/frame-state';
import { meshBounds } from '../../mesh/types';
import { OperatorError } from '../../operators/context';
import { uniqueName } from '../../util/names';
import { DESK_PROPS } from '../props';
import { keyPose, poseChannelPaths } from './actor';
import { legFrame, legRigs, solveLeg, type LegSolution } from './gait';
import { blueprintFor, isHumanoidKind, requireBuiltKind } from './kinds';
import { KeyWriter, bonePath, channelKeys } from './keys';
import { humanoidStoop } from './mannequin';
import { HUMAN_POSE_SPECS, groundedPose, humanRotations, poseBones, type HumanPoseSpec } from './poses';
import { DEG, RIDE_PREFIX, actorParts, requireActor, rotEuler, type ActorMeta } from './rig';
import { yawOf } from './locomotion';

/*
 * What actors do with other objects (spec §8): look at them (DAMPED_TRACK bone constraints on the
 * neck and head, their influence keyed), hold them (a CHILD_OF on the prop with the hand bone as
 * subtarget) and ride a mount (a CHILD_OF on the rider with the mount's `saddle` bone). A CHILD_OF's
 * influence is keyed 0 → 1 at the grab with its inverse set there, so the held object takes the
 * place it is given at that frame and then follows the bone (a held prop glides into the hand over
 * the frames before); at the release the influence goes back to 0 and the object's own transform
 * is keyed where it was seen (its visual transform), so it stays there (or, with a rigid body,
 * falls from there: its start_frame). An object is held by one hand and a rider sits on one saddle
 * at a time: holding or riding again replaces or ends what overlaps it.
 */

/** The object `ref` names (id or exact name), or NOT_FOUND. */
function requireObject(doc: SceneDoc, ref: string, what: string): ObjectData {
  const o = doc.getObject(ref) ?? doc.resolveObject(ref);
  if (!o) throw new OperatorError(`${what} '${ref}' not found`, 'NOT_FOUND');
  return o;
}

const objectInfluence = (name: string) => `constraints[${JSON.stringify(name)}].influence`;
const boneInfluence = (bone: string, name: string) =>
  `pose.bones[${JSON.stringify(bone)}].constraints[${JSON.stringify(name)}].influence`;

/**
 * Keys an influence channel from `from` (its value at `frame`) to `to` over `blend` frames; a
 * blend of 0 switches at `frame` (CONSTANT from the frame before).
 */
function rampInfluence(
  w: KeyWriter,
  id: string,
  path: string,
  frame: number,
  blend: number,
  from: number,
  to: number,
) {
  w.clear(id, path, 0, frame - 1, frame + blend);
  if (blend > 0) {
    w.key(id, path, 0, frame, from);
    w.key(id, path, 0, frame + blend, to);
  } else {
    w.key(id, path, 0, frame - 1, from, 'CONSTANT');
    w.key(id, path, 0, frame, to, 'CONSTANT');
  }
}

// ---------------------------------------------------------------- look at

const LOOK_PREFIX = 'Look ';
const LOOK_LIMIT = 'Look Limit';

/**
 * Turns the actor's head (and partly its neck) toward object `target` from `frame`, blended in
 * over blend_frames (default 6); null turns it back to looking ahead. Other looks blend out.
 * Returns the head's constraint name (null when looking ahead).
 */
export function lookAtObject(
  doc: SceneDoc,
  actorId: string,
  target: string | null,
  o: { frame: number; blend_frames?: number },
): { constraint: string | null } {
  const meta = requireActor(doc, actorId);
  const human = isHumanoidKind(requireBuiltKind(meta.kind));
  if (!Number.isFinite(o.frame)) throw new OperatorError('frame must be a number', 'INVALID_PARAMS');
  const blend = Math.max(0, Math.round(o.blend_frames ?? 6));
  const tgt = target === null ? null : requireObject(doc, target, 'Look target');
  if (tgt && (tgt.id === meta.id || tgt.custom_props?.[DESK_PROPS.actor] === meta.id))
    throw new OperatorError('An actor cannot look at itself', 'INVALID_PARAMS');
  const obj = doc.getObject(meta.id)!;
  const bones: Record<string, PoseBone> = { ...obj.pose.bones };
  // the head turns fully and the neck a little: people track with the face (+Z of the upright
  // head), animals along the head bone (the muzzle)
  const rig = human
    ? [
        { bone: 'neck', weight: 0.35, axis: 'TRACK_Z' },
        { bone: 'head', weight: 1, axis: 'TRACK_Z' },
      ]
    : [
        { bone: 'neck', weight: 0.3, axis: 'TRACK_Y' },
        { bone: 'head', weight: 0.8, axis: 'TRACK_Y' },
      ];
  const live = new FrameState(doc, o.frame).get<ObjectData>('object', meta.id)?.pose?.bones ?? {};
  const influenceNow = (bone: string, c: ConstraintData) =>
    live[bone]?.constraints?.find((x) => x.name === c.name)?.influence ?? c.influence;
  const w = new KeyWriter();
  let made: string | null = null;
  for (const { bone, weight, axis } of rig) {
    const pb = bones[bone];
    if (!pb) continue;
    const list = [...(pb.constraints ?? [])];
    for (const c of list) {
      if (c.type !== 'DAMPED_TRACK' || !c.name.startsWith(LOOK_PREFIX) || (tgt && c.target === tgt.id))
        continue;
      rampInfluence(w, meta.id, boneInfluence(bone, c.name), o.frame, blend, influenceNow(bone, c), 0);
    }
    if (tgt) {
      let c = list.find(
        (x) => x.type === 'DAMPED_TRACK' && x.name.startsWith(LOOK_PREFIX) && x.target === tgt.id,
      );
      if (!c) {
        c = createConstraint('DAMPED_TRACK', {
          name: uniqueName(
            `${LOOK_PREFIX}${tgt.name}`,
            list.map((x) => x.name),
          ),
          target: tgt.id,
          influence: 0,
          show_expanded: false,
          params: { track_axis: axis, head_tail: 0 },
        });
        // looks go before the limit that keeps a head from turning round
        const limit = list.findIndex((x) => x.name === LOOK_LIMIT);
        list.splice(limit >= 0 ? limit : list.length, 0, c);
      }
      if (human && bone === 'head' && !list.some((x) => x.name === LOOK_LIMIT))
        list.push(
          createConstraint('LIMIT_ROTATION', {
            name: LOOK_LIMIT,
            show_expanded: false,
            params: {
              use_limit_x: true,
              use_limit_y: true,
              use_limit_z: true,
              min_x: -55 * DEG,
              max_x: 55 * DEG,
              min_y: -80 * DEG,
              max_y: 80 * DEG,
              min_z: -35 * DEG,
              max_z: 35 * DEG,
              owner_space: 'LOCAL',
            },
          }),
        );
      rampInfluence(w, meta.id, boneInfluence(bone, c.name), o.frame, blend, influenceNow(bone, c), weight);
      if (bone === 'head') made = c.name;
    }
    bones[bone] = { ...pb, constraints: list };
  }
  doc.updateObject(meta.id, { pose: { ...obj.pose, bones } });
  w.commit(doc);
  return { constraint: made };
}

// ---------------------------------------------------------------- holds and rides as spans

/** World matrix and length of a posed bone's head frame at a frame state. */
function boneWorld(fs: FrameState, actorId: string, bone: string): { matrix: Mat4; length: number } {
  const b = fs.boneMatrix(actorId, bone);
  if (!b) throw new OperatorError(`Bone '${bone}' of the actor cannot be evaluated`, 'FAILED');
  return b;
}

/** Tolerance of key frames (keys.ts treats keys this close as one frame). */
const FRAME_EPS = 1e-3;

const HOLD_PREFIX = 'Hold ';

/**
 * When a hold or a ride (a CHILD_OF named 'Hold …' or 'Ride …') holds, read from its influence
 * keys: it rises from `start` (a glide into the hand; = `grab` when it takes hold at once), holds
 * fully from `grab` and lets go at `release` (Infinity: never).
 */
export interface AttachSpan {
  constraint: ConstraintData;
  start: number;
  grab: number;
  release: number;
}

const influenceKeys = (doc: SceneDoc, id: string, name: string) =>
  channelKeys(doc, id, objectInfluence(name), 0);

function spanOf(doc: SceneDoc, id: string, c: ConstraintData): AttachSpan | null {
  const keys = influenceKeys(doc, id, c.name);
  if (!keys.length)
    return c.influence >= 0.5
      ? { constraint: c, start: -Infinity, grab: -Infinity, release: Infinity }
      : null;
  const g = keys.findIndex((k) => k.value >= 1 - 1e-6);
  if (g < 0) return null;
  let release = Infinity;
  for (let i = g + 1; i < keys.length; i++)
    if (keys[i].value < 0.5) {
      release = keys[i].frame;
      break;
    }
  const b = keys[g - 1];
  const glide = !!b && b.value <= 1e-6 && b.interpolation !== 'CONSTANT';
  return { constraint: c, start: glide ? b.frame : keys[g].frame, grab: keys[g].frame, release };
}

/** The holds ('Hold …') or rides ('Ride …') of object `id`, in the order they take hold. */
export function attachSpans(doc: SceneDoc, id: string, prefix: string): AttachSpan[] {
  const out: AttachSpan[] = [];
  for (const c of doc.getObject(id)?.constraints ?? []) {
    if (c.type !== 'CHILD_OF' || !c.name.startsWith(prefix) || !c.target) continue;
    const s = spanOf(doc, id, c);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.grab - b.grab);
}

const overlaps = (s: AttachSpan, from: number, to: number) => s.grab < to && from < s.release;

/** An object's own location and rotation channels (a hold or a ride keys them; never the scale). */
const OWN = ['location', 'rotation_euler'] as const;

/** Drops the keys of an object's own location and rotation at `frame`. */
function dropOwn(w: KeyWriter, id: string, frame: number): void {
  if (!Number.isFinite(frame)) return;
  for (const p of OWN) for (let i = 0; i < 3; i++) w.drop(id, p, i, frame);
}

/** Removes constraint `c` of object `id` and the F-curve of its influence. */
function removeConstraint(doc: SceneDoc, id: string, c: ConstraintData): void {
  const o = doc.getObject(id);
  if (!o) return;
  doc.updateObject(id, { constraints: (o.constraints ?? []).filter((x) => x.id !== c.id) });
  doc.removeFCurve(
    fcurveKey({ target_type: 'object', target_id: id, path: objectInfluence(c.name), index: 0 }),
  );
}

/**
 * Lets go of span `s` at `at` (CONSTANT): its influence keys from `at` on replaced by 0 there, and
 * the keys it had for letting go later dropped (the caller keys what follows).
 */
function truncateInfluence(w: KeyWriter, doc: SceneDoc, id: string, s: AttachSpan, at: number): void {
  const path = objectInfluence(s.constraint.name);
  const before = influenceKeys(doc, id, s.constraint.name).filter((k) => k.frame < at - FRAME_EPS);
  w.clear(id, path, 0, at - 2 * FRAME_EPS, Infinity);
  // a hold without keys holds from the start: it keeps holding until the frame before
  if (!before.length) w.key(id, path, 0, at - 1, 1, 'CONSTANT');
  w.key(id, path, 0, at, 0, 'CONSTANT');
}

// ---------------------------------------------------------------- hold

/** A carrying-posture constraint of a hold on one bone of its holder's arm. */
interface ArmPart {
  bone: string;
  c: ConstraintData;
}

const channelsOf = (m: Readonly<Mat4>, oldRot: Readonly<Vec3>): { location: Vec3; rotation: Vec3 } => ({
  location: [m[12], m[13], m[14]],
  rotation: matrixToCompatibleEuler(m, oldRot),
});

/**
 * The carrying posture of a holding arm (joint angles as poses.ts writes them): the upper arm a
 * little forward and out, the forearm forward at the waist and turned slightly in, so what the hand
 * holds is carried in front of the body (where rideo draws a held prop) instead of against the leg.
 * LIMIT_ROTATION constraints on the upper arm and forearm (min = max, the bone's local rotation)
 * force it over whatever the arm is keyed to do, their influence keyed with the hold.
 */
const HOLD_ARM: HumanPoseSpec = { arm: [16, 16], armOut: [10, 10], armTwist: [20, 20], elbow: [80, 80] };

/**
 * Frames the arm takes to come up into the carrying posture before the grab (and to go down after
 * the release), and the prop to glide from where it lies into the hand.
 */
export const HOLD_BLEND = 6;

/** Offset (frames) before a release at which the held prop is read where it is seen in the hand. */
const RELEASE_EPS = 1e-3;

/** Arm bones whose carrying posture a hold on `subtarget` keys (a person's hand; none for a mouth). */
const armBones = (subtarget: string): string[] => {
  const m = /^hand\.([LR])$/.exec(subtarget);
  return m ? [`upper_arm.${m[1]}`, `forearm.${m[1]}`] : [];
};

/** Id of the carrying-posture constraint a hold (CHILD_OF `holdId`) puts on arm bone `bone`. */
const armId = (holdId: string, bone: string) => `${holdId}.${bone}`;

/**
 * The carrying-posture constraints of hold `s` on its holder's arm: by their ids, or (holds keyed
 * before they had them) the 'Hold …' LIMIT_ROTATION fully on at the grab and the release.
 */
function holdArms(doc: SceneDoc, s: AttachSpan): ArmPart[] {
  const holder = s.constraint.target ? doc.getObject(s.constraint.target) : null;
  if (!holder) return [];
  const out: ArmPart[] = [];
  const on = (keys: Keyframe[], frame: number) =>
    keys.some((k) => Math.abs(k.frame - frame) <= FRAME_EPS && k.value >= 1 - 1e-6);
  for (const bone of armBones(s.constraint.subtarget)) {
    const list = holder.pose?.bones?.[bone]?.constraints ?? [];
    let c = list.find((x) => x.id === armId(s.constraint.id, bone));
    c ??= list.find((x) => {
      if (x.type !== 'LIMIT_ROTATION' || !x.name.startsWith(HOLD_PREFIX)) return false;
      const keys = channelKeys(doc, holder.id, boneInfluence(bone, x.name), 0);
      return on(keys, s.grab) && (!Number.isFinite(s.release) || on(keys, s.release));
    });
    if (c) out.push({ bone, c });
  }
  return out;
}

/**
 * Adds the carrying posture's constraints to one arm of a humanoid actor (named `Hold <prop>`, ids
 * from hold `holdId`), their influence keyed in `w`: up over HOLD_BLEND frames before `frame`, down
 * after `release`.
 */
function holdArm(
  doc: SceneDoc,
  meta: ActorMeta,
  side: 'L' | 'R',
  propName: string,
  holdId: string,
  frame: number,
  release: number,
  w: KeyWriter,
): void {
  const kind = requireBuiltKind(meta.kind);
  if (!isHumanoidKind(kind)) return;
  const { rot } = humanRotations(HOLD_ARM, humanoidStoop(kind), meta.height);
  const obj = doc.getObject(meta.id)!;
  const bones: Record<string, PoseBone> = { ...obj.pose.bones };
  const arm = [`upper_arm.${side}`, `forearm.${side}`];
  const taken = arm.flatMap((b) => (bones[b]?.constraints ?? []).map((c) => c.name));
  const name = uniqueName(`${HOLD_PREFIX}${propName}`, taken);
  for (const bone of arm) {
    const pb = bones[bone];
    const e = rot[bone];
    if (!pb || !e) continue;
    const c = createConstraint('LIMIT_ROTATION', {
      id: armId(holdId, bone),
      name,
      influence: 0,
      show_expanded: false,
      params: {
        use_limit_x: true,
        use_limit_y: true,
        use_limit_z: true,
        min_x: e[0],
        max_x: e[0],
        min_y: e[1],
        max_y: e[1],
        min_z: e[2],
        max_z: e[2],
        owner_space: 'LOCAL',
      },
    });
    bones[bone] = { ...pb, constraints: [...(pb.constraints ?? []), c] };
    const path = boneInfluence(bone, name);
    const end = Number.isFinite(release) ? release : frame;
    w.clear(meta.id, path, 0, frame - HOLD_BLEND - 1, end + HOLD_BLEND);
    w.key(meta.id, path, 0, frame - HOLD_BLEND, 0);
    w.key(meta.id, path, 0, frame, 1);
    if (Number.isFinite(release)) {
      w.key(meta.id, path, 0, release, 1);
      w.key(meta.id, path, 0, release + HOLD_BLEND, 0);
    }
  }
  doc.updateObject(meta.id, { pose: { ...obj.pose, bones } });
}

/** Removes hold `s` of prop `propId`: its constraint, its keys and its holder's carrying posture. */
function removeHold(doc: SceneDoc, propId: string, s: AttachSpan): void {
  const arms = holdArms(doc, s);
  const holder = s.constraint.target;
  if (holder && arms.length) {
    const o = doc.getObject(holder)!;
    const bones: Record<string, PoseBone> = { ...o.pose.bones };
    for (const { bone, c } of arms) {
      const pb = bones[bone];
      if (!pb) continue;
      bones[bone] = { ...pb, constraints: (pb.constraints ?? []).filter((x) => x.id !== c.id) };
      doc.removeFCurve(
        fcurveKey({ target_type: 'object', target_id: holder, path: boneInfluence(bone, c.name), index: 0 }),
      );
    }
    doc.updateObject(holder, { pose: { ...o.pose, bones } });
  }
  removeConstraint(doc, propId, s.constraint);
  // where it held the prop still and let it go
  const w = new KeyWriter();
  dropOwn(w, propId, s.start);
  dropOwn(w, propId, s.grab);
  dropOwn(w, propId, s.release);
  w.commit(doc);
}

/** Hold `s` lets go of the prop at `at`, its holder's arm going down from there. */
function truncateHold(doc: SceneDoc, propId: string, s: AttachSpan, at: number): void {
  const w = new KeyWriter();
  truncateInfluence(w, doc, propId, s, at);
  dropOwn(w, propId, s.release);
  const holder = s.constraint.target;
  if (holder)
    for (const { bone, c } of holdArms(doc, s)) {
      const path = boneInfluence(bone, c.name);
      w.clear(holder, path, 0, at - 2 * FRAME_EPS, Infinity);
      w.key(holder, path, 0, at, 1);
      w.key(holder, path, 0, at + HOLD_BLEND, 0);
    }
  w.commit(doc);
}

/**
 * Makes room for a hold of prop `propId` by bone `bone` of `actorId` from `grab` to `release`: one
 * object is never held twice at once. A hold of the same hand that overlaps it is replaced (holding
 * a prop again with a release frame fixes the hold); another that would take the prop during it is
 * dropped; another that still holds the prop at the grab lets go there (a hand-off).
 */
function settleHolds(
  doc: SceneDoc,
  propId: string,
  actorId: string,
  bone: string,
  grab: number,
  release: number,
): void {
  for (const s of attachSpans(doc, propId, HOLD_PREFIX)) {
    if (!overlaps(s, grab, release)) continue;
    const same = s.constraint.target === actorId && s.constraint.subtarget === bone;
    if (same || s.grab >= grab) removeHold(doc, propId, s);
    else truncateHold(doc, propId, s, grab);
  }
}

/** World bounds of an object and its children's meshes (a store model's root holds its pieces). */
function subtreeBounds(doc: SceneDoc, fs: FrameState, rootId: string): { min: Vec3; max: Vec3 } | null {
  const kids = doc.childrenIndex();
  const stack = [rootId];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  while (stack.length) {
    const id = stack.pop()!;
    const o = doc.getObject(id);
    const mesh = o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    const b = mesh ? meshBounds(mesh) : null;
    const m = b ? fs.world(id) : null;
    if (b && m)
      for (let c = 0; c < 8; c++) {
        const p = transformPoint3(m, [
          c & 1 ? b.max[0] : b.min[0],
          c & 2 ? b.max[1] : b.min[1],
          c & 4 ? b.max[2] : b.min[2],
        ]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
    for (const c of kids.get(id) ?? []) stack.push(c);
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** An object's own transform without its scale (parent · location · rotation) as animated at `fs`. */
function ownRigid(fs: FrameState, id: string): Mat4 {
  const o = fs.get<ObjectData>('object', id);
  const local = o ? compose4(o.location, o.rotation_euler, [1, 1, 1]) : identity4();
  return multiply4(fs.parent(id), local);
}

/** Whether object `id` has own location or rotation keys strictly between frames a and b. */
function ownKeysBetween(doc: SceneDoc, id: string, a: number, b: number): boolean {
  for (const p of OWN)
    for (let i = 0; i < 3; i++)
      if (channelKeys(doc, id, p, i).some((k) => k.frame > a + FRAME_EPS && k.frame < b - FRAME_EPS))
        return true;
  return false;
}

/**
 * Keys prop `propId` around its holds so that every hold keeps the prop where it was put in the
 * hand (the hold's placement: the hand-relative transform it was given at the grab, its CHILD_OF
 * inverse times the prop's own transform). The prop's own location and rotation are keyed
 * (CONSTANT) where each hold starts taking it, and at each release where it is seen in the hand,
 * so it rests there until the next hold takes it; each hold's inverse is set against the rest it
 * takes the prop from. A glide into the hand never starts while another hand still holds the prop.
 * Called after every hold, and again for every prop an actor holds whenever the actor (or what it
 * rides) is moved, turned, posed or looks (index.ts), so releases follow the hands and a prop handed
 * on stays in the hand that takes it.
 */
export function rekeyHolds(doc: SceneDoc, propId: string): void {
  const usable = () =>
    attachSpans(doc, propId, HOLD_PREFIX).filter(
      (s) =>
        Number.isFinite(s.grab) &&
        !!s.constraint.subtarget &&
        Array.isArray((s.constraint.params as { inverse_matrix?: unknown }).inverse_matrix) &&
        (s.constraint.params as { inverse_matrix: unknown[] }).inverse_matrix.length === 16,
    );
  let spans = usable();
  if (!spans.length) return;
  // a glide into a hand starts when the hand before lets go
  const wr = new KeyWriter();
  let moved = false;
  for (let k = 1; k < spans.length; k++) {
    const p = spans[k - 1];
    const s = spans[k];
    if (!(p.release > s.start + FRAME_EPS && p.release <= s.grab + FRAME_EPS)) continue;
    const path = objectInfluence(s.constraint.name);
    wr.clear(propId, path, 0, s.start - 2 * FRAME_EPS, s.grab - 2 * FRAME_EPS);
    if (p.release < s.grab - FRAME_EPS) wr.key(propId, path, 0, p.release, 0);
    else wr.key(propId, path, 0, s.grab - 1, 0, 'CONSTANT');
    moved = true;
  }
  if (moved) {
    wr.commit(doc);
    spans = usable();
  }

  // every frame read, before anything is keyed (one reading of the document)
  const states = new Map<number, FrameState>();
  let first: FrameState | null = null;
  const at = (frame: number): FrameState => {
    let fs = states.get(frame);
    if (!fs) {
      fs = new FrameState(doc, frame, null, first ? { base: first } : {});
      first ??= fs;
      states.set(frame, fs);
    }
    return fs;
  };
  const ownFrame = (s: AttachSpan) => (s.start < s.grab - FRAME_EPS ? s.start : s.grab);
  const placements = spans.map((s) =>
    multiply4(
      (s.constraint.params as { inverse_matrix: number[] }).inverse_matrix as Mat4,
      ownRigid(at(s.grab), propId),
    ),
  );
  const hands = spans.map((s) =>
    Number.isFinite(s.release)
      ? (at(s.release - RELEASE_EPS).boneMatrix(s.constraint.target!, s.constraint.subtarget)?.matrix ?? null)
      : null,
  );
  for (const s of spans) {
    at(ownFrame(s)).parent(propId);
    if (Number.isFinite(s.release)) at(s.release).parent(propId);
  }

  const w = new KeyWriter();
  const list = [...(doc.getObject(propId)?.constraints ?? [])];
  let changed = false;
  let rest: { frame: number; matrix: Mat4 } | null = null;
  spans.forEach((s, j) => {
    const from = ownFrame(s);
    const fsFrom = at(from);
    // the rest it is taken from: where the hand before let it go, unless keyed since
    const ref =
      rest && rest.frame <= from + FRAME_EPS && !ownKeysBetween(doc, propId, rest.frame, from)
        ? rest.matrix
        : ownRigid(fsFrom, propId);
    const inverse = multiply4(placements[j], invert4(ref));
    const old = (s.constraint.params as { inverse_matrix: number[] }).inverse_matrix;
    if (inverse.some((v, i) => Math.abs(v - old[i]) > 1e-9)) {
      const i = list.findIndex((c) => c.id === s.constraint.id);
      if (i >= 0) {
        list[i] = { ...list[i], params: { ...list[i].params, inverse_matrix: Array.from(inverse) } };
        changed = true;
      }
    }
    // still while it is held (the constraint carries it)
    const oldRot = fsFrom.get<ObjectData>('object', propId)?.rotation_euler ?? [0, 0, 0];
    const local = channelsOf(multiply4(invert4(fsFrom.parent(propId)), ref), oldRot);
    const end = Number.isFinite(s.release) ? s.release : Infinity;
    for (const p of OWN) w.clear3(propId, p, from, end);
    w.key3(propId, 'location', from, local.location, 'CONSTANT');
    w.key3(propId, 'rotation_euler', from, local.rotation, 'CONSTANT');
    rest = null;
    const hand = hands[j];
    if (!Number.isFinite(s.release) || !hand) return;
    // let go where it is seen in the hand
    const seen = multiply4(hand, placements[j]);
    const out = channelsOf(multiply4(invert4(at(s.release).parent(propId)), seen), local.rotation);
    w.key3(propId, 'location', s.release, out.location, 'CONSTANT');
    w.key3(propId, 'rotation_euler', s.release, out.rotation, 'CONSTANT');
    rest = { frame: s.release, matrix: seen };
  });
  w.commit(doc);
  if (changed) doc.updateObject(propId, { constraints: list });
}

/** What a hold did: its constraint, the bone, how far the prop glides into the hand, and warnings. */
export interface HoldResult {
  constraint: string;
  bone: string;
  /** Distance (m) from where the prop was to the hand that takes it. */
  distance_m: number;
  /** How far the actor reaches without walking (m, from the shoulder or the root of the neck). */
  reach_m: number;
  warnings: string[];
}

/**
 * The actor takes `propId` at `frame`: a person's arm comes up into a carrying posture (HOLD_ARM)
 * and the prop glides over the HOLD_BLEND frames before into that hand (its middle against the
 * palm, keeping its orientation; animals take it in the mouth), then follows the hand until
 * release_frame, where it stays as it was seen and the arm goes down again. A prop handed on (let
 * go by another hand at the frame) goes straight from hand to hand. Holding a prop again with the
 * same hand replaces the hold; see settleHolds for other hands. Warns when the prop lies beyond the
 * actor's reach (walk the actor to it first).
 */
export function holdObject(
  doc: SceneDoc,
  actorId: string,
  propId: string,
  o: { hand?: 'right' | 'left'; frame: number; release_frame?: number },
): HoldResult {
  const meta = requireActor(doc, actorId);
  const human = isHumanoidKind(requireBuiltKind(meta.kind));
  const prop = requireObject(doc, propId, 'Prop');
  if (!Number.isFinite(o.frame)) throw new OperatorError('frame must be a number', 'INVALID_PARAMS');
  if (prop.id === meta.id || prop.custom_props?.[DESK_PROPS.actor] === meta.id)
    throw new OperatorError('An actor cannot hold itself or one of its parts', 'INVALID_PARAMS');
  if (doc.isAncestor(prop.id, meta.id))
    throw new OperatorError(`'${prop.name}' is a parent of the actor and cannot be held`, 'INVALID_PARAMS');
  if (o.release_frame !== undefined && !(o.release_frame > o.frame))
    throw new OperatorError('release_frame must be after frame', 'INVALID_PARAMS');
  const side = o.hand === 'left' ? 'L' : 'R';
  const bone = human ? `hand.${side}` : 'head';
  const grab = o.frame;
  const release = o.release_frame ?? Infinity;

  settleHolds(doc, prop.id, meta.id, bone, grab, release);
  // the glide starts HOLD_BLEND frames before the grab, or when another hand lets go of it
  let start = grab - HOLD_BLEND;
  for (const s of attachSpans(doc, prop.id, HOLD_PREFIX))
    if (s.release <= grab + FRAME_EPS && s.release > start) start = s.release;

  const c = createConstraint('CHILD_OF', {
    name: uniqueName(
      `${HOLD_PREFIX}${meta.name}`,
      (doc.getObject(prop.id)?.constraints ?? []).map((x) => x.name),
    ),
    target: meta.id,
    subtarget: bone,
    influence: 0,
    show_expanded: false,
    params: { set_inverse_pending: false },
  });
  if (human) {
    const wa = new KeyWriter();
    holdArm(doc, meta, side, prop.name, c.id, grab, release, wa);
    wa.commit(doc);
  }

  // where the prop is as it is taken, and the hand at the grab
  const before = new FrameState(doc, grab - RELEASE_EPS);
  const fs = new FrameState(doc, grab, null, { base: before });
  const hand = boneWorld(fs, meta.id, bone);
  const seen = before.world(prop.id) ?? multiply4(before.parent(prop.id), before.local(prop.id));
  // the grip: on the palm side of the hand's middle (the palm of a hanging or carrying hand faces
  // the body: +X, the character's left, for the right hand) or between an animal's jaws
  const sign = side === 'L' ? -1 : 1;
  const grip = transformPoint3(
    hand.matrix,
    human ? [sign * 0.012 * meta.height, 0.55 * hand.length, 0] : [0, 0.85 * hand.length, 0.03 * meta.height],
  );
  const palm = transformDirection3(hand.matrix, human ? [sign, 0, 0] : [0, 0, 1]);
  // in the hand: the prop's orientation as it lies, its middle at the grip (scale left out: the
  // prop's own scale applies on top, as its channels have it)
  const desired = normalizedAxes(seen);
  const box = subtreeBounds(doc, before, prop.id);
  const centre: Vec3 = box
    ? (box.min.map((v, k) => (v + box.max[k]) / 2) as Vec3)
    : [seen[12], seen[13], seen[14]];
  if (box) {
    const half = [0, 1, 2].reduce((a, k) => a + Math.abs(palm[k]) * (box.max[k] - box.min[k]) * 0.5, 0);
    const push = human ? Math.max(0, half - 0.004 * meta.height) : 0;
    for (let k = 0; k < 3; k++) desired[12 + k] += grip[k] + palm[k] * push - centre[k];
  } else for (let k = 0; k < 3; k++) desired[12 + k] = grip[k];
  // CHILD_OF: result = hand · inverse · own; the placement (hand-relative) is hand⁻¹ · desired
  const placement = multiply4(invert4(hand.matrix), desired);
  c.params = {
    ...c.params,
    inverse_matrix: Array.from(multiply4(placement, invert4(ownRigid(fs, prop.id)))),
  };
  doc.updateObject(prop.id, { constraints: [...(doc.getObject(prop.id)?.constraints ?? []), c] });

  const w = new KeyWriter();
  const ip = objectInfluence(c.name);
  if (start < grab - FRAME_EPS) w.key(prop.id, ip, 0, start, 0);
  else w.key(prop.id, ip, 0, grab - 1, 0, 'CONSTANT');
  w.key(prop.id, ip, 0, grab, 1, 'CONSTANT');
  if (Number.isFinite(release)) w.key(prop.id, ip, 0, release, 0, 'CONSTANT');
  w.commit(doc);
  rekeyHolds(doc, prop.id);

  // a rigid body starts its dynamics at its last release (MOTION's delayed bodies follow their
  // animated and constrained transform until their start_frame)
  const rb = doc.getObject(prop.id)?.rigid_body;
  const last = Math.max(...attachSpans(doc, prop.id, HOLD_PREFIX).map((s) => s.release));
  if (rb && Number.isFinite(last)) doc.updateObject(prop.id, { rigid_body: { ...rb, start_frame: last } });

  // how far it was: from the shoulder (a person bends and leans: the arm and a sixth of the height),
  // or from the root of an animal's neck (the neck and the head)
  const root = boneWorld(fs, meta.id, human ? `upper_arm.${side}` : 'neck');
  const reach = human
    ? ['upper_arm', 'forearm', 'hand'].reduce(
        (a, b) => a + boneWorld(fs, meta.id, `${b}.${side}`).length,
        0,
      ) +
      meta.height / 6
    : boneWorld(fs, meta.id, 'neck').length + hand.length + 0.1 * meta.height;
  const r = root.matrix;
  const across = Math.hypot(centre[0] - r[12], centre[1] - r[13]);
  const above = centre[2] - r[14];
  const distance = Math.hypot(centre[0] - grip[0], centre[1] - grip[1], centre[2] - grip[2]);
  const warnings: string[] = [];
  if (across > 0.8 * reach || above > reach)
    warnings.push(
      `'${prop.name}' is ${distance.toFixed(2)} m from ${meta.name}'s ${human ? 'hand' : 'mouth'} at frame ` +
        `${grab} (beyond its reach of about ${reach.toFixed(2)} m): it glides into the ` +
        `${human ? 'hand' : 'mouth'} over the ${HOLD_BLEND} frames before; walk ${meta.name} to it first ` +
        '(desk.actor_move) for the hold to look like a reach',
    );
  return { constraint: c.name, bone, distance_m: distance, reach_m: reach, warnings };
}

/** The objects `actorId` holds (a 'Hold …' CHILD_OF on the actor). */
function heldBy(doc: SceneDoc, actorId: string): string[] {
  const out: string[] = [];
  for (const [id, y] of doc.map('objects').entries()) {
    const list = (y as { get(key: string): unknown }).get('constraints');
    if (id === actorId || !Array.isArray(list)) continue;
    if (
      (list as ConstraintData[]).some(
        (c) => c.type === 'CHILD_OF' && c.target === actorId && c.name?.startsWith(HOLD_PREFIX),
      )
    )
      out.push(id);
  }
  return out;
}

/**
 * Keys again where the objects `actorId` holds are let go, from its bones as animated now (and the
 * holds of the same objects by other hands: rekeyHolds): a move, turn, pose or look keyed after a
 * hold would otherwise leave a released prop where the hand was before. Called after each move,
 * turn, pose, look, hold and ride (index.ts).
 */
export function refreshReleases(doc: SceneDoc, actorId: string): void {
  for (const id of heldBy(doc, actorId)) rekeyHolds(doc, id);
}

// ---------------------------------------------------------------- ride

/** Half the width of a mount's barrel at the saddle (its spine part's mesh, in the bone's frame). */
function mountGirth(doc: SceneDoc, mount: ActorMeta): number {
  const id = actorParts(doc, mount.id).get('spine');
  const o = id ? doc.getObject(id) : null;
  const mesh = o?.data ? doc.getMesh(o.data) : null;
  const b = mesh ? meshBounds(mesh) : null;
  return b ? Math.max(Math.abs(b.min[0]), Math.abs(b.max[0])) : 0.2 * mount.height;
}

/** The point under a rider's pelvis that sits on the saddle's head (character space at rest). */
function riderSeat(arm: ArmatureData, height: number): Vec3 {
  const hips = arm.bones.find((b) => b.name === 'hips');
  return [0, 0.02 * height, (hips?.head[2] ?? 0.53 * height) - 0.075 * height];
}

/** A mount's barrel as a rider's legs go round it: half its width and height, and how far its axis is below the saddle's head. */
interface Barrel {
  halfWidth: number;
  halfHeight: number;
  drop: number;
}

function mountBarrel(doc: SceneDoc, mount: ActorMeta): Barrel {
  const b = blueprintFor(requireBuiltKind(mount.kind), mount.height).barrel;
  const saddle = doc.getArmature(mount.armature)?.bones.find((x) => x.name === 'saddle');
  if (!b || !saddle) {
    const g = mountGirth(doc, mount);
    return { halfWidth: g, halfHeight: g, drop: g };
  }
  return { halfWidth: b.halfWidth, halfHeight: b.halfHeight, drop: saddle.head[2] - b.z };
}

/**
 * The ride pose of a rider on a mount whose barrel is `barrel` (`k`: the mount's scale over the
 * rider's): the 'ride' pose's back and arms, and each leg solved (the gait's two-bone leg IK) so the
 * ankle hangs just outside the barrel's widest part under the hip, the knee turned out until it
 * clears the barrel and the foot level in the stirrup.
 */
function ridePose(doc: SceneDoc, rider: ActorMeta, barrel: Barrel, k: number): Record<string, PoseBone> {
  const kind = requireBuiltKind(rider.kind);
  if (!isHumanoidKind(kind))
    throw new OperatorError(`The rider must be a person (got a ${kind})`, 'INVALID_PARAMS');
  const bp = blueprintFor(kind, rider.height);
  const arm = doc.getArmature(rider.armature);
  if (!arm) throw new OperatorError(`Actor '${rider.name}' has no armature data`, 'FAILED');
  const h = rider.height;
  const { rot } = humanRotations(HUMAN_POSE_SPECS.ride, humanoidStoop(kind), h);
  // the barrel in the rider's character space: an ellipse across, its axis below the seat
  const seat = riderSeat(arm, h);
  const W = barrel.halfWidth * k;
  const R = barrel.halfHeight * k;
  const zc = seat[2] - barrel.drop * k;
  const halfWidthAt = (z: number) => {
    const t = (z - zc) / R;
    return Math.abs(t) >= 1 ? 0 : W * Math.sqrt(1 - t * t);
  };
  const pose = computePose(arm, poseBones(arm, rot, [0, 0, 0]), {
    frame: 0,
    armatureMatrix: identity4(),
    getWorldMatrix: () => null,
  });
  const limb = 0.04 * h;
  for (const leg of legRigs(arm, 'humanoid')) {
    const parent = pose.bones.get(leg.parent)?.matrix;
    if (!parent) continue;
    const frame = legFrame(leg, parent);
    // the ankle on the barrel's side (a limb's thickness off it), a little below its widest line,
    // or as low on it as a short leg (a child on a horse) reaches: never through the barrel
    const hip: Vec3 = [frame[12], frame[13], frame[14]];
    const reach = 0.97 * (leg.L1 + leg.L2);
    const onSide = (phi: number): Vec3 => [
      leg.side * (W + limb) * Math.sin(phi),
      seat[1] + 0.03 * h,
      zc + (R + limb) * Math.cos(phi),
    ];
    let phi = Math.acos(Math.max(-1, Math.min(1, (-0.2 * R) / (R + limb))));
    while (phi > 0.3 && Math.hypot(...sub3(onSide(phi), hip)) > reach) phi -= 2 * DEG;
    const ankle = onSide(phi);
    let sol: LegSolution | null = null;
    for (let out = 10; out <= 50; out += 5) {
      const a = out * DEG;
      const heading: Vec3 = [leg.side * Math.sin(a), -Math.cos(a), 0];
      const foot = normalize3([leg.side * Math.sin(a), -Math.cos(a), 0.08]);
      sol = solveLeg(leg, frame, ankle, foot, heading, null);
      const knee = transformPoint3(multiply4(frame, rotEuler(sol.upper)), [0, leg.L1, 0]);
      if (Math.abs(knee[0]) >= halfWidthAt(knee[2]) + limb) break;
    }
    if (!sol) continue;
    rot[leg.upper] = sol.upper;
    rot[leg.lower] = sol.lower;
    rot[leg.foot] = sol.foot;
    if (leg.toe) rot[leg.toe] = sol.toe;
  }
  return groundedPose(arm, bp.probes, rot, [0, 0, 0], 'none');
}

/** Drops a rider's pose keys at `frame` (the ride pose or the stand keyed there, and the frame before). */
function dropPoseKeys(w: KeyWriter, doc: SceneDoc, rider: ActorMeta, frame: number): void {
  if (!Number.isFinite(frame)) return;
  const arm = doc.getArmature(rider.armature);
  if (!arm) return;
  for (const { bone, channel } of poseChannelPaths(arm.bones.map((b) => b.name)))
    for (let i = 0; i < 3; i++)
      for (const f of [frame - 1, frame]) w.drop(rider.id, bonePath(bone, channel), i, f);
}

/**
 * Makes room for a ride of `rider` on `mountId` from `frame` to `dismount`: a rider sits on one
 * saddle at a time. A ride on the same mount that overlaps it is replaced (riding again with a
 * dismount frame fixes the ride), its seat and dismount keys dropped where the new ride keys none;
 * another ride that would start during it is dropped; another that still carries the rider at the
 * frame ends there (it moves from saddle to saddle).
 */
function settleRides(
  doc: SceneDoc,
  rider: ActorMeta,
  mountId: string,
  frame: number,
  dismount: number,
): void {
  for (const s of attachSpans(doc, rider.id, RIDE_PREFIX)) {
    if (!overlaps(s, frame, dismount)) continue;
    const w = new KeyWriter();
    if (s.constraint.target === mountId || s.grab >= frame) {
      removeConstraint(doc, rider.id, s.constraint);
      if (Math.abs(s.grab - frame) > FRAME_EPS) {
        dropOwn(w, rider.id, s.grab);
        dropPoseKeys(w, doc, rider, s.grab);
      }
    } else truncateInfluence(w, doc, rider.id, s, frame);
    if (Number.isFinite(s.release) && Math.abs(s.release - dismount) > FRAME_EPS) {
      dropOwn(w, rider.id, s.release);
      dropPoseKeys(w, doc, rider, s.release);
    }
    w.commit(doc);
  }
}

/**
 * Seats `riderId` on `mountId`'s saddle at `frame` in the ride pose (CHILD_OF on the saddle bone);
 * before it the rider is where it was (its transform and pose held to the frame before), and at
 * dismount_frame it stands on the ground at the mount's left. Riding the same mount again replaces
 * the ride (see settleRides). Returns the constraint's name.
 */
export function mountActor(
  doc: SceneDoc,
  riderId: string,
  mountId: string,
  o: { frame: number; dismount_frame?: number },
): { constraint: string } {
  const rider = requireActor(doc, riderId);
  const mount = requireActor(doc, mountId);
  if (rider.id === mount.id) throw new OperatorError('An actor cannot ride itself', 'INVALID_PARAMS');
  if (!Number.isFinite(o.frame)) throw new OperatorError('frame must be a number', 'INVALID_PARAMS');
  const mk = requireBuiltKind(mount.kind);
  if (!isHumanoidKind(requireBuiltKind(rider.kind)))
    throw new OperatorError(`The rider must be a person (got a ${rider.kind})`, 'INVALID_PARAMS');
  if (isHumanoidKind(mk) || !doc.getArmature(mount.armature)?.bones.some((b) => b.name === 'saddle'))
    throw new OperatorError(
      `'${mount.name}' (${mk}) has no saddle bone: riders mount horses, ponies, donkeys and cows`,
      'INVALID_PARAMS',
    );
  if (doc.isAncestor(rider.id, mount.id))
    throw new OperatorError(
      `'${rider.name}' is a parent of '${mount.name}' and cannot ride it`,
      'INVALID_PARAMS',
    );
  if (o.dismount_frame !== undefined && !(o.dismount_frame > o.frame))
    throw new OperatorError('dismount_frame must be after frame', 'INVALID_PARAMS');

  settleRides(doc, rider, mount.id, o.frame, o.dismount_frame ?? Infinity);
  const fs = new FrameState(doc, o.frame);
  // the rider as it is the frame before it mounts
  const prev = new FrameState(doc, o.frame - 1, null, { base: fs });
  const riderObj = doc.getObject(rider.id)!;
  const before = prev.get<ObjectData>('object', rider.id);
  const live = before?.pose?.bones ?? riderObj.pose.bones;
  const saddle = boneWorld(fs, mount.id, 'saddle');
  const girth = mountGirth(doc, mount);
  // the mount's size relative to the rider's (object scales)
  const mountScale = axisLengths(fs.world(mount.id) ?? identity4())[0];
  const riderScale = axisLengths(fs.world(rider.id) ?? identity4())[0];
  const k = mountScale > 1e-9 && riderScale > 1e-9 ? mountScale / riderScale : 1;
  // the seat (under the pelvis, character space) on the saddle's head, facing the mount's way
  const seat = riderSeat(doc.getArmature(rider.armature)!, rider.height);
  const yaw = yawOf(transformDirection3(saddle.matrix, [0, 1, 0]));
  const s = transformPoint3(compose4([0, 0, 0], [0, 0, yaw], riderObj.scale), seat);
  const worldR = compose4(
    [saddle.matrix[12] - s[0], saddle.matrix[13] - s[1], saddle.matrix[14] - s[2]],
    [0, 0, yaw],
    riderObj.scale,
  );
  const oldRot = before?.rotation_euler ?? riderObj.rotation_euler;
  const local = channelsOf(multiply4(invert4(fs.parent(rider.id)), worldR), oldRot);
  writeRidePose(doc, rider.id, live, ridePose(doc, rider, mountBarrel(doc, mount), k), o.frame);

  const list = [...(riderObj.constraints ?? [])];
  const name = uniqueName(
    `${RIDE_PREFIX}${mount.name}`,
    list.map((x) => x.name),
  );
  list.push(
    createConstraint('CHILD_OF', {
      name,
      target: mount.id,
      subtarget: 'saddle',
      influence: 0,
      show_expanded: false,
      params: { set_inverse_pending: false, inverse_matrix: Array.from(invert4(saddle.matrix)) },
    }),
  );
  doc.updateObject(rider.id, { constraints: list });

  const w = new KeyWriter();
  const ip = objectInfluence(name);
  w.key(rider.id, ip, 0, o.frame - 1, 0, 'CONSTANT');
  w.key(rider.id, ip, 0, o.frame, 1, 'CONSTANT');
  const end = o.dismount_frame ?? o.frame;
  // until it mounts the rider stays where it was: its transform keyed the frame before when the
  // keys there would carry it towards the seat (a BEZIER key of a walk, or none at all)
  if (before)
    for (const [p, v] of [
      ['location', before.location],
      ['rotation_euler', before.rotation_euler],
    ] as const)
      for (let i = 0; i < 3; i++) {
        const last = channelKeys(doc, rider.id, p, i)
          .filter((key) => key.frame <= o.frame - 1 + FRAME_EPS)
          .pop();
        if (!last || last.interpolation !== 'CONSTANT') w.key(rider.id, p, i, o.frame - 1, v[i], 'CONSTANT');
      }
  for (const p of OWN) w.clear3(rider.id, p, o.frame - 1, end);
  w.key3(rider.id, 'location', o.frame, local.location, 'CONSTANT');
  w.key3(rider.id, 'rotation_euler', o.frame, local.rotation, 'CONSTANT');
  if (o.dismount_frame !== undefined) {
    w.key(rider.id, ip, 0, o.dismount_frame, 0, 'CONSTANT');
    keyDismount(doc, w, rider, mount.id, girth, o.dismount_frame, local.rotation);
  }
  w.commit(doc);
  if (o.dismount_frame !== undefined)
    keyPose(doc, rider.id, 'stand', { frame: o.dismount_frame, blend_frames: 0 });
  return { constraint: name };
}

/**
 * Keys `rider` standing on the ground at the left of `mountId`'s saddle (Rz(yaw) of +X, the
 * character's left) at `frame`, facing the mount's way, as the mount is animated now.
 */
function keyDismount(
  doc: SceneDoc,
  w: KeyWriter,
  rider: ActorMeta,
  mountId: string,
  girth: number,
  frame: number,
  oldRot: Readonly<Vec3>,
): void {
  const fd = new FrameState(doc, frame);
  const sd = boneWorld(fd, mountId, 'saddle');
  const yaw = yawOf(transformDirection3(sd.matrix, [0, 1, 0]));
  const off = girth + 0.25 * rider.height;
  const ground = fd.world(mountId)?.[14] ?? 0;
  const pos: Vec3 = [sd.matrix[12] + Math.cos(yaw) * off, sd.matrix[13] + Math.sin(yaw) * off, ground];
  const world = compose4(pos, [0, 0, yaw], doc.getObject(rider.id)?.scale ?? [1, 1, 1]);
  const t = channelsOf(multiply4(invert4(fd.parent(rider.id)), world), oldRot);
  w.key3(rider.id, 'location', frame, t.location, 'CONSTANT');
  w.key3(rider.id, 'rotation_euler', frame, t.rotation, 'CONSTANT');
}

/**
 * Keys again where the riders of `mountId` get down, from its saddle as animated now: a mount
 * moved, turned or posed after a rider mounted it would otherwise leave the rider to step down
 * where the mount was before. Every 1→0 step of the influence of a ride (CHILD_OF on the mount's
 * saddle) is a dismount. Called after each move, turn and pose (index.ts).
 */
export function refreshDismounts(doc: SceneDoc, mountId: string): void {
  const w = new KeyWriter();
  let girth: number | null = null;
  for (const [id, y] of doc.map('objects').entries()) {
    const list = (y as { get(key: string): unknown }).get('constraints');
    if (id === mountId || !Array.isArray(list)) continue;
    for (const c of list as ConstraintData[]) {
      if (c.type !== 'CHILD_OF' || c.target !== mountId || c.subtarget !== 'saddle') continue;
      const keys = influenceKeys(doc, id, c.name);
      for (let i = 1; i < keys.length; i++) {
        if (!(keys[i - 1].value >= 0.5 && keys[i].value < 0.5)) continue;
        const rider = actorOrNull(doc, id);
        if (!rider) break;
        girth ??= mountGirth(doc, requireActor(doc, mountId));
        const old = new FrameState(doc, keys[i].frame).get<ObjectData>('object', id);
        keyDismount(doc, w, rider, mountId, girth, keys[i].frame, old?.rotation_euler ?? [0, 0, 0]);
      }
    }
  }
  w.commit(doc);
}

const actorOrNull = (doc: SceneDoc, id: string): ActorMeta | null => {
  try {
    return requireActor(doc, id);
  } catch {
    return null;
  }
};

/** Keys the ride pose at `frame`: a jump into the saddle (CONSTANT from the frame before). */
function writeRidePose(
  doc: SceneDoc,
  id: string,
  live: Record<string, PoseBone>,
  target: Record<string, PoseBone>,
  frame: number,
): void {
  const w = new KeyWriter();
  for (const [bone, pb] of Object.entries(target)) {
    if (bone === 'root') continue;
    for (const ch of bone === 'hips'
      ? (['rotation_euler', 'location'] as const)
      : (['rotation_euler'] as const)) {
      const p = bonePath(bone, ch);
      const before = (live[bone]?.[ch] ?? [0, 0, 0]) as Vec3;
      const after = pb[ch] as Vec3;
      for (let i = 0; i < 3; i++) {
        w.clear(id, p, i, frame - 1, frame);
        w.key(id, p, i, frame - 1, before[i], 'CONSTANT');
        w.key(id, p, i, frame, after[i]);
      }
    }
  }
  w.commit(doc);
}
