import type { Mat4 } from '../math/types';
import type { ConstraintData, CurveData, ObjectType } from '../doc/types';
import type { CurvePath } from '../curve/path';
import type { ArmaturePose } from '../armature/types';

/** Transform information about an object, used for LOCAL space conversions and messages. */
export interface ConstraintObjectInfo {
  name: string;
  type: ObjectType;
  /** World matrix of the object's parent (bone tail for bone parenting); null when unparented. */
  parentMatrix: Mat4 | null;
  /** Matrix of the object's own (animated) location / rotation / scale. */
  basisMatrix: Mat4;
}

/** Everything a constraint may read while it is solved. */
export interface ConstraintContext {
  frame: number;
  /**
   * World matrix of the owner's parent (identity when unparented). LOCAL owner space is relative
   * to it. Pose-bone owners pass the bone's parent-and-rest frame (armature world · parent pose ·
   * parent rest⁻¹ · rest) so LOCAL matches Blender's bone local space.
   */
  parentMatrix: Mat4;
  /** Final world matrix of another object (its constraints applied); null if missing or cyclic. */
  getWorldMatrix(id: string): Mat4 | null;
  /** World-space posed matrix of an armature bone (origin at the head, +Y along the bone). */
  getBoneMatrix(armatureObjectId: string, bone: string): { matrix: Mat4; length: number } | null;
  /** Path of a curve object (curve object space) with its world matrix; null if not a curve. */
  getCurvePath(id: string): { path: CurvePath; matrix: Mat4; curve: CurveData } | null;
  /**
   * Optional: id of the object owning the stack. Enables self-target detection and Blender's
   * local space of parentless objects (their own unscaled rotation frame). Omit for pose bones.
   */
  ownerId?: string;
  /**
   * Optional: transform info of an object (null when it does not exist). Needed for LOCAL target
   * space of object targets and for precise "missing" vs "cyclic" error messages.
   */
  getObjectInfo?(id: string): ConstraintObjectInfo | null;
  /** Optional: evaluated pose of an armature object (LOCAL target space of bone sub-targets). */
  getArmaturePose?(armatureObjectId: string): ArmaturePose | null;
  /**
   * Optional: why a constraint of the stack lies on a dependency cycle (its target depends on the
   * owner, e.g. "Target 'B' is part of a dependency cycle: A [Track To] → B [Track To] → A"), or
   * null. Scene evaluation finds cycles with a graph walk over every parent, constraint and pose
   * relation, so every constraint on a cycle is reported and skipped - without reading its target -
   * whatever order objects are evaluated in.
   */
  dependencyCycle?(constraint: ConstraintData): string | null;
}

export interface ConstraintError {
  constraintId: string;
  message: string;
}

export interface ConstraintResult {
  matrix: Mat4;
  errors: ConstraintError[];
}
