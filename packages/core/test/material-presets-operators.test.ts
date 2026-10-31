import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MATERIAL_PRESETS,
  SceneDoc,
  createCube,
  createEditorState,
  createOperatorRegistry,
  getMaterialPreset,
  presetMaterialValues,
  type OperatorContext,
  type ProceduralTexture,
} from '../src';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  const um = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const run = (id: string, params?: unknown) => reg.run<Record<string, any>>(ctx, id, params);
  const cube = (name: string) => {
    const id = doc.addObject({ type: 'MESH', name, data: doc.addMesh(name, createCube({ size: 2 })) });
    return id;
  };
  return { doc, reg, ctx, um, run, cube, reports };
}

describe('material.preset_list', () => {
  it('lists every preset with summary values and filters by category', () => {
    const { reg, run } = setup();
    expect(reg.get('material.preset_list')!.undo).toBe(false);
    const all = run('material.preset_list');
    expect(all.ok).toBe(true);
    expect(all.result!.presets).toHaveLength(MATERIAL_PRESETS.length);
    const brick = all.result!.presets.find((p: { id: string }) => p.id === 'brick');
    expect(brick.procedural_channels).toEqual(['base_color', 'normal']);
    expect(brick.category).toBe('STONE');
    const metals = run('material.preset_list', { category: 'METAL' }).result!.presets;
    expect(metals.length).toBeGreaterThanOrEqual(7);
    expect(metals.every((p: { category: string }) => p.category === 'METAL')).toBe(true);
    expect(run('material.preset_list', { category: 'CHEESE' }).ok).toBe(false);
  });
});

describe('material.preset_apply', () => {
  it('creates one material for all targets (selection) and assigns the slot', () => {
    const { doc, ctx, run, cube } = setup();
    const a = cube('A');
    const b = cube('B');
    ctx.state.selectedIds = [a, b];
    const r = run('material.preset_apply', { preset: 'gold' });
    expect(r.ok).toBe(true);
    expect(r.result!.materials).toHaveLength(1);
    const mid = r.result!.materials[0].id;
    expect(r.result!.materials[0].name).toBe('Gold');
    expect(doc.getObject(a)!.material_slots).toEqual([mid]);
    expect(doc.getObject(b)!.material_slots).toEqual([mid]);
    const m = doc.getMaterial(mid)!;
    const p = presetMaterialValues(getMaterialPreset('gold')!);
    expect(m.base_color).toEqual(p.base_color);
    expect(m.metallic).toBe(1);
    expect(r.result!.objects).toEqual([a, b]);
  });

  it('assigns by object name into a higher slot with a custom name and base colour override', () => {
    const { doc, run, cube } = setup();
    const a = cube('Wall');
    const r = run('material.preset_apply', {
      preset: 'glossy_plastic',
      objects: ['Wall'],
      slot: 2,
      name: 'Toy',
      base_color: [0.1, 0.2, 0.9],
    });
    expect(r.ok).toBe(true);
    const slots = doc.getObject(a)!.material_slots;
    expect(slots).toHaveLength(3);
    expect(slots[0]).toBe(null);
    const m = doc.getMaterial(slots[2]!)!;
    expect(m.name).toBe('Toy');
    expect(m.base_color).toEqual([0.1, 0.2, 0.9, 1]);
  });

  it('OVERWRITE rewrites the slot material in place (once when shared) and fills empty slots', () => {
    const { doc, run, cube } = setup();
    const a = cube('A');
    const b = cube('B');
    const c = cube('C');
    const shared = doc.addMaterial({ name: 'Shared', emission_strength: 5, textures: {} });
    doc.updateObject(a, { material_slots: [shared] });
    doc.updateObject(b, { material_slots: [shared] });
    const r = run('material.preset_apply', { preset: 'brick', objects: [a, b, c], mode: 'OVERWRITE' });
    expect(r.ok).toBe(true);
    expect(r.result!.materials).toHaveLength(2);
    const m = doc.getMaterial(shared)!;
    expect(m.name).toBe('Shared');
    // overwriting resets values that the preset does not set
    expect(m.emission_strength).toBe(0);
    expect(m.textures.base_color?.procedural?.type).toBe('BRICK');
    const cm = doc.getObject(c)!.material_slots[0]!;
    expect(cm).not.toBe(shared);
    expect(doc.getMaterial(cm)!.name).toBe('Brick');
  });

  it('overwrites an explicit material without touching objects', () => {
    const { doc, run } = setup();
    const id = doc.addMaterial({ name: 'Mat' });
    const r = run('material.preset_apply', { preset: 'marble', material: 'Mat' });
    expect(r.ok).toBe(true);
    expect(r.result!.objects).toEqual([]);
    expect(doc.getMaterial(id)!.textures.base_color?.procedural?.type).toBe('MARBLE');
  });

  it('skips objects that cannot take materials and reports errors', () => {
    const { doc, run, reports } = setup();
    const empty = doc.addObject({ type: 'EMPTY', name: 'Empty' });
    const r = run('material.preset_apply', { preset: 'rubber', objects: [empty] });
    expect(r.ok).toBe(true);
    expect(r.result!.objects).toEqual([]);
    expect(reports.some((x) => x.level === 'WARNING' && /cannot have materials/.test(x.message))).toBe(true);
    expect(run('material.preset_apply', { preset: 'adamantium' }).ok).toBe(false);
    expect(run('material.preset_apply', { preset: 'gold', objects: ['Nope'] }).error).toMatch(/not found/);
    expect(run('material.preset_apply', { preset: 'gold', material: 'Nope' }).error).toMatch(/not found/);
  });

  it('is one undo step and survives a snapshot round trip', () => {
    const { doc, um, run, cube } = setup();
    const a = cube('A');
    run('material.preset_apply', { preset: 'rusty_iron', objects: [a] });
    expect(doc.listMaterials()).toHaveLength(1);
    const snap = doc.toSnapshot();
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(copy.listMaterials()).toEqual(doc.listMaterials());
    expect(copy.getObject(a)!.material_slots).toEqual(doc.getObject(a)!.material_slots);
    um.undo();
    expect(doc.listMaterials()).toHaveLength(0);
    expect(doc.getObject(a)!.material_slots).toEqual([]);
    um.redo();
    expect(doc.listMaterials()[0].textures.metallic?.procedural?.type).toBe('NOISE');
  });
});

describe('material.procedural_set', () => {
  const proc = (doc: SceneDoc, id: string, ch = 'base_color'): ProceduralTexture | null | undefined =>
    doc.getMaterial(id)!.textures[ch as 'base_color']?.procedural;

  it('creates a procedural slot from the type defaults and merges later edits', () => {
    const { doc, run } = setup();
    const id = doc.addMaterial({ name: 'M' });
    const r = run('material.procedural_set', {
      material: 'M',
      procedural: { type: 'NOISE', scale: 8, color_a: [1, 0, 0], params: { noise_type: 'RIDGED' } },
    });
    expect(r.ok).toBe(true);
    expect(r.result!.channel).toBe('base_color');
    let t = proc(doc, id)!;
    expect(t.type).toBe('NOISE');
    expect(t.scale).toBe(8);
    expect(t.color_a).toEqual([1, 0, 0, 1]);
    expect(t.detail).toBe(2);
    expect(doc.getMaterial(id)!.textures.base_color!.image).toBe('');
    run('material.procedural_set', { material: id, procedural: { detail: 6, params: { lacunarity: 3 } } });
    t = proc(doc, id)!;
    expect(t.scale).toBe(8);
    expect(t.detail).toBe(6);
    expect(t.params).toEqual({ noise_type: 'RIDGED', lacunarity: 3 });
    // null removes a param
    run('material.procedural_set', { material: id, procedural: { params: { lacunarity: null } } });
    expect(proc(doc, id)!.params).toEqual({ noise_type: 'RIDGED' });
  });

  it('changing the type keeps colours, mapping, seed and common params only', () => {
    const { doc, run } = setup();
    const id = doc.addMaterial({ name: 'M' });
    run('material.procedural_set', {
      material: id,
      procedural: {
        type: 'NOISE',
        mapping: 'OBJECT',
        seed: 4,
        scale: 9,
        color_b: [0, 1, 0, 1],
        params: { noise_type: 'RIDGED', offset_x: 2 },
      },
    });
    run('material.procedural_set', { material: id, procedural: { type: 'BRICK' } });
    const t = proc(doc, id)!;
    expect(t.type).toBe('BRICK');
    expect(t.mapping).toBe('OBJECT');
    expect(t.seed).toBe(4);
    expect(t.color_b).toEqual([0, 1, 0, 1]);
    expect(t.scale).toBe(5);
    expect(t.params).toEqual({ offset_x: 2 });
    run('material.procedural_set', { material: id, procedural: { type: 'BRICK' }, replace: true });
    expect(proc(doc, id)!.mapping).toBe('GENERATED');
  });

  it('works on every channel, defaults to the active object material and validates params', () => {
    const { doc, ctx, run, cube } = setup();
    const o = cube('Obj');
    const id = doc.addMaterial({ name: 'M' });
    doc.updateObject(o, { material_slots: [id] });
    ctx.state.activeId = o;
    for (const channel of ['metallic', 'roughness', 'normal', 'emission', 'alpha']) {
      const r = run('material.procedural_set', { channel, procedural: { type: 'VORONOI' } });
      expect(r.ok, channel).toBe(true);
      expect(proc(doc, id, channel)?.type).toBe('VORONOI');
    }
    const bad = run('material.procedural_set', {
      procedural: { type: 'WAVE', params: { wave_type: 'ZIGZAG' } },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/param 'wave_type' must be one of BANDS\|RINGS/);
    expect(run('material.procedural_set', { procedural: { params: { bogus: 1 } } }).error).toMatch(
      /unknown param/,
    );
    expect(run('material.procedural_set', { material: 'Nope', procedural: {} }).ok).toBe(false);
    ctx.state.activeId = null;
    expect(run('material.procedural_set', { procedural: {} }).error).toMatch(/no active object/);
  });

  it('clears a channel (keeping an image) and is undoable', () => {
    const { doc, um, run } = setup();
    const id = doc.addMaterial({
      name: 'M',
      textures: { roughness: { image: 'img1', scale: [2, 2], offset: [0, 0] } },
    });
    run('material.procedural_set', { material: id, channel: 'roughness', procedural: { type: 'CHECKER' } });
    let slot = doc.getMaterial(id)!.textures.roughness!;
    expect(slot.procedural?.type).toBe('CHECKER');
    expect(slot.scale).toEqual([2, 2]);
    run('material.procedural_set', { material: id, procedural: { type: 'NOISE' } });
    run('material.procedural_set', { material: id, channel: 'base_color', procedural: null });
    expect(doc.getMaterial(id)!.textures.base_color).toBeUndefined();
    um.undo();
    expect(proc(doc, id)?.type).toBe('NOISE');
    um.undo();
    expect(proc(doc, id)).toBeUndefined();
    um.undo();
    slot = doc.getMaterial(id)!.textures.roughness!;
    expect(slot.image).toBe('img1');
    expect(slot.procedural).toBeUndefined();
    // clearing a channel without a procedural reports and keeps the image slot
    const prepared = setup();
    const id2 = prepared.doc.addMaterial({
      name: 'M2',
      textures: { normal: { image: 'n', scale: [1, 1], offset: [0, 0] } },
    });
    const r = prepared.run('material.procedural_set', { material: id2, channel: 'normal', procedural: null });
    expect(r.ok).toBe(true);
    expect(prepared.doc.getMaterial(id2)!.textures.normal!.image).toBe('n');
    expect(prepared.reports.some((x) => /no procedural texture/.test(x.message))).toBe(true);
  });

  it('describes every parameter for AI agents', () => {
    const { reg } = setup();
    for (const id of [
      'material.preset_apply',
      'material.preset_list',
      'material.procedural_set',
      'world.sky_set',
      'world.mist_set',
    ]) {
      const info = reg.describe().find((d) => d.id === id)!;
      expect(info, id).toBeTruthy();
      expect(info.description.length).toBeGreaterThan(80);
      const props =
        (info.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [k, v] of Object.entries(props)) expect(v.description, `${id}.${k}`).toBeTruthy();
    }
  });
});
