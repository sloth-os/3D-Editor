import type { Mat4 } from '../math/types';
import type { CurveData } from '../doc/types';
import type { CurvePath } from '../curve/path';

/** Everything a constraint may read while it is solved. */
export interface ConstraintContext {
  frame: number;
  /** World matrix of the owner's parent (identity when unparented). */
  parentMatrix: Mat4;
  /** Final world matrix of another object (its constraints applied); null if missing or cyclic. */
  getWorldMatrix(id: string): Mat4 | null;
  /** World-space posed matrix of an armature bone (origin at the head, +Y along the bone). */
  getBoneMatrix(armatureObjectId: string, bone: string): { matrix: Mat4; length: number } | null;
  /** Path of a curve object (curve object space) with its world matrix; null if not a curve. */
  getCurvePath(id: string): { path: CurvePath; matrix: Mat4; curve: CurveData } | null;
}

export interface ConstraintError {
  constraintId: string;
  message: string;
}

export interface ConstraintResult {
  matrix: Mat4;
  errors: ConstraintError[];
}
