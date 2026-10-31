import type { ProjectSession } from '../../project/session';
import { Checkbox, ColorField, NumberField, Panel, Row, SelectField, RAD } from '../fields/fields';
import { setProp } from './prop-edit';
import { run } from '../../editor/editor';

export function RenderTab({ s }: { s: ProjectSession }) {
  const r = s.doc.getRender();
  const set = (f: string, v: unknown, final = true) => setProp(s, 'render', null, f, v, final);
  return (
    <>
      <div class="prop-context">Scene › Render</div>
      <Panel title="Render Engine">
        <Row label="Engine">
          <SelectField
            value={r.engine}
            options={[{ value: 'RASTER', label: 'Rasterized (real-time)' }]}
            onChange={(v) => set('engine', v)}
          />
        </Row>
        <Row label="Samples">
          <NumberField value={r.samples} integer min={1} max={64} onChange={(v, f) => set('samples', v, f)} />
        </Row>
        <Row label="">
          <Checkbox value={r.use_shadows} label="Shadows" onChange={(v) => set('use_shadows', v)} />
        </Row>
        <Row label="">
          <button
            class="btn primary"
            onClick={() => run('render.render', {}, 'ui')}
            data-testid="render-button"
          >
            Render Image (F12)
          </button>
        </Row>
      </Panel>
      <Panel title="Film">
        <Row label="">
          <Checkbox
            value={r.film_transparent}
            label="Transparent"
            onChange={(v) => set('film_transparent', v)}
          />
        </Row>
      </Panel>
      <Panel title="Color Management">
        <Row label="View Transform">
          <SelectField
            value={r.view_transform}
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

export function WorldTab({ s }: { s: ProjectSession }) {
  const w = s.doc.getWorld();
  const set = (f: string, v: unknown, final = true) => setProp(s, 'world', null, f, v, final);
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
            onChange={(v, f) => set('strength', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Environment Lighting">
        <Row label="Type">
          <SelectField
            value={w.environment === 'IMAGE' || w.environment === 'SKY' ? 'STUDIO' : w.environment}
            options={[
              { value: 'STUDIO', label: 'Studio' },
              { value: 'NONE', label: 'None (world color)' },
            ]}
            onChange={(v) => set('environment', v)}
          />
        </Row>
        <Row label="Strength">
          <NumberField
            value={w.environment_strength}
            min={0}
            max={20}
            step={0.01}
            onChange={(v, f) => set('environment_strength', v, f)}
          />
        </Row>
        <Row label="Rotation">
          <NumberField
            value={w.environment_rotation}
            unit="°"
            step={1}
            {...RAD}
            onChange={(v, f) => set('environment_rotation', v, f)}
          />
        </Row>
        <Row label="">
          <Checkbox
            value={w.show_environment_background}
            label="Show as Background"
            onChange={(v) => set('show_environment_background', v)}
          />
        </Row>
      </Panel>
    </>
  );
}
