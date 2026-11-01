import { useState } from 'preact/hooks';
import {
  getConstraintTypeInfo,
  safeJsonSchema,
  type ConstraintData,
  type ConstraintError,
  type ConstraintTypeInfo,
  type ObjectData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { Checkbox, NumberField, Row, SelectField, TextField, ToggleGroup, RAD } from '../fields/fields';
import { SchemaForm } from '../SchemaForm';
import { MenuButton } from '../Menu';
import { Icon } from '../icons';
import { run } from '../../editor/editor';
import { constraintAddItems, type MenuItem } from '../../editor/menus';
import { animState } from './prop-edit';
import { ErrorList, boneOptions, dragEdit, panelEvaluation, sourceErrors } from './ObjectTab';

/*
 * Object Constraints tab (Blender's Properties > Object Constraints): the constraint stack of the
 * active object, evaluated top to bottom. Every edit runs a constraint operator (one undo step,
 * synced to every device); slider drags are previewed live and committed once on release.
 */

/** Parameters handled by dedicated buttons instead of fields. */
const HIDDEN_PARAMS = new Set(['inverse_matrix', 'set_inverse_pending']);

/** Enum parameters shown as button rows (axis choices), like Blender's constraint panels. */
const EXPANDED_ENUMS = [
  'track_axis',
  'up_axis',
  'lock_axis',
  'forward_axis',
  'floor_location',
  'main_axis',
  'limit_mode',
];

/** Blender's labels of constraint parameters (others are humanized from their names). */
const PARAM_LABELS: Record<string, string> = {
  track_axis: 'Track Axis',
  up_axis: 'Up',
  lock_axis: 'Lock',
  forward_axis: 'Forward Axis',
  use_target_z: 'Target Z',
  target_space: 'Target Space',
  owner_space: 'Owner Space',
  head_tail: 'Head/Tail',
  use_offset: 'Offset',
  use_add: 'Additive',
  use_make_uniform: 'Make Uniform',
  mix_mode: 'Mix',
  euler_order: 'Order',
  limit_mode: 'Clamp Region',
  use_transform_limit: 'Affect Transform',
  use_legacy_behavior: 'Legacy Behavior',
  remove_target_shear: 'Remove Target Shear',
  use_fixed_location: 'Fixed Position',
  use_curve_follow: 'Follow Curve',
  use_curve_radius: 'Curve Radius',
  offset_factor: 'Offset Factor',
  main_axis: 'Main Axis',
  use_cyclic: 'Cyclic',
  floor_location: 'Min/Max',
  use_rotation: 'Use Rotation',
  use_relative_location: 'Relative Offset',
  rotation_range: 'Rotation Range',
};

const AXIS_GROUP_LABELS: Record<string, string> = {
  use: 'Axis',
  invert: 'Invert',
  use_location: 'Location',
  use_rotation: 'Rotation',
  use_scale: 'Scale',
};

const SPACE_LABELS: Record<string, string> = { WORLD: 'World Space', LOCAL: 'Local Space' };
const LIMIT_MODES: Record<string, string> = {
  LIMITDIST_INSIDE: 'Inside',
  LIMITDIST_OUTSIDE: 'Outside',
  LIMITDIST_ONSURFACE: 'On Surface',
};

/** Blender's short labels for constraint enum values ('-Z' for TRACK_NEGATIVE_Z, …). */
export function constraintEnumLabel(_key: string, value: string): string | undefined {
  const axis = /^(?:TRACK|UP|LOCK|FORWARD|FLOOR)_(NEGATIVE_)?([XYZ])$/.exec(value);
  if (axis) return `${axis[1] ? '-' : ''}${axis[2]}`;
  if (value in SPACE_LABELS) return SPACE_LABELS[value];
  if (value in LIMIT_MODES) return LIMIT_MODES[value];
  if (value.startsWith('CLAMPTO_')) return value === 'CLAMPTO_AUTO' ? 'Auto' : value.slice(8);
  if (value === 'ALWAYS_ACTIVE') return 'Always';
  if (/^N[XYZ]$/.test(value)) return `-${value[1]}`;
  return undefined;
}

interface JsonProp {
  type?: string | string[];
  description?: string;
  default?: unknown;
  anyOf?: JsonProp[];
}

function propType(p: JsonProp | undefined): string | undefined {
  if (!p) return undefined;
  if (p.anyOf) return propType(p.anyOf.find((a) => a.type !== 'null'));
  return Array.isArray(p.type) ? p.type.find((t) => t !== 'null') : p.type;
}

const schemaCache = new Map<string, { properties: Record<string, JsonProp> }>();
function paramSchema(info: ConstraintTypeInfo): { properties: Record<string, JsonProp> } {
  let s = schemaCache.get(info.type);
  if (!s) {
    const json = safeJsonSchema(info.schema) as { properties?: Record<string, JsonProp> };
    s = { properties: json.properties ?? {} };
    schemaCache.set(info.type, s);
  }
  return s;
}

/** One block of the parameter layout of a constraint panel. */
export type ConstraintLayoutItem =
  | { kind: 'fields'; keys: string[] }
  | { kind: 'axes'; label: string; keys: string[] }
  | { kind: 'limit'; label: string; flag: string; keys: string[] };

/**
 * Groups constraint parameters like Blender's panels: X/Y/Z boolean triples become one row of
 * axis toggles (Axis, Invert, Location …), `use_min_x` + `min_x` pairs and `use_limit_x` +
 * `min_x`/`max_x` become limit rows (checkbox + value fields); everything else stays a plain field.
 */
export function layoutConstraintParams(props: Record<string, JsonProp>): ConstraintLayoutItem[] {
  const items: ConstraintLayoutItem[] = [];
  const done = new Set<string>();
  const isBool = (k: string) => propType(props[k]) === 'boolean';
  for (const key of Object.keys(props)) {
    if (done.has(key) || HIDDEN_PARAMS.has(key)) continue;
    const minMax = /^use_(min|max)_([xyz])$/.exec(key);
    if (minMax && props[`${minMax[1]}_${minMax[2]}`]) {
      const value = `${minMax[1]}_${minMax[2]}`;
      items.push({
        kind: 'limit',
        label: `${minMax[1] === 'min' ? 'Minimum' : 'Maximum'} ${minMax[2].toUpperCase()}`,
        flag: key,
        keys: [value],
      });
      done.add(key).add(value);
      continue;
    }
    const limit = /^use_limit_([xyz])$/.exec(key);
    if (limit && props[`min_${limit[1]}`] && props[`max_${limit[1]}`]) {
      const keys = [`min_${limit[1]}`, `max_${limit[1]}`];
      items.push({ kind: 'limit', label: `Limit ${limit[1].toUpperCase()}`, flag: key, keys });
      done.add(key).add(keys[0]).add(keys[1]);
      continue;
    }
    const axis = /^(.+)_([xyz])$/.exec(key);
    if (axis && isBool(key)) {
      const keys = ['x', 'y', 'z'].map((a) => `${axis[1]}_${a}`);
      if (keys.every((k) => isBool(k) && !done.has(k))) {
        const label =
          AXIS_GROUP_LABELS[axis[1]] ??
          axis[1]
            .replace(/^use_/, '')
            .replace(/_/g, ' ')
            .replace(/^\w/, (c) => c.toUpperCase());
        items.push({ kind: 'axes', label, keys });
        for (const k of keys) done.add(k);
        continue;
      }
    }
    const last = items[items.length - 1];
    if (last?.kind === 'fields') last.keys.push(key);
    else items.push({ kind: 'fields', keys: [key] });
    done.add(key);
  }
  return items;
}

/** Object entries of a stored list; malformed entries are skipped (as the core operators do). */
export function validItems<T>(list: readonly T[] | undefined | null): T[] {
  return Array.isArray(list)
    ? list.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x))
    : [];
}

const quoteKey = (k: string) => `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Data path of a constraint property, e.g. `constraints["Track To"].influence`. */
export function constraintPath(c: Pick<ConstraintData, 'name'>, prop: string): string {
  return `constraints[${quoteKey(c.name)}].${prop}`;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (m: unknown) =>
  Array.isArray(m) && m.length === 16 && m.every((v, i) => Math.abs(Number(v) - IDENTITY[i]) < 1e-9);

/** Replaces one constraint of an object in the document (used for live drag previews). */
function writeConstraint(
  s: ProjectSession,
  objectId: string,
  constraintId: string,
  change: (c: ConstraintData) => ConstraintData,
): void {
  const o = s.doc.getObject(objectId);
  if (!o) return;
  s.doc.updateObject(objectId, {
    constraints: o.constraints.map((c) => (c.id === constraintId ? change(c) : c)),
  });
}

export function ConstraintsTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const ev = panelEvaluation(s);
  const evo = ev?.byId.get(o.id);
  const errors = evo?.constraintErrors ?? [];
  const list = validItems(o.constraints);
  const poseErrors = o.type === 'ARMATURE' ? sourceErrors(ev, `pose:${o.id}`) : [];
  return (
    <>
      <div class="prop-context">
        <Icon name="constraint" size={14} /> {o.name}
      </div>
      <div style={{ padding: '4px 8px' }}>
        <MenuButton
          label="Add Object Constraint ▾"
          items={() => constraintAddItems(o.id)}
          testId="add-constraint-button"
        />
      </div>
      {list.length === 0 && (
        <div class="empty-note">
          No constraints. Constraints drive the transform from other objects: tracking, copying, limits,
          following paths.
        </div>
      )}
      {list.map((c, i) => (
        <ConstraintPanel
          key={c.id}
          s={s}
          o={o}
          c={c}
          index={i}
          count={list.length}
          errors={errors}
          evaluated={evo?.data.constraints?.[i]}
        />
      ))}
      {poseErrors.length > 0 && (
        <div class="panel">
          <div class="panel-body">
            <span class="hint">Pose (bone constraints)</span>
            <ErrorList messages={poseErrors} testId="pose-errors" />
          </div>
        </div>
      )}
    </>
  );
}

/** The header dropdown of a constraint panel (Blender: Apply, move within the stack). */
export function constraintMenu(
  ref: { object: string; constraint: string },
  index: number,
  count: number,
): MenuItem[] {
  const move = (label: string, to: number, possible: boolean): MenuItem => ({
    label,
    op: 'constraint.move_to_index',
    params: { ...ref, index: to },
    enabled: () => possible,
  });
  return [
    { label: 'Apply', op: 'constraint.apply', params: ref },
    { sep: true },
    move('Move to First', 0, index > 0),
    move('Move Up', Math.max(0, index - 1), index > 0),
    move('Move Down', index + 1, index < count - 1),
    move('Move to Last', count - 1, index < count - 1),
  ];
}

function constraintError(
  errors: readonly ConstraintError[],
  c: ConstraintData,
  index: number,
): string | null {
  return errors.find((e) => e.constraintId === c.id || e.constraintId === `#${index}`)?.message ?? null;
}

function ConstraintPanel(p: {
  s: ProjectSession;
  o: ObjectData;
  c: ConstraintData;
  index: number;
  count: number;
  errors: readonly ConstraintError[];
  /** The constraint with animation applied (current frame). */
  evaluated?: ConstraintData;
}) {
  const { s, o, c, index } = p;
  const info = getConstraintTypeInfo(c.type);
  const storageKey = `3d-editor:constraint:${c.id}`;
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? c.show_expanded !== false : stored === '1';
  });
  const toggle = () => {
    setOpen(!open);
    localStorage.setItem(storageKey, open ? '0' : '1');
  };
  const error = constraintError(p.errors, c, index);
  const ref = { object: o.id, constraint: c.id };
  const update = (patch: Record<string, unknown>) => run('constraint.update', { ...ref, ...patch }, 'ui');
  const tid = `constraint-${c.name}`;
  return (
    <div
      class="panel"
      data-testid={tid}
      style={error ? { boxShadow: 'inset 2px 0 0 var(--danger)' } : undefined}
      aria-invalid={error ? true : undefined}
    >
      <div class="panel-header" onClick={toggle}>
        <span class="chev">{open ? '▾' : '▸'}</span>
        <span
          title={error ?? info?.description}
          style={{ display: 'flex', color: error ? '#ff7b7b' : undefined }}
        >
          <Icon name={error ? 'warning' : 'constraint'} size={12} />
        </span>
        <span
          style={{ flex: 1, minWidth: 0, fontWeight: 'normal', opacity: c.mute ? 0.55 : 1 }}
          onClick={(e) => e.stopPropagation()}
        >
          <TextField
            value={c.name}
            testId={`${tid}-name`}
            ariaLabel="Constraint name"
            onChange={(v) => v.trim() && update({ name: v.trim() })}
          />
        </span>
        <span class="actions" style={{ fontWeight: 'normal' }} onClick={(e) => e.stopPropagation()}>
          <button
            class={`btn flat icon ${c.mute ? '' : 'active'}`}
            title={c.mute ? 'Enable constraint' : 'Disable (mute) constraint'}
            aria-label={c.mute ? 'Enable constraint' : 'Mute constraint'}
            aria-pressed={!c.mute}
            data-testid={`${tid}-mute`}
            onClick={() => update({ mute: !c.mute })}
          >
            <Icon name={c.mute ? 'eyeOff' : 'eye'} size={12} />
          </button>
          <MenuButton label="▾" testId={`${tid}-menu`} items={() => constraintMenu(ref, index, p.count)} />
          <button
            class="btn flat icon"
            title="Delete constraint"
            aria-label="Delete constraint"
            data-testid={`${tid}-delete`}
            onClick={() => run('constraint.delete', ref, 'ui')}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      </div>
      {open && (
        <div class="panel-body" style={{ opacity: c.mute ? 0.6 : 1 }}>
          {error && <ErrorList messages={[error]} testId={`${tid}-error`} />}
          {!info ? (
            <div class="hint">Unknown constraint type {c.type}</div>
          ) : (
            <ConstraintBody s={s} o={o} c={c} info={info} tid={tid} update={update} evaluated={p.evaluated} />
          )}
        </div>
      )}
    </div>
  );
}

function ConstraintBody(p: {
  s: ProjectSession;
  o: ObjectData;
  c: ConstraintData;
  info: ConstraintTypeInfo;
  tid: string;
  update: (patch: Record<string, unknown>) => boolean;
  evaluated?: ConstraintData;
}) {
  const { s, o, c, info, tid, update } = p;
  const target = c.target ? s.doc.getObject(c.target) : null;
  const bones =
    target?.type === 'ARMATURE' && target.data
      ? (s.doc.getArmature(target.data)?.bones.map((b) => b.name) ?? [])
      : [];
  const candidates = s.doc
    .listObjects()
    .filter((x) => x.id !== o.id && (!info.targetObjectType || x.type === info.targetObjectType));
  const props = paramSchema(info).properties;
  const params = { ...(c.params ?? {}) };
  const layout = layoutConstraintParams(props);
  const hasBone = !!c.subtarget && bones.length > 0;
  const units: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (/metre|meter/i.test(v.description ?? '')) units[k] = ' m';
  const setParam = (k: string, v: unknown, final: boolean) =>
    dragEdit(
      s,
      `constraint:${c.id}:${k}`,
      final,
      () => writeConstraint(s, o.id, c.id, (x) => ({ ...x, params: { ...x.params, [k]: v } })),
      captureConstraints(s, o.id),
      () => update({ params: { [k]: v } }),
    );
  const setInfluence = (v: number, final: boolean) =>
    dragEdit(
      s,
      `constraint:${c.id}:influence`,
      final,
      () => writeConstraint(s, o.id, c.id, (x) => ({ ...x, influence: v })),
      captureConstraints(s, o.id),
      () => update({ influence: v }),
    );
  const influencePath = constraintPath(c, 'influence');
  const influenceState = animState(s, 'object', o.id, influencePath, 0);
  const influence = influenceState ? (p.evaluated?.influence ?? c.influence) : c.influence;
  if (info.boneOnly)
    return (
      <div class="hint">
        {info.label} only works on pose bones (armature pose evaluation); it is ignored on objects.
      </div>
    );
  return (
    <>
      {info.target !== 'NONE' && (
        <Row
          label="Target"
          title={info.targetObjectType ? `${info.targetObjectType} object` : 'Target object'}
        >
          <SelectField
            value={c.target ?? ''}
            testId={`${tid}-target`}
            options={[
              { value: '', label: info.target === 'OPTIONAL' ? '— none (optional) —' : '— none —' },
              ...candidates.map((x) => ({ value: x.id, label: x.name })),
              ...(c.target && !candidates.some((x) => x.id === c.target)
                ? [{ value: c.target, label: `${target?.name ?? c.target} (invalid)` }]
                : []),
            ]}
            onChange={(v) => update({ target: v || null })}
          />
        </Row>
      )}
      {info.target !== 'NONE' && info.boneSubtarget && target?.type === 'ARMATURE' && (
        <Row label="Bone" title="Bone of the armature target ('' = the armature object itself)">
          <SelectField
            value={c.subtarget}
            testId={`${tid}-bone`}
            options={boneOptions(bones, c.subtarget, '— armature —')}
            onChange={(v) => update({ subtarget: v })}
          />
        </Row>
      )}
      {layout.map((item, k) => {
        if (item.kind === 'axes')
          return (
            <Row key={k} label={item.label} title={props[item.keys[0]]?.description}>
              <ToggleGroup
                testId={`${tid}-${item.keys[0].replace(/_x$/, '')}`}
                options={item.keys.map((key, i) => ({
                  label: 'XYZ'[i],
                  value: !!(params[key] ?? props[key]?.default),
                  title: props[key]?.description,
                }))}
                onChange={(i, v) => setParam(item.keys[i], v, true)}
              />
            </Row>
          );
        if (item.kind === 'limit') {
          const on = !!params[item.flag];
          return (
            <Row key={k} label={item.label} title={props[item.flag]?.description}>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <Checkbox
                  value={on}
                  testId={`${tid}-${item.flag}`}
                  onChange={(v) => setParam(item.flag, v, true)}
                />
                {item.keys.map((key) => {
                  const angle = /radian/i.test(props[key]?.description ?? '');
                  return (
                    <div key={key} style={{ flex: 1, minWidth: 0, opacity: on ? 1 : 0.55 }}>
                      <NumberField
                        value={Number(params[key] ?? 0)}
                        label={item.keys.length > 1 ? (key.startsWith('min') ? 'Min' : 'Max') : undefined}
                        step={angle ? 1 : 0.01}
                        unit={angle ? '°' : units[key]}
                        {...(angle ? RAD : {})}
                        title={props[key]?.description}
                        testId={`${tid}-${key}`}
                        onChange={(v, final) => setParam(key, v, final)}
                      />
                    </div>
                  );
                })}
              </div>
            </Row>
          );
        }
        return (
          <SchemaForm
            key={k}
            schema={{ properties: props }}
            only={item.keys}
            exclude={hasBone ? [] : ['head_tail']}
            values={params}
            doc={s.doc}
            testIdPrefix={tid}
            units={units}
            expandEnums={EXPANDED_ENUMS}
            enumLabel={constraintEnumLabel}
            labels={PARAM_LABELS}
            onChange={setParam}
          />
        );
      })}
      {c.type === 'CHILD_OF' && (
        <Row label="" title="The inverse correction keeps the owner in place when the target is assigned">
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              class="btn"
              data-testid={`${tid}-set-inverse`}
              onClick={() => run('constraint.childof_set_inverse', { object: o.id, constraint: c.id }, 'ui')}
            >
              Set Inverse
            </button>
            <button
              class="btn"
              data-testid={`${tid}-clear-inverse`}
              disabled={isIdentity(params.inverse_matrix)}
              onClick={() =>
                run('constraint.childof_clear_inverse', { object: o.id, constraint: c.id }, 'ui')
              }
            >
              Clear Inverse
            </button>
            <span class="hint">{isIdentity(params.inverse_matrix) ? 'no inverse' : 'inverse set'}</span>
          </div>
        </Row>
      )}
      {c.type === 'FOLLOW_PATH' && (
        <Row label="">
          <button
            class="btn"
            data-testid={`${tid}-animate-path`}
            title="Keyframe the path so the owner travels along it"
            onClick={() =>
              run('constraint.followpath_path_animate', { object: o.id, constraint: c.id }, 'ui')
            }
          >
            Animate Path
          </button>
        </Row>
      )}
      {c.type === 'LIMIT_DISTANCE' && (
        <Row label="">
          <button
            class="btn"
            data-testid={`${tid}-reset-distance`}
            title="Set the distance to the current distance between owner and target"
            onClick={() => run('constraint.limitdistance_reset', { object: o.id, constraint: c.id }, 'ui')}
          >
            Reset Distance
          </button>
        </Row>
      )}
      <Row label="Influence" title="Blend between the unconstrained (0) and fully constrained (1) transform">
        <div style={{ display: 'flex', gap: '2px' }}>
          <div style={{ flex: 1 }}>
            <NumberField
              value={influence}
              min={0}
              max={1}
              slider
              state={influenceState}
              testId={`${tid}-influence`}
              onChange={setInfluence}
            />
          </div>
          <button
            class="btn flat icon"
            title={`Insert keyframe for the influence at frame ${s.state.frame}`}
            aria-label="Insert influence keyframe"
            data-testid={`${tid}-key-influence`}
            onClick={() =>
              run(
                'anim.keyframe_insert_property',
                { target_type: 'object', target: o.id, path: influencePath, index: 0 },
                'ui',
              )
            }
          >
            <Icon name="key" size={12} />
          </button>
        </div>
      </Row>
    </>
  );
}

/** Captures an object's constraint list; returns the function restoring it. */
function captureConstraints(s: ProjectSession, objectId: string): () => () => void {
  return () => {
    const original = s.doc.getObject(objectId)?.constraints;
    return () => {
      if (original && s.doc.getObject(objectId)) s.doc.updateObject(objectId, { constraints: original });
    };
  };
}
