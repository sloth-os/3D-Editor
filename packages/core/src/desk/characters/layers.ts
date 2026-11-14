import type { Vec3 } from '../../math/types';
import { transformDirection3 } from '../../math/vec3';
import type { ArmatureData, ObjectData, PoseBone } from '../../doc/types';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
import { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import { isHumanoidKind, posedBones } from './kinds';
import { lowestPoint } from './poses';
import { bonePath } from './keys';
import { LEGS } from './quadruped';
import { RIDE_PREFIX, SIDES, partSurfaces, restMatrices, type Blueprint } from './rig';
import { ANIMAL_GESTURES, HUMAN_GESTURES, POSE_LAYERS, type ActorKind, type PoseLayer } from './types';

/*
 * Layered poses (applyPose / desk.actor_pose `layer`). A full-body pose keys every bone. An
 * upper-body layer keys only the spine, neck, head and arms (an animal's neck and head), so a
 * gesture is made over whatever the hips and legs are doing: sitting on a seat or on the ground,
 * kneeling, crouching, lying, riding or walking. The layer keys the parts the pose moves away from
 * standing, each as a whole: the posture (spine, chest, neck, head) and each arm it uses. The other
 * parts take the stance's own values when the hips and legs hold a known stance still (the arm a
 * seated actor props itself up with, a rider's hand on the reins), so a gesture replaces an earlier
 * one as a full pose does; while the legs move they keep their keys (a walk's arm swing). 'auto'
 * layers a gesture (types.ts HUMAN_GESTURES) on an actor that sits, kneels, crouches, lies, rides
 * or moves its legs over the frames the pose keys; a gesture on an actor standing still, and every
 * full-body pose, are keyed in full as before. 'auto' is desk.actor_pose's default; applyPose (the
 * library call rideo's import keys its whole-figure mark poses with) keys in full unless asked.
 */

/** The bones an upper-body layer keys, and the hips and legs it leaves. */
export interface LayerRig {
  /**
   * The parts a layer keys, each as a whole: the posture (spine, chest, neck and head: a gesture
   * that turns the head also sets the back it turns it on) and each arm, shoulder to hand.
   */
  parts: readonly (readonly string[])[];
  /** The hips and legs: what the actor stands, sits or rides on (a layer never keys them). */
  lower: readonly string[];
}

const HUMAN_RIG: LayerRig = {
  parts: [
    ['spine', 'chest', 'neck', 'head'],
    ...SIDES.map((s) => [`shoulder.${s}`, `upper_arm.${s}`, `forearm.${s}`, `hand.${s}`]),
  ],
  lower: ['hips', ...SIDES.flatMap((s) => [`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`])],
};

const ANIMAL_RIG: LayerRig = {
  parts: [['neck', 'head']],
  lower: ['hips', ...LEGS.flatMap((l) => [`upper_leg.${l}`, `lower_leg.${l}`, `foot.${l}`])],
};

/** The layer bones of a kind's family. */
export const layerRig = (kind: ActorKind): LayerRig => (isHumanoidKind(kind) ? HUMAN_RIG : ANIMAL_RIG);

/** Whether `pose` is an upper-body gesture of `kind` (it moves only the spine, neck, head and arms). */
export function isGesture(kind: ActorKind, pose: string): boolean {
  return ((isHumanoidKind(kind) ? HUMAN_GESTURES : ANIMAL_GESTURES) as readonly string[]).includes(pose);
}

/** A layer value, or an INVALID_PARAMS OperatorError (absent: 'auto'). */
export function requireLayer(layer: string | undefined): PoseLayer {
  const l = layer ?? 'auto';
  if (!(POSE_LAYERS as readonly string[]).includes(l))
    throw new OperatorError(`layer must be one of ${POSE_LAYERS.join(', ')} (got '${l}')`, 'INVALID_PARAMS');
  return l as PoseLayer;
}

// ---------------------------------------------------------------- stances

/** Stances a gesture is layered over besides riding: each lowers the hips well below standing. */
const LOW_STANCES = {
  humanoid: ['sit', 'sit_ground', 'kneel', 'crouch', 'lie'],
  quadruped: ['sit', 'lie'],
} as const;

/** Joint angles this close (radians) are the same; hips locations this close (per metre of height). */
const ANGLE_EPS = 1e-3;
const LOC_EPS = 1e-3;
/** Hips lowered below standing by more than this share of the height: a low stance (sat, knelt, lying). */
const LOW_HIPS = 0.14;
/** Key frames this close are the same frame (keys.ts). */
const FRAME_EPS = 1e-3;
/** Key values this close are the same value (a key that holds a channel where it is). */
const VALUE_EPS = 1e-6;

const ZERO: Readonly<Vec3> = [0, 0, 0];
const rotOf = (b: PoseBone | undefined): Readonly<Vec3> => (b?.rotation_euler as Vec3 | undefined) ?? ZERO;
const locOf = (b: PoseBone | undefined): Readonly<Vec3> => (b?.location as Vec3 | undefined) ?? ZERO;
/** Difference of two angles (radians), wrapped to [0, π]. */
const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** posedBones results per kind, height and armature (the candidates every gesture compares with). */
const posedCache = new Map<string, Map<string, Record<string, PoseBone>>>();

/** The rest bones of an armature as a cache key (an edited armature poses differently). */
const armatureKey = (arm: ArmatureData) =>
  arm.bones.map((b) => `${b.name}:${b.parent}:${b.head}:${b.tail}:${b.roll}`).join(';');

/** posedBones of a kind's pose (cached; the result is shared: never change it). */
export function cachedPose(
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  pose: string,
): Record<string, PoseBone> {
  const key = `${kind}|${bp.height}|${armatureKey(arm)}`;
  let poses = posedCache.get(key);
  if (!poses) {
    if (posedCache.size >= 64) posedCache.clear();
    posedCache.set(key, (poses = new Map()));
  }
  let bones = poses.get(pose);
  if (!bones) poses.set(pose, (bones = posedBones(kind, arm, bp, pose)));
  return bones;
}

/** Whether two poses have the same hips and legs. */
function sameLower(rig: LayerRig, a: Record<string, PoseBone>, b: Record<string, PoseBone>, height: number) {
  for (const bone of rig.lower) {
    const ra = rotOf(a[bone]);
    const rb = rotOf(b[bone]);
    for (let i = 0; i < 3; i++) if (angleGap(ra[i], rb[i]) > ANGLE_EPS) return false;
    if (bone !== 'hips') continue;
    const la = locOf(a[bone]);
    const lb = locOf(b[bone]);
    for (let i = 0; i < 3; i++) if (Math.abs(la[i] - lb[i]) > LOC_EPS * height) return false;
  }
  return true;
}

/** Whether two poses of an actor of `kind` have the same hips and legs. */
export const sameLegs = (
  kind: ActorKind,
  a: Record<string, PoseBone>,
  b: Record<string, PoseBone>,
  height: number,
): boolean => sameLower(layerRig(kind), a, b, height);

/** Whether a pose lowers the hips below standing by more than LOW_HIPS of the height (sat, knelt, lying). */
export function loweredHips(
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  bones: Record<string, PoseBone>,
): boolean {
  return hipsDrop(arm, bones, cachedPose(kind, arm, bp, 'stand')) > LOW_HIPS * bp.height;
}

/** How far (m) a pose's hips are below standing, in the character's space (its armature at rest). */
function hipsDrop(
  arm: ArmatureData,
  bones: Record<string, PoseBone>,
  stand: Record<string, PoseBone>,
): number {
  const rest = restMatrices(arm.bones).get('hips')?.matrix;
  if (!rest) return 0;
  const z = (b: Record<string, PoseBone>) => transformDirection3(rest, locOf(b.hips) as Vec3)[2];
  return z(stand) - z(bones);
}

/** What an actor's hips and legs do over the frames a pose keys (readLower). */
export interface LowerBody {
  /**
   * The full-body pose they hold still ('ride' for a rider), whose upper body the parts a layer
   * leaves take; null while they move, or when they hold no pose of the kind's stances.
   */
  stance: string | null;
  /** Whether they move over those frames: keys inside them that change a value, or other values at their ends. */
  moving: boolean;
  /** Whether the actor is down or carried: riding, or its hips lowered below standing. */
  low: boolean;
  /** Whether it rides (its ground is the saddle, not the floor under its armature). */
  riding: boolean;
}

/** The evaluated actor at the frames a pose keys: where it blends from, reaches the pose and stops holding it. */
export interface PoseFrames {
  from: number;
  frame: number;
  end: number;
}

/** The actor object as evaluated at each of the frames (one reading of the document for all). */
export function evaluateFrames(
  doc: SceneDoc,
  id: string,
  f: PoseFrames,
): { from: ObjectData | null; frame: ObjectData | null; end: ObjectData | null } {
  // frame states of an unchanged document share their reading of it (eval/frame-input.ts)
  const at = (frame: number) => new FrameState(doc, frame).get<ObjectData>('object', id);
  const from = at(f.from);
  const frame = f.frame === f.from ? from : at(f.frame);
  return { from, frame, end: f.end === f.frame ? frame : at(f.end) };
}

/** Whether an evaluated actor rides: a 'Ride …' CHILD_OF holds it (influence ≥ 0.5). */
const riding = (o: ObjectData | null): boolean =>
  !!o?.constraints?.some(
    (c) => c.type === 'CHILD_OF' && c.name.startsWith(RIDE_PREFIX) && !c.mute && (c.influence ?? 1) >= 0.5,
  );

/**
 * Whether a channel of the hips or legs has a key strictly inside (from, end) that changes its
 * value: one away from the value it has at `from` (`at`, the bones evaluated there). A key that only
 * holds that value (a held pose's end, which every keyed channel gets) moves nothing: the curves'
 * handles are auto-clamped (anim/fcurve.ts), so a curve between keys of one value stays flat.
 */
function keyedInside(
  doc: SceneDoc,
  id: string,
  rig: LayerRig,
  from: number,
  end: number,
  at: Record<string, PoseBone>,
): boolean {
  if (!(end - from > 2 * FRAME_EPS)) return false;
  for (const bone of rig.lower)
    for (const channel of bone === 'hips'
      ? (['rotation_euler', 'location'] as const)
      : (['rotation_euler'] as const))
      for (let i = 0; i < 3; i++) {
        const fc = doc.getFCurve(
          fcurveKey({ target_type: 'object', target_id: id, path: bonePath(bone, channel), index: i }),
        );
        if (!fc) continue;
        const v = (channel === 'location' ? locOf(at[bone]) : rotOf(at[bone]))[i];
        if (
          fc.keyframes.some(
            (k) =>
              k.frame > from + FRAME_EPS && k.frame < end - FRAME_EPS && Math.abs(k.value - v) > VALUE_EPS,
          )
        )
          return true;
      }
  return false;
}

/**
 * What the actor's hips and legs do over frames `f`, read from the actor evaluated there (`at`) and
 * its keys: a rider rides ('ride'); legs keyed inside the frames, or posed differently at their
 * ends, move; legs held still in one of the kind's stances (stand or a low one) hold it.
 */
export function readLower(
  doc: SceneDoc,
  id: string,
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  f: PoseFrames,
  at: { from: ObjectData | null; frame: ObjectData | null; end: ObjectData | null },
): LowerBody {
  const rig = layerRig(kind);
  const bones = [at.from, at.frame, at.end].map((o) => o?.pose?.bones ?? {});
  const moving =
    !sameLower(rig, bones[0], bones[1], bp.height) ||
    !sameLower(rig, bones[0], bones[2], bp.height) ||
    keyedInside(doc, id, rig, f.from, f.end, bones[0]);
  const lowered = bones.some((b) => loweredHips(kind, arm, bp, b));
  if (riding(at.frame)) return { stance: moving ? null : 'ride', moving, low: true, riding: true };
  if (moving) return { stance: null, moving, low: lowered, riding: false };
  return { ...stanceOf(kind, arm, bp, bones[1]), moving, riding: false };
}

/** The stance a still pose holds (stand or a low one), and whether it is low. */
function stanceOf(
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  bones: Record<string, PoseBone>,
): { stance: string | null; low: boolean } {
  const rig = layerRig(kind);
  const stand = cachedPose(kind, arm, bp, 'stand');
  if (sameLower(rig, bones, stand, bp.height)) return { stance: 'stand', low: false };
  for (const s of LOW_STANCES[isHumanoidKind(kind) ? 'humanoid' : 'quadruped'])
    if (sameLower(rig, bones, cachedPose(kind, arm, bp, s), bp.height)) return { stance: s, low: true };
  return { stance: null, low: loweredHips(kind, arm, bp, bones) };
}

/** The stance of an actor's stored (unkeyed) pose, for a pose applied without a frame. */
export function restLower(
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  bones: Record<string, PoseBone>,
): LowerBody {
  return { ...stanceOf(kind, arm, bp, bones), moving: false, riding: false };
}

// ---------------------------------------------------------------- the layer

/**
 * An upper-body layer: the parts it keys (each a list of bones) and their target pose, and the
 * parts of the pose the ground rule held back (they keep the stance's values or their own).
 */
export interface UpperLayer {
  parts: string[][];
  target: Record<string, PoseBone>;
  held: string[][];
}

/** What a part of a layer is called in a warning: the back and head, an arm, an animal's neck and head. */
export function partName(kind: ActorKind, part: readonly string[]): string {
  if (!isHumanoidKind(kind)) return 'neck and head';
  if (part.some((b) => b.endsWith('.L'))) return 'left arm';
  if (part.some((b) => b.endsWith('.R'))) return 'right arm';
  return 'back and head';
}

/** How far (share of the height) a layer may put the body into the ground before a part is held back (upperLayer). */
const SINK = 0.02;

/**
 * The upper-body layer of `pose` over an actor's bones `current`: each part (the posture, an arm)
 * the pose moves away from standing takes its values; each other part takes the stance's
 * (`stance`, a pose name) or, without one, is not keyed. With `ground` (the actor's bones at the
 * pose's frame, its hips and legs where they are), a part that would put the body more than SINK
 * of its height into the ground (an arm hanging from a seat on the ground, the head of an actor
 * lying on its back tipped back) takes the stance's values, or is left as it was where those sink
 * it too: the parts that sink it most go first. `held`: the parts of the gesture so held back
 * (keyPose warns about them).
 */
export function upperLayer(
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  pose: string,
  stance: string | null,
  current: Record<string, PoseBone>,
  ground: Record<string, PoseBone> | null = null,
): UpperLayer {
  const gesture = cachedPose(kind, arm, bp, pose);
  const stand = cachedPose(kind, arm, bp, 'stand');
  const base = stance ? cachedPose(kind, arm, bp, stance) : null;
  const moves = (bone: string) =>
    [0, 1, 2].some((i) => angleGap(rotOf(gesture[bone])[i], rotOf(stand[bone])[i]) > 1e-9);
  const target: Record<string, PoseBone> = {};
  let parts: string[][] = [];
  const held: string[][] = [];
  for (const part of layerRig(kind).parts) {
    const bones = part.filter((b) => gesture[b]);
    const src = bones.some(moves) ? gesture : base;
    if (!src || !bones.length) continue;
    for (const b of bones)
      target[b] = { ...(current[b] ?? src[b]), rotation_euler: [...rotOf(src[b])] as Vec3 };
    parts.push(bones);
  }
  if (ground && parts.length) {
    const surface = partSurfaces(bp);
    const low = (keep: string[][]) => {
      const bones = { ...ground };
      for (const part of keep) for (const b of part) bones[b] = target[b];
      return lowestPoint(arm, bones, bp.probes, surface);
    };
    const floor = Math.min(0, low([])) - SINK * bp.height;
    const dropped: string[][] = [];
    while (parts.length && low(parts) < floor) {
      let drop = 0;
      let best = -Infinity;
      parts.forEach((_, i) => {
        const l = low(parts.filter((__, j) => j !== i));
        if (l > best) [best, drop] = [l, i];
      });
      dropped.push(parts[drop]);
      parts = parts.filter((_, i) => i !== drop);
    }
    // a dropped part of the gesture takes the stance's values instead where they keep it up (an
    // earlier gesture's arm does not stay); otherwise it is left as it was
    for (const part of dropped) {
      if (part.some(moves)) held.push(part);
      if (base && part.some(moves)) {
        for (const b of part)
          target[b] = { ...(current[b] ?? base[b]), rotation_euler: [...rotOf(base[b])] as Vec3 };
        if (low([...parts, part]) >= floor) {
          parts.push(part);
          continue;
        }
      }
      for (const b of part) delete target[b];
    }
  }
  return { parts, target, held };
}

/**
 * Whether keying component `i` of bone `bone`'s rotation from `before` (at `from`) to `after` would
 * change nothing: it already holds that value at the pose's frames (at `samples`) and has no keys
 * between them (a curve flat at both ends of a span with no keys in it is flat all through it).
 */
export function unchangedComponent(
  doc: SceneDoc,
  id: string,
  bone: string,
  i: number,
  after: number,
  samples: readonly Record<string, PoseBone>[],
  from: number,
  end: number,
): boolean {
  for (const s of samples) if (angleGap(rotOf(s[bone])[i], after) > 1e-9) return false;
  const fc = doc.getFCurve(
    fcurveKey({ target_type: 'object', target_id: id, path: bonePath(bone, 'rotation_euler'), index: i }),
  );
  return !fc?.keyframes.some((k) => k.frame > from + FRAME_EPS && k.frame <= end + FRAME_EPS);
}
