import type { Mat4, Vec3 } from '../../math/types';
import { compose4, identity4, invert4, multiply4 } from '../../math/mat4';
import { normalize3, sub3, transformDirection3, transformPoint3 } from '../../math/vec3';
import type { ArmatureData, ConstraintData, ObjectData, PoseBone } from '../../doc/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import { computePose } from '../../armature/pose';
import { createConstraint } from '../../constraints/catalogue';
import { axisLengths, matrixToCompatibleEuler } from '../../constraints/math';
import { FrameState } from '../../eval/frame-state';
import { meshBounds } from '../../mesh/types';
import { OperatorError } from '../../operators/context';
import { uniqueName } from '../../util/names';
import { DESK_PROPS } from '../props';
import { keyPose } from './actor';
import { legFrame, legRigs, solveLeg, type LegSolution } from './gait';
import { blueprintFor, isHumanoidKind, requireBuiltKind } from './kinds';
import { KeyWriter, bonePath } from './keys';
import { humanoidStoop } from './mannequin';
import { HUMAN_POSE_SPECS, groundedPose, humanRotations, poseBones, type HumanPoseSpec } from './poses';
import { DEG, actorParts, requireActor, rotEuler, type ActorMeta } from './rig';
import { yawOf } from './locomotion';

/*
 * What actors do with other objects (spec §8): look at them (DAMPED_TRACK bone constraints on the
 * neck and head, their influence keyed), hold them (a CHILD_OF on the prop with the hand bone as
 * subtarget) and ride a mount (a CHILD_OF on the rider with the mount's `saddle` bone). A CHILD_OF's
 * influence is keyed 0 → 1 at the grab with its inverse set there, so the held object takes the
 * place it is given at that frame and then follows the bone; at the release the influence goes
 * back to 0 and the object's own transform is keyed where it was seen (its visual transform), so
 * it stays there (or, with a rigid body, falls from there: its start_frame).
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

// ---------------------------------------------------------------- hold

/** World matrix and length of a posed bone's head frame at a frame state. */
function boneWorld(fs: FrameState, actorId: string, bone: string): { matrix: Mat4; length: number } {
  const b = fs.boneMatrix(actorId, bone);
  if (!b) throw new OperatorError(`Bone '${bone}' of the actor cannot be evaluated`, 'FAILED');
  return b;
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

interface Channels {
  location: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

const channelsOf = (m: Readonly<Mat4>, oldRot: Readonly<Vec3>): Channels => ({
  location: [m[12], m[13], m[14]],
  rotation: matrixToCompatibleEuler(m, oldRot),
  scale: axisLengths(m),
});

/** Keys an object's transform channels at a frame (CONSTANT: they hold until the next key). */
function keyChannels(w: KeyWriter, id: string, frame: number, t: Channels, scale = true) {
  w.key3(id, 'location', frame, t.location, 'CONSTANT');
  w.key3(id, 'rotation_euler', frame, t.rotation, 'CONSTANT');
  if (scale) w.key3(id, 'scale', frame, t.scale, 'CONSTANT');
}

const HOLD_PREFIX = 'Hold ';

/**
 * The carrying posture of a holding arm (joint angles as poses.ts writes them): the upper arm a
 * little forward and out, the forearm forward at the waist and turned slightly in, so what the hand
 * holds is carried in front of the body (where rideo draws a held prop) instead of against the leg.
 * LIMIT_ROTATION constraints on the upper arm and forearm (min = max, the bone's local rotation)
 * force it over whatever the arm is keyed to do, their influence keyed with the hold.
 */
const HOLD_ARM: HumanPoseSpec = { arm: [16, 16], armOut: [10, 10], armTwist: [20, 20], elbow: [80, 80] };

/** Frames the arm takes to come up into the carrying posture before the grab and to go down after the release. */
export const HOLD_BLEND = 6;

/** Offset (frames) before a release at which the held transform is read. */
const RELEASE_EPS = 1e-3;

/**
 * Adds the carrying posture's constraints to one arm of a humanoid actor (named `Hold <prop>`),
 * their influence keyed in `w`: up over HOLD_BLEND frames before `frame`, down after `release`.
 */
function holdArm(
  doc: SceneDoc,
  meta: ActorMeta,
  side: 'L' | 'R',
  propName: string,
  frame: number,
  release: number | undefined,
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
    w.clear(meta.id, path, 0, frame - HOLD_BLEND - 1, (release ?? frame) + HOLD_BLEND);
    w.key(meta.id, path, 0, frame - HOLD_BLEND, 0);
    w.key(meta.id, path, 0, frame, 1);
    if (release !== undefined) {
      w.key(meta.id, path, 0, release, 1);
      w.key(meta.id, path, 0, release + HOLD_BLEND, 0);
    }
  }
  doc.updateObject(meta.id, { pose: { ...obj.pose, bones } });
}

/**
 * Keys a held object's own transform at `frame`, its release, where it is seen then: the CHILD_OF
 * result (bone · inverse · its world transform as held) as its new local transform, so it stays
 * there (or falls from there) once the constraint lets go.
 */
function keyRelease(
  w: KeyWriter,
  doc: SceneDoc,
  propId: string,
  actorId: string,
  bone: string,
  inverse: Readonly<Mat4>,
  frame: number,
): void {
  const held = new FrameState(doc, frame - RELEASE_EPS);
  const fr = new FrameState(doc, frame);
  const b = fr.boneMatrix(actorId, bone);
  if (!b) return;
  const parent = fr.parent(propId);
  const visual = multiply4(multiply4(b.matrix, inverse as Mat4), multiply4(parent, held.local(propId)));
  const old = held.get<ObjectData>('object', propId)?.rotation_euler ?? [0, 0, 0];
  keyChannels(w, propId, frame, channelsOf(multiply4(invert4(parent), visual), old));
}

/**
 * The actor takes `propId` at `frame`: a person's arm comes up into a carrying posture (HOLD_ARM)
 * and the prop moves into that hand (its middle against the palm, keeping its orientation; animals
 * take it in the mouth), then follows the hand until release_frame, where it stays as it was seen
 * and the arm goes down again. Returns the CHILD_OF constraint's name and the bone.
 */
export function holdObject(
  doc: SceneDoc,
  actorId: string,
  propId: string,
  o: { hand?: 'right' | 'left'; frame: number; release_frame?: number },
): { constraint: string; bone: string } {
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
  if (human) {
    const wa = new KeyWriter();
    holdArm(doc, meta, side, prop.name, o.frame, o.release_frame, wa);
    wa.commit(doc);
  }
  const fs = new FrameState(doc, o.frame);
  const hand = boneWorld(fs, meta.id, bone);
  const own = multiply4(fs.parent(prop.id), fs.local(prop.id));
  const seen = fs.world(prop.id) ?? own;
  // the grip: on the palm side of the hand's middle (the palm of a hanging or carrying hand faces
  // the body: +X, the character's left, for the right hand) or between an animal's jaws
  const sign = side === 'L' ? -1 : 1;
  const grip = transformPoint3(
    hand.matrix,
    human ? [sign * 0.012 * meta.height, 0.55 * hand.length, 0] : [0, 0.85 * hand.length, 0.03 * meta.height],
  );
  const palm = transformDirection3(hand.matrix, human ? [sign, 0, 0] : [0, 0, 1]);
  const desired = seen.slice() as Mat4;
  const box = subtreeBounds(doc, fs, prop.id);
  if (box) {
    const c = box.min.map((v, k) => (v + box.max[k]) / 2);
    const half = [0, 1, 2].reduce((a, k) => a + Math.abs(palm[k]) * (box.max[k] - box.min[k]) * 0.5, 0);
    const push = human ? Math.max(0, half - 0.004 * meta.height) : 0;
    for (let k = 0; k < 3; k++) desired[12 + k] += grip[k] + palm[k] * push - c[k];
  } else for (let k = 0; k < 3; k++) desired[12 + k] = grip[k];
  // CHILD_OF: result = hand · inverse · own; at the grab it is `desired`
  const inverse = multiply4(multiply4(invert4(hand.matrix), desired), invert4(own));
  const list = [...(prop.constraints ?? [])];
  const name = uniqueName(
    `${HOLD_PREFIX}${meta.name}`,
    list.map((x) => x.name),
  );
  list.push(
    createConstraint('CHILD_OF', {
      name,
      target: meta.id,
      subtarget: bone,
      influence: 0,
      show_expanded: false,
      params: { set_inverse_pending: false, inverse_matrix: Array.from(inverse) },
    }),
  );
  doc.updateObject(prop.id, { constraints: list });

  const w = new KeyWriter();
  const ip = objectInfluence(name);
  w.key(prop.id, ip, 0, o.frame - 1, 0, 'CONSTANT');
  w.key(prop.id, ip, 0, o.frame, 1, 'CONSTANT');
  // the prop's own transform holds still while it is held (the constraint carries it)
  const local = channelsOf(fs.local(prop.id), prop.rotation_euler);
  const end = o.release_frame ?? o.frame;
  for (const p of ['location', 'rotation_euler', 'scale']) w.clear3(prop.id, p, o.frame - 1, end);
  keyChannels(w, prop.id, o.frame, local);
  if (o.release_frame !== undefined) w.key(prop.id, ip, 0, o.release_frame, 0, 'CONSTANT');
  w.commit(doc);
  if (o.release_frame !== undefined) {
    // released where it is seen at that frame
    const wr = new KeyWriter();
    keyRelease(wr, doc, prop.id, meta.id, bone, inverse, o.release_frame);
    wr.commit(doc);
  }
  // a rigid body starts its dynamics at the release (MOTION's delayed bodies follow their
  // animated and constrained transform until their start_frame)
  if (o.release_frame !== undefined && prop.rigid_body)
    doc.updateObject(prop.id, { rigid_body: { ...prop.rigid_body, start_frame: o.release_frame } });
  return { constraint: name, bone };
}

/**
 * Keys again where the objects `actorId` holds are let go, from its bones as animated now: a move,
 * turn, pose or look keyed after a hold would otherwise leave a released prop where the hand was
 * before. Every 1 → 0 step of the influence of a hold (a CHILD_OF on the actor named 'Hold …') is a
 * release. Called after each move, turn, pose, look and ride (index.ts).
 */
export function refreshReleases(doc: SceneDoc, actorId: string): void {
  const w = new KeyWriter();
  for (const [id, y] of doc.map('objects').entries()) {
    const list = (y as { get(key: string): unknown }).get('constraints');
    if (id === actorId || !Array.isArray(list)) continue;
    for (const c of list as ConstraintData[]) {
      if (c.type !== 'CHILD_OF' || c.target !== actorId || !c.subtarget || !c.name.startsWith(HOLD_PREFIX))
        continue;
      const inverse = (c.params as { inverse_matrix?: unknown }).inverse_matrix;
      if (!Array.isArray(inverse) || inverse.length !== 16) continue;
      const fc = doc.getFCurve(
        fcurveKey({ target_type: 'object', target_id: id, path: objectInfluence(c.name), index: 0 }),
      );
      const keys = [...(fc?.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
      for (let i = 1; i < keys.length; i++)
        if (keys[i - 1].value >= 0.5 && keys[i].value < 0.5)
          keyRelease(w, doc, id, actorId, c.subtarget, inverse as Mat4, keys[i].frame);
    }
  }
  w.commit(doc);
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

/**
 * Seats `riderId` on `mountId`'s saddle at `frame` in the ride pose (CHILD_OF on the saddle bone);
 * at dismount_frame the rider stands on the ground at the mount's left. Returns the constraint's name.
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

  const fs = new FrameState(doc, o.frame);
  const saddle = boneWorld(fs, mount.id, 'saddle');
  const girth = mountGirth(doc, mount);
  const riderObj = doc.getObject(rider.id)!;
  const live = fs.get<ObjectData>('object', rider.id)?.pose?.bones ?? riderObj.pose.bones;
  // the mount's size relative to the rider's (object scales)
  const mountScale = axisLengths(fs.world(mount.id) ?? identity4())[0];
  const riderScale = axisLengths(fs.world(rider.id) ?? identity4())[0];
  const k = mountScale > 1e-9 && riderScale > 1e-9 ? mountScale / riderScale : 1;
  writeRidePose(doc, rider.id, live, ridePose(doc, rider, mountBarrel(doc, mount), k), o.frame);

  // the seat (under the pelvis, character space) on the saddle's head, facing the mount's way
  const seat = riderSeat(doc.getArmature(rider.armature)!, rider.height);
  const yaw = yawOf(transformDirection3(saddle.matrix, [0, 1, 0]));
  const s = transformPoint3(compose4([0, 0, 0], [0, 0, yaw], riderObj.scale), seat);
  const worldR = compose4(
    [saddle.matrix[12] - s[0], saddle.matrix[13] - s[1], saddle.matrix[14] - s[2]],
    [0, 0, yaw],
    riderObj.scale,
  );
  const local = channelsOf(multiply4(invert4(fs.parent(rider.id)), worldR), riderObj.rotation_euler);

  const list = [...(riderObj.constraints ?? [])];
  const name = uniqueName(
    `Ride ${mount.name}`,
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
  for (const p of ['location', 'rotation_euler']) w.clear3(rider.id, p, o.frame - 1, end);
  keyChannels(w, rider.id, o.frame, local, false);
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
  keyChannels(w, rider.id, frame, channelsOf(multiply4(invert4(fd.parent(rider.id)), world), oldRot), false);
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
      const fc = doc.getFCurve(
        fcurveKey({ target_type: 'object', target_id: id, path: objectInfluence(c.name), index: 0 }),
      );
      const keys = [...(fc?.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
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
