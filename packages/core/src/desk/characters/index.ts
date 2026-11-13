import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { FrameState } from '../../eval/frame-state';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';
import { buildActor, keyPose } from './actor';
import { holdObject, lookAtObject, mountActor, refreshDismounts } from './attach';
import { keypointsOf, measureActor } from './keypoints';
import { actorPosition, moveActor, turnActor, yawOf } from './locomotion';
import type { ActorInfo, ActorKeypoints, CreateActorOptions } from './types';

/*
 * Actors of the director's desk (CHARACTERS; spec §8): segmented mannequins (humanoids) and
 * quadrupeds, each an ARMATURE object (desk_role 'actor') with one mesh part per bone,
 * BONE-parented (desk_actor = the armature's id). Locomotion keys the armature OBJECT's location
 * and rotation_euler[2] (the `root` bone stays at rest), so the object's transform is the actor's
 * position for checks, layouts, subject tracks and rideo exports. Gaits are explicit keys for every
 * cycle of a move, planned from footsteps so planted feet stay put. Hold and mount use CHILD_OF on a
 * bone subtarget with influence keyed 0→1 at the grab (inverse set there) and 1→0 at the release;
 * a rider's dismount is keyed again whenever its mount moves, turns or changes pose.
 *
 * Modules: types (names and constants), rig (shared vocabulary), mannequin / quadruped (bodies),
 * kinds (registry), poses, actor (build, pose keys), gait / locomotion (moves, turns), attach
 * (look, hold, ride), keypoints (measures).
 */

export * from './types';
export { BUILT_KINDS, defaultHeight as defaultActorHeight } from './kinds';
export { OPENPOSE18_KEYPOINTS, QUADRUPED_KEYPOINTS } from './keypoints';
export { MAX_ACTOR_HEIGHT, MIN_ACTOR_HEIGHT } from './actor';

/** Whether object `id` is an actor: an ARMATURE object with desk_role 'actor'. */
export function isActor(doc: SceneDoc, id: string): boolean {
  const y = doc.map('objects').get(id) as { get(key: string): unknown } | undefined;
  if (!y || typeof y.get !== 'function' || y.get('type') !== 'ARMATURE') return false;
  const props = y.get('custom_props') as Record<string, unknown> | undefined;
  return !!props && props[DESK_PROPS.role] === 'actor';
}

/**
 * Builds an actor (armature + parts) standing at `location` facing facing_deg, in `pose`
 * (unkeyed); returns the armature object, its parts and name. Heights: people to the top of the
 * head, animals at the withers.
 */
export function createActor(
  doc: SceneDoc,
  o: CreateActorOptions,
): { actor: string; parts: string[]; name: string } {
  return buildActor(doc, o);
}

/** The actor measured at the frame `fs` evaluates (world space). */
export function actorInfo(fs: FrameState, doc: SceneDoc, actorId: string): ActorInfo {
  return measureActor(fs, doc, actorId);
}

/**
 * Keypoints of the actor at the frame `fs` evaluates: OpenPose-18 for people, AP-10K's 17 for
 * quadrupeds (OPENPOSE18_KEYPOINTS, QUADRUPED_KEYPOINTS); nose, eyes and ears are fixed offsets on
 * the head bone.
 */
export function actorKeypoints(fs: FrameState, doc: SceneDoc, actorId: string): ActorKeypoints {
  return keypointsOf(fs, doc, actorId);
}

/**
 * Keys pose `pose` at `frame`, blended from the pose the actor has blend_frames earlier (default 6)
 * and held for hold_frames; without a frame the pose becomes the actor's unkeyed rest pose.
 */
export function applyPose(
  doc: SceneDoc,
  actorId: string,
  pose: string,
  o?: { frame?: number; blend_frames?: number; hold_frames?: number },
): void {
  keyPose(doc, actorId, pose, o);
  refreshDismounts(doc, actorId);
}

/**
 * Keys the actor walking (running, trotting, galloping) from where it stands at frame_start through
 * `points`, at speed_mps or arriving at frame_end; returns the arrival frame and the path length.
 */
export function moveAlongPath(
  doc: SceneDoc,
  actorId: string,
  points: Vec3[],
  o: {
    frame_start: number;
    speed_mps?: number;
    frame_end?: number;
    gait?: string;
    face_path?: boolean;
    end_pose?: string;
  },
): { frame_end: number; length_m: number } {
  const r = moveActor(doc, actorId, points, o);
  refreshDismounts(doc, actorId);
  return { frame_end: r.frame_end, length_m: r.length_m };
}

/** Keys the actor turning on the spot to facing_deg, or towards `target`, ending at `frame` after turn_frames (default 8). */
export function faceTo(
  doc: SceneDoc,
  actorId: string,
  o: { facing_deg?: number; target?: Vec3; frame: number; turn_frames?: number },
): void {
  if (!Number.isFinite(o.frame)) throw new OperatorError('frame must be a number', 'INVALID_PARAMS');
  const turnFrames = Math.max(0, Math.round(o.turn_frames ?? 8));
  let yaw: number;
  if (o.target) {
    const at = actorPosition(doc, actorId, o.frame - turnFrames);
    const d: Vec3 = [o.target[0] - at[0], o.target[1] - at[1], 0];
    if (Math.hypot(d[0], d[1]) < 1e-6)
      throw new OperatorError('target is where the actor stands: give facing_deg instead', 'INVALID_PARAMS');
    yaw = yawOf(d);
  } else if (o.facing_deg !== undefined && Number.isFinite(o.facing_deg))
    yaw = (o.facing_deg * Math.PI) / 180;
  else throw new OperatorError('Give facing_deg or target', 'INVALID_PARAMS');
  turnActor(doc, actorId, { yaw, frame: o.frame, turnFrames });
  refreshDismounts(doc, actorId);
}

/** Keys the actor's head looking at object `target` (null: straight ahead again) from `frame`. */
export function lookAt(
  doc: SceneDoc,
  actorId: string,
  target: string | null,
  o: { frame: number; blend_frames?: number },
): void {
  lookAtObject(doc, actorId, target, o);
}

/** Makes the actor hold `propId` in a hand from `frame` (CHILD_OF on the hand bone) until release_frame. */
export function holdProp(
  doc: SceneDoc,
  actorId: string,
  propId: string,
  o: { hand?: 'right' | 'left'; frame: number; release_frame?: number },
): void {
  holdObject(doc, actorId, propId, o);
}

/** Seats `riderId` on `mountId`'s saddle in the 'ride' pose from `frame` until dismount_frame. */
export function mount(
  doc: SceneDoc,
  riderId: string,
  mountId: string,
  o: { frame: number; dismount_frame?: number },
): void {
  mountActor(doc, riderId, mountId, o);
}
