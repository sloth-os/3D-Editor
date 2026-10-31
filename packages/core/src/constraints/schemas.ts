import { z } from 'zod';

/*
 * Parameter schemas of every constraint type. Names, enum identifiers and defaults follow
 * Blender's Python API (`bpy.types.TrackToConstraint.track_axis` …); `schema.parse({})` yields
 * the defaults of a newly added constraint. Parameters live in `ConstraintData.params`; the
 * common fields (target, subtarget, influence, mute, name) are stored on the constraint itself.
 */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const constraintSpaceSchema = z.enum(['WORLD', 'LOCAL']);
export type ConstraintSpace = z.infer<typeof constraintSpaceSchema>;

export const trackAxisSchema = z.enum([
  'TRACK_X',
  'TRACK_Y',
  'TRACK_Z',
  'TRACK_NEGATIVE_X',
  'TRACK_NEGATIVE_Y',
  'TRACK_NEGATIVE_Z',
]);
export type TrackAxis = z.infer<typeof trackAxisSchema>;

export const upAxisSchema = z.enum(['UP_X', 'UP_Y', 'UP_Z']);
export type UpAxis = z.infer<typeof upAxisSchema>;

export const lockAxisSchema = z.enum(['LOCK_X', 'LOCK_Y', 'LOCK_Z']);
export type LockAxis = z.infer<typeof lockAxisSchema>;

/** Follow Path forward axes (Blender mixes FORWARD_* and TRACK_NEGATIVE_* identifiers). */
export const forwardAxisSchema = z.enum([
  'FORWARD_X',
  'FORWARD_Y',
  'FORWARD_Z',
  'TRACK_NEGATIVE_X',
  'TRACK_NEGATIVE_Y',
  'TRACK_NEGATIVE_Z',
]);
export type ForwardAxis = z.infer<typeof forwardAxisSchema>;

export const constraintEulerOrderSchema = z.enum(['AUTO', 'XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX']);
export type ConstraintEulerOrder = z.infer<typeof constraintEulerOrderSchema>;

const ownerSpace = constraintSpaceSchema
  .default('WORLD')
  .describe(
    'Space the owner is evaluated in: WORLD, or LOCAL = relative to its parent. As in Blender, LOCAL of an ' +
      'object without parent is its own rotation frame: locations are measured along its rotated axes and its own ' +
      'rotation counts as zero',
  );
const targetSpace = constraintSpaceSchema
  .default('WORLD')
  .describe(
    "Space the target is read in: WORLD, or LOCAL = the target's transform relative to its parent (a target " +
      'without parent: relative to its own rotation frame, like Blender; a bone sub-target: its pose relative to ' +
      'its rest pose and parent bone)',
  );
const headTail = z
  .number()
  .min(0)
  .max(1)
  .default(0)
  .describe('Bone sub-targets only: point along the bone used as target location, 0 = head, 1 = tail');
const flag = (value: boolean, text: string) => z.boolean().default(value).describe(text);
const limitValue = (text: string) => z.number().default(0).describe(text);

export const trackToSchema = z.object({
  track_axis: trackAxisSchema
    .default('TRACK_NEGATIVE_Z')
    .describe('Owner axis that points at the target (default -Z: what cameras and lights look along)'),
  up_axis: upAxisSchema
    .default('UP_Y')
    .describe('Owner axis that points upward (towards world +Z, or the target +Z with use_target_z)'),
  use_target_z: flag(false, "Use the target's Z axis instead of world Z as the up direction"),
  head_tail: headTail,
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const dampedTrackSchema = z.object({
  track_axis: trackAxisSchema
    .default('TRACK_Y')
    .describe(
      'Owner axis that points at the target; the owner turns by the smallest rotation that achieves it. Use ' +
        'TRACK_NEGATIVE_Z for cameras and lights (they look along -Z)',
    ),
  head_tail: headTail,
});

export const lockedTrackSchema = z.object({
  track_axis: trackAxisSchema
    .default('TRACK_Y')
    .describe('Owner axis that points towards the target (cameras and lights: TRACK_NEGATIVE_Z, they look along -Z)'),
  lock_axis: lockAxisSchema
    .default('LOCK_Z')
    .describe(
      'Owner axis that keeps its direction; the owner only rotates around it (must differ from track_axis)',
    ),
  head_tail: headTail,
});

export const copyLocationSchema = z.object({
  use_x: flag(true, "Copy the target's X location"),
  use_y: flag(true, "Copy the target's Y location"),
  use_z: flag(true, "Copy the target's Z location"),
  invert_x: flag(false, 'Negate the copied X location'),
  invert_y: flag(false, 'Negate the copied Y location'),
  invert_z: flag(false, 'Negate the copied Z location'),
  use_offset: flag(false, "Add the owner's own location to the copied location"),
  head_tail: headTail,
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const copyRotationSchema = z.object({
  use_x: flag(true, "Copy the target's X rotation"),
  use_y: flag(true, "Copy the target's Y rotation"),
  use_z: flag(true, "Copy the target's Z rotation"),
  invert_x: flag(false, 'Negate the copied X rotation'),
  invert_y: flag(false, 'Negate the copied Y rotation'),
  invert_z: flag(false, 'Negate the copied Z rotation'),
  mix_mode: z
    .enum(['REPLACE', 'ADD', 'BEFORE', 'AFTER', 'OFFSET'])
    .default('REPLACE')
    .describe(
      'How the copied rotation combines with the original: REPLACE, ADD (add euler angles), BEFORE (copied ' +
        'rotation applied before the original, as if the target were a parent), AFTER (applied after, as if ' +
        'the target were a child), OFFSET (legacy per-axis offset)',
    ),
  euler_order: constraintEulerOrderSchema
    .default('AUTO')
    .describe('Euler order used to split rotations into axes (AUTO = the owner order, XYZ)'),
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const copyScaleSchema = z.object({
  use_x: flag(true, "Copy the target's X scale"),
  use_y: flag(true, "Copy the target's Y scale"),
  use_z: flag(true, "Copy the target's Z scale"),
  power: z.number().default(1).describe("Raise the target's scale to this power before copying"),
  use_make_uniform: flag(
    false,
    'Copy the change in volume as a uniform scale on all three owner axes (selected axes multiplied)',
  ),
  use_offset: flag(false, "Combine the owner's own scale with the copied scale"),
  use_add: flag(false, 'With use_offset: add scales (2.7x behaviour) instead of multiplying them'),
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const copyTransformsSchema = z.object({
  mix_mode: z
    .enum(['REPLACE', 'BEFORE_FULL', 'BEFORE', 'BEFORE_SPLIT', 'AFTER_FULL', 'AFTER', 'AFTER_SPLIT'])
    .default('REPLACE')
    .describe(
      "How the target transform combines with the owner's: REPLACE; BEFORE_* treat the target like a parent, " +
        'AFTER_* like a child; *_FULL = plain matrix product, BEFORE/AFTER = aligned (no shear), *_SPLIT = ' +
        'location, rotation and scale combined separately',
    ),
  remove_target_shear: flag(false, 'Remove shear from the target transform before combining'),
  head_tail: headTail,
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const limitLocationSchema = z.object({
  use_min_x: flag(false, 'Enforce min_x'),
  use_min_y: flag(false, 'Enforce min_y'),
  use_min_z: flag(false, 'Enforce min_z'),
  use_max_x: flag(false, 'Enforce max_x'),
  use_max_y: flag(false, 'Enforce max_y'),
  use_max_z: flag(false, 'Enforce max_z'),
  min_x: limitValue('Lowest X location (metres)'),
  min_y: limitValue('Lowest Y location (metres)'),
  min_z: limitValue('Lowest Z location (metres)'),
  max_x: limitValue('Highest X location (metres)'),
  max_y: limitValue('Highest Y location (metres)'),
  max_z: limitValue('Highest Z location (metres)'),
  use_transform_limit: flag(false, 'Also limit interactive transform tools (no effect on evaluation)'),
  owner_space: ownerSpace,
});

export const limitRotationSchema = z.object({
  use_limit_x: flag(false, 'Limit the X rotation to [min_x, max_x]'),
  use_limit_y: flag(false, 'Limit the Y rotation to [min_y, max_y]'),
  use_limit_z: flag(false, 'Limit the Z rotation to [min_z, max_z]'),
  min_x: limitValue('Lowest X angle (radians)'),
  min_y: limitValue('Lowest Y angle (radians)'),
  min_z: limitValue('Lowest Z angle (radians)'),
  max_x: limitValue('Highest X angle (radians)'),
  max_y: limitValue('Highest Y angle (radians)'),
  max_z: limitValue('Highest Z angle (radians)'),
  euler_order: constraintEulerOrderSchema
    .default('AUTO')
    .describe('Euler order used to decompose the rotation (AUTO = the owner order, XYZ)'),
  use_legacy_behavior: flag(
    false,
    'Clamp angles as plain numbers (pre-4.2 behaviour) instead of treating them as looping around the circle',
  ),
  use_transform_limit: flag(false, 'Also limit interactive transform tools (no effect on evaluation)'),
  owner_space: ownerSpace,
});

export const limitScaleSchema = z.object({
  use_min_x: flag(false, 'Enforce min_x'),
  use_min_y: flag(false, 'Enforce min_y'),
  use_min_z: flag(false, 'Enforce min_z'),
  use_max_x: flag(false, 'Enforce max_x'),
  use_max_y: flag(false, 'Enforce max_y'),
  use_max_z: flag(false, 'Enforce max_z'),
  min_x: limitValue('Lowest X scale factor'),
  min_y: limitValue('Lowest Y scale factor'),
  min_z: limitValue('Lowest Z scale factor'),
  max_x: limitValue('Highest X scale factor'),
  max_y: limitValue('Highest Y scale factor'),
  max_z: limitValue('Highest Z scale factor'),
  use_transform_limit: flag(false, 'Also limit interactive transform tools (no effect on evaluation)'),
  owner_space: ownerSpace,
});

export const limitDistanceSchema = z.object({
  distance: z
    .number()
    .min(0)
    .default(0)
    .describe(
      'Radius of the limiting sphere around the target (metres). 0 = initialise from the current distance ' +
        '(done when the constraint gets a target through an operator)',
    ),
  limit_mode: z
    .enum(['LIMITDIST_INSIDE', 'LIMITDIST_OUTSIDE', 'LIMITDIST_ONSURFACE'])
    .default('LIMITDIST_INSIDE')
    .describe('Keep the owner INSIDE the sphere, OUTSIDE of it, or exactly ON its SURFACE'),
  use_transform_limit: flag(false, 'Also limit interactive transform tools (no effect on evaluation)'),
  head_tail: headTail,
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const childOfSchema = z.object({
  use_location_x: flag(true, "Inherit the target's X location"),
  use_location_y: flag(true, "Inherit the target's Y location"),
  use_location_z: flag(true, "Inherit the target's Z location"),
  use_rotation_x: flag(true, "Inherit the target's X rotation"),
  use_rotation_y: flag(true, "Inherit the target's Y rotation"),
  use_rotation_z: flag(true, "Inherit the target's Z rotation"),
  use_scale_x: flag(true, "Inherit the target's X scale"),
  use_scale_y: flag(true, "Inherit the target's Y scale"),
  use_scale_z: flag(true, "Inherit the target's Z scale"),
  set_inverse_pending: flag(
    true,
    'Request computing inverse_matrix from the current target transform (operators handle it as soon as a ' +
      'target is set, so the owner keeps its place); evaluation always uses the stored inverse_matrix',
  ),
  inverse_matrix: z
    .array(z.number())
    .length(16)
    .default(() => IDENTITY.slice())
    .describe(
      'Parent inverse correction applied between the target and the owner (column-major 4x4, identity = none)',
    ),
});

export const followPathSchema = z.object({
  offset: z
    .number()
    .default(0)
    .describe("Offset in frames: the position is taken at the curve's (eval_time - offset) / path_duration"),
  offset_factor: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      'Position along the path when use_fixed_location is on: 0 = start, 1 = end (animated values are clamped ' +
        'to 0..1)',
    ),
  use_fixed_location: flag(
    false,
    'Stay at offset_factor instead of following the curve evaluation time (eval_time)',
  ),
  use_curve_follow: flag(
    false,
    'Rotate the owner so forward_axis follows the path direction (and banking/tilt)',
  ),
  use_curve_radius: flag(false, 'Scale the owner by the curve radius at its position'),
  forward_axis: forwardAxisSchema
    .default('FORWARD_Y')
    .describe('Owner axis aligned with the path direction when use_curve_follow is on'),
  up_axis: upAxisSchema
    .default('UP_Z')
    .describe('Owner axis aligned with the path up direction (curve Z) when use_curve_follow is on'),
});

export const clampToSchema = z.object({
  main_axis: z
    .enum(['CLAMPTO_AUTO', 'CLAMPTO_X', 'CLAMPTO_Y', 'CLAMPTO_Z'])
    .default('CLAMPTO_AUTO')
    .describe(
      "Axis whose owner location is mapped onto the curve (AUTO = the longest axis of the curve's bounding box)",
    ),
  use_cyclic: flag(false, 'Repeat the curve beyond its bounding box instead of clamping to its ends'),
});

export const floorSchema = z.object({
  floor_location: z
    .enum(['FLOOR_X', 'FLOOR_Y', 'FLOOR_Z', 'FLOOR_NEGATIVE_X', 'FLOOR_NEGATIVE_Y', 'FLOOR_NEGATIVE_Z'])
    .default('FLOOR_Z')
    .describe(
      "Target axis the owner may not pass: FLOOR_Z keeps the owner above the target's Z, FLOOR_NEGATIVE_Z below …",
    ),
  offset: z
    .number()
    .default(0)
    .describe('Distance of the floor from the target origin along the axis (metres)'),
  use_rotation: flag(false, "Use the target's rotation (tilted floor plane)"),
  target_space: targetSpace,
  owner_space: ownerSpace,
});

export const pivotSchema = z.object({
  offset: z
    .tuple([z.number(), z.number(), z.number()])
    .default((): [number, number, number] => [0, 0, 0])
    .describe(
      'Pivot offset (metres): from the target when one is set, otherwise from the owner location ' +
        '(use_relative_location) or the absolute world position of the pivot',
    ),
  use_relative_location: flag(
    true,
    'Without a target: offset is relative to the owner location (else absolute)',
  ),
  rotation_range: z
    .enum(['ALWAYS_ACTIVE', 'NX', 'NY', 'NZ', 'X', 'Y', 'Z'])
    .default('NX')
    .describe(
      "When pivoting happens: ALWAYS_ACTIVE, or only while the owner's euler angle around X/Y/Z is negative " +
        '(NX/NY/NZ; NX is the Blender default) or positive (X/Y/Z)',
    ),
  head_tail: headTail,
});

/** Parameter schema of every object constraint type (IK's lives with pose evaluation). */
export const CONSTRAINT_PARAM_SCHEMAS = {
  TRACK_TO: trackToSchema,
  DAMPED_TRACK: dampedTrackSchema,
  LOCKED_TRACK: lockedTrackSchema,
  COPY_LOCATION: copyLocationSchema,
  COPY_ROTATION: copyRotationSchema,
  COPY_SCALE: copyScaleSchema,
  COPY_TRANSFORMS: copyTransformsSchema,
  LIMIT_LOCATION: limitLocationSchema,
  LIMIT_ROTATION: limitRotationSchema,
  LIMIT_SCALE: limitScaleSchema,
  LIMIT_DISTANCE: limitDistanceSchema,
  CHILD_OF: childOfSchema,
  FOLLOW_PATH: followPathSchema,
  CLAMP_TO: clampToSchema,
  FLOOR: floorSchema,
  PIVOT: pivotSchema,
} as const;

/** Parsed (defaults filled) parameters of an object constraint type, e.g. `ConstraintParams<'TRACK_TO'>`. */
export type ConstraintParams<T extends keyof typeof CONSTRAINT_PARAM_SCHEMAS> = z.infer<
  (typeof CONSTRAINT_PARAM_SCHEMAS)[T]
>;
