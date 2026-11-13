import type { Mat4, Vec3 } from '../math/types';
import { multiply4 } from '../math/mat4';
import { distance3 } from '../math/vec3';
import type { ConstraintData } from '../doc/types';
import type { ConstraintContext, ConstraintResult } from './types';
import { constraintContextFor, type ConstraintEvalSource } from './context';
import { parseConstraintParams, solveConstraints } from './solve';
import { childOfSchema, limitDistanceSchema } from './schemas';
import { childOfInverseMatrix } from './relation';
import { ConstraintSolveError, ownerLocalFrame, resolveTargetMatrix } from './targets';
import { decomposeLocRotSize, invertSafe, matrixToCompatibleEuler, translationOf } from './math';

/*
 * Helpers for operators that bake or initialise constraint results (Apply, Set Inverse, Visual
 * Transform, Limit Distance initialisation). They evaluate through the same context the scene
 * evaluator uses, so the result matches what the viewport shows at that frame.
 */

/**
 * World matrix of object `ownerId` after solving the first `count` constraints of `constraints`
 * (default: all of them) on top of its unconstrained (parented + animated) matrix.
 */
export function solveConstraintPrefix(
  src: ConstraintEvalSource,
  ownerId: string,
  constraints: readonly ConstraintData[],
  count = constraints.length,
): ConstraintResult & { parent: Mat4; context: ConstraintContext } {
  // evaluate the owner through the regular path first, so targets that depend on it are cached in
  // the same state the evaluator sees (dependency cycles resolve identically)
  src.world(ownerId);
  const parent = src.parent(ownerId);
  const context = constraintContextFor(src, ownerId, parent);
  const res = solveConstraints(
    constraints.slice(0, Math.max(0, count)),
    multiply4(parent, src.local(ownerId)),
    context,
  );
  return { ...res, parent, context };
}

/**
 * Inverse matrix "Set Inverse" stores on a Child Of constraint: the inverse of its target matrix
 * (channel filtered by the use_* flags) at the context's frame. Throws ConstraintSolveError when
 * the target is unusable.
 */
export function childOfSetInverse(c: ConstraintData, ctx: ConstraintContext): Mat4 {
  if (c.type !== 'CHILD_OF') throw new ConstraintSolveError(`'${c.name}' is not a Child Of constraint`);
  const p = childOfSchema.parse(c.params ?? {});
  return childOfInverseMatrix(resolveTargetMatrix(ctx, c, 'WORLD', 0), p);
}

/**
 * Current owner-target distance of the Limit Distance constraint at `index` (measured in its
 * owner/target spaces after the constraints before it), used to initialise `distance` = 0.
 */
export function limitDistanceCurrent(
  constraints: readonly ConstraintData[],
  index: number,
  world: Mat4,
  ctx: ConstraintContext,
): number {
  const c = constraints[index];
  if (!c || c.type !== 'LIMIT_DISTANCE') throw new ConstraintSolveError('Not a Limit Distance constraint');
  const parsed = parseConstraintParams(c);
  if (!parsed.ok) throw new ConstraintSolveError(parsed.message);
  const p = limitDistanceSchema.parse(parsed.params);
  const before = solveConstraints(constraints.slice(0, index), world, ctx).matrix;
  const own = p.owner_space === 'LOCAL' ? multiply4(invertSafe(ownerLocalFrame(ctx)), before) : before;
  const target = resolveTargetMatrix(ctx, c, p.target_space, p.head_tail);
  return distance3(translationOf(own), translationOf(target));
}

/**
 * Splits a world matrix into an object's location / rotation_euler / scale relative to its
 * parent's world matrix (Blender's "apply matrix" with compatible eulers: the euler closest to
 * `oldRotation` is chosen; mirroring negates all three scale axes).
 */
export function worldMatrixToTransform(
  world: Mat4,
  parentWorld: Mat4 | null,
  oldRotation: Vec3 = [0, 0, 0],
): { location: Vec3; rotation_euler: Vec3; scale: Vec3 } {
  const local = parentWorld ? multiply4(invertSafe(parentWorld), world) : world;
  const { loc, rot, size } = decomposeLocRotSize(local);
  return { location: loc, rotation_euler: matrixToCompatibleEuler(rot, oldRotation), scale: size };
}
