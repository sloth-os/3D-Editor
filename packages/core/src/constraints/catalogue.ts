import { z } from 'zod';
import type { ConstraintData, ConstraintType } from '../doc/types';
import { newId } from '../util/id';
import { cloneJson } from '../util/json';
import {
  childOfSchema,
  clampToSchema,
  copyLocationSchema,
  copyRotationSchema,
  copyScaleSchema,
  copyTransformsSchema,
  dampedTrackSchema,
  floorSchema,
  followPathSchema,
  limitDistanceSchema,
  limitLocationSchema,
  limitRotationSchema,
  limitScaleSchema,
  lockedTrackSchema,
  pivotSchema,
  trackToSchema,
} from './schemas';
import { BONE_CONSTRAINT_SCHEMAS } from '../armature/bone-constraints';

/** Columns of Blender's "Add Object Constraint" menu. */
export type ConstraintCategory = 'TRANSFORM' | 'TRACKING' | 'RELATIONSHIP';

/** Whether a constraint type reads a target object. */
export type ConstraintTargetRequirement = 'REQUIRED' | 'OPTIONAL' | 'NONE';

/** Static description of a constraint type (for menus, property editors, scripting and MCP). */
export interface ConstraintTypeInfo {
  type: ConstraintType;
  /** Blender UI name, also the default name of new constraints ("Track To"). */
  label: string;
  category: ConstraintCategory;
  /** What the constraint does, written for users and AI agents. */
  description: string;
  target: ConstraintTargetRequirement;
  /** Object type the target must have (Follow Path and Clamp To need a CURVE object). */
  targetObjectType: 'CURVE' | null;
  /** Whether `subtarget` may name a bone when the target is an armature. */
  boneSubtarget: boolean;
  /** Pose-bone only constraint (IK): ignored in object constraint stacks. */
  boneOnly: boolean;
  /** Parameters that hold object ids besides `target` (e.g. IK `pole_target`). */
  objectParams: string[];
  /** Parameter schema; `schema.parse({})` yields the defaults. */
  schema: z.ZodObject<z.ZodRawShape>;
}

function info(
  type: ConstraintType,
  label: string,
  category: ConstraintCategory,
  schema: z.ZodObject<z.ZodRawShape>,
  description: string,
  opts: Partial<
    Pick<ConstraintTypeInfo, 'target' | 'targetObjectType' | 'boneSubtarget' | 'boneOnly' | 'objectParams'>
  > = {},
): ConstraintTypeInfo {
  return {
    type,
    label,
    category,
    description,
    target: opts.target ?? 'REQUIRED',
    targetObjectType: opts.targetObjectType ?? null,
    boneSubtarget: opts.boneSubtarget ?? true,
    boneOnly: opts.boneOnly ?? false,
    objectParams: opts.objectParams ?? [],
    schema,
  };
}

/** Every constraint type, in Blender's "Add Constraint" menu order. */
export const CONSTRAINT_TYPES: readonly ConstraintTypeInfo[] = [
  // ---- Transform
  info(
    'COPY_LOCATION',
    'Copy Location',
    'TRANSFORM',
    copyLocationSchema,
    "Moves the owner to the target's location (use_x/use_y/use_z pick axes, invert_* negate them, use_offset " +
      "adds the owner's own location). Rotation and scale are kept.",
  ),
  info(
    'COPY_ROTATION',
    'Copy Rotation',
    'TRANSFORM',
    copyRotationSchema,
    "Gives the owner the target's rotation, per euler axis (use_x/y/z, invert_*), combined with the owner's " +
      'own rotation according to mix_mode (REPLACE, ADD, BEFORE, AFTER). Location and scale are kept.',
  ),
  info(
    'COPY_SCALE',
    'Copy Scale',
    'TRANSFORM',
    copyScaleSchema,
    "Copies the target's per-axis scale (use_x/y/z), optionally raised to `power`, made uniform " +
      "(use_make_uniform) or combined with the owner's own scale (use_offset, use_add).",
  ),
  info(
    'COPY_TRANSFORMS',
    'Copy Transforms',
    'TRANSFORM',
    copyTransformsSchema,
    "Copies the target's complete transform (location, rotation and scale), or combines it with the owner's " +
      'transform according to mix_mode.',
  ),
  info(
    'LIMIT_DISTANCE',
    'Limit Distance',
    'TRANSFORM',
    limitDistanceSchema,
    'Keeps the owner inside, outside or on the surface of a sphere of radius `distance` (metres) around the ' +
      'target. distance 0 is replaced by the current distance when the target is assigned.',
  ),
  info(
    'LIMIT_LOCATION',
    'Limit Location',
    'TRANSFORM',
    limitLocationSchema,
    "Clamps the owner's location per axis: enable use_min_x … use_max_z and set min_x … max_z (metres).",
    { target: 'NONE', boneSubtarget: false },
  ),
  info(
    'LIMIT_ROTATION',
    'Limit Rotation',
    'TRANSFORM',
    limitRotationSchema,
    "Clamps the owner's euler rotation per axis: enable use_limit_x/y/z and set min_*/max_* (radians). Angles " +
      'are compared on the circle (use_legacy_behavior = plain clamping). Also removes shear.',
    { target: 'NONE', boneSubtarget: false },
  ),
  info(
    'LIMIT_SCALE',
    'Limit Scale',
    'TRANSFORM',
    limitScaleSchema,
    "Clamps the owner's per-axis scale factors: enable use_min_x … use_max_z and set min_x … max_z.",
    { target: 'NONE', boneSubtarget: false },
  ),
  // ---- Tracking
  info(
    'CLAMP_TO',
    'Clamp To',
    'TRACKING',
    clampToSchema,
    "Keeps the owner on a CURVE target: the owner's location along main_axis is mapped proportionally onto the " +
      "curve's bounding box and the owner is moved to the matching point of the path (use_cyclic repeats it).",
    { targetObjectType: 'CURVE', boneSubtarget: false },
  ),
  info(
    'DAMPED_TRACK',
    'Damped Track',
    'TRACKING',
    dampedTrackSchema,
    'Points track_axis of the owner (default +Y) at the target using the smallest possible rotation (no up ' +
      'axis; good for eyes and pointers). Cameras and lights look along their -Z axis: give them track_axis ' +
      'TRACK_NEGATIVE_Z (object.track_set does this automatically).',
  ),
  info(
    'IK',
    'Inverse Kinematics',
    'TRACKING',
    // IK is solved by pose evaluation, which owns its parameter schema
    BONE_CONSTRAINT_SCHEMAS.IK as unknown as z.ZodObject<z.ZodRawShape>,
    'Pose bones only: bends a chain of chain_count bones so its tip reaches the target (pole_target controls the ' +
      'bend). Solved by armature pose evaluation; ignored in object constraint stacks.',
    { boneOnly: true, objectParams: ['pole_target'] },
  ),
  info(
    'LOCKED_TRACK',
    'Locked Track',
    'TRACKING',
    lockedTrackSchema,
    'Rotates the owner only around lock_axis so that track_axis (default +Y) points as close as possible at the ' +
      'target (billboards, doors, turrets). For cameras and lights, which look along -Z, use track_axis ' +
      'TRACK_NEGATIVE_Z with lock_axis LOCK_Y.',
  ),
  info(
    'TRACK_TO',
    'Track To',
    'TRACKING',
    trackToSchema,
    'Aims the owner at the target: track_axis points at it while up_axis points towards world +Z (or the ' +
      "target's Z with use_target_z). The defaults (-Z track, Y up) aim cameras and lights. Location and scale " +
      'are kept.',
  ),
  // ---- Relationship
  info(
    'CHILD_OF',
    'Child Of',
    'RELATIONSHIP',
    childOfSchema,
    'Parents the owner to the target (or one of its bones) through a constraint: the owner follows the ' +
      "target's location/rotation/scale channels enabled by use_*. inverse_matrix holds the Set Inverse " +
      'correction, computed when the target is assigned so the owner keeps its current place ' +
      '(constraint.childof_set_inverse / childof_clear_inverse change it).',
  ),
  info(
    'FLOOR',
    'Floor',
    'RELATIONSHIP',
    floorSchema,
    "Prevents the owner's origin from passing through a plane at the target's location (+ offset) along " +
      "floor_location, optionally tilted by the target's rotation (use_rotation).",
  ),
  info(
    'FOLLOW_PATH',
    'Follow Path',
    'RELATIONSHIP',
    followPathSchema,
    'Moves the owner along a CURVE target. The position is the fraction (eval_time - offset) / path_duration of ' +
      "the curve's path (animate eval_time with constraint.followpath_path_animate), or offset_factor with " +
      'use_fixed_location. Cyclic curves wrap around. use_curve_follow turns forward_axis along the path, ' +
      "use_curve_radius scales by the curve radius. The owner's own transform is applied relative to the path " +
      'point (keep its location at 0 to sit on the curve).',
    { targetObjectType: 'CURVE', boneSubtarget: false },
  ),
  info(
    'PIVOT',
    'Pivot',
    'RELATIONSHIP',
    pivotSchema,
    "Makes the owner's rotation happen around a pivot point instead of its origin: the target location + " +
      'offset, or (without target) an offset from the owner or an absolute point. rotation_range limits when ' +
      'it applies (Blender default NX: only while the X rotation is <= 0; use ALWAYS_ACTIVE to always pivot).',
    { target: 'OPTIONAL' },
  ),
];

const BY_TYPE = new Map<string, ConstraintTypeInfo>(CONSTRAINT_TYPES.map((t) => [t.type, t]));

/** Constraint type ids ('TRACK_TO', …). */
export const CONSTRAINT_TYPE_IDS: readonly ConstraintType[] = CONSTRAINT_TYPES.map((t) => t.type);

/** Static info of a constraint type (undefined for unknown types). */
export function getConstraintTypeInfo(type: string): ConstraintTypeInfo | undefined {
  return BY_TYPE.get(type);
}

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');

/**
 * Resolves a user supplied type name: an id ('TRACK_TO'), case-insensitively and with or without
 * separators ('track_to', 'TrackTo'), or a label ('Track To').
 */
export function resolveConstraintType(name: string): ConstraintTypeInfo | undefined {
  const exact = BY_TYPE.get(name) ?? BY_TYPE.get(name.trim().toUpperCase());
  if (exact) return exact;
  const key = squash(name);
  if (!key) return undefined;
  return CONSTRAINT_TYPES.find((t) => squash(t.type) === key || squash(t.label) === key);
}

/** Default parameters of a constraint type (empty object for unknown types). */
export function defaultConstraintParams(type: string): Record<string, unknown> {
  const def = BY_TYPE.get(type);
  return def ? (def.schema.parse({}) as Record<string, unknown>) : {};
}

/** Default name of a new constraint of `type` (Blender's name, e.g. "Track To"; "IK" for IK). */
export function defaultConstraintName(type: string): string {
  if (type === 'IK') return 'IK';
  return BY_TYPE.get(type)?.label ?? type;
}

/**
 * A new constraint with Blender defaults (unique id, label as name, influence 1, default params
 * merged with `init.params`). Parameters are not validated here; operators validate them.
 */
export function createConstraint(
  type: ConstraintType,
  init: Partial<Omit<ConstraintData, 'type' | 'params'>> & { params?: Record<string, unknown> } = {},
): ConstraintData {
  return {
    id: init.id ?? newId(),
    name: init.name ?? defaultConstraintName(type),
    type,
    mute: init.mute ?? false,
    influence: init.influence ?? 1,
    target: init.target ?? null,
    subtarget: init.subtarget ?? '',
    show_expanded: init.show_expanded ?? true,
    params: { ...defaultConstraintParams(type), ...cloneJson(init.params ?? {}) },
  };
}

/** A constraint type with its defaults and JSON-schema parameters (for UIs and MCP tools). */
export interface ConstraintTypeDescription extends Omit<ConstraintTypeInfo, 'schema'> {
  defaults: Record<string, unknown>;
  parameters: unknown;
}

/** Describes every constraint type with defaults and JSON schema of the parameters. */
export function describeConstraintTypes(): ConstraintTypeDescription[] {
  return CONSTRAINT_TYPES.map(({ schema, ...rest }) => {
    let parameters: unknown;
    try {
      parameters = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
    } catch {
      parameters = { type: 'object' };
    }
    return { ...rest, defaults: schema.parse({}) as Record<string, unknown>, parameters };
  });
}
