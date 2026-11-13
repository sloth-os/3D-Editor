import { useState } from 'preact/hooks';
import {
  ANIMATABLE,
  FMODIFIER_PARAM_SCHEMAS,
  FMODIFIER_TYPE_INFO,
  ParticleSettingsSchema,
  ROOT_COLLECTION_ID,
  driverProblems,
  fcurveKey,
  getModifierDef,
  getPathValue,
  parseDataPath,
  readChannel,
  safeJsonSchema,
  type AnimTargetType,
  type DatablockKind,
  type DriverData,
  type DriverVariable,
  type EvaluatedScene,
  type FCurve,
  type FModifierData,
  type ObjectData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import {
  Checkbox,
  ColorField,
  NumberField,
  Panel,
  Row,
  SelectField,
  TextField,
  VectorField,
  RAD,
  composing,
} from '../fields/fields';
import { PREVIEW_ORIGIN, animState, animatedValue, setProp } from './prop-edit';
import { run } from '../../editor/editor';
import { Icon } from '../icons';
import { MenuButton } from '../Menu';
import { SchemaForm } from '../SchemaForm';

// ------------------------------------------------------------------ shared panel helpers

interface EvalMemo {
  revision: number;
  frame: number;
  edit: string | null;
  ev: EvaluatedScene | null;
}
const evalMemo = new WeakMap<ProjectSession, EvalMemo>();

/**
 * The evaluated scene at the current frame for property panels (evaluation errors, constraint
 * results, generated instances, simulation state). Evaluated at most once per document revision,
 * frame and edit object and shared by every panel of a redraw; reading it subscribes the calling
 * component to revision and frame changes. Null when the evaluation fails.
 */
export function panelEvaluation(s: ProjectSession): EvaluatedScene | null {
  const frame = s.state.frame;
  const revision = s.revision.value;
  const edit = s.state.mode === 'EDIT' ? s.state.activeId : null;
  const hit = evalMemo.get(s);
  if (hit && hit.revision === revision && hit.frame === frame && hit.edit === edit) return hit.ev;
  let ev: EvaluatedScene | null = null;
  try {
    ev = s.evaluator.evaluate(frame, { editObjectId: edit });
  } catch (e) {
    console.error('scene evaluation failed', e);
  }
  evalMemo.set(s, { revision, frame, edit, ev });
  return ev;
}

/** Messages of the evaluation errors reported by `source` (e.g. `rigidbody:<id>`, `driver:<key>`). */
export function sourceErrors(ev: EvaluatedScene | null, source: string): string[] {
  return ev ? ev.errors.filter((e) => e.source === source).map((e) => e.message) : [];
}

/** Evaluation problems shown in red with a warning icon (nothing when there are none). */
export function ErrorList({ messages, testId }: { messages: string[]; testId?: string }) {
  if (!messages.length) return null;
  return (
    <div data-testid={testId} role="alert" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {messages.map((m, i) => (
        <div key={i} class="error-text" style={{ display: 'flex', gap: '4px', alignItems: 'flex-start' }}>
          <Icon name="warning" size={12} style={{ flex: 'none', marginTop: '1px' }} />
          <span style={{ userSelect: 'text' }}>{m}</span>
        </div>
      ))}
    </div>
  );
}

let dragState: { key: string; restore: () => void } | null = null;

/**
 * Live preview of a value being dragged in a field: while `final` is false, `preview` writes the
 * value outside undo (synced to peers, like {@link setProp}); the final value restores the state
 * captured before the drag (`capture` returns the restore function) and runs `commit`, normally an
 * operator, so the whole drag is a single undo step.
 *
 * The restore must put back only the dragged field, written into the document state as it is at
 * release time (see {@link captureField}): a drag lasts seconds, and other devices or MCP agents
 * may change other entries of the same list (constraints, particle systems, keyframes) meanwhile.
 */
export function dragEdit(
  s: ProjectSession,
  key: string,
  final: boolean,
  preview: () => void,
  capture: () => () => void,
  commit: () => void,
): void {
  if (!final) {
    if (!dragState || dragState.key !== key) dragState = { key, restore: capture() };
    s.doc.transact(preview, PREVIEW_ORIGIN);
    return;
  }
  if (dragState?.key === key) {
    const restore = dragState.restore;
    dragState = null;
    s.doc.transact(restore, PREVIEW_ORIGIN);
  }
  commit();
}

/**
 * A `capture` for {@link dragEdit} that restores one field: `read` returns the field's current
 * stored value (undefined when absent), `write` stores a value into the current document state,
 * re-reading it and changing nothing else (undefined removes the field). Edits that others make to
 * the rest of the datablock during the drag therefore survive the release.
 */
export function captureField(read: () => unknown, write: (value: unknown) => void): () => () => void {
  return () => {
    const before = read();
    return () => write(before);
  };
}

/** A copy of `record` with `key` set to `value`, or without `key` when `value` is undefined. */
export function withField<T extends object>(record: T | null | undefined, key: string, value: unknown): T {
  const next: Record<string, unknown> = { ...(record ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

/** Whether a stored list entry is an object (stored lists may hold malformed entries). */
export const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);

/** Small framed box used for list entries inside panels (drivers, variables, channels). */
export const boxStyle = {
  border: '1px solid var(--border-light)',
  borderRadius: 'var(--radius)',
  padding: '4px 6px',
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
  background: 'rgba(0, 0, 0, 0.12)',
} as const;

/** Header line of a list entry: icon, title and trailing buttons. */
export const boxHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  minHeight: '22px',
} as const;

const fmtValue = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4));

function humanize(k: string): string {
  return k
    .replace(/^use_/, '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ------------------------------------------------------------------ transform

export function TransformFields({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const driven = (path: string, i: number) => {
    const d = s.doc.getDriver(fcurveKey({ target_type: 'object', target_id: o.id, path, index: i }));
    return !!d && !d.mute;
  };
  // driven channels show the value their driver gives at this frame (only evaluated when needed)
  const evo = s.doc.listDrivers(o.id).some((d) => d.target_type === 'object' && !d.mute)
    ? panelEvaluation(s)?.byId.get(o.id)
    : undefined;
  const vec = (path: 'location' | 'rotation_euler' | 'scale') =>
    o[path].map((v, i) => {
      const value = evo && driven(path, i) ? evo.data[path]?.[i] : undefined;
      return typeof value === 'number' ? value : animatedValue(s, 'object', o.id, path, i, v);
    });
  const states = (path: string) => [0, 1, 2].map((i) => animState(s, 'object', o.id, path, i));
  const keyBtn = (path: string) => (
    <button
      class="btn flat icon"
      title={`Insert keyframe for ${path} at frame ${s.state.frame}`}
      data-testid={`key-${path}`}
      onClick={() =>
        run('anim.keyframe_insert_property', { target_type: 'object', target: o.id, path }, 'ui')
      }
    >
      <Icon name="key" size={12} />
    </button>
  );
  return (
    <>
      <Row label="Location">
        <div style={{ display: 'flex', gap: '2px' }}>
          <div style={{ flex: 1 }}>
            <VectorField
              value={vec('location')}
              unit=" m"
              step={0.01}
              states={states('location')}
              testId="loc"
              onChange={(v, f) => setProp(s, 'objects', o.id, 'location', v, f)}
            />
          </div>
          {keyBtn('location')}
        </div>
      </Row>
      <Row label="Rotation">
        <div style={{ display: 'flex', gap: '2px' }}>
          <div style={{ flex: 1 }}>
            <VectorField
              value={vec('rotation_euler')}
              unit="°"
              step={1}
              {...RAD}
              states={states('rotation_euler')}
              testId="rot"
              onChange={(v, f) => setProp(s, 'objects', o.id, 'rotation_euler', v, f)}
            />
          </div>
          {keyBtn('rotation_euler')}
        </div>
      </Row>
      <Row label="Scale">
        <div style={{ display: 'flex', gap: '2px' }}>
          <div style={{ flex: 1 }}>
            <VectorField
              value={vec('scale')}
              step={0.01}
              states={states('scale')}
              testId="scale"
              onChange={(v, f) => setProp(s, 'objects', o.id, 'scale', v, f)}
            />
          </div>
          {keyBtn('scale')}
        </div>
      </Row>
    </>
  );
}

// ------------------------------------------------------------------ object tab

/**
 * The object's custom properties as they are now, when it still has `key`: a field commits its text
 * also when it goes away, with the properties it rendered, after an agent or another person may have
 * changed them (their changes stay; a property they removed is not written back).
 */
function customPropsNow(s: ProjectSession, id: string, key: string): ObjectData['custom_props'] | null {
  const now = s.doc.getObject(id)?.custom_props;
  return now && Object.hasOwn(now, key) ? now : null;
}

export function ObjectTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const objects = s.doc.listObjects().filter((x) => x.id !== o.id && !s.doc.isAncestor(o.id, x.id));
  const collections = s.doc.listCollections();
  const parent = o.parent ? s.doc.getObject(o.parent) : null;
  const parentBones =
    parent?.type === 'ARMATURE' && parent.data
      ? (s.doc.getArmature(parent.data)?.bones.map((b) => b.name) ?? [])
      : [];
  return (
    <>
      <div class="prop-context">
        <Icon name="object" size={14} /> {o.name}
      </div>
      <Panel title="Object">
        <Row label="Name">
          <TextField
            value={o.name}
            testId="object-name"
            onChange={(v) => v && run('object.rename', { object: o.id, name: v }, 'ui')}
          />
        </Row>
      </Panel>
      <Panel title="Transform">
        <TransformFields s={s} o={o} />
      </Panel>
      <Panel title="Relations">
        <Row label="Parent">
          <SelectField
            value={o.parent ?? ''}
            testId="object-parent"
            options={[
              { value: '', label: '— none —' },
              ...objects.map((x) => ({ value: x.id, label: x.name })),
            ]}
            onChange={(v) => run('object.parent_to', { objects: [o.id], parent: v || null }, 'ui')}
          />
        </Row>
        {parent?.type === 'ARMATURE' && (
          <>
            <Row label="Parent Type">
              <SelectField
                value={o.parent_type}
                testId="object-parent-type"
                options={[
                  { value: 'OBJECT', label: 'Object' },
                  { value: 'BONE', label: 'Bone' },
                ]}
                onChange={(v) =>
                  run(
                    'object.parent_to',
                    v === 'BONE'
                      ? { objects: [o.id], parent: parent.id, type: 'BONE', bone: parentBones[0] ?? '' }
                      : { objects: [o.id], parent: parent.id, type: 'OBJECT' },
                    'ui',
                  )
                }
              />
            </Row>
            {o.parent_type === 'BONE' && (
              <Row label="Parent Bone">
                <SelectField
                  value={o.parent_bone}
                  testId="object-parent-bone"
                  options={boneOptions(parentBones, o.parent_bone)}
                  onChange={(v) =>
                    run(
                      'object.parent_to',
                      { objects: [o.id], parent: parent.id, type: 'BONE', bone: v },
                      'ui',
                    )
                  }
                />
              </Row>
            )}
          </>
        )}
        <Row label="Collection">
          <SelectField
            value={o.collection}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => setProp(s, 'objects', o.id, 'collection', v)}
          />
        </Row>
      </Panel>
      {o.type === 'EMPTY' && <InstancingPanel s={s} o={o} />}
      <Panel title="Visibility">
        <Row label="">
          <Checkbox
            value={!o.hide_viewport}
            label="Show in Viewports"
            onChange={(v) => setProp(s, 'objects', o.id, 'hide_viewport', !v)}
          />
        </Row>
        <Row label="">
          <Checkbox
            value={!o.hide_render}
            label="Show in Renders"
            onChange={(v) => setProp(s, 'objects', o.id, 'hide_render', !v)}
          />
        </Row>
        <Row label="">
          <Checkbox
            value={!o.hide_select}
            label="Selectable"
            onChange={(v) => setProp(s, 'objects', o.id, 'hide_select', !v)}
          />
        </Row>
      </Panel>
      <Panel title="Viewport Display" defaultOpen={false}>
        {o.type === 'EMPTY' && (
          <>
            <Row label="Display As">
              <SelectField
                value={o.empty_display_type}
                options={['PLAIN_AXES', 'ARROWS', 'SINGLE_ARROW', 'CIRCLE', 'CUBE', 'SPHERE', 'CONE'].map(
                  (v) => ({ value: v, label: v.replace('_', ' ').toLowerCase() }),
                )}
                onChange={(v) => setProp(s, 'objects', o.id, 'empty_display_type', v)}
              />
            </Row>
            <Row label="Size">
              <NumberField
                value={o.empty_display_size}
                min={0.001}
                step={0.01}
                onChange={(v, f) => setProp(s, 'objects', o.id, 'empty_display_size', v, f)}
              />
            </Row>
          </>
        )}
        <Row label="Display As">
          <SelectField
            value={o.display_type}
            options={[
              { value: 'TEXTURED', label: 'Textured' },
              { value: 'SOLID', label: 'Solid' },
              { value: 'WIRE', label: 'Wire' },
              { value: 'BOUNDS', label: 'Bounds' },
            ]}
            onChange={(v) => setProp(s, 'objects', o.id, 'display_type', v)}
          />
        </Row>
        <Row label="">
          <Checkbox
            value={o.show_wire}
            label="Wireframe"
            onChange={(v) => setProp(s, 'objects', o.id, 'show_wire', v)}
          />
        </Row>
        <Row label="Color">
          <ColorField value={o.color} onChange={(v, f) => setProp(s, 'objects', o.id, 'color', v, f)} />
        </Row>
      </Panel>
      <FCurvesPanel s={s} o={o} />
      <DriversPanel s={s} o={o} />
      <Panel title="Custom Properties" defaultOpen={false}>
        {Object.entries(o.custom_props).map(([k, v]) => (
          <Row key={k} label={k}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <TextField
                value={String(v)}
                testId={`custom-prop-${k}`}
                onChange={(nv) => {
                  const now = customPropsNow(s, o.id, k);
                  if (!now) return;
                  const num = Number(nv);
                  setProp(s, 'objects', o.id, 'custom_props', {
                    ...now,
                    [k]: nv !== '' && Number.isFinite(num) ? num : nv,
                  });
                }}
              />
              <button
                class="btn icon"
                title="Remove"
                onClick={() => {
                  const now = customPropsNow(s, o.id, k);
                  if (!now) return;
                  const { [k]: _drop, ...rest } = now;
                  setProp(s, 'objects', o.id, 'custom_props', rest);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          </Row>
        ))}
        <Row label="">
          <button
            class="btn"
            onClick={() => {
              const name = prompt('Property name');
              if (name) setProp(s, 'objects', o.id, 'custom_props', { ...o.custom_props, [name]: 1 });
            }}
          >
            <Icon name="plus" size={12} /> New
          </button>
        </Row>
      </Panel>
    </>
  );
}

/** Bone picker options; a stored bone that no longer exists stays visible as missing. */
export function boneOptions(
  bones: string[],
  current: string,
  none?: string,
): { value: string; label: string }[] {
  const out = bones.map((b) => ({ value: b, label: b }));
  if (current && !bones.includes(current)) out.unshift({ value: current, label: `${current} (missing)` });
  if (none !== undefined) out.unshift({ value: '', label: none });
  return out;
}

// ------------------------------------------------------------------ instancing (empties)

function InstancingPanel({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const ev = panelEvaluation(s);
  const collections = s.doc.listCollections().filter((c) => c.id !== ROOT_COLLECTION_ID);
  const current = o.instance_type === 'COLLECTION' ? (o.instance_collection ?? '') : '';
  const count = ev ? ev.instances.filter((i) => i.ownerId === o.id).length : 0;
  return (
    <Panel title="Instancing" id="object-instancing">
      <Row label="Collection" title="Collection whose objects appear at this empty (Collection Instance)">
        <SelectField
          value={current}
          testId="instance-collection"
          options={[
            { value: '', label: '— none —' },
            ...collections.map((c) => ({ value: c.id, label: c.name })),
            ...(current && !collections.some((c) => c.id === current)
              ? [{ value: current, label: `${current} (missing)` }]
              : []),
          ]}
          onChange={(v) =>
            run('object.instance_collection_set', { object: o.id, collection: v || null }, 'ui')
          }
        />
      </Row>
      {current && (
        <>
          <Row label="">
            <span class="hint" data-testid="instance-count">
              {count.toLocaleString()} instance{count === 1 ? '' : 's'}
            </span>
          </Row>
          <ErrorList messages={sourceErrors(ev, `instances:${o.id}`)} testId="instancing-errors" />
          <Row label="">
            <button
              class="btn"
              data-testid="instances-make-real"
              title="Turn the instances into real objects (Make Instances Real)"
              onClick={() => run('object.duplicates_make_real', { objects: [o.id] }, 'ui')}
            >
              Make Instances Real
            </button>
          </Row>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ animation channels

const AXIS = ['X', 'Y', 'Z', 'W'];
const RGBA = ['R', 'G', 'B', 'A'];
const PROPERTY_NAMES: Record<string, string> = {
  location: 'Location',
  rotation_euler: 'Euler Rotation',
  scale: 'Scale',
  energy: 'Power',
  lens: 'Focal Length',
  eval_time: 'Evaluation Time',
  custom_props: 'Custom Property',
};
const AXIS_FIRST = new Set(['location', 'rotation_euler', 'scale']);

/**
 * Readable name of an animation channel in Blender style: 'X Location', 'Influence (Track To)',
 * 'Color B', 'amount (Custom Property)'. `length` is the number of channels of the property.
 */
export function channelLabel(path: string, index: number, length = 1): string {
  let segs;
  try {
    segs = parseDataPath(path);
  } catch {
    return `${path}[${index}]`;
  }
  const last = segs[segs.length - 1];
  const props = segs.flatMap((x) => (x.kind === 'prop' ? [x.name] : []));
  const keys = segs.flatMap((x) => (x.kind === 'key' ? [x.key] : []));
  if (last.kind === 'key' && props[props.length - 1] === 'custom_props')
    return `${last.key} (Custom Property)`;
  const prop = props[props.length - 1] ?? path;
  const name = PROPERTY_NAMES[prop] ?? humanize(prop);
  const owner = keys.length ? ` (${keys[keys.length - 1]})` : '';
  if (length <= 1 && index === 0) return `${name}${owner}`;
  const letter = (/color/.test(prop) ? RGBA : AXIS)[index] ?? String(index);
  return AXIS_FIRST.has(prop) ? `${letter} ${name}${owner}` : `${name} ${letter}${owner}`;
}

/** Number of channels of the property at `path` on a datablock (1 for scalars). */
function channelCount(type: AnimTargetType, block: Record<string, unknown> | null, path: string): number {
  const fixed = ANIMATABLE[type]?.[path];
  if (fixed) return fixed;
  let v: unknown;
  try {
    v = block ? getPathValue(block, path) : undefined;
  } catch {
    v = undefined;
  }
  return Array.isArray(v) ? v.length : 1;
}

const DATA_KIND: Partial<Record<AnimTargetType, DatablockKind>> = {
  object: 'objects',
  material: 'materials',
  light: 'lights',
  camera: 'cameras',
  curve: 'curves',
  mesh: 'meshes',
};

/** The stored datablock of an animation target as a plain record (shape key values for meshes). */
function storedBlock(s: ProjectSession, type: AnimTargetType, id: string): Record<string, unknown> | null {
  if (type === 'world') return s.doc.getWorld() as unknown as Record<string, unknown>;
  if (type === 'scene') return s.doc.getScene() as unknown as Record<string, unknown>;
  if (type === 'mesh')
    return s.doc.has('meshes', id)
      ? { shape_keys: s.doc.getShapeKeys(id).map((k) => ({ name: k.name, value: k.value })) }
      : null;
  const kind = DATA_KIND[type];
  return kind ? s.doc.getBlock(kind, id) : null;
}

/** The evaluated (animated and driven) value of a channel, when the evaluation exposes it. */
function evaluatedChannel(
  ev: EvaluatedScene | null,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
): number | null {
  if (!ev) return null;
  let block: unknown = null;
  if (type === 'object') block = ev.byId.get(id)?.data ?? null;
  else if (type === 'world') block = ev.world;
  else
    for (const o of ev.objects) {
      const cand =
        type === 'light'
          ? o.light
          : type === 'camera'
            ? o.camera
            : type === 'curve'
              ? o.curve
              : type === 'material'
                ? o.materials.find((m) => m?.id === id)
                : null;
      if (cand && cand.id === id) {
        block = cand;
        break;
      }
    }
  if (!block) return null;
  return readChannel(block as Record<string, unknown>, path, index) ?? null;
}

/** A datablock whose properties the Object tab can drive: the object itself and its data. */
interface DriverTarget {
  type: AnimTargetType;
  id: string;
  name: string;
}

function driverTargets(s: ProjectSession, o: ObjectData): DriverTarget[] {
  const out: DriverTarget[] = [{ type: 'object', id: o.id, name: o.name }];
  const data = o.data;
  if (data) {
    if (o.type === 'LIGHT')
      out.push({ type: 'light', id: data, name: s.doc.getLight(data)?.name ?? 'Light' });
    if (o.type === 'CAMERA')
      out.push({ type: 'camera', id: data, name: s.doc.getCamera(data)?.name ?? 'Camera' });
    if (o.type === 'CURVE' || o.type === 'FONT')
      out.push({ type: 'curve', id: data, name: s.doc.getCurve(data)?.name ?? 'Curve' });
    if (o.type === 'MESH')
      out.push({ type: 'mesh', id: data, name: s.doc.getMeshBlock(data)?.name ?? 'Mesh' });
  }
  for (const m of new Set(o.material_slots)) {
    const mat = m ? s.doc.getMaterial(m) : null;
    if (mat) out.push({ type: 'material', id: mat.id, name: mat.name });
  }
  return out;
}

/** A property channel that can get a driver. */
interface Channel {
  target: DriverTarget;
  path: string;
  index: number;
  label: string;
  group: string;
}

let particleNumericKeys: string[] | null = null;
function particleNumbers(): string[] {
  if (!particleNumericKeys) {
    const props = (
      safeJsonSchema(ParticleSettingsSchema) as { properties?: Record<string, { type?: string }> }
    ).properties;
    particleNumericKeys = Object.entries(props ?? {})
      .filter(([, v]) => v.type === 'number' || v.type === 'integer')
      .map(([k]) => k);
  }
  return particleNumericKeys;
}

const modifierNumericKeys = new Map<string, string[]>();
/** Numeric parameters of a modifier type (drivable), cached per type. */
function modifierNumbers(type: string): string[] {
  let keys = modifierNumericKeys.get(type);
  if (!keys) {
    const def = getModifierDef(type);
    const props = def
      ? ((safeJsonSchema(def.schema) as { properties?: Record<string, { type?: string }> }).properties ?? {})
      : {};
    keys = Object.entries(props)
      .filter(([, v]) => v.type === 'number' || v.type === 'integer')
      .map(([k]) => k);
    modifierNumericKeys.set(type, keys);
  }
  return keys;
}

const quoteKey = (k: string) => `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Every numeric channel of the object and its data that a driver can set, grouped for a menu. */
function drivableChannels(s: ProjectSession, o: ObjectData): Channel[] {
  const out: Channel[] = [];
  const targets = driverTargets(s, o);
  const self = targets[0];
  const add = (target: DriverTarget, group: string, path: string, length: number) => {
    for (let i = 0; i < length; i++)
      out.push({ target, path, index: i, label: channelLabel(path, i, length), group });
  };
  add(self, 'Transform', 'location', 3);
  add(self, 'Transform', 'rotation_euler', 3);
  add(self, 'Transform', 'scale', 3);
  add(self, 'Viewport Display', 'color', 4);
  for (const c of o.constraints ?? []) {
    add(self, 'Constraints', `constraints[${quoteKey(c.name)}].influence`, 1);
    for (const [k, v] of Object.entries(c.params ?? {}))
      if (typeof v === 'number') add(self, 'Constraints', `constraints[${quoteKey(c.name)}].${k}`, 1);
  }
  for (const m of o.modifiers)
    for (const k of modifierNumbers(m.type)) add(self, 'Modifiers', `modifiers[${quoteKey(m.name)}].${k}`, 1);
  for (const ps of o.particle_systems ?? [])
    for (const k of particleNumbers())
      add(self, 'Particle Systems', `particle_systems[${quoteKey(ps.name)}].${k}`, 1);
  if (o.type === 'ARMATURE')
    for (const bone of Object.keys(o.pose?.bones ?? {}).sort())
      for (const p of ['location', 'rotation_euler', 'scale'])
        add(self, `Pose: ${bone}`, `pose.bones[${quoteKey(bone)}].${p}`, 3);
  for (const [k, v] of Object.entries(o.custom_props))
    if (typeof v === 'number' || typeof v === 'boolean')
      add(self, 'Custom Properties', `custom_props[${quoteKey(k)}]`, 1);
  for (const t of targets.slice(1)) {
    const group = `${t.type.charAt(0).toUpperCase()}${t.type.slice(1)}: ${t.name}`;
    if (t.type === 'mesh') {
      for (const key of s.doc.getShapeKeys(t.id)) add(t, group, `shape_keys[${quoteKey(key.name)}].value`, 1);
      continue;
    }
    for (const [prop, length] of Object.entries(ANIMATABLE[t.type] ?? {})) add(t, group, prop, length);
  }
  return out;
}

// ------------------------------------------------------------------ drivers

const VARIABLE_TYPES: { value: AnimTargetType; label: string }[] = [
  { value: 'object', label: 'Object' },
  { value: 'material', label: 'Material' },
  { value: 'light', label: 'Light' },
  { value: 'camera', label: 'Camera' },
  { value: 'curve', label: 'Curve' },
  { value: 'mesh', label: 'Mesh' },
  { value: 'world', label: 'World' },
  { value: 'scene', label: 'Scene' },
];

/** Datablocks of a type, for variable target pickers. */
function blocksOfType(s: ProjectSession, type: AnimTargetType): { value: string; label: string }[] {
  const named = (ids: Iterable<string>, kind: DatablockKind) =>
    [...ids]
      .map((id) => ({ value: id, label: String(s.doc.getBlock(kind, id)?.name ?? id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  switch (type) {
    case 'object':
      return s.doc.listObjects().map((x) => ({ value: x.id, label: x.name }));
    case 'material':
      return s.doc.listMaterials().map((x) => ({ value: x.id, label: x.name }));
    case 'curve':
      return s.doc.listCurves().map((x) => ({ value: x.id, label: x.name }));
    case 'mesh':
      return s.doc.listMeshBlocks().map((x) => ({ value: x.id, label: x.name }));
    case 'light':
      return named(s.doc.map('lights').keys(), 'lights');
    case 'camera':
      return named(s.doc.map('cameras').keys(), 'cameras');
    default:
      return [];
  }
}

/** Default target of a variable that reads a datablock type (world and scene have exactly one). */
function defaultVariableTarget(s: ProjectSession, type: AnimTargetType, prefer: string): string {
  if (type === 'world') return 'world';
  if (type === 'scene') return 'scene';
  const blocks = blocksOfType(s, type);
  return blocks.find((b) => b.value === prefer)?.value ?? blocks[0]?.value ?? '';
}

const variableInput = (v: DriverVariable) => ({
  name: v.name,
  target_type: v.target_type,
  target: v.target_id,
  path: v.path,
  index: v.index,
});

/** A name not used by the driver's variables yet ('var', 'var_1', …). */
function freeVariableName(vars: readonly DriverVariable[]): string {
  const used = new Set(vars.map((v) => v.name));
  if (!used.has('var')) return 'var';
  for (let i = 1; ; i++) if (!used.has(`var_${i}`)) return `var_${i}`;
}

function DriversPanel({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const targets = driverTargets(s, o);
  const drivers = targets.flatMap((t) =>
    s.doc
      .listDrivers(t.id)
      .filter((d) => d.target_type === t.type)
      .sort((a, b) => String(a.path).localeCompare(String(b.path)) || a.index - b.index)
      .map((d) => ({ d, t })),
  );
  // driven values and errors need an evaluation; objects without drivers skip it
  const ev = drivers.length ? panelEvaluation(s) : null;
  return (
    <Panel
      title={`Drivers${drivers.length ? ` (${drivers.length})` : ''}`}
      id="object-drivers"
      defaultOpen={drivers.length > 0}
    >
      {drivers.length === 0 && (
        <div class="hint">
          No drivers. A driver sets a property every frame from an expression of other properties.
        </div>
      )}
      {drivers.map(({ d, t }) => (
        <DriverBox key={fcurveKey(d)} s={s} d={d} target={t} ev={ev} isObject={t.type === 'object'} />
      ))}
      <AddDriver s={s} o={o} drivers={drivers.map((x) => x.d)} />
      <datalist id="driver-path-suggestions">
        {[...new Set(Object.values(ANIMATABLE).flatMap((m) => Object.keys(m)))].sort().map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </Panel>
  );
}

function AddDriver({ s, o, drivers }: { s: ProjectSession; o: ObjectData; drivers: DriverData[] }) {
  // the selection is the channel's key, not its position: the list changes whenever a constraint,
  // modifier or particle system is added, removed or renamed (here, on a peer or by an agent)
  const [sel, setSel] = useState('');
  const channels = drivableChannels(s, o);
  const driven = new Set(drivers.map((d) => fcurveKey(d)));
  const keyOf = (c: Channel) =>
    fcurveKey({ target_type: c.target.type, target_id: c.target.id, path: c.path, index: c.index });
  const groups: [string, Channel[]][] = [];
  for (const c of channels) {
    const g = groups.find(([name]) => name === c.group);
    if (g) g[1].push(c);
    else groups.push([c.group, [c]]);
  }
  const chosen = sel && !driven.has(sel) ? (channels.find((c) => keyOf(c) === sel) ?? null) : null;
  const add = () => {
    if (!chosen) return;
    const block = storedBlock(s, chosen.target.type, chosen.target.id);
    const current = block ? readChannel(block, chosen.path, chosen.index) : undefined;
    const ok = run(
      'anim.driver_add',
      {
        target_type: chosen.target.type,
        target: chosen.target.id,
        path: chosen.path,
        index: chosen.index,
        expression: fmtValue(current ?? 0),
        variables: [],
        replace: false,
      },
      'ui',
    );
    if (ok) setSel('');
  };
  return (
    <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
      <select
        class="select"
        style={{ flex: 1, minWidth: 0 }}
        value={chosen ? sel : ''}
        data-testid="driver-add-channel"
        aria-label="Property to drive"
        onChange={(e) => setSel((e.target as HTMLSelectElement).value)}
      >
        <option value="">Property to drive…</option>
        {groups.map(([name, items]) => (
          <optgroup key={name} label={name}>
            {items.map((c) => {
              const k = keyOf(c);
              return (
                <option key={k} value={k} disabled={driven.has(k)}>
                  {c.label}
                  {driven.has(k) ? ' (driven)' : ''}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
      <button class="btn" disabled={!chosen} data-testid="driver-add" onClick={add}>
        <Icon name="plus" size={12} /> Add Driver
      </button>
    </div>
  );
}

/** Expression input with live syntax checking; commits on Enter or blur, Escape reverts. */
function ExpressionField(p: {
  value: string;
  variables: DriverVariable[];
  onCommit: (v: string) => void;
  testId?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [, rerender] = useState(0);
  const shown = text ?? p.value;
  const problems = text === null ? [] : driverProblems({ expression: text, variables: p.variables });
  /**
   * Commits the text in the input (a script can type and press Enter before the field renders it),
   * then shows the stored expression: also when the text was typed and committed in one go, which
   * leaves `text` as it was rendered (null) and would render nothing.
   */
  const commit = (typed: string) => {
    try {
      if (typed.trim() && typed !== p.value) p.onCommit(typed.trim());
    } finally {
      setText(null);
      rerender((n) => n + 1);
    }
  };
  return (
    <>
      <input
        class="textfield"
        style={{ fontFamily: 'var(--mono)' }}
        value={shown}
        spellcheck={false}
        aria-label="Driver expression"
        data-testid={p.testId}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          // the keys that confirm or cancel an IME composition belong to it
          if (composing(e)) return;
          const el = e.currentTarget as HTMLInputElement;
          if (e.key === 'Enter') commit(el.value);
          if (e.key === 'Escape') {
            el.value = p.value;
            setText(null);
          }
        }}
        onBlur={(e) => commit((e.currentTarget as HTMLInputElement).value)}
      />
      {problems.length > 0 && <ErrorList messages={problems.slice(0, 2)} />}
    </>
  );
}

function DriverBox(p: {
  s: ProjectSession;
  d: DriverData;
  target: DriverTarget;
  ev: EvaluatedScene | null;
  isObject: boolean;
}) {
  const { s, d, target, ev } = p;
  const key = fcurveKey(d);
  const block = storedBlock(s, d.target_type, d.target_id);
  const label = channelLabel(d.path, d.index, channelCount(d.target_type, block, d.path));
  const errors = sourceErrors(ev, `driver:${key}`);
  const value = evaluatedChannel(ev, d.target_type, d.target_id, d.path, d.index);
  const ref = { target_type: d.target_type, target: d.target_id, path: d.path, index: d.index };
  const update = (patch: Record<string, unknown>) => run('anim.driver_update', { ...ref, ...patch }, 'ui');
  const vars = Array.isArray(d.variables) ? d.variables : [];
  const setVars = (next: DriverVariable[]) => update({ variables: next.map(variableInput) });
  /** The driver's variables as they are now (null when the driver is gone). */
  const varsNow = (): DriverVariable[] | null => {
    const now = s.doc.getDriver(key);
    return now ? (Array.isArray(now.variables) ? now.variables : []) : null;
  };
  /**
   * Changes (or removes, for null) the variable named `name` as the driver is now, not as this panel
   * rendered it: a field commits its text also when it goes away, with what it rendered, after an
   * agent or another person may have changed the variables (their changes stay; a variable they
   * removed or renamed is not written back).
   */
  const editVar = (name: string, change: (v: DriverVariable) => DriverVariable | null) => {
    const now = varsNow();
    const i = now ? now.findIndex((x) => x.name === name) : -1;
    if (!now || i < 0) return;
    const next = change(now[i]);
    setVars(next ? now.map((x, j) => (j === i ? next : x)) : now.filter((_, j) => j !== i));
  };
  const tid = `driver-${d.path}-${d.index}`;
  return (
    <div style={{ ...boxStyle, opacity: d.mute ? 0.6 : 1 }} data-testid={tid}>
      <div style={boxHeaderStyle}>
        <Icon
          name={errors.length ? 'warning' : 'driver'}
          size={12}
          style={{ flex: 'none', color: errors.length ? '#ff7b7b' : '#b18cf0' }}
        />
        <span
          style={{
            flex: 1,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={`${d.path}[${d.index}]`}
        >
          {label}
          {!p.isObject && <span class="hint"> · {target.name}</span>}
        </span>
        <button
          class={`btn flat icon ${d.mute ? '' : 'active'}`}
          title={d.mute ? 'Enable driver' : 'Disable (mute) driver'}
          aria-label={d.mute ? 'Enable driver' : 'Mute driver'}
          data-testid={`${tid}-mute`}
          onClick={() => update({ mute: !d.mute })}
        >
          <Icon name={d.mute ? 'eyeOff' : 'eye'} size={12} />
        </button>
        <button
          class="btn flat icon"
          title="Remove driver"
          aria-label="Remove driver"
          data-testid={`${tid}-remove`}
          onClick={() => run('anim.driver_remove', ref, 'ui')}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <Row label="Expression">
        <ExpressionField
          value={typeof d.expression === 'string' ? d.expression : ''}
          variables={vars}
          testId={`${tid}-expression`}
          onCommit={(expression) => update({ expression })}
        />
      </Row>
      <Row label="Value">
        <span data-testid={`${tid}-value`} style={{ fontFamily: 'var(--mono)' }}>
          {value === null ? '—' : fmtValue(value)}
        </span>
      </Row>
      <ErrorList messages={errors} testId={`${tid}-error`} />
      {vars.map((v, k) => (
        <VariableEditor
          key={k}
          s={s}
          v={v}
          testId={`${tid}-var-${k}`}
          onChange={(patch) => editVar(v.name, (x) => ({ ...x, ...patch }))}
          onRemove={() => editVar(v.name, () => null)}
        />
      ))}
      <div>
        <button
          class="btn flat"
          data-testid={`${tid}-add-variable`}
          title="Add a variable reading a property of an object or datablock"
          onClick={() => {
            const now = varsNow();
            if (!now) return;
            setVars([
              ...now,
              {
                name: freeVariableName(now),
                target_type: d.target_type,
                target_id: defaultVariableTarget(s, d.target_type, d.target_id),
                path:
                  d.target_type === 'object'
                    ? 'location'
                    : (Object.keys(ANIMATABLE[d.target_type] ?? {})[0] ?? d.path),
                index: 0,
              },
            ]);
          }}
        >
          <Icon name="plus" size={12} /> Add Variable
        </button>
      </div>
    </div>
  );
}

function VariableEditor(p: {
  s: ProjectSession;
  v: DriverVariable;
  testId: string;
  /** The fields to change, applied to the variable as it is when they are committed. */
  onChange: (patch: Partial<DriverVariable>) => void;
  onRemove: () => void;
}) {
  const { s, v } = p;
  const pickable = v.target_type !== 'world' && v.target_type !== 'scene';
  const blocks = pickable ? blocksOfType(s, v.target_type) : [];
  return (
    <div style={{ ...boxStyle, background: 'transparent' }} data-testid={p.testId}>
      <div style={boxHeaderStyle}>
        <div style={{ flex: 1 }}>
          <TextField
            value={v.name}
            testId={`${p.testId}-name`}
            ariaLabel="Variable name"
            onChange={(name) => name.trim() && p.onChange({ name: name.trim() })}
          />
        </div>
        <SelectField
          value={v.target_type}
          testId={`${p.testId}-type`}
          title="Datablock type the variable reads"
          options={VARIABLE_TYPES}
          onChange={(t) =>
            p.onChange({
              target_type: t,
              target_id: defaultVariableTarget(s, t, v.target_id),
              path: Object.keys(ANIMATABLE[t] ?? {})[0] ?? v.path,
              index: 0,
            })
          }
        />
        <button
          class="btn flat icon"
          title="Remove variable"
          aria-label="Remove variable"
          data-testid={`${p.testId}-remove`}
          onClick={p.onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {/* compact rows: the path needs the width (e.g. rotation_euler, pose.bones["Arm"].location) */}
      {pickable && (
        <Row label="Target" compact>
          <SelectField
            value={v.target_id}
            testId={`${p.testId}-target`}
            options={
              blocks.some((b) => b.value === v.target_id)
                ? blocks
                : [{ value: v.target_id, label: `${v.target_id} (missing)` }, ...blocks]
            }
            onChange={(id) => p.onChange({ target_id: id })}
          />
        </Row>
      )}
      <Row label="Path" compact>
        <div style={{ display: 'flex', gap: '2px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextField
              value={v.path}
              list="driver-path-suggestions"
              testId={`${p.testId}-path`}
              title={`${v.path}[${v.index}]`}
              ariaLabel="Data path the variable reads"
              onChange={(path) => path.trim() && p.onChange({ path: path.trim() })}
            />
          </div>
          <div
            style={{ width: '40px', flex: 'none' }}
            title="Channel index (0 = X / R, 1 = Y / G, 2 = Z / B)"
          >
            <NumberField
              value={v.index}
              integer
              min={0}
              max={3}
              testId={`${p.testId}-index`}
              onChange={(index, final) => final && p.onChange({ index })}
            />
          </div>
        </div>
      </Row>
    </div>
  );
}

// ------------------------------------------------------------------ F-curves and their modifiers

const EXTRAPOLATIONS = [
  { value: 'CONSTANT', label: 'Constant' },
  { value: 'LINEAR', label: 'Linear' },
  { value: 'CYCLIC', label: 'Cyclic' },
] as const;

function FCurvesPanel({ s, o }: { s: ProjectSession; o: ObjectData }) {
  // the curves of the object and of its data (light, camera, curve, shape keys, materials), like
  // the Drivers panel: e.g. the eval_time curve that Animate Path keys on a path
  const curves = driverTargets(s, o).flatMap((t) =>
    s.doc
      .listFCurves(t.id)
      .filter((fc) => fc.target_type === t.type)
      .sort((a, b) => a.path.localeCompare(b.path) || a.index - b.index)
      .map((fc) => ({ fc, t })),
  );
  return (
    <Panel
      title={`Animation${curves.length ? ` (${curves.length})` : ''}`}
      id="object-fcurves"
      defaultOpen={false}
    >
      {curves.length === 0 && (
        <div class="hint">No animated properties. Insert keyframes (I) to animate this object.</div>
      )}
      {curves.map(({ fc, t }) => (
        <ChannelBox
          key={fcurveKey(fc)}
          s={s}
          o={o}
          fc={fc}
          target={t}
          length={channelCount(fc.target_type, storedBlock(s, fc.target_type, fc.target_id), fc.path)}
          // anim.extrapolation_set selects data curves by object, property and channel only
          shared={curves
            .filter((x) => x.fc !== fc && x.fc.path === fc.path && x.fc.index === fc.index)
            .map((x) => x.t.name)}
        />
      ))}
    </Panel>
  );
}

function ChannelBox(p: {
  s: ProjectSession;
  o: ObjectData;
  fc: FCurve;
  target: DriverTarget;
  length: number;
  /** Datablocks of the object with a curve of the same property and channel. */
  shared: string[];
}) {
  const { s, o, fc } = p;
  const isObject = fc.target_type === 'object';
  const ref = { target_type: fc.target_type, target: fc.target_id, path: fc.path, index: fc.index };
  const driver = s.doc.getDriver(fcurveKey(fc));
  const tid = isObject ? `fcurve-${fc.path}-${fc.index}` : `fcurve-${fc.target_type}-${fc.path}-${fc.index}`;
  const sharedNote =
    !isObject && p.shared.length ? ` (also applies to the same channel of ${p.shared.join(', ')})` : '';
  return (
    <div style={boxStyle} data-testid={tid}>
      {/* the controls move below the name when both do not fit on one line */}
      <div style={{ ...boxHeaderStyle, flexWrap: 'wrap' }}>
        <Icon name="key" size={11} style={{ flex: 'none', color: 'var(--key)' }} />
        <span
          style={{
            flex: '1 0 auto',
            maxWidth: 'calc(100% - 16px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={`${fc.path}[${fc.index}] · ${fc.keyframes.length} keyframe${fc.keyframes.length === 1 ? '' : 's'}`}
        >
          {channelLabel(fc.path, fc.index, p.length)}
          {!isObject && <span class="hint"> · {p.target.name}</span>}
        </span>
        <span style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          <SelectField
            value={fc.extrapolation}
            testId={`${tid}-extrapolation`}
            title={`Extrapolation: how the curve continues before the first and after the last keyframe${sharedNote}`}
            options={EXTRAPOLATIONS.map((e) => ({ ...e }))}
            onChange={(type) =>
              run(
                'anim.extrapolation_set',
                { objects: [o.id], type, path: fc.path, index: fc.index, include_data: !isObject },
                'ui',
              )
            }
          />
          <MenuButton
            label="+ Modifier"
            testId={`${tid}-add-modifier`}
            items={() => [
              { title: 'Add F-Curve Modifier' },
              ...FMODIFIER_TYPE_INFO.map((i) => ({
                label: i.label,
                op: 'anim.fmodifier_add',
                params: { ...ref, type: i.type },
              })),
            ]}
          />
        </span>
      </div>
      {driver && !driver.mute && (
        <div class="hint">Driven: the driver overrides this curve and its modifiers.</div>
      )}
      {(Array.isArray(fc.modifiers) ? fc.modifiers : []).map((m, i) =>
        isRecord(m) ? (
          <FModifierBox key={i} s={s} fc={fc} m={m} index={i} testId={`${tid}-mod-${i}`} />
        ) : null,
      )}
    </div>
  );
}

/** Blender's labels of F-curve modifier settings. */
const FMODIFIER_LABELS: Record<string, string> = {
  blend_type: 'Blend Type',
  use_influence: 'Use Influence',
  use_restricted_range: 'Restricted Frame Range',
  frame_start: 'Start',
  frame_end: 'End',
  blend_in: 'Blend In',
  blend_out: 'Blend Out',
  frame_step: 'Step Size',
  frame_offset: 'Offset',
  use_frame_start: 'Use Start Frame',
  use_frame_end: 'Use End Frame',
  use_additive: 'Additive',
  reference_value: 'Reference Value',
  default_min: 'Min',
  default_max: 'Max',
  use_min_x: 'Minimum X',
  use_max_x: 'Maximum X',
  use_min_y: 'Minimum Y',
  use_max_y: 'Maximum Y',
  min_x: 'Min X',
  max_x: 'Max X',
  min_y: 'Min Y',
  max_y: 'Max Y',
};

/**
 * Settings of an F-curve modifier that are not shown: list-valued ones (own editors) and values
 * whose enabling toggle is off (influence, restricted range, stepped start/end, limits).
 */
function hiddenFModifierParams(params: Record<string, unknown>): string[] {
  const hidden = ['coefficients', 'poly_order', 'control_points'];
  const off = (flag: string) => flag in params && !params[flag];
  if (off('use_influence')) hidden.push('influence');
  if (off('use_restricted_range')) hidden.push('frame_start', 'frame_end', 'blend_in', 'blend_out');
  if (off('use_frame_start')) hidden.push('frame_start');
  if (off('use_frame_end')) hidden.push('frame_end');
  for (const v of ['min_x', 'max_x', 'min_y', 'max_y']) if (off(`use_${v}`)) hidden.push(v);
  return hidden;
}

const fmodSchemas = new Map<string, unknown>();
function fmodSchema(type: string): unknown {
  let schema = fmodSchemas.get(type);
  if (!schema) {
    const z = FMODIFIER_PARAM_SCHEMAS[type as keyof typeof FMODIFIER_PARAM_SCHEMAS];
    schema = z ? safeJsonSchema(z) : { type: 'object' };
    fmodSchemas.set(type, schema);
  }
  return schema;
}

function FModifierBox(p: { s: ProjectSession; fc: FCurve; m: FModifierData; index: number; testId: string }) {
  const { s, fc, m, index } = p;
  const [open, setOpen] = useState(true);
  const info = FMODIFIER_TYPE_INFO.find((t) => t.type === m.type);
  const ref = {
    target_type: fc.target_type,
    target: fc.target_id,
    path: fc.path,
    index: fc.index,
    modifier_index: index,
  };
  const params = (m.params ?? {}) as Record<string, unknown>;
  const update = (patch: Record<string, unknown>) => run('anim.fmodifier_update', { ...ref, ...patch }, 'ui');
  const key = fcurveKey(fc);
  /** Writes one parameter of this modifier into the current curve (nothing when it is gone). */
  const writeParam = (k: string, v: unknown) => {
    const cur = s.doc.getFCurve(key);
    const mod = cur?.modifiers?.[index];
    if (!cur?.modifiers || !isRecord(mod) || mod.type !== m.type) return;
    const modifiers = cur.modifiers.map((x, j) =>
      j === index ? { ...x, params: withField(x.params, k, v) } : x,
    );
    s.doc.setFCurve({ ...cur, modifiers });
  };
  const setParam = (k: string, v: unknown, final: boolean) =>
    dragEdit(
      s,
      `${key}:${index}:${k}`,
      final,
      () => writeParam(k, v),
      captureField(
        () => s.doc.getFCurve(key)?.modifiers?.[index]?.params?.[k],
        (before) => writeParam(k, before),
      ),
      () => update({ params: { [k]: v } }),
    );
  const coefficients = Array.isArray(params.coefficients) ? (params.coefficients as number[]) : [];
  const points = Array.isArray(params.control_points)
    ? (params.control_points as { frame: number; min: number; max: number }[])
    : [];
  const setPoints = (next: typeof points) => update({ params: { control_points: next } });
  return (
    <div style={{ ...boxStyle, background: 'transparent', opacity: m.mute ? 0.6 : 1 }} data-testid={p.testId}>
      <div style={{ ...boxHeaderStyle, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <span style={{ width: '10px', color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
        <Icon name="fmodifier" size={12} style={{ flex: 'none' }} />
        <span style={{ flex: 1 }} title={info?.description}>
          {info?.label ?? m.type}
        </span>
        <span style={{ display: 'flex', gap: '2px' }} onClick={(e) => e.stopPropagation()}>
          <button
            class={`btn flat icon ${m.mute ? '' : 'active'}`}
            title={m.mute ? 'Enable modifier' : 'Disable (mute) modifier'}
            aria-label={m.mute ? 'Enable modifier' : 'Mute modifier'}
            data-testid={`${p.testId}-mute`}
            onClick={() => update({ mute: !m.mute })}
          >
            <Icon name={m.mute ? 'eyeOff' : 'eye'} size={12} />
          </button>
          <button
            class="btn flat icon"
            title="Remove modifier"
            aria-label="Remove modifier"
            data-testid={`${p.testId}-remove`}
            onClick={() => run('anim.fmodifier_remove', ref, 'ui')}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      </div>
      {open && (
        <>
          <SchemaForm
            schema={fmodSchema(m.type)}
            values={params}
            exclude={hiddenFModifierParams(params)}
            labels={FMODIFIER_LABELS}
            testIdPrefix={p.testId}
            onChange={setParam}
          />
          {m.type === 'GENERATOR' && (
            <Row label="Coefficients" title="c0, c1, c2 … (lowest power first): c0 + c1·frame + c2·frame² …">
              <TextField
                value={coefficients.join(', ')}
                testId={`${p.testId}-coefficients`}
                onChange={(t) => {
                  const nums = t
                    .split(/[\s,;]+/)
                    .filter(Boolean)
                    .map(Number);
                  if (nums.length && nums.every(Number.isFinite)) update({ params: { coefficients: nums } });
                }}
              />
            </Row>
          )}
          {m.type === 'ENVELOPE' && (
            <>
              {points.map((pt, k) => (
                <Row key={k} label={k === 0 ? 'Control Points' : ''}>
                  <div style={{ display: 'flex', gap: '2px' }}>
                    {(['frame', 'min', 'max'] as const).map((f) => (
                      <div key={f} style={{ flex: 1 }}>
                        <NumberField
                          label={f === 'frame' ? 'Fr' : f === 'min' ? 'Min' : 'Max'}
                          value={pt[f]}
                          precision={f === 'frame' ? 0 : 3}
                          step={f === 'frame' ? 1 : 0.01}
                          onChange={(v, final) =>
                            final && setPoints(points.map((x, j) => (j === k ? { ...x, [f]: v } : x)))
                          }
                        />
                      </div>
                    ))}
                    <button
                      class="btn flat icon"
                      title="Remove control point"
                      aria-label="Remove control point"
                      onClick={() => setPoints(points.filter((_, j) => j !== k))}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                </Row>
              ))}
              <Row label={points.length ? '' : 'Control Points'}>
                <button
                  class="btn"
                  data-testid={`${p.testId}-add-point`}
                  onClick={() =>
                    setPoints([...points, { frame: Math.round(s.state.frame), min: -1, max: 1 }])
                  }
                >
                  <Icon name="plus" size={12} /> Add Control Point
                </button>
              </Row>
            </>
          )}
        </>
      )}
    </div>
  );
}
