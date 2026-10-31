import type { Mat4 } from '../math/types';
import type { ConstraintData } from '../doc/types';
import type { ConstraintContext, ConstraintResult } from './types';

/** Object ids a constraint reads (targets), so evaluation can order and cycle-check them. */
export function constraintTargets(c: ConstraintData): string[] {
  const out: string[] = [];
  if (c.target) out.push(c.target);
  const pole = c.params?.pole_target;
  if (typeof pole === 'string' && pole) out.push(pole);
  return out;
}

/**
 * Applies an object's constraint stack to its world matrix (after parenting and animation).
 * Each constraint blends its result with the incoming matrix by `influence`; muted constraints
 * are skipped. Failing constraints are skipped and reported.
 *
 * Phase-0 stub: returns the matrix unchanged. The constraints workstream implements every
 * ConstraintType (except IK, which pose evaluation handles) here.
 */
export function solveConstraints(
  constraints: readonly ConstraintData[],
  world: Mat4,
  ctx: ConstraintContext,
): ConstraintResult {
  void constraints;
  void ctx;
  return { matrix: world, errors: [] };
}
