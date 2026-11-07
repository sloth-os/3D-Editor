import { useState } from 'preact/hooks';
import { z } from 'zod';
import {
  CONSTRAINT_TYPES,
  getConstraintTypeInfo,
  resolveConstraintType,
  safeJsonSchema,
  transformPoint3,
  type ConstraintData,
  type ConstraintTypeInfo,
  type ObjectData,
  type SceneDoc,
  type Vec3,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { registry } from '../editor/editor';
import { lastOperator, redoLast, type LastOperator } from '../editor/runner';
import { SchemaForm, type SchemaChoice } from './SchemaForm';
import { isRecord } from './properties/ObjectTab';
import { ikSettingValues } from './properties/DataTab';

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
 * What the operator keeps for parameters left unset ("only given values change"): the current
 * state of what it edits, shown instead of a default. Editing one component of such a vector
 * keeps the others as they are.
 */
function keptValues(doc: SceneDoc, last: LastOperator, params: Params): Params {
  switch (last.id) {
    case 'pose.bone_transform_set': {
      const bones = objectOrActive(doc, last, params.object)?.pose?.bones;
      const name = String(params.bone ?? '');
      const pb = bones && Object.hasOwn(bones, name) ? bones[name] : undefined;
      return {
        location: pb?.location ?? [0, 0, 0],
        rotation_euler: pb?.rotation_euler ?? [0, 0, 0],
        scale: pb?.scale ?? [1, 1, 1],
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
      const o = objectOrActive(doc, last, params.object);
      const bones = o?.type === 'ARMATURE' && o.data ? (doc.getArmature(o.data)?.bones ?? []) : [];
      // a renamed bone is found under its new name
      const bone =
        bones.find((b) => b.name === params.bone) ?? bones.find((b) => b.name === text(params.name)?.trim());
      if (!o || !bone) return {};
      const world = params.space === 'WORLD' ? doc.worldMatrix(o.id) : null;
      const point = (p: Vec3) => (world ? transformPoint3(world, p) : [...p]);
      return { head: point(bone.head), tail: point(bone.tail), roll: bone.roll };
    }
    case 'constraint.update': {
      const c = objectConstraint(doc, last, params)?.current;
      return c
        ? { target: c.target ?? undefined, subtarget: c.subtarget, influence: c.influence, mute: c.mute }
        : {};
    }
    case 'pose.constraint_set': {
      const bones = objectOrActive(doc, last, params.object)?.pose?.bones;
      const name = String(params.bone ?? '');
      const pb = bones && Object.hasOwn(bones, name) ? bones[name] : undefined;
      const c = findEntry<ConstraintData>(pb?.constraints, params.constraint);
      return c
        ? { target: c.target ?? undefined, subtarget: c.subtarget, influence: c.influence, mute: c.mute }
        : {};
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
 * for unset ones, and pickers that only offer what the operator accepts. Objects the operation
 * created are never offered: adjusting it undoes it first, which deletes them.
 */
export function redoForm(doc: SceneDoc, last: LastOperator): RedoForm {
  const params = (last.params ?? {}) as Params;
  const props = (paramSchema(last.id) as { properties?: Record<string, unknown> } | null)?.properties;
  const values: Params = { ...params };
  for (const [k, v] of Object.entries(keptValues(doc, last, params)))
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
  const form = redoForm(s.doc, last);
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
