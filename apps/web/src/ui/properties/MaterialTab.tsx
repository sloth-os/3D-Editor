import { useState } from 'preact/hooks';
import type { MaterialData, MaterialTextureChannel, ObjectData } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { Checkbox, ColorField, NumberField, Panel, Row, SelectField } from '../fields/fields';
import { animState, setProp } from './prop-edit';
import { run, runResult } from '../../editor/editor';
import { Icon } from '../icons';
import { toast } from '../../app/store';

const CHANNELS: { id: MaterialTextureChannel; label: string }[] = [
  { id: 'base_color', label: 'Base Color' },
  { id: 'roughness', label: 'Roughness' },
  { id: 'metallic', label: 'Metallic' },
  { id: 'normal', label: 'Normal' },
  { id: 'emission', label: 'Emission' },
  { id: 'alpha', label: 'Alpha' },
];

async function readImage(file: File): Promise<{ width: number; height: number; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bmp = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const r = { width: bmp.width, height: bmp.height, bytes };
  bmp.close();
  return r;
}

export function MaterialTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const [slot, setSlot] = useState(0);
  const slots = o.material_slots;
  const active = Math.min(slot, Math.max(0, slots.length - 1));
  const matId = slots[active] ?? null;
  const m = matId ? s.doc.getMaterial(matId) : null;
  const all = s.doc.listMaterials();
  return (
    <>
      <div class="prop-context">
        <Icon name="material" size={14} /> {o.name}
      </div>
      <Panel title="Material Slots">
        {slots.length === 0 && <div class="hint">No material slots</div>}
        {slots.map((id, i) => {
          const mat = id ? s.doc.getMaterial(id) : null;
          return (
            <div
              key={i}
              class={`outliner-row ${i === active ? 'active' : ''}`}
              onClick={() => setSlot(i)}
              data-testid={`material-slot-${i}`}
            >
              <span
                class="dot"
                style={{
                  background: mat
                    ? `rgb(${mat.base_color
                        .slice(0, 3)
                        .map((c) => Math.round(Math.pow(c, 1 / 2.2) * 255))
                        .join(',')})`
                    : '#555',
                  width: '10px',
                  height: '10px',
                }}
              />
              <span class="name">{mat?.name ?? '(empty)'}</span>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
          <button class="btn icon" title="Add slot" onClick={() => run('object.material_slot_add', {}, 'ui')}>
            <Icon name="plus" size={12} />
          </button>
          <button
            class="btn icon"
            title="Remove slot"
            disabled={!slots.length}
            onClick={() => run('object.material_slot_remove', { index: active }, 'ui')}
          >
            <Icon name="minus" size={12} />
          </button>
          {s.state.mode === 'EDIT' && (
            <button class="btn" onClick={() => run('object.material_slot_assign', { index: active }, 'ui')}>
              Assign to Faces
            </button>
          )}
        </div>
      </Panel>
      <Panel title="Material">
        <Row label="">
          <div style={{ display: 'flex', gap: '4px' }}>
            <SelectField
              value={matId ?? ''}
              options={[
                { value: '', label: '— none —' },
                ...all.map((x) => ({ value: x.id, label: x.name })),
              ]}
              onChange={(v) =>
                run('object.material_assign', { material: v || null, objects: [o.id], slot: active }, 'ui')
              }
            />
            <button
              class="btn"
              data-testid="material-new"
              onClick={() => {
                if (!slots.length) {
                  run('material.new', { name: 'Material' }, 'ui');
                  return;
                }
                const r = runResult('material.new', { name: 'Material', assign: false }, 'ui');
                const created = (r?.result as { material?: string } | undefined)?.material;
                if (created)
                  run('object.material_assign', { material: created, objects: [o.id], slot: active }, 'ui');
              }}
            >
              <Icon name="plus" size={12} /> New
            </button>
          </div>
        </Row>
        {m && (
          <Row label="Name">
            <input
              class="textfield"
              value={m.name}
              onChange={(e) => setProp(s, 'materials', m.id, 'name', (e.target as HTMLInputElement).value)}
            />
          </Row>
        )}
      </Panel>
      {m && <PrincipledPanel s={s} m={m} />}
    </>
  );
}

function PrincipledPanel({ s, m }: { s: ProjectSession; m: MaterialData }) {
  const set = (f: string, v: unknown, final = true) => setProp(s, 'materials', m.id, f, v, final);
  const st = (path: string) => animState(s, 'material', m.id, path, 0);
  return (
    <>
      <Panel title="Surface (Principled)">
        <Row label="Base Color">
          <ColorField
            value={m.base_color}
            testId="material-base-color"
            onChange={(v, f) => set('base_color', v, f)}
          />
        </Row>
        <Row label="Metallic">
          <NumberField
            value={m.metallic}
            min={0}
            max={1}
            slider
            state={st('metallic')}
            testId="material-metallic"
            onChange={(v, f) => set('metallic', v, f)}
          />
        </Row>
        <Row label="Roughness">
          <NumberField
            value={m.roughness}
            min={0}
            max={1}
            slider
            state={st('roughness')}
            testId="material-roughness"
            onChange={(v, f) => set('roughness', v, f)}
          />
        </Row>
        <Row label="IOR">
          <NumberField value={m.ior} min={1} max={4} step={0.01} onChange={(v, f) => set('ior', v, f)} />
        </Row>
        <Row label="Alpha">
          <NumberField value={m.alpha} min={0} max={1} slider onChange={(v, f) => set('alpha', v, f)} />
        </Row>
        <Row label="Transmission">
          <NumberField
            value={m.transmission}
            min={0}
            max={1}
            slider
            onChange={(v, f) => set('transmission', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Emission">
        <Row label="Color">
          <ColorField value={m.emission_color} onChange={(v, f) => set('emission_color', v, f)} />
        </Row>
        <Row label="Strength">
          <NumberField
            value={m.emission_strength}
            min={0}
            step={0.05}
            state={st('emission_strength')}
            onChange={(v, f) => set('emission_strength', v, f)}
          />
        </Row>
      </Panel>
      <Panel title="Coat & Sheen" defaultOpen={false}>
        <Row label="Coat">
          <NumberField
            value={m.coat_weight}
            min={0}
            max={1}
            slider
            onChange={(v, f) => set('coat_weight', v, f)}
          />
        </Row>
        <Row label="Coat Roughness">
          <NumberField
            value={m.coat_roughness}
            min={0}
            max={1}
            slider
            onChange={(v, f) => set('coat_roughness', v, f)}
          />
        </Row>
        <Row label="Sheen">
          <NumberField
            value={m.sheen_weight}
            min={0}
            max={1}
            slider
            onChange={(v, f) => set('sheen_weight', v, f)}
          />
        </Row>
        <Row label="Sheen Tint">
          <ColorField value={m.sheen_tint} onChange={(v, f) => set('sheen_tint', v, f)} />
        </Row>
      </Panel>
      <Panel title="Textures" defaultOpen={false}>
        {CHANNELS.map((ch) => {
          const slot = m.textures[ch.id];
          const img = slot ? s.doc.getImage(slot.image) : null;
          return (
            <Row key={ch.id} label={ch.label}>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <span class="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {img ? `${img.name} (${img.width}×${img.height})` : 'none'}
                </span>
                <label class="btn" title="Load image">
                  <Icon name="plus" size={12} />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = (e.target as HTMLInputElement).files?.[0];
                      if (!f) return;
                      try {
                        const info = await readImage(f);
                        if (info.bytes.length > 8 * 1024 * 1024) throw new Error('Image larger than 8 MB');
                        s.doc.transact(() => {
                          const imageId = s.doc.addImage({
                            name: f.name,
                            mime: f.type || 'image/png',
                            width: info.width,
                            height: info.height,
                            data: info.bytes,
                          });
                          s.doc.updateMaterial(m.id, {
                            textures: {
                              ...m.textures,
                              [ch.id]: { image: imageId, scale: [1, 1], offset: [0, 0] },
                            },
                          });
                        });
                      } catch (err) {
                        toast(`Could not load image: ${err instanceof Error ? err.message : err}`, 'error');
                      }
                    }}
                  />
                </label>
                {slot && (
                  <button
                    class="btn icon"
                    title="Remove texture"
                    onClick={() => set('textures', { ...m.textures, [ch.id]: null })}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            </Row>
          );
        })}
      </Panel>
      <Panel title="Settings" defaultOpen={false}>
        <Row label="Blend Mode">
          <SelectField
            value={m.blend_method}
            options={[
              { value: 'OPAQUE', label: 'Opaque' },
              { value: 'CLIP', label: 'Alpha Clip' },
              { value: 'BLEND', label: 'Alpha Blend' },
            ]}
            onChange={(v) => set('blend_method', v)}
          />
        </Row>
        <Row label="">
          <Checkbox
            value={m.use_backface_culling}
            label="Backface Culling"
            onChange={(v) => set('use_backface_culling', v)}
          />
        </Row>
      </Panel>
    </>
  );
}
