import {
  safeJsonSchema,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  type ObjectData,
  type RigidBodyData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { EnumButtons, Panel, Row } from '../fields/fields';
import { SchemaForm } from '../SchemaForm';
import { Icon } from '../icons';
import { registry, run } from '../../editor/editor';
import {
  ErrorList,
  captureField,
  dragEdit,
  isRecord,
  panelEvaluation,
  sourceErrors,
  withField,
} from './ObjectTab';

/*
 * Physics tab (Blender's Properties > Physics, rigid bodies only): add/remove the active object's
 * rigid body, edit its settings, bake the simulation to keyframes, and the scene's rigid body world.
 * Every change runs a rigidbody.* operator (one undo step); slider drags are previewed live.
 */

const operatorSchemas = new Map<string, unknown>();
/** JSON schema of an operator's parameters (cached): ranges and descriptions for the fields. */
function operatorSchema(id: string): unknown {
  let schema = operatorSchemas.get(id);
  if (!schema) {
    const def = registry.get(id);
    schema = def ? safeJsonSchema(def.schema) : { properties: {} };
    operatorSchemas.set(id, schema);
  }
  return schema;
}

/** Blender's labels of the rigid body settings. */
const LABELS: Record<string, string> = {
  mass: 'Mass',
  enabled: 'Dynamic',
  kinematic: 'Animated',
  collision_shape: 'Shape',
  friction: 'Friction',
  restitution: 'Bounciness',
  collision_margin: 'Margin',
  linear_damping: 'Translation',
  angular_damping: 'Rotation',
  frame_start: 'Simulation Start',
  frame_end: 'Simulation End',
  substeps_per_frame: 'Substeps Per Frame',
  solver_iterations: 'Solver Iterations',
  time_scale: 'Speed',
  use_gravity: 'Gravity',
  gravity: 'Gravity',
};

const SHAPE_LABELS: Record<string, string> = {
  BOX: 'Box',
  SPHERE: 'Sphere',
  CAPSULE: 'Capsule',
  CYLINDER: 'Cylinder',
  CONE: 'Cone',
  CONVEX_HULL: 'Convex Hull',
  MESH: 'Mesh',
};

export function PhysicsTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const ev = panelEvaluation(s);
  const rb = sanitizeRigidBody(o.rigid_body);
  const isMesh = o.type === 'MESH' && !!o.data;
  return (
    <>
      <div class="prop-context">
        <Icon name="physics" size={14} /> {o.name}
      </div>
      <div style={{ padding: '4px 8px', display: 'flex', gap: '4px' }}>
        <button
          class={`btn ${rb ? 'active' : ''}`}
          style={{ flex: 1 }}
          disabled={!isMesh && !rb}
          aria-pressed={!!rb}
          data-testid="physics-rigid-body"
          title={
            rb
              ? 'Rigid body physics is enabled (use × to remove it)'
              : isMesh
                ? 'Add rigid body physics (falls and collides when the timeline plays)'
                : 'Rigid bodies need a mesh object'
          }
          onClick={() => !rb && run('rigidbody.object_add', { objects: [o.id], type: 'ACTIVE' }, 'ui')}
        >
          <Icon name="physics" size={12} /> Rigid Body
        </button>
        {rb && (
          <button
            class="btn icon"
            title="Remove the rigid body"
            aria-label="Remove rigid body"
            data-testid="physics-rigid-body-remove"
            onClick={() => run('rigidbody.object_remove', { objects: [o.id] }, 'ui')}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {!isMesh && !rb && <div class="empty-note">Rigid body physics is available for mesh objects.</div>}
      {rb && (
        <RigidBodyPanels
          s={s}
          o={o}
          rb={rb}
          simulated={!!ev?.byId.get(o.id)?.simulated}
          errors={[...sourceErrors(ev, `rigidbody:${o.id}`), ...sourceErrors(ev, 'rigidbody')]}
        />
      )}
      <WorldPanel s={s} />
    </>
  );
}

function RigidBodyPanels(p: {
  s: ProjectSession;
  o: ObjectData;
  rb: RigidBodyData;
  simulated: boolean;
  errors: string[];
}) {
  const { s, o, rb } = p;
  const schema = operatorSchema('rigidbody.object_settings_set');
  const active = rb.type === 'ACTIVE';
  const world = sanitizeRigidBodyWorld(s.doc.getScene().rigidbody_world);
  const values = rb as unknown as Record<string, unknown>;
  /** Sets one setting of the current rigid body (nothing when it was removed meanwhile). */
  const writeSetting = (k: string, v: unknown) => {
    const cur = s.doc.getObject(o.id)?.rigid_body;
    if (isRecord(cur)) s.doc.updateObject(o.id, { rigid_body: withField(cur, k, v) });
  };
  const setSetting = (k: string, v: unknown, final: boolean) =>
    dragEdit(
      s,
      `rigidbody:${o.id}:${k}`,
      final,
      () => writeSetting(k, v),
      captureField(
        () => (s.doc.getObject(o.id)?.rigid_body as Record<string, unknown> | null | undefined)?.[k],
        (before) => writeSetting(k, before),
      ),
      // a rigid body (or object) an agent removed meanwhile takes nothing (no error toast)
      () => {
        if (isRecord(s.doc.getObject(o.id)?.rigid_body))
          run('rigidbody.object_settings_set', { objects: [o.id], [k]: v }, 'ui');
      },
    );
  const form = (keys: string[]) => (
    <SchemaForm
      schema={schema}
      only={keys}
      values={values}
      labels={LABELS}
      units={{ mass: ' kg', collision_margin: ' m' }}
      enumLabel={(_k, v) => SHAPE_LABELS[v]}
      testIdPrefix="rigidbody"
      onChange={setSetting}
    />
  );
  const frame = s.state.frame;
  const status = !world.enabled
    ? 'The rigid body world is disabled (enable it below)'
    : p.simulated
      ? `Simulated at frame ${Math.round(frame)}`
      : frame <= world.frame_start
        ? `At rest until the simulation starts after frame ${world.frame_start}`
        : !active
          ? rb.kinematic
            ? 'Passive collider following its animation'
            : 'Passive collider'
          : !rb.enabled
            ? 'Dynamic is off: held at its start pose'
            : 'Not simulated at this frame';
  return (
    <>
      <Panel title="Rigid Body" id="physics-rigid-body">
        <Row label="Type" title="Active bodies are simulated; passive bodies are colliders (floors, walls)">
          <EnumButtons
            value={rb.type}
            testId="rigidbody-type"
            options={[
              { value: 'ACTIVE', label: 'Active' },
              { value: 'PASSIVE', label: 'Passive' },
            ]}
            onChange={(type) => run('rigidbody.object_settings_set', { objects: [o.id], type }, 'ui')}
          />
        </Row>
        <Row label="">
          <span class="hint" data-testid="rigidbody-status">
            {status}
          </span>
        </Row>
        <ErrorList messages={p.errors} testId="rigidbody-errors" />
      </Panel>
      <Panel title="Settings" id="physics-settings">
        {form(active ? ['mass', 'enabled', 'kinematic'] : ['kinematic'])}
      </Panel>
      <Panel title="Collisions" id="physics-collisions">
        {form(['collision_shape'])}
        <div class="hint">Surface Response</div>
        {form(['friction', 'restitution'])}
        <div class="hint">Sensitivity</div>
        {form(['collision_margin'])}
      </Panel>
      {active && (
        <Panel title="Dynamics" id="physics-dynamics" defaultOpen={false}>
          <div class="hint">Damping</div>
          {form(['linear_damping', 'angular_damping'])}
        </Panel>
      )}
      <div style={{ padding: '6px 8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        <button
          class="btn"
          disabled={!active}
          data-testid="rigidbody-bake"
          title="Bake the simulated motion into keyframes and remove the rigid body"
          onClick={() => run('rigidbody.bake_to_keyframes', { objects: [o.id] }, 'ui')}
        >
          Bake to Keyframes
        </button>
        <button
          class="btn"
          data-testid="rigidbody-free-cache"
          title="Drop the cached simulation so it is simulated again from the start"
          onClick={() => run('rigidbody.cache_free', {}, 'ui')}
        >
          Free Cache
        </button>
      </div>
    </>
  );
}

/** Scene-wide rigid body world settings (Blender: Scene > Rigid Body World and Gravity). */
function WorldPanel({ s }: { s: ProjectSession }) {
  const scene = s.doc.getScene();
  const world = sanitizeRigidBodyWorld(scene.rigidbody_world);
  const values: Record<string, unknown> = {
    ...world,
    use_gravity: scene.use_gravity,
    gravity: scene.gravity,
  };
  // gravity lives on the scene, the other settings in its rigidbody_world record
  const onScene = (k: string) => k === 'use_gravity' || k === 'gravity';
  const read = (k: string): unknown => {
    const scene = s.doc.getScene();
    return onScene(k)
      ? (scene as unknown as Record<string, unknown>)[k]
      : (scene.rigidbody_world as unknown as Record<string, unknown> | undefined)?.[k];
  };
  /** Sets one setting in the current scene state, leaving the others as stored. */
  const write = (k: string, v: unknown) => {
    if (onScene(k)) {
      if (v !== undefined) s.doc.updateScene({ [k]: v });
    } else s.doc.updateScene({ rigidbody_world: withField(s.doc.getScene().rigidbody_world, k, v) });
  };
  const set = (k: string, v: unknown, final: boolean) =>
    dragEdit(
      s,
      `rigidbody_world:${k}`,
      final,
      () => write(k, v),
      captureField(
        () => read(k),
        (before) => write(k, before),
      ),
      () => run('rigidbody.world_set', { [k]: v }, 'ui'),
    );
  return (
    <Panel title="Rigid Body World" id="physics-world" defaultOpen={false}>
      <SchemaForm
        schema={operatorSchema('rigidbody.world_set')}
        only={[
          'enabled',
          'frame_start',
          'frame_end',
          'substeps_per_frame',
          'solver_iterations',
          'time_scale',
          'use_gravity',
          'gravity',
        ]}
        values={values}
        labels={{ ...LABELS, enabled: 'Enabled' }}
        units={{ gravity: ' m/s²' }}
        testIdPrefix="rigidbody-world"
        onChange={set}
      />
    </Panel>
  );
}
