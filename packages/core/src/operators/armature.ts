import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import { decompose4, invert4, multiply4 } from '../math/mat4';
import { transformDirection3, transformPoint3 } from '../math/vec3';
import type {
  ArmatureData,
  BoneData,
  ConstraintData,
  ModifierData,
  ObjectData,
  PoseBone,
  ShapeKeyData,
  VertexGroupData,
} from '../doc/types';
import { defaultBone, defaultPoseBone } from '../doc/defaults';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { vertexCount } from '../mesh/types';
import { selectedVertexSet } from '../mesh/selection';
import { applyShapeKeys, decodeFloat32, encodeFloat32 } from '../mesh/shape-keys';
import { getModifierDef, modifierObjectParams, registerBuiltinModifiers } from '../modifiers';
import { getConstraintTypeInfo } from '../constraints/catalogue';
import { FrameState } from '../eval/frame-state';
import { computePose } from '../armature/pose';
import { ikSettingsOf } from '../armature/ik';
import { rollFromZAxis } from '../armature/bone-math';
import {
  BONE_CONSTRAINT_LABELS,
  BONE_CONSTRAINT_SCHEMAS,
  BONE_CONSTRAINT_TYPES,
  type BoneConstraintType,
} from '../armature/bone-constraints';
import { computeEnvelopeWeights, computeHeatWeights, type WeightBone } from '../armature/weights';
import { poseBonePath, removeBones, renameBone, syncPoseChannels, uniqueBoneName } from '../armature/edit';
import { newId } from '../util/id';
import { uniqueName } from '../util/names';
import { cloneJson } from '../util/json';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { activeObject, setSelection, vec3 } from './helpers';
import { keyProperty, rekeyAnimated } from './anim';

/*
 * Operators for armatures, bones, pose, skinning, vertex groups and shape keys:
 * object.armature_add, armature.*, pose.*, object.vertex_group_*, object.shape_key_* and the
 * armature parent types of object.parent_set (see `armatureParentSet`).
 *
 * Conventions (Blender): bone head/tail are in armature (object) space unless `space` is WORLD;
 * a bone's local Y axis points from head to tail and `roll` (radians) turns it about that axis;
 * pose transforms (location / rotation_euler / scale) are relative to the rest pose in the
 * bone's own axes.
 */

// ------------------------------------------------------------------ shared schema pieces

const objectRef = (what = 'Armature object') =>
  z.string().optional().describe(`${what} id or name (default: the active object)`);
const boneRef = z.string().min(1).describe('Bone name');
const spaceParam = z
  .enum(['ARMATURE', 'WORLD'])
  .default('ARMATURE')
  .describe('Coordinate space of head/tail/points: ARMATURE (relative to the armature object) or WORLD');
const rollParam = z
  .number()
  .default(0)
  .describe("Roll in radians: rotation of the bone's X/Z axes about its own (head → tail) Y axis");
const alignRollParam = vec3
  .optional()
  .describe(
    "Instead of `roll`: direction the bone's local Z axis should face (e.g. [0, -1, 0] = towards -Y/front)",
  );
const envelopeParams = {
  envelope_distance: z
    .number()
    .min(0)
    .optional()
    .describe('Envelope falloff distance in metres (default 0.25)'),
  envelope_weight: z.number().min(0).optional().describe('Envelope weight multiplier (default 1)'),
  head_radius: z.number().min(0).optional().describe('Envelope radius at the head in metres (default 0.1)'),
  tail_radius: z.number().min(0).optional().describe('Envelope radius at the tail in metres (default 0.05)'),
};

const MIN_BONE_LENGTH = 1e-6;

// ------------------------------------------------------------------ resolution helpers

interface ArmatureTarget {
  object: ObjectData;
  arm: ArmatureData;
}

function resolveObject(ctx: OperatorContext, ref: string | undefined): ObjectData {
  const o = ref ? ctx.doc.resolveObject(ref) : activeObject(ctx);
  if (!o) {
    if (ref) throw new OperatorError(`Object '${ref}' not found`, 'NOT_FOUND');
    throw new OperatorError('No active object (pass `object`)', 'POLL_FAILED');
  }
  return o;
}

function armatureTarget(ctx: OperatorContext, ref: string | undefined): ArmatureTarget {
  const object = resolveObject(ctx, ref);
  if (object.type !== 'ARMATURE' || !object.data)
    throw new OperatorError(
      `Object '${object.name}' is a ${object.type} object, not an armature`,
      ref ? 'INVALID_PARAMS' : 'POLL_FAILED',
    );
  const arm = ctx.doc.getArmature(object.data);
  if (!arm) throw new OperatorError(`Armature data of '${object.name}' is missing`, 'FAILED');
  return { object, arm };
}

function meshTarget(
  ctx: OperatorContext,
  ref: string | undefined,
): { object: ObjectData; meshId: string; n: number } {
  const object = resolveObject(ctx, ref);
  if (object.type !== 'MESH' || !object.data)
    throw new OperatorError(
      `Object '${object.name}' is a ${object.type} object; vertex groups and shape keys need a mesh`,
      ref ? 'INVALID_PARAMS' : 'POLL_FAILED',
    );
  const counts = ctx.doc.meshCounts(object.data);
  if (!counts) throw new OperatorError(`Mesh data of '${object.name}' is missing`, 'FAILED');
  return { object, meshId: object.data, n: counts.vertices };
}

function boneList(arm: ArmatureData): string {
  const names = arm.bones.map((b) => `'${b.name}'`);
  if (!names.length) return 'none';
  return names.length > 40 ? `${names.slice(0, 40).join(', ')}, …` : names.join(', ');
}

function findBone(arm: ArmatureData, name: string): BoneData {
  const b = arm.bones.find((x) => x.name === name);
  if (!b)
    throw new OperatorError(
      `Bone '${name}' not found in '${arm.name}' (bones: ${boneList(arm)})`,
      'NOT_FOUND',
    );
  return b;
}

/** Evaluated world matrix of an object at the current frame. */
function worldMatrixOf(ctx: OperatorContext, id: string): Mat4 {
  return new FrameState(ctx.doc, ctx.state.frame).world(id) ?? ctx.doc.worldMatrix(id);
}

/** Converts points/directions given in `space` into armature space. */
function spaceConverter(ctx: OperatorContext, armatureObject: string, space: 'ARMATURE' | 'WORLD') {
  if (space === 'ARMATURE')
    return { point: (p: Vec3): Vec3 => [...p] as Vec3, dir: (d: Vec3): Vec3 => [...d] as Vec3 };
  const inv = invert4(worldMatrixOf(ctx, armatureObject));
  return { point: (p: Vec3) => transformPoint3(inv, p), dir: (d: Vec3) => transformDirection3(inv, d) };
}

const len3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const round = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e6) / 1e6);
const roundVec = (v: readonly number[]) => v.map(round) as Vec3;

/** Descendants of a bone (children, grandchildren…). */
function boneDescendants(arm: ArmatureData, name: string): Set<string> {
  const out = new Set<string>();
  let frontier = [name];
  while (frontier.length) {
    const next: string[] = [];
    for (const b of arm.bones)
      if (b.parent && frontier.includes(b.parent) && !out.has(b.name)) next.push(b.name);
    for (const n of next) out.add(n);
    frontier = next;
  }
  return out;
}

function writeBones(ctx: OperatorContext, arm: ArmatureData, bones: BoneData[]): void {
  ctx.doc.updateArmature(arm.id, { bones });
  syncPoseChannels(ctx.doc, arm.id);
}

function boneSummary(b: BoneData) {
  return {
    name: b.name,
    parent: b.parent,
    head: roundVec(b.head),
    tail: roundVec(b.tail),
    roll: round(b.roll),
    length: round(len3(b.head, b.tail)),
    use_connect: b.use_connect,
    use_deform: b.use_deform,
  };
}

// ------------------------------------------------------------------ pose helpers

/** Own (not inherited) pose channel of a bone, if any. */
function ownChannel(bones: Record<string, PoseBone> | undefined, bone: string): PoseBone | undefined {
  return bones && Object.hasOwn(bones, bone) ? bones[bone] : undefined;
}

function poseChannel(o: ObjectData, bone: string): PoseBone {
  return cloneJson(ownChannel(o.pose?.bones, bone) ?? defaultPoseBone());
}

function writePoseChannel(ctx: OperatorContext, o: ObjectData, bone: string, pb: PoseBone): void {
  const cur = ctx.doc.getObject(o.id)!;
  ctx.doc.updateObject(o.id, { pose: { ...cur.pose, bones: { ...(cur.pose?.bones ?? {}), [bone]: pb } } });
}

/** Resolves a constraint target reference: object id/name (null when unset). */
function resolveTargetId(ctx: OperatorContext, ref: string | null | undefined, what: string): string | null {
  if (ref === undefined || ref === null || ref === '') return null;
  const o = ctx.doc.resolveObject(ref);
  if (!o) throw new OperatorError(`${what} '${ref}' not found`, 'NOT_FOUND');
  return o.id;
}

/** Checks that `bone` exists on the armature object `targetId` (when a sub-target is given). */
function checkSubtarget(ctx: OperatorContext, targetId: string | null, bone: string, what: string): void {
  if (!bone || !targetId) return;
  const t = ctx.doc.getObject(targetId)!;
  if (t.type !== 'ARMATURE' || !t.data)
    throw new OperatorError(
      `${what} '${t.name}' is not an armature, so it has no bone '${bone}'`,
      'INVALID_PARAMS',
    );
  findBone(ctx.doc.getArmature(t.data)!, bone);
}

function findConstraint(list: ConstraintData[], ref: string, bone: string): number {
  let i = list.findIndex((c) => c.id === ref);
  if (i < 0) i = list.findIndex((c) => c.name === ref);
  if (i < 0) {
    const have = list.map((c) => `'${c.name}'`).join(', ') || 'none';
    throw new OperatorError(
      `Constraint '${ref}' not found on bone '${bone}' (constraints: ${have})`,
      'NOT_FOUND',
    );
  }
  return i;
}

/** Validates a partial parameter patch for a bone constraint type; object references → ids. */
function validateConstraintParams(
  ctx: OperatorContext,
  ownerId: string,
  type: BoneConstraintType,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const schema = BONE_CONSTRAINT_SCHEMAS[type] as z.ZodObject<any>;
  const keys = Object.keys(schema.shape);
  const unknown = Object.keys(patch).filter((k) => !keys.includes(k));
  if (unknown.length)
    throw new OperatorError(
      `Unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} for ${type}. ` +
        `Valid parameters: ${keys.join(', ') || 'none'}`,
      'INVALID_PARAMS',
    );
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) if (keys.includes(k)) merged[k] = v;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
  if (type === 'IK' && 'pole_target' in patch) {
    if (patch.pole_target === '' && patch.pole_subtarget)
      throw new OperatorError(
        'pole_target "" removes the pole (and its pole_subtarget bone); to use a bone of this armature as ' +
          'the pole, pass this armature as pole_target or give only pole_subtarget',
        'INVALID_PARAMS',
      );
    merged.pole_target = resolveTargetId(ctx, patch.pole_target as string | null, 'Pole target');
    // without a pole object its bone goes too (a pole bone without an object is ignored)
    if (!merged.pole_target && !patch.pole_subtarget) merged.pole_subtarget = '';
  }
  const res = schema.safeParse(merged);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`).join('; ');
    throw new OperatorError(`Invalid ${type} parameters: ${msg}`, 'INVALID_PARAMS');
  }
  const out = cloneJson(res.data as Record<string, unknown>);
  if (type === 'IK') {
    // a pole bone without a pole object is a bone of this armature (stored like Blender does)
    if (!out.pole_target && out.pole_subtarget) out.pole_target = ownerId;
    checkSubtarget(ctx, out.pole_target as string | null, String(out.pole_subtarget ?? ''), 'Pole target');
  }
  return out;
}

/** Bones whose rotation an IK constraint on `bone` drives (root first). */
function ikChain(arm: ArmatureData, bone: string, chainCount: number, useTail: boolean): string[] {
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  let cur: string | null = useTail ? bone : (byName.get(bone)?.parent ?? null);
  const chain: string[] = [];
  const seen = new Set<string>();
  while (cur && byName.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    if (chainCount > 0 && chain.length >= chainCount) break;
    cur = byName.get(cur)!.parent;
  }
  return chain.reverse();
}

/** Every IK setting of a pose bone with its effective value (Blender defaults filled in). */
function ikSettingsSummary(pb: PoseBone | undefined) {
  const s = ikSettingsOf(pb);
  const out: Record<string, boolean | number> = {};
  (['x', 'y', 'z'] as const).forEach((a, i) => {
    out[`lock_ik_${a}`] = s?.lock[i] ?? false;
    out[`use_ik_limit_${a}`] = !!s?.limit[i];
    out[`ik_min_${a}`] = round(
      s?.limit[i]?.[0] ?? Math.max(-Math.PI, Math.min(0, pb?.[`ik_min_${a}`] ?? -Math.PI)),
    );
    out[`ik_max_${a}`] = round(
      s?.limit[i]?.[1] ?? Math.min(Math.PI, Math.max(0, pb?.[`ik_max_${a}`] ?? Math.PI)),
    );
    out[`ik_stiffness_${a}`] = round(s?.stiffness[i] ?? 0);
  });
  return out;
}

/** IK constraints of an armature object whose chain contains `bone` (owner bone, name, chain). */
function chainsContaining(object: ObjectData, arm: ArmatureData, bone: string) {
  const out: { bone: string; constraint: string; chain: string[] }[] = [];
  for (const [owner, pb] of Object.entries(object.pose?.bones ?? {})) {
    for (const c of pb.constraints ?? []) {
      if (c.type !== 'IK') continue;
      const params = (c.params ?? {}) as { chain_count?: number; use_tail?: boolean };
      const chain = ikChain(arm, owner, params.chain_count ?? 0, params.use_tail ?? true);
      if (chain.includes(bone)) out.push({ bone: owner, constraint: c.name, chain });
    }
  }
  return out;
}

// ------------------------------------------------------------------ vertex group helpers

function readGroups(ctx: OperatorContext, meshId: string): VertexGroupData[] {
  return ctx.doc.getVertexGroups(meshId);
}

function groupWeights(g: VertexGroupData, n: number): Float32Array {
  const w = decodeFloat32(g.weights);
  if (w.length === n) return w;
  // the mesh changed size since the weights were written: keep what still maps, zero the rest
  const out = new Float32Array(n);
  out.set(w.subarray(0, Math.min(n, w.length)));
  return out;
}

function findGroup(groups: VertexGroupData[], name: string, objectName: string): number {
  const i = groups.findIndex((g) => g.name === name);
  if (i < 0) {
    const have = groups.map((g) => `'${g.name}'`).join(', ') || 'none';
    throw new OperatorError(
      `Vertex group '${name}' not found on '${objectName}' (groups: ${have})`,
      'NOT_FOUND',
    );
  }
  return i;
}

/** Vertex indices to act on: explicit list, else the edit-mode selection of this object, else all. */
function targetVertices(
  ctx: OperatorContext,
  o: ObjectData,
  n: number,
  indices: number[] | undefined,
): number[] {
  if (indices) {
    for (const i of indices)
      if (i >= n)
        throw new OperatorError(`Vertex index ${i} out of range (mesh has ${n} vertices)`, 'INVALID_PARAMS');
    return [...new Set(indices)];
  }
  if (ctx.state.mode === 'EDIT' && ctx.state.activeId === o.id && o.data) {
    const mesh = ctx.doc.getMesh(o.data);
    if (mesh) return [...selectedVertexSet(mesh, ctx.state.meshSelection)].filter((v) => v < n);
  }
  return Array.from({ length: n }, (_, i) => i);
}

/** Deform bone names of the armatures deforming a mesh object (modifiers / armature parent). */
function deformBoneNames(ctx: OperatorContext, o: ObjectData): Set<string> {
  const ids = new Set<string>();
  for (const m of o.modifiers)
    if (m.type === 'ARMATURE' && typeof m.params?.object === 'string') ids.add(m.params.object);
  if (o.parent) ids.add(o.parent);
  const out = new Set<string>();
  for (const id of ids) {
    const a = ctx.doc.getObject(id);
    const arm = a?.type === 'ARMATURE' && a.data ? ctx.doc.getArmature(a.data) : null;
    for (const b of arm?.bones ?? []) if (b.use_deform) out.add(b.name);
  }
  return out;
}

// ------------------------------------------------------------------ shape key helpers

function findKey(keys: ShapeKeyData[], ref: string, objectName: string): number {
  const i = keys.findIndex((k) => k.name === ref);
  if (i < 0) {
    const have = keys.map((k) => `'${k.name}'`).join(', ') || 'none';
    throw new OperatorError(
      `Shape key '${ref}' not found on '${objectName}' (shape keys: ${have})`,
      'NOT_FOUND',
    );
  }
  return i;
}

function shapeKeyPath(name: string): string {
  return `shape_keys[${JSON.stringify(name)}].value`;
}

/** Shape keys of a mesh with their animated (F-curve / driver) values at the current frame. */
function animatedShapeKeys(ctx: OperatorContext, meshId: string): ShapeKeyData[] {
  const animated = new FrameState(ctx.doc, ctx.state.frame).get<{ shape_keys: ShapeKeyData[] }>(
    'mesh',
    meshId,
  );
  return animated?.shape_keys ?? ctx.doc.getShapeKeys(meshId);
}

/** Positions of a shape key, validated against the mesh vertex count. */
function keyPositions(k: ShapeKeyData, n: number): Float32Array {
  const d = decodeFloat32(k.data);
  if (d.length !== n * 3)
    throw new OperatorError(
      `Shape key '${k.name}' has ${d.length / 3} vertices but the mesh has ${n}; remove and re-add it`,
      'FAILED',
    );
  return d;
}

// ------------------------------------------------------------------ armature parenting (object.parent_set)

export const ARMATURE_PARENT_TYPES = [
  'ARMATURE',
  'ARMATURE_NAME',
  'ARMATURE_ENVELOPE',
  'ARMATURE_AUTO',
  'BONE',
] as const;
export type ArmatureParentType = (typeof ARMATURE_PARENT_TYPES)[number];

export interface ArmatureParentResult {
  parent: string;
  type: ArmatureParentType;
  children: string[];
  bone?: string;
  /** Vertex groups created or updated per child mesh (by object name). */
  vertex_groups?: Record<string, string[]>;
  warnings?: string[];
}

/** Inserts an Armature modifier for `armatureId` unless the mesh already has one (before generators). */
function ensureArmatureModifier(ctx: OperatorContext, o: ObjectData, armatureId: string): void {
  if (o.modifiers.some((m) => m.type === 'ARMATURE' && m.params?.object === armatureId)) return;
  registerBuiltinModifiers();
  const def = getModifierDef('ARMATURE');
  const params = { ...(def ? (def.schema.parse({}) as Record<string, unknown>) : {}), object: armatureId };
  const mod: ModifierData = {
    id: newId(),
    name: uniqueName('Armature', new Set(o.modifiers.map((m) => m.name))),
    type: 'ARMATURE',
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params,
  };
  // deform with the original vertices: place it before the first non-deform modifier
  let at = o.modifiers.findIndex((m) => getModifierDef(m.type)?.category !== 'DEFORM');
  if (at < 0) at = o.modifiers.length;
  const modifiers = [...o.modifiers];
  modifiers.splice(at, 0, mod);
  ctx.doc.updateObject(o.id, { modifiers });
}

/**
 * Parents objects to an armature like Blender's Ctrl+P menu: ARMATURE (armature deform: Armature
 * modifier, no groups), ARMATURE_NAME (+ empty vertex groups for the deform bones),
 * ARMATURE_ENVELOPE (+ weights from the bone envelopes), ARMATURE_AUTO (+ automatic "bone heat"
 * weights) or BONE (rigidly follows `bone`). World transforms are kept when `keep_transform`.
 */
export function armatureParentSet(
  ctx: OperatorContext,
  childIds: readonly string[],
  parentId: string,
  type: ArmatureParentType,
  opts: { keep_transform?: boolean; bone?: string } = {},
): ArmatureParentResult {
  const parent = ctx.doc.getObject(parentId);
  if (!parent || parent.type !== 'ARMATURE' || !parent.data)
    throw new OperatorError(
      `Parent type ${type} needs an armature object as the parent (got '${parent?.name ?? parentId}')`,
      'INVALID_PARAMS',
    );
  const arm = ctx.doc.getArmature(parent.data);
  if (!arm) throw new OperatorError(`Armature data of '${parent.name}' is missing`, 'FAILED');
  const children = childIds.filter((id) => id !== parentId);
  if (!children.length)
    throw new OperatorError('Nothing to parent: select the children and the armature', 'INVALID_PARAMS');
  let bone: string | undefined;
  if (type === 'BONE') {
    bone = opts.bone || (arm.bones.length === 1 ? arm.bones[0].name : '');
    if (!bone)
      throw new OperatorError(`Parent type BONE needs \`bone\` (bones: ${boneList(arm)})`, 'INVALID_PARAMS');
    findBone(arm, bone);
  }
  for (const id of children)
    if (ctx.doc.isAncestor(id, parentId)) throw new OperatorError('Loop in parents', 'FAILED');

  const before = new FrameState(ctx.doc, ctx.state.frame);
  const worlds = new Map(children.map((id) => [id, before.world(id) ?? ctx.doc.worldMatrix(id)]));
  for (const id of children)
    ctx.doc.updateObject(id, {
      parent: parentId,
      parent_type: type === 'BONE' ? 'BONE' : 'OBJECT',
      parent_bone: type === 'BONE' ? bone! : '',
    });
  if (opts.keep_transform !== false) {
    const after = new FrameState(ctx.doc, ctx.state.frame);
    for (const id of children) {
      const local = multiply4(invert4(after.parent(id)), worlds.get(id)!);
      const d = decompose4(local);
      ctx.doc.updateObject(id, { location: d.location, rotation_euler: d.rotation, scale: d.scale });
    }
  }
  const result: ArmatureParentResult = { parent: parentId, type, children: [...children] };
  if (bone) result.bone = bone;
  if (type === 'BONE') return result;

  const warnings: string[] = [];
  const groupsOut: Record<string, string[]> = {};
  const fs = new FrameState(ctx.doc, ctx.state.frame);
  const armWorld = fs.world(parentId) ?? ctx.doc.worldMatrix(parentId);
  const restPose = computePose(
    { ...arm, pose_position: 'REST' },
    {},
    {
      frame: ctx.state.frame,
      armatureMatrix: armWorld,
      getWorldMatrix: () => null,
    },
  );
  const deform = restPose.order.map((n) => restPose.bones.get(n)!).filter((b) => b.deform !== false);
  const weightBones: WeightBone[] = deform.map((b) => ({
    name: b.name,
    head: b.restHead ?? [b.rest[12], b.rest[13], b.rest[14]],
    tail: b.restTail ?? [b.rest[12], b.rest[13], b.rest[14]],
    headRadius: b.envelope?.headRadius,
    tailRadius: b.envelope?.tailRadius,
    distance: b.envelope?.distance,
  }));
  const doneMeshes = new Set<string>();
  for (const id of children) {
    const o = ctx.doc.getObject(id)!;
    if (o.type !== 'MESH' || !o.data) {
      warnings.push(`'${o.name}' is not a mesh: parented without armature deform`);
      continue;
    }
    ensureArmatureModifier(ctx, o, parentId);
    if (type === 'ARMATURE' || doneMeshes.has(o.data)) continue;
    doneMeshes.add(o.data);
    const mesh = ctx.doc.getMesh(o.data);
    if (!mesh) continue;
    const n = vertexCount(mesh);
    let weights: Float32Array[];
    if (type === 'ARMATURE_NAME') weights = deform.map(() => new Float32Array(n));
    else {
      // where the mesh is now (it moved if the transform was not kept)
      const toArm = multiply4(invert4(armWorld), fs.world(id) ?? worlds.get(id)!);
      const pos = new Array<number>(n * 3);
      for (let v = 0; v < n; v++) {
        const p = transformPoint3(toArm, [
          mesh.positions[v * 3],
          mesh.positions[v * 3 + 1],
          mesh.positions[v * 3 + 2],
        ]);
        pos[v * 3] = p[0];
        pos[v * 3 + 1] = p[1];
        pos[v * 3 + 2] = p[2];
      }
      if (type === 'ARMATURE_ENVELOPE') weights = computeEnvelopeWeights(pos, weightBones);
      else {
        const res = computeHeatWeights({ ...mesh, positions: pos }, weightBones);
        weights = res.weights;
        for (const w of res.warnings) warnings.push(`'${o.name}': ${w}`);
      }
    }
    const groups = ctx.doc.getVertexGroups(o.data);
    const names: string[] = [];
    deform.forEach((b, j) => {
      const i = groups.findIndex((g) => g.name === b.name);
      if (type === 'ARMATURE_NAME') {
        if (i < 0) groups.push({ name: b.name, weights: encodeFloat32(weights[j]) });
      } else if (i >= 0) groups[i] = { name: b.name, weights: encodeFloat32(weights[j]) };
      else groups.push({ name: b.name, weights: encodeFloat32(weights[j]) });
      names.push(b.name);
    });
    ctx.doc.setVertexGroups(o.data, groups);
    groupsOut[o.name] = names;
  }
  if (Object.keys(groupsOut).length) result.vertex_groups = groupsOut;
  if (warnings.length) {
    result.warnings = warnings;
    for (const w of warnings) ctx.report('WARNING', w);
  }
  return result;
}

/**
 * Removes bone parenting from an object (it becomes unparented), keeping its evaluated world
 * transform when `keepTransform` (the stored-transform helpers of SceneDoc ignore bones).
 */
export function clearBoneParent(ctx: OperatorContext, id: string, keepTransform: boolean): void {
  const world = keepTransform ? worldMatrixOf(ctx, id) : null;
  ctx.doc.updateObject(id, { parent: null, parent_type: 'OBJECT', parent_bone: '' });
  if (world) {
    const d = decompose4(world);
    ctx.doc.updateObject(id, { location: d.location, rotation_euler: d.rotation, scale: d.scale });
  }
}

/** Object references of a constraint list remapped through `remap` (null when nothing changed). */
function remapConstraintRefs(
  list: ConstraintData[] | undefined,
  remap: (id: unknown) => unknown,
): ConstraintData[] | null {
  if (!Array.isArray(list) || !list.length) return null;
  let changed = false;
  const out = list.map((c) => {
    if (!c || typeof c !== 'object') return c;
    let next = c;
    const t = remap(c.target);
    if (t !== c.target) next = { ...next, target: t as string };
    const keys = getConstraintTypeInfo(c.type)?.objectParams ?? ['pole_target'];
    for (const k of keys) {
      const v = c.params?.[k];
      const r = remap(v);
      if (r !== v) next = { ...next, params: { ...next.params, [k]: r } };
    }
    if (next !== c) changed = true;
    return next;
  });
  return changed ? out : null;
}

/**
 * After objects were duplicated (`map`: original id → copy id), points the copies' references to
 * duplicated objects at the copies, like Blender: modifier objects (e.g. the Armature modifier's
 * armature), object constraint targets and pose bone constraint targets / pole targets, so a
 * duplicated rig and its meshes form an independent copy. Self targets (a bone constraint whose
 * target is its own armature) follow the copy. References to objects outside the set are kept.
 */
export function remapDuplicatedReferences(doc: SceneDoc, map: ReadonlyMap<string, string>): void {
  if (!map.size) return;
  const remap = (id: unknown): unknown => (typeof id === 'string' && map.has(id) ? map.get(id)! : id);
  for (const copy of map.values()) {
    const o = doc.getObject(copy);
    if (!o) continue;
    const patch: Partial<ObjectData> = {};
    let modsChanged = false;
    const modifiers = o.modifiers.map((m) => {
      let params = m.params;
      for (const k of modifierObjectParams(m.type)) {
        const v = params?.[k];
        const r = remap(v);
        if (r !== v) params = { ...params, [k]: r };
      }
      if (params === m.params) return m;
      modsChanged = true;
      return { ...m, params };
    });
    if (modsChanged) patch.modifiers = modifiers;
    const cs = remapConstraintRefs(o.constraints, remap);
    if (cs) patch.constraints = cs;
    if (o.type === 'ARMATURE' && o.pose?.bones) {
      let changed = false;
      const bones = Object.entries(o.pose.bones).map(([name, pb]): [string, PoseBone] => {
        const bc = remapConstraintRefs(pb?.constraints, remap);
        if (!bc) return [name, pb];
        changed = true;
        return [name, { ...pb, constraints: bc }];
      });
      if (changed) patch.pose = { ...o.pose, bones: Object.fromEntries(bones) };
    }
    if (Object.keys(patch).length) doc.updateObject(copy, patch);
  }
}

// ------------------------------------------------------------------ registration

export function registerArmatureOperators(reg: OperatorRegistry): void {
  registerAddAndBoneOperators(reg);
  registerPoseOperators(reg);
  registerVertexGroupOperators(reg);
  registerShapeKeyOperators(reg);
}

function registerAddAndBoneOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'object.armature_add',
      label: 'Armature',
      description:
        'Add an armature object with one bone (named `bone_name`) from the armature origin straight up its +Z axis, ' +
        '`radius` metres long. Add more bones with armature.bone_add / armature.chain_add, pose them with ' +
        'pose.bone_transform_set, and bind meshes with object.parent_set(type="ARMATURE_AUTO"). Returns the ' +
        'object id/name, the armature data id and the bone names.',
      category: 'Add',
      redoable: true,
      schema: z.object({
        name: z.string().default('Armature').describe('Name of the new armature object (and its data)'),
        bone_name: z.string().min(1).default('Bone').describe('Name of the initial bone'),
        radius: z.number().positive().default(1).describe('Length of the initial bone in metres'),
        location: vec3.optional().describe('World location (default: the 3D cursor)'),
        rotation: vec3.optional().describe('Euler XYZ rotation in radians (default [0, 0, 0])'),
        scale: vec3.optional().describe('Scale (default [1, 1, 1])'),
      }),
      poll: (ctx) => (ctx.state.mode === 'OBJECT' ? true : 'Operator requires Object Mode'),
      execute(ctx, p) {
        const bone = defaultBone(uniqueBoneName([], p.bone_name), [0, 0, 0], [0, 0, p.radius]);
        const data = ctx.doc.addArmature({ name: p.name, bones: [bone] });
        const id = ctx.doc.addObject({
          type: 'ARMATURE',
          name: p.name,
          data,
          location: (p.location ?? ctx.state.cursorLocation) as Vec3,
          rotation_euler: (p.rotation ?? [0, 0, 0]) as Vec3,
          scale: (p.scale ?? [1, 1, 1]) as Vec3,
          pose: { bones: Object.fromEntries([[bone.name, defaultPoseBone()]]) },
        });
        setSelection(ctx, [id], id);
        return { object: id, name: ctx.doc.getObject(id)!.name, armature: data, bones: [bone.name] };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'armature.bone_add',
      label: 'Add Bone',
      description:
        'Add a bone to an armature. head/tail are positions in metres (armature space unless space="WORLD"); the ' +
        "bone's Y axis points from head to tail. With `parent`, head defaults to the parent's tail and tail to head " +
        "plus the parent's direction × `length`; use_connect=true snaps the head onto the parent's tail (the bone " +
        "then can't be moved on its own). The name is made unique (Bone, Bone.001…). Returns the final bone data.",
      category: 'Armature',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        name: z.string().min(1).default('Bone').describe('Bone name (made unique within the armature)'),
        head: vec3.optional().describe("Head position (default: the parent's tail, or [0, 0, 0])"),
        tail: vec3
          .optional()
          .describe("Tail position (default: head + `length` along the parent's direction, or along +Z)"),
        length: z
          .number()
          .positive()
          .default(1)
          .describe('Bone length in metres, used when `tail` is omitted'),
        roll: rollParam,
        align_roll: alignRollParam,
        parent: z.string().optional().describe('Name of the parent bone'),
        use_connect: z
          .boolean()
          .default(false)
          .describe("Connect to the parent: the head sits on the parent's tail and pose location is ignored"),
        use_deform: z
          .boolean()
          .default(true)
          .describe('Bone deforms meshes (gets automatic weights / vertex groups)'),
        ...envelopeParams,
        space: spaceParam,
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        const conv = spaceConverter(ctx, object.id, p.space);
        const parent = p.parent ? findBone(arm, p.parent) : null;
        if (p.use_connect && !parent)
          throw new OperatorError('use_connect needs a `parent` bone', 'INVALID_PARAMS');
        let head: Vec3 = p.head ? conv.point(p.head as Vec3) : parent ? [...parent.tail] : [0, 0, 0];
        if (p.use_connect && parent) head = [...parent.tail];
        let tail: Vec3;
        if (p.tail) tail = conv.point(p.tail as Vec3);
        else {
          const d: Vec3 = parent
            ? [
                parent.tail[0] - parent.head[0],
                parent.tail[1] - parent.head[1],
                parent.tail[2] - parent.head[2],
              ]
            : [0, 0, 1];
          const l = Math.hypot(...d) || 1;
          tail = [
            head[0] + (d[0] / l) * p.length,
            head[1] + (d[1] / l) * p.length,
            head[2] + (d[2] / l) * p.length,
          ];
        }
        if (len3(head, tail) < MIN_BONE_LENGTH)
          throw new OperatorError(
            'Bone head and tail must not coincide (zero-length bone)',
            'INVALID_PARAMS',
          );
        const roll = p.align_roll ? rollFromZAxis(head, tail, conv.dir(p.align_roll as Vec3)) : p.roll;
        const bone: BoneData = {
          ...defaultBone(uniqueBoneName(arm.bones, p.name), head, tail),
          roll,
          parent: parent?.name ?? null,
          use_connect: p.use_connect,
          use_deform: p.use_deform,
        };
        for (const k of ['envelope_distance', 'envelope_weight', 'head_radius', 'tail_radius'] as const)
          if (p[k] !== undefined) bone[k] = p[k]!;
        writeBones(ctx, arm, [...arm.bones, bone]);
        return { object: object.id, bone: bone.name, ...boneSummary(bone) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'armature.chain_add',
      label: 'Add Bone Chain',
      description:
        'Add a chain of connected bones through a list of points (≥ 2; one bone per consecutive pair), e.g. a ' +
        'spine, tail, tentacle or limb. Bones are named from `name` (Bone, Bone.001, …) unless `names` are given. ' +
        'The first bone can be parented to an existing bone (`parent`, optionally connected). Points are in metres ' +
        '(armature space unless space="WORLD"). Returns the created bone names, root first.',
      category: 'Armature',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        points: z
          .array(vec3)
          .min(2)
          .describe('Joint positions: head of the first bone, …, tail of the last bone'),
        name: z.string().min(1).default('Bone').describe('Base name for the bones'),
        names: z
          .array(z.string().min(1))
          .optional()
          .describe('Explicit bone names (one per bone = points.length - 1); made unique'),
        parent: z.string().optional().describe('Parent bone of the first bone of the chain'),
        use_connect: z
          .boolean()
          .default(false)
          .describe("Connect the first bone to `parent` (its head snaps to the parent's tail)"),
        roll: rollParam,
        align_roll: alignRollParam,
        use_deform: z.boolean().default(true).describe('Bones deform meshes'),
        space: spaceParam,
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        const conv = spaceConverter(ctx, object.id, p.space);
        const pts = p.points.map((q) => conv.point(q as Vec3));
        const parent = p.parent ? findBone(arm, p.parent) : null;
        if (p.use_connect && !parent)
          throw new OperatorError('use_connect needs a `parent` bone', 'INVALID_PARAMS');
        if (p.use_connect && parent) pts[0] = [...parent.tail];
        const count = pts.length - 1;
        if (p.names && p.names.length !== count)
          throw new OperatorError(`names must have ${count} entries (one per bone)`, 'INVALID_PARAMS');
        for (let i = 0; i < count; i++)
          if (len3(pts[i], pts[i + 1]) < MIN_BONE_LENGTH)
            throw new OperatorError(`Points ${i} and ${i + 1} coincide (zero-length bone)`, 'INVALID_PARAMS');
        const bones = [...arm.bones];
        const created: BoneData[] = [];
        for (let i = 0; i < count; i++) {
          const head = pts[i];
          const tail = pts[i + 1];
          const roll = p.align_roll ? rollFromZAxis(head, tail, conv.dir(p.align_roll as Vec3)) : p.roll;
          const b: BoneData = {
            ...defaultBone(uniqueBoneName(bones, p.names?.[i] ?? p.name), head, tail),
            roll,
            parent: i === 0 ? (parent?.name ?? null) : created[i - 1].name,
            use_connect: i === 0 ? p.use_connect : true,
            use_deform: p.use_deform,
          };
          bones.push(b);
          created.push(b);
        }
        writeBones(ctx, arm, bones);
        return {
          object: object.id,
          bones: created.map((b) => b.name),
          lengths: created.map((b) => round(len3(b.head, b.tail))),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'armature.bone_update',
      label: 'Edit Bone',
      description:
        'Change a bone (rest pose / edit-mode properties): rename (vertex groups, animation, constraints and bone ' +
        'parenting follow), move head/tail (metres, armature space unless space="WORLD"; connected children follow ' +
        "the tail, and moving the head of a connected bone moves its parent's tail), roll (radians) or align_roll, " +
        're-parent (parent="" clears), connect, deform flag and envelope settings. Only given fields change.',
      category: 'Armature',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        bone: boneRef,
        name: z.string().min(1).optional().describe('New name (made unique)'),
        head: vec3.optional().describe('New head position'),
        tail: vec3.optional().describe('New tail position'),
        roll: z.number().optional().describe('New roll in radians'),
        align_roll: alignRollParam,
        parent: z.string().optional().describe('New parent bone name ("" = no parent)'),
        use_connect: z
          .boolean()
          .optional()
          .describe("Connect to the parent (snaps the head to the parent's tail)"),
        use_deform: z.boolean().optional().describe('Bone deforms meshes'),
        ...envelopeParams,
        space: spaceParam,
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        const name = findBone(arm, p.bone).name;
        // everything is computed and validated before the document changes (no partial edits)
        const newName = p.name !== undefined ? uniqueBoneName(arm.bones, p.name.trim() || name, name) : name;
        const bones = arm.bones.map((b) => ({ ...b, head: [...b.head] as Vec3, tail: [...b.tail] as Vec3 }));
        const byName = new Map(bones.map((b) => [b.name, b]));
        const b = byName.get(name)!;
        const conv = spaceConverter(ctx, object.id, p.space);
        if (p.parent !== undefined) {
          if (p.parent === '') {
            b.parent = null;
            b.use_connect = false;
          } else {
            findBone(arm, p.parent);
            if (p.parent === name || boneDescendants(arm, name).has(p.parent))
              throw new OperatorError(
                `Bone '${p.parent}' is '${name}' or one of its children`,
                'INVALID_PARAMS',
              );
            b.parent = p.parent;
          }
        }
        if (p.use_connect !== undefined) {
          if (p.use_connect && !b.parent)
            throw new OperatorError('use_connect needs a parent bone', 'INVALID_PARAMS');
          b.use_connect = p.use_connect;
        }
        const moveConnectedHeads = (parentName: string, to: Vec3) => {
          for (const c of bones) if (c.parent === parentName && c.use_connect) c.head = [...to];
        };
        if (p.head) {
          const h = conv.point(p.head as Vec3);
          if (b.use_connect && b.parent) {
            // the head is the parent's tail: move both (and the parent's other connected children)
            const par = byName.get(b.parent)!;
            par.tail = [...h];
            moveConnectedHeads(par.name, h);
          }
          b.head = h;
        }
        if (b.use_connect && b.parent) b.head = [...byName.get(b.parent)!.tail];
        if (p.tail) {
          b.tail = conv.point(p.tail as Vec3);
          moveConnectedHeads(name, b.tail);
        }
        if (p.roll !== undefined) b.roll = p.roll;
        if (p.align_roll) b.roll = rollFromZAxis(b.head, b.tail, conv.dir(p.align_roll as Vec3));
        if (p.use_deform !== undefined) b.use_deform = p.use_deform;
        for (const k of ['envelope_distance', 'envelope_weight', 'head_radius', 'tail_radius'] as const)
          if (p[k] !== undefined) b[k] = p[k]!;
        for (const x of bones)
          if (len3(x.head, x.tail) < MIN_BONE_LENGTH)
            throw new OperatorError(`Bone '${x.name}' would have zero length`, 'INVALID_PARAMS');
        let final = bones;
        if (newName !== name) {
          // renames the bone and every reference to it (animation, groups, constraints…)
          renameBone(ctx.doc, arm.id, name, newName);
          const rn = (n: string | null) => (n === name ? newName : n);
          final = bones.map((x) => ({ ...x, name: rn(x.name)!, parent: rn(x.parent) }));
        }
        writeBones(ctx, ctx.doc.getArmature(arm.id)!, final);
        const result = final.find((x) => x.name === newName)!;
        return { object: object.id, bone: newName, ...boneSummary(result) };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'armature.bone_remove',
      label: 'Delete Bones',
      description:
        "Delete bones from an armature. Their children are re-parented to the deleted bone's parent (unconnected, " +
        'staying in place); pose channels and their animation curves are removed. Vertex groups are kept.',
      category: 'Armature',
      schema: z.object({
        object: objectRef(),
        bones: z.array(z.string().min(1)).min(1).describe('Names of the bones to delete'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        for (const n of p.bones) findBone(arm, n);
        const removed = removeBones(ctx.doc, arm.id, p.bones);
        return {
          object: object.id,
          removed,
          remaining: ctx.doc.getArmature(arm.id)!.bones.map((b) => b.name),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'armature.properties_set',
      label: 'Armature Properties',
      description:
        'Set armature data properties: pose_position ("POSE" shows the pose, "REST" the rest pose without pose ' +
        'transforms or constraints), display_type (OCTAHEDRAL, STICK, BBONE, ENVELOPE, WIRE), show_names, show_axes.',
      category: 'Armature',
      schema: z.object({
        object: objectRef(),
        pose_position: z.enum(['POSE', 'REST']).optional().describe('Show the pose or the rest pose'),
        display_type: z
          .enum(['OCTAHEDRAL', 'STICK', 'BBONE', 'ENVELOPE', 'WIRE'])
          .optional()
          .describe('Bone display'),
        show_names: z.boolean().optional().describe('Show bone names in the viewport'),
        show_axes: z.boolean().optional().describe('Show bone axes in the viewport'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        const { object: _o, ...patch } = p;
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(clean).length) ctx.doc.updateArmature(arm.id, clean);
        const a = ctx.doc.getArmature(arm.id)!;
        return {
          object: object.id,
          pose_position: a.pose_position,
          display_type: a.display_type,
          show_names: a.show_names,
          show_axes: a.show_axes,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'armature.describe',
      label: 'Describe Armature',
      description:
        'Read-only: list the bones of an armature with their hierarchy, rest head/tail/roll and rest x_axis / z_axis ' +
        '(armature space; Y runs from head to tail), pose ' +
        'channels (location/rotation_euler/scale), bone constraints, IK settings (ik_settings: locks, limits, ' +
        'stiffness; null when none) and the evaluated posed head/tail in world space ' +
        'at the current (or given) frame, plus pose evaluation problems. Use it to verify a rig.',
      category: 'Armature',
      undo: false,
      schema: z.object({
        object: objectRef(),
        frame: z.number().optional().describe('Frame to evaluate (default: the current frame)'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        const fs = new FrameState(ctx.doc, p.frame ?? ctx.state.frame);
        const pose = fs.pose(object.id);
        const world = fs.world(object.id) ?? ctx.doc.worldMatrix(object.id);
        const animated = fs.byId.get(object.id) ?? object;
        const name = (id: string | null) => (id ? (ctx.doc.getObject(id)?.name ?? id) : null);
        return {
          object: object.id,
          name: object.name,
          armature: arm.name,
          pose_position: arm.pose_position,
          bones: arm.bones.map((b) => {
            const pb = ownChannel(animated.pose?.bones, b.name) ?? defaultPoseBone();
            const ev = pose?.bones.get(b.name);
            return {
              ...boneSummary(b),
              // rest axes in armature space: rotating about X tilts the tail towards +Z, about Z towards −X
              ...(ev
                ? {
                    x_axis: roundVec([ev.rest[0], ev.rest[1], ev.rest[2]]),
                    z_axis: roundVec([ev.rest[8], ev.rest[9], ev.rest[10]]),
                  }
                : {}),
              children: arm.bones.filter((c) => c.parent === b.name).map((c) => c.name),
              location: roundVec(pb.location),
              rotation_euler: roundVec(pb.rotation_euler),
              scale: roundVec(pb.scale),
              ...(ev
                ? {
                    posed_head_world: roundVec(transformPoint3(world, ev.head)),
                    posed_tail_world: roundVec(transformPoint3(world, ev.tail)),
                  }
                : {}),
              constraints: (pb.constraints ?? []).map((c) => ({
                id: c.id,
                name: c.name,
                type: c.type,
                target: name(c.target),
                subtarget: c.subtarget,
                influence: c.influence,
                mute: c.mute,
                params: c.params,
              })),
              // IK locks / limits / stiffness (pose.ik_settings_set), null when the bone has none
              ik_settings: ikSettingsOf(pb) ? ikSettingsSummary(pb) : null,
            };
          }),
          errors: pose?.errors ?? [],
        };
      },
    }),
  );
}

function registerPoseOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'pose.bone_transform_set',
      label: 'Set Bone Transform',
      description:
        'Pose a bone: set its location (metres), rotation_euler (radians, XYZ order) and/or scale relative to the ' +
        "rest pose, in the bone's own axes (Y = along the bone, head → tail; rotating about X or Z bends it, about Y " +
        'twists it). Children follow. Connected bones ignore location. Only given channels change. keyframe=true ' +
        'also inserts keyframes for the given channels at `frame` (default: the current frame); without it, ' +
        'channels that are already animated are re-keyed at the current frame so the change stays visible.',
      category: 'Pose',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        bone: boneRef,
        location: vec3.optional().describe('Translation in metres along the bone axes'),
        rotation_euler: vec3.optional().describe('Euler XYZ rotation in radians about the bone axes'),
        scale: vec3.optional().describe('Scale along the bone axes'),
        keyframe: z.boolean().default(false).describe('Insert keyframes for the given channels'),
        frame: z.number().optional().describe('Frame for keyframe=true (default: the current frame)'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        findBone(arm, p.bone);
        const pb = poseChannel(object, p.bone);
        const channels: string[] = [];
        if (p.location) {
          pb.location = [...p.location] as Vec3;
          channels.push('location');
        }
        if (p.rotation_euler) {
          pb.rotation_euler = [...p.rotation_euler] as Vec3;
          channels.push('rotation_euler');
        }
        if (p.scale) {
          pb.scale = [...p.scale] as Vec3;
          channels.push('scale');
        }
        writePoseChannel(ctx, object, p.bone, pb);
        const paths = channels.map((c) => poseBonePath(p.bone, c));
        let keyframes = 0;
        if (p.keyframe)
          for (const path of paths)
            keyframes += keyProperty(ctx, 'object', object.id, path, p.frame ?? ctx.state.frame);
        else rekeyAnimated(ctx, 'object', object.id, paths);
        return {
          object: object.id,
          bone: p.bone,
          location: pb.location,
          rotation_euler: pb.rotation_euler,
          scale: pb.scale,
          keyframes_inserted: keyframes,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'pose.transforms_clear',
      label: 'Clear Pose Transforms',
      description:
        'Reset pose channels to the rest pose (location 0, rotation 0, scale 1) for the given bones (default: all ' +
        'bones). type limits it to LOCATION, ROTATION or SCALE. Animated channels are re-keyed at the current frame.',
      category: 'Pose',
      schema: z.object({
        object: objectRef(),
        bones: z.array(z.string().min(1)).optional().describe('Bone names (default: all bones)'),
        type: z.enum(['ALL', 'LOCATION', 'ROTATION', 'SCALE']).default('ALL').describe('Channels to clear'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        const names = p.bones ?? arm.bones.map((b) => b.name);
        for (const n of names) findBone(arm, n);
        const cur = ctx.doc.getObject(object.id)!;
        const bones = new Map(Object.entries(cur.pose?.bones ?? {}));
        const channels =
          p.type === 'ALL'
            ? ['location', 'rotation_euler', 'scale']
            : [p.type === 'LOCATION' ? 'location' : p.type === 'ROTATION' ? 'rotation_euler' : 'scale'];
        const paths: string[] = [];
        for (const n of names) {
          const pb = cloneJson(bones.get(n) ?? defaultPoseBone());
          if (channels.includes('location')) pb.location = [0, 0, 0];
          if (channels.includes('rotation_euler')) pb.rotation_euler = [0, 0, 0];
          if (channels.includes('scale')) pb.scale = [1, 1, 1];
          bones.set(n, pb);
          // only the cleared channels are re-keyed (the others keep their animation untouched)
          for (const c of channels) paths.push(poseBonePath(n, c));
        }
        ctx.doc.updateObject(object.id, { pose: { ...cur.pose, bones: Object.fromEntries(bones) } });
        rekeyAnimated(ctx, 'object', object.id, paths);
        return { object: object.id, cleared: names, channels };
      },
    }),
  );

  const constraintTypeList = BONE_CONSTRAINT_TYPES.join(', ');

  reg.register(
    defineOperator({
      id: 'pose.ik_add',
      label: 'Add IK',
      description:
        'Add an inverse kinematics constraint to a bone so the chain ending at it reaches a target: an object ' +
        '(`target`), or a bone (`subtarget`) of `target` (an armature) or — when `target` is omitted — of this ' +
        'armature (typical "IK control bone"). chain_count = number of bones driven, counted from this bone up (0 = ' +
        'all the way to the root; use 2 for an arm or leg). pole_target/pole_subtarget set the bend direction: the ' +
        "chain root's X axis, rotated by pole_angle (radians) towards its Z axis, faces the pole (try ±π/2 if a " +
        "knee/elbow points sideways). A perfectly straight chain bends towards the pole (or its root's -Z axis). " +
        'Returns the constraint id/name and the bones of the chain.',
      category: 'Pose',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        bone: boneRef.describe('Bone that gets the IK constraint (the end of the chain)'),
        target: z
          .string()
          .optional()
          .describe('Target object id or name (omit to target a bone of this armature)'),
        subtarget: z.string().default('').describe('Target bone (of `target`, or of this armature)'),
        chain_count: z
          .number()
          .int()
          .min(0)
          .max(255)
          .default(0)
          .describe('Bones in the chain (0 = up to the root)'),
        pole_target: z
          .string()
          .optional()
          .describe('Pole object id or name (omit with pole_subtarget for this armature)'),
        pole_subtarget: z.string().default('').describe('Pole bone (of `pole_target`, or of this armature)'),
        pole_angle: z.number().default(0).describe('Radians; see description'),
        iterations: z.number().int().min(1).max(10000).default(500).describe('Maximum solver iterations'),
        use_tail: z
          .boolean()
          .default(true)
          .describe("true: the bone's tail reaches the target; false: the chain ends at the bone's head"),
        use_stretch: z.boolean().default(false).describe('Stretch the chain when the target is out of reach'),
        influence: z
          .number()
          .min(0)
          .max(1)
          .default(1)
          .describe('Blend between the original pose (0) and the IK result (1)'),
        name: z.string().optional().describe('Constraint name (default "IK", made unique on the bone)'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        findBone(arm, p.bone);
        let target = resolveTargetId(ctx, p.target, 'Target');
        if (!target && !p.subtarget)
          throw new OperatorError('IK needs a `target` object and/or a `subtarget` bone', 'INVALID_PARAMS');
        if (!target) target = object.id;
        checkSubtarget(ctx, target, p.subtarget, 'Target');
        if (target === object.id && p.subtarget === p.bone)
          throw new OperatorError('A bone cannot be its own IK target', 'INVALID_PARAMS');
        let pole = resolveTargetId(ctx, p.pole_target, 'Pole target');
        if (!pole && p.pole_subtarget) pole = object.id;
        const chain = ikChain(arm, p.bone, p.chain_count, p.use_tail);
        if (!chain.length)
          throw new OperatorError(
            `Bone '${p.bone}' has no parent, so use_tail=false leaves no chain`,
            'INVALID_PARAMS',
          );
        if (target === object.id && p.subtarget) {
          const dependent = chain.some((b) => b === p.subtarget || boneDescendants(arm, b).has(p.subtarget));
          if (dependent)
            throw new OperatorError(
              `Target bone '${p.subtarget}' is part of (or a child of) the IK chain ${chain.join(' → ')}`,
              'INVALID_PARAMS',
            );
        }
        const params = validateConstraintParams(
          ctx,
          object.id,
          'IK',
          {},
          {
            chain_count: p.chain_count,
            pole_target: pole,
            pole_subtarget: p.pole_subtarget,
            pole_angle: p.pole_angle,
            iterations: p.iterations,
            use_tail: p.use_tail,
            use_stretch: p.use_stretch,
          },
        );
        const c = addBoneConstraint(ctx, object, p.bone, 'IK', {
          name: p.name,
          target,
          subtarget: p.subtarget,
          influence: p.influence,
          params,
        });
        return { object: object.id, bone: p.bone, constraint: c.id, name: c.name, chain };
      },
    }),
  );

  const ikAxis = (a: 'X' | 'Y' | 'Z', what: string) =>
    `${what} the bone's local ${a} axis (${a === 'Y' ? 'Y runs along the bone, head → tail: twist' : `${a} bends the bone`})`;
  const ikSettingsShape = Object.fromEntries(
    (['x', 'y', 'z'] as const).flatMap((a) => {
      const A = a.toUpperCase() as 'X' | 'Y' | 'Z';
      return [
        [`lock_ik_${a}`, z.boolean().optional().describe(ikAxis(A, 'IK may not rotate the bone about'))],
        [
          `use_ik_limit_${a}`,
          z
            .boolean()
            .optional()
            .describe(`Limit the IK rotation about local ${A} to [ik_min_${a}, ik_max_${a}]`),
        ],
        [
          `ik_min_${a}`,
          z
            .number()
            .min(-Math.PI)
            .max(0)
            .optional()
            .describe(`Radians (−π … 0, default −π): smallest rotation about local ${A}, from the rest pose`),
        ],
        [
          `ik_max_${a}`,
          z
            .number()
            .min(0)
            .max(Math.PI)
            .optional()
            .describe(`Radians (0 … π, default π): largest rotation about local ${A}, from the rest pose`),
        ],
        [
          `ik_stiffness_${a}`,
          z
            .number()
            .min(0)
            .max(0.99)
            .optional()
            .describe(
              `0 … 0.99 (default 0): resistance to rotating about local ${A}; other bones move more instead`,
            ),
        ],
      ];
    }),
  ) as Record<string, z.ZodOptional<z.ZodBoolean> | z.ZodOptional<z.ZodNumber>>;

  reg.register(
    defineOperator({
      id: 'pose.ik_settings_set',
      label: 'Set Bone IK Settings',
      description:
        "Set a pose bone's inverse kinematics settings (Blender Bone properties > Inverse Kinematics), used by " +
        "every IK chain that contains the bone. Axes are the bone's own: Y runs along the bone (head → tail, " +
        'twist), X and Z bend it. lock_ik_x/y/z: the solver may not rotate the bone about that axis (e.g. a ' +
        "robot's vertical base bone that may only yaw: lock_ik_x and lock_ik_z; a hinge: lock two axes). " +
        'use_ik_limit_x/y/z with ik_min_* (−π … 0) and ik_max_* (0 … π): keep the rotation about that axis, ' +
        'measured from the rest pose (swing about X/Z, twist about Y), within range; a positive angle about X tilts ' +
        "the tail towards the bone's +Z axis, about Z towards its −X axis (armature.describe lists every bone's " +
        'rest x_axis and z_axis). ik_stiffness_x/y/z (0 … ' +
        '0.99): the bone resists rotating about that axis, so other bones take more of the motion. Only the ' +
        'settings passed change. Chains with such bones are solved with a damped least-squares solver (FABRIK ' +
        'otherwise); a pole target is ignored when the chain root itself is locked, limited or stiff. Returns ' +
        'every IK setting of the bone and the IK constraints whose chains contain it (a warning when none does: ' +
        'the settings only matter inside an IK chain).',
      category: 'Pose',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        bone: boneRef.describe('Bone whose IK settings change'),
        ...ikSettingsShape,
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        findBone(arm, p.bone);
        const pb = poseChannel(object, p.bone) as PoseBone & Record<string, unknown>;
        const changed: string[] = [];
        for (const key of Object.keys(ikSettingsShape)) {
          const v = (p as Record<string, unknown>)[key];
          if (v === undefined) continue;
          pb[key] = v;
          changed.push(key);
        }
        if (!changed.length)
          throw new OperatorError(
            `Nothing to set: pass at least one of ${Object.keys(ikSettingsShape).join(', ')}`,
            'INVALID_PARAMS',
          );
        for (const a of ['x', 'y', 'z'] as const) {
          const min = pb[`ik_min_${a}`];
          const max = pb[`ik_max_${a}`];
          if (pb[`use_ik_limit_${a}`] && min === undefined && max === undefined)
            ctx.report(
              'WARNING',
              `'${p.bone}': use_ik_limit_${a} without ik_min_${a} / ik_max_${a} allows −π … π (no limit yet)`,
            );
          if (
            !pb[`use_ik_limit_${a}`] &&
            (changed.includes(`ik_min_${a}`) || changed.includes(`ik_max_${a}`))
          )
            ctx.report(
              'WARNING',
              `'${p.bone}': ik_min_${a} / ik_max_${a} only apply with use_ik_limit_${a}: true`,
            );
        }
        writePoseChannel(ctx, object, p.bone, pb);
        const chains = chainsContaining(ctx.doc.getObject(object.id)!, arm, p.bone);
        if (!chains.length)
          ctx.report(
            'WARNING',
            `'${p.bone}' is not part of any IK chain yet: the settings take effect once an IK constraint ` +
              '(pose.ik_add) includes it',
          );
        return { object: object.id, bone: p.bone, changed, ik_settings: ikSettingsSummary(pb), chains };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'pose.constraint_add',
      label: 'Add Bone Constraint',
      description:
        `Add a constraint to a pose bone. type: ${constraintTypeList}. Targets: \`target\` object (id or name), ` +
        'with `subtarget` = a bone of that armature (omit `target` to use a bone of this armature). Type parameters ' +
        "use Blender's names (e.g. COPY_ROTATION use_x/mix_mode/owner_space, DAMPED_TRACK track_axis, " +
        'LIMIT_ROTATION use_limit_x/min_x/max_x in radians with owner_space LOCAL by default, IK as in pose.ik_add). ' +
        'Constraints apply in stack order after the bone transform. Returns the constraint id and unique name.',
      category: 'Pose',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        bone: boneRef,
        type: z
          .enum(BONE_CONSTRAINT_TYPES as [BoneConstraintType, ...BoneConstraintType[]])
          .describe('Constraint type'),
        name: z
          .string()
          .optional()
          .describe('Constraint name (default: the type label, made unique on the bone)'),
        target: z.string().optional().describe('Target object id or name'),
        subtarget: z.string().default('').describe('Target bone (of `target`, or of this armature)'),
        influence: z.number().min(0).max(1).default(1).describe('Blend with the unconstrained result (0..1)'),
        params: z.record(z.string(), z.unknown()).optional().describe('Type parameters (Blender names)'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        findBone(arm, p.bone);
        let target = resolveTargetId(ctx, p.target, 'Target');
        if (!target && p.subtarget) target = object.id;
        checkSubtarget(ctx, target, p.subtarget, 'Target');
        if (p.type !== 'LIMIT_ROTATION' && !target)
          throw new OperatorError(
            `${p.type} needs a \`target\` object or a \`subtarget\` bone`,
            'INVALID_PARAMS',
          );
        const params = validateConstraintParams(ctx, object.id, p.type, {}, p.params ?? {});
        const c = addBoneConstraint(ctx, object, p.bone, p.type, {
          name: p.name,
          target,
          subtarget: p.subtarget,
          influence: p.influence,
          params,
        });
        return { object: object.id, bone: p.bone, constraint: c.id, name: c.name };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'pose.constraint_set',
      label: 'Edit Bone Constraint',
      description:
        'Change a pose bone constraint (id or name): name (animation follows), influence (0..1), mute, target ' +
        '(object id/name; "" removes the target and its sub-target bone, so the constraint does nothing), subtarget ' +
        '(a bone of the target armature; with no target object: a bone of this armature) and type parameters ' +
        '(merged with the current ones and validated). keyframe=true inserts a keyframe on the influence at `frame` ' +
        '(default: the current frame), e.g. for IK/FK switching; without it an already animated influence is ' +
        're-keyed at the current frame so the change stays visible.',
      category: 'Pose',
      redoable: true,
      schema: z.object({
        object: objectRef(),
        bone: boneRef,
        constraint: z.string().describe('Constraint id or name'),
        name: z.string().min(1).optional().describe('New name (made unique on the bone)'),
        influence: z.number().min(0).max(1).optional().describe('Blend with the unconstrained result (0..1)'),
        mute: z.boolean().optional().describe('Disable the constraint'),
        target: z
          .string()
          .optional()
          .describe('Target object id or name ("" removes the target and its sub-target bone)'),
        subtarget: z
          .string()
          .optional()
          .describe('Target bone (of the target armature; of this armature when there is no target object)'),
        params: z.record(z.string(), z.unknown()).optional().describe('Parameter changes (Blender names)'),
        keyframe: z.boolean().default(false).describe('Insert a keyframe on the influence'),
        frame: z.number().optional().describe('Frame for keyframe=true (default: the current frame)'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        findBone(arm, p.bone);
        const pb = poseChannel(object, p.bone);
        const list = pb.constraints ?? [];
        const i = findConstraint(list, p.constraint, p.bone);
        const c = { ...list[i] };
        const oldName = c.name;
        if (p.name !== undefined)
          c.name = uniqueName(p.name, new Set(list.filter((_, k) => k !== i).map((x) => x.name)));
        if (p.influence !== undefined) c.influence = p.influence;
        if (p.mute !== undefined) c.mute = p.mute;
        if (p.target === '' && p.subtarget)
          throw new OperatorError(
            'target "" removes the target object and its sub-target bone; to use a bone of this armature, pass ' +
              'this armature as `target` (or only `subtarget` when the constraint has no target)',
            'INVALID_PARAMS',
          );
        if (p.target !== undefined) c.target = resolveTargetId(ctx, p.target, 'Target');
        // no target object: the sub-target bone goes too (a constraint without a target does nothing)
        if (p.target === '') c.subtarget = '';
        if (p.subtarget !== undefined) c.subtarget = p.subtarget;
        if (p.subtarget && !c.target) c.target = object.id;
        checkSubtarget(ctx, c.target, c.subtarget, 'Target');
        if (p.params) {
          const type = c.type as BoneConstraintType;
          if (!(BONE_CONSTRAINT_TYPES as string[]).includes(type))
            throw new OperatorError(`Constraint type ${c.type} is not supported on bones`, 'INVALID_PARAMS');
          c.params = validateConstraintParams(ctx, object.id, type, c.params ?? {}, p.params);
        }
        list[i] = c;
        writePoseChannel(ctx, object, p.bone, { ...pb, constraints: list });
        if (c.name !== oldName) renameConstraintCurves(ctx, object.id, p.bone, oldName, c.name);
        const path = constraintInfluencePath(p.bone, c.name);
        let keyframes = 0;
        if (p.keyframe) keyframes = keyProperty(ctx, 'object', object.id, path, p.frame ?? ctx.state.frame);
        else if (p.influence !== undefined) rekeyAnimated(ctx, 'object', object.id, [path]);
        return {
          object: object.id,
          bone: p.bone,
          constraint: c.id,
          name: c.name,
          influence: c.influence,
          keyframes_inserted: keyframes,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'pose.constraint_remove',
      label: 'Remove Bone Constraint',
      description:
        'Remove a constraint (id or name) from a pose bone, or all of its constraints with all=true.',
      category: 'Pose',
      schema: z.object({
        object: objectRef(),
        bone: boneRef,
        constraint: z.string().optional().describe('Constraint id or name'),
        all: z.boolean().default(false).describe('Remove every constraint of the bone'),
      }),
      execute(ctx, p) {
        const { object, arm } = armatureTarget(ctx, p.object);
        findBone(arm, p.bone);
        const pb = poseChannel(object, p.bone);
        const list = pb.constraints ?? [];
        let removed: string[];
        let rest: ConstraintData[];
        if (p.all) {
          removed = list.map((c) => c.name);
          rest = [];
        } else {
          if (!p.constraint) throw new OperatorError('Pass `constraint` (or all=true)', 'INVALID_PARAMS');
          const i = findConstraint(list, p.constraint, p.bone);
          removed = [list[i].name];
          rest = list.filter((_, k) => k !== i);
        }
        const next: PoseBone = { ...pb };
        if (rest.length) next.constraints = rest;
        else delete next.constraints;
        writePoseChannel(ctx, object, p.bone, next);
        // animation of the removed constraints (e.g. keyed influence) goes with them
        const kept = new Set(rest.map((c) => c.name));
        for (const name of removed) if (!kept.has(name)) removeConstraintCurves(ctx, object.id, p.bone, name);
        return { object: object.id, bone: p.bone, removed };
      },
    }),
  );
}

function addBoneConstraint(
  ctx: OperatorContext,
  object: ObjectData,
  bone: string,
  type: BoneConstraintType,
  init: {
    name?: string;
    target: string | null;
    subtarget: string;
    influence: number;
    params: Record<string, unknown>;
  },
): ConstraintData {
  const pb = poseChannel(object, bone);
  const list = pb.constraints ?? [];
  const c: ConstraintData = {
    id: newId(),
    name: uniqueName(init.name?.trim() || BONE_CONSTRAINT_LABELS[type], new Set(list.map((x) => x.name))),
    type,
    mute: false,
    influence: init.influence,
    target: init.target,
    subtarget: init.subtarget,
    show_expanded: true,
    params: init.params,
  };
  writePoseChannel(ctx, object, bone, { ...pb, constraints: [...list, c] });
  return c;
}

/** Data path of a pose bone constraint's influence, e.g. `pose.bones["Arm"].constraints["IK"].influence`. */
function constraintInfluencePath(bone: string, constraint: string): string {
  return poseBonePath(bone, `constraints[${JSON.stringify(constraint)}].influence`);
}

/** Prefix of the data paths of one pose bone constraint. */
function constraintPathPrefix(bone: string, constraint: string): string {
  return poseBonePath(bone, `constraints[${JSON.stringify(constraint)}]`);
}

/** Moves the F-curves of a renamed pose bone constraint to its new name. */
function renameConstraintCurves(
  ctx: OperatorContext,
  id: string,
  bone: string,
  from: string,
  to: string,
): void {
  const prefix = constraintPathPrefix(bone, from);
  for (const fc of ctx.doc.listFCurves(id)) {
    if (fc.target_type !== 'object' || !fc.path.startsWith(`${prefix}.`)) continue;
    ctx.doc.removeFCurve(fcurveKey(fc));
    ctx.doc.setFCurve({ ...fc, path: constraintPathPrefix(bone, to) + fc.path.slice(prefix.length) });
  }
}

/** Deletes the F-curves of a removed pose bone constraint. */
function removeConstraintCurves(ctx: OperatorContext, id: string, bone: string, name: string): void {
  const prefix = `${constraintPathPrefix(bone, name)}.`;
  for (const fc of ctx.doc.listFCurves(id))
    if (fc.target_type === 'object' && fc.path.startsWith(prefix)) ctx.doc.removeFCurve(fcurveKey(fc));
}

function registerVertexGroupOperators(reg: OperatorRegistry): void {
  const meshRef = objectRef('Mesh object');
  const groupRef = z.string().min(1).describe('Vertex group name');
  const indicesParam = z
    .array(z.number().int().min(0))
    .optional()
    .describe('Vertex indices (default: the edit-mode selection in Edit Mode, else every vertex)');

  reg.register(
    defineOperator({
      id: 'object.vertex_group_add',
      label: 'Add Vertex Group',
      description:
        'Add an empty vertex group (per-vertex weights 0..1) to a mesh. Groups named like deform bones drive the ' +
        'Armature modifier. Returns the unique group name and its index.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        name: z.string().min(1).default('Group').describe('Group name (made unique)'),
      }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        const name = uniqueName(p.name, new Set(groups.map((g) => g.name)));
        groups.push({ name, weights: encodeFloat32(new Float32Array(n)) });
        ctx.doc.setVertexGroups(meshId, groups);
        return { object: object.id, group: name, index: groups.length - 1 };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_remove',
      label: 'Remove Vertex Group',
      description: 'Delete a vertex group of a mesh (or every group with all=true).',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        group: z.string().optional().describe('Vertex group name'),
        all: z.boolean().default(false).describe('Remove every vertex group'),
      }),
      execute(ctx, p) {
        const { object, meshId } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        if (p.all) {
          ctx.doc.setVertexGroups(meshId, []);
          return { object: object.id, removed: groups.map((g) => g.name) };
        }
        if (!p.group) throw new OperatorError('Pass `group` (or all=true)', 'INVALID_PARAMS');
        const i = findGroup(groups, p.group, object.name);
        ctx.doc.setVertexGroups(
          meshId,
          groups.filter((_, k) => k !== i),
        );
        return { object: object.id, removed: [p.group] };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_assign',
      label: 'Assign to Vertex Group',
      description:
        'Assign vertices to a vertex group with a weight (0..1). The group is created if it does not exist. ' +
        'type REPLACE sets the weight, ADD/SUBTRACT change it (clamped to 0..1). Vertices default to the ' +
        'edit-mode selection in Edit Mode, else all vertices. Returns the number of vertices assigned.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        group: groupRef,
        indices: indicesParam,
        weight: z.number().min(0).max(1).default(1).describe('Weight 0..1'),
        type: z.enum(['REPLACE', 'ADD', 'SUBTRACT']).default('REPLACE').describe('How the weight is applied'),
      }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        let i = groups.findIndex((g) => g.name === p.group);
        if (i < 0) {
          groups.push({ name: p.group, weights: encodeFloat32(new Float32Array(n)) });
          i = groups.length - 1;
        }
        const w = groupWeights(groups[i], n);
        const verts = targetVertices(ctx, object, n, p.indices);
        for (const v of verts) {
          const cur = w[v];
          const next = p.type === 'REPLACE' ? p.weight : p.type === 'ADD' ? cur + p.weight : cur - p.weight;
          w[v] = Math.min(1, Math.max(0, next));
        }
        groups[i] = { name: groups[i].name, weights: encodeFloat32(w) };
        ctx.doc.setVertexGroups(meshId, groups);
        return { object: object.id, group: p.group, assigned: verts.length };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_remove_from',
      label: 'Remove from Vertex Group',
      description:
        'Remove vertices from a vertex group (weight 0). Vertices default to the edit-mode selection in Edit Mode, ' +
        'else all vertices.',
      category: 'Object',
      schema: z.object({ object: meshRef, group: groupRef, indices: indicesParam }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        const i = findGroup(groups, p.group, object.name);
        const w = groupWeights(groups[i], n);
        const verts = targetVertices(ctx, object, n, p.indices);
        for (const v of verts) w[v] = 0;
        groups[i] = { name: groups[i].name, weights: encodeFloat32(w) };
        ctx.doc.setVertexGroups(meshId, groups);
        return { object: object.id, group: p.group, removed: verts.length };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_set_weights',
      label: 'Set Vertex Weights',
      description:
        'Set the weights of a vertex group directly (created if missing). Either `weights` holds one value per ' +
        'vertex of the mesh, or `indices` + `weights` (same length) set only those vertices. Weights are 0..1.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        group: groupRef,
        weights: z
          .array(z.number().min(0).max(1))
          .describe('Weights (per vertex, or per entry of `indices`)'),
        indices: z.array(z.number().int().min(0)).optional().describe('Vertex indices matching `weights`'),
      }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        let i = groups.findIndex((g) => g.name === p.group);
        if (i < 0) {
          groups.push({ name: p.group, weights: encodeFloat32(new Float32Array(n)) });
          i = groups.length - 1;
        }
        const w = groupWeights(groups[i], n);
        if (p.indices) {
          if (p.indices.length !== p.weights.length)
            throw new OperatorError('`indices` and `weights` must have the same length', 'INVALID_PARAMS');
          p.indices.forEach((v, k) => {
            if (v >= n)
              throw new OperatorError(
                `Vertex index ${v} out of range (mesh has ${n} vertices)`,
                'INVALID_PARAMS',
              );
            w[v] = p.weights[k];
          });
        } else {
          if (p.weights.length !== n)
            throw new OperatorError(
              `\`weights\` has ${p.weights.length} values but the mesh has ${n} vertices (or pass \`indices\`)`,
              'INVALID_PARAMS',
            );
          w.set(p.weights);
        }
        groups[i] = { name: groups[i].name, weights: encodeFloat32(w) };
        ctx.doc.setVertexGroups(meshId, groups);
        return { object: object.id, group: p.group, set: p.indices ? p.indices.length : n };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_normalize_all',
      label: 'Normalize All Vertex Groups',
      description:
        "Scale every vertex's weights so they sum to 1 across the groups (vertices without weight stay at 0). " +
        'group_select_mode BONE_DEFORM only touches groups named like deform bones of the armatures deforming the ' +
        'mesh; `locked` groups keep their weights and the others share the remainder.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        group_select_mode: z.enum(['ALL', 'BONE_DEFORM']).default('ALL').describe('Which groups take part'),
        locked: z.array(z.string()).default([]).describe('Groups whose weights must not change'),
      }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        const deform = p.group_select_mode === 'BONE_DEFORM' ? deformBoneNames(ctx, object) : null;
        const active = groups.map((g) => !deform || deform.has(g.name));
        if (!active.some(Boolean)) return { object: object.id, groups: [], normalized: 0 };
        const locked = new Set(p.locked);
        const w = groups.map((g) => groupWeights(g, n));
        let normalized = 0;
        for (let v = 0; v < n; v++) {
          let lockedSum = 0;
          let free = 0;
          groups.forEach((g, i) => {
            if (!active[i]) return;
            if (locked.has(g.name)) lockedSum += w[i][v];
            else free += w[i][v];
          });
          if (free <= 0) continue;
          const target = Math.max(0, 1 - lockedSum);
          const f = target / free;
          if (Math.abs(f - 1) < 1e-7) continue;
          groups.forEach((g, i) => {
            if (active[i] && !locked.has(g.name)) w[i][v] *= f;
          });
          normalized++;
        }
        ctx.doc.setVertexGroups(
          meshId,
          groups.map((g, i) => ({ name: g.name, weights: encodeFloat32(w[i]) })),
        );
        return {
          object: object.id,
          groups: groups.filter((_, i) => active[i]).map((g) => g.name),
          normalized,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_normalize',
      label: 'Normalize Vertex Group',
      description: "Scale a vertex group's weights so its largest weight becomes 1.",
      category: 'Object',
      schema: z.object({ object: meshRef, group: groupRef }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        const i = findGroup(groups, p.group, object.name);
        const w = groupWeights(groups[i], n);
        let max = 0;
        for (const x of w) max = Math.max(max, x);
        if (max > 0) for (let v = 0; v < n; v++) w[v] /= max;
        groups[i] = { name: groups[i].name, weights: encodeFloat32(w) };
        ctx.doc.setVertexGroups(meshId, groups);
        return { object: object.id, group: p.group, max };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.vertex_group_rename',
      label: 'Rename Vertex Group',
      description: 'Rename a vertex group (e.g. to match a bone name). Returns the final unique name.',
      category: 'Object',
      schema: z.object({ object: meshRef, group: groupRef, name: z.string().min(1).describe('New name') }),
      execute(ctx, p) {
        const { object, meshId } = meshTarget(ctx, p.object);
        const groups = readGroups(ctx, meshId);
        const i = findGroup(groups, p.group, object.name);
        const name = uniqueName(p.name, new Set(groups.filter((_, k) => k !== i).map((g) => g.name)));
        groups[i] = { ...groups[i], name };
        ctx.doc.setVertexGroups(meshId, groups);
        for (const o of ctx.doc.listObjects()) {
          if (o.data !== meshId) continue;
          const mods = o.modifiers.map((m) =>
            m.params?.vertex_group === p.group ? { ...m, params: { ...m.params, vertex_group: name } } : m,
          );
          if (mods.some((m, k) => m !== o.modifiers[k])) ctx.doc.updateObject(o.id, { modifiers: mods });
        }
        return { object: object.id, group: name };
      },
    }),
  );
}

function registerShapeKeyOperators(reg: OperatorRegistry): void {
  const meshRef = objectRef('Mesh object');
  const keyRef = z.string().min(1).describe('Shape key name');

  reg.register(
    defineOperator({
      id: 'object.shape_key_add',
      label: 'Add Shape Key',
      description:
        'Add a shape key (morph target) to a mesh. The mesh itself is the basis; the new key starts as a copy of ' +
        'the basis (or, with from_mix=true, of the blend of all keys shown at the current frame). Edit it with ' +
        'object.shape_key_set_positions and blend it with object.shape_key_set(value). Returns the key name and index.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        name: z.string().optional().describe('Key name (default "Key N", made unique)'),
        from_mix: z
          .boolean()
          .default(false)
          .describe('Start from the current shape key mix instead of the basis'),
        value: z.number().min(-10).max(10).default(0).describe('Initial value (blend factor, usually 0..1)'),
        relative_key: z.string().default('').describe('Key this one is relative to ("" = the basis)'),
      }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        const mesh = ctx.doc.getMesh(meshId)!;
        const keys = ctx.doc.getShapeKeys(meshId);
        if (p.relative_key) findKey(keys, p.relative_key, object.name);
        // the mix as shown at the current frame (animated key values)
        const positions = p.from_mix
          ? applyShapeKeys(mesh, animatedShapeKeys(ctx, meshId)).mesh.positions
          : mesh.positions;
        const name = uniqueName(p.name?.trim() || `Key ${keys.length + 1}`, new Set(keys.map((k) => k.name)));
        const key: ShapeKeyData = {
          name,
          value: p.value,
          slider_min: 0,
          slider_max: 1,
          mute: false,
          relative_key: p.relative_key,
          data: encodeFloat32(positions.slice(0, n * 3)),
        };
        ctx.doc.setShapeKeys(meshId, [...keys, key]);
        return { object: object.id, key: name, index: keys.length };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.shape_key_remove',
      label: 'Remove Shape Key',
      description:
        'Remove a shape key (keys relative to it become relative to the basis) or all keys with all=true; ' +
        'apply_mix=true (with all) first bakes the blend shown at the current frame into the mesh. Animation of ' +
        'removed keys is deleted.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        key: z.string().optional().describe('Shape key name'),
        all: z.boolean().default(false).describe('Remove every shape key'),
        apply_mix: z
          .boolean()
          .default(false)
          .describe('With all=true: keep the current shape by applying the mix'),
      }),
      execute(ctx, p) {
        const { object, meshId } = meshTarget(ctx, p.object);
        const keys = ctx.doc.getShapeKeys(meshId);
        let removed: string[];
        let rest: ShapeKeyData[];
        if (p.all) {
          if (p.apply_mix && keys.length) {
            const mesh = ctx.doc.getMesh(meshId)!;
            const mixed = applyShapeKeys(mesh, animatedShapeKeys(ctx, meshId)).mesh;
            ctx.doc.setMesh(meshId, { ...ctx.doc.getMeshCopy(meshId)!, positions: mixed.positions.slice() });
          }
          removed = keys.map((k) => k.name);
          rest = [];
        } else {
          if (!p.key) throw new OperatorError('Pass `key` (or all=true)', 'INVALID_PARAMS');
          const i = findKey(keys, p.key, object.name);
          removed = [keys[i].name];
          rest = keys
            .filter((_, k) => k !== i)
            .map((k) => (k.relative_key === p.key ? { ...k, relative_key: '' } : k));
        }
        ctx.doc.setShapeKeys(meshId, rest);
        const gone = new Set(removed.map(shapeKeyPath));
        for (const fc of ctx.doc.listFCurves(meshId))
          if (fc.target_type === 'mesh' && gone.has(fc.path)) ctx.doc.removeFCurve(fcurveKey(fc));
        return { object: object.id, removed };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.shape_key_set',
      label: 'Set Shape Key',
      description:
        'Change a shape key: value (blend factor, clamped to [slider_min, slider_max] when evaluated), slider ' +
        'range (-10..10), mute, relative_key ("" = basis) or name (animation follows). keyframe=true inserts a ' +
        'keyframe on the value at `frame` (default: the current frame); without it an already animated value is ' +
        're-keyed at the current frame so the change stays visible.',
      category: 'Object',
      redoable: true,
      schema: z.object({
        object: meshRef,
        key: keyRef,
        value: z.number().min(-10).max(10).optional().describe('Blend factor'),
        slider_min: z.number().min(-10).max(10).optional().describe('Minimum value'),
        slider_max: z.number().min(-10).max(10).optional().describe('Maximum value'),
        mute: z.boolean().optional().describe('Disable the key'),
        relative_key: z.string().optional().describe('Key this one is relative to ("" = the basis)'),
        name: z.string().min(1).optional().describe('New name (made unique)'),
        keyframe: z.boolean().default(false).describe('Insert a keyframe on the value'),
        frame: z.number().optional().describe('Frame for keyframe=true (default: the current frame)'),
      }),
      execute(ctx, p) {
        const { object, meshId } = meshTarget(ctx, p.object);
        const keys = ctx.doc.getShapeKeys(meshId);
        const i = findKey(keys, p.key, object.name);
        const k = { ...keys[i] };
        if (p.slider_min !== undefined) k.slider_min = p.slider_min;
        if (p.slider_max !== undefined) k.slider_max = p.slider_max;
        if (k.slider_min > k.slider_max)
          throw new OperatorError('slider_min must not be greater than slider_max', 'INVALID_PARAMS');
        if (p.value !== undefined) k.value = p.value;
        if (p.mute !== undefined) k.mute = p.mute;
        if (p.relative_key !== undefined) {
          if (p.relative_key === k.name)
            throw new OperatorError('A key cannot be relative to itself', 'INVALID_PARAMS');
          if (p.relative_key) findKey(keys, p.relative_key, object.name);
          k.relative_key = p.relative_key;
        }
        let next = keys.slice();
        if (p.name !== undefined && p.name !== k.name) {
          const old = k.name;
          k.name = uniqueName(p.name, new Set(keys.filter((_, j) => j !== i).map((x) => x.name)));
          next = next.map((x) => (x.relative_key === old ? { ...x, relative_key: k.name } : x));
          for (const fc of ctx.doc.listFCurves(meshId))
            if (fc.target_type === 'mesh' && fc.path === shapeKeyPath(old)) {
              ctx.doc.removeFCurve(fcurveKey(fc));
              ctx.doc.setFCurve({ ...fc, path: shapeKeyPath(k.name) });
            }
        }
        next[i] = k;
        ctx.doc.setShapeKeys(meshId, next);
        let keyframes = 0;
        if (p.keyframe)
          keyframes = keyProperty(ctx, 'mesh', meshId, shapeKeyPath(k.name), p.frame ?? ctx.state.frame);
        else if (p.value !== undefined) rekeyAnimated(ctx, 'mesh', meshId, [shapeKeyPath(k.name)]);
        return {
          object: object.id,
          key: k.name,
          value: k.value,
          slider_min: k.slider_min,
          slider_max: k.slider_max,
          mute: k.mute,
          relative_key: k.relative_key,
          keyframes_inserted: keyframes,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.shape_key_set_positions',
      label: 'Set Shape Key Positions',
      description:
        'Sculpt a shape key numerically: set absolute vertex positions (`positions`, object local space, metres) ' +
        'or displacement `offsets` added to the basis mesh (offset_from="BASIS") or to the key\'s current positions ' +
        '(offset_from="KEY"). `indices` selects the vertices (same length as positions/offsets); without it the ' +
        'arrays cover every vertex in order. Returns the number of changed vertices.',
      category: 'Object',
      schema: z.object({
        object: meshRef,
        key: keyRef,
        indices: z.array(z.number().int().min(0)).optional().describe('Vertex indices'),
        positions: z.array(vec3).optional().describe('Absolute positions (object local space)'),
        offsets: z.array(vec3).optional().describe('Displacements in metres (object local space)'),
        offset_from: z.enum(['BASIS', 'KEY']).default('BASIS').describe('What `offsets` are added to'),
      }),
      execute(ctx, p) {
        const { object, meshId, n } = meshTarget(ctx, p.object);
        if (!!p.positions === !!p.offsets)
          throw new OperatorError('Pass exactly one of `positions` or `offsets`', 'INVALID_PARAMS');
        const values = (p.positions ?? p.offsets)!;
        const indices = p.indices ?? Array.from({ length: values.length }, (_, i) => i);
        if (indices.length !== values.length)
          throw new OperatorError(
            '`indices` and the positions/offsets must have the same length',
            'INVALID_PARAMS',
          );
        if (!p.indices && values.length !== n)
          throw new OperatorError(
            `Got ${values.length} values for a mesh with ${n} vertices (pass \`indices\` for a subset)`,
            'INVALID_PARAMS',
          );
        for (const v of indices)
          if (v >= n)
            throw new OperatorError(
              `Vertex index ${v} out of range (mesh has ${n} vertices)`,
              'INVALID_PARAMS',
            );
        const keys = ctx.doc.getShapeKeys(meshId);
        const i = findKey(keys, p.key, object.name);
        const data = keyPositions(keys[i], n);
        const basis = ctx.doc.getMesh(meshId)!.positions;
        indices.forEach((v, k) => {
          const val = values[k];
          for (let c = 0; c < 3; c++) {
            const base = p.positions ? 0 : p.offset_from === 'BASIS' ? basis[v * 3 + c] : data[v * 3 + c];
            data[v * 3 + c] = base + val[c];
          }
        });
        keys[i] = { ...keys[i], data: encodeFloat32(data) };
        ctx.doc.setShapeKeys(meshId, keys);
        return { object: object.id, key: p.key, changed: new Set(indices).size };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'object.shape_key_clear',
      label: 'Clear Shape Keys',
      description: 'Set the value of every shape key of a mesh to 0 (the mesh shows its basis shape).',
      category: 'Object',
      schema: z.object({ object: meshRef }),
      execute(ctx, p) {
        const { object, meshId } = meshTarget(ctx, p.object);
        const keys = ctx.doc.getShapeKeys(meshId);
        ctx.doc.setShapeKeys(
          meshId,
          keys.map((k) => ({ ...k, value: 0 })),
        );
        rekeyAnimated(
          ctx,
          'mesh',
          meshId,
          keys.map((k) => shapeKeyPath(k.name)),
        );
        return { object: object.id, cleared: keys.map((k) => k.name) };
      },
    }),
  );
}
