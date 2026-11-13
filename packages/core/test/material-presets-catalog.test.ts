import { describe, expect, it } from 'vitest';
import {
  MATERIAL_PRESETS,
  MATERIAL_TEXTURE_CHANNELS,
  PROCEDURAL_MAPPINGS,
  PROCEDURAL_TYPES,
  channelProcedural,
  defaultMaterial,
  getMaterialPreset,
  presetMaterialValues,
  sampleProcedural,
  validateProceduralParams,
} from '../src';

const REQUIRED = [
  'gold',
  'silver',
  'copper',
  'brass',
  'chrome',
  'brushed_aluminium',
  'rusty_iron',
  'glossy_plastic',
  'matte_plastic',
  'rubber',
  'clear_glass',
  'frosted_glass',
  'tinted_glass',
  'water',
  'ceramic',
  'porcelain',
  'wood',
  'marble',
  'concrete',
  'brick',
  'fabric',
  'velvet',
  'leather',
  'car_paint',
  'neon',
  'skin',
  'grass',
  'snow',
  'sand',
  'rock',
];

const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('MATERIAL_PRESETS', () => {
  it('has at least 24 presets with unique ids/names and all required materials', () => {
    expect(MATERIAL_PRESETS.length).toBeGreaterThanOrEqual(24);
    const ids = MATERIAL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(MATERIAL_PRESETS.map((p) => p.name)).size).toBe(ids.length);
    for (const id of REQUIRED) expect(ids, id).toContain(id);
    for (const p of MATERIAL_PRESETS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(p.description.length).toBeGreaterThan(10);
    }
  });

  it('uses physically plausible values', () => {
    for (const p of MATERIAL_PRESETS) {
      const m = presetMaterialValues(p);
      for (const v of m.base_color) {
        expect(v, p.id).toBeGreaterThanOrEqual(0);
        expect(v, p.id).toBeLessThanOrEqual(1);
      }
      expect(m.roughness, p.id).toBeGreaterThanOrEqual(0);
      expect(m.roughness, p.id).toBeLessThanOrEqual(1);
      expect(m.metallic, p.id).toBeGreaterThanOrEqual(0);
      expect(m.metallic, p.id).toBeLessThanOrEqual(1);
      expect(m.ior, p.id).toBeGreaterThanOrEqual(1);
      expect(m.ior, p.id).toBeLessThanOrEqual(3);
      if (p.category === 'METAL') {
        expect(m.metallic, p.id).toBe(1);
        // metals reflect strongly at normal incidence (F0 luminance > 0.3)
        expect(lum(m.base_color), p.id).toBeGreaterThan(0.3);
      } else if (p.id !== 'car_paint') expect(m.metallic, p.id).toBe(0);
      // no real dielectric albedo is (near) 1
      if (m.metallic === 0 && m.transmission === 0) expect(lum(m.base_color), p.id).toBeLessThan(0.95);
      if (p.category === 'GLASS' || p.category === 'LIQUID') {
        expect(m.transmission, p.id).toBe(1);
        expect(m.ior, p.id).toBeGreaterThanOrEqual(1.3);
        expect(m.ior, p.id).toBeLessThanOrEqual(1.6);
      }
    }
    expect(presetMaterialValues(getMaterialPreset('water')!).ior).toBeCloseTo(1.333, 6);
    expect(presetMaterialValues(getMaterialPreset('car_paint')!).coat_weight).toBeGreaterThan(0);
    expect(presetMaterialValues(getMaterialPreset('neon')!).emission_strength).toBeGreaterThan(1);
    expect(presetMaterialValues(getMaterialPreset('velvet')!).sheen_weight).toBeGreaterThan(0.5);
  });

  it('uses the matching procedural texture types', () => {
    const typeOf = (id: string) =>
      channelProcedural(presetMaterialValues(getMaterialPreset(id)!), 'base_color')?.type;
    expect(typeOf('wood')).toBe('WOOD');
    expect(typeOf('marble')).toBe('MARBLE');
    expect(typeOf('brick')).toBe('BRICK');
    expect(typeOf('checker')).toBe('CHECKER');
    expect(channelProcedural(presetMaterialValues(getMaterialPreset('lava')!), 'emission')?.type).toBe(
      'NOISE',
    );
    const procedural = MATERIAL_PRESETS.filter((p) =>
      MATERIAL_TEXTURE_CHANNELS.some((ch) => channelProcedural(presetMaterialValues(p), ch)),
    );
    expect(procedural.length).toBeGreaterThanOrEqual(12);
  });

  it('has valid procedural slots that evaluate to finite colours', () => {
    for (const p of MATERIAL_PRESETS) {
      const m = presetMaterialValues(p);
      for (const ch of MATERIAL_TEXTURE_CHANNELS) {
        const slot = m.textures[ch];
        if (!slot) continue;
        const t = slot.procedural!;
        expect(t, `${p.id}.${ch}`).toBeTruthy();
        expect(slot.image).toBe('');
        expect(PROCEDURAL_TYPES).toContain(t.type);
        expect(PROCEDURAL_MAPPINGS).toContain(t.mapping);
        expect(validateProceduralParams(t.type, t.params), `${p.id}.${ch}`).toEqual([]);
        for (const c of [
          [0.1, 0.2, 0.3],
          [-1.5, 2.25, 0.75],
        ] as [number, number, number][])
          for (const v of sampleProcedural(t, c)) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('expands presets into complete, independent material values', () => {
    const keys = Object.keys(defaultMaterial('x', 'y'))
      .filter((k) => k !== 'id' && k !== 'name')
      .sort();
    for (const p of MATERIAL_PRESETS) expect(Object.keys(presetMaterialValues(p)).sort()).toEqual(keys);
    const a = presetMaterialValues(getMaterialPreset('brick')!);
    a.textures.base_color!.procedural!.scale = 99;
    a.base_color[0] = 0;
    const b = presetMaterialValues(getMaterialPreset('brick')!);
    expect(b.textures.base_color!.procedural!.scale).toBe(1);
    expect(b.base_color[0]).not.toBe(0);
  });

  it('looks presets up case-insensitively', () => {
    expect(getMaterialPreset('Clear Glass')?.id).toBe('clear_glass');
    expect(getMaterialPreset('BRUSHED-ALUMINIUM')?.id).toBe('brushed_aluminium');
    expect(getMaterialPreset('unobtainium')).toBeUndefined();
  });
});
