import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { CollisionShape } from '../../doc/types';
import { OperatorError } from '../../operators/context';

/*
 * Physics presets of the director's desk (MOTION owns this module and presets.ts, tether.ts,
 * vehicle.ts): the library behind the desk.physics_* operators (operators/desk-motion.ts). Bodies
 * start at their RigidBodyData.start_frame with initial velocities (doc/types.ts; the simulation
 * keeps a body kinematic until then), and the presets set the rigid body world's range to the
 * frames they need (frame_start = min(start_frame) − 1), never the whole scene range.
 *
 * FOUNDATION wrote the names and signatures; every function throws until MOTION implements it.
 * The names follow the operator ids:
 *
 *   deskPhysicsSetup   desk.physics_setup   rigid bodies (+ a ground collider) on objects
 *   deskPhysicsDrop    desk.physics_drop    lift and release objects at a frame
 *   deskPhysicsThrow   desk.physics_throw   launch velocity to land on a point or object
 *   deskPhysicsPush    desk.physics_push    a push (velocity along a direction) at a frame
 *   deskPhysicsBake    desk.physics_bake    simulated motion to world-space keyframes
 *   deskTetherFly      desk.tether_fly      a kite / balloon on a string from an anchor (phase 2)
 *   deskVehicleDrive   desk.vehicle_drive   a vehicle along a path, wheels spinning, steering (phase 2)
 */

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
}

function notImplemented(name: string): never {
  throw new OperatorError(`${name} is not implemented yet`, 'FAILED');
}

/** Gives `objectIds` rigid bodies of `kind` (and a ground collider); returns the bodies and the ground. */
export function deskPhysicsSetup(
  _doc: SceneDoc,
  _objectIds: readonly string[],
  _o: DeskPhysicsSetupOptions,
): { bodies: string[]; ground: string | null } {
  return notImplemented('deskPhysicsSetup');
}

/** Lifts `objectIds` by `height` (default: where they are) and releases them at `frame`. */
export function deskPhysicsDrop(
  _doc: SceneDoc,
  _objectIds: readonly string[],
  _o: { frame: number; height?: number },
): { bodies: string[] } {
  return notImplemented('deskPhysicsDrop');
}

/** Releases `objectId` at `frame` with the velocity that lands it on `target` (a point or an object) after flight_s. */
export function deskPhysicsThrow(
  _doc: SceneDoc,
  _objectId: string,
  _target: Vec3 | string,
  _o: DeskThrowOptions,
): { velocity: Vec3; landing_frame: number } {
  return notImplemented('deskPhysicsThrow');
}

/** Pushes `objectId` along `direction` at speed_mps from `frame`. */
export function deskPhysicsPush(
  _doc: SceneDoc,
  _objectId: string,
  _o: { direction: Vec3; speed_mps: number; frame: number },
): { velocity: Vec3 } {
  return notImplemented('deskPhysicsPush');
}

/** Bakes the simulation of `objects` (default: every simulated body) to world-space keyframes. */
export function deskPhysicsBake(
  _doc: SceneDoc,
  _o: { frame_start?: number; frame_end?: number; objects?: readonly string[] },
): { objects: string[]; keyframes: number; frame_start: number; frame_end: number } {
  return notImplemented('deskPhysicsBake');
}

/** Flies `flyer` on a string from `anchor` in the wind (phase 2). */
export function deskTetherFly(
  _doc: SceneDoc,
  _o: DeskTetherFlyOptions,
): { flyer: string; string: string | null; tail: string | null; frame_end: number } {
  return notImplemented('deskTetherFly');
}

/** Drives `vehicleId` through `points` (wheels spin, front wheels steer) (phase 2). */
export function deskVehicleDrive(
  _doc: SceneDoc,
  _vehicleId: string,
  _points: readonly Vec3[],
  _o: { frame_start: number; speed_mps?: number; frame_end?: number },
): { frame_end: number; length_m: number } {
  return notImplemented('deskVehicleDrive');
}
