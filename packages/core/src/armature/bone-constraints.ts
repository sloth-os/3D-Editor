import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { eulerFromRotation, invert4, multiply4, rotationFromEuler } from '../math/mat4';
import { quatFromEuler } from '../math/quat';
import { transformPoint3 } from '../math/vec3';
import type { ConstraintData, ConstraintType } from '../doc/types';
import { composeTRS, decomposeTRS, rotateAbout, rotationBetween, rotationPart } from './bone-math';

/*
 * Pose bone constraints (PoseBone.constraints), evaluated in armature space during pose
 * evaluation. Parameter names follow Blender's Python API. IK is solved by `ik.ts`; the other
 * supported types are applied here, one at a time, by `applyBoneConstraint`.
 */

const space = z
  .enum(['WORLD', 'POSE', 'LOCAL'])
  .describe(
    'WORLD: world space; POSE: armature (object) space; LOCAL: the bone transform relative to its rest pose ' +
      '(object targets have no rest pose and are read in POSE space)',
  );

const eulerOrder = z
  .enum(['AUTO', 'XYZ'])
  .default('AUTO')
  .describe('Euler order used to split rotations into axes (bones rotate in XYZ, so AUTO = XYZ)');

const ikSchema = z.object({
  chain_count: z
    .number()
    .int()
    .min(0)
    .max(255)
    .default(0)
    .describe('Number of bones in the chain, counted from the constrained bone upwards (0 = up to the root)'),
  pole_target: z
    .string()
    .nullable()
    .default(null)
    .describe('Object id controlling the bend direction (with pole_subtarget: a bone of that armature)'),
  pole_subtarget: z.string().default('').describe('Bone of the pole target armature'),
  pole_angle: z
    .number()
    .default(0)
    .describe(
      "Radians. The chain root bone's X axis, rotated by this angle towards its Z axis, is turned to face the pole",
    ),
  iterations: z.number().int().min(1).max(10000).default(500).describe('Maximum solver iterations'),
  use_tail: z
    .boolean()
    .default(true)
    .describe("true: the bone's tail reaches the target; false: the chain ends at the bone's head"),
  use_stretch: z
    .boolean()
    .default(false)
    .describe('Stretch the chain bones (along their Y axis) when the target is out of reach'),
});

const copyRotationSchema = z.object({
  use_x: z.boolean().default(true),
  use_y: z.boolean().default(true),
  use_z: z.boolean().default(true),
  invert_x: z.boolean().default(false),
  invert_y: z.boolean().default(false),
  invert_z: z.boolean().default(false),
  mix_mode: z
    .enum(['REPLACE', 'ADD', 'BEFORE', 'AFTER', 'OFFSET'])
    .default('REPLACE')
    .describe(
      'REPLACE the rotation, ADD Euler angles (OFFSET: legacy alias of ADD), apply the target rotation BEFORE ' +
        '(parent side) or AFTER (child side) the original',
    ),
  euler_order: eulerOrder,
  target_space: space.default('WORLD'),
  owner_space: space.default('WORLD'),
});

const copyLocationSchema = z.object({
  use_x: z.boolean().default(true),
  use_y: z.boolean().default(true),
  use_z: z.boolean().default(true),
  invert_x: z.boolean().default(false),
  invert_y: z.boolean().default(false),
  invert_z: z.boolean().default(false),
  use_offset: z.boolean().default(false).describe("Add the target location to the bone's own location"),
  head_tail: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Bone targets: point along the target bone (0 = head, 1 = tail)'),
  target_space: space.default('WORLD'),
  owner_space: space.default('WORLD'),
});

const dampedTrackSchema = z.object({
  track_axis: z
    .enum(['TRACK_X', 'TRACK_Y', 'TRACK_Z', 'TRACK_NEGATIVE_X', 'TRACK_NEGATIVE_Y', 'TRACK_NEGATIVE_Z'])
    .default('TRACK_Y')
    .describe('Local axis turned to point at the target (TRACK_Y = along the bone)'),
  head_tail: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Bone targets: point along the target bone (0 = head, 1 = tail)'),
});

const limitRotationSchema = z.object({
  use_limit_x: z.boolean().default(false),
  use_limit_y: z.boolean().default(false),
  use_limit_z: z.boolean().default(false),
  min_x: z.number().default(0).describe('Radians'),
  max_x: z.number().default(0).describe('Radians'),
  min_y: z.number().default(0).describe('Radians'),
  max_y: z.number().default(0).describe('Radians'),
  min_z: z.number().default(0).describe('Radians'),
  max_z: z.number().default(0).describe('Radians'),
  euler_order: eulerOrder,
  use_legacy_behavior: z
    .boolean()
    .default(false)
    .describe('Clamp the angles as plain numbers instead of treating them as looping around the circle'),
  use_transform_limit: z
    .boolean()
    .default(false)
    .describe('Accepted for compatibility (no effect on evaluation)'),
  owner_space: space
    .default('LOCAL')
    .describe('Space of the limits; LOCAL (default for bones) limits the rotation relative to the rest pose'),
});

/** Parameter schemas of the constraint types supported on pose bones. */
export const BONE_CONSTRAINT_SCHEMAS = {
  IK: ikSchema,
  COPY_ROTATION: copyRotationSchema,
  COPY_LOCATION: copyLocationSchema,
  DAMPED_TRACK: dampedTrackSchema,
  LIMIT_ROTATION: limitRotationSchema,
} as const;

export type BoneConstraintType = keyof typeof BONE_CONSTRAINT_SCHEMAS;
export type IkParams = z.infer<typeof ikSchema>;

/** Constraint types that can be added to pose bones. */
export const BONE_CONSTRAINT_TYPES = Object.keys(BONE_CONSTRAINT_SCHEMAS) as BoneConstraintType[];

/** Blender's default constraint names. */
export const BONE_CONSTRAINT_LABELS: Record<BoneConstraintType, string> = {
  IK: 'IK',
  COPY_ROTATION: 'Copy Rotation',
  COPY_LOCATION: 'Copy Location',
  DAMPED_TRACK: 'Damped Track',
  LIMIT_ROTATION: 'Limit Rotation',
};

export function isBoneConstraintType(t: string): t is BoneConstraintType {
  return t in BONE_CONSTRAINT_SCHEMAS;
}

/** Validated parameters (defaults filled in) of a bone constraint; throws with a readable message. */
export function parseBoneConstraintParams<T extends BoneConstraintType>(
  type: T,
  params: unknown,
): z.infer<(typeof BONE_CONSTRAINT_SCHEMAS)[T]> {
  const schema = BONE_CONSTRAINT_SCHEMAS[type] as z.ZodObject<any>;
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`).join('; ');
    throw new Error(`invalid ${type} parameters: ${issues}`);
  }
  return res.data as z.infer<(typeof BONE_CONSTRAINT_SCHEMAS)[T]>;
}

/** A resolved constraint target in armature space. */
export interface BoneConstraintTarget {
  matrix: Mat4;
  /** Rest-relative frame of a bone target (LOCAL target space); null for objects. */
  frame: Mat4 | null;
  /** Bone length of bone targets (for head_tail), 0 for objects. */
  length: number;
}

export interface BoneConstraintEnv {
  /** The owner bone's rest frame under its posed parent (parent pose · bone offset); LOCAL space basis. */
  frame: Mat4;
  /** World matrix of the armature object (WORLD space); identity when omitted. */
  armatureMatrix?: Readonly<Mat4>;
  /** Resolves the constraint target (null when unset or unavailable; may throw saying why). */
  target(c: ConstraintData): BoneConstraintTarget | null;
}

/** Converts an armature-space matrix into constraint space `sp` (LOCAL uses `frame` when given). */
function toSpace(m: Mat4, sp: string, frame: Mat4 | null, env: BoneConstraintEnv): Mat4 {
  if (sp === 'LOCAL') return frame ? multiply4(invert4(frame), m) : m;
  if (sp === 'WORLD' && env.armatureMatrix) return multiply4(env.armatureMatrix as Mat4, m);
  return m;
}

/** Inverse of `toSpace` for the owner bone. */
function fromSpace(m: Mat4, sp: string, env: BoneConstraintEnv): Mat4 {
  if (sp === 'LOCAL') return multiply4(env.frame, m);
  if (sp === 'WORLD' && env.armatureMatrix) return multiply4(invert4(env.armatureMatrix), m);
  return m;
}

function targetPoint(t: BoneConstraintTarget, headTail: number): Vec3 {
  const m = t.matrix;
  const d = headTail * t.length;
  return [m[12] + m[4] * d, m[13] + m[5] * d, m[14] + m[6] * d];
}

const TRACK_AXES: Record<string, Vec3> = {
  TRACK_X: [1, 0, 0],
  TRACK_Y: [0, 1, 0],
  TRACK_Z: [0, 0, 1],
  TRACK_NEGATIVE_X: [-1, 0, 0],
  TRACK_NEGATIVE_Y: [0, -1, 0],
  TRACK_NEGATIVE_Z: [0, 0, -1],
};

const TAU = 2 * Math.PI;

/** Wraps an angle to [-π, π). */
function wrapAngle(a: number): number {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/**
 * Clamps an angle to [lo, hi] treating angles as points on a circle (Blender 4.2+): an angle
 * outside the range snaps to the limit that is nearest around the circle.
 */
function clampAngleCircular(a: number, lo: number, hi: number): number {
  if (hi - lo >= TAU) return a;
  // shift the angle into [lo, lo + 2π)
  const t = lo + ((((a - lo) % TAU) + TAU) % TAU);
  if (t <= hi) return t;
  return t - hi <= lo + TAU - t ? hi : lo;
}

/**
 * Applies one (non-IK) bone constraint to the owner's armature-space matrix and returns the
 * constrained matrix (influence and mute are handled by the caller). Throws for unsupported
 * types or missing targets.
 */
export function applyBoneConstraint(c: ConstraintData, owner: Mat4, env: BoneConstraintEnv): Mat4 {
  const type = c.type as ConstraintType;
  switch (type) {
    case 'COPY_ROTATION': {
      const p = parseBoneConstraintParams('COPY_ROTATION', c.params);
      const t = env.target(c);
      if (!t) throw new Error('target not found');
      const own = toSpace(owner, p.owner_space, env.frame, env);
      const tgt = toSpace(t.matrix, p.target_space, t.frame, env);
      const o = decomposeTRS(own);
      const ownRot = rotationPart(own);
      const tgtRot = rotationPart(tgt);
      const allAxes = p.use_x && p.use_y && p.use_z && !p.invert_x && !p.invert_y && !p.invert_z;
      let rot: Mat4;
      if (p.mix_mode === 'REPLACE' && allAxes) rot = tgtRot;
      else {
        const te = eulerFromRotation(tgtRot);
        const oe = eulerFromRotation(ownRot);
        const use = [p.use_x, p.use_y, p.use_z];
        const inv = [p.invert_x, p.invert_y, p.invert_z];
        const filtered = te.map((v, k) => (use[k] ? (inv[k] ? -v : v) : 0)) as Vec3;
        if (p.mix_mode === 'REPLACE')
          rot = rotationFromEuler(oe.map((v, k) => (use[k] ? filtered[k] : v)) as Vec3);
        else if (p.mix_mode === 'ADD' || p.mix_mode === 'OFFSET')
          rot = rotationFromEuler(oe.map((v, k) => v + filtered[k]) as Vec3);
        else if (p.mix_mode === 'BEFORE') rot = multiply4(rotationFromEuler(filtered), ownRot);
        else rot = multiply4(ownRot, rotationFromEuler(filtered));
      }
      const res = composeTRS({ location: o.location, rotation: decomposeTRS(rot).rotation, scale: o.scale });
      return fromSpace(res, p.owner_space, env);
    }
    case 'COPY_LOCATION': {
      const p = parseBoneConstraintParams('COPY_LOCATION', c.params);
      const t = env.target(c);
      if (!t) throw new Error('target not found');
      const own = toSpace(owner, p.owner_space, env.frame, env);
      let tp = targetPoint(t, p.head_tail);
      if (p.target_space === 'LOCAL' && t.frame) {
        const lm = toSpace(t.matrix, 'LOCAL', t.frame, env);
        tp = [lm[12], lm[13], lm[14]];
      } else if (p.target_space === 'WORLD' && env.armatureMatrix) {
        tp = transformPoint3(env.armatureMatrix, tp);
      }
      const use = [p.use_x, p.use_y, p.use_z];
      const inv = [p.invert_x, p.invert_y, p.invert_z];
      const res = own.slice();
      for (let k = 0; k < 3; k++) {
        if (!use[k]) continue;
        const v = inv[k] ? -tp[k] : tp[k];
        res[12 + k] = p.use_offset ? own[12 + k] + v : v;
      }
      return fromSpace(res, p.owner_space, env);
    }
    case 'DAMPED_TRACK': {
      const p = parseBoneConstraintParams('DAMPED_TRACK', c.params);
      const t = env.target(c);
      if (!t) throw new Error('target not found');
      const goal = targetPoint(t, p.head_tail);
      const a = TRACK_AXES[p.track_axis];
      const axis: Vec3 = [
        owner[0] * a[0] + owner[4] * a[1] + owner[8] * a[2],
        owner[1] * a[0] + owner[5] * a[1] + owner[9] * a[2],
        owner[2] * a[0] + owner[6] * a[1] + owner[10] * a[2],
      ];
      const origin: Vec3 = [owner[12], owner[13], owner[14]];
      const dir: Vec3 = [goal[0] - origin[0], goal[1] - origin[1], goal[2] - origin[2]];
      if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-9) return owner;
      return rotateAbout(owner, rotationBetween(axis, dir), origin);
    }
    case 'LIMIT_ROTATION': {
      const p = parseBoneConstraintParams('LIMIT_ROTATION', c.params);
      if (!p.use_limit_x && !p.use_limit_y && !p.use_limit_z) return owner;
      const own = toSpace(owner, p.owner_space, env.frame, env);
      const d = decomposeTRS(own);
      const e = eulerFromRotation(rotationPart(own));
      const lim: [boolean, number, number][] = [
        [p.use_limit_x, p.min_x, p.max_x],
        [p.use_limit_y, p.min_y, p.max_y],
        [p.use_limit_z, p.min_z, p.max_z],
      ];
      let changed = false;
      for (let k = 0; k < 3; k++) {
        const [on, a, b] = lim[k];
        if (!on) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const v = e[k];
        const clamped = p.use_legacy_behavior ? Math.min(Math.max(v, lo), hi) : clampAngleCircular(v, lo, hi);
        if (Math.abs(wrapAngle(clamped - v)) > 1e-12) changed = true;
        e[k] = clamped;
      }
      if (!changed) return owner;
      const res = composeTRS({ location: d.location, rotation: quatFromEuler(e), scale: d.scale });
      return fromSpace(res, p.owner_space, env);
    }
    case 'IK':
      // solved by the IK chain solver
      return owner;
    default:
      throw new Error(`constraint type ${c.type} is not supported on bones`);
  }
}
