import { signal } from '@preact/signals';
import {
  ParticleSettingsSchema,
  ROOT_COLLECTION_ID,
  collectionMembers,
  normalizeParticleSettings,
  safeJsonSchema,
  type InstanceWeight,
  type ObjectData,
  type ParticleSystemData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { NumberField, Panel, Row, TextField } from '../fields/fields';
import { SchemaForm, type SchemaChoice } from '../SchemaForm';
import { Icon } from '../icons';
import { run, runResult } from '../../editor/editor';
import { ErrorList, captureField, dragEdit, isRecord, panelEvaluation, withField } from './ObjectTab';
import { validItems } from './ConstraintsTab';

/*
 * Particles tab (Blender's Properties > Particles): the particle systems of the active mesh, curve
 * or text object. Systems are static scatters whose particles instance an object or a collection;
 * every edit runs object.particle_system_* (one undo step).
 */

const EMITTER_TYPES = new Set(['MESH', 'CURVE', 'FONT']);

/** Whether an object can emit particles (mesh, curve and text objects with data). */
export function canHaveParticles(o: ObjectData): boolean {
  return EMITTER_TYPES.has(o.type) && !!o.data;
}

let settingsJson: unknown = null;
const settingsSchema = () => (settingsJson ??= safeJsonSchema(ParticleSettingsSchema));

/** Blender's labels of the particle settings. */
const LABELS: Record<string, string> = {
  count: 'Number',
  seed: 'Seed',
  emit_from: 'Emit From',
  distribution: 'Distribution',
  use_even_distribution: 'Even Distribution',
  grid_resolution: 'Resolution',
  grid_random: 'Grid Randomness',
  min_distance: 'Minimum Distance',
  use_modifier_stack: 'Use Modifier Stack',
  vertex_group_density: 'Density',
  invert_vertex_group_density: 'Invert Density',
  instance_type: 'Render As',
  instance_object: 'Instance Object',
  instance_collection: 'Instance Collection',
  use_whole_collection: 'Whole Collection',
  use_collection_pick_random: 'Pick Random',
  particle_size: 'Scale',
  size_random: 'Scale Randomness',
  use_rotation_instance: 'Object Rotation',
  use_scale_instance: 'Object Scale',
  rotation_mode: 'Orientation Axis',
  rotation_factor_random: 'Randomize',
  phase_factor: 'Phase',
  phase_factor_random: 'Randomize Phase',
  display_percentage: 'Amount %',
};

const ENUM_LABELS: Record<string, string> = {
  VERT: 'Verts',
  FACE: 'Faces',
  VOLUME: 'Volume',
  RANDOM: 'Random',
  JITTERED: 'Jittered',
  GRID: 'Grid',
  NONE: 'None',
  OBJECT: 'Object',
  COLLECTION: 'Collection',
  NORMAL: 'Normal',
  NORMAL_TANGENT: 'Normal-Tangent',
  GLOBAL_Z: 'Global Z',
};

/** The particle system selected in the list, per emitter object (local UI state). */
const activeSystems = signal<Record<string, string>>({});

/** The stored particle system of an object (null when it is gone). */
function storedSystem(s: ProjectSession, objectId: string, systemId: string): ParticleSystemData | null {
  const list = s.doc.getObject(objectId)?.particle_systems;
  return (Array.isArray(list) ? list : []).find((x) => isRecord(x) && x.id === systemId) ?? null;
}

/**
 * Sets one setting of a particle system in the current document state (live drag previews and
 * their restore; undefined removes it): the other systems, including ones added meanwhile by
 * peers, are kept as stored.
 */
function writeSetting(
  s: ProjectSession,
  objectId: string,
  systemId: string,
  key: string,
  value: unknown,
): void {
  const list = s.doc.getObject(objectId)?.particle_systems;
  if (!Array.isArray(list) || !storedSystem(s, objectId, systemId)) return;
  s.doc.updateObject(objectId, {
    particle_systems: list.map((x) =>
      isRecord(x) && x.id === systemId ? { ...x, settings: withField(x.settings, key, value) } : x,
    ),
  });
}

/** Objects a particle system can instance: geometry objects and collection instances. */
function instanceObjectChoices(s: ProjectSession, emitter: ObjectData): SchemaChoice[] {
  return [
    { value: '', label: '— none —' },
    ...s.doc
      .listObjects()
      .filter(
        (x) =>
          x.id !== emitter.id &&
          ((EMITTER_TYPES.has(x.type) && !!x.data) ||
            (x.type === 'EMPTY' && x.instance_type === 'COLLECTION')),
      )
      .map((x) => ({ value: x.id, label: x.name })),
  ];
}

export function ParticlesTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const ev = panelEvaluation(s);
  const systems = validItems(o.particle_systems);
  const chosen = activeSystems.value[o.id];
  const active = systems.find((p) => p.id === chosen) ?? systems[0] ?? null;
  const select = (id: string) => (activeSystems.value = { ...activeSystems.value, [o.id]: id });
  const errors = ev ? ev.errors.filter((e) => e.source === `instances:${o.id}`).map((e) => e.message) : [];
  const systemPrefix = /^Particle system '.*?': /;
  const add = () => {
    const res = runResult('object.particle_system_add', { object: o.id }, 'ui');
    const id = (res?.result as { particle_system?: string } | undefined)?.particle_system;
    if (res?.ok && id) select(id);
  };
  const toggle = (ps: ParticleSystemData, key: 'show_viewport' | 'show_render') =>
    run('object.particle_system_update', { object: o.id, particle_system: ps.id, [key]: !ps[key] }, 'ui');
  return (
    <>
      <div class="prop-context">
        <Icon name="particles" size={14} /> {o.name}
      </div>
      <div style={{ display: 'flex', gap: '4px', padding: '4px 8px' }}>
        <div
          role="listbox"
          aria-label="Particle systems"
          data-testid="particle-systems"
          style={{
            flex: 1,
            minHeight: '68px',
            maxHeight: '140px',
            overflowY: 'auto',
            background: 'var(--bg-input-dark)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
          }}
        >
          {systems.map((ps) => (
            <div
              key={ps.id}
              role="option"
              aria-selected={ps.id === active?.id}
              class={`outliner-row ${ps.id === active?.id ? 'active' : ''}`}
              style={{ paddingLeft: '6px' }}
              data-testid={`psys-${ps.name}`}
              onClick={() => select(ps.id)}
            >
              <Icon name="particles" size={13} />
              <span class="name">{ps.name}</span>
              <span
                class="vis"
                title={ps.show_viewport ? 'Hide in viewport' : 'Show in viewport'}
                data-testid={`psys-${ps.name}-viewport`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(ps, 'show_viewport');
                }}
              >
                <Icon name={ps.show_viewport ? 'eye' : 'eyeOff'} size={13} />
              </span>
              <span
                class="vis"
                title={ps.show_render ? 'Disable in renders' : 'Enable in renders'}
                data-testid={`psys-${ps.name}-render`}
                style={{ opacity: ps.show_render ? 0.8 : 0.3 }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(ps, 'show_render');
                }}
              >
                <Icon name="render" size={13} />
              </span>
            </div>
          ))}
          {systems.length === 0 && (
            <div class="hint" style={{ padding: '6px 8px' }}>
              No particle systems
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <button
            class="btn icon"
            title="Add a particle system"
            aria-label="Add particle system"
            data-testid="psys-add"
            onClick={add}
          >
            <Icon name="plus" size={12} />
          </button>
          <button
            class="btn icon"
            title="Remove the selected particle system"
            aria-label="Remove particle system"
            data-testid="psys-remove"
            disabled={!active}
            onClick={() =>
              active &&
              run('object.particle_system_remove', { object: o.id, particle_system: active.id }, 'ui')
            }
          >
            <Icon name="minus" size={12} />
          </button>
        </div>
      </div>
      <div style={{ padding: '0 8px' }}>
        <ErrorList messages={errors.filter((m) => !systemPrefix.test(m))} testId="particles-emitter-errors" />
      </div>
      {active && (
        <SystemSettings
          key={active.id}
          s={s}
          o={o}
          ps={active}
          instances={ev ? ev.instances.filter((i) => i.id.startsWith(`${o.id}:${active.id}:`)).length : null}
          errors={errors
            .filter((m) => m.startsWith(`Particle system '${active.name}': `))
            .map((m) => m.replace(systemPrefix, ''))}
        />
      )}
    </>
  );
}

function SystemSettings(p: {
  s: ProjectSession;
  o: ObjectData;
  ps: ParticleSystemData;
  instances: number | null;
  errors: string[];
}) {
  const { s, o, ps } = p;
  const settings = normalizeParticleSettings(ps.settings).settings;
  const values = settings as unknown as Record<string, unknown>;
  const tid = `psys-${ps.name}`;
  // a field commits as it goes away, also after an agent removed the system: nothing to change then
  const update = (patch: Record<string, unknown>) =>
    storedSystem(s, o.id, ps.id) &&
    run('object.particle_system_update', { object: o.id, particle_system: ps.id, ...patch }, 'ui');
  const setSetting = (k: string, v: unknown, final: boolean) =>
    dragEdit(
      s,
      `psys:${ps.id}:${k}`,
      final,
      () => writeSetting(s, o.id, ps.id, k, v),
      captureField(
        () => storedSystem(s, o.id, ps.id)?.settings?.[k as keyof ParticleSystemData['settings']],
        (before) => writeSetting(s, o.id, ps.id, k, before),
      ),
      () => update({ settings: { [k]: v } }),
    );
  const vertexGroups = o.type === 'MESH' && o.data ? s.doc.getVertexGroups(o.data).map((g) => g.name) : [];
  const collections = s.doc.listCollections().filter((c) => c.id !== ROOT_COLLECTION_ID);
  const choices: Record<string, SchemaChoice[]> = {
    instance_object: instanceObjectChoices(s, o),
    instance_collection: [
      { value: '', label: '— none —' },
      ...collections.map((c) => ({ value: c.id, label: c.name })),
    ],
    vertex_group_density: [
      { value: '', label: '— none —' },
      ...vertexGroups.map((g) => ({ value: g, label: g })),
    ],
  };
  const form = (keys: string[]) => (
    <SchemaForm
      schema={settingsSchema()}
      only={keys}
      values={values}
      doc={s.doc}
      labels={LABELS}
      choices={choices}
      units={{ min_distance: ' m' }}
      expandEnums={['emit_from', 'distribution', 'instance_type']}
      enumLabel={(_k, v) => ENUM_LABELS[v]}
      testIdPrefix={tid}
      onChange={setSetting}
    />
  );
  const grid = settings.distribution === 'GRID';
  const viewportShare = settings.display_percentage < 100 ? ` (${settings.display_percentage}% shown)` : '';
  return (
    <>
      <div style={{ padding: '2px 8px 4px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <Row label="Name">
          <TextField
            value={ps.name}
            testId={`${tid}-name`}
            onChange={(v) => v.trim() && update({ name: v.trim() })}
          />
        </Row>
        <Row label="">
          <span class="hint" data-testid={`${tid}-stats`}>
            {!ps.show_viewport
              ? 'Hidden in the viewport'
              : p.instances === null
                ? ''
                : `${p.instances.toLocaleString()} instance${p.instances === 1 ? '' : 's'} in the viewport${viewportShare}`}
          </span>
        </Row>
        <ErrorList messages={p.errors} testId={`${tid}-errors`} />
      </div>
      <Panel title="Emission" id="psys-emission">
        {form(grid ? ['seed'] : ['count', 'seed'])}
        {grid && <div class="hint">Grid distribution places one particle per cell (Number is ignored).</div>}
      </Panel>
      <Panel title="Source" id="psys-source">
        {form([
          'emit_from',
          'distribution',
          ...(settings.emit_from === 'FACE' && !grid ? ['use_even_distribution'] : []),
          ...(grid ? ['grid_resolution', 'grid_random'] : []),
          'min_distance',
          'use_modifier_stack',
        ])}
      </Panel>
      <Panel title="Render" id="psys-render">
        {form([
          'instance_type',
          ...(settings.instance_type === 'OBJECT' ? ['instance_object'] : []),
          ...(settings.instance_type === 'COLLECTION'
            ? ['instance_collection', 'use_whole_collection', 'use_collection_pick_random']
            : []),
        ])}
        {settings.instance_type === 'COLLECTION' &&
          settings.instance_collection &&
          !settings.use_whole_collection && (
            <CollectionWeights
              s={s}
              collection={settings.instance_collection}
              weights={settings.instance_weights}
              testId={`${tid}-weights`}
              onChange={(w) => update({ settings: { instance_weights: w } })}
            />
          )}
        {settings.instance_type !== 'NONE' &&
          form(['particle_size', 'size_random', 'use_rotation_instance', 'use_scale_instance'])}
      </Panel>
      <Panel title="Rotation" id="psys-rotation" defaultOpen={false}>
        {form(['rotation_mode', 'rotation_factor_random', 'phase_factor', 'phase_factor_random'])}
      </Panel>
      {o.type === 'MESH' && (
        <Panel title="Vertex Groups" id="psys-vgroups" defaultOpen={false}>
          {form(['vertex_group_density', 'invert_vertex_group_density'])}
          {!vertexGroups.length && <div class="hint">The emitter has no vertex groups.</div>}
        </Panel>
      )}
      <Panel title="Viewport Display" id="psys-display" defaultOpen={false}>
        {form(['display_percentage'])}
      </Panel>
      <div style={{ padding: '6px 8px' }}>
        <button
          class="btn"
          data-testid={`${tid}-make-real`}
          title="Turn the instances of this object's visible particle systems into real objects"
          onClick={() => run('object.duplicates_make_real', { objects: [o.id] }, 'ui')}
        >
          Make Instances Real
        </button>
      </div>
    </>
  );
}

/** Relative pick weights of the objects of the instanced collection (Blender's instance weights). */
function CollectionWeights(p: {
  s: ProjectSession;
  collection: string;
  weights: InstanceWeight[];
  testId: string;
  onChange: (w: InstanceWeight[]) => void;
}) {
  const members = collectionMembers(p.s.doc, p.collection).filter(
    (x) => (EMITTER_TYPES.has(x.type) && !!x.data) || x.type === 'EMPTY',
  );
  if (!members.length) return null;
  const weightOf = (id: string) => p.weights.find((w) => w.object === id)?.weight ?? 1;
  return (
    <>
      {members.map((m, i) => (
        <Row
          key={m.id}
          label={i === 0 ? 'Weights' : ''}
          title="Relative frequency of each object (0 = never)"
        >
          <NumberField
            label={m.name}
            value={weightOf(m.id)}
            min={0}
            step={0.01}
            testId={`${p.testId}-${m.name}`}
            onChange={(v, final) => {
              if (!final) return;
              const rest = p.weights.filter((w) => w.object !== m.id);
              p.onChange([...rest, { object: m.id, weight: v }]);
            }}
          />
        </Row>
      ))}
    </>
  );
}
