import type { Mat4 } from '../math/types';
import type { CurveData, ObjectData } from '../doc/types';
import type { CurvePath } from '../curve/path';
import type { ArmaturePose } from '../armature/types';
import type { ConstraintContext, ConstraintObjectInfo } from './types';
import { dependencyGraph, type DependencySource } from './depgraph';

/**
 * The parts of a per-frame scene state that constraint evaluation reads. `eval/FrameState`
 * implements it; operators use the same builder on a fresh FrameState so they see exactly what the
 * evaluator sees.
 */
export interface ConstraintEvalSource extends DependencySource {
  readonly frame: number;
  /** Animated objects by id. */
  readonly byId: ReadonlyMap<string, ObjectData>;
  /** Final world matrix (null when missing or part of a dependency cycle). */
  world(id: string): Mat4 | null;
  /** World matrix of the object's parent (identity when unparented). */
  parent(id: string): Mat4;
  /** Matrix of the object's own animated location / rotation / scale. */
  local(id: string): Mat4;
  pose(id: string): ArmaturePose | null;
  boneMatrix(armatureId: string, bone: string): { matrix: Mat4; length: number } | null;
  curvePath(id: string): { path: CurvePath; matrix: Mat4; curve: CurveData } | null;
}

/** Transform info of an object of `src` (null when it does not exist). */
export function constraintObjectInfo(src: ConstraintEvalSource, id: string): ConstraintObjectInfo | null {
  const o = src.byId.get(id);
  if (!o) return null;
  const parented = !!o.parent && o.parent !== id && src.byId.has(o.parent);
  return {
    name: o.name,
    type: o.type,
    parentMatrix: parented ? src.parent(id) : null,
    basisMatrix: src.local(id),
  };
}

/**
 * Builds the context for solving the constraint stack of object `ownerId`. `parentMatrix` defaults
 * to the owner's evaluated parent matrix; pass it when it is already known (during evaluation).
 * Constraints on dependency cycles are found with the source's dependency graph (`dependencyGraph`).
 */
export function constraintContextFor(
  src: ConstraintEvalSource,
  ownerId: string,
  parentMatrix?: Mat4,
): ConstraintContext {
  return {
    frame: src.frame,
    parentMatrix: parentMatrix ?? src.parent(ownerId),
    ownerId,
    getWorldMatrix: (id) => src.world(id),
    getBoneMatrix: (armature, bone) => src.boneMatrix(armature, bone),
    getCurvePath: (id) => src.curvePath(id),
    getObjectInfo: (id) => constraintObjectInfo(src, id),
    getArmaturePose: (id) => src.pose(id),
    dependencyCycle: (c) => dependencyGraph(src).cycle(ownerId, c),
  };
}
