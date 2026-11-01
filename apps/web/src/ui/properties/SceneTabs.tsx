import { useState } from 'preact/hooks';
import {
  rigidBodyCacheInfo,
  safeJsonSchema,
  sanitizeRigidBodyWorld,
  type EnvironmentType,
  type WorldSettings,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { Checkbox, ColorField, NumberField, Panel, Row, SelectField, RAD } from '../fields/fields';
import { SchemaForm } from '../SchemaForm';
import { animState, setProp } from './prop-edit';
import { registry, run, runResult } from '../../editor/editor';
import { defaultThreadCount } from '../../render';
import { dragEdit } from './ObjectTab';

/*
 * Scene-level property tabs: Render (engine, sampling, light paths, film, colour management),
 * Output (resolution, frame range), Scene (camera, units, gravity and the rigid body world) and
 * World (surface, environment, procedural sky, mist).
 */

const BUTTON_ROW = { display: 'flex', gap: '4px', flexWrap: 'wrap' } as const;

export function RenderTab({ s }: { s: ProjectSession }) {
  const r = s.doc.getRender();
  const set = (f: string, v: unknown, final = true) => setProp(s, 'render', null, f, v, final);
  const pathTracer = r.engine === 'PATHTRACER';
  return (
    <>
      <div class="prop-context">Scene › Render</div>
      <Panel title="Render Engine">
        <Row label="Engine">
          <SelectField
            value={r.engine}
            testId="render-engine"
            options={[
              { value: 'RASTER', label: 'Rasterized (real-time)' },
              { value: 'PATHTRACER', label: 'Path Tracer' },
            ]}
            onChange={(v) => set('engine', v)}
          />
        </Row>
        <div class="hint" data-testid="render-engine-hint">
          {pathTracer
            ? `Physically based: soft shadows, reflections, refraction and global illumination. F12 renders progressively on ${defaultThreadCount()} CPU thread${defaultThreadCount() === 1 ? '' : 's'} of this device.`
            : 'WebGL, like the Rendered viewport shading: fast, approximate lighting.'}
        </div>
        {!pathTracer && (
          <Row label="">
            <Checkbox value={r.use_shadows} label="Shadows" onChange={(v) => set('use_shadows', v)} />
          </Row>
        )}
        <Row label="">
          <div style={BUTTON_ROW}>
            <button
              class="btn primary"
              onClick={() => run('render.render', {}, 'ui')}
              data-testid="render-button"
            >
              Render Image (F12)
            </button>
            <button
              class="btn"
              onClick={() => run('render.render', { animation: true }, 'ui')}
              data-testid="render-animation-button"
            >
              Render Animation (Ctrl F12)
            </button>
          </div>
        </Row>
      </Panel>
      {pathTracer && (
        <>
          <Panel title="Sampling" id="render-sampling">
            <Row label="Samples" title="Samples per pixel of final renders (more = less noise, slower)">
              <NumberField
                value={r.samples}
                integer
                min={1}
                max={4096}
                step={1}
                testId="render-samples"
                onChange={(v, f) => set('samples', v, f)}
              />
            </Row>
            <Row label="">
              <Checkbox
                value={r.use_denoising}
                label="Denoise"
                testId="render-denoise"
                onChange={(v) => set('use_denoising', v)}
              />
            </Row>
          </Panel>
          <Panel title="Light Paths" id="render-light-paths">
            <Row
              label="Max Bounces"
              title="Total bounces of any kind (diffuse, glossy, transmission); 0 = direct light only"
            >
              <NumberField
                value={r.max_bounces}
                integer
                min={0}
                max={64}
                step={1}
                testId="render-max-bounces"
                onChange={(v, f) => set('max_bounces', v, f)}
              />
            </Row>
          </Panel>
        </>
      )}
      <Panel title="Film">
        <Row label="">
          <Checkbox
            value={r.film_transparent}
            label="Transparent"
            testId="render-film-transparent"
            onChange={(v) => set('film_transparent', v)}
          />
        </Row>
      </Panel>
      <Panel title="Color Management">
        <Row label="View Transform">
          <SelectField
            value={r.view_transform}
            testId="render-view-transform"
            options={[
              { value: 'AGX', label: 'AgX' },
              { value: 'FILMIC', label: 'Filmic' },
              { value: 'ACES', label: 'ACES' },
              { value: 'NEUTRAL', label: 'Khronos PBR Neutral' },
              { value: 'STANDARD', label: 'Standard' },
            ]}
            onChange={(v) => set('view_transform', v)}
          />
        </Row>
        <Row label="Exposure">
          <NumberField
            value={r.exposure}
            min={-10}
            max={10}
            step={0.05}
            testId="render-exposure"
            onChange={(v, f) => set('exposure', v, f)}
          />
        </Row>
      </Panel>
    </>
  );
}

export function OutputTab({ s }: { s: ProjectSession }) {
  const r = s.doc.getRender();
  const sc = s.doc.getScene();
  return (
    <>
      <div class="prop-context">Scene › Output</div>
      <Panel title="Format">
        <Row label="Resolution X">
          <NumberField
            value={r.resolution_x}
            integer
            min={4}
            max={16384}
            unit=" px"
            step={1}
            onChange={(v, f) => setProp(s, 'render', null, 'resolution_x', v, f)}
          />
        </Row>
        <Row label="Y">
          <NumberField
            value={r.resolution_y}
            integer
            min={4}
            max={16384}
            unit=" px"
            step={1}
            onChange={(v, f) => setProp(s, 'render', null, 'resolution_y', v, f)}
          />
        </Row>
        <Row label="%">
          <NumberField
            value={r.resolution_percentage}
            integer
            min={1}
            max={100}
            slider
            unit="%"
            onChange={(v, f) => setProp(s, 'render', null, 'resolution_percentage', v, f)}
          />
        </Row>
        <Row label="Frame Rate">
          <SelectField
            value={String(sc.fps)}
            options={[12, 24, 25, 30, 48, 50, 60, 120].map((x) => ({ value: String(x), label: `${x} fps` }))}
            onChange={(v) => setProp(s, 'scene', null, 'fps', Number(v))}
          />
        </Row>
      </Panel>
      <Panel title="Frame Range">
        <Row label="Frame Start">
          <NumberField
            value={sc.frame_start}
            integer
            step={1}
            onChange={(v, f) => setProp(s, 'scene', null, 'frame_start', v, f)}
          />
        </Row>
        <Row label="End">
          <NumberField
            value={sc.frame_end}
            integer
            step={1}
            onChange={(v, f) => setProp(s, 'scene', null, 'frame_end', v, f)}
          />
        </Row>
      </Panel>
    </>
  );
}

export function SceneTab({ s }: { s: ProjectSession }) {
  const sc = s.doc.getScene();
  const cams = s.doc.listObjects().filter((o) => o.type === 'CAMERA');
  return (
    <>
      <div class="prop-context">Scene</div>
      <Panel title="Scene">
        <Row label="Camera">
          <SelectField
            value={sc.camera ?? ''}
            testId="scene-camera"
            options={[{ value: '', label: '— none —' }, ...cams.map((c) => ({ value: c.id, label: c.name }))]}
            onChange={(v) => setProp(s, 'scene', null, 'camera', v || null)}
          />
        </Row>
      </Panel>
      <Panel title="Units">
        <Row label="Unit System">
          <SelectField
            value={sc.unit_system}
            options={[
              { value: 'METRIC', label: 'Metric' },
              { value: 'IMPERIAL', label: 'Imperial' },
              { value: 'NONE', label: 'None' },
            ]}
            onChange={(v) => setProp(s, 'scene', null, 'unit_system', v)}
          />
        </Row>
        <Row label="Unit Scale">
          <NumberField
            value={sc.unit_scale_length}
            min={0.0001}
            step={0.01}
            onChange={(v, f) => setProp(s, 'scene', null, 'unit_scale_length', v, f)}
          />
        </Row>
      </Panel>
      <RigidBodyWorldPanels s={s} />
      <Panel title="Project">
        <Row label="Name">
          <input
            class="textfield"
            value={s.doc.name}
            data-testid="project-name"
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) s.doc.setName(v);
            }}
          />
        </Row>
        <div class="hint">Project id: {s.id}</div>
      </Panel>
    </>
  );
}

let worldSchema: unknown = null;
/** JSON schema of rigidbody.world_set (ranges and descriptions of the world settings). */
function rigidBodyWorldSchema(): unknown {
  if (!worldSchema) {
    const def = registry.get('rigidbody.world_set');
    worldSchema = def ? safeJsonSchema(def.schema) : { properties: {} };
  }
  return worldSchema;
}

const WORLD_LABELS: Record<string, string> = {
  enabled: 'Enabled',
  frame_start: 'Simulation Start',
  frame_end: 'Simulation End',
  substeps_per_frame: 'Substeps Per Frame',
  solver_iterations: 'Solver Iterations',
  time_scale: 'Speed',
  use_gravity: 'Gravity',
  gravity: 'Gravity',
};

/**
 * Blender's Scene > Gravity and Scene > Rigid Body World (settings and cache). The per-object rigid
 * body settings are in the Physics tab.
 */
function RigidBodyWorldPanels({ s }: { s: ProjectSession }) {
  const [, setTick] = useState(0);
  const sc = s.doc.getScene();
  const world = sanitizeRigidBodyWorld(sc.rigidbody_world);
  void s.state.$frame.value; // the cache grows while the animation plays
  const values: Record<string, unknown> = { ...world, use_gravity: sc.use_gravity, gravity: sc.gravity };
  const set = (k: string, v: unknown, final: boolean) =>
    dragEdit(
      s,
      `scene-rigidbody-world:${k}`,
      final,
      () => {
        if (k === 'use_gravity' || k === 'gravity') s.doc.updateScene({ [k]: v });
        else
          s.doc.updateScene({
            rigidbody_world: { ...sanitizeRigidBodyWorld(s.doc.getScene().rigidbody_world), [k]: v },
          });
      },
      () => {
        const original = s.doc.getScene();
        const restore = {
          rigidbody_world: original.rigidbody_world,
          use_gravity: original.use_gravity,
          gravity: original.gravity,
        };
        return () => s.doc.updateScene(restore);
      },
      () => run('rigidbody.world_set', { [k]: v }, 'ui'),
    );
  const form = (keys: string[]) => (
    <SchemaForm
      schema={rigidBodyWorldSchema()}
      only={keys}
      values={values}
      labels={WORLD_LABELS}
      units={{ gravity: ' m/s²' }}
      testIdPrefix="scene-rigidbody-world"
      onChange={set}
    />
  );
  const bodies = s.doc.listObjects().filter((o) => o.rigid_body);
  const active = bodies.filter((o) => o.rigid_body?.type === 'ACTIVE');
  const cache = rigidBodyCacheInfo(s.doc);
  const cached =
    cache && cache.simulated_to > cache.frame_start
      ? `Cached frames ${cache.frame_start}–${cache.simulated_to} of ${cache.frame_start}–${cache.frame_end}`
      : 'Nothing cached yet (frames are simulated as the timeline plays)';
  const bake = () => {
    // simulates the whole range now, so playback and scrubbing only read the cache
    const r = runResult('rigidbody.describe', { frame: world.frame_end }, 'ui');
    if (r?.ok) setTick((t) => t + 1);
  };
  return (
    <>
      <Panel title="Gravity" id="scene-gravity">
        {form(['use_gravity', 'gravity'])}
      </Panel>
      <Panel title="Rigid Body World" id="scene-rigidbody-world">
        {form(['enabled'])}
        <div class="hint" style={{ margin: '4px 0 2px', fontWeight: 600 }}>
          Settings
        </div>
        {form(['time_scale', 'substeps_per_frame', 'solver_iterations'])}
        <div class="hint" style={{ margin: '6px 0 2px', fontWeight: 600 }}>
          Cache
        </div>
        {form(['frame_start', 'frame_end'])}
        <div class="hint" data-testid="scene-rigidbody-cache">
          {bodies.length
            ? `${bodies.length} rigid bod${bodies.length === 1 ? 'y' : 'ies'} (${active.length} active) · ${cached}`
            : 'No rigid bodies: add them in the Physics tab of an object.'}
        </div>
        <div style={{ ...BUTTON_ROW, marginTop: '4px' }}>
          <button
            class="btn"
            data-testid="scene-rigidbody-bake"
            disabled={!bodies.length || !world.enabled}
            title="Simulate the whole frame range now (playback then reads the cache)"
            onClick={bake}
          >
            Bake
          </button>
          <button
            class="btn"
            data-testid="scene-rigidbody-free"
            disabled={!cache}
            title="Delete the cached simulation (it is simulated again from the start)"
            onClick={() => {
              run('rigidbody.cache_free', {}, 'ui');
              setTick((t) => t + 1);
            }}
          >
            Free Bake
          </button>
          <button
            class="btn"
            data-testid="scene-rigidbody-bake-keyframes"
            disabled={!active.length}
            title="Turn the simulated motion of every active body into keyframes (removes their rigid bodies)"
            onClick={() => run('rigidbody.bake_to_keyframes', { objects: active.map((o) => o.id) }, 'ui')}
          >
            Bake to Keyframes
          </button>
        </div>
      </Panel>
    </>
  );
}

const ENVIRONMENTS: { value: EnvironmentType; label: string }[] = [
  { value: 'STUDIO', label: 'Studio' },
  { value: 'SKY', label: 'Sky (procedural)' },
  { value: 'NONE', label: 'None (world color)' },
];

const SKY_PRESETS = ['NOON', 'CLEAR_DAY', 'MORNING', 'SUNSET', 'DUSK', 'NIGHT', 'OVERCAST'] as const;

/** Mist density (1/m) that reaches 95 % at `distance` metres: 1 − exp(−(ρd)²) = 0.95. */
export function mistDensityForDistance(distance: number): number {
  return Math.sqrt(Math.log(20)) / Math.max(1e-9, distance);
}

export function WorldTab({ s }: { s: ProjectSession }) {
  const w = s.doc.getWorld();
  const set = (f: keyof WorldSettings, v: unknown, final = true) => setProp(s, 'world', null, f, v, final);
  const st = (f: keyof WorldSettings, i = 0) => animState(s, 'world', 'world', f, i);
  const environments = ENVIRONMENTS.some((e) => e.value === w.environment)
    ? ENVIRONMENTS
    : [...ENVIRONMENTS, { value: w.environment, label: 'Image (path tracer only)' }];
  const sky = w.environment === 'SKY';
  return (
    <>
      <div class="prop-context">Scene › World</div>
      <Panel title="Surface">
        <Row label="Color">
          <ColorField value={w.color} testId="world-color" onChange={(v, f) => set('color', v, f)} />
        </Row>
        <Row label="Strength">
          <NumberField
            value={w.strength}
            min={0}
            max={100}
            step={0.01}
            state={st('strength')}
            testId="world-strength"
            onChange={(v, f) => set('strength', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Environment Lighting">
        <Row label="Type">
          <SelectField
            value={w.environment}
            testId="world-environment"
            options={environments}
            onChange={(v) => {
              // switching to the sky also shows it as the background (world.sky_set)
              if (v === 'SKY') run('world.sky_set', { enable: true }, 'ui');
              else set('environment', v);
            }}
          />
        </Row>
        <Row label="Strength">
          <NumberField
            value={w.environment_strength}
            min={0}
            max={20}
            step={0.01}
            state={st('environment_strength')}
            testId="world-environment-strength"
            onChange={(v, f) => set('environment_strength', v, f)}
          />
        </Row>
        {!sky && (
          <Row label="Rotation">
            <NumberField
              value={w.environment_rotation}
              unit="°"
              step={1}
              {...RAD}
              state={st('environment_rotation')}
              onChange={(v, f) => set('environment_rotation', v, f)}
            />
          </Row>
        )}
        <Row label="">
          <Checkbox
            value={w.show_environment_background}
            label="Show as Background"
            testId="world-show-background"
            onChange={(v) => set('show_environment_background', v)}
          />
        </Row>
      </Panel>
      {sky && <SkyPanel s={s} w={w} set={set} st={st} />}
      <Panel title="Mist" id="world-mist" defaultOpen={w.mist_density > 0}>
        <Row label="Density" title="Distance fog density in 1/m (0 = off)">
          <NumberField
            value={w.mist_density}
            min={0}
            max={1000}
            step={0.001}
            precision={4}
            unit=" /m"
            state={st('mist_density')}
            testId="world-mist-density"
            onChange={(v, f) => set('mist_density', v, f)}
          />
        </Row>
        <Row label="Distance" title="View depth in metres where the mist reaches 95 %">
          <NumberField
            value={w.mist_density > 0 ? mistDensityForDistance(1) / w.mist_density : NaN}
            placeholder="Off"
            min={0.01}
            step={1}
            unit=" m"
            testId="world-mist-distance"
            onChange={(v, f) => set('mist_density', mistDensityForDistance(v), f)}
          />
        </Row>
        <Row label="Color">
          <ColorField
            value={w.mist_color}
            testId="world-mist-color"
            onChange={(v, f) => set('mist_color', v, f)}
          />
        </Row>
      </Panel>
    </>
  );
}

function SkyPanel(p: {
  s: ProjectSession;
  w: WorldSettings;
  set: (f: keyof WorldSettings, v: unknown, final?: boolean) => void;
  st: (f: keyof WorldSettings, i?: number) => ReturnType<typeof animState>;
}) {
  const { w, set, st } = p;
  return (
    <Panel title="Sky" id="world-sky">
      <Row label="Preset" title="Apply a ready-made sky (keeps the sun rotation)">
        <SelectField
          value=""
          testId="world-sky-preset"
          options={[
            { value: '', label: 'Apply preset…' },
            ...SKY_PRESETS.map((x) => ({
              value: x,
              label: x
                .toLowerCase()
                .replace(/_/g, ' ')
                .replace(/^\w/, (c) => c.toUpperCase()),
            })),
          ]}
          onChange={(v) => v && run('world.sky_set', { preset: v }, 'ui')}
        />
      </Row>
      <Row label="Zenith">
        <ColorField
          value={w.sky_zenith_color}
          testId="world-sky-zenith"
          onChange={(v, f) => set('sky_zenith_color', v, f)}
        />
      </Row>
      <Row label="Horizon">
        <ColorField
          value={w.sky_horizon_color}
          testId="world-sky-horizon"
          onChange={(v, f) => set('sky_horizon_color', v, f)}
        />
      </Row>
      <Row label="Ground">
        <ColorField
          value={w.sky_ground_color}
          testId="world-sky-ground"
          onChange={(v, f) => set('sky_ground_color', v, f)}
        />
      </Row>
      <div class="hint" style={{ margin: '6px 0 2px', fontWeight: 600 }}>
        Sun
      </div>
      <Row label="Elevation" title="Height of the sun above the horizon (negative = below)">
        <NumberField
          value={w.sun_elevation}
          min={-Math.PI / 2}
          max={Math.PI / 2}
          unit="°"
          step={1}
          {...RAD}
          state={st('sun_elevation')}
          testId="world-sun-elevation"
          onChange={(v, f) => set('sun_elevation', v, f)}
        />
      </Row>
      <Row label="Rotation" title="Azimuth counter-clockwise from +Y seen from above (180° = sun towards −Y)">
        <NumberField
          value={w.sun_rotation}
          unit="°"
          step={1}
          {...RAD}
          state={st('sun_rotation')}
          testId="world-sun-rotation"
          onChange={(v, f) => set('sun_rotation', v, f)}
        />
      </Row>
      <Row label="Intensity" title="Sun irradiance in W/m² (like a Sun lamp's strength; 0 = no sun)">
        <NumberField
          value={w.sun_intensity}
          min={0}
          step={0.05}
          unit=" W/m²"
          state={st('sun_intensity')}
          testId="world-sun-intensity"
          onChange={(v, f) => set('sun_intensity', v, f)}
        />
      </Row>
      <Row label="Size" title="Angular diameter of the sun disc (bigger = softer shadows)">
        <NumberField
          value={w.sun_size}
          min={0}
          max={Math.PI / 2}
          unit="°"
          step={0.05}
          precision={3}
          {...RAD}
          testId="world-sun-size"
          onChange={(v, f) => set('sun_size', v, f)}
        />
      </Row>
      <Row label="Color">
        <ColorField
          value={w.sun_color}
          testId="world-sun-color"
          onChange={(v, f) => set('sun_color', v, f)}
        />
      </Row>
      <div class="hint">The sky and its sun light the scene in Rendered shading and in renders.</div>
    </Panel>
  );
}
