import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  BONE_CONSTRAINT_LABELS,
  cameraFovY,
  decodeFloat32,
  defaultPoseBone,
  lensFromFovY,
  meshStats,
  poseBonePath,
  sanitizeSpline,
  type BoneConstraintType,
  type BoneData,
  type CameraData,
  type ConstraintData,
  type CurveData,
  type LightData,
  type ObjectData,
  type ShapeKeyData,
  type Spline,
  type SplinePoint,
  type Vec3,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import {
  Checkbox,
  ColorField,
  EnumButtons,
  NumberField,
  Panel,
  Row,
  SelectField,
  TextField,
  VectorField,
  RAD,
} from '../fields/fields';
import { animState, animatedValue, setProp } from './prop-edit';
import { animatedBlock } from './animated';
import { run, runResult } from '../../editor/editor';
import { Icon, type IconName } from '../icons';
import {
  ErrorList,
  boneOptions,
  boxHeaderStyle,
  boxStyle,
  dragEdit,
  panelEvaluation,
  sourceErrors,
} from './ObjectTab';

/*
 * Object Data tab (Blender's Properties > Data): mesh statistics, normals, vertex groups and shape
 * keys; curve shape, geometry, bevel, path animation and the active spline; text body, font and
 * paragraph; armature skeleton, display, bones and the pose of the active bone (with IK); lights
 * and cameras. Every change runs an operator (one undo step); slider drags are previewed live.
 */

export function DataTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  if (o.type === 'MESH' && o.data) return <MeshData s={s} o={o} />;
  if ((o.type === 'CURVE' || o.type === 'FONT') && o.data) return <CurvePanels s={s} o={o} />;
  if (o.type === 'ARMATURE' && o.data) return <ArmaturePanels s={s} o={o} />;
  if (o.type === 'LIGHT' && o.data) return <LightPanel s={s} id={o.data} />;
  if (o.type === 'CAMERA' && o.data) return <CameraPanel s={s} id={o.data} />;
  return <div class="empty-note">Empties have no object data.</div>;
}

// ------------------------------------------------------------------ shared helpers

/** The active entry of a list (UI state, like Blender's active_index): its name and position. */
export interface ActiveEntry {
  name: string;
  index: number;
}

/**
 * Index of the active entry in a list of names: the entry with the remembered name, else (after a
 * rename made elsewhere: undo, redo, an MCP agent or a collaborator) the entry at the remembered
 * position, the last one when the list got shorter; -1 for none.
 */
export function activeEntryIndex(names: readonly string[], entry: ActiveEntry | undefined): number {
  if (!entry || !names.length) return -1;
  const i = names.indexOf(entry.name);
  if (i >= 0) return i;
  return entry.index < 0 ? -1 : Math.min(entry.index, names.length - 1);
}

/** The entry to remember for `name` in a list (its position now). */
const entryOf = (names: readonly string[], name: string): ActiveEntry => ({
  name,
  index: names.indexOf(name),
});

/** Active list entries per datablock (UI state, like Blender's active_index). */
const activeVertexGroups = signal<Record<string, ActiveEntry>>({});
const activeShapeKeys = signal<Record<string, ActiveEntry>>({});
const activeBones = signal<Record<string, ActiveEntry>>({});
const activeSplines = signal<Record<string, number>>({});
/** Weight used by Assign in Edit Mode (Blender's tool setting vertex_group_weight). */
const vertexGroupWeight = signal(1);

const SUBHEAD = { margin: '6px 0 2px', fontWeight: 600, color: 'var(--text-dim)' } as const;
const LIST_STYLE = {
  flex: 1,
  minHeight: '68px',
  maxHeight: '180px',
  overflowY: 'auto',
  background: 'var(--bg-input-dark)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
} as const;
const BUTTON_ROW = { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } as const;
/** A value at the end of a list row (readable on the highlighted active row too). */
const LIST_VALUE = { marginLeft: 'auto', paddingRight: '6px', opacity: 0.7, fontSize: '11px' } as const;

/** A Blender-style list (UIList) with a column of buttons on its right. */
function UIList(p: {
  label: string;
  testId: string;
  empty: string;
  rows: { key: string; content: ComponentChildren; testId?: string; title?: string }[];
  active: number;
  onSelect: (index: number) => void;
  buttons: ComponentChildren;
}) {
  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      <div role="listbox" aria-label={p.label} data-testid={p.testId} style={LIST_STYLE}>
        {p.rows.map((r, i) => (
          <div
            key={r.key}
            role="option"
            aria-selected={i === p.active}
            class={`outliner-row ${i === p.active ? 'active' : ''}`}
            style={{ paddingLeft: '6px' }}
            data-testid={r.testId}
            title={r.title}
            onClick={() => p.onSelect(i)}
          >
            {r.content}
          </div>
        ))}
        {p.rows.length === 0 && (
          <div class="hint" style={{ padding: '6px 8px' }}>
            {p.empty}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>{p.buttons}</div>
    </div>
  );
}

function IconButton(p: {
  icon: IconName;
  title: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      class="btn icon"
      title={p.title}
      aria-label={p.title}
      data-testid={p.testId}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <Icon name={p.icon} size={12} />
    </button>
  );
}

function ContextLine({ icon, name, users }: { icon: IconName; name: string; users: number }) {
  return (
    <div class="prop-context">
      <Icon name={icon} size={14} /> {name}
      {users > 1 && <span class="badge">{users} users</span>}
    </div>
  );
}

const humanize = (v: string) =>
  v
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

/** Dropdown options that always contain the current value (shown as is when it is not a choice). */
function withCurrent<T extends string>(options: { value: T; label: string }[], current: T) {
  return options.some((o) => o.value === current)
    ? options
    : [...options, { value: current, label: humanize(current) }];
}

// ------------------------------------------------------------------ mesh

function MeshData({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const block = s.doc.getMeshBlock(o.data!);
  const mesh = s.doc.getMesh(o.data!);
  if (!block || !mesh) return null;
  const st = meshStats(mesh);
  const users = s.doc.dataUsers(o.data!);
  const smoothFaces = mesh.faceSmooth.filter(Boolean).length;
  return (
    <>
      <ContextLine icon="data" name={block.name} users={users} />
      <VertexGroupsPanel s={s} o={o} meshId={block.id} vertexCount={mesh.positions.length / 3} />
      <ShapeKeysPanel s={s} o={o} meshId={block.id} />
      <Panel title="Statistics">
        <div class="hint">
          Vertices {st.vertices.toLocaleString()} · Edges {st.edges.toLocaleString()} · Faces{' '}
          {st.faces.toLocaleString()} · Triangles {st.triangles.toLocaleString()}
        </div>
      </Panel>
      <Panel title="Normals">
        <div class="hint">
          {smoothFaces === 0
            ? 'Flat shaded'
            : smoothFaces === mesh.faces.length
              ? 'Smooth shaded'
              : `${smoothFaces} smooth faces`}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button class="btn" onClick={() => run('object.shade_flat', {}, 'ui')}>
            Flat
          </button>
          <button class="btn" onClick={() => run('object.shade_smooth', {}, 'ui')}>
            Smooth
          </button>
          <button class="btn" onClick={() => run('object.shade_auto_smooth', {}, 'ui')}>
            Auto Smooth
          </button>
        </div>
      </Panel>
      <Panel title="Attributes" defaultOpen={false}>
        <div class="hint">
          UV map: {mesh.uvs ? 'yes' : 'none'} · Vertex colors: {mesh.colors ? 'yes' : 'none'}
        </div>
        <div class="hint">
          Seams: {Object.values(mesh.edgeAttrs).filter((a) => a.seam).length} · Sharp edges:{' '}
          {Object.values(mesh.edgeAttrs).filter((a) => a.sharp).length}
        </div>
      </Panel>
    </>
  );
}

const weightCounts = new WeakMap<Uint8Array, number>();
/** Number of vertices with a weight above zero (cached per weights buffer). */
export function assignedVertexCount(weights: Uint8Array): number {
  let n = weightCounts.get(weights);
  if (n === undefined) {
    n = 0;
    for (const w of decodeFloat32(weights)) if (w > 0) n++;
    weightCounts.set(weights, n);
  }
  return n;
}

function VertexGroupsPanel(p: { s: ProjectSession; o: ObjectData; meshId: string; vertexCount: number }) {
  const { s, o, meshId } = p;
  const groups = s.doc.getVertexGroups(meshId);
  const index = Math.max(
    0,
    activeEntryIndex(
      groups.map((g) => g.name),
      activeVertexGroups.value[meshId],
    ),
  );
  const active = groups[index] ?? null;
  const select = (name: string) =>
    (activeVertexGroups.value = {
      ...activeVertexGroups.value,
      [meshId]: entryOf(
        s.doc.getVertexGroups(meshId).map((g) => g.name),
        name,
      ),
    });
  const editing = s.state.mode === 'EDIT' && s.state.activeId === o.id;
  const add = () => {
    const r = runResult('object.vertex_group_add', { object: o.id, name: 'Group' }, 'ui');
    const name = (r?.result as { group?: string } | undefined)?.group;
    if (r?.ok && name) select(name);
  };
  return (
    <Panel title="Vertex Groups" id="data-vertex-groups">
      <UIList
        label="Vertex groups"
        testId="vertex-groups"
        empty="No vertex groups"
        active={index}
        onSelect={(i) => select(groups[i].name)}
        rows={groups.map((g) => {
          const count = assignedVertexCount(g.weights);
          return {
            key: g.name,
            testId: `vgroup-${g.name}`,
            title: `${count} of ${p.vertexCount} vertices have a weight`,
            content: (
              <>
                <Icon name="mesh" size={13} />
                <span class="name">{g.name}</span>
                <span style={LIST_VALUE}>{count}</span>
              </>
            ),
          };
        })}
        buttons={
          <>
            <IconButton icon="plus" title="Add vertex group" testId="vgroup-add" onClick={add} />
            <IconButton
              icon="minus"
              title="Remove the vertex group"
              testId="vgroup-remove"
              disabled={!active}
              onClick={() =>
                active && run('object.vertex_group_remove', { object: o.id, group: active.name }, 'ui')
              }
            />
          </>
        }
      />
      {active && (
        <>
          <Row label="Name">
            <TextField
              value={active.name}
              testId="vgroup-name"
              ariaLabel="Vertex group name"
              onChange={(v) => {
                const name = v.trim();
                if (!name || name === active.name) return;
                const r = runResult(
                  'object.vertex_group_rename',
                  { object: o.id, group: active.name, name },
                  'ui',
                );
                const renamed = (r?.result as { group?: string } | undefined)?.group;
                if (r?.ok) select(renamed ?? name);
              }}
            />
          </Row>
          {editing ? (
            <>
              <Row label="Weight" title="Weight given to the selected vertices by Assign">
                <NumberField
                  value={vertexGroupWeight.value}
                  min={0}
                  max={1}
                  slider
                  testId="vgroup-weight"
                  onChange={(v) => (vertexGroupWeight.value = v)}
                />
              </Row>
              <div style={BUTTON_ROW}>
                <button
                  class="btn"
                  data-testid="vgroup-assign"
                  title="Give the selected vertices this weight in the group"
                  onClick={() =>
                    run(
                      'object.vertex_group_assign',
                      { object: o.id, group: active.name, weight: vertexGroupWeight.value },
                      'ui',
                    )
                  }
                >
                  Assign
                </button>
                <button
                  class="btn"
                  data-testid="vgroup-remove-from"
                  title="Remove the selected vertices from the group"
                  onClick={() =>
                    run('object.vertex_group_remove_from', { object: o.id, group: active.name }, 'ui')
                  }
                >
                  Remove
                </button>
              </div>
            </>
          ) : (
            <div class="hint">Assign selected vertices with a weight in Edit Mode (Tab).</div>
          )}
        </>
      )}
      {groups.length > 0 && (
        <div style={BUTTON_ROW}>
          <button
            class="btn"
            data-testid="vgroup-normalize-all"
            title="Scale the weights of every vertex so its groups add up to 1"
            onClick={() => run('object.vertex_group_normalize_all', { object: o.id }, 'ui')}
          >
            Normalize All
          </button>
        </div>
      )}
    </Panel>
  );
}

/** Live previews rewrite every key of a mesh, so they are skipped for heavy shape key sets. */
const SHAPE_KEY_PREVIEW_BYTES = 2_000_000;

export const shapeKeyPath = (name: string) => `shape_keys[${JSON.stringify(name)}].value`;

function ShapeKeysPanel({ s, o, meshId }: { s: ProjectSession; o: ObjectData; meshId: string }) {
  const keys = s.doc.getShapeKeys(meshId);
  // none: the Basis row
  const activeIndex = activeEntryIndex(
    keys.map((k) => k.name),
    activeShapeKeys.value[meshId],
  );
  const active: ShapeKeyData | null = activeIndex >= 0 ? keys[activeIndex] : null;
  const select = (name: string) =>
    (activeShapeKeys.value = {
      ...activeShapeKeys.value,
      [meshId]: entryOf(
        s.doc.getShapeKeys(meshId).map((k) => k.name),
        name,
      ),
    });
  const bytes = keys.reduce((n, k) => n + (k.data?.length ?? 0), 0);
  const value = (k: ShapeKeyData) => animatedValue(s, 'mesh', meshId, shapeKeyPath(k.name), 0, k.value);
  const setKey = (
    k: ShapeKeyData,
    field: 'value' | 'slider_min' | 'slider_max',
    v: number,
    final: boolean,
  ) => {
    if (!final && (field !== 'value' || bytes > SHAPE_KEY_PREVIEW_BYTES)) return;
    /** Sets the field of this key in the current list (other keys and fields stay as they are now). */
    const write = (value: number) =>
      s.doc.setShapeKeys(
        meshId,
        s.doc.getShapeKeys(meshId).map((x) => (x.name === k.name ? { ...x, [field]: value } : x)),
      );
    dragEdit(
      s,
      `shapekey:${meshId}:${k.name}:${field}`,
      final,
      () => write(v),
      () => {
        const before = s.doc.getShapeKeys(meshId).find((x) => x.name === k.name)?.[field];
        return () => {
          if (typeof before === 'number') write(before);
        };
      },
      () => run('object.shape_key_set', { object: o.id, key: k.name, [field]: v }, 'ui'),
    );
  };
  const add = (fromMix: boolean) => {
    const r = runResult('object.shape_key_add', { object: o.id, from_mix: fromMix }, 'ui');
    const name = (r?.result as { key?: string } | undefined)?.key;
    if (r?.ok && name) select(name);
  };
  const rows = [
    {
      key: '\0basis',
      testId: 'shape-key-Basis',
      title: 'The mesh itself is the basis shape',
      content: (
        <>
          <Icon name="key" size={13} />
          <span class="name">Basis</span>
        </>
      ),
    },
    ...keys.map((k) => ({
      key: k.name,
      testId: `shape-key-${k.name}`,
      content: (
        <>
          <Icon name="key" size={13} />
          <span class="name" style={{ opacity: k.mute ? 0.5 : 1 }}>
            {k.name}
          </span>
          <span style={{ ...LIST_VALUE, paddingRight: 0 }}>{value(k).toFixed(3)}</span>
          <span
            class="vis"
            title={k.mute ? 'Enable the shape key' : 'Mute the shape key'}
            data-testid={`shape-key-${k.name}-mute`}
            onClick={(e) => {
              e.stopPropagation();
              run('object.shape_key_set', { object: o.id, key: k.name, mute: !k.mute }, 'ui');
            }}
          >
            <Icon name={k.mute ? 'eyeOff' : 'eye'} size={13} />
          </span>
        </>
      ),
    })),
  ];
  return (
    <Panel title="Shape Keys" id="data-shape-keys">
      <UIList
        label="Shape keys"
        testId="shape-keys"
        empty="No shape keys"
        active={keys.length ? activeIndex + 1 : -1}
        onSelect={(i) => select(i === 0 ? '' : keys[i - 1].name)}
        rows={keys.length ? rows : []}
        buttons={
          <>
            <IconButton
              icon="plus"
              title={keys.length ? 'Add a shape key from the basis' : 'Add shape keys (Basis and Key 1)'}
              testId="shape-key-add"
              onClick={() => add(false)}
            />
            <IconButton
              icon="minus"
              title="Remove the shape key"
              testId="shape-key-remove"
              disabled={!active}
              onClick={() =>
                active && run('object.shape_key_remove', { object: o.id, key: active.name }, 'ui')
              }
            />
          </>
        }
      />
      {keys.length > 0 && (
        <div style={BUTTON_ROW}>
          <button
            class="btn"
            data-testid="shape-key-add-mix"
            title="New shape key from the current blend of all keys"
            onClick={() => add(true)}
          >
            New from Mix
          </button>
          <button
            class="btn"
            data-testid="shape-key-clear"
            title="Set every shape key value to 0"
            onClick={() => run('object.shape_key_clear', { object: o.id }, 'ui')}
          >
            Clear Values
          </button>
          <button
            class="btn"
            data-testid="shape-key-apply-all"
            title="Apply the current blend to the mesh and remove every shape key"
            onClick={() => run('object.shape_key_remove', { object: o.id, all: true, apply_mix: true }, 'ui')}
          >
            Apply All
          </button>
        </div>
      )}
      {keys.length > 0 && !active && (
        <div class="hint">The mesh itself is the Basis shape; Edit Mode edits the Basis.</div>
      )}
      {active && (
        <>
          <Row label="Name">
            <TextField
              value={active.name}
              testId="shape-key-name"
              ariaLabel="Shape key name"
              onChange={(v) => {
                const name = v.trim();
                if (!name || name === active.name) return;
                const r = runResult('object.shape_key_set', { object: o.id, key: active.name, name }, 'ui');
                const renamed = (r?.result as { key?: string } | undefined)?.key;
                if (r?.ok && renamed) select(renamed);
              }}
            />
          </Row>
          <Row label="Value">
            <NumberField
              value={value(active)}
              min={active.slider_min}
              max={active.slider_max}
              slider
              state={animState(s, 'mesh', meshId, shapeKeyPath(active.name), 0)}
              testId="shape-key-value"
              onChange={(v, f) => setKey(active, 'value', v, f)}
            />
          </Row>
          <Row label="Range Min">
            <NumberField
              value={active.slider_min}
              min={-10}
              max={active.slider_max}
              testId="shape-key-min"
              onChange={(v, f) => setKey(active, 'slider_min', v, f)}
            />
          </Row>
          <Row label="Max">
            <NumberField
              value={active.slider_max}
              min={active.slider_min}
              max={10}
              testId="shape-key-max"
              onChange={(v, f) => setKey(active, 'slider_max', v, f)}
            />
          </Row>
          <Row label="Relative To">
            <SelectField
              value={active.relative_key}
              testId="shape-key-relative"
              options={[
                { value: '', label: 'Basis' },
                ...keys.filter((k) => k.name !== active.name).map((k) => ({ value: k.name, label: k.name })),
              ]}
              onChange={(v) =>
                run('object.shape_key_set', { object: o.id, key: active.name, relative_key: v }, 'ui')
              }
            />
          </Row>
          <Row label="">
            <Checkbox
              value={active.mute}
              label="Mute"
              testId="shape-key-mute"
              onChange={(v) => run('object.shape_key_set', { object: o.id, key: active.name, mute: v }, 'ui')}
            />
          </Row>
          <Row label="">
            <button
              class="btn"
              data-testid="shape-key-keyframe"
              title="Insert a keyframe on the value at the current frame"
              onClick={() =>
                run(
                  'object.shape_key_set',
                  { object: o.id, key: active.name, value: value(active), keyframe: true },
                  'ui',
                )
              }
            >
              <Icon name="key" size={12} /> Insert Keyframe
            </button>
          </Row>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ curve and text

/** Fields set with font.text_set (the others with curve.properties_set). */
const TEXT_FIELDS = new Set([
  'body',
  'size',
  'space_line',
  'space_word',
  'space_character',
  'shear',
  'align_x',
  'align_y',
  'offset_x',
  'offset_y',
]);

const FILL_2D = [
  { value: 'BOTH', label: 'Both' },
  { value: 'FRONT', label: 'Front' },
  { value: 'BACK', label: 'Back' },
  { value: 'NONE', label: 'None' },
] as const;
const FILL_3D = [
  { value: 'FULL', label: 'Full' },
  { value: 'HALF', label: 'Half' },
  { value: 'FRONT', label: 'Front' },
  { value: 'BACK', label: 'Back' },
] as const;

/**
 * The operator that sets a curve/text data field and its parameters (curve.properties_set or
 * font.text_set); bevel_object references are passed as object ids.
 */
export function curveFieldOperator(
  objectId: string,
  field: string,
  value: unknown,
): { id: string; params: Record<string, unknown> } {
  return {
    id: TEXT_FIELDS.has(field) ? 'font.text_set' : 'curve.properties_set',
    params: { object: objectId, [field]: value },
  };
}

function CurvePanels({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const curve = s.doc.getCurve(o.data!);
  if (!curve) return <div class="empty-note">The curve data is missing.</div>;
  const isText = o.type === 'FONT';
  const ev = panelEvaluation(s);
  const evCurve = ev?.byId.get(o.id)?.curve;
  const st = (f: keyof CurveData) => animState(s, 'curve', curve.id, f, 0);
  /** A number field's value: the animated value at this frame when the field is animated. */
  const num = (f: keyof CurveData): number => {
    const v = st(f) && evCurve ? evCurve[f] : curve[f];
    return typeof v === 'number' ? v : 0;
  };
  const set = (field: keyof CurveData, value: unknown, final = true) =>
    dragEdit(
      s,
      `curve:${curve.id}:${field}`,
      final,
      () => s.doc.updateCurve(curve.id, { [field]: value } as Partial<CurveData>),
      () => {
        const before = s.doc.getCurve(curve.id)?.[field];
        return () => s.doc.updateCurve(curve.id, { [field]: before } as Partial<CurveData>);
      },
      () => {
        const op = curveFieldOperator(o.id, field, value);
        run(op.id, op.params, 'ui');
      },
    );
  const is2D = isText || curve.dimensions === '2D';
  const bevelObjects = s.doc.listObjects().filter((x) => x.type === 'CURVE' && x.id !== o.id);
  return (
    <>
      <ContextLine icon={isText ? 'font' : 'curve'} name={curve.name} users={s.doc.dataUsers(curve.id)} />
      <div style={{ padding: '0 8px' }}>
        <ErrorList messages={sourceErrors(ev, `curve:${o.id}`)} testId="curve-errors" />
      </div>
      {isText && <TextPanels s={s} o={o} curve={curve} num={num} st={st} set={set} />}
      <Panel title="Shape" id="curve-shape">
        {!isText && (
          <Row label="Dimensions">
            <EnumButtons
              value={curve.dimensions}
              testId="curve-dimensions"
              options={[
                { value: '2D', label: '2D' },
                { value: '3D', label: '3D' },
              ]}
              onChange={(v) => set('dimensions', v)}
            />
          </Row>
        )}
        {!is2D && (
          <Row label="Twist Method" title="Orientation of the bevel along the curve">
            <SelectField
              value={curve.twist_mode}
              testId="curve-twist"
              options={[
                { value: 'Z_UP', label: 'Z-Up' },
                { value: 'MINIMUM', label: 'Minimum' },
                { value: 'TANGENT', label: 'Tangent' },
              ]}
              onChange={(v) => set('twist_mode', v)}
            />
          </Row>
        )}
        <Row label="Fill Mode">
          <SelectField
            value={curve.fill_mode}
            testId="curve-fill-mode"
            options={withCurrent<CurveData['fill_mode']>(
              (is2D ? FILL_2D : FILL_3D).map((x) => ({ ...x })),
              curve.fill_mode,
            )}
            onChange={(v) => set('fill_mode', v)}
          />
        </Row>
        <div class="hint" style={SUBHEAD}>
          Resolution
        </div>
        <Row label="Preview U" title="Resolution Preview U: samples per segment between control points">
          <NumberField
            value={curve.resolution_u}
            integer
            min={1}
            max={1024}
            testId="curve-resolution"
            onChange={(v, f) => set('resolution_u', v, f)}
          />
        </Row>
        <Row
          label="Render U"
          title="Resolution Render U: samples per segment in final renders (0 = Preview U)"
        >
          <NumberField
            value={curve.render_resolution_u}
            integer
            min={0}
            max={1024}
            testId="curve-render-resolution"
            onChange={(v, f) => set('render_resolution_u', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Geometry" id="curve-geometry">
        <Row label="Offset" title="Sideways offset of the bevel, extrusion or fill outline">
          <NumberField
            value={num('offset')}
            step={0.01}
            unit=" m"
            state={st('offset')}
            testId="curve-offset"
            onChange={(v, f) => set('offset', v, f)}
          />
        </Row>
        <Row
          label="Extrude"
          title={isText ? 'Half the thickness of the text' : 'Half the height of the ribbon'}
        >
          <NumberField
            value={num('extrude')}
            min={0}
            step={0.01}
            unit=" m"
            state={st('extrude')}
            testId="curve-extrude"
            onChange={(v, f) => set('extrude', v, f)}
          />
        </Row>
        <div class="hint" style={SUBHEAD}>
          Bevel
        </div>
        <Row label="">
          <EnumButtons
            value={curve.bevel_mode}
            testId="curve-bevel-mode"
            options={[
              { value: 'ROUND', label: 'Round' },
              { value: 'OBJECT', label: 'Object' },
            ]}
            onChange={(v) => set('bevel_mode', v)}
          />
        </Row>
        {curve.bevel_mode === 'OBJECT' ? (
          <Row label="Object" title="Curve object whose shape is swept along this curve">
            <SelectField
              value={curve.bevel_object ?? ''}
              testId="curve-bevel-object"
              options={[
                { value: '', label: '— none —' },
                ...bevelObjects.map((x) => ({ value: x.id, label: x.name })),
                ...(curve.bevel_object && !bevelObjects.some((x) => x.id === curve.bevel_object)
                  ? [{ value: curve.bevel_object, label: `${curve.bevel_object} (missing)` }]
                  : []),
              ]}
              onChange={(v) => set('bevel_object', v || null)}
            />
          </Row>
        ) : (
          <>
            <Row label="Depth" title="Radius of the round bevel (0 = none)">
              <NumberField
                value={num('bevel_depth')}
                min={0}
                step={0.005}
                unit=" m"
                state={st('bevel_depth')}
                testId="curve-bevel-depth"
                onChange={(v, f) => set('bevel_depth', v, f)}
              />
            </Row>
            <Row label="Resolution" title="Smoothness of the round bevel">
              <NumberField
                value={curve.bevel_resolution}
                integer
                min={0}
                max={32}
                testId="curve-bevel-resolution"
                onChange={(v, f) => set('bevel_resolution', v, f)}
              />
            </Row>
          </>
        )}
        <Row label="">
          <Checkbox
            value={curve.use_fill_caps}
            label="Fill Caps"
            testId="curve-fill-caps"
            onChange={(v) => set('use_fill_caps', v)}
          />
        </Row>
        {!isText && (
          <div class="hint" data-testid="curve-taper-note">
            Taper: the bevel and the extrusion are scaled by the Radius of each control point (0 = pointed
            end); radii are set per point with the curve.spline_set_points operator (F3).
          </div>
        )}
        <div class="hint" style={SUBHEAD}>
          Start &amp; End Mapping
        </div>
        <Row label="Factor Start" title="Where along the curve the bevel starts (0..1)">
          <NumberField
            value={num('bevel_factor_start')}
            min={0}
            max={1}
            slider
            state={st('bevel_factor_start')}
            testId="curve-factor-start"
            onChange={(v, f) => set('bevel_factor_start', v, f)}
          />
        </Row>
        <Row label="End" title="Where along the curve the bevel ends (animate it to grow the curve)">
          <NumberField
            value={num('bevel_factor_end')}
            min={0}
            max={1}
            slider
            state={st('bevel_factor_end')}
            testId="curve-factor-end"
            onChange={(v, f) => set('bevel_factor_end', v, f)}
          />
        </Row>
      </Panel>
      {!isText && (
        <Panel title="Path Animation" id="curve-path" defaultOpen={false}>
          <Row label="">
            <Checkbox
              value={curve.use_path}
              label="Path Animation"
              testId="curve-use-path"
              onChange={(v) => set('use_path', v)}
            />
          </Row>
          <Row label="Frames" title="Frames needed to traverse the path (Follow Path)">
            <NumberField
              value={curve.path_duration}
              integer
              min={1}
              testId="curve-path-frames"
              onChange={(v, f) => set('path_duration', v, f)}
            />
          </Row>
          <Row label="Evaluation Time" title="Position along the path in frames (animatable)">
            <NumberField
              value={num('eval_time')}
              step={1}
              state={st('eval_time')}
              testId="curve-eval-time"
              onChange={(v, f) => set('eval_time', v, f)}
            />
          </Row>
        </Panel>
      )}
      {!isText && <ActiveSplinePanel s={s} o={o} curve={curve} />}
    </>
  );
}

function TextBody({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <textarea
      class="textfield"
      aria-label="Text"
      data-testid="font-body"
      title="Text (Ctrl+Enter or leaving the field applies it)"
      rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
      value={text}
      style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', padding: '4px 6px', height: 'auto' }}
      onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') setText(value);
        e.stopPropagation();
      }}
    />
  );
}

function TextPanels(p: {
  s: ProjectSession;
  o: ObjectData;
  curve: CurveData;
  num: (f: keyof CurveData) => number;
  st: (f: keyof CurveData) => ReturnType<typeof animState>;
  set: (field: keyof CurveData, value: unknown, final?: boolean) => void;
}) {
  const { o, curve, num, st, set } = p;
  const body = curve.body ?? '';
  const lines = body.length ? body.split('\n').length : 0;
  return (
    <>
      <Panel title="Text" id="font-text">
        <TextBody value={body} onCommit={(v) => run('font.text_set', { object: o.id, body: v }, 'ui')} />
        <div class="hint">
          {lines} line{lines === 1 ? '' : 's'} · {body.replace(/\n/g, '').length} characters · built-in
          sans-serif font
        </div>
      </Panel>
      <Panel title="Font" id="font-font">
        <Row label="Size" title="One em in metres (capital letters are 0.7 × size)">
          <NumberField
            value={num('size')}
            min={0.001}
            step={0.01}
            unit=" m"
            state={st('size')}
            testId="font-size"
            onChange={(v, f) => set('size', v, f)}
          />
        </Row>
        <Row label="Shear" title="Italic slant">
          <NumberField
            value={num('shear')}
            min={-1}
            max={1}
            slider
            state={st('shear')}
            testId="font-shear"
            onChange={(v, f) => set('shear', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Paragraph" id="font-paragraph">
        <div class="hint" style={SUBHEAD}>
          Alignment
        </div>
        <Row label="Horizontal">
          <SelectField
            value={curve.align_x}
            testId="font-align-x"
            options={[
              { value: 'LEFT', label: 'Left' },
              { value: 'CENTER', label: 'Center' },
              { value: 'RIGHT', label: 'Right' },
              { value: 'JUSTIFY', label: 'Justify' },
              { value: 'FLUSH', label: 'Flush' },
            ]}
            onChange={(v) => set('align_x', v)}
          />
        </Row>
        <Row label="Vertical">
          <SelectField
            value={curve.align_y}
            testId="font-align-y"
            options={[
              { value: 'TOP_BASELINE', label: 'Top Base-Line' },
              { value: 'TOP', label: 'Top' },
              { value: 'CENTER', label: 'Middle' },
              { value: 'BOTTOM', label: 'Bottom' },
              { value: 'BOTTOM_BASELINE', label: 'Bottom Base-Line' },
            ]}
            onChange={(v) => set('align_y', v)}
          />
        </Row>
        <div class="hint" style={SUBHEAD}>
          Spacing
        </div>
        <Row label="Character">
          <NumberField
            value={num('space_character')}
            step={0.01}
            state={st('space_character')}
            testId="font-space-character"
            onChange={(v, f) => set('space_character', v, f)}
          />
        </Row>
        <Row label="Word">
          <NumberField
            value={num('space_word')}
            min={0}
            step={0.01}
            state={st('space_word')}
            testId="font-space-word"
            onChange={(v, f) => set('space_word', v, f)}
          />
        </Row>
        <Row label="Line">
          <NumberField
            value={num('space_line')}
            step={0.01}
            state={st('space_line')}
            testId="font-space-line"
            onChange={(v, f) => set('space_line', v, f)}
          />
        </Row>
        <div class="hint" style={SUBHEAD}>
          Offset
        </div>
        <Row label="X">
          <NumberField
            value={num('offset_x')}
            step={0.01}
            unit=" m"
            state={st('offset_x')}
            testId="font-offset-x"
            onChange={(v, f) => set('offset_x', v, f)}
          />
        </Row>
        <Row label="Y">
          <NumberField
            value={num('offset_y')}
            step={0.01}
            unit=" m"
            state={st('offset_y')}
            testId="font-offset-y"
            onChange={(v, f) => set('offset_y', v, f)}
          />
        </Row>
      </Panel>
    </>
  );
}

/** A spline point as curve.spline_set_points takes it (keeps handles, radius, tilt and weight). */
export function splinePointInput(pt: SplinePoint): Record<string, unknown> {
  return {
    co: [...pt.co],
    handle_left: pt.handle_left ? [...pt.handle_left] : null,
    handle_right: pt.handle_right ? [...pt.handle_right] : null,
    handle_left_type: pt.handle_left_type,
    handle_right_type: pt.handle_right_type,
    radius: pt.radius,
    tilt: pt.tilt,
    weight: pt.weight,
  };
}

const SPLINE_LABEL: Record<Spline['type'], string> = { POLY: 'Poly', BEZIER: 'Bezier', NURBS: 'NURBS' };

function ActiveSplinePanel({ s, o, curve }: { s: ProjectSession; o: ObjectData; curve: CurveData }) {
  const splines = (Array.isArray(curve.splines) ? curve.splines : []).map((x) => sanitizeSpline(x));
  if (!splines.length)
    return (
      <Panel title="Active Spline" id="curve-active-spline">
        <div class="hint">The curve has no splines.</div>
      </Panel>
    );
  const index = Math.min(Math.max(0, activeSplines.value[curve.id] ?? 0), splines.length - 1);
  const sp = splines[index];
  /** Changes spline settings through curve.spline_set_points (the points stay as they are). */
  const update = (patch: Record<string, unknown>) =>
    run(
      'curve.spline_set_points',
      { object: o.id, spline_index: index, points: sp.points.map(splinePointInput), ...patch },
      'ui',
    );
  /** Sets the resolution of the active spline in the current spline list. */
  const writeResolution = (v: number) => {
    const cur = s.doc.getCurve(curve.id);
    if (!cur || !Array.isArray(cur.splines) || !cur.splines[index]) return;
    s.doc.updateCurve(curve.id, {
      splines: cur.splines.map((x, i) => (i === index ? { ...x, resolution_u: v } : x)),
    });
  };
  const setResolution = (v: number, final: boolean) =>
    dragEdit(
      s,
      `spline:${curve.id}:${index}:resolution`,
      final,
      () => writeResolution(v),
      () => {
        const before = s.doc.getCurve(curve.id)?.splines?.[index]?.resolution_u;
        return () => {
          if (typeof before === 'number') writeResolution(before);
        };
      },
      () => update({ resolution_u: v }),
    );
  const slots = o.material_slots;
  return (
    <Panel title="Active Spline" id="curve-active-spline">
      {splines.length > 1 && (
        <Row label="Spline">
          <SelectField
            value={String(index)}
            testId="spline-select"
            options={splines.map((x, i) => ({
              value: String(i),
              label: `${i + 1}: ${SPLINE_LABEL[x.type]}, ${x.points.length} points${x.use_cyclic_u ? ', cyclic' : ''}`,
            }))}
            onChange={(v) => (activeSplines.value = { ...activeSplines.value, [curve.id]: Number(v) })}
          />
        </Row>
      )}
      <Row label="Type">
        <EnumButtons
          value={sp.type}
          testId="spline-type"
          options={[
            { value: 'POLY', label: 'Poly' },
            { value: 'BEZIER', label: 'Bezier' },
            { value: 'NURBS', label: 'NURBS' },
          ]}
          onChange={(type) => update({ type })}
        />
      </Row>
      <Row label="">
        <Checkbox
          value={sp.use_cyclic_u}
          label="Cyclic"
          testId="spline-cyclic"
          onChange={(cyclic) =>
            run('curve.cyclic_toggle', { object: o.id, spline_index: index, cyclic }, 'ui')
          }
        />
      </Row>
      <Row label="Resolution" title="Samples per segment (0 = the curve's resolution)">
        <NumberField
          value={sp.resolution_u}
          integer
          min={0}
          max={1024}
          testId="spline-resolution"
          onChange={setResolution}
        />
      </Row>
      {sp.type === 'NURBS' && (
        <>
          <Row label="Order" title="NURBS order (degree + 1)">
            <NumberField
              value={sp.order_u}
              integer
              min={2}
              max={6}
              testId="spline-order"
              onChange={(v, f) => f && update({ order_u: v })}
            />
          </Row>
          <Row label="">
            <Checkbox
              value={sp.use_endpoint_u}
              label="Endpoint"
              testId="spline-endpoint"
              onChange={(v) => update({ use_endpoint_u: v })}
            />
          </Row>
        </>
      )}
      <Row label="">
        <Checkbox
          value={sp.use_smooth}
          label="Smooth"
          testId="spline-smooth"
          onChange={(v) => update({ use_smooth: v })}
        />
      </Row>
      <Row label="Material" title="Material slot used by this spline's surface">
        {slots.length ? (
          <SelectField
            value={String(sp.material_index)}
            testId="spline-material"
            options={withCurrent(
              slots.map((id, i) => ({
                value: String(i),
                label: `${i}: ${id ? (s.doc.getMaterial(id)?.name ?? '(missing)') : '(empty)'}`,
              })),
              String(sp.material_index),
            )}
            onChange={(v) => update({ material_index: Number(v) })}
          />
        ) : (
          <span class="hint">No material slots</span>
        )}
      </Row>
      <div style={BUTTON_ROW}>
        <button
          class="btn"
          data-testid="spline-switch-direction"
          title="Reverse the direction of the spline"
          onClick={() => run('curve.switch_direction', { object: o.id, spline_index: index }, 'ui')}
        >
          Switch Direction
        </button>
        <button
          class="btn"
          data-testid="spline-remove"
          disabled={splines.length < 2}
          title={splines.length < 2 ? 'The only spline of the curve' : 'Delete this spline'}
          onClick={() => {
            if (run('curve.spline_remove', { object: o.id, spline_index: index }, 'ui'))
              activeSplines.value = { ...activeSplines.value, [curve.id]: Math.max(0, index - 1) };
          }}
        >
          Remove Spline
        </button>
      </div>
      <div class="hint">{sp.points.length} control points</div>
    </Panel>
  );
}

// ------------------------------------------------------------------ armature

/** Bones in hierarchy order (parents before children) with their depth. */
export function boneTree(bones: readonly BoneData[]): { bone: BoneData; depth: number }[] {
  const names = new Set(bones.map((b) => b.name));
  const children = new Map<string | null, BoneData[]>();
  for (const b of bones) {
    const parent = b.parent && b.parent !== b.name && names.has(b.parent) ? b.parent : null;
    const list = children.get(parent) ?? [];
    list.push(b);
    children.set(parent, list);
  }
  const out: { bone: BoneData; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const b of children.get(parent) ?? []) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      out.push({ bone: b, depth });
      walk(b.name, depth + 1);
    }
  };
  walk(null, 0);
  // bones caught in a parent cycle (damaged data) are listed at the end
  for (const b of bones)
    if (!seen.has(b.name)) {
      seen.add(b.name);
      out.push({ bone: b, depth: 0 });
    }
  return out;
}

/** Names of a bone's descendants. */
function descendants(bones: readonly BoneData[], name: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bones)
      if (b.parent && (b.parent === name || out.has(b.parent)) && !out.has(b.name) && b.name !== name) {
        out.add(b.name);
        grew = true;
      }
  }
  return out;
}

const boneLength = (b: BoneData) =>
  Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);

function ArmaturePanels({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const arm = s.doc.getArmature(o.data!);
  if (!arm) return <div class="empty-note">The armature data is missing.</div>;
  const ev = panelEvaluation(s);
  const bones = Array.isArray(arm.bones) ? arm.bones : [];
  const tree = boneTree(bones);
  const chosen = activeEntryIndex(
    bones.map((b) => b.name),
    activeBones.value[o.id],
  );
  const active = (chosen >= 0 ? bones[chosen] : null) ?? tree[0]?.bone ?? null;
  const select = (name: string) =>
    (activeBones.value = {
      ...activeBones.value,
      [o.id]: entryOf(
        (s.doc.getArmature(o.data!)?.bones ?? []).map((b) => b.name),
        name,
      ),
    });
  const setArmature = (patch: Record<string, unknown>) =>
    run('armature.properties_set', { object: o.id, ...patch }, 'ui');
  const add = () => {
    const params: Record<string, unknown> = { object: o.id, name: 'Bone' };
    if (active) {
      params.parent = active.name;
      params.length = Math.max(0.01, boneLength(active));
    }
    const r = runResult('armature.bone_add', params, 'ui');
    const name = (r?.result as { bone?: string } | undefined)?.bone;
    if (r?.ok && name) select(name);
  };
  return (
    <>
      <ContextLine icon="armature" name={arm.name} users={s.doc.dataUsers(arm.id)} />
      <div style={{ padding: '0 8px' }}>
        <ErrorList messages={sourceErrors(ev, `pose:${o.id}`)} testId="pose-errors" />
      </div>
      <Panel title="Skeleton" id="armature-skeleton">
        <Row
          label="Pose Position"
          title="Rest Position shows the rest pose without pose transforms or constraints"
        >
          <EnumButtons
            value={arm.pose_position}
            testId="armature-pose-position"
            options={[
              { value: 'POSE', label: 'Pose Position' },
              { value: 'REST', label: 'Rest Position' },
            ]}
            onChange={(v) => setArmature({ pose_position: v })}
          />
        </Row>
      </Panel>
      <Panel title="Viewport Display" id="armature-display">
        <Row label="Display As">
          <SelectField
            value={arm.display_type}
            testId="armature-display-type"
            options={[
              { value: 'OCTAHEDRAL', label: 'Octahedral' },
              { value: 'STICK', label: 'Stick' },
              { value: 'BBONE', label: 'B-Bone' },
              { value: 'ENVELOPE', label: 'Envelope' },
              { value: 'WIRE', label: 'Wire' },
            ]}
            onChange={(v) => setArmature({ display_type: v })}
          />
        </Row>
        <Row label="Show">
          <div style={{ display: 'flex', gap: '10px' }}>
            <Checkbox
              value={arm.show_names}
              label="Names"
              testId="armature-show-names"
              onChange={(v) => setArmature({ show_names: v })}
            />
            <Checkbox
              value={arm.show_axes}
              label="Axes"
              testId="armature-show-axes"
              onChange={(v) => setArmature({ show_axes: v })}
            />
          </div>
        </Row>
      </Panel>
      <Panel title="Bones" id="armature-bones">
        <UIList
          label="Bones"
          testId="bones"
          empty="No bones"
          active={active ? tree.findIndex((t) => t.bone.name === active.name) : -1}
          onSelect={(i) => select(tree[i].bone.name)}
          rows={tree.map(({ bone, depth }) => ({
            key: bone.name,
            testId: `bone-${bone.name}`,
            title: bone.parent ? `${bone.name} (child of ${bone.parent})` : bone.name,
            content: (
              <>
                <span style={{ width: `${depth * 12}px`, flex: 'none' }} />
                <Icon name="bone" size={13} />
                <span class="name" style={{ opacity: bone.use_deform ? 1 : 0.6 }}>
                  {bone.name}
                </span>
              </>
            ),
          }))}
          buttons={
            <>
              <IconButton
                icon="plus"
                title={active ? `Add a bone as a child of ${active.name}` : 'Add a bone'}
                testId="bone-add"
                onClick={add}
              />
              <IconButton
                icon="minus"
                title="Delete the bone (its children move to its parent)"
                testId="bone-remove"
                disabled={!active}
                onClick={() =>
                  active && run('armature.bone_remove', { object: o.id, bones: [active.name] }, 'ui')
                }
              />
            </>
          }
        />
        {active && (
          <BoneFields
            key={active.name}
            s={s}
            o={o}
            armId={arm.id}
            bone={active}
            bones={bones}
            onRename={select}
          />
        )}
      </Panel>
      {active && <PosePanel key={active.name} s={s} o={o} bone={active} bones={bones} />}
    </>
  );
}

function BoneFields(p: {
  s: ProjectSession;
  o: ObjectData;
  armId: string;
  bone: BoneData;
  bones: BoneData[];
  onRename: (name: string) => void;
}) {
  const { s, o, armId, bone, bones } = p;
  const update = (patch: Record<string, unknown>) =>
    runResult('armature.bone_update', { object: o.id, bone: bone.name, ...patch }, 'ui');
  /** Sets a rest field of this bone in the current bone list (other bones stay as they are now). */
  const writeRest = (field: 'head' | 'tail' | 'roll', v: Vec3 | number) => {
    const cur = s.doc.getArmature(armId);
    if (!cur || !Array.isArray(cur.bones)) return;
    s.doc.updateArmature(armId, {
      bones: cur.bones.map((b) => (b.name === bone.name ? { ...b, [field]: v } : b)),
    });
  };
  const setRest = (field: 'head' | 'tail' | 'roll', v: Vec3 | number, final: boolean) =>
    dragEdit(
      s,
      `bone:${armId}:${bone.name}:${field}`,
      final,
      () => writeRest(field, v),
      () => {
        const before = s.doc.getArmature(armId)?.bones?.find((b) => b.name === bone.name)?.[field];
        return () => {
          if (before !== undefined) writeRest(field, before);
        };
      },
      () => void update({ [field]: v }),
    );
  const excluded = descendants(bones, bone.name);
  const parents = bones.filter((b) => b.name !== bone.name && !excluded.has(b.name)).map((b) => b.name);
  return (
    <div style={{ marginTop: '4px' }}>
      <Row label="Name">
        <TextField
          value={bone.name}
          testId="bone-name"
          ariaLabel="Bone name"
          onChange={(v) => {
            const name = v.trim();
            if (!name || name === bone.name) return;
            const r = update({ name });
            const renamed = (r?.result as { bone?: string } | undefined)?.bone;
            if (r?.ok && renamed) p.onRename(renamed);
          }}
        />
      </Row>
      <Row label="Parent">
        <SelectField
          value={bone.parent ?? ''}
          testId="bone-parent"
          options={boneOptions(parents, bone.parent ?? '', '— none —')}
          onChange={(v) => update({ parent: v })}
        />
      </Row>
      <Row label="">
        <div style={{ display: 'flex', gap: '10px' }}>
          <Checkbox
            value={bone.use_connect}
            label="Connected"
            testId="bone-connect"
            onChange={(v) => {
              if (v && !bone.parent) return;
              update({ use_connect: v });
            }}
          />
          <Checkbox
            value={bone.use_deform}
            label="Deform"
            testId="bone-deform"
            onChange={(v) => update({ use_deform: v })}
          />
        </div>
      </Row>
      <Row label="Head" title="Rest position of the head (armature space)">
        <VectorField
          value={[...bone.head]}
          unit=" m"
          testId="bone-head"
          onChange={(v, f) => setRest('head', v as Vec3, f)}
        />
      </Row>
      <Row label="Tail" title="Rest position of the tail (armature space)">
        <VectorField
          value={[...bone.tail]}
          unit=" m"
          testId="bone-tail"
          onChange={(v, f) => setRest('tail', v as Vec3, f)}
        />
      </Row>
      <Row label="Roll">
        <NumberField
          value={bone.roll}
          unit="°"
          step={1}
          {...RAD}
          testId="bone-roll"
          onChange={(v, f) => setRest('roll', v, f)}
        />
      </Row>
      <div class="hint">Length {boneLength(bone).toFixed(3)} m</div>
    </div>
  );
}

/** Pose channels of a bone. */
type PoseChannel = 'location' | 'rotation_euler' | 'scale';

function PosePanel({
  s,
  o,
  bone,
  bones,
}: {
  s: ProjectSession;
  o: ObjectData;
  bone: BoneData;
  bones: BoneData[];
}) {
  const pb = o.pose?.bones?.[bone.name] ?? defaultPoseBone();
  const path = (c: PoseChannel) => poseBonePath(bone.name, c);
  const values = (c: PoseChannel) =>
    [0, 1, 2].map((i) => animatedValue(s, 'object', o.id, path(c), i, (pb[c] ?? defaultPoseBone()[c])[i]));
  const states = (c: PoseChannel) => [0, 1, 2].map((i) => animState(s, 'object', o.id, path(c), i));
  /** Sets one channel of this bone in the current pose (other bones and channels stay as they are now). */
  const writeChannel = (c: PoseChannel, v: Vec3) => {
    const cur = s.doc.getObject(o.id);
    if (!cur) return;
    const map = { ...(cur.pose?.bones ?? {}) };
    map[bone.name] = { ...(map[bone.name] ?? defaultPoseBone()), [c]: v };
    s.doc.updateObject(o.id, { pose: { ...cur.pose, bones: map } });
  };
  const setChannel = (c: PoseChannel, v: number[], final: boolean) =>
    dragEdit(
      s,
      `pose:${o.id}:${bone.name}:${c}`,
      final,
      () => writeChannel(c, v as Vec3),
      () => {
        // a bone without a pose entry is at rest: its channel goes back to the rest value
        const before = s.doc.getObject(o.id)?.pose?.bones?.[bone.name]?.[c] ?? defaultPoseBone()[c];
        return () => writeChannel(c, before);
      },
      () => run('pose.bone_transform_set', { object: o.id, bone: bone.name, [c]: v }, 'ui'),
    );
  const constraints = (pb.constraints ?? []).filter((c): c is ConstraintData => !!c && typeof c === 'object');
  return (
    <Panel title={`Pose: ${bone.name}`} id="armature-pose">
      <Row label="Location">
        <VectorField
          value={values('location')}
          unit=" m"
          states={states('location')}
          testId="pose-location"
          onChange={(v, f) => setChannel('location', v, f)}
        />
      </Row>
      <Row label="Rotation" title="XYZ Euler rotation about the bone's own axes">
        <VectorField
          value={values('rotation_euler')}
          unit="°"
          step={1}
          {...RAD}
          states={states('rotation_euler')}
          testId="pose-rotation"
          onChange={(v, f) => setChannel('rotation_euler', v, f)}
        />
      </Row>
      <Row label="Scale">
        <VectorField
          value={values('scale')}
          states={states('scale')}
          testId="pose-scale"
          onChange={(v, f) => setChannel('scale', v, f)}
        />
      </Row>
      <div style={BUTTON_ROW}>
        <button
          class="btn"
          data-testid="pose-keyframe"
          title="Insert keyframes for location, rotation and scale at the current frame"
          onClick={() =>
            run(
              'pose.bone_transform_set',
              {
                object: o.id,
                bone: bone.name,
                location: values('location'),
                rotation_euler: values('rotation_euler'),
                scale: values('scale'),
                keyframe: true,
              },
              'ui',
            )
          }
        >
          <Icon name="key" size={12} /> Insert Keyframe
        </button>
        <button
          class="btn"
          data-testid="pose-clear"
          title="Back to the rest pose (location 0, rotation 0, scale 1)"
          onClick={() => run('pose.transforms_clear', { object: o.id, bones: [bone.name] }, 'ui')}
        >
          Clear Transform
        </button>
      </div>
      <div class="hint" style={SUBHEAD}>
        Bone Constraints
      </div>
      {constraints.length === 0 && <div class="hint">No bone constraints</div>}
      {constraints.map((c) => (
        <BoneConstraintBox key={c.id} s={s} o={o} bone={bone.name} c={c} />
      ))}
      <AddIkForm s={s} o={o} bone={bone} bones={bones} />
    </Panel>
  );
}

function BoneConstraintBox({
  s,
  o,
  bone,
  c,
}: {
  s: ProjectSession;
  o: ObjectData;
  bone: string;
  c: ConstraintData;
}) {
  const label = BONE_CONSTRAINT_LABELS[c.type as BoneConstraintType] ?? humanize(c.type);
  const tid = `bone-constraint-${c.name}`;
  const target = c.target ? s.doc.getObject(c.target) : null;
  const update = (patch: Record<string, unknown>) =>
    run('pose.constraint_set', { object: o.id, bone, constraint: c.id, ...patch }, 'ui');
  const influencePath = poseBonePath(bone, `constraints[${JSON.stringify(c.name)}].influence`);
  /** Sets this constraint's influence in the current pose (everything else stays as it is now). */
  const writeInfluence = (v: number) => {
    const cur = s.doc.getObject(o.id);
    const pb = cur?.pose?.bones?.[bone];
    if (!cur || !pb) return;
    const list = (pb.constraints ?? []).map((x) => (x.id === c.id ? { ...x, influence: v } : x));
    s.doc.updateObject(o.id, {
      pose: { ...cur.pose, bones: { ...cur.pose.bones, [bone]: { ...pb, constraints: list } } },
    });
  };
  const setInfluence = (v: number, final: boolean) =>
    dragEdit(
      s,
      `bonecon:${o.id}:${bone}:${c.id}`,
      final,
      () => writeInfluence(v),
      () => {
        const before = s.doc
          .getObject(o.id)
          ?.pose?.bones?.[bone]?.constraints?.find((x) => x.id === c.id)?.influence;
        return () => {
          if (typeof before === 'number') writeInfluence(before);
        };
      },
      () => update({ influence: v }),
    );
  return (
    <div style={{ ...boxStyle, marginBottom: '4px' }} data-testid={tid}>
      <div style={boxHeaderStyle}>
        <Icon name="constraint" size={13} />
        <b style={{ opacity: c.mute ? 0.5 : 1 }}>{c.name}</b>
        {label !== c.name && <span class="hint">{label}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
          <IconButton
            icon={c.mute ? 'eyeOff' : 'eye'}
            title={c.mute ? 'Enable the constraint' : 'Disable the constraint'}
            testId={`${tid}-mute`}
            onClick={() => update({ mute: !c.mute })}
          />
          <IconButton
            icon="close"
            title="Delete the constraint"
            testId={`${tid}-remove`}
            onClick={() => run('pose.constraint_remove', { object: o.id, bone, constraint: c.id }, 'ui')}
          />
        </span>
      </div>
      <div class="hint">
        Target: {target ? target.name : c.target ? `${c.target} (missing)` : 'none'}
        {c.subtarget ? ` › ${c.subtarget}` : ''}
      </div>
      <Row label="Influence">
        <NumberField
          value={animatedValue(s, 'object', o.id, influencePath, 0, c.influence)}
          min={0}
          max={1}
          slider
          state={animState(s, 'object', o.id, influencePath, 0)}
          testId={`${tid}-influence`}
          onChange={setInfluence}
        />
      </Row>
      {c.type === 'IK' && (
        <Row label="Chain Length" title="Bones driven by the IK, counted from this bone up (0 = to the root)">
          <NumberField
            value={Number(c.params?.chain_count ?? 0)}
            integer
            min={0}
            max={255}
            testId={`${tid}-chain`}
            onChange={(v, f) => f && update({ params: { chain_count: v } })}
          />
        </Row>
      )}
    </div>
  );
}

function AddIkForm({
  s,
  o,
  bone,
  bones,
}: {
  s: ProjectSession;
  o: ObjectData;
  bone: BoneData;
  bones: BoneData[];
}) {
  const [target, setTarget] = useState('');
  const [sub, setSub] = useState('');
  const [chain, setChain] = useState(2);
  const targetObj = target ? s.doc.getObject(target) : o;
  const targetBones =
    targetObj?.type === 'ARMATURE' && targetObj.data
      ? (target ? (s.doc.getArmature(targetObj.data)?.bones ?? []) : bones)
          .map((b) => b.name)
          .filter((n) => target || n !== bone.name)
      : [];
  const valid = target ? !!targetObj : !!sub;
  return (
    <div style={{ ...boxStyle, marginTop: '4px' }} data-testid="pose-ik-form">
      <div style={boxHeaderStyle}>
        <Icon name="plus" size={12} /> <b>Inverse Kinematics</b>
      </div>
      <Row label="Target" title="Object the chain reaches for (or a bone of this armature)">
        <SelectField
          value={target}
          testId="pose-ik-target"
          options={[
            { value: '', label: 'This armature (bone)' },
            ...s.doc
              .listObjects()
              .filter((x) => x.id !== o.id)
              .map((x) => ({ value: x.id, label: x.name })),
          ]}
          onChange={(v) => {
            setTarget(v);
            setSub('');
          }}
        />
      </Row>
      {targetBones.length > 0 && (
        <Row label="Bone">
          <SelectField
            value={sub}
            testId="pose-ik-bone"
            options={boneOptions(targetBones, sub, target ? '— object —' : '— choose a bone —')}
            onChange={setSub}
          />
        </Row>
      )}
      <Row label="Chain Length" title="Bones driven by the IK, counted from this bone up (0 = to the root)">
        <NumberField value={chain} integer min={0} max={255} testId="pose-ik-chain" onChange={setChain} />
      </Row>
      <Row label="">
        <button
          class="btn"
          data-testid="pose-ik-add"
          disabled={!valid}
          title={valid ? `Add an IK constraint to ${bone.name}` : 'Choose the target bone'}
          onClick={() =>
            run(
              'pose.ik_add',
              {
                object: o.id,
                bone: bone.name,
                ...(target ? { target } : {}),
                subtarget: sub,
                chain_count: chain,
              },
              'ui',
            )
          }
        >
          Add IK
        </button>
      </Row>
    </div>
  );
}

// ------------------------------------------------------------------ light

function LightPanel({ s, id }: { s: ProjectSession; id: string }) {
  const l = s.doc.getLight(id);
  if (!l) return null;
  /** The values at the current frame (keyframes and drivers applied), which the renderers use. */
  const a = animatedBlock<LightData>(s, 'light', id) ?? l;
  const set = (f: string, v: unknown, final = true) => setProp(s, 'lights', id, f, v, final);
  const st = (path: string, i = 0) => animState(s, 'light', id, path, i);
  return (
    <>
      <div class="prop-context">
        <Icon name="light" size={14} /> {l.name}
      </div>
      <Panel title="Light">
        <Row label="Type">
          <SelectField
            value={l.type}
            testId="light-type"
            options={[
              { value: 'POINT', label: 'Point' },
              { value: 'SUN', label: 'Sun' },
              { value: 'SPOT', label: 'Spot' },
              { value: 'AREA', label: 'Area' },
            ]}
            onChange={(v) => set('type', v)}
          />
        </Row>
        <Row label="Color">
          <ColorField value={a.color} testId="light-color" onChange={(v, f) => set('color', v, f)} />
        </Row>
        <Row label={l.type === 'SUN' ? 'Strength' : 'Power'}>
          <NumberField
            value={a.energy}
            min={0}
            step={l.type === 'SUN' ? 0.01 : 1}
            unit={l.type === 'SUN' ? '' : ' W'}
            state={st('energy')}
            testId="light-energy"
            onChange={(v, f) => set('energy', v, f)}
          />
        </Row>
        {l.type !== 'SUN' && l.type !== 'AREA' && (
          <Row label="Radius">
            <NumberField
              value={a.shadow_soft_size}
              min={0}
              step={0.01}
              unit=" m"
              state={st('shadow_soft_size')}
              testId="light-radius"
              onChange={(v, f) => set('shadow_soft_size', v, f)}
            />
          </Row>
        )}
        <Row label="">
          <Checkbox value={l.use_shadow} label="Cast Shadows" onChange={(v) => set('use_shadow', v)} />
        </Row>
      </Panel>
      {l.type === 'SPOT' && (
        <Panel title="Spot Shape">
          <Row label="Size">
            <NumberField
              value={a.spot_size}
              min={0.01}
              max={Math.PI}
              unit="°"
              step={1}
              {...RAD}
              state={st('spot_size')}
              onChange={(v, f) => set('spot_size', v, f)}
            />
          </Row>
          <Row label="Blend">
            <NumberField
              value={a.spot_blend}
              min={0}
              max={1}
              slider
              state={st('spot_blend')}
              onChange={(v, f) => set('spot_blend', v, f)}
            />
          </Row>
        </Panel>
      )}
      {l.type === 'AREA' && (
        <Panel title="Area Shape">
          <Row label="Shape">
            <SelectField
              value={l.shape}
              options={[
                { value: 'SQUARE', label: 'Square' },
                { value: 'RECTANGLE', label: 'Rectangle' },
                { value: 'DISK', label: 'Disk' },
                { value: 'ELLIPSE', label: 'Ellipse' },
              ]}
              onChange={(v) => set('shape', v)}
            />
          </Row>
          <Row label="Size">
            <NumberField
              value={a.size}
              min={0.001}
              step={0.01}
              unit=" m"
              state={st('size')}
              onChange={(v, f) => set('size', v, f)}
            />
          </Row>
          {(l.shape === 'RECTANGLE' || l.shape === 'ELLIPSE') && (
            <Row label="Size Y">
              <NumberField
                value={a.size_y}
                min={0.001}
                step={0.01}
                unit=" m"
                state={st('size_y')}
                onChange={(v, f) => set('size_y', v, f)}
              />
            </Row>
          )}
        </Panel>
      )}
    </>
  );
}

// ------------------------------------------------------------------ camera

function CameraPanel({ s, id }: { s: ProjectSession; id: string }) {
  const c = s.doc.getCamera(id);
  if (!c) return null;
  /** The values at the current frame (keyframes and drivers applied), which the renderers use. */
  const a = animatedBlock<CameraData>(s, 'camera', id) ?? c;
  const r = s.doc.getRender();
  const aspect = r.resolution_x / Math.max(1, r.resolution_y);
  const set = (f: string, v: unknown, final = true) => setProp(s, 'cameras', id, f, v, final);
  const st = (path: string) => animState(s, 'camera', id, path, 0);
  return (
    <>
      <div class="prop-context">
        <Icon name="camera" size={14} /> {c.name}
      </div>
      <Panel title="Lens">
        <Row label="Type">
          <SelectField
            value={c.type}
            options={[
              { value: 'PERSP', label: 'Perspective' },
              { value: 'ORTHO', label: 'Orthographic' },
            ]}
            onChange={(v) => set('type', v)}
          />
        </Row>
        {c.type === 'PERSP' ? (
          <>
            <Row label="Focal Length">
              <NumberField
                value={a.lens}
                min={1}
                max={5000}
                step={0.5}
                unit=" mm"
                state={st('lens')}
                testId="camera-lens"
                onChange={(v, f) => set('lens', v, f)}
              />
            </Row>
            <Row label="Field of View">
              <NumberField
                value={cameraFovY(a, aspect)}
                unit="°"
                step={0.5}
                {...RAD}
                min={0.01}
                max={3.1}
                state={st('lens')}
                testId="camera-fov"
                onChange={(v, f) => set('lens', lensFromFovY(v, aspect, c.sensor_width), f)}
              />
            </Row>
          </>
        ) : (
          <Row label="Ortho Scale">
            <NumberField
              value={a.ortho_scale}
              min={0.001}
              step={0.05}
              state={st('ortho_scale')}
              onChange={(v, f) => set('ortho_scale', v, f)}
            />
          </Row>
        )}
        <Row label="Shift X">
          <NumberField
            value={a.shift_x}
            step={0.01}
            state={st('shift_x')}
            testId="camera-shift-x"
            onChange={(v, f) => set('shift_x', v, f)}
          />
        </Row>
        <Row label="Y">
          <NumberField
            value={a.shift_y}
            step={0.01}
            state={st('shift_y')}
            testId="camera-shift-y"
            onChange={(v, f) => set('shift_y', v, f)}
          />
        </Row>
        <Row label="Clip Start">
          <NumberField
            value={a.clip_start}
            min={0.0001}
            step={0.01}
            unit=" m"
            state={st('clip_start')}
            onChange={(v, f) => set('clip_start', v, f)}
          />
        </Row>
        <Row label="End">
          <NumberField
            value={a.clip_end}
            min={0.01}
            step={1}
            unit=" m"
            state={st('clip_end')}
            onChange={(v, f) => set('clip_end', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Camera" defaultOpen={false}>
        <Row label="Sensor Fit">
          <SelectField
            value={c.sensor_fit}
            options={[
              { value: 'AUTO', label: 'Auto' },
              { value: 'HORIZONTAL', label: 'Horizontal' },
              { value: 'VERTICAL', label: 'Vertical' },
            ]}
            onChange={(v) => set('sensor_fit', v)}
          />
        </Row>
        <Row label="Size">
          <NumberField
            value={c.sensor_width}
            min={1}
            step={0.1}
            unit=" mm"
            onChange={(v, f) => set('sensor_width', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Depth of Field" id="camera-dof" defaultOpen={c.dof_use}>
        <Row label="">
          <Checkbox
            value={c.dof_use}
            label="Depth of Field"
            testId="camera-dof"
            onChange={(v) => set('dof_use', v)}
          />
        </Row>
        <Row label="Focus Distance" title="Distance from the camera that is in sharp focus">
          <NumberField
            value={a.dof_focus_distance}
            min={0}
            step={0.1}
            unit=" m"
            state={st('dof_focus_distance')}
            testId="camera-dof-distance"
            onChange={(v, f) => set('dof_focus_distance', v, f)}
          />
        </Row>
        <Row label="F-Stop" title="Aperture f-number: lower values give a shallower focus and more blur">
          <NumberField
            value={a.dof_aperture_fstop}
            min={0.1}
            max={128}
            step={0.1}
            precision={1}
            state={st('dof_aperture_fstop')}
            testId="camera-dof-fstop"
            onChange={(v, f) => set('dof_aperture_fstop', v, f)}
          />
        </Row>
        <div class="hint">Rendered by the Path Tracer engine (the rasterized viewport stays sharp).</div>
      </Panel>
    </>
  );
}
