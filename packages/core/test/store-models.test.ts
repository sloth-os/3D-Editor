import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import { FrameState } from '../src/eval/frame-state';
import { renderSceneSoftware } from '../src/render';
import { estimateOperator } from '../src/operators/memory';
import { STORE_MODEL_MAX_OBJECTS, STORE_MODEL_MAX_MATERIALS } from '../src/operators/memory-desk';
import { STORE_CATEGORIES, type CatalogEntry } from '../src/store';
import { FURNITURE_MODELS } from '../src/store/builtin/furniture';
import { PROPS_MODELS } from '../src/store/builtin/props';
import { FOOD_MODELS } from '../src/store/builtin/food';
import type { Vec3 } from '../src/math/types';

/*
 * The built-in furniture, props and food (CATALOG-A) built through store.add: each stands on the
 * ground at the location asked for with its base centred, has the size and triangle count its entry
 * declares, an EMPTY root with named parts, materials in every slot, and honours the build options
 * (size, scale, rotation, colour, parameters, name) as one undo step.
 */

const MINE: CatalogEntry[] = [...FURNITURE_MODELS, ...PROPS_MODELS, ...FOOD_MODELS];

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
  const run = (id: string, p: unknown) => reg.run(ctx, id, p) as RunResult<any> & { result: any };
  return { doc, reg, ctx, reports, run };
}

/** World bounds and triangles of the mesh objects among `ids` (evaluated at frame 1). */
function measure(doc: SceneDoc, ids: readonly string[]) {
  const fs = new FrameState(doc, 1);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const id of ids) {
    const o = doc.getObject(id)!;
    if (o.type !== 'MESH') continue;
    const mesh = doc.getMesh(o.data!)!;
    for (const f of mesh.faces) triangles += f.length - 2;
    const m = fs.world(id)!;
    const P = mesh.positions;
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const w = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
        min[k] = Math.min(min[k], w);
        max[k] = Math.max(max[k], w);
      }
  }
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) as Vec3, triangles };
}

describe('built-in furniture, props and food', () => {
  it('declare unique snake_case ids, valid categories and real data', () => {
    const ids = new Set<string>();
    for (const e of MINE) {
      expect(e.id, e.id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(ids.has(e.id), `duplicate ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(STORE_CATEGORIES).toContain(e.category);
      expect(['furniture', 'props', 'food']).toContain(e.category);
      expect(e.name.length, e.id).toBeGreaterThan(2);
      expect(e.description.length, e.id).toBeGreaterThan(10);
      expect(e.tags.length, e.id).toBeGreaterThan(1);
      expect(e.synonyms.length, e.id).toBeGreaterThan(0);
      expect(e.rig, e.id).toBeNull();
      expect(e.dimensions_m.every((v) => v > 0)).toBe(true);
      // low/mid poly: a few dozen to a few thousand triangles
      expect(e.triangles, e.id).toBeGreaterThan(40);
      expect(e.triangles, e.id).toBeLessThanOrEqual(4000);
    }
    expect(MINE.length).toBeGreaterThanOrEqual(65);
  });

  it.each(MINE.map((e) => [e.id, e] as const))(
    '%s builds at the location asked for, at its declared size and triangle count',
    (_id, e) => {
      const t = setup();
      const location: Vec3 = [1.5, -2, 0.25];
      const res = t.run('store.add', { model: e.id, location });
      expect(res.ok, res.error).toBe(true);
      expect(t.reports.filter((r) => r.level !== 'INFO')).toEqual([]);
      const { root, objects } = res.result;
      const r = t.doc.getObject(root)!;
      expect(r.type).toBe('EMPTY');
      expect(r.name).toBe(e.name);
      expect(r.location).toEqual(location);
      expect(r.custom_props).toMatchObject({
        store_id: `builtin:${e.id}`,
        store_source: 'builtin',
        license: 'CC0-1.0',
        author: '3D Editor built-in',
      });
      expect(objects[0]).toBe(root);
      expect(objects.length).toBeGreaterThan(1);
      expect(objects.length).toBeLessThanOrEqual(STORE_MODEL_MAX_OBJECTS);
      for (const id of objects.slice(1)) {
        const o = t.doc.getObject(id)!;
        expect(t.doc.isAncestor(root, id)).toBe(true);
        expect(o.type).toBe('MESH');
        expect(typeof o.custom_props.store_part).toBe('string');
        // every face's slot has a material
        const mesh = t.doc.getMesh(o.data!)!;
        const slots = Math.max(...mesh.faces.map((_, f) => mesh.faceMaterials[f] ?? 0)) + 1;
        expect(o.material_slots.length, `${e.id}/${o.name}`).toBeGreaterThanOrEqual(slots);
        expect(o.material_slots.every((m) => m && t.doc.getMaterial(m))).toBe(true);
      }
      const m = measure(t.doc, objects);
      // the base centre at the location, the base on its ground
      expect(m.min[2]).toBeCloseTo(location[2], 4);
      expect((m.min[0] + m.max[0]) / 2).toBeCloseTo(location[0], 4);
      expect((m.min[1] + m.max[1]) / 2).toBeCloseTo(location[1], 4);
      for (let k = 0; k < 3; k++)
        expect(Math.abs(m.size[k] / e.dimensions_m[k] - 1), `${e.id} axis ${k}`).toBeLessThan(0.1);
      expect(Math.abs(m.triangles / e.triangles - 1), e.id).toBeLessThan(0.3);
      expect(res.result.dimensions_m.map((v: number, k: number) => Math.abs(v - m.size[k]) < 1e-3)).toEqual([
        true,
        true,
        true,
      ]);
      // the store.add memory estimate covers what the model adds
      const est = estimateOperator('store.add', t.ctx, t.reg.parseParams('store.add', { model: e.id }))!;
      expect(est.faces).toBeGreaterThanOrEqual(m.triangles);
      expect(est.objects).toBeGreaterThanOrEqual(objects.length);
      expect(t.doc.listMaterials().length).toBeLessThanOrEqual(STORE_MODEL_MAX_MATERIALS);
    },
  );
});

describe('store.add', () => {
  it('sizes the model: one size keeps proportions, several set their axes, scale multiplies', () => {
    const t = setup();
    const sofa = MINE.find((e) => e.id === 'sofa')!;
    const [w, d, h] = sofa.dimensions_m;
    const tall = t.run('store.add', { model: 'sofa', height_m: h * 2 }).result;
    const s1 = measure(t.doc, tall.objects).size;
    expect(s1[2]).toBeCloseTo(h * 2, 3);
    expect(s1[0] / s1[1]).toBeCloseTo(w / d, 2);
    const wide = t.run('store.add', { model: 'sofa', width_m: 3, depth_m: 1 }).result;
    const s2 = measure(t.doc, wide.objects).size;
    expect(s2[0]).toBeCloseTo(3, 3);
    expect(s2[1]).toBeCloseTo(1, 3);
    // height by the geometric mean of the two factors
    expect(s2[2]).toBeCloseTo(h * Math.sqrt((3 / w) * (1 / d)), 3);
    const half = t.run('store.add', { model: 'sofa', scale: 0.5 }).result;
    const s3 = measure(t.doc, half.objects).size;
    expect(s3.map((v) => Math.round(v * 1000) / 1000)).toEqual(
      [w / 2, d / 2, h / 2].map((v) => Math.round(v * 1000) / 1000),
    );
    // a size wins over scale
    const both = t.run('store.add', { model: 'sofa', scale: 3, height_m: h }).result;
    expect(measure(t.doc, both.objects).size[2]).toBeCloseTo(h, 3);
  });

  it('reports the size of a tiny or a huge model as built, to six significant digits', () => {
    const t = setup();
    for (const [model, height_m] of [
      ['mug', 1e-6],
      ['mug', 0.00123],
      ['sofa', 9876.5],
    ] as const) {
      const r = t.run('store.add', { model, height_m });
      expect(r.ok, r.error).toBe(true);
      const built = measure(t.doc, r.result.objects).size;
      const reported = r.result.dimensions_m as number[];
      expect(reported[2]).toBeCloseTo(height_m, 9);
      for (let k = 0; k < 3; k++) {
        expect(reported[k], `${model} ${height_m} axis ${k}`).toBeGreaterThan(0);
        expect(Math.abs(reported[k] - built[k]) / built[k]).toBeLessThan(1e-5);
      }
    }
  });

  it('turns the model about Z by rotation_deg (its front from −Y to +X at 90°)', () => {
    const t = setup();
    const r = t.run('store.add', { model: 'sofa', rotation_deg: 90, location: [0, 0, 0] }).result;
    const s = measure(t.doc, r.objects).size;
    const [w, d] = MINE.find((e) => e.id === 'sofa')!.dimensions_m;
    expect(s[0]).toBeCloseTo(d, 2);
    expect(s[1]).toBeCloseTo(w, 2);
    expect(t.doc.getObject(r.root)!.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 9);
  });

  it('places the base centre at the 3D cursor by default and selects the root', () => {
    const t = setup();
    t.ctx.state.cursorLocation = [4, 5, 0];
    const r = t.run('store.add', { model: 'builtin:coffee_table' }).result;
    expect(t.doc.getObject(r.root)!.location).toEqual([4, 5, 0]);
    expect(t.ctx.state.selectedIds).toEqual([r.root]);
    expect(t.ctx.state.activeId).toBe(r.root);
    expect(r.name).toBe('Coffee table');
    expect(r.names[0]).toBe('Coffee table');
    expect(r.entry).toMatchObject({ id: 'builtin:coffee_table', provider: 'builtin', category: 'furniture' });
  });

  it('accepts ids with dashes, spaces or capitals and the store id', () => {
    const t = setup();
    for (const model of ['coffee-table', 'Coffee Table', 'BUILTIN:coffee_table', ' coffee_table '])
      expect(t.run('store.add', { model }).ok, model).toBe(true);
  });

  it('recolours the main material only, sharing materials between copies', () => {
    const t = setup();
    const a = t.run('store.add', { model: 'sofa' }).result;
    const materials = t.doc.listMaterials().length;
    t.run('store.add', { model: 'sofa' });
    // a second sofa of the default colour adds no materials
    expect(t.doc.listMaterials().length).toBe(materials);
    const red = t.run('store.add', { model: 'sofa', color: '#c03030' }).result;
    expect(t.doc.listMaterials().length).toBe(materials + 1);
    const fabricOf = (objects: string[]) =>
      t.doc.getMaterial(t.doc.getObject(objects[1])!.material_slots[0]!)!;
    expect(fabricOf(a.objects).name).toBe('Sofa Fabric');
    const redFabric = fabricOf(red.objects);
    expect(redFabric.name).toBe('Sofa Fabric #c03030');
    // sRGB #c03030 → linear
    expect(redFabric.base_color[0]).toBeCloseTo(0.527, 2);
    expect(redFabric.base_color[1]).toBeCloseTo(0.0296, 3);
    // the legs keep their wood
    const legs = red.objects.find((id: string) => t.doc.getObject(id)!.custom_props.store_part === 'legs');
    expect(t.doc.getMaterial(t.doc.getObject(legs)!.material_slots[0]!)!.name).toBe('Walnut');
  });

  it('takes the model parameters and refuses wrong ones before adding anything', () => {
    const t = setup();
    const two = t.run('store.add', { model: 'sofa', params: { seats: 2 } }).result;
    const four = t.run('store.add', { model: 'sofa', params: { seats: 4 } }).result;
    expect(measure(t.doc, four.objects).size[0] - measure(t.doc, two.objects).size[0]).toBeCloseTo(1.24, 3);
    const tv = t.run('store.add', { model: 'tv', params: { inches: 32 } }).result;
    expect(measure(t.doc, tv.objects).size[0]).toBeCloseTo(0.0254 * 32 * (16 / Math.hypot(16, 9)) + 0.024, 3);
    const bed = t.run('store.add', { model: 'bed', params: { size: 'king' } }).result;
    expect(measure(t.doc, bed.objects).size[0]).toBeCloseTo(1.9, 3);
    const objects = t.doc.listObjects().length;
    expect(t.run('store.add', { model: 'sofa', params: { seats: 9 } })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    const unknown = t.run('store.add', { model: 'sofa', params: { legs: 3 } });
    expect(unknown).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(unknown.error).toMatch(/legs/);
    expect(t.run('store.add', { model: 'rug', params: { seats: 2 } })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
    expect(t.doc.listObjects().length).toBe(objects);
  });

  it('names the root as asked and builds the same model every time', () => {
    const t = setup();
    const r = t.run('store.add', { model: 'bookshelf', name: 'Study shelf' }).result;
    expect(t.doc.getObject(r.root)!.name).toBe('Study shelf');
    const meshOf = (doc: SceneDoc, ids: string[]) =>
      ids.slice(1).map((id) => Array.from(doc.getMesh(doc.getObject(id)!.data!)!.positions));
    const other = setup();
    const b = other.run('store.add', { model: 'bookshelf' }).result;
    // the seeded book rows come out identical in another document
    expect(meshOf(other.doc, b.objects)).toEqual(meshOf(t.doc, r.objects));
  });

  it('is one undo step', () => {
    const t = setup();
    const um = new Y.UndoManager(t.doc.sharedTypes(), {
      trackedOrigins: new Set([t.doc.origin]),
      captureTimeout: 0,
    });
    const r = t.run('store.add', { model: 'office_chair' });
    expect(r.ok).toBe(true);
    expect(t.doc.listObjects().length).toBe(r.result.objects.length);
    um.undo();
    expect(t.doc.listObjects()).toHaveLength(0);
    expect(t.doc.listMaterials()).toHaveLength(0);
  });

  it('names the closest models when the id is unknown', () => {
    const t = setup();
    const r = t.run('store.add', { model: 'couch' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(r.error).toMatch(/No built-in model 'couch'; did you mean 'sofa'/);
    expect(t.run('store.add', { model: 'polyhaven:sofa' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('needs Object Mode', () => {
    const t = setup();
    t.ctx.state.mode = 'EDIT';
    expect(t.run('store.add', { model: 'sofa' })).toMatchObject({ ok: false, code: 'POLL_FAILED' });
  });
});

describe('the wine glass', () => {
  it('reads in RASTER renders against light and dark backgrounds, not as a faint smudge', () => {
    // the glass alone, the same glass in opaque black (its silhouette) and nothing, from the front
    const empty = setup().doc;
    const glass = setup();
    expect(glass.run('store.add', { model: 'wine_glass', location: [0, 0, 0] }).ok).toBe(true);
    const shape = setup();
    const black = shape.doc.addMaterial({ name: 'Silhouette', base_color: [0, 0, 0, 1], roughness: 1 });
    for (const id of shape.run('store.add', { model: 'wine_glass', location: [0, 0, 0] }).result.objects) {
      const o = shape.doc.getObject(id)!;
      if (o.type === 'MESH')
        shape.doc.updateObject(id, { material_slots: o.material_slots.map(() => black) });
    }
    const view = {
      position: [0, -0.6, 0.12] as Vec3,
      target: [0, 0, 0.1] as Vec3,
      fovY: (25 * Math.PI) / 180,
    };
    for (const background of [
      [0.85, 0.86, 0.88, 1],
      [0.35, 0.36, 0.38, 1],
    ] as const) {
      const shot = (doc: SceneDoc) =>
        renderSceneSoftware(doc, { width: 48, height: 64, view, background: [...background], samples: 1 })
          .data;
      const bare = shot(empty);
      /** Pixels whose colour the model changes by more than 8% of the range. */
      const changed = (img: ArrayLike<number>) => {
        let n = 0;
        for (let i = 0; i < img.length; i += 4) {
          const d =
            Math.abs(img[i] - bare[i]) +
            Math.abs(img[i + 1] - bare[i + 1]) +
            Math.abs(img[i + 2] - bare[i + 2]);
          if (d / 3 / 255 > 0.08) n++;
        }
        return n;
      };
      const silhouette = changed(shot(shape.doc));
      expect(silhouette).toBeGreaterThan(300);
      // most of the glass shows (a 0.35-alpha clear glass without wine changed under a fifth of it)
      expect(changed(shot(glass.doc)) / silhouette, `background ${background[0]}`).toBeGreaterThan(0.4);
    }
  });
});
