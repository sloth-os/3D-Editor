import { signal } from '@preact/signals';
import { useRef, useState } from 'preact/hooks';
import {
  MATERIAL_PRESETS,
  PROCEDURAL_TYPE_DOCS,
  PROCEDURAL_TYPE_PARAMS,
  PROCEDURAL_TYPES,
  channelProcedural,
  getMaterialPreset,
  presetMaterialValues,
  sampleProcedural,
  type MaterialData,
  type MaterialTextureChannel,
  type ObjectData,
  type ProceduralParamSpec,
  type ProceduralTexture,
  type ProceduralType,
  type TextureSlot,
  type Vec3,
  type Vec4,
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
} from '../fields/fields';
import { animState, setProp } from './prop-edit';
import { run, runResult } from '../../editor/editor';
import { Icon } from '../icons';
import { toast } from '../../app/store';
import { boxHeaderStyle, boxStyle, dragEdit } from './ObjectTab';

/*
 * Material tab: material slots, the material of the active slot with a preset picker (the core
 * presets catalogue), the Principled values and per channel an image or procedural texture with
 * its full parameter set. Changes run operators (material.preset_apply, material.procedural_set,
 * data.set_property); slider drags are previewed live.
 */

const CHANNELS: { id: MaterialTextureChannel; label: string }[] = [
  { id: 'base_color', label: 'Base Color' },
  { id: 'roughness', label: 'Roughness' },
  { id: 'metallic', label: 'Metallic' },
  { id: 'normal', label: 'Normal (Bump)' },
  { id: 'emission', label: 'Emission' },
  { id: 'alpha', label: 'Alpha' },
];

const BUTTON_ROW = { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } as const;

async function readImage(file: File): Promise<{ width: number; height: number; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bmp = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const r = { width: bmp.width, height: bmp.height, bytes };
  bmp.close();
  return r;
}

/** Active material slot per object (UI state). */
const activeSlots = signal<Record<string, number>>({});

export function MaterialTab({ s, o }: { s: ProjectSession; o: ObjectData }) {
  const slots = o.material_slots;
  const active = Math.min(activeSlots.value[o.id] ?? 0, Math.max(0, slots.length - 1));
  const setSlot = (i: number) => (activeSlots.value = { ...activeSlots.value, [o.id]: i });
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
                        .map((c) => Math.round(Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2) * 255))
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
              testId="material-select"
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
              data-testid="material-name"
              onChange={(e) => setProp(s, 'materials', m.id, 'name', (e.target as HTMLInputElement).value)}
            />
          </Row>
        )}
      </Panel>
      <PresetPanel s={s} o={o} slot={active} m={m} />
      {m && <PrincipledPanel s={s} m={m} />}
    </>
  );
}

// ------------------------------------------------------------------ presets

const CATEGORY_LABELS: Record<string, string> = {
  METAL: 'Metal',
  PLASTIC: 'Plastic',
  GLASS: 'Glass',
  LIQUID: 'Liquid',
  CERAMIC: 'Ceramic',
  STONE: 'Stone',
  WOOD: 'Wood',
  FABRIC: 'Fabric',
  PAINT: 'Paint',
  EMISSIVE: 'Emissive',
  ORGANIC: 'Organic',
  GROUND: 'Ground',
  PATTERN: 'Pattern',
};

/** Presets matching a search text (name, id, category or description) and a category. */
export function filterPresets(query: string, category: string): (typeof MATERIAL_PRESETS)[number][] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return MATERIAL_PRESETS.filter((p) => {
    if (category !== 'ALL' && p.category !== category) return false;
    const text =
      `${p.name} ${p.id} ${CATEGORY_LABELS[p.category] ?? p.category} ${p.description}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

type SwatchMaterial = Omit<MaterialData, 'id' | 'name'>;

const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * A small shaded sphere of a material (RGBA8, `size`×`size`): base colour, metallic, roughness and
 * emission, including their procedural textures sampled on a 0.4 m sphere (object space), lit by
 * a key light and a grey sky. A preview only, not a render.
 */
export function materialSwatchPixels(m: SwatchMaterial, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const R = 0.4;
  const l = [-0.45, 0.55, 0.7];
  const ll = Math.hypot(l[0], l[1], l[2]);
  const L = [l[0] / ll, l[1] / ll, l[2] / ll];
  const hl = Math.hypot(L[0], L[1], L[2] + 1);
  const H = [L[0] / hl, L[1] / hl, (L[2] + 1) / hl];
  const tex = {
    base: channelProcedural(m, 'base_color'),
    rough: channelProcedural(m, 'roughness'),
    metal: channelProcedural(m, 'metallic'),
    emit: channelProcedural(m, 'emission'),
  };
  const coord = (t: ProceduralTexture, x: number, y: number, nz: number): Vec3 => {
    const P: Vec3 = [x * R, -nz * R, y * R];
    if (t.mapping === 'OBJECT') return P;
    if (t.mapping === 'UV')
      return [
        0.5 + Math.atan2(P[0], -P[1]) / (2 * Math.PI),
        0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI,
        0,
      ];
    return [(x + 1) / 2, (1 - nz) / 2, (y + 1) / 2];
  };
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const transmission = clamp01(m.transmission ?? 0);
  const emitStrength = Math.max(0, m.emission_strength ?? 0);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const y = 1 - ((py + 0.5) / size) * 2;
      const r2 = x * x + y * y;
      const o = (py * size + px) * 4;
      const coverage = clamp01((1 - Math.sqrt(r2)) * size * 0.5 + 0.5);
      if (coverage <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - r2));
      const base: Vec4 = tex.base ? sampleProcedural(tex.base, coord(tex.base, x, y, nz)) : m.base_color;
      const rough = clamp01(
        tex.rough ? sampleProcedural(tex.rough, coord(tex.rough, x, y, nz))[0] : m.roughness,
      );
      const metal = clamp01(
        tex.metal ? sampleProcedural(tex.metal, coord(tex.metal, x, y, nz))[0] : m.metallic,
      );
      const emitColor = tex.emit ? sampleProcedural(tex.emit, coord(tex.emit, x, y, nz)) : m.emission_color;
      const ndl = Math.max(0, x * L[0] + y * L[1] + nz * L[2]);
      const ndh = Math.max(0, x * H[0] + y * H[1] + nz * H[2]);
      const exp = 4 + 600 * (1 - rough) * (1 - rough) * (1 - rough);
      const spec = ((exp + 2) / 8) * Math.pow(ndh, exp) * ndl;
      // reflection of a grey sky (brighter above), blurred towards its mean by roughness
      const ry = 2 * nz * y;
      const sky = 0.18 + 0.55 * clamp01(0.5 + 0.5 * ry);
      const env = sky * (1 - rough) + 0.38 * rough;
      const fres = Math.pow(1 - nz, 5);
      const rgb = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const b = Math.max(0, base[k]);
        const f0 = 0.04 * (1 - metal) + b * metal;
        const F = f0 + (1 - f0) * fres * (1 - rough * 0.8);
        const diffuse = b * (1 - metal) * (1 - transmission) * (ndl * 0.85 + 0.15);
        const through = b * transmission * 0.35;
        rgb[k] = diffuse + through + F * (spec * 1.6 + env * 0.8) + Math.max(0, emitColor[k]) * emitStrength;
      }
      for (let k = 0; k < 3; k++)
        out[o + k] = Math.round(linearToSrgb(clamp01(1 - Math.exp(-1.6 * rgb[k]))) * 255);
      const alpha = m.blend_method === 'BLEND' ? Math.max(0.35, clamp01((m.alpha ?? 1) * (base[3] ?? 1))) : 1;
      out[o + 3] = Math.round(coverage * alpha * 255);
    }
  return out;
}

const SWATCH_SIZE = 44;
const swatches = new Map<string, string>();
/** Bumped whenever preset swatches become available (re-renders the picker). */
const swatchVersion = signal(0);
const swatchQueue: string[] = [];
let swatchTimer: ReturnType<typeof setTimeout> | null = null;

function swatchUrl(pixels: Uint8ClampedArray, size: number): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(size, size);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** The swatch of a preset (a data URL), or null while it is being made (a few per event loop turn). */
function presetSwatch(id: string): string | null {
  const hit = swatches.get(id);
  if (hit !== undefined) return hit || null;
  if (!swatchQueue.includes(id)) swatchQueue.push(id);
  if (!swatchTimer)
    swatchTimer = setTimeout(function work() {
      const t0 = performance.now();
      while (swatchQueue.length && performance.now() - t0 < 12) {
        const pid = swatchQueue.shift()!;
        const preset = getMaterialPreset(pid);
        let url = '';
        try {
          if (preset)
            url = swatchUrl(materialSwatchPixels(presetMaterialValues(preset), SWATCH_SIZE), SWATCH_SIZE);
        } catch {
          url = '';
        }
        swatches.set(pid, url);
      }
      swatchVersion.value++;
      swatchTimer = swatchQueue.length ? setTimeout(work, 0) : null;
    }, 0);
  return null;
}

function PresetPanel({
  s,
  o,
  slot,
  m,
}: {
  s: ProjectSession;
  o: ObjectData;
  slot: number;
  m: MaterialData | null;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  void swatchVersion.value;
  const list = filterPresets(query, category);
  const sel = selected ? getMaterialPreset(selected) : undefined;
  const categories = [...new Set(MATERIAL_PRESETS.map((p) => p.category))];
  const apply = (id: string, overwrite: boolean) => {
    const ok =
      overwrite && m
        ? run('material.preset_apply', { preset: id, material: m.id }, 'ui')
        : run('material.preset_apply', { preset: id, objects: [o.id], slot, mode: 'NEW' }, 'ui');
    if (ok) setSelected(id);
  };
  void s;
  return (
    <Panel title="Presets" id="material-presets" defaultOpen={!m}>
      <div style={{ display: 'flex', gap: '4px' }}>
        <div style={{ flex: 1 }}>
          <TextField
            value={query}
            placeholder="Search presets…"
            commitOnBlur={false}
            ariaLabel="Search material presets"
            testId="material-preset-search"
            onChange={setQuery}
          />
        </div>
        <SelectField
          value={category}
          testId="material-preset-category"
          title="Category"
          options={[
            { value: 'ALL', label: 'All' },
            ...categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c })),
          ]}
          onChange={setCategory}
        />
      </div>
      <div
        role="listbox"
        aria-label="Material presets"
        data-testid="material-presets"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(62px, 1fr))',
          gap: '4px',
          maxHeight: '228px',
          overflowY: 'auto',
          marginTop: '4px',
        }}
      >
        {list.map((p) => {
          const url = presetSwatch(p.id);
          const on = selected === p.id;
          return (
            <button
              key={p.id}
              role="option"
              aria-selected={on}
              class={`btn ${on ? 'active' : ''}`}
              title={`${p.name} — ${p.description}${m ? ' (double-click: apply to this material)' : ''}`}
              data-testid={`material-preset-${p.id}`}
              style={{
                height: 'auto',
                padding: '3px 2px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                minWidth: 0,
              }}
              onClick={() => setSelected(p.id)}
              onDblClick={() => apply(p.id, !!m)}
            >
              {url ? (
                <img src={url} alt="" width={SWATCH_SIZE} height={SWATCH_SIZE} style={{ display: 'block' }} />
              ) : (
                <span style={{ width: `${SWATCH_SIZE}px`, height: `${SWATCH_SIZE}px`, display: 'block' }} />
              )}
              <span
                style={{
                  fontSize: '10px',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.name}
              </span>
            </button>
          );
        })}
        {list.length === 0 && <div class="hint">No preset matches</div>}
      </div>
      {sel && (
        <>
          <div class="hint" style={{ marginTop: '4px' }} data-testid="material-preset-description">
            <b>{sel.name}</b> ({CATEGORY_LABELS[sel.category] ?? sel.category}): {sel.description}
          </div>
          <div style={BUTTON_ROW}>
            {m && (
              <button
                class="btn"
                data-testid="material-preset-apply"
                title={`Overwrite '${m.name}' with the preset (every object using it changes)`}
                onClick={() => apply(sel.id, true)}
              >
                Apply to {m.name}
              </button>
            )}
            <button
              class="btn primary"
              data-testid="material-preset-new"
              title={`New material from the preset in slot ${slot + 1}`}
              onClick={() => apply(sel.id, false)}
            >
              <Icon name="plus" size={12} /> New Material
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ principled values

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
            testId="material-transmission"
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
            testId="material-emission-strength"
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
      <Panel title="Textures" id="material-textures">
        <div class="hint" style={{ marginBottom: '4px' }}>
          Each channel can use an image or a procedural texture (evaluated the same way by the viewport, the
          renderers and the path tracer).
        </div>
        {CHANNELS.map((ch) => (
          <TextureChannel key={ch.id} s={s} m={m} channel={ch.id} label={ch.label} />
        ))}
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
        {m.blend_method === 'CLIP' && (
          <Row label="Clip Threshold">
            <NumberField
              value={m.alpha_threshold}
              min={0}
              max={1}
              slider
              onChange={(v, f) => set('alpha_threshold', v, f)}
            />
          </Row>
        )}
        <Row label="Normal Strength" title="Strength of normal maps and procedural bump">
          <NumberField
            value={m.normal_strength}
            min={0}
            max={10}
            step={0.01}
            onChange={(v, f) => set('normal_strength', v, f)}
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

// ------------------------------------------------------------------ textures

type TextureSource = 'NONE' | 'IMAGE' | 'PROCEDURAL';

/** What a channel uses: nothing, an image or a procedural texture (which wins over an image). */
export function textureSource(
  m: Pick<MaterialData, 'textures'>,
  channel: MaterialTextureChannel,
): TextureSource {
  if (channelProcedural(m, channel)) return 'PROCEDURAL';
  return m.textures?.[channel]?.image ? 'IMAGE' : 'NONE';
}

/** Loads an image file into a material channel (replacing a procedural texture), as one undo step. */
async function loadChannelImage(
  s: ProjectSession,
  m: MaterialData,
  channel: MaterialTextureChannel,
  f: File,
) {
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
      const cur = s.doc.getMaterial(m.id);
      const slot = cur?.textures?.[channel];
      s.doc.updateMaterial(m.id, {
        textures: {
          ...(cur?.textures ?? {}),
          [channel]: { image: imageId, scale: slot?.scale ?? [1, 1], offset: slot?.offset ?? [0, 0] },
        },
      });
    });
  } catch (err) {
    toast(`Could not load image: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

function TextureChannel(p: {
  s: ProjectSession;
  m: MaterialData;
  channel: MaterialTextureChannel;
  label: string;
}) {
  const { s, m, channel } = p;
  const slot = m.textures?.[channel] ?? null;
  const proc = channelProcedural(m, channel);
  const source = textureSource(m, channel);
  const img = slot?.image ? s.doc.getImage(slot.image) : null;
  const tid = `tex-${channel}`;
  const fileInput = useRef<HTMLInputElement>(null);
  const pickImage = () => fileInput.current?.click();
  /** The material's texture slots now, with this channel's slot replaced (other channels as they are now). */
  const texturesWith = (fn: (cur: TextureSlot) => TextureSlot | null) => {
    const cur = s.doc.getMaterial(m.id);
    const curSlot = cur?.textures?.[channel];
    return curSlot ? { ...(cur?.textures ?? {}), [channel]: fn(curSlot) } : null;
  };
  /** Image scale / offset: previewed while dragging, one data.set_property on release. */
  const setImageField = (field: 'scale' | 'offset', v: number[], final: boolean) =>
    dragEdit(
      s,
      `texture:${m.id}:${channel}:${field}`,
      final,
      () => {
        const textures = texturesWith((x) => ({ ...x, [field]: [v[0], v[1]] }));
        if (textures) s.doc.updateMaterial(m.id, { textures });
      },
      () => {
        const before = s.doc.getMaterial(m.id)?.textures?.[channel]?.[field];
        return () => {
          const textures = texturesWith((x) => ({ ...x, [field]: before }));
          if (textures) s.doc.updateMaterial(m.id, { textures });
        };
      },
      () => {
        const textures = texturesWith((x) => ({ ...x, [field]: [v[0], v[1]] }));
        if (textures)
          run('data.set_property', { kind: 'materials', target: m.id, values: { textures } }, 'ui');
      },
    );
  const setSource = (v: TextureSource) => {
    if (v === source) return;
    if (v === 'PROCEDURAL')
      run('material.procedural_set', { material: m.id, channel, procedural: { type: 'NOISE' } }, 'ui');
    else if (v === 'IMAGE') {
      // a stored image comes back when the procedural texture is removed; otherwise pick a file
      if (slot?.image) run('material.procedural_set', { material: m.id, channel, procedural: null }, 'ui');
      else pickImage();
    } else {
      const textures = texturesWith(() => null);
      if (textures) setProp(s, 'materials', m.id, 'textures', textures);
    }
  };
  return (
    <div style={{ ...boxStyle, marginBottom: '4px' }} data-testid={tid}>
      <div style={boxHeaderStyle}>
        <b style={{ flex: 1 }}>{p.label}</b>
        <EnumButtons
          value={source}
          testId={`${tid}-source`}
          compact
          options={[
            { value: 'NONE', label: 'None' },
            { value: 'IMAGE', label: 'Image' },
            { value: 'PROCEDURAL', label: 'Procedural' },
          ]}
          onChange={setSource}
        />
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        data-testid={`${tid}-file`}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          input.value = '';
          if (f) void loadChannelImage(s, m, channel, f);
        }}
      />
      {source === 'IMAGE' && slot && (
        <>
          <Row label="Image">
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <span class="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {img ? `${img.name} (${img.width}×${img.height})` : `${slot.image} (missing)`}
              </span>
              <button class="btn" title="Load another image" onClick={pickImage}>
                Replace…
              </button>
            </div>
          </Row>
          <Row label="Scale" title="UV repetitions of the image">
            <VectorField
              value={[slot.scale?.[0] ?? 1, slot.scale?.[1] ?? 1]}
              labels={['U', 'V']}
              testId={`${tid}-scale`}
              onChange={(v, f) => setImageField('scale', v, f)}
            />
          </Row>
          <Row label="Offset">
            <VectorField
              value={[slot.offset?.[0] ?? 0, slot.offset?.[1] ?? 0]}
              labels={['U', 'V']}
              testId={`${tid}-offset`}
              onChange={(v, f) => setImageField('offset', v, f)}
            />
          </Row>
        </>
      )}
      {source === 'PROCEDURAL' && proc && <ProceduralEditor s={s} m={m} channel={channel} tex={proc} />}
    </div>
  );
}

const TYPE_LABELS: Record<ProceduralType, string> = {
  NOISE: 'Noise',
  VORONOI: 'Voronoi',
  CHECKER: 'Checker',
  GRADIENT: 'Gradient',
  WAVE: 'Wave',
  BRICK: 'Brick',
  MARBLE: 'Marble',
  WOOD: 'Wood',
  MAGIC: 'Magic',
};

/** Procedural types that use detail / roughness / distortion (the others ignore them). */
const USES_DETAIL = new Set<ProceduralType>(['NOISE', 'WAVE', 'MARBLE', 'WOOD', 'MAGIC']);
const USES_ROUGHNESS = new Set<ProceduralType>(['NOISE', 'WAVE', 'MARBLE', 'WOOD']);
const USES_DISTORTION = new Set<ProceduralType>(['NOISE', 'VORONOI', 'WAVE', 'MARBLE', 'WOOD', 'MAGIC']);

/** Channels whose texture is used as a single value (the red component of the ramp colours). */
const SCALAR_CHANNELS = new Set<MaterialTextureChannel>(['roughness', 'metallic', 'normal', 'alpha']);

/** Labels that differ from the title-cased key (Blender's names, or short enough for the label column). */
const PARAM_LABELS: Record<string, string> = {
  color_randomness: 'Random Color',
  offset_frequency: 'Offset Freq.',
  squash_frequency: 'Squash Freq.',
  // enum values
  FBM: 'fBM',
  SIN: 'Sine',
  TRI: 'Triangle',
  SAW: 'Saw',
  DISTANCE_TO_EDGE: 'Distance to Edge',
  XY: 'XY',
};
const SMALL_WORDS = new Set(['to', 'of', 'and', 'or']);

/** Title Case label of a parameter key or enum value (`mortar_size` → "Mortar Size"). */
export function paramLabel(key: string): string {
  return (
    PARAM_LABELS[key] ??
    key
      .toLowerCase()
      .split('_')
      .filter(Boolean)
      .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ')
  );
}

/** The texture with one field (or `params.<key>`) changed, for live previews. */
export function patchProcedural(tex: ProceduralTexture, field: string, value: unknown): ProceduralTexture {
  if (field.startsWith('params.'))
    return { ...tex, params: { ...(tex.params ?? {}), [field.slice(7)]: value as number | string } };
  if (field === 'params') return { ...tex, params: { ...(tex.params ?? {}), ...(value as object) } };
  return { ...tex, [field]: value } as ProceduralTexture;
}

/**
 * `tex` with the field a drag previewed (`field` as in {@link patchProcedural}, `value` the
 * previewed value) put back as it was in `before`; everything else keeps its current value.
 */
export function restoreProcedural(
  tex: ProceduralTexture,
  before: ProceduralTexture,
  field: string,
  value: unknown,
): ProceduralTexture {
  const keys = field.startsWith('params.')
    ? [field.slice(7)]
    : field === 'params'
      ? Object.keys(value as object)
      : null;
  if (!keys)
    return { ...tex, [field]: (before as unknown as Record<string, unknown>)[field] } as ProceduralTexture;
  const params = { ...(tex.params ?? {}) };
  for (const k of keys) {
    const old = before.params?.[k];
    if (old === undefined) delete params[k];
    else params[k] = old;
  }
  return { ...tex, params };
}

/** The `procedural` argument of material.procedural_set for one field (params are merged by the operator). */
export function proceduralPatch(field: string, value: unknown): Record<string, unknown> {
  if (field.startsWith('params.')) return { params: { [field.slice(7)]: value } };
  return { [field]: value };
}

function ProceduralEditor(p: {
  s: ProjectSession;
  m: MaterialData;
  channel: MaterialTextureChannel;
  tex: ProceduralTexture;
}) {
  const { s, m, channel, tex } = p;
  const tid = `tex-${channel}`;
  const scalar = SCALAR_CHANNELS.has(channel);
  const params = tex.params ?? {};
  const animPath = (field: string) => `textures.${channel}.procedural.${field}`;
  const st = (field: string) => animState(s, 'material', m.id, animPath(field), 0);
  /** Replaces this channel's texture in the current material (other channels stay as they are now). */
  const writeTexture = (fn: (t: ProceduralTexture) => ProceduralTexture) => {
    const cur = s.doc.getMaterial(m.id);
    const curTex = channelProcedural(cur, channel);
    const slot = cur?.textures?.[channel];
    if (!cur || !curTex || !slot) return;
    s.doc.updateMaterial(m.id, {
      textures: { ...cur.textures, [channel]: { ...slot, procedural: fn(curTex) } },
    });
  };
  const set = (field: string, value: unknown, final = true) =>
    dragEdit(
      s,
      `procedural:${m.id}:${channel}:${field}`,
      final,
      () => writeTexture((t) => patchProcedural(t, field, value)),
      () => {
        const before = channelProcedural(s.doc.getMaterial(m.id), channel);
        return () => before && writeTexture((t) => restoreProcedural(t, before, field, value));
      },
      () =>
        run(
          'material.procedural_set',
          { material: m.id, channel, procedural: proceduralPatch(field, value) },
          'ui',
        ),
    );
  const grey = (v: number): Vec4 => [v, v, v, 1];
  const paramField = (spec: ProceduralParamSpec) => {
    const value = params[spec.key] ?? spec.default;
    if (spec.kind === 'enum')
      return (
        <Row key={spec.key} label={paramLabel(spec.key)} title={spec.description}>
          <SelectField
            value={String(value)}
            testId={`${tid}-${spec.key}`}
            title={spec.description}
            options={(spec.values ?? []).map((v) => ({ value: v, label: paramLabel(v) }))}
            onChange={(v) => set(`params.${spec.key}`, v)}
          />
        </Row>
      );
    const ranged = spec.min !== undefined && spec.max !== undefined;
    return (
      <Row key={spec.key} label={paramLabel(spec.key)} title={spec.description}>
        <NumberField
          value={Number(value)}
          min={spec.min}
          max={spec.max}
          integer={spec.kind === 'int'}
          slider={ranged && spec.max! - spec.min! <= 10}
          step={spec.kind === 'int' ? 1 : 0.01}
          title={spec.description}
          testId={`${tid}-${spec.key}`}
          onChange={(v, f) => set(`params.${spec.key}`, v, f)}
        />
      </Row>
    );
  };
  const interpolation = String(params.ramp_interpolation ?? 'LINEAR');
  return (
    <div data-testid={`${tid}-procedural`}>
      <Row label="Type" title={PROCEDURAL_TYPE_DOCS[tex.type]}>
        <SelectField
          value={tex.type}
          testId={`${tid}-type`}
          title={PROCEDURAL_TYPE_DOCS[tex.type]}
          options={PROCEDURAL_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
          onChange={(type) =>
            run('material.procedural_set', { material: m.id, channel, procedural: { type } }, 'ui')
          }
        />
      </Row>
      <Row
        label="Mapping"
        title="GENERATED: the object's bounding box; OBJECT: object space in metres; UV: the UV map"
      >
        <SelectField
          value={tex.mapping}
          testId={`${tid}-mapping`}
          options={[
            { value: 'GENERATED', label: 'Generated' },
            { value: 'OBJECT', label: 'Object' },
            { value: 'UV', label: 'UV' },
          ]}
          onChange={(v) => set('mapping', v)}
        />
      </Row>
      <Row label="Scale" title="Pattern repetitions per texture coordinate unit">
        <NumberField
          value={tex.scale}
          step={0.1}
          state={st('scale')}
          testId={`${tid}-scale`}
          onChange={(v, f) => set('scale', v, f)}
        />
      </Row>
      {USES_DETAIL.has(tex.type) && (
        <Row label="Detail" title={tex.type === 'MAGIC' ? 'Depth (0..10)' : 'Noise octaves (0..15)'}>
          <NumberField
            value={tex.detail}
            min={0}
            max={tex.type === 'MAGIC' ? 10 : 15}
            step={0.1}
            state={st('detail')}
            testId={`${tid}-detail`}
            onChange={(v, f) => set('detail', v, f)}
          />
        </Row>
      )}
      {USES_ROUGHNESS.has(tex.type) && (
        <Row label="Roughness" title="Amplitude falloff between octaves">
          <NumberField
            value={tex.roughness}
            min={0}
            max={1}
            slider
            state={st('roughness')}
            testId={`${tid}-roughness`}
            onChange={(v, f) => set('roughness', v, f)}
          />
        </Row>
      )}
      {USES_DISTORTION.has(tex.type) && (
        <Row label="Distortion">
          <NumberField
            value={tex.distortion}
            step={0.05}
            state={st('distortion')}
            testId={`${tid}-distortion`}
            onChange={(v, f) => set('distortion', v, f)}
          />
        </Row>
      )}
      {PROCEDURAL_TYPE_PARAMS[tex.type]?.map(paramField)}
      <div class="hint" style={{ margin: '6px 0 2px', fontWeight: 600 }}>
        Color Ramp
      </div>
      {scalar ? (
        <>
          <Row label="Value A" title="Value at the low end of the ramp">
            <NumberField
              value={tex.color_a[0]}
              step={0.01}
              testId={`${tid}-value-a`}
              onChange={(v, f) => set('color_a', grey(v), f)}
            />
          </Row>
          <Row label="Value B" title="Value at the high end of the ramp">
            <NumberField
              value={tex.color_b[0]}
              step={0.01}
              testId={`${tid}-value-b`}
              onChange={(v, f) => set('color_b', grey(v), f)}
            />
          </Row>
        </>
      ) : (
        <>
          <Row label="Color A">
            <ColorField
              value={tex.color_a}
              testId={`${tid}-color-a`}
              onChange={(v, f) => set('color_a', v, f)}
            />
          </Row>
          <Row label="Color B">
            <ColorField
              value={tex.color_b}
              testId={`${tid}-color-b`}
              onChange={(v, f) => set('color_b', v, f)}
            />
          </Row>
        </>
      )}
      <Row label="Low" title="Texture value where the ramp is exactly A">
        <NumberField
          value={tex.ramp_low}
          step={0.01}
          state={st('ramp_low')}
          testId={`${tid}-ramp-low`}
          onChange={(v, f) => set('ramp_low', v, f)}
        />
      </Row>
      <Row label="High" title="Texture value where the ramp is exactly B">
        <NumberField
          value={tex.ramp_high}
          step={0.01}
          state={st('ramp_high')}
          testId={`${tid}-ramp-high`}
          onChange={(v, f) => set('ramp_high', v, f)}
        />
      </Row>
      <Row label="Interpolation">
        <SelectField
          value={interpolation}
          testId={`${tid}-interpolation`}
          options={[
            { value: 'LINEAR', label: 'Linear' },
            { value: 'EASE', label: 'Ease' },
            { value: 'CONSTANT', label: 'Constant' },
          ]}
          onChange={(v) => set('params.ramp_interpolation', v)}
        />
      </Row>
      <Row label="Seed">
        <NumberField
          value={tex.seed}
          integer
          step={1}
          testId={`${tid}-seed`}
          onChange={(v, f) => set('seed', v, f)}
        />
      </Row>
      <Row label="Offset" title="Translation of the texture coordinates (before the scale)">
        <VectorField
          value={[Number(params.offset_x ?? 0), Number(params.offset_y ?? 0), Number(params.offset_z ?? 0)]}
          testId={`${tid}-offset`}
          onChange={(v, f) => set('params', { offset_x: v[0], offset_y: v[1], offset_z: v[2] }, f)}
        />
      </Row>
      {channel === 'normal' && (
        <Row label="Bump Distance" title="Bump height in metres for texture value 1 (× Normal Strength)">
          <NumberField
            value={Number(params.bump_distance ?? 0.1)}
            min={0}
            max={10}
            step={0.005}
            unit=" m"
            testId={`${tid}-bump-distance`}
            onChange={(v, f) => set('params.bump_distance', v, f)}
          />
        </Row>
      )}
    </div>
  );
}
