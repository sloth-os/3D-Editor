import type { Vec3 } from '../math/types';
import type { CollisionShape, RigidBodyData, RigidBodyWorld, SceneSettings } from '../doc/types';
import { defaultRigidBody } from '../doc/defaults';

/*
 * Validation of rigid body settings read from the document. Stored data may have been written
 * through generic property setters (MCP, scripting), so every field is checked and clamped to
 * Blender's ranges; bad values fall back to Blender's defaults instead of breaking evaluation.
 */

export const COLLISION_SHAPES: readonly CollisionShape[] = [
  'BOX',
  'SPHERE',
  'CAPSULE',
  'CYLINDER',
  'CONE',
  'CONVEX_HULL',
  'MESH',
];

/** Upper bound of simulated frames per cache (frames after it hold the last state). */
export const MAX_SIMULATED_FRAMES = 20000;

export interface WorldParams {
  frameStart: number;
  frameEnd: number;
  substeps: number;
  iterations: number;
  timeScale: number;
  /** Gravity acceleration (zero when scene.use_gravity is off), m/s². */
  gravity: Vec3;
  fps: number;
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

function vec3(v: unknown, fallback: Vec3): Vec3 {
  return Array.isArray(v) &&
    v.length >= 3 &&
    v.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x))
    ? [v[0], v[1], v[2]]
    : [...fallback];
}

/** Blender's rigid body world defaults. */
export function defaultRigidBodyWorld(): RigidBodyWorld {
  return {
    enabled: true,
    frame_start: 1,
    frame_end: 250,
    substeps_per_frame: 10,
    solver_iterations: 10,
    time_scale: 1,
  };
}

/** A valid copy of the scene's rigid body world settings (Blender ranges). */
export function sanitizeRigidBodyWorld(w: unknown): RigidBodyWorld {
  const d = defaultRigidBodyWorld();
  const o = w && typeof w === 'object' ? (w as Record<string, unknown>) : {};
  const frame_start = Math.round(num(o.frame_start, d.frame_start, -1048574, 1048574));
  return {
    enabled: bool(o.enabled, d.enabled),
    frame_start,
    frame_end: Math.round(num(o.frame_end, d.frame_end, -1048574, 1048574)),
    substeps_per_frame: Math.round(num(o.substeps_per_frame, d.substeps_per_frame, 1, 1000)),
    solver_iterations: Math.round(num(o.solver_iterations, d.solver_iterations, 1, 1000)),
    time_scale: num(o.time_scale, d.time_scale, 0, 100),
  };
}

/**
 * Last frame that is actually simulated: frame_end, capped at frame_start + MAX_SIMULATED_FRAMES
 * (later frames hold the state of that frame).
 */
export function simulatedFrameEnd(params: Pick<WorldParams, 'frameStart' | 'frameEnd'>): number {
  return Math.min(Math.max(params.frameStart, params.frameEnd), params.frameStart + MAX_SIMULATED_FRAMES);
}

/** Simulation parameters of a scene (world settings, gravity and frame rate). */
export function worldParams(scene: Partial<SceneSettings>): WorldParams {
  const w = sanitizeRigidBodyWorld(scene.rigidbody_world);
  const useGravity = bool(scene.use_gravity, true);
  return {
    frameStart: w.frame_start,
    frameEnd: Math.max(w.frame_start, w.frame_end),
    substeps: w.substeps_per_frame,
    iterations: w.solver_iterations,
    timeScale: w.time_scale,
    gravity: useGravity ? vec3(scene.gravity, [0, 0, -9.81]) : [0, 0, 0],
    fps: num(scene.fps, 24, 1e-3, 1e4),
  };
}

/**
 * Blender's settings for a newly added rigid body (`rigidbody.object_add`): ACTIVE bodies use a
 * convex hull, PASSIVE ones the triangle mesh. "Dynamic" (`enabled`) is on for both types, as in
 * Blender, so switching the type later never freezes a body.
 */
export function newRigidBody(type: RigidBodyData['type']): RigidBodyData {
  return {
    ...defaultRigidBody(type),
    enabled: true,
    collision_shape: type === 'PASSIVE' ? 'MESH' : 'CONVEX_HULL',
  };
}

/**
 * A valid copy of an object's rigid body settings, or null when the object has none. Unknown or
 * out-of-range values are replaced by Blender's defaults / clamped to Blender's ranges.
 */
export function sanitizeRigidBody(rb: unknown): RigidBodyData | null {
  if (!rb || typeof rb !== 'object' || Array.isArray(rb)) return null;
  const o = rb as Record<string, unknown>;
  const type = o.type === 'PASSIVE' ? 'PASSIVE' : 'ACTIVE';
  const d = defaultRigidBody(type);
  const shape = COLLISION_SHAPES.includes(o.collision_shape as CollisionShape)
    ? (o.collision_shape as CollisionShape)
    : d.collision_shape;
  return {
    type,
    enabled: bool(o.enabled, d.enabled),
    kinematic: bool(o.kinematic, d.kinematic),
    mass: num(o.mass, d.mass, 0.001, 1e9),
    friction: num(o.friction, d.friction, 0, 100),
    restitution: num(o.restitution, d.restitution, 0, 10),
    collision_shape: shape,
    collision_margin: num(o.collision_margin, d.collision_margin, 0, 1),
    linear_damping: num(o.linear_damping, d.linear_damping, 0, 1),
    angular_damping: num(o.angular_damping, d.angular_damping, 0, 1),
  };
}

/**
 * How a body moves during one frame step (Blender semantics):
 * - DYNAMIC: ACTIVE, "Dynamic" (enabled) and not "Animated" (kinematic): simulated.
 * - KINEMATIC: "Animated" bodies (ACTIVE or PASSIVE) follow their animated transform and push others.
 * - FROZEN: ACTIVE bodies with "Dynamic" off keep their current pose but still collide.
 * - STATIC: PASSIVE, not animated: fixed at its frame_start transform.
 */
export type MotionMode = 'DYNAMIC' | 'KINEMATIC' | 'FROZEN' | 'STATIC';

export function motionMode(rb: RigidBodyData): MotionMode {
  if (rb.kinematic) return 'KINEMATIC';
  if (rb.type === 'PASSIVE') return 'STATIC';
  return rb.enabled ? 'DYNAMIC' : 'FROZEN';
}
