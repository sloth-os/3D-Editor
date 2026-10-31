import type { ObjectData } from '@3d-editor/core';
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
} from '../fields/fields';
import { animState, animatedValue, setProp } from './prop-edit';
import { run } from '../../editor/editor';
import { Icon } from '../icons';

export function TransformFields({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const vec = (path: 'location' | 'rotation_euler' | 'scale') =>
    o[path].map((v, i) => animatedValue(s, 'object', o.id, path, i, v));
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

export function ObjectTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const objects = s.doc.listObjects().filter((x) => x.id !== o.id && !s.doc.isAncestor(o.id, x.id));
  const collections = s.doc.listCollections();
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
            options={[
              { value: '', label: '— none —' },
              ...objects.map((x) => ({ value: x.id, label: x.name })),
            ]}
            onChange={(v) => run('object.parent_to', { objects: [o.id], parent: v || null }, 'ui')}
          />
        </Row>
        <Row label="Collection">
          <SelectField
            value={o.collection}
            options={collections.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => setProp(s, 'objects', o.id, 'collection', v)}
          />
        </Row>
      </Panel>
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
      <Panel title="Custom Properties" defaultOpen={false}>
        {Object.entries(o.custom_props).map(([k, v]) => (
          <Row key={k} label={k}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <TextField
                value={String(v)}
                onChange={(nv) => {
                  const num = Number(nv);
                  setProp(s, 'objects', o.id, 'custom_props', {
                    ...o.custom_props,
                    [k]: nv !== '' && Number.isFinite(num) ? num : nv,
                  });
                }}
              />
              <button
                class="btn icon"
                title="Remove"
                onClick={() => {
                  const { [k]: _drop, ...rest } = o.custom_props;
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
