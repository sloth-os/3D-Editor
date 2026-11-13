import type { Vec3 } from '../../math/types';

/*
 * Names, types and constants of the desk actors (spec §8), shared by the characters modules and
 * re-exported by desk/characters/index.ts.
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
