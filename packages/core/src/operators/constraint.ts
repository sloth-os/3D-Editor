import { z } from 'zod';
import type { ConstraintData, DriverData, FCurve, ObjectData } from '../doc/types';
import type { Vec3 } from '../math/types';
import { fcurveKey } from '../doc/scene-doc';
import { createFCurve, insertKeyframe } from '../anim/fcurve';
import { parseDataPath, type PathSegment } from '../anim/path';
import {
  CONSTRAINT_TYPES,
  childOfSetInverse,
  clampConstraintParams,
  constraintContextFor,
  createConstraint,
  defaultConstraintName,
  describeConstraintTypes,
  getConstraintTypeInfo,
  limitDistanceCurrent,
  resolveConstraintType,
  solveConstraintPrefix,
  worldMatrixToTransform,
  type ConstraintTypeInfo,
} from '../constraints';
import { FrameState } from '../eval/frame-state';
import { buildCurvePath } from '../curve/path';
import { decompose4, multiply4 } from '../math/mat4';
import { newId } from '../util/id';
import { uniqueName } from '../util/names';
import { cloneJson } from '../util/json';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject, resolveObjectIds, selectedObjects } from './helpers';
import { rekeyAnimated } from './anim';

/*
 * Object constraint operators (Blender's object.constraint_add, constraint.*, object.track_set …).
 * Constraints are stored on ObjectData.constraints; every operator rewrites that list in one
 * transaction (one undo step). Constraints are addressed by name or id, objects by id or name.
 */

const objectRef = z
  .string()
  .optional()
  .describe('Object id or exact name owning the constraint (default: the active object)');
const constraintRef = z.string().describe('Constraint name (e.g. "Track To") or id on that object');

const TYPE_LIST = CONSTRAINT_TYPES.filter((t) => !t.boneOnly)
  .map((t) => t.type)
  .join(', ');

/**
 * The constraint list of an object with malformed entries dropped (stored data can be written
 * through generic property setters). Animated and stored lists filter identically, so indices of
 * both stay aligned.
 */
function constraintsOf(o: ObjectData | null | undefined): ConstraintData[] {
  const list: unknown = o?.constraints;
  return Array.isArray(list)
    ? (list.filter((c) => c !== null && typeof c === 'object' && !Array.isArray(c)) as ConstraintData[])
    : [];
}

/** The owner object (by id/name, default active) with a normalised constraint list. */
function ownerObject(ctx: OperatorContext, ref: string | undefined): ObjectData {
  const o = ref ? ctx.doc.resolveObject(ref) : activeObject(ctx);
  if (!o) {
    if (ref) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
    throw new OperatorError('No active object (pass `object`)', 'POLL_FAILED');
  }
  const list = constraintsOf(o);
  const stored: unknown = o.constraints;
  if (!Array.isArray(stored) || list.length !== stored.length)
    ctx.report('WARNING', `Ignoring malformed constraint data on '${o.name}'`);
  o.constraints = list;
  return o;
}

function findConstraint(o: ObjectData, ref: string): number {
  const list = o.constraints;
  let i = list.findIndex((c) => c.id === ref);
  if (i < 0) i = list.findIndex((c) => c.name === ref);
  if (i < 0) {
    const have = list.map((c) => `'${c.name}'`).join(', ') || 'none';
    throw new OperatorError(
      `Constraint '${ref}' not found on '${o.name}' (constraints: ${have})`,
      'NOT_FOUND',
    );
  }
  return i;
}

function resolveType(name: string): ConstraintTypeInfo {
  const info = resolveConstraintType(name);
  if (!info)
    throw new OperatorError(`Unknown constraint type '${name}'. Valid types: ${TYPE_LIST}`, 'INVALID_PARAMS');
  if (info.boneOnly)
    throw new OperatorError(
      `${info.label} constraints only work on pose bones, not on objects. Object constraint types: ${TYPE_LIST}`,
      'INVALID_PARAMS',
    );
  return info;
}

/** Resolves and validates a target reference ('' / null clears it). */
function resolveTarget(
  ctx: OperatorContext,
  owner: ObjectData,
  info: ConstraintTypeInfo,
  ref: string | null | undefined,
): string | null {
  if (ref === undefined || ref === null || ref === '') return null;
  if (info.target === 'NONE')
    throw new OperatorError(`${info.label} constraints do not use a target`, 'INVALID_PARAMS');
  const t = ctx.doc.resolveObject(ref);
  if (!t) throw new OperatorError(`Target object '${ref}' not found`, 'NOT_FOUND');
  if (t.id === owner.id)
    throw new OperatorError(`'${owner.name}' cannot be the target of its own constraint`, 'INVALID_PARAMS');
  if (info.targetObjectType && t.type !== info.targetObjectType)
    throw new OperatorError(
      `${info.label} needs a ${info.targetObjectType} target, but '${t.name}' is a ${t.type} object`,
      'INVALID_PARAMS',
    );
  return t.id;
}

/** Validates a bone sub-target against the target armature's bones ('' = none). */
function resolveSubtarget(
  ctx: OperatorContext,
  info: ConstraintTypeInfo,
  targetId: string | null,
  sub: string | undefined,
): string {
  if (!sub) return '';
  if (!info.boneSubtarget)
    throw new OperatorError(`${info.label} constraints do not support a sub-target`, 'INVALID_PARAMS');
  const t = targetId ? ctx.doc.getObject(targetId) : null;
  if (!t) throw new OperatorError('A sub-target (bone) needs a target armature', 'INVALID_PARAMS');
  if (t.type !== 'ARMATURE' || !t.data)
    throw new OperatorError(
      `Sub-target '${sub}' needs an armature target, but '${t.name}' is a ${t.type} object`,
      'INVALID_PARAMS',
    );
  const bones = ctx.doc.getArmature(t.data)?.bones ?? [];
  if (!bones.some((b) => b.name === sub)) {
    const names = bones.slice(0, 30).map((b) => `'${b.name}'`);
    throw new OperatorError(
      `Bone '${sub}' not found in armature '${t.name}' (bones: ${names.join(', ') || 'none'})`,
      'NOT_FOUND',
    );
  }
  return sub;
}

/**
 * Merges a partial parameter patch into `current` and validates it with the type's schema. Stored
 * numbers outside their range are clamped (as evaluation does); values in `patch` must be valid.
 */
function validateParams(
  info: ConstraintTypeInfo,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(info.schema.shape);
  const unknown = Object.keys(patch).filter((k) => !keys.includes(k));
  if (unknown.length)
    throw new OperatorError(
      `Unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} for ${info.type} ` +
        `constraint. Valid parameters: ${keys.join(', ')}`,
      'INVALID_PARAMS',
    );
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clampConstraintParams(info.type, current))) if (keys.includes(k)) merged[k] = v;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
  const res = info.schema.safeParse(merged);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new OperatorError(`Invalid ${info.type} parameters: ${msg}`, 'INVALID_PARAMS');
  }
  return cloneJson(res.data as Record<string, unknown>);
}

function uniqueConstraintName(o: ObjectData, base: string, except = -1): string {
  return uniqueName(
    base,
    new Set(
      constraintsOf(o)
        .filter((_, i) => i !== except)
        .map((c) => String(c.name)),
    ),
  );
}

function writeConstraints(ctx: OperatorContext, id: string, constraints: ConstraintData[]): void {
  ctx.doc.updateObject(id, { constraints });
}

// ---------------------------------------------------------------- animation paths of constraints

/** Serialises data path segments back into Blender path syntax. */
function formatPath(segs: PathSegment[]): string {
  return segs
    .map((s, i) =>
      s.kind === 'prop'
        ? `${i ? '.' : ''}${s.name}`
        : s.kind === 'index'
          ? `[${s.index}]`
          : `["${s.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
    )
    .join('');
}

/** If `path` addresses constraint `name` (`constraints["name"]…`), returns the remaining segments. */
function constraintPathRest(path: string, name: string): PathSegment[] | null {
  let segs: PathSegment[];
  try {
    segs = parseDataPath(path);
  } catch {
    return null;
  }
  const [a, b] = segs;
  if (a?.kind !== 'prop' || a.name !== 'constraints' || b?.kind !== 'key' || b.key !== name) return null;
  return segs.slice(2);
}

/**
 * Renames (newName) or removes (null) the animation curves and drivers of object `ownerId` that
 * address constraint `name`, so animation follows renamed constraints like in Blender.
 */
function retargetConstraintAnimation(
  ctx: OperatorContext,
  ownerId: string,
  name: string,
  newName: string | null,
) {
  const rename = (path: string): string | null | undefined => {
    const rest = constraintPathRest(path, name);
    if (!rest) return undefined; // not ours
    if (newName === null) return null;
    return formatPath([{ kind: 'prop', name: 'constraints' }, { kind: 'key', key: newName }, ...rest]);
  };
  for (const fc of ctx.doc.listFCurves(ownerId)) {
    if (fc.target_type !== 'object') continue;
    const next = rename(fc.path);
    if (next === undefined) continue;
    ctx.doc.removeFCurve(fcurveKey(fc));
    if (next !== null) ctx.doc.setFCurve({ ...fc, path: next });
  }
  for (const d of ctx.doc.listDrivers()) {
    let changed = false;
    let out: DriverData | null = { ...d, variables: (d.variables ?? []).map((v) => ({ ...v })) };
    if (d.target_type === 'object' && d.target_id === ownerId) {
      const next = rename(d.path);
      if (next === null) out = null;
      else if (next !== undefined) {
        out.path = next;
        changed = true;
      }
    }
    if (out && newName !== null)
      for (const v of out.variables) {
        if (v.target_type !== 'object' || v.target_id !== ownerId) continue;
        const next = rename(v.path);
        if (next) {
          v.path = next;
          changed = true;
        }
      }
    if (!out) ctx.doc.removeDriver(fcurveKey(d));
    else if (changed) {
      ctx.doc.removeDriver(fcurveKey(d));
      ctx.doc.setDriver(out);
    }
  }
}

// ---------------------------------------------------------------- evaluation helpers

/**
 * Evaluation errors of constraint `id` of object `ownerId` at the current frame. Constraints on a
 * dependency cycle are found by a graph walk over the whole scene, so the result does not depend on
 * which object is evaluated first and matches what the scene evaluator reports.
 */
function constraintErrors(
  ctx: OperatorContext,
  ownerId: string,
  id: string,
  fs = new FrameState(ctx.doc, ctx.state.frame),
): string[] {
  fs.world(ownerId);
  return (fs.constraintErrors.get(ownerId) ?? []).filter((e) => e.constraintId === id).map((e) => e.message);
}

/**
 * Performs what Blender does on the first evaluation after a target is assigned: Child Of
 * computes its inverse ("Set Inverse") when `set_inverse_pending`, Limit Distance adopts the
 * current distance when `distance` is 0, and curves used as paths get `use_path`. Problems are
 * reported as warnings (the constraint itself reports them while evaluating).
 */
function settleConstraint(ctx: OperatorContext, ownerId: string, constraintId: string): void {
  const owner = ctx.doc.getObject(ownerId);
  const stored = constraintsOf(owner);
  const index = stored.findIndex((c) => c.id === constraintId);
  if (!owner || index < 0) return;
  const c = stored[index];
  if (!c.target) return;
  if (c.type === 'FOLLOW_PATH' || c.type === 'CLAMP_TO') {
    const curveObj = ctx.doc.getObject(c.target);
    const curve = curveObj?.data ? ctx.doc.getCurve(curveObj.data) : null;
    if (curveObj?.data && curve && !curve.use_path) ctx.doc.updateCurve(curveObj.data, { use_path: true });
    return;
  }
  const current: Record<string, unknown> = c.params && typeof c.params === 'object' ? c.params : {};
  const pendingInverse = c.type === 'CHILD_OF' && current.set_inverse_pending !== false;
  const initDistance = c.type === 'LIMIT_DISTANCE' && !(Number(current.distance) > 0);
  if (!pendingInverse && !initDistance) return;
  const fs = new FrameState(ctx.doc, ctx.state.frame);
  const constraints = constraintsOf(fs.byId.get(ownerId));
  const prefix = solveConstraintPrefix(fs, ownerId, constraints, 0);
  const params = { ...current };
  try {
    if (pendingInverse) {
      params.inverse_matrix = childOfSetInverse(c, prefix.context);
      params.set_inverse_pending = false;
    } else {
      params.distance = limitDistanceCurrent(constraints, index, prefix.matrix, prefix.context);
    }
  } catch (e) {
    ctx.report('WARNING', `${c.name}: ${(e as Error).message}`);
    return;
  }
  const list = stored.slice();
  list[index] = { ...c, params };
  writeConstraints(ctx, ownerId, list);
}

const transformChannels = ['location', 'rotation_euler', 'scale'];

/**
 * Writes a world matrix into an object's loc/rot/scale (relative to its evaluated parent) and
 * re-keys animated channels. Eulers are chosen closest to `compat`, the object's animated rotation
 * at the current frame (Blender's compatible eulers), so baking an animated object keeps its
 * rotation curves continuous (e.g. a wheel keyed past 180° is not flipped back by a multiple of 2π).
 */
function applyWorldMatrix(
  ctx: OperatorContext,
  o: ObjectData,
  world: number[],
  parent: number[],
  compat: Vec3,
) {
  const t = worldMatrixToTransform(world, o.parent ? parent : null, compat);
  ctx.doc.updateObject(o.id, t);
  rekeyAnimated(ctx, 'object', o.id, transformChannels);
  return t;
}

/** Animated rotation of an object at the frame of `fs` (stored rotation when not evaluated). */
function animatedRotation(fs: FrameState, o: ObjectData): Vec3 {
  const r = fs.byId.get(o.id)?.rotation_euler;
  return Array.isArray(r) && r.length === 3 && r.every(Number.isFinite) ? r : o.rotation_euler;
}

export function registerConstraintOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'constraint.type_list',
      label: 'List Constraint Types',
      description:
        'Read-only: list the constraint types with label, category, description, whether they need a target ' +
        '(REQUIRED/OPTIONAL/NONE, CURVE-only targets, bone sub-targets), their default `params` and the JSON schema of ' +
        'the parameters (names, enums, ranges, descriptions). Use it before object.constraint_add / ' +
        'constraint.update. IK is listed with bone_only = true (pose bones only).',
      category: 'Object',
      undo: false,
      schema: z.object({
        type: z
          .string()
          .optional()
          .describe('Only this type (id like "TRACK_TO" or label; default: all types)'),
      }),
      execute(_ctx, p) {
        const info = p.type ? resolveConstraintType(p.type) : undefined;
        if (p.type && !info)
          throw new OperatorError(
            `Unknown constraint type '${p.type}'. Valid types: ${TYPE_LIST}`,
            'INVALID_PARAMS',
          );
        const types = describeConstraintTypes()
          .filter((t) => !info || t.type === info.type)
          .map(({ boneOnly, boneSubtarget, targetObjectType, objectParams, ...t }) => ({
            ...t,
            target_object_type: targetObjectType,
            bone_subtarget: boneSubtarget,
            bone_only: boneOnly,
            object_params: objectParams,
          }));
        return { types };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.describe',
      label: 'Describe Constraints',
      description:
        "Read-only: an object's constraint stack in evaluation order (id, name, type, target and sub-target with " +
        'the target name, influence, mute, params) with the current evaluation error of each constraint (missing ' +
        'target, invalid parameters, dependency cycle …; identical to what scene evaluation reports), and the ' +
        "object's evaluated world location / rotation_euler (radians) / scale at the current (or given) frame. Use " +
        'it to verify that constraints do what was intended.',
      category: 'Object',
      undo: false,
      schema: z.object({
        object: objectRef,
        frame: z.number().optional().describe('Frame to evaluate (default: the current frame)'),
      }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const fs = new FrameState(ctx.doc, p.frame ?? ctx.state.frame);
        const world = fs.world(owner.id) ?? ctx.doc.worldMatrix(owner.id);
        const errors = fs.constraintErrors.get(owner.id) ?? [];
        const d = decompose4(world);
        const round = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);
        return {
          object: owner.id,
          name: owner.name,
          world_location: round(d.location),
          world_rotation_euler: round(d.rotation),
          world_scale: round(d.scale),
          constraints: owner.constraints.map((c, i) => ({
            index: i,
            id: c.id,
            name: c.name,
            type: c.type,
            target: c.target,
            target_name: c.target ? (ctx.doc.getObject(c.target)?.name ?? null) : null,
            subtarget: c.subtarget,
            influence: c.influence,
            mute: c.mute,
            params: c.params,
            error: errors.find((e) => e.constraintId === c.id || e.constraintId === `#${i}`)?.message ?? null,
          })),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.constraint_add',
      label: 'Add Constraint',
      description:
        "Add a constraint to the end of an object's constraint stack (default: active object). `type` is a Blender " +
        `constraint type (${TYPE_LIST}); "Track To" style labels also work. \`target\` is the object it reads ` +
        '(id or name; FOLLOW_PATH and CLAMP_TO need a CURVE object), `subtarget` a bone name when the target is an ' +
        'armature. Optional `params` (Blender names) are validated per type. Like Blender, a Child Of constraint ' +
        'sets its inverse when it gets a target (the owner does not jump) and Limit Distance with distance 0 adopts ' +
        'the current distance. Returns the constraint id, its unique name ("Track To", "Track To.001"…), its index ' +
        'and `errors` = current evaluation problems, e.g. a missing target or a dependency cycle (the target ' +
        'depends on the owner through parenting or other constraints: every constraint on the cycle is skipped ' +
        'and reports the objects of the loop).',
      category: 'Object',
      redoable: true,
      schema: z.object({
        type: z.string().describe(`Constraint type: ${TYPE_LIST}`),
        object: objectRef,
        target: z
          .string()
          .optional()
          .describe('Target object id or exact name (needed by every type except LIMIT_* and PIVOT)'),
        subtarget: z
          .string()
          .optional()
          .describe('Bone name of an armature target ("" = the armature object)'),
        name: z
          .string()
          .optional()
          .describe('Constraint name, made unique on the object (default: type label)'),
        influence: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe('Blend 0..1 between the unconstrained and the fully constrained transform'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Initial type-specific parameters (Blender names, e.g. {"track_axis": "TRACK_NEGATIVE_Z"})',
          ),
      }),
      execute(ctx, p) {
        const info = resolveType(p.type);
        const owner = ownerObject(ctx, p.object);
        const target = resolveTarget(ctx, owner, info, p.target);
        const subtarget = resolveSubtarget(ctx, info, target, p.subtarget);
        const params = validateParams(info, info.schema.parse({}) as Record<string, unknown>, p.params ?? {});
        const c = createConstraint(info.type, {
          id: newId(),
          name: uniqueConstraintName(owner, p.name?.trim() || defaultConstraintName(info.type)),
          influence: p.influence,
          target,
          subtarget,
          params,
        });
        const list = [...owner.constraints, c];
        writeConstraints(ctx, owner.id, list);
        settleConstraint(ctx, owner.id, c.id);
        const errors = constraintErrors(ctx, owner.id, c.id);
        for (const e of errors) ctx.report('WARNING', `${c.name}: ${e}`);
        if (
          (owner.type === 'CAMERA' || owner.type === 'LIGHT') &&
          (info.type === 'DAMPED_TRACK' || info.type === 'LOCKED_TRACK') &&
          params.track_axis !== 'TRACK_NEGATIVE_Z'
        )
          ctx.report(
            'INFO',
            `${c.name}: ${owner.type === 'CAMERA' ? 'cameras' : 'lights'} look along their -Z axis but track_axis is ` +
              `${String(params.track_axis)}; use params.track_axis = "TRACK_NEGATIVE_Z" to aim it at the target`,
          );
        return {
          constraint: c.id,
          name: c.name,
          type: c.type,
          object: owner.id,
          index: list.length - 1,
          target,
          errors,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.update',
      label: 'Set Constraint Properties',
      description:
        'Change a constraint: `params` is a partial set of type-specific parameters (merged with the current values ' +
        'and validated; unknown keys are rejected with the list of valid ones), plus optional influence (0..1), mute, ' +
        'target (id or name; "" or null clears it), subtarget (bone name), name (renaming also updates animation ' +
        'paths) and show_expanded. Setting params.set_inverse_pending = true on a Child Of recomputes its inverse; ' +
        'params.distance = 0 on Limit Distance re-adopts the current distance. Returns the updated constraint and ' +
        'its current evaluation `errors` (e.g. a missing target or a dependency cycle).',
      category: 'Object',
      redoable: true,
      schema: z.object({
        constraint: constraintRef,
        object: objectRef,
        params: z.record(z.string(), z.unknown()).optional().describe('Parameters to change (Blender names)'),
        influence: z.number().min(0).max(1).optional().describe('Blend factor 0..1'),
        mute: z.boolean().optional().describe('true disables the constraint'),
        target: z
          .string()
          .nullable()
          .optional()
          .describe('New target object id or name; "" or null clears it'),
        subtarget: z.string().optional().describe('Bone name of an armature target ("" = none)'),
        name: z.string().optional().describe('New name (made unique on the object)'),
        show_expanded: z.boolean().optional().describe('UI panel expanded state'),
      }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const index = findConstraint(owner, p.constraint);
        const cur = owner.constraints[index];
        const info = getConstraintTypeInfo(cur.type);
        if (!info) throw new OperatorError(`Constraint '${cur.name}' has unknown type ${cur.type}`, 'FAILED');
        const next: ConstraintData = { ...cloneJson(cur) };
        if (p.params && Object.keys(p.params).length)
          next.params = validateParams(info, cur.params ?? {}, p.params);
        if (p.influence !== undefined) next.influence = p.influence;
        if (p.mute !== undefined) next.mute = p.mute;
        if (p.show_expanded !== undefined) next.show_expanded = p.show_expanded;
        const targetChanged = p.target !== undefined;
        if (targetChanged) next.target = resolveTarget(ctx, owner, info, p.target);
        if (p.subtarget !== undefined) next.subtarget = resolveSubtarget(ctx, info, next.target, p.subtarget);
        else if (targetChanged && next.subtarget) {
          // keep the bone only while the new target still has it
          try {
            next.subtarget = resolveSubtarget(ctx, info, next.target, next.subtarget);
          } catch {
            next.subtarget = '';
          }
        }
        if (p.name !== undefined && p.name.trim())
          next.name = uniqueConstraintName(owner, p.name.trim(), index);
        const list = owner.constraints.slice();
        list[index] = next;
        writeConstraints(ctx, owner.id, list);
        if (next.name !== cur.name) retargetConstraintAnimation(ctx, owner.id, cur.name, next.name);
        settleConstraint(ctx, owner.id, next.id);
        const final = constraintsOf(ctx.doc.getObject(owner.id))[index];
        return {
          constraint: final.id,
          name: final.name,
          type: final.type,
          target: final.target,
          subtarget: final.subtarget,
          influence: final.influence,
          mute: final.mute,
          params: final.params,
          errors: constraintErrors(ctx, owner.id, final.id),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.delete',
      label: 'Delete Constraint',
      description:
        'Remove a constraint (name or id) from an object (default: active object), together with the animation ' +
        'curves and drivers of its properties. The object returns to its unconstrained transform for that constraint.',
      category: 'Object',
      schema: z.object({ constraint: constraintRef, object: objectRef }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const index = findConstraint(owner, p.constraint);
        const removed = owner.constraints[index];
        writeConstraints(
          ctx,
          owner.id,
          owner.constraints.filter((_, i) => i !== index),
        );
        retargetConstraintAnimation(ctx, owner.id, removed.name, null);
        return { removed: removed.id, name: removed.name, object: owner.id };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.move_to_index',
      label: 'Move Constraint to Index',
      description:
        'Move a constraint to a position in the stack (0 = first, evaluated first; clamped to the stack size). ' +
        'Returns the new index.',
      category: 'Object',
      schema: z.object({
        constraint: constraintRef,
        index: z.number().int().min(0).describe('New position, 0 = top of the stack'),
        object: objectRef,
      }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const from = findConstraint(owner, p.constraint);
        const to = Math.min(owner.constraints.length - 1, p.index);
        if (to === from) {
          ctx.report('INFO', `Constraint '${owner.constraints[from].name}' is already at position ${from}`);
          return { constraint: owner.constraints[from].id, index: from };
        }
        const list = owner.constraints.slice();
        const [c] = list.splice(from, 1);
        list.splice(to, 0, c);
        writeConstraints(ctx, owner.id, list);
        return { constraint: c.id, name: c.name, index: to };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.apply',
      label: 'Apply Constraint',
      description:
        "Bake the visual result of the constraint stack up to and including the given constraint into the object's " +
        'location / rotation_euler / scale (relative to its parent) at the current frame, then remove that ' +
        'constraint. Fails (changing nothing) when the constraint cannot be evaluated, e.g. without a target. ' +
        'Constraints above it stay and still apply (a warning is reported, as in Blender). Returns the new transform.',
      category: 'Object',
      schema: z.object({ constraint: constraintRef, object: objectRef }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const index = findConstraint(owner, p.constraint);
        const c = owner.constraints[index];
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const animated = constraintsOf(fs.byId.get(owner.id));
        const res = solveConstraintPrefix(fs, owner.id, animated, index + 1);
        const own = res.errors.filter((e) => e.constraintId === c.id);
        if (own.length)
          throw new OperatorError(
            `Cannot apply constraint '${c.name}': ${own.map((e) => e.message).join('; ')}`,
          );
        const earlier = owner.constraints.slice(0, index).some((x) => !x.mute);
        const t = applyWorldMatrix(ctx, owner, res.matrix, res.parent, animatedRotation(fs, owner));
        writeConstraints(
          ctx,
          owner.id,
          owner.constraints.filter((_, i) => i !== index),
        );
        retargetConstraintAnimation(ctx, owner.id, c.name, null);
        if (earlier) ctx.report('WARNING', 'Applied constraint was not first, result may not be as expected');
        else ctx.report('INFO', `Applied constraint: ${c.name}`);
        return { object: owner.id, applied: c.name, ...t };
      },
    }),
  );

  const childOf = (ctx: OperatorContext, objectRefValue: string | undefined, ref: string) => {
    const owner = ownerObject(ctx, objectRefValue);
    const index = findConstraint(owner, ref);
    const c = owner.constraints[index];
    if (c.type !== 'CHILD_OF')
      throw new OperatorError(`'${c.name}' is a ${c.type} constraint, not CHILD_OF`, 'INVALID_PARAMS');
    return { owner, index, c };
  };

  reg.register(
    defineOperator({
      id: 'constraint.childof_set_inverse',
      label: 'Set Inverse',
      description:
        "Set the inverse correction of a Child Of constraint from the target's current transform (current frame), " +
        'so the owner keeps its present place while following the target from now on. Returns inverse_matrix ' +
        '(column-major 4x4).',
      category: 'Object',
      schema: z.object({ constraint: constraintRef, object: objectRef }),
      execute(ctx, p) {
        const { owner, index, c } = childOf(ctx, p.object, p.constraint);
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        fs.world(owner.id);
        let inverse: number[];
        try {
          inverse = childOfSetInverse(c, constraintContextFor(fs, owner.id));
        } catch (e) {
          throw new OperatorError(`Cannot set inverse of '${c.name}': ${(e as Error).message}`);
        }
        const list = owner.constraints.slice();
        list[index] = { ...c, params: { ...c.params, inverse_matrix: inverse, set_inverse_pending: false } };
        writeConstraints(ctx, owner.id, list);
        return { constraint: c.id, name: c.name, inverse_matrix: inverse };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.childof_clear_inverse',
      label: 'Clear Inverse',
      description:
        'Reset the inverse correction of a Child Of constraint to identity: the owner is then placed in the ' +
        "target's space as if parented without correction (it usually jumps).",
      category: 'Object',
      schema: z.object({ constraint: constraintRef, object: objectRef }),
      execute(ctx, p) {
        const { owner, index, c } = childOf(ctx, p.object, p.constraint);
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const list = owner.constraints.slice();
        list[index] = { ...c, params: { ...c.params, inverse_matrix: identity, set_inverse_pending: false } };
        writeConstraints(ctx, owner.id, list);
        return { constraint: c.id, name: c.name };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.limitdistance_reset',
      label: 'Reset Distance',
      description:
        'Set the distance of a Limit Distance constraint to the current distance between owner and target ' +
        '(current frame). Returns the new distance in metres.',
      category: 'Object',
      schema: z.object({ constraint: constraintRef, object: objectRef }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const index = findConstraint(owner, p.constraint);
        const c = owner.constraints[index];
        if (c.type !== 'LIMIT_DISTANCE')
          throw new OperatorError(
            `'${c.name}' is a ${c.type} constraint, not LIMIT_DISTANCE`,
            'INVALID_PARAMS',
          );
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const constraints = constraintsOf(fs.byId.get(owner.id));
        const prefix = solveConstraintPrefix(fs, owner.id, constraints, 0);
        let distance: number;
        try {
          distance = limitDistanceCurrent(constraints, index, prefix.matrix, prefix.context);
        } catch (e) {
          throw new OperatorError(`Cannot reset distance of '${c.name}': ${(e as Error).message}`);
        }
        const list = owner.constraints.slice();
        list[index] = { ...c, params: { ...c.params, distance } };
        writeConstraints(ctx, owner.id, list);
        return { constraint: c.id, name: c.name, distance };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'constraint.followpath_path_animate',
      label: 'Animate Path',
      description:
        'Animate a Follow Path constraint so its owner travels the whole path in `length` frames. Normally keyframes ' +
        "the target curve's eval_time from 0 at frame_start to the curve's path_duration at frame_start + length " +
        '(linear); closed (cyclic) paths keep looping afterwards, open paths stop at the end. That timing is shared ' +
        'by every object following the curve; an existing eval_time animation is replaced. When the constraint has ' +
        "use_fixed_location on (its position comes from offset_factor, not eval_time) or has no target, the constraint's " +
        'own offset_factor is keyed 0 → 1 instead (repeating on closed paths); without a target use_fixed_location ' +
        'is switched on. Returns the animated property (target_type, target_id, path), frame and value range and the ' +
        'extrapolation.',
      category: 'Animation',
      schema: z.object({
        constraint: constraintRef,
        object: objectRef,
        frame_start: z.number().int().default(1).describe('First frame of the path animation'),
        length: z
          .number()
          .int()
          .min(1)
          .max(1048574)
          .optional()
          .describe(
            "Frames one pass along the path takes (default: the curve's path_duration, so eval_time advances one " +
              'unit per frame; 100 without a target curve)',
          ),
      }),
      execute(ctx, p) {
        const owner = ownerObject(ctx, p.object);
        const index = findConstraint(owner, p.constraint);
        const c = owner.constraints[index];
        if (c.type !== 'FOLLOW_PATH')
          throw new OperatorError(`'${c.name}' is a ${c.type} constraint, not FOLLOW_PATH`, 'INVALID_PARAMS');
        const curveObj = c.target ? ctx.doc.getObject(c.target) : null;
        const curve = curveObj?.type === 'CURVE' && curveObj.data ? ctx.doc.getCurve(curveObj.data) : null;
        if (c.target && !curve) throw new OperatorError(`Target of '${c.name}' is not a curve object`, 'FAILED');
        // closed exactly when the evaluated path is (e.g. a cyclic Bezier loop of only two points)
        const cyclic = !!curve && !!buildCurvePath(curve)?.cyclic;
        const duration =
          curve && Number.isFinite(curve.path_duration) && curve.path_duration >= 1 ? curve.path_duration : 100;
        const fixed = c.params?.use_fixed_location === true;
        let fc: FCurve;
        let end: number;
        let length: number;
        if (curveObj && curve && !fixed) {
          end = duration;
          length = p.length ?? Math.max(1, Math.round(end));
          const key = fcurveKey({
            target_type: 'curve',
            target_id: curveObj.data!,
            path: 'eval_time',
            index: 0,
          });
          if (ctx.doc.getFCurve(key))
            ctx.report('INFO', `Replaced the existing eval_time animation of '${curve.name}'`);
          fc = createFCurve({ target_type: 'curve', target_id: curveObj.data!, path: 'eval_time', index: 0 });
          fc.extrapolation = cyclic ? 'LINEAR' : 'CONSTANT';
        } else {
          // the position comes from offset_factor: animate it (the curve's eval_time would have no effect)
          length = p.length ?? (curve ? Math.max(1, Math.round(duration)) : 100);
          end = 1;
          const path = formatPath([
            { kind: 'prop', name: 'constraints' },
            { kind: 'key', key: c.name },
            { kind: 'prop', name: 'offset_factor' },
          ]);
          fc = createFCurve({ target_type: 'object', target_id: owner.id, path, index: 0 });
          fc.extrapolation = cyclic ? 'CYCLIC' : 'CONSTANT';
          if (curve)
            ctx.report(
              'INFO',
              `'${c.name}' uses a fixed location: animated its offset_factor instead of the eval_time of '${curve.name}'`,
            );
          if (!fixed) {
            const list = owner.constraints.slice();
            list[index] = { ...c, params: { ...c.params, use_fixed_location: true } };
            writeConstraints(ctx, owner.id, list);
          }
        }
        fc = insertKeyframe(fc, p.frame_start, 0, 'LINEAR');
        fc = insertKeyframe(fc, p.frame_start + length, end, 'LINEAR');
        ctx.doc.setFCurve(fc);
        return {
          target_type: fc.target_type,
          target_id: fc.target_id,
          path: fc.path,
          frame_start: p.frame_start,
          frame_end: p.frame_start + length,
          value_start: 0,
          value_end: end,
          extrapolation: fc.extrapolation,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.constraints_clear',
      label: 'Clear Object Constraints',
      description:
        'Remove all constraints (and their animation) from the given objects (ids or names; default: the selected ' +
        'objects). Returns how many constraints were removed.',
      category: 'Object',
      schema: z.object({
        objects: z.array(z.string()).optional().describe('Object ids or names (default: selected objects)'),
      }),
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects);
        if (!ids.length) throw new OperatorError('No objects selected (pass `objects`)', 'POLL_FAILED');
        let cleared = 0;
        for (const id of ids) {
          const o = ctx.doc.getObject(id)!;
          const list = constraintsOf(o);
          const stored: unknown = o.constraints;
          if (!list.length && Array.isArray(stored) && !stored.length) continue;
          cleared += list.length;
          writeConstraints(ctx, id, []);
          for (const c of list) retargetConstraintAnimation(ctx, id, String(c.name), null);
        }
        return { cleared, objects: ids };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.track_set',
      label: 'Make Track',
      description:
        'Make objects track a target (Blender Object > Track): adds an "AutoTrack" constraint of `type` TRACKTO ' +
        '(Track To: -Z at the target, Y up), DAMPTRACK (Damped Track: +Y, -Z for cameras/lights) or LOCKTRACK ' +
        '(Locked Track: +Y locked on Z; cameras/lights -Z locked on Y) to every object in `objects` (default: the ' +
        'selected objects) pointing at `target` (default: the active object, which is skipped). Returns the added ' +
        'constraints with their current evaluation `errors` (e.g. a dependency cycle when an object would track ' +
        'its own child).',
      category: 'Object',
      schema: z.object({
        type: z
          .enum(['TRACKTO', 'DAMPTRACK', 'LOCKTRACK'])
          .default('TRACKTO')
          .describe('Kind of tracking constraint'),
        target: z.string().optional().describe('Object to track (id or name; default: the active object)'),
        objects: z
          .array(z.string())
          .optional()
          .describe('Objects that get the constraint (ids or names; default: the selected objects)'),
      }),
      execute(ctx, p) {
        const target = p.target ? ctx.doc.resolveObject(p.target) : activeObject(ctx);
        if (!target)
          throw new OperatorError(
            p.target ? `Target object '${p.target}' not found` : 'No active object to track (pass `target`)',
            p.target ? 'NOT_FOUND' : 'POLL_FAILED',
          );
        const owners = (
          p.objects ? resolveObjectIds(ctx, p.objects) : selectedObjects(ctx).map((o) => o.id)
        ).filter((id) => id !== target.id);
        if (!owners.length)
          throw new OperatorError(
            'No objects to add tracking to (select them or pass `objects`)',
            'POLL_FAILED',
          );
        const type =
          p.type === 'TRACKTO' ? 'TRACK_TO' : p.type === 'DAMPTRACK' ? 'DAMPED_TRACK' : 'LOCKED_TRACK';
        const added: { object: string; constraint: string; name: string }[] = [];
        for (const id of [...new Set(owners)]) {
          const o = ctx.doc.getObject(id)!;
          const aims = o.type === 'CAMERA' || o.type === 'LIGHT';
          const params: Record<string, unknown> = {};
          if (aims && type === 'DAMPED_TRACK') params.track_axis = 'TRACK_NEGATIVE_Z';
          if (aims && type === 'LOCKED_TRACK')
            Object.assign(params, { track_axis: 'TRACK_NEGATIVE_Z', lock_axis: 'LOCK_Y' });
          const c = createConstraint(type, {
            name: uniqueConstraintName(o, 'AutoTrack'),
            target: target.id,
            params,
          });
          writeConstraints(ctx, id, [...constraintsOf(o), c]);
          added.push({ object: id, constraint: c.id, name: c.name });
        }
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const constraints = added.map((a) => {
          const errors = constraintErrors(ctx, a.object, a.constraint, fs);
          const owner = ctx.doc.getObject(a.object)?.name ?? a.object;
          for (const e of errors) ctx.report('WARNING', `${owner} ${a.name}: ${e}`);
          return { ...a, errors };
        });
        return { target: target.id, type, constraints };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.visual_transform_apply',
      label: 'Apply Visual Transform',
      description:
        'Copy the evaluated (visual) transform of objects - including constraints, parenting and animation at the ' +
        'current frame - into their location / rotation_euler / scale (relative to the parent). Constraints are ' +
        'kept (remove them afterwards to freeze the result). Default: the selected objects. Returns the new transforms.',
      category: 'Object',
      schema: z.object({
        objects: z.array(z.string()).optional().describe('Object ids or names (default: selected objects)'),
      }),
      execute(ctx, p) {
        const ids = resolveObjectIds(ctx, p.objects);
        if (!ids.length) throw new OperatorError('No objects selected (pass `objects`)', 'POLL_FAILED');
        // evaluate everything first so each object sees the state before any change
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const visual = ids.map((id) => ({ id, world: fs.world(id), parent: fs.parent(id) }));
        const out: { object: string; location: number[]; rotation_euler: number[]; scale: number[] }[] = [];
        for (const v of visual) {
          const o = ctx.doc.getObject(v.id)!;
          const world = v.world ?? multiply4(v.parent, fs.local(v.id));
          out.push({ object: v.id, ...applyWorldMatrix(ctx, o, world, v.parent, animatedRotation(fs, o)) });
        }
        return { objects: out };
      },
    }),
  );
}
