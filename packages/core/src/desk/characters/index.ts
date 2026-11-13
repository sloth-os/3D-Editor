import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';

/*
 * Actors of the director's desk (CHARACTERS owns this module; spec §8): segmented mannequins
 * (humanoids) and quadrupeds, each an ARMATURE object (desk_role 'actor') with one mesh part per
 * bone, BONE-parented (desk_actor = the armature's id). Locomotion keys the armature OBJECT's
 * location and rotation_euler[2] (the `root` bone stays at rest), so the object's transform is the
 * actor's position for checks, layouts, subject tracks and rideo exports. Gaits are explicit keys
 * for every cycle of a move (about 5 per channel per cycle, BEZIER, CONSTANT extrapolation). Hold
 * and mount use CHILD_OF on a bone subtarget with influence keyed 0→1 at the grab (inverse set
 * there) and 1→0 at the release.
 *
 * FOUNDATION wrote the contract: the types, poseHeightShare and ACTOR_PALETTE, isActor and stubs
 * that throw until CHARACTERS implements them.
 */

/** Every actor kind (the operator schemas list all; unimplemented kinds fail with a clear error). */
export const ACTOR_KINDS = [
  'adult',
  'man',
  'woman',
  'child',
  'toddler',
  'elder',
  'horse',
  'pony',
  'donkey',
  'cow',
  'dog',
  'small_dog',
  'cat',
  'sheep',
  'pig',
  'deer',
  'bear',
  'duck',
  'bird',
] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Humanoid kinds (the rest are quadrupeds and birds). */
export const HUMANOID_KINDS: readonly ActorKind[] = ['adult', 'man', 'woman', 'child', 'toddler', 'elder'];

/** Kinds a rider can mount (they have a `saddle` bone). */
export const RIDEABLE_KINDS: readonly ActorKind[] = ['horse', 'pony', 'donkey', 'cow'];

/** Kinds phase 1 builds; the others throw until phase 3. */
export const PHASE1_ACTOR_KINDS: readonly ActorKind[] = [
  'adult',
  'man',
  'woman',
  'child',
  'horse',
  'pony',
  'dog',
];

/** Humanoid poses: rideo's 10 first, then the editor's own. */
export const HUMAN_POSES = [
  'stand',
  'walk',
  'run',
  'sit',
  'crouch',
  'kneel',
  'lie',
  'reach',
  'point',
  'wave',
  'idle',
  'talk',
  'arms_crossed',
  'hands_on_hips',
  'carry',
  'throw',
  'kick',
  'jump',
  'look_up',
  'ride',
  'sit_ground',
] as const;
export type HumanPose = (typeof HUMAN_POSES)[number];

/** rideo's 10 poses (SceneBlocking `pose`). */
export const RIDEO_POSES: readonly HumanPose[] = HUMAN_POSES.slice(0, 10);

export const ANIMAL_POSES = ['stand', 'walk', 'trot', 'gallop', 'sit', 'lie', 'eat', 'look_up'] as const;
export type AnimalPose = (typeof ANIMAL_POSES)[number];

/** Every pose name the actor operators accept: the humanoid poses, then the quadrupeds' own. */
export const ACTOR_POSES = [...HUMAN_POSES, 'trot', 'gallop', 'eat'] as const;
export type ActorPose = (typeof ACTOR_POSES)[number];

/** Gaits of desk.actor_move ('auto' picks one from the speed and the kind). */
export const ACTOR_GAITS = ['auto', 'walk', 'run', 'trot', 'gallop'] as const;
export type ActorGait = (typeof ACTOR_GAITS)[number];

/** Fixed bone names of humanoid actors. */
export const HUMANOID_BONES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulder.L',
  'shoulder.R',
  'upper_arm.L',
  'upper_arm.R',
  'forearm.L',
  'forearm.R',
  'hand.L',
  'hand.R',
  'thigh.L',
  'thigh.R',
  'shin.L',
  'shin.R',
  'foot.L',
  'foot.R',
  'toe.L',
  'toe.R',
] as const;

/** Fixed bone names of quadruped actors (`saddle` only on RIDEABLE_KINDS). */
export const QUADRUPED_BONES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'tail.1',
  'tail.2',
  'tail.3',
  ...(['FL', 'FR', 'BL', 'BR'] as const).flatMap((leg) => [
    `upper_leg.${leg}`,
    `lower_leg.${leg}`,
    `foot.${leg}`,
  ]),
  'saddle',
] as const;

/** rideo's cast colours, in cast order (BLOCKING_PALETTE). */
export const ACTOR_PALETTE: string[] = [
  '#ff8a3d',
  '#3d8bff',
  '#3dbe6b',
  '#a35bff',
  '#f2c230',
  '#ff5fa2',
  '#2ec4c4',
  '#e5484d',
];

export interface CreateActorOptions {
  kind: ActorKind;
  name?: string;
  /** '#rrggbb' (default: the next ACTOR_PALETTE colour). */
  color?: string;
  /** Standing height in metres (default per kind). */
  height_m?: number;
  /** Where the feet stand (default: the 3D cursor of the operator, else the origin). */
  location?: Vec3;
  /** Facing in degrees about +Z (0 = facing −Y, the front). */
  facing_deg?: number;
  pose?: string;
  /** rideo character id (desk_character_id). */
  character_id?: string;
}

/** An actor measured in world space at one evaluated frame. */
export interface ActorInfo {
  kind: ActorKind;
  height_m: number;
  feet: Vec3;
  eyes: Vec3;
  head_top: Vec3;
  chest: Vec3;
  /** Unit vector the actor faces (horizontal). */
  facing: Vec3;
  /** World bounds of the actor's parts. */
  bounds: { min: Vec3; max: Vec3 };
}

/** OpenPose-18 points (humanoids) or the quadruped layout; null for points that are hidden or missing. */
export interface ActorKeypoints {
  format: 'openpose18' | 'quadruped';
  points: (Vec3 | null)[];
}

function notImplemented(name: string): never {
  throw new OperatorError(`${name} is not implemented yet`, 'FAILED');
}

/**
 * rideo's POSE_HEIGHT: the share of the standing height a subject keeps in a pose (stand, walk,
 * reach, point and wave 1, run 0.97, sit 0.72, crouch 0.62, kneel 0.74, lie 0.22); 1 for every
 * other pose. The camera solver scales subjects by it when it has no measured actor.
 */
export function poseHeightShare(pose: string): number {
  switch (pose) {
    case 'run':
      return 0.97;
    case 'sit':
      return 0.72;
    case 'crouch':
      return 0.62;
    case 'kneel':
      return 0.74;
    case 'lie':
      return 0.22;
    default:
      return 1;
  }
}

/** Whether object `id` is an actor: an ARMATURE object with desk_role 'actor'. */
export function isActor(doc: SceneDoc, id: string): boolean {
  const y = doc.map('objects').get(id) as { get(key: string): unknown } | undefined;
  if (!y || typeof y.get !== 'function' || y.get('type') !== 'ARMATURE') return false;
  const props = y.get('custom_props') as Record<string, unknown> | undefined;
  return !!props && props[DESK_PROPS.role] === 'actor';
}

/** Builds an actor (armature + parts), placed and posed; returns the armature object, its parts and name. */
export function createActor(
  _doc: SceneDoc,
  _o: CreateActorOptions,
): { actor: string; parts: string[]; name: string } {
  return notImplemented('createActor');
}

/** The actor measured at the frame `fs` evaluates (world space). */
export function actorInfo(_fs: FrameState, _doc: SceneDoc, _actorId: string): ActorInfo {
  return notImplemented('actorInfo');
}

/** Keypoints of the actor at the frame `fs` evaluates (nose, eyes and ears from fixed head offsets). */
export function actorKeypoints(_fs: FrameState, _doc: SceneDoc, _actorId: string): ActorKeypoints {
  return notImplemented('actorKeypoints');
}

/** Keys pose `pose` at `frame` (default: now), blended over blend_frames and held for hold_frames. */
export function applyPose(
  _doc: SceneDoc,
  _actorId: string,
  _pose: string,
  _o?: { frame?: number; blend_frames?: number; hold_frames?: number },
): void {
  notImplemented('applyPose');
}

/**
 * Keys the actor walking (running, trotting…) through `points` from frame_start, at speed_mps or
 * arriving at frame_end; returns the last frame and the path length.
 */
export function moveAlongPath(
  _doc: SceneDoc,
  _actorId: string,
  _points: Vec3[],
  _o: {
    frame_start: number;
    speed_mps?: number;
    frame_end?: number;
    gait?: string;
    face_path?: boolean;
    end_pose?: string;
  },
): { frame_end: number; length_m: number } {
  return notImplemented('moveAlongPath');
}

/** Keys the actor turning to facing_deg, or towards `target`, at `frame` over turn_frames. */
export function faceTo(
  _doc: SceneDoc,
  _actorId: string,
  _o: { facing_deg?: number; target?: Vec3; frame: number; turn_frames?: number },
): void {
  notImplemented('faceTo');
}

/** Keys the actor's head looking at object `target` (null: straight ahead) from `frame`. */
export function lookAt(
  _doc: SceneDoc,
  _actorId: string,
  _target: string | null,
  _o: { frame: number; blend_frames?: number },
): void {
  notImplemented('lookAt');
}

/** Makes the actor hold `propId` in a hand from `frame` (CHILD_OF on the hand bone) until release_frame. */
export function holdProp(
  _doc: SceneDoc,
  _actorId: string,
  _propId: string,
  _o: { hand?: 'right' | 'left'; frame: number; release_frame?: number },
): void {
  notImplemented('holdProp');
}

/** Seats `riderId` on `mountId`'s saddle in the 'ride' pose from `frame` until dismount_frame. */
export function mount(
  _doc: SceneDoc,
  _riderId: string,
  _mountId: string,
  _o: { frame: number; dismount_frame?: number },
): void {
  notImplemented('mount');
}
