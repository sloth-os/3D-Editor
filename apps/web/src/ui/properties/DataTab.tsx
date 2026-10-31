import { meshStats, cameraFovY, lensFromFovY, type ObjectData } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { Checkbox, ColorField, NumberField, Panel, Row, SelectField, RAD } from '../fields/fields';
import { animState, setProp } from './prop-edit';
import { run } from '../../editor/editor';
import { Icon } from '../icons';

export function DataTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  if (o.type === 'MESH' && o.data) return <MeshData s={s} o={o} />;
  if (o.type === 'LIGHT' && o.data) return <LightPanel s={s} id={o.data} />;
  if (o.type === 'CAMERA' && o.data) return <CameraPanel s={s} id={o.data} />;
  return <div class="empty-note">Empties have no object data.</div>;
}

function MeshData({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const block = s.doc.getMeshBlock(o.data!);
  const mesh = s.doc.getMesh(o.data!);
  if (!block || !mesh) return null;
  const st = meshStats(mesh);
  const users = s.doc.dataUsers(o.data!);
  const smoothFaces = mesh.faceSmooth.filter(Boolean).length;
  return (
    <>
      <div class="prop-context">
        <Icon name="data" size={14} /> {block.name}
        {users > 1 && <span class="badge">{users} users</span>}
      </div>
      <Panel title="Statistics">
        <div class="hint">
          Vertices {st.vertices.toLocaleString()} · Edges {st.edges.toLocaleString()} · Faces {st.faces.toLocaleString()} · Triangles{' '}
          {st.triangles.toLocaleString()}
        </div>
      </Panel>
      <Panel title="Normals">
        <div class="hint">
          {smoothFaces === 0 ? 'Flat shaded' : smoothFaces === mesh.faces.length ? 'Smooth shaded' : `${smoothFaces} smooth faces`}
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
        <div class="hint">UV map: {mesh.uvs ? 'yes' : 'none'} · Vertex colors: {mesh.colors ? 'yes' : 'none'}</div>
        <div class="hint">Seams: {Object.values(mesh.edgeAttrs).filter((a) => a.seam).length} · Sharp edges: {Object.values(mesh.edgeAttrs).filter((a) => a.sharp).length}</div>
      </Panel>
    </>
  );
}

function LightPanel({ s, id }: { s: ProjectSession; id: string }) {
  const l = s.doc.getLight(id);
  if (!l) return null;
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
          <ColorField value={l.color} onChange={(v, f) => set('color', v, f)} />
        </Row>
        <Row label={l.type === 'SUN' ? 'Strength' : 'Power'}>
          <NumberField
            value={l.energy}
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
            <NumberField value={l.shadow_soft_size} min={0} step={0.01} unit=" m" onChange={(v, f) => set('shadow_soft_size', v, f)} />
          </Row>
        )}
        <Row label="">
          <Checkbox value={l.use_shadow} label="Cast Shadows" onChange={(v) => set('use_shadow', v)} />
        </Row>
      </Panel>
      {l.type === 'SPOT' && (
        <Panel title="Spot Shape">
          <Row label="Size">
            <NumberField value={l.spot_size} min={0.01} max={Math.PI} unit="°" step={1} {...RAD} onChange={(v, f) => set('spot_size', v, f)} />
          </Row>
          <Row label="Blend">
            <NumberField value={l.spot_blend} min={0} max={1} slider onChange={(v, f) => set('spot_blend', v, f)} />
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
            <NumberField value={l.size} min={0.001} step={0.01} unit=" m" onChange={(v, f) => set('size', v, f)} />
          </Row>
          {(l.shape === 'RECTANGLE' || l.shape === 'ELLIPSE') && (
            <Row label="Size Y">
              <NumberField value={l.size_y} min={0.001} step={0.01} unit=" m" onChange={(v, f) => set('size_y', v, f)} />
            </Row>
          )}
        </Panel>
      )}
    </>
  );
}

function CameraPanel({ s, id }: { s: ProjectSession; id: string }) {
  const c = s.doc.getCamera(id);
  if (!c) return null;
  const r = s.doc.getRender();
  const aspect = r.resolution_x / Math.max(1, r.resolution_y);
  const set = (f: string, v: unknown, final = true) => setProp(s, 'cameras', id, f, v, final);
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
              <NumberField value={c.lens} min={1} max={5000} step={0.5} unit=" mm" state={animState(s, 'camera', id, 'lens', 0)} testId="camera-lens" onChange={(v, f) => set('lens', v, f)} />
            </Row>
            <Row label="Field of View">
              <NumberField
                value={cameraFovY(c, aspect)}
                unit="°"
                step={0.5}
                {...RAD}
                min={0.01}
                max={3.1}
                onChange={(v, f) => set('lens', lensFromFovY(v, aspect, c.sensor_width), f)}
              />
            </Row>
          </>
        ) : (
          <Row label="Ortho Scale">
            <NumberField value={c.ortho_scale} min={0.001} step={0.05} onChange={(v, f) => set('ortho_scale', v, f)} />
          </Row>
        )}
        <Row label="Shift X">
          <NumberField value={c.shift_x} step={0.01} onChange={(v, f) => set('shift_x', v, f)} />
        </Row>
        <Row label="Y">
          <NumberField value={c.shift_y} step={0.01} onChange={(v, f) => set('shift_y', v, f)} />
        </Row>
        <Row label="Clip Start">
          <NumberField value={c.clip_start} min={0.0001} step={0.01} unit=" m" onChange={(v, f) => set('clip_start', v, f)} />
        </Row>
        <Row label="End">
          <NumberField value={c.clip_end} min={0.01} step={1} unit=" m" onChange={(v, f) => set('clip_end', v, f)} />
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
          <NumberField value={c.sensor_width} min={1} step={0.1} unit=" mm" onChange={(v, f) => set('sensor_width', v, f)} />
        </Row>
      </Panel>
    </>
  );
}
