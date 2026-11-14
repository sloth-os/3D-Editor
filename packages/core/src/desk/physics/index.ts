import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { CollisionShape } from '../../doc/types';
import { deskBake, deskBakePlan, type DeskBakeResult } from './bake';
import type { DeskBakeWater } from './float';
import { deskDrop, deskPhysicsSetupBodies, deskPush, deskThrow, type DeskWorldRange } from './presets';
import { tetherFly, type TetherAfter, type TetherResult } from './tether';
import { vehicleDrive, type VehicleResult } from './vehicle';

/*
 * Physics presets of the director's desk (MOTION owns this module and presets.ts, bake.ts, tether.ts,
 * vehicle.ts, common.ts, estimate.ts): the library behind the desk.physics_* operators
 * (operators/desk-motion.ts). Bodies start at their RigidBodyData.start_frame with initial velocities
 * (doc/types.ts; the simulation keeps a body animated until then, physics/simulation.ts), and the
 * presets set the rigid body world's range to the frames they need (frame_start = min(start_frame) −
 * RELEASE_TRACKED_STEPS, ending when the bodies have come to rest), never the whole scene range; a
 * start_frame set later past that range keeps the world running until its body rests.
 *
 *   deskPhysicsSetup   desk.physics_setup   rigid bodies (+ a ground collider) on objects
 *   deskPhysicsDrop    desk.physics_drop    lift and release objects at a frame
 *   deskPhysicsThrow   desk.physics_throw   launch velocity to land on a point or object
 *   deskPhysicsPush    desk.physics_push    a push (velocity along a direction) at a frame
 *   deskPhysicsBake    desk.physics_bake    simulated motion to world-space keyframes (floating on water)
 *   deskTetherFly      desk.tether_fly      a kite / balloon on a string from an anchor (phase 2)
 *   deskVehicleDrive   desk.vehicle_drive   a vehicle along a path, wheels spinning, steering (phase 2)
 *
 * Object references are ids (the operators resolve names). Every function changes the document and
 * returns what it did, with warnings for the operator to report.
 */

export {
  DESK_BALL_SETTINGS,
  DESK_SETTLE_FALLBACK_SECONDS,
  DESK_SETTLE_MAX_SECONDS,
  ballisticVelocity as deskBallisticVelocity,
  flightCoefficients as deskFlightCoefficients,
  guessShape as deskGuessShape,
  isBallLike as deskIsBallLike,
  updateDeskWorldRange,
  type DeskWorldRange,
} from './presets';
export {
  DESK_BAKE_MAX_BODY_FRAMES,
  deskBakePlan,
  type DeskBakeBody,
  type DeskBakeFloat,
  type DeskBakePlan,
  type DeskBakeResult,
} from './bake';
export {
  DESK_BAKE_WATER,
  FLAT_RATIO,
  FLOAT_BOB_HZ,
  FLOAT_BOB_M,
  FLOAT_DEPTH_RADII,
  FLOAT_DRIFT_S,
  FLOAT_ENTRY_MPS,
  FLOAT_SETTLE_S,
  FLOAT_SPIN_S,
  FLOAT_TILT_S,
  FLOAT_TOP_SHARE,
  SINK_DEPTH_RADII,
  WATER_DENSITY,
  type DeskBakeWater,
} from './float';
export { modelRootOf as deskModelRoot } from './common';
export {
  TETHER_AFTER,
  TETHER_LAND_FALL_FACTOR,
  TETHER_LAND_SECONDS,
  TETHER_MAX_FRAMES,
  TETHER_MAX_OBJECT_FRAMES,
  TETHER_STRING_RADIUS,
  TETHER_TAIL_SEGMENTS,
  TETHER_TAIL_SETTLE_SECONDS,
  seedFromName as deskTetherSeed,
  tetherLandFramesMax,
  tetherLandSeconds,
  windModel as deskWindModel,
  TETHER_DETACH_M,
  tetherDetachments as deskTetherDetachments,
  type TetherAfter,
  type TetherDetachment,
  type TetherResult,
} from './tether';
export {
  VEHICLE_DEFAULT_MPS,
  VEHICLE_EASE_SECONDS,
  VEHICLE_MAX_FRAMES,
  VEHICLE_MAX_STEER,
  drivenDistance as deskDrivenDistance,
  vehicleRig as deskVehicleRig,
  type VehicleResult,
  type VehicleWheel,
} from './vehicle';

/** How desk.physics_setup simulates objects: dynamic, static colliders, or animated colliders. */
export const DESK_PHYSICS_KINDS = ['active', 'passive', 'animated'] as const;
export type DeskPhysicsKind = (typeof DESK_PHYSICS_KINDS)[number];

export interface DeskPhysicsSetupOptions {
  kind: DeskPhysicsKind;
  shape?: CollisionShape;
  mass?: number;
  friction?: number;
  restitution?: number;
  /** Add (or reuse) a passive ground collider at z = 0. */
  ground?: boolean;
}

export interface DeskThrowOptions {
  /** Frame the object leaves its holder (its start_frame). */
  frame: number;
  /** Seconds in the air until it reaches the target. */
  flight_s: number;
  /** Angular velocity (rad/s, world space) given at the release. */
  spin?: Vec3;
}

export interface DeskTetherFlyOptions {
  /** The flying object (a kite, a balloon). */
  flyer: string;
  /** Object the string is tied to (an actor's hand: anchor_bone). */
  anchor: string;
  anchor_bone?: string;
  length_m: number;
  wind_dir_deg: number;
  wind_mps: number;
  frame_start: number;
  frame_end: number;
  launch_frames?: number;
  tail?: boolean;
  string?: boolean;
  seed?: number;
  /** After frame_end: 'hold' (default) where the flight ends, 'hide' the flyer, tail and string, 'land' a kite. */
  after?: TetherAfter;
}

/** What a preset did to the rigid body world, and what the operator reports. */
interface PresetReport {
  /** The rigid body world's range afterwards (null: the scene has no simulated body). */
  world: DeskWorldRange | null;
  warnings: string[];
}

/**
 * Gives `objectIds` rigid bodies of `kind` (a model's root: its mesh part) and a ground collider under
 * them; returns the bodies and the ground (null: none needed or asked for).
 */
export function deskPhysicsSetup(
  doc: SceneDoc,
  objectIds: readonly string[],
  o: DeskPhysicsSetupOptions,
): { bodies: string[]; ground: string | null } & PresetReport {
  return deskPhysicsSetupBodies(doc, objectIds, o);
}

/** Lifts `objectIds` by `height` (default: where they are) and releases them at `frame`. */
export function deskPhysicsDrop(
  doc: SceneDoc,
  objectIds: readonly string[],
  o: { frame: number; height?: number },
): { bodies: string[] } & PresetReport {
  return deskDrop(doc, objectIds, o);
}

/** Releases `objectId` at `frame` with the velocity that lands it on `target` (a point or an object) after flight_s. */
export function deskPhysicsThrow(
  doc: SceneDoc,
  objectId: string,
  target: Vec3 | string,
  o: DeskThrowOptions,
): { body: string; velocity: Vec3; landing_frame: number } & PresetReport {
  return deskThrow(doc, objectId, target, o);
}

/** Pushes `objectId` along `direction` at speed_mps from `frame`. */
export function deskPhysicsPush(
  doc: SceneDoc,
  objectId: string,
  o: { direction: Vec3; speed_mps: number; frame: number },
): { body: string; velocity: Vec3 } & PresetReport {
  return deskPush(doc, objectId, o);
}

/**
 * Bakes the simulation of `objects` (bodies, or objects above them such as a store model's root;
 * default: every simulated body) to keyframes: a body that carries a store model's geometry is keyed
 * through the model's root, any other body on itself (desk/physics/bake.ts); bodies that reach water
 * float there unless `water` is 'ignore' (desk/physics/float.ts).
 */
export function deskPhysicsBake(
  doc: SceneDoc,
  o: { frame_start?: number; frame_end?: number; objects?: readonly string[]; water?: DeskBakeWater },
): DeskBakeResult {
  return deskBake(doc, deskBakePlan(doc, o));
}

/**
 * Flies `flyer` on a string from `anchor` in the wind (phase 2): keys the flyer, its string and its
 * tail on every frame of the flight, then holds, hides or lands them (`after`; desk/physics/tether.ts).
 */
export function deskTetherFly(doc: SceneDoc, o: DeskTetherFlyOptions): TetherResult {
  return tetherFly(doc, o);
}

/**
 * Drives `vehicleId` through `points` (wheels spin, front wheels steer) (phase 2): keys the vehicle,
 * its wheels and its steering pivots on every frame of the drive (desk/physics/vehicle.ts).
 */
export function deskVehicleDrive(
  doc: SceneDoc,
  vehicleId: string,
  points: readonly Vec3[],
  o: { frame_start: number; speed_mps?: number; frame_end?: number },
): VehicleResult {
  return vehicleDrive(doc, vehicleId, points, o);
}
