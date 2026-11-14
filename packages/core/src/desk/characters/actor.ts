import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { PoseBone } from '../../doc/types';
import { compatibleEuler } from '../../constraints/math';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';
import { liftArms, type BlendGround, type KeyedChannel } from './blend';
import {
  blueprintFor,
  defaultHeight,
  isHumanoidKind,
  posedBones,
  requireBuiltKind,
  requirePose,
} from './kinds';
import { KeyWriter, bonePath, channelKeys, nextKey } from './keys';
import {
  evaluateFrames,
  isGesture,
  loweredHips,
  partName,
  readLower,
  requireLayer,
  restLower,
  sameLegs,
  unchangedComponent,
  upperLayer,
} from './layers';
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
import { ACTOR_PALETTE, type ActorKind, type CreateActorOptions, type PoseLayer } from './types';

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

/** Largest difference (radians) between two pose bones' rotation components. */
const rotGap = (a: PoseBone | undefined, b: PoseBone | undefined) => {
  const ra = (a?.rotation_euler ?? [0, 0, 0]) as Vec3;
  const rb = (b?.rotation_euler ?? [0, 0, 0]) as Vec3;
  return Math.max(Math.abs(ra[0] - rb[0]), Math.abs(ra[1] - rb[1]), Math.abs(ra[2] - rb[2]));
};

/**
 * Keys `pose` on an actor at `frame` (blended from the pose it has `blend_frames` earlier and held
 * for `hold_frames`), or, without a frame, stores it as the actor's unkeyed pose. `layer` (default
 * 'auto' as desk.actor_pose's; applyPose passes 'full' unless told otherwise; layers.ts): 'full'
 * keys the whole body; 'upper' only the spine, neck, head and arms the pose moves, over the hips
 * and legs the actor has; 'auto' layers a gesture on an actor that sits, kneels, crouches, lies,
 * rides or moves its legs, and keys everything else in full. Returns the keyed frames, the layer
 * used, the parts of the pose a layer held back because they would go into the ground (`held`:
 * 'back and head', 'left arm', 'right arm', an animal's 'neck and head') and a warning saying so.
 */
export function keyPose(
  doc: SceneDoc,
  actorId: string,
  pose: string,
  o: { frame?: number; blend_frames?: number; hold_frames?: number; layer?: PoseLayer } = {},
): { frames: number[]; layer: 'full' | 'upper'; held: string[]; warning?: string } {
  const meta = requireActor(doc, actorId);
  const kind = requireBuiltKind(meta.kind) as ActorKind;
  const arm = doc.getArmature(meta.armature);
  if (!arm) throw new OperatorError(`Actor '${meta.name}' has no armature data`, 'FAILED');
  const layer = requireLayer(o.layer);
  const bp = blueprintFor(kind, meta.height);
  const target = posedBones(kind, arm, bp, pose);
  // a gesture is layered by 'auto' only where the legs are not standing still (layers.ts)
  const mayLayer = layer === 'upper' || (layer === 'auto' && isGesture(kind, pose));
  if (o.frame === undefined) {
    // the bones keep their constraints (looks, holds)
    const old = doc.getObject(meta.id)?.pose.bones ?? {};
    let posed = target;
    let used: 'full' | 'upper' = 'full';
    let held: string[] = [];
    let changed = true;
    let stance: string | null = null;
    if (mayLayer) {
      const lower = restLower(kind, arm, bp, old);
      if (layer === 'upper' || lower.low) {
        const up = upperLayer(kind, arm, bp, pose, lower.stance, old, old);
        posed = { ...target, ...old };
        for (const part of up.parts) for (const b of part) posed[b] = up.target[b];
        used = 'upper';
        held = up.held.map((part) => partName(kind, part));
        changed = up.parts.some((part) => part.some((b) => rotGap(old[b], up.target[b]) > 1e-9));
        stance = lower.stance;
      }
    }
    const bones: Record<string, PoseBone> = {};
    for (const [name, pb] of Object.entries(posed))
      bones[name] = old[name]?.constraints?.length ? { ...pb, constraints: old[name].constraints } : pb;
    doc.updateObject(meta.id, { pose: { bones } });
    return {
      frames: [],
      layer: used,
      held,
      ...heldWarning(meta.name, pose, held, stance, changed, 'nothing changed'),
    };
  }
  const frame = o.frame;
  const blend = Math.max(0, Math.round(o.blend_frames ?? 6));
  const hold = o.hold_frames === undefined ? undefined : Math.max(0, Math.round(o.hold_frames));
  const from = blend > 0 ? frame - blend : frame - 1;
  const frames = [from, frame];
  if (hold) frames.push(frame + hold);
  const f = { from, frame, end: frame + (hold ?? 0) };
  const at = evaluateFrames(doc, meta.id, mayLayer ? f : { from, frame: from, end: from });
  const current = at.from?.pose?.bones ?? {};
  const step = blend === 0;
  if (mayLayer) {
    const lower = readLower(doc, meta.id, kind, arm, bp, f, at);
    if (layer === 'upper' || lower.low || lower.moving) {
      // the stance's upper body where the pose leaves it, unless the legs move (then it is left);
      // the ground is the floor of the actor's own space: a rider's lies below its feet (7 to 36 cm
      // on the built mounts), deeper than any gesture reaches
      const now = at.frame?.pose?.bones ?? {};
      const up = upperLayer(kind, arm, bp, pose, lower.moving ? null : lower.stance, current, now);
      const samples = [current, now, at.end?.pose?.bones ?? {}];
      const bones = up.parts.flat();
      const only = (bone: string, channel: string, i: number) =>
        channel === 'rotation_euler' &&
        !unchangedComponent(
          doc,
          meta.id,
          bone,
          i,
          (up.target[bone].rotation_euler as Vec3)[i],
          samples,
          from,
          f.end,
        );
      // over a low stance an arm's blend can pass through the ground: lifted (blend.ts); not looked
      // at on a saddle, where nothing reaches the floor (above) and sampling the blend costs ~1 ms
      const ground: BlendGround | undefined =
        lower.low && !lower.riding && isHumanoidKind(kind)
          ? { arm, bp, base: now, start: current }
          : undefined;
      const keyed = writePoseKeys(doc, meta.id, bones, current, up.target, {
        from,
        frame,
        hold,
        step,
        only,
        ground,
      });
      const held = up.held.map((part) => partName(kind, part));
      const stance = lower.moving ? null : lower.stance;
      return { frames, layer: 'upper', held, ...heldWarning(meta.name, pose, held, stance, keyed > 0) };
    }
  }
  // a full pose that keeps low legs where they are (a stance keyed again after a gesture) moves
  // only the arms and back: its arms' blend can pass through the ground too
  const ground: BlendGround | undefined =
    isHumanoidKind(kind) && loweredHips(kind, arm, bp, target) && sameLegs(kind, current, target, bp.height)
      ? { arm, bp, base: target, start: current }
      : undefined;
  writePoseKeys(doc, meta.id, Object.keys(target), current, target, { from, frame, hold, step, ground });
  return { frames, layer: 'full', held: [] };
}

/** How a stance is said in a warning. */
const STANCE_WORDS: Record<string, string> = {
  sit: 'sits',
  sit_ground: 'sits on the ground',
  kneel: 'kneels',
  crouch: 'crouches',
  lie: 'lies',
  ride: 'rides',
};

/**
 * The warning for parts of a pose a layer held back (keyPose `held`): which parts would have gone
 * into the ground, and `none` (nothing was keyed, nothing changed) when nothing else changed either.
 */
function heldWarning(
  name: string,
  pose: string,
  held: readonly string[],
  stance: string | null,
  changed: boolean,
  none = 'nothing was keyed',
): { warning?: string } {
  if (!held.length) return {};
  const where = stance && STANCE_WORDS[stance] ? ` while ${name} ${STANCE_WORDS[stance]}` : '';
  const said = `${pose} would put ${name}'s ${held.join(' and ')} into the ground${where}`;
  const kept = `${held.length > 1 ? 'those parts keep' : 'that part keeps'} ${stance ? `the ${stance} pose` : 'its pose'}`;
  return { warning: `${said}; ${changed ? kept : none}` };
}

/**
 * Writes pose keys: the pose `old` at `from`, `target` at `frame` (and at frame + hold), the keys
 * in between cleared; without a hold, the first later key that still held the old pose now holds
 * the new one (so the next change starts from it). A channel never keyed that the pose leaves as it
 * is stays unkeyed (an F-curve holding one value would only cost every frame that evaluates it).
 * With `ground` (a pose over a low stance), an arm whose blend would pass through the ground gets
 * a key lifting it out (blend.ts liftArms). Returns how many channel components it keyed.
 */
export function writePoseKeys(
  doc: SceneDoc,
  id: string,
  bones: string[],
  old: Record<string, PoseBone>,
  target: Record<string, PoseBone>,
  o: {
    from: number;
    frame: number;
    hold?: number;
    step?: boolean;
    /** Keys only the channel components it accepts (a layer); without it, every one. */
    only?: (bone: string, channel: 'rotation_euler' | 'location', index: number) => boolean;
    /** What the blend is keyed over, to keep the hands out of the ground (blend.ts). */
    ground?: BlendGround;
  },
): number {
  const w = new KeyWriter();
  const end = o.frame + (o.hold ?? 0);
  const written: KeyedChannel[] = [];
  for (const { bone, channel } of poseChannelPaths(bones)) {
    const path = bonePath(bone, channel);
    const before = (old[bone]?.[channel] ?? [0, 0, 0]) as Vec3;
    let after = (target[bone]?.[channel] ?? [0, 0, 0]) as Vec3;
    if (channel === 'rotation_euler') after = compatibleEuler(after, before);
    for (let i = 0; i < 3; i++) {
      if (o.only && !o.only(bone, channel, i)) continue;
      if (close(before[i], after[i]) && !channelKeys(doc, id, path, i).length) continue;
      written.push({ bone, channel, index: i });
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
  if (o.ground && !o.step) liftArms(doc, id, w, written, o.ground, { from: o.from, frame: o.frame, end });
  w.commit(doc);
  return written.length;
}
