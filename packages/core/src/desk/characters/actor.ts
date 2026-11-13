import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { PoseBone } from '../../doc/types';
import { compatibleEuler } from '../../constraints/math';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';
import { blueprintFor, defaultHeight, posedBones, requireBuiltKind, requirePose } from './kinds';
import { KeyWriter, animatedPose, bonePath, nextKey } from './keys';
import {
  DEG,
  MAT_ACCENT,
  MAT_BODY,
  MAT_DARK,
  MAT_LIGHT,
  boneData,
  buildPartMesh,
  hexToLinear,
  requireActor,
  restMatrices,
  shadeLinear,
} from './rig';
import { ACTOR_PALETTE, type ActorKind, type CreateActorOptions } from './types';

/*
 * Building actors (createActor) and keying their poses (applyPose).
 */

/** Heights an actor may have (m): from a small bird to a large horse. */
export const MIN_ACTOR_HEIGHT = 0.05;
export const MAX_ACTOR_HEIGHT = 8;

const HEX = /^#[0-9a-f]{6}$/i;

/** The next cast colour: the first palette colour no actor uses yet, else by count (rideo's cast order). */
export function nextActorColor(doc: SceneDoc): string {
  const used = new Set<string>();
  let actors = 0;
  for (const id of doc.objectIds()) {
    const o = doc.getObject(id);
    if (o?.type !== 'ARMATURE' || o.custom_props?.[DESK_PROPS.role] !== 'actor') continue;
    actors++;
    used.add(String(o.custom_props[DESK_PROPS.color] ?? '').toLowerCase());
  }
  return ACTOR_PALETTE.find((c) => !used.has(c)) ?? ACTOR_PALETTE[actors % ACTOR_PALETTE.length];
}

const title = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');

/** Builds an actor: an armature with the kind's bones, a mesh part per bone, posed (unkeyed). */
export function buildActor(
  doc: SceneDoc,
  o: CreateActorOptions,
): { actor: string; parts: string[]; name: string } {
  const kind = requireBuiltKind(o.kind);
  const height = o.height_m ?? defaultHeight(kind);
  if (!(height >= MIN_ACTOR_HEIGHT && height <= MAX_ACTOR_HEIGHT))
    throw new OperatorError(
      `height_m must be between ${MIN_ACTOR_HEIGHT} and ${MAX_ACTOR_HEIGHT} m (got ${o.height_m})`,
      'INVALID_PARAMS',
    );
  if (o.color !== undefined && !HEX.test(o.color))
    throw new OperatorError(`color must be '#rrggbb' (got '${o.color}')`, 'INVALID_PARAMS');
  const pose = requirePose(kind, o.pose ?? 'stand');
  const loc: Vec3 = o.location ? [o.location[0], o.location[1], o.location[2]] : [0, 0, 0];
  if (!loc.every(Number.isFinite)) throw new OperatorError('location must be finite', 'INVALID_PARAMS');
  const facing = o.facing_deg ?? 0;
  if (!Number.isFinite(facing)) throw new OperatorError('facing_deg must be finite', 'INVALID_PARAMS');
  const color = (o.color ?? nextActorColor(doc)).toLowerCase();
  const name = o.name?.trim() || title(kind);

  const bp = blueprintFor(kind, height);
  const bones = boneData(bp.bones);
  const rest = restMatrices(bones);
  const armId = doc.addArmature({ name, bones, display_type: 'STICK' });
  const arm = doc.getArmature(armId)!;
  const base = hexToLinear(color);
  const mats = [
    doc.addMaterial({ name: `${name} Body`, base_color: base, roughness: 0.55 }),
    doc.addMaterial({ name: `${name} Joints`, base_color: shadeLinear(base, 0.32), roughness: 0.5 }),
    doc.addMaterial({ name: `${name} Face`, base_color: [0.88, 0.88, 0.84, 1], roughness: 0.35 }),
  ];
  if (bp.accent)
    mats.push(doc.addMaterial({ name: `${name} Saddle`, base_color: [0.16, 0.07, 0.03, 1], roughness: 0.6 }));
  const props: Record<string, string | number | boolean> = {
    [DESK_PROPS.role]: 'actor',
    [DESK_PROPS.kind]: kind,
    [DESK_PROPS.heightM]: height,
    [DESK_PROPS.color]: color,
  };
  if (o.character_id) props[DESK_PROPS.characterId] = o.character_id;
  const actor = doc.addObject({
    type: 'ARMATURE',
    name,
    data: armId,
    location: loc,
    rotation_euler: [0, 0, facing * DEG],
    custom_props: props,
    pose: { bones: posedBones(kind, arm, bp, pose) },
  });
  const actorName = doc.getObject(actor)!.name;
  const parts: string[] = [];
  for (const part of bp.parts) {
    const r = rest.get(part.bone);
    if (!r) continue;
    const mesh = buildPartMesh(part, r.matrix);
    const partName = `${actorName}.${part.bone}`;
    const slots = [mats[MAT_BODY], mats[MAT_DARK], mats[MAT_LIGHT]];
    if (bp.accent) slots.push(mats[MAT_ACCENT]);
    parts.push(
      doc.addObject({
        type: 'MESH',
        name: partName,
        data: doc.addMesh(partName, mesh),
        parent: actor,
        parent_type: 'BONE',
        parent_bone: part.bone,
        location: [0, -r.length, 0],
        material_slots: slots,
        custom_props: { [DESK_PROPS.actor]: actor },
      }),
    );
  }
  return { actor, parts, name: actorName };
}

/** Pose channels keyed by a pose: every bone's rotation and the hips' location. */
export function poseChannelPaths(
  bones: Iterable<string>,
): { bone: string; channel: 'rotation_euler' | 'location' }[] {
  const out: { bone: string; channel: 'rotation_euler' | 'location' }[] = [];
  for (const b of bones) {
    if (b === 'root') continue;
    out.push({ bone: b, channel: 'rotation_euler' });
    if (b === 'hips') out.push({ bone: b, channel: 'location' });
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * Keys `pose` on an actor at `frame` (blended from the pose it has `blend_frames` earlier and held
 * for `hold_frames`), or, without a frame, stores it as the actor's unkeyed pose.
 */
export function keyPose(
  doc: SceneDoc,
  actorId: string,
  pose: string,
  o: { frame?: number; blend_frames?: number; hold_frames?: number } = {},
): { frames: number[] } {
  const meta = requireActor(doc, actorId);
  const kind = requireBuiltKind(meta.kind) as ActorKind;
  const arm = doc.getArmature(meta.armature);
  if (!arm) throw new OperatorError(`Actor '${meta.name}' has no armature data`, 'FAILED');
  const target = posedBones(kind, arm, blueprintFor(kind, meta.height), pose);
  if (o.frame === undefined) {
    doc.updateObject(meta.id, { pose: { bones: target } });
    return { frames: [] };
  }
  const frame = o.frame;
  const blend = Math.max(0, Math.round(o.blend_frames ?? 6));
  const hold = o.hold_frames === undefined ? undefined : Math.max(0, Math.round(o.hold_frames));
  const from = blend > 0 ? frame - blend : frame - 1;
  const current = animatedPose(doc, meta.id, from);
  writePoseKeys(doc, meta.id, Object.keys(target), current, target, { from, frame, hold, step: blend === 0 });
  const frames = [from, frame];
  if (hold) frames.push(frame + hold);
  return { frames };
}

/**
 * Writes pose keys: the pose `old` at `from`, `target` at `frame` (and at frame + hold), the keys
 * in between cleared; without a hold, the first later key that still held the old pose now holds
 * the new one (so the next change starts from it).
 */
export function writePoseKeys(
  doc: SceneDoc,
  id: string,
  bones: string[],
  old: Record<string, PoseBone>,
  target: Record<string, PoseBone>,
  o: { from: number; frame: number; hold?: number; step?: boolean },
): void {
  const w = new KeyWriter();
  const end = o.frame + (o.hold ?? 0);
  for (const { bone, channel } of poseChannelPaths(bones)) {
    const path = bonePath(bone, channel);
    const before = (old[bone]?.[channel] ?? [0, 0, 0]) as Vec3;
    let after = (target[bone]?.[channel] ?? [0, 0, 0]) as Vec3;
    if (channel === 'rotation_euler') after = compatibleEuler(after, before);
    for (let i = 0; i < 3; i++) {
      w.clear(id, path, i, o.from, end);
      w.key(id, path, i, o.from, before[i], o.step ? 'CONSTANT' : 'BEZIER');
      w.key(id, path, i, o.frame, after[i]);
      if (o.hold) w.key(id, path, i, end, after[i]);
      else {
        const next = nextKey(doc, id, path, i, end);
        if (next && close(next.value, before[i]))
          w.key(id, path, i, next.frame, after[i], next.interpolation);
      }
    }
  }
  w.commit(doc);
}
