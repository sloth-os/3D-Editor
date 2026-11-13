import type { Mat4, Vec3 } from '../../math/types';
import { compose4, invert4, multiply4 } from '../../math/mat4';
import { transformDirection3, transformPoint3 } from '../../math/vec3';
import type { ConstraintData, ObjectData, PoseBone } from '../../doc/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import { createConstraint } from '../../constraints/catalogue';
import { axisLengths, matrixToCompatibleEuler } from '../../constraints/math';
import { FrameState } from '../../eval/frame-state';
import { meshBounds } from '../../mesh/types';
import { OperatorError } from '../../operators/context';
import { uniqueName } from '../../util/names';
import { DESK_PROPS } from '../props';
import { keyPose } from './actor';
import { blueprintFor, isHumanoidKind, requireBuiltKind } from './kinds';
import { KeyWriter, bonePath } from './keys';
import { humanoidStoop } from './mannequin';
import { HUMAN_POSE_SPECS, groundedPose, humanRotations } from './poses';
import { DEG, actorParts, requireActor, type ActorMeta } from './rig';
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

/**
 * The actor takes `propId` at `frame`: the prop moves into the hand (its middle against the palm,
 * keeping its orientation; animals take it in the mouth) and follows the hand until release_frame,
 * where it stays as it was seen. Returns the CHILD_OF constraint's name and the bone.
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
  const bone = human ? (o.hand === 'left' ? 'hand.L' : 'hand.R') : 'head';
  const fs = new FrameState(doc, o.frame);
  const hand = boneWorld(fs, meta.id, bone);
  const own = multiply4(fs.parent(prop.id), fs.local(prop.id));
  const seen = fs.world(prop.id) ?? own;
  // the grip: on the palm side of the hand's middle (the palm of a hanging hand faces the body:
  // +X, the character's left, for the right hand) or between an animal's jaws
  const side = o.hand === 'left' ? -1 : 1;
  const grip = transformPoint3(
    hand.matrix,
    human ? [side * 0.012 * meta.height, 0.55 * hand.length, 0] : [0, 0.85 * hand.length, 0.03 * meta.height],
  );
  const palm = transformDirection3(hand.matrix, human ? [side, 0, 0] : [0, 0, 1]);
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
    `Hold ${meta.name}`,
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
  if (o.release_frame !== undefined) {
    w.key(prop.id, ip, 0, o.release_frame, 0, 'CONSTANT');
    // released where it is seen at that frame
    const fr = new FrameState(doc, o.release_frame);
    const handR = boneWorld(fr, meta.id, bone);
    const parentR = fr.parent(prop.id);
    const ownR = multiply4(parentR, compose4(local.location, local.rotation, local.scale));
    const visual = multiply4(multiply4(handR.matrix, inverse), ownR);
    keyChannels(w, prop.id, o.release_frame, channelsOf(multiply4(invert4(parentR), visual), local.rotation));
  }
  w.commit(doc);
  // a rigid body starts its dynamics at the release (MOTION's delayed bodies follow their
  // animated and constrained transform until their start_frame)
  if (o.release_frame !== undefined && prop.rigid_body)
    doc.updateObject(prop.id, { rigid_body: { ...prop.rigid_body, start_frame: o.release_frame } });
  return { constraint: name, bone };
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

/**
 * The ride pose of a rider whose mount's barrel is `girth` wide (half): the 'ride' pose with each
 * thigh swung out first (so the knees clear the barrel), then forward.
 */
function ridePose(doc: SceneDoc, rider: ActorMeta, girth: number): Record<string, PoseBone> {
  const kind = requireBuiltKind(rider.kind);
  if (!isHumanoidKind(kind))
    throw new OperatorError(`The rider must be a person (got a ${kind})`, 'INVALID_PARAMS');
  const bp = blueprintFor(kind, rider.height);
  const arm = doc.getArmature(rider.armature);
  if (!arm) throw new OperatorError(`Actor '${rider.name}' has no armature data`, 'FAILED');
  const thigh = arm.bones.find((b) => b.name === 'thigh.L');
  const hipX = thigh ? Math.abs(thigh.head[0]) : 0.09 * rider.height;
  const len = thigh
    ? Math.hypot(thigh.tail[0] - thigh.head[0], thigh.tail[1] - thigh.head[1], thigh.tail[2] - thigh.head[2])
    : 0.25 * rider.height;
  const spread = Math.asin(Math.max(0.12, Math.min(0.92, (girth + 0.04 * rider.height - hipX) / len)));
  const spec = HUMAN_POSE_SPECS.ride;
  const { rot } = humanRotations(spec, humanoidStoop(kind), rider.height);
  for (const s of ['L', 'R'] as const) {
    const out = s === 'L' ? -1 : 1;
    const hip = (spec.hip?.[0] ?? 60) * DEG;
    // R = Rx(−hip) · Rz(out · spread): swing out about the back axis, then forward
    const m = multiply4(
      compose4([0, 0, 0], [-hip, 0, 0], [1, 1, 1]),
      compose4([0, 0, 0], [0, 0, out * spread], [1, 1, 1]),
    );
    rot[`thigh.${s}`] = matrixToCompatibleEuler(m, [-hip, 0, 0]);
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
      `'${mount.name}' (${mk}) has no saddle bone: riders mount horses and ponies`,
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
  writeRidePose(doc, rider.id, live, ridePose(doc, rider, girth), o.frame);

  // the seat (under the pelvis, character space) on the saddle's head, facing the mount's way
  const hips = doc.getArmature(rider.armature)!.bones.find((b) => b.name === 'hips');
  const seat: Vec3 = [0, 0.02 * rider.height, (hips?.head[2] ?? 0.53 * rider.height) - 0.075 * rider.height];
  const yaw = yawOf(transformDirection3(saddle.matrix, [0, 1, 0]));
  const s = transformPoint3(compose4([0, 0, 0], [0, 0, yaw], [1, 1, 1]), seat);
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
