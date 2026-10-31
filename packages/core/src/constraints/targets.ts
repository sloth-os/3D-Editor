import type { Mat4 } from '../math/types';
import { multiply4 } from '../math/mat4';
import type { ConstraintData, CurveData } from '../doc/types';
import type { CurvePath } from '../curve/path';
import type { ConstraintContext, ConstraintObjectInfo } from './types';
import type { ConstraintSpace } from './schemas';
import { invertSafe, normalizedAxes, transformPoint, withTranslation } from './math';

/** A problem that makes a constraint skip (reported as a ConstraintError). */
export class ConstraintSolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintSolveError';
  }
}

/** What a constraint solver may ask for while it runs. */
export interface SolveEnv {
  readonly ctx: ConstraintContext;
  readonly constraint: ConstraintData;
  /**
   * Target matrix in `space`: the target object's world matrix, or the posed bone of an armature
   * target named by `subtarget` (moved `headTail` along the bone). Throws ConstraintSolveError when
   * the target is unset, missing, the owner itself or part of a dependency cycle.
   */
  target(space: ConstraintSpace, headTail?: number): Mat4;
  /** Whether a target object is set (for constraints whose target is optional). */
  hasTarget(): boolean;
  /** The CURVE target's path and world matrix (Follow Path, Clamp To). Throws like `target`. */
  curveTarget(): { path: CurvePath; matrix: Mat4; curve: CurveData };
}

function targetId(c: ConstraintData): string | null {
  return typeof c.target === 'string' && c.target ? c.target : null;
}

/** Info for messages (undefined when the context cannot provide it). */
function infoOf(ctx: ConstraintContext, id: string): ConstraintObjectInfo | null | undefined {
  return ctx.getObjectInfo ? ctx.getObjectInfo(id) : undefined;
}

const quoted = (info: ConstraintObjectInfo | null | undefined, id: string) => `'${info ? info.name : id}'`;

/** Resolves the target object and its world matrix, or throws a descriptive ConstraintSolveError. */
export function requireTarget(
  ctx: ConstraintContext,
  c: ConstraintData,
): { id: string; world: Mat4; info: ConstraintObjectInfo | undefined } {
  const id = targetId(c);
  if (!id) throw new ConstraintSolveError('No target object set');
  if (ctx.ownerId !== undefined && id === ctx.ownerId)
    throw new ConstraintSolveError('A constraint cannot use its own object as target');
  const info = infoOf(ctx, id);
  if (info === null) throw new ConstraintSolveError(`Target object '${id}' not found`);
  const world = ctx.getWorldMatrix(id);
  if (!world)
    throw new ConstraintSolveError(
      info
        ? `Target ${quoted(info, id)} is part of a dependency cycle`
        : `Target object '${id}' is missing or part of a dependency cycle`,
    );
  return { id, world, info };
}

/**
 * Frame that LOCAL space is relative to for an object: its parent's world matrix, or - for
 * objects without a parent - its own rotation (Blender defines the local space of parentless
 * objects as their unscaled, untranslated basis rotation).
 */
export function objectLocalFrame(info: ConstraintObjectInfo): Mat4 {
  return info.parentMatrix ?? normalizedAxes(info.basisMatrix, false);
}

/** Frame of the owner's LOCAL space. */
export function ownerLocalFrame(ctx: ConstraintContext): Mat4 {
  if (ctx.ownerId !== undefined && ctx.getObjectInfo) {
    const info = ctx.getObjectInfo(ctx.ownerId);
    if (info) return objectLocalFrame(info);
  }
  return ctx.parentMatrix;
}

/** Converts an armature bone matrix (world) into Blender's bone LOCAL space. */
function boneToLocal(
  ctx: ConstraintContext,
  armatureId: string,
  bone: string,
  world: Mat4,
  armature: Mat4,
): Mat4 {
  const pose = ctx.getArmaturePose?.(armatureId);
  const pb = pose?.bones.get(bone);
  if (!pose || !pb)
    throw new ConstraintSolveError(`LOCAL target space of bone '${bone}' needs the evaluated armature pose`);
  const parent = pb.parent ? pose.bones.get(pb.parent) : undefined;
  // the bone's rest frame carried by its posed parent: parent pose · parent rest⁻¹ · rest
  const frame = parent ? multiply4(parent.matrix, multiply4(invertSafe(parent.rest), pb.rest)) : pb.rest;
  return multiply4(invertSafe(multiply4(armature, frame)), world);
}

/** See `SolveEnv.target`. */
export function resolveTargetMatrix(
  ctx: ConstraintContext,
  c: ConstraintData,
  space: ConstraintSpace,
  headTail = 0,
): Mat4 {
  const { id, world, info } = requireTarget(ctx, c);
  const sub = typeof c.subtarget === 'string' ? c.subtarget : '';
  if (!sub) {
    if (space !== 'LOCAL') return world;
    if (!info)
      throw new ConstraintSolveError(
        'LOCAL target space needs object information that this evaluation context does not provide',
      );
    return multiply4(invertSafe(objectLocalFrame(info)), world);
  }
  const bone = ctx.getBoneMatrix(id, sub);
  if (!bone) {
    if (info && info.type !== 'ARMATURE')
      throw new ConstraintSolveError(
        `Sub-target '${sub}' needs an armature target, but ${quoted(info, id)} is a ${info.type} object`,
      );
    throw new ConstraintSolveError(`Bone '${sub}' not found in armature ${quoted(info, id)}`);
  }
  let m = bone.matrix.slice();
  const h = Number.isFinite(headTail) ? Math.min(1, Math.max(0, headTail)) : 0;
  if (h > 0) m = withTranslation(m, transformPoint(bone.matrix, [0, h * bone.length, 0]));
  return space === 'LOCAL' ? boneToLocal(ctx, id, sub, m, world) : m;
}

/** See `SolveEnv.curveTarget`. */
export function resolveCurveTarget(
  ctx: ConstraintContext,
  c: ConstraintData,
  label: string,
): { path: CurvePath; matrix: Mat4; curve: CurveData } {
  const id = targetId(c);
  if (!id) throw new ConstraintSolveError('No target curve set');
  if (ctx.ownerId !== undefined && id === ctx.ownerId)
    throw new ConstraintSolveError('A constraint cannot use its own object as target');
  const res = ctx.getCurvePath(id);
  if (res) return res;
  const info = infoOf(ctx, id);
  if (info === null) throw new ConstraintSolveError(`Target object '${id}' not found`);
  if (info && info.type !== 'CURVE')
    throw new ConstraintSolveError(
      `${label} needs a CURVE target, but ${quoted(info, id)} is a ${info.type} object`,
    );
  if (!ctx.getWorldMatrix(id))
    throw new ConstraintSolveError(
      info
        ? `Target ${quoted(info, id)} is part of a dependency cycle`
        : `Target '${id}' is not a curve, is missing or is part of a dependency cycle`,
    );
  throw new ConstraintSolveError(
    `Curve ${quoted(info, id)} has no usable path (its first spline needs at least two distinct points)`,
  );
}

/** Creates the solver environment of one constraint. */
export function createSolveEnv(ctx: ConstraintContext, c: ConstraintData, label: string): SolveEnv {
  return {
    ctx,
    constraint: c,
    target: (space, headTail = 0) => resolveTargetMatrix(ctx, c, space, headTail),
    hasTarget: () => targetId(c) !== null,
    curveTarget: () => resolveCurveTarget(ctx, c, label),
  };
}
