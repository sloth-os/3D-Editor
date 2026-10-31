import type { Mat4 } from '../math/types';
import { identity4, multiply4 } from '../math/mat4';
import type { ConstraintData, ConstraintType } from '../doc/types';
import type { ConstraintContext, ConstraintError, ConstraintResult } from './types';
import { getConstraintTypeInfo } from './catalogue';
import { blendMatrices, invertSafe, isFiniteMatrix } from './math';
import { ConstraintSolveError, createSolveEnv, ownerLocalFrame, type SolveEnv } from './targets';
import { solveDampedTrack, solveLockedTrack, solveTrackTo } from './track';
import { solveCopyLocation, solveCopyRotation, solveCopyScale, solveCopyTransforms } from './copy';
import { solveLimitDistance, solveLimitLocation, solveLimitRotation, solveLimitScale } from './limit';
import { solveChildOf, solveFloor, solvePivot } from './relation';
import { solveClampTo, solveFollowPath } from './path';

/** Evaluates one constraint type on the owner matrix (already in the constraint's owner space). */
type Solver = (m: Mat4, params: any, env: SolveEnv) => Mat4;

const SOLVERS: Partial<Record<ConstraintType, Solver>> = {
  TRACK_TO: solveTrackTo,
  DAMPED_TRACK: solveDampedTrack,
  LOCKED_TRACK: solveLockedTrack,
  COPY_LOCATION: solveCopyLocation,
  COPY_ROTATION: solveCopyRotation,
  COPY_SCALE: solveCopyScale,
  COPY_TRANSFORMS: solveCopyTransforms,
  LIMIT_LOCATION: solveLimitLocation,
  LIMIT_ROTATION: solveLimitRotation,
  LIMIT_SCALE: solveLimitScale,
  LIMIT_DISTANCE: solveLimitDistance,
  CHILD_OF: solveChildOf,
  FOLLOW_PATH: solveFollowPath,
  CLAMP_TO: solveClampTo,
  FLOOR: solveFloor,
  PIVOT: solvePivot,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Object ids a constraint reads (targets), so evaluation can order and cycle-check them. */
export function constraintTargets(c: ConstraintData): string[] {
  const out: string[] = [];
  if (!isRecord(c)) return out;
  if (typeof c.target === 'string' && c.target) out.push(c.target);
  if (isRecord(c.params)) {
    const keys = getConstraintTypeInfo(c.type)?.objectParams ?? ['pole_target'];
    for (const key of keys) {
      const v = c.params[key];
      if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** Parsed parameters of a constraint, or a readable validation message. */
export function parseConstraintParams(
  c: Pick<ConstraintData, 'type' | 'params'>,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const info = getConstraintTypeInfo(c.type);
  if (!info) return { ok: false, message: `Unknown constraint type '${String(c.type)}'` };
  const params = isRecord(c.params) ? c.params : {};
  // Animating a parameter that is missing from `params` writes it onto the constraint itself (data
  // paths cannot create keys inside the bag): pick such values up.
  const loose: Record<string, unknown> = {};
  const top = c as unknown as Record<string, unknown>;
  for (const key of Object.keys(info.schema.shape)) if (key in top && !(key in params)) loose[key] = top[key];
  const res = info.schema.safeParse({ ...loose, ...params });
  if (res.success) return { ok: true, params: res.data as Record<string, unknown> };
  const issues = res.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`).join('; ');
  return { ok: false, message: `Invalid parameters: ${issues}` };
}

/** Influence of a constraint clamped to 0..1 (missing counts as 1); null when not a finite number. */
function influenceOf(c: Record<string, unknown>): number | null {
  const v = c.influence;
  if (v === undefined) return 1;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/**
 * Applies an object's constraint stack to its world matrix (after parenting and animation).
 * Each constraint is solved in its owner space (WORLD, or LOCAL = relative to the parent) and its
 * result is blended with the incoming matrix by `influence` (location lerp, rotation slerp, scale
 * lerp). Muted constraints, zero influence and pose-bone-only types (IK) are skipped. Constraints
 * that cannot be solved (unknown type, invalid parameters, missing, self or cyclic targets) leave
 * the matrix unchanged and are reported in `errors`; this function never throws.
 */
export function solveConstraints(
  constraints: readonly ConstraintData[],
  world: Mat4,
  ctx: ConstraintContext,
): ConstraintResult {
  const errors: ConstraintError[] = [];
  let m: Mat4 = Array.isArray(world) && world.length === 16 ? world.slice() : identity4();
  if (!Array.isArray(constraints)) return { matrix: m, errors };
  let ownerFrame: { m: Mat4; inv: Mat4 } | null = null;
  const frame = () => {
    if (!ownerFrame) {
      const f = ownerLocalFrame(ctx);
      ownerFrame = { m: f, inv: invertSafe(f) };
    }
    return ownerFrame;
  };
  constraints.forEach((entry: unknown, index) => {
    if (!isRecord(entry)) {
      errors.push({ constraintId: `#${index}`, message: 'Invalid constraint entry (expected an object)' });
      return;
    }
    // stored data may be anything (e.g. written through generic property setters): check it
    const c = entry as unknown as ConstraintData;
    const id = typeof c.id === 'string' && c.id ? c.id : `#${index}`;
    if (c.mute === true) return;
    const info = getConstraintTypeInfo(String(c.type));
    if (!info) {
      errors.push({ constraintId: id, message: `Unknown constraint type '${String(c.type)}'` });
      return;
    }
    const solver = SOLVERS[info.type];
    if (info.boneOnly || !solver) return; // IK: solved by pose evaluation
    const influence = influenceOf(entry);
    if (influence === null) {
      errors.push({ constraintId: id, message: 'influence must be a finite number between 0 and 1' });
      return;
    }
    if (influence === 0) return;
    const parsed = parseConstraintParams(c);
    if (!parsed.ok) {
      errors.push({ constraintId: id, message: parsed.message });
      return;
    }
    try {
      const env = createSolveEnv(ctx, c, info.label);
      const local = parsed.params.owner_space === 'LOCAL' ? frame() : null;
      let out = solver(local ? multiply4(local.inv, m) : m, parsed.params, env);
      if (local) out = multiply4(local.m, out);
      if (!isFiniteMatrix(out))
        throw new ConstraintSolveError('The constraint produced an invalid (non-finite) transform');
      m = influence < 1 ? blendMatrices(m, out, influence) : out;
    } catch (e) {
      errors.push({ constraintId: id, message: e instanceof Error ? e.message : String(e) });
    }
  });
  return { matrix: m, errors };
}
