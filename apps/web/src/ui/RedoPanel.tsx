import { useState } from 'preact/hooks';
import { z } from 'zod';
import {
  CONSTRAINT_TYPES,
  FrameState,
  getConstraintTypeInfo,
  poseBonePath,
  resolveConstraintType,
  safeJsonSchema,
  transformPoint3,
  type AnimTargetType,
  type ConstraintData,
  type ConstraintTypeInfo,
  type Mat4,
  type ObjectData,
  type ParticleSystemData,
  type SceneDoc,
  type ShapeKeyData,
  type Vec3,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { registry } from '../editor/editor';
import { lastOperator, redoLast, type LastOperator } from '../editor/runner';
import { SchemaForm, type SchemaChoice } from './SchemaForm';
import { isRecord } from './properties/ObjectTab';
import { ikSettingValues, shapeKeyPath } from './properties/DataTab';
import { constraintPath } from './properties/ConstraintsTab';
import { animatedValue } from './properties/prop-edit';

type Params = Record<string, unknown>;

/**
 * Parameters the panel never shows: what the operation worked on (the selection, the edited
 * constraint or modifier) and panel state, like Blender's hidden operator properties.
 */
const HIDDEN = ['enter_editmode', 'name', 'objects', 'object'];
const HIDDEN_BY_OPERATOR: Record<string, readonly string[]> = {
  'constraint.update': ['constraint', 'show_expanded'],
  'object.modifier_set': ['modifier', 'show_expanded'],
  'object.particle_system_update': ['particle_system'],
  'pose.constraint_set': ['constraint'],
};

/** Operators whose `target` (and IK `pole_target`) are bone constraint targets. */
const POSE_TARGET_OPERATORS = new Set(['pose.constraint_add', 'pose.constraint_set', 'pose.ik_add']);

/** Object constraint types (Add Constraint's `type`) with Blender's names. */
const OBJECT_CONSTRAINT_CHOICES: SchemaChoice[] = CONSTRAINT_TYPES.filter((t) => !t.boneOnly).map((t) => ({
  value: t.type,
  label: t.label,
}));

/** An object picker parameter whose unset value means the active object (per its description). */
const ACTIVE_DEFAULT = /default:?\s*(the\s+)?active object/i;

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const schemas = new WeakMap<object, unknown>();
/** JSON schema of an operator's parameters (converted once per operator schema). */
function paramSchema(id: string): unknown {
  const def = registry.get(id);
  if (!def) return null;
  if (!schemas.has(def.schema)) schemas.set(def.schema, safeJsonSchema(def.schema));
  return schemas.get(def.schema);
}

/** The object a parameter refers to (id or name); unset: the active object the operation ran with. */
function objectOrActive(doc: SceneDoc, last: LastOperator, ref: unknown): ObjectData | null {
  const r = text(ref);
  if (r) return doc.resolveObject(r);
  return last.before.activeId ? doc.getObject(last.before.activeId) : null;
}

/** An entry of a stored list by id or else by name, as the operators look them up. */
function findEntry<T extends { id: string; name: string }>(list: unknown, ref: unknown): T | null {
  const items = (Array.isArray(list) ? list : []).filter(isRecord) as unknown as T[];
  return items.find((x) => x.id === ref) ?? items.find((x) => x.name === ref) ?? null;
}

/** What the run returned under `key` (a name or id of what it edited), when it is a string. */
function reported(last: LastOperator, key: string): string | null {
  const r = last.result;
  return isRecord(r) && typeof r[key] === 'string' ? r[key] : null;
}

/** The object the run reports it edited, else the one its parameters name (or the active one). */
function editedObject(doc: SceneDoc, last: LastOperator, params: Params): ObjectData | null {
  const id = reported(last, 'object');
  return (id && doc.getObject(id)) || objectOrActive(doc, last, params.object);
}

/**
 * The value of an animatable number at the current frame, as the Properties editor shows it
 * (prop-edit.ts `animatedValue`): its driver's or its F-curve's value, else `base`, the stored value.
 */
export type ValueAt = (type: AnimTargetType, id: string, path: string, index: number, base: number) => number;

/** The stored values (a form shown without a session, e.g. in tests). */
const STORED: ValueAt = (_type, _id, _path, _index, base) => base;

/**
 * The world matrix of an object where the scene shows it at the current frame (animation, a bone
 * or another parent, poses and constraints included), as the operators read it. Null: from the
 * stored values (a form shown without a session, e.g. in tests).
 */
export type WorldAt = ((id: string) => Mat4) | null;

/** Bone names of an armature object (empty for other objects). */
function boneNames(doc: SceneDoc, o: ObjectData | null): string[] {
  return o?.type === 'ARMATURE' && o.data ? (doc.getArmature(o.data)?.bones.map((b) => b.name) ?? []) : [];
}

/** The constraint type (and owner) an object constraint operation works with. */
function objectConstraint(
  doc: SceneDoc,
  last: LastOperator,
  params: Params,
): { info: ConstraintTypeInfo; owner: ObjectData | null; current: ConstraintData | null } | null {
  const owner = objectOrActive(doc, last, params.object);
  if (last.id === 'object.constraint_add') {
    const info = typeof params.type === 'string' ? resolveConstraintType(params.type) : undefined;
    return info ? { info, owner, current: null } : null;
  }
  if (last.id === 'constraint.update') {
    const current = findEntry<ConstraintData>(owner?.constraints, params.constraint);
    const info = current ? getConstraintTypeInfo(current.type) : undefined;
    return info ? { info, owner, current } : null;
  }
  return null;
}

/** Whether a constraint of type `info` on `owner` accepts `target` (the operators reject the rest). */
function acceptsTarget(info: ConstraintTypeInfo, owner: ObjectData | null, target: ObjectData): boolean {
  return (
    info.target !== 'NONE' &&
    target.id !== owner?.id &&
    (!info.targetObjectType || target.type === info.targetObjectType)
  );
}

/**
 * The shape key Set Shape Key edited, under the name the run reports (a rename in the same call
 * makes the name unique), the mesh it belongs to and the mesh's keys.
 */
function shapeKeyOf(
  doc: SceneDoc,
  last: LastOperator,
  params: Params,
): { key: ShapeKeyData | null; keys: ShapeKeyData[]; meshId: string | null } {
  const o = editedObject(doc, last, params);
  const meshId = o?.type === 'MESH' && o.data ? o.data : null;
  const keys = meshId ? doc.getShapeKeys(meshId) : [];
  const named = (n: unknown) => keys.find((k) => k.name === n) ?? null;
  // without a report: the key asked for, or the one renamed to the new name
  const name = reported(last, 'key');
  const key = name !== null ? named(name) : (named(params.key) ?? named(text(params.name)?.trim()));
  return { key, keys, meshId };
}

/**
 * What the operator keeps for parameters left unset ("only given values change"): the current
 * state of what it edits, shown instead of a default, as the Properties editor shows it: the
 * stored values, and for the numbers it shows at the current frame when they are animated (a pose
 * bone's transform, a constraint's influence, a shape key's value) their value there (`at`).
 * Editing one component of such a vector keeps the others as they are shown. The Properties
 * editor and the outliner run these operators with only the field that changed.
 */
function keptValues(
  doc: SceneDoc,
  last: LastOperator,
  params: Params,
  at: ValueAt,
  worldAt: WorldAt,
): Params {
  switch (last.id) {
    case 'pose.bone_transform_set': {
      const o = objectOrActive(doc, last, params.object);
      const bones = o?.pose?.bones;
      const name = String(params.bone ?? '');
      const pb = bones && Object.hasOwn(bones, name) ? bones[name] : undefined;
      // at the current frame, as the bone's Pose panel shows them
      const channel = (c: 'location' | 'rotation_euler' | 'scale', rest: number[]) => {
        const v = pb?.[c] ?? rest;
        return o ? v.map((x, i) => at('object', o.id, poseBonePath(name, c), i, x)) : v;
      };
      return {
        location: channel('location', [0, 0, 0]),
        rotation_euler: channel('rotation_euler', [0, 0, 0]),
        scale: channel('scale', [1, 1, 1]),
      };
    }
    case 'pose.ik_settings_set': {
      // the bone's IK settings as its Inverse Kinematics panel shows them (Blender's defaults for
      // a bone without any)
      const bones = objectOrActive(doc, last, params.object)?.pose?.bones;
      const name = String(params.bone ?? '');
      return ikSettingValues(bones && Object.hasOwn(bones, name) ? bones[name] : undefined);
    }
    case 'armature.bone_update': {
      const o = editedObject(doc, last, params);
      const bones = o?.type === 'ARMATURE' && o.data ? (doc.getArmature(o.data)?.bones ?? []) : [];
      const named = (n: unknown) => bones.find((b) => b.name === n);
      // under the name the run reports (a rename in the same call makes the name unique); without
      // a report, the bone asked for or the one renamed to the new name
      const name = reported(last, 'bone');
      const bone = name !== null ? named(name) : (named(params.bone) ?? named(text(params.name)?.trim()));
      if (!o || !bone) return {};
      // in world space where the armature is at the current frame, as the operator converts them
      const world = params.space === 'WORLD' ? (worldAt ?? ((id) => doc.worldMatrix(id)))(o.id) : null;
      const point = (p: Vec3) => (world ? transformPoint3(world, p) : [...p]);
      // the rest of what the Bone panel shows: parent, Connected, Deform; and the envelope
      return {
        head: point(bone.head),
        tail: point(bone.tail),
        roll: bone.roll,
        parent: bone.parent ?? '',
        use_connect: bone.use_connect,
        use_deform: bone.use_deform,
        envelope_distance: bone.envelope_distance,
        envelope_weight: bone.envelope_weight,
        head_radius: bone.head_radius,
        tail_radius: bone.tail_radius,
      };
    }
    case 'object.shape_key_set': {
      // the key's settings as the Shape Keys panel shows them (the value at the current frame)
      const { key: k, meshId } = shapeKeyOf(doc, last, params);
      return k && meshId
        ? {
            value: at('mesh', meshId, shapeKeyPath(k.name), 0, k.value),
            slider_min: k.slider_min,
            slider_max: k.slider_max,
            mute: k.mute,
            relative_key: k.relative_key,
          }
        : {};
    }
    case 'object.particle_system_update': {
      // the system's visibility as the Particles tab and the outliner show it; the system is the
      // one the run reports (without `particle_system` the operator edits an object's only one)
      const systems = editedObject(doc, last, params)?.particle_systems ?? [];
      const ref = reported(last, 'particle_system') ?? text(params.particle_system);
      const ps = ref
        ? findEntry<ParticleSystemData>(systems, ref)
        : systems.length === 1 && isRecord(systems[0])
          ? systems[0]
          : null;
      return ps ? { show_viewport: ps.show_viewport, show_render: ps.show_render } : {};
    }
    case 'constraint.update': {
      const ctx = objectConstraint(doc, last, params);
      const c = ctx?.current;
      if (!c) return {};
      // the influence at the current frame, as the Constraints tab shows it
      const influence = ctx.owner
        ? at('object', ctx.owner.id, constraintPath(c, 'influence'), 0, c.influence)
        : c.influence;
      return { target: c.target ?? undefined, subtarget: c.subtarget, influence, mute: c.mute };
    }
    case 'pose.constraint_set': {
      const o = objectOrActive(doc, last, params.object);
      const bones = o?.pose?.bones;
      const name = String(params.bone ?? '');
      const pb = bones && Object.hasOwn(bones, name) ? bones[name] : undefined;
      const c = findEntry<ConstraintData>(pb?.constraints, params.constraint);
      if (!o || !c) return {};
      // the influence at the current frame, as the bone's constraint panel shows it
      const path = poseBonePath(name, `constraints[${JSON.stringify(c.name)}].influence`);
      const influence = at('object', o.id, path, 0, c.influence);
      return { target: c.target ?? undefined, subtarget: c.subtarget, influence, mute: c.mute };
    }
    case 'object.modifier_set': {
      const m = findEntry<{ id: string; name: string } & Params>(
        objectOrActive(doc, last, params.object)?.modifiers,
        params.modifier,
      );
      return m
        ? { show_viewport: m.show_viewport, show_render: m.show_render, show_in_editmode: m.show_in_editmode }
        : {};
    }
  }
  return {};
}

/** The Adjust Last Operation form of an operation: which parameters show, and how. */
export interface RedoForm {
  /** The operation's parameters, plus what the operator used for unset ones when that is known. */
  values: Params;
  exclude: string[];
  /** Extra parameters that hold object references (shown as object pickers). */
  objectKeys: string[];
  choices: Record<string, SchemaChoice[]>;
  /** Whether an object picker lists an object: never one the operator would reject. */
  objectFilter: (key: string, o: ObjectData) => boolean;
  /** Labels of the empty choice of object pickers whose unset value means something else than none. */
  emptyLabels: Record<string, string>;
}

/**
 * The form for adjusting `last`: its parameters with the values the operator kept or computed
 * for unset ones (animated numbers at the current frame, from `at`), and pickers that only offer
 * what the operator accepts. Objects the operation created are never offered: adjusting it undoes
 * it first, which deletes them.
 */
export function redoForm(
  doc: SceneDoc,
  last: LastOperator,
  at: ValueAt = STORED,
  worldAt: WorldAt = null,
): RedoForm {
  const params = (last.params ?? {}) as Params;
  const props = (paramSchema(last.id) as { properties?: Record<string, unknown> } | null)?.properties;
  const values: Params = { ...params };
  for (const [k, v] of Object.entries(keptValues(doc, last, params, at, worldAt)))
    if (values[k] === undefined) values[k] = v;
  const exclude = [...HIDDEN, ...(HIDDEN_BY_OPERATOR[last.id] ?? [])];
  const objectKeys: string[] = [];
  const choices: Record<string, SchemaChoice[]> = {};
  const emptyLabels: Record<string, string> = {};
  const created = new Set(last.created);
  const rules: ((key: string, o: ObjectData) => boolean)[] = [(_k, o) => !created.has(o.id)];
  const resolveId = (ref: unknown) => {
    const r = text(ref);
    return r ? (doc.resolveObject(r)?.id ?? null) : null;
  };

  // object pickers whose unset value means the active object show that object
  for (const [k, raw] of Object.entries(props ?? {})) {
    const description = isRecord(raw) ? String(raw.description ?? '') : '';
    if (values[k] === undefined && ACTIVE_DEFAULT.test(description) && k !== 'object' && last.before.activeId)
      values[k] = last.before.activeId;
  }

  if (last.id === 'object.align') objectKeys.push('active');

  if (last.id === 'object.shape_key_set') {
    // Relative To as in the Shape Keys panel: the basis or another key of the mesh
    const { key, keys } = shapeKeyOf(doc, last, params);
    choices.relative_key = [
      { value: '', label: 'Basis' },
      ...keys.filter((k) => k !== key).map((k) => ({ value: k.name, label: k.name })),
    ];
  }

  if (last.id === 'object.constraint_add' || last.id === 'constraint.update') {
    if (last.id === 'object.constraint_add') {
      choices.type = OBJECT_CONSTRAINT_CHOICES;
      const info = text(params.type) ? resolveConstraintType(String(params.type)) : undefined;
      if (info) values.type = info.type;
    }
    const ctx = objectConstraint(doc, last, values);
    if (ctx?.info.target === 'NONE') exclude.push('target', 'subtarget');
    else if (ctx) {
      const { info, owner } = ctx;
      const bone = text(values.subtarget);
      rules.push(
        (k, o) =>
          k !== 'target' || (acceptsTarget(info, owner, o) && (!bone || boneNames(doc, o).includes(bone))),
      );
      const bones = info.boneSubtarget ? boneNames(doc, doc.getObject(resolveId(values.target) ?? '')) : [];
      if (bones.length)
        choices.subtarget = [{ value: '', label: '— none —' }, ...bones.map((b) => ({ value: b, label: b }))];
      else if (!bone) exclude.push('subtarget');
    }
  }

  if (POSE_TARGET_OPERATORS.has(last.id)) {
    if (last.id === 'pose.ik_add') objectKeys.push('pole_target');
    // with a bone set, the target must be an armature that has it
    const bone = { target: text(values.subtarget), pole_target: text(values.pole_subtarget) };
    rules.push((k, o) => {
      const b = k === 'target' || k === 'pole_target' ? bone[k] : null;
      return !b || boneNames(doc, o).includes(b);
    });
    if (last.id !== 'pose.constraint_set') {
      // Add IK / Add Bone Constraint: a bone without a target object is a bone of the constrained
      // armature itself, not "none" (Set Bone Constraint's empty choice does remove the target)
      const owner = objectOrActive(doc, last, params.object);
      const self = `This armature${owner ? ` (${owner.name})` : ''}`;
      for (const k of ['target', 'pole_target'] as const) if (bone[k]) emptyLabels[k] = self;
    }
  }

  if (last.id === 'anim.turntable') {
    // the camera cannot orbit around itself
    const target = resolveId(values.target);
    const camera = resolveId(values.camera);
    rules.push((k, o) => !(k === 'camera' && o.id === target) && !(k === 'target' && o.id === camera));
  }

  if (last.id === 'object.track_set') {
    // the target is skipped among the tracking objects, so it cannot be the only one
    const owners = Array.isArray(values.objects)
      ? values.objects.map((r) => resolveId(r)).filter((id): id is string => !!id)
      : last.before.selectedIds;
    const only = new Set(owners).size === 1 ? owners[0] : null;
    rules.push((k, o) => k !== 'target' || o.id !== only);
  }

  return {
    values,
    exclude,
    objectKeys,
    choices,
    objectFilter: (k, o) => rules.every((r) => r(k, o)),
    emptyLabels,
  };
}

/**
 * The parameters to re-run `last` with after `key` changed to `value`. Changing a constraint's
 * type drops what the new type rejects: a target of the wrong kind (or any target for types
 * without one), the bone, and type parameters it does not have. Values the form only showed
 * (kept or computed values of unset parameters) are not passed on.
 */
export function redoParams(doc: SceneDoc, last: LastOperator, key: string, value: unknown): Params {
  const params: Params = { ...((last.params ?? {}) as Params), [key]: value };
  if (value === undefined) delete params[key];
  if (last.id === 'pose.constraint_set' && key === 'target' && value === undefined) {
    // the picker shows the current target: "none" removes it (with its bone), as "" does
    params.target = '';
    delete params.subtarget;
  }
  if (last.id === 'object.constraint_add' && key === 'type') {
    const ctx = objectConstraint(doc, last, params);
    if (!ctx) return params;
    const { info, owner } = ctx;
    const target = text(params.target) ? doc.resolveObject(String(params.target)) : null;
    if (target && !acceptsTarget(info, owner, target)) delete params.target;
    const bone = text(params.subtarget);
    if (bone && (!info.boneSubtarget || !params.target || !boneNames(doc, target).includes(bone)))
      delete params.subtarget;
    if (isRecord(params.params)) {
      const shape = info.schema.shape;
      const kept = Object.entries(params.params).filter(
        ([k, v]) => Object.hasOwn(shape, k) && z.safeParse(shape[k], v).success,
      );
      if (kept.length) params.params = Object.fromEntries(kept);
      else delete params.params;
    }
  }
  return params;
}

/** Blender's "Adjust Last Operation" panel: re-runs the last redoable operator with new parameters. */
export function RedoPanel({ s }: { s: ProjectSession }) {
  const last = lastOperator.value;
  void s.undoRevision.value;
  // kept values show what the operation edits as it is now, also after others (MCP agents, other
  // users) change it: their edits are not on this undo stack
  void s.revision.value;
  const [open, setOpen] = useState(true);
  // bumped when a value is rejected, so the fields show the kept parameters again
  const [, setRejected] = useState(0);
  if (!last || s.undo.undoStack.length !== last.undoDepth) return null;
  const def = registry.get(last.id);
  if (!def) return null;
  // animated kept values at the current frame (reading them follows the frame, like the panels)
  const form = redoForm(
    s.doc,
    last,
    (type, id, path, index, base) => animatedValue(s, type, id, path, index, base),
    (id) => new FrameState(s.doc, s.state.frame).world(id) ?? s.doc.worldMatrix(id),
  );
  return (
    <div
      class="redo-panel"
      onPointerDown={(e) => e.stopPropagation()}
      // scroll the panel, not the view
      onWheel={(e) => e.stopPropagation()}
      data-testid="redo-panel"
    >
      <div class="panel-header" onClick={() => setOpen(!open)}>
        <span class="chev">{open ? '▾' : '▸'}</span>
        {def.label}
      </div>
      {open && (
        <div class="panel-body">
          <SchemaForm
            schema={paramSchema(last.id)}
            values={form.values}
            doc={s.doc}
            exclude={form.exclude}
            objectKeys={form.objectKeys}
            choices={form.choices}
            objectFilter={form.objectFilter}
            emptyLabels={form.emptyLabels}
            testIdPrefix="redo"
            onChange={(k, v, final) => {
              if (!final) return;
              const res = redoLast(s, registry, redoParams(s.doc, last, k, v));
              if (res && !res.ok) setRejected((n) => n + 1);
            }}
          />
        </div>
      )}
    </div>
  );
}
