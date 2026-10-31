import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  meshBounds,
  transformPoint3,
  validateMesh,
  type OperatorContext,
  type Vec3,
} from '../src';
import type { GeneratedObjectInfo } from '../src/operators/generate';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (id: string, params?: unknown) => reg.run<GeneratedObjectInfo>(ctx, id, params);
  const ok = (id: string, params?: unknown): GeneratedObjectInfo => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result!;
  };
  const undo = () =>
    new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });
  return { doc, reg, ctx, run, ok, undo, reports };
}

/** Every generator with fast parameters (small resolutions). */
const KINDS: Record<string, Record<string, unknown>> = {
  terrain: { subdivisions: 8 },
  rock: { detail: 2 },
  tree: { branch_levels: 2 },
  bush: {},
  grass_tuft: {},
  flower: {},
  building: {},
  stairs: {},
  fence: {},
  pipe: {},
  table: {},
  chair: {},
  shelf: {},
  gear: {},
  spring: { resolution: 12 },
  column: { flutes: 4 },
  arch: {},
  cloud: { resolution: 16 },
  blob: { resolution: 16 },
  wheel: {},
  barrel: {},
};

describe('object.generate_* operators', () => {
  it('registers one operator per generator in the Add category, with documented parameters', () => {
    const { reg } = setup();
    const ids = reg
      .list()
      .map((o) => o.id)
      .filter((id) => id.startsWith('object.generate_'));
    expect(ids.sort()).toEqual(
      Object.keys(KINDS)
        .map((k) => `object.generate_${k}`)
        .sort(),
    );
    for (const info of reg.describe({ category: 'Add' }).filter((o) => o.id.startsWith('object.generate_'))) {
      expect(info.redoable).toBe(true);
      expect(info.description).toMatch(/Material slot/);
      expect(info.description).toMatch(/Returns/);
      const schema = info.parameters as {
        properties: Record<string, { description?: string; default?: unknown }>;
      };
      for (const [name, prop] of Object.entries(schema.properties)) {
        expect(prop.description, `${info.id}.${name} description`).toBeTruthy();
        if (!['name', 'location'].includes(name))
          expect('default' in prop, `${info.id}.${name} default`).toBe(true);
      }
      expect(schema.properties.seed === undefined || schema.properties.seed.default === 0).toBe(true);
    }
  });

  for (const [kind, params] of Object.entries(KINDS))
    it(`generate_${kind}: adds a selected, active mesh object at the cursor with filled material slots`, () => {
      const { doc, ctx, ok } = setup();
      ctx.state.cursorLocation = [1, 2, 3];
      const r = ok(`object.generate_${kind}`, params);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
      const o = doc.getObject(r.object)!;
      expect(o.type).toBe('MESH');
      expect(o.location).toEqual([1, 2, 3]);
      expect(ctx.state.selectedIds).toEqual([o.id]);
      expect(ctx.state.activeId).toBe(o.id);
      expect(o.data).toBe(r.mesh);
      const mesh = doc.getMesh(o.data!)!;
      expect(validateMesh(mesh)).toEqual([]);
      expect(r.vertices).toBe(mesh.positions.length / 3);
      expect(r.faces).toBe(mesh.faces.length);
      expect(o.material_slots).toHaveLength(r.material_slots.length);
      r.material_slots.forEach((slot, i) => {
        expect(slot.index).toBe(i);
        expect(o.material_slots[i]).toBe(slot.material);
        expect(doc.getMaterial(slot.material!)!.name).toBe(slot.name);
      });
      expect(Math.max(...mesh.faceMaterials)).toBeLessThan(o.material_slots.length);
      const b = meshBounds(mesh)!;
      expect(r.dimensions).toEqual([0, 1, 2].map((k) => expect.closeTo(b.max[k] - b.min[k], 5)));
      expect(r.bounds.min).toEqual([0, 1, 2].map((k) => expect.closeTo(b.min[k] + [1, 2, 3][k], 5)));
    });

  it('places with location, rotation and scale and reports world bounds and scaled dimensions', () => {
    const { doc, ok } = setup();
    const r = ok('object.generate_table', {
      location: [5, 0, 1],
      rotation: [0, 0, Math.PI / 2],
      scale: [2, 2, 2],
      name: 'Desk',
    });
    const o = doc.getObject(r.object)!;
    expect(o.name).toBe('Desk');
    expect(doc.getMeshBlock(o.data!)!.name).toBe('Desk');
    expect(o.rotation_euler).toEqual([0, 0, Math.PI / 2]);
    expect(o.scale).toEqual([2, 2, 2]);
    expect(r.dimensions).toEqual([2.8, 1.6, 1.5].map((v) => expect.closeTo(v, 9)));
    // rotated 90°: the 1.4 m width now spans Y
    expect(r.bounds.max[1] - r.bounds.min[1]).toBeCloseTo(2.8, 9);
    expect(r.bounds.max[0] - r.bounds.min[0]).toBeCloseTo(1.6, 9);
    expect(r.bounds.min[2]).toBeCloseTo(1, 9);
    expect(r.bounds.max[2]).toBeCloseTo(2.5, 9);
    const w = doc.worldMatrix(o.id);
    const mesh = doc.getMesh(o.data!)!;
    const p = transformPoint3(w, [mesh.positions[0], mesh.positions[1], mesh.positions[2]] as Vec3);
    for (let k = 0; k < 3; k++) {
      expect(p[k]).toBeGreaterThanOrEqual(r.bounds.min[k] - 1e-6);
      expect(p[k]).toBeLessThanOrEqual(r.bounds.max[k] + 1e-6);
    }
    expect(ok('object.generate_table', { name: 'Desk' }).name).toBe('Desk.001');
  });

  it('reuses materials by name across generators and keeps user edits to them', () => {
    const { doc, ok } = setup();
    const custom = doc.addMaterial({ name: 'Leaves', base_color: [1, 0, 0, 1] });
    const a = ok('object.generate_tree', { branch_levels: 1 });
    const b = ok('object.generate_bush', {});
    expect(a.material_slots.map((s) => s.name)).toEqual(['Bark', 'Leaves']);
    expect(a.material_slots[1].material).toBe(custom);
    expect(b.material_slots[0].material).toBe(a.material_slots[0].material);
    expect(b.material_slots[1].material).toBe(custom);
    expect(doc.getMaterial(custom)!.base_color).toEqual([1, 0, 0, 1]);
    expect(doc.listMaterials().filter((m) => m.name === 'Bark')).toHaveLength(1);
    const bark = doc.getMaterial(a.material_slots[0].material!)!;
    expect(bark.roughness).toBeGreaterThan(0.5);
    expect(doc.getMaterial(ok('object.generate_gear', {}).material_slots[0].material!)!.metallic).toBe(1);
  });

  it('materials=false leaves one empty slot per material index', () => {
    const { doc, ok } = setup();
    const r = ok('object.generate_building', { materials: false });
    expect(doc.getObject(r.object)!.material_slots).toEqual([null, null, null, null, null]);
    expect(r.material_slots.map((s) => s.material)).toEqual([null, null, null, null, null]);
    expect(r.material_slots.map((s) => s.name)).toEqual([
      'Wall',
      'Window Glass',
      'Window Frame',
      'Roof',
      'Door',
    ]);
    expect(doc.listMaterials()).toHaveLength(0);
  });

  it('is one undo step (object, mesh and new materials) and redoes identically', () => {
    const { doc, ok, undo } = setup();
    const um = undo();
    const r = ok('object.generate_tree', { style: 'PALM', seed: 3 });
    const mesh = doc.getMeshCopy(r.mesh)!;
    expect(doc.listMaterials()).toHaveLength(2);
    um.undo();
    expect(doc.listObjects()).toHaveLength(0);
    expect(doc.listMeshBlocks()).toHaveLength(0);
    expect(doc.listMaterials()).toHaveLength(0);
    um.redo();
    expect(doc.getObject(r.object)!.name).toBe('Tree');
    expect(doc.getMesh(r.mesh)).toEqual(mesh);
    expect(doc.listMaterials().map((m) => m.name)).toEqual(['Bark', 'Palm Leaves']);
  });

  it('the same parameters and seed always build the same mesh', () => {
    const { doc, ok } = setup();
    const a = ok('object.generate_rock', { seed: 11, detail: 3 });
    const b = ok('object.generate_rock', { seed: 11, detail: 3 });
    const c = ok('object.generate_rock', { seed: 12, detail: 3 });
    expect(doc.getMesh(b.mesh)).toEqual(doc.getMesh(a.mesh));
    expect(doc.getMesh(c.mesh)!.positions).not.toEqual(doc.getMesh(a.mesh)!.positions);
  });

  it('survives a snapshot round trip and a Yjs update round trip', () => {
    const { doc, ok } = setup();
    const r = ok('object.generate_building', { roof: 'HIP' });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(copy.getObject(r.object)).toEqual(doc.getObject(r.object));
    expect(copy.getMesh(r.mesh)).toEqual(doc.getMesh(r.mesh));
    expect(copy.listMaterials()).toEqual(doc.listMaterials());
    const synced = SceneDoc.fromUpdate(doc.encodeState());
    expect(synced.getMesh(r.mesh)).toEqual(doc.getMesh(r.mesh));
  });

  it('rejects invalid parameters and runs only in Object Mode', () => {
    const { doc, ctx, run } = setup();
    expect(run('object.generate_tree', { height: -1 }).error).toMatch(/Invalid parameters/);
    expect(run('object.generate_tree', { style: 'BONSAI' }).error).toMatch(/Invalid parameters/);
    expect(run('object.generate_terrain', { subdivisions: 2.5 }).error).toMatch(/Invalid parameters/);
    expect(run('object.generate_pipe', { points: [[0, 0, 0]] }).error).toMatch(/Invalid parameters/);
    expect(run('object.generate_rock', { size: [1, NaN, 1] }).ok).toBe(false);
    expect(doc.listObjects()).toHaveLength(0);
    run('mesh.primitive_cube_add');
    ctx.state.mode = 'EDIT';
    const r = run('object.generate_rock');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Object Mode/);
  });

  it('generated parts and material slots can be split with the existing mesh.separate (Edit Mode)', () => {
    const { doc, ctx, ok, run } = setup();
    const building = ok('object.generate_building', { roof: 'FLAT' });
    ok('object.mode_set', { mode: 'EDIT' });
    ok('mesh.select_all', { action: 'SELECT' });
    const r = run('mesh.separate', { type: 'MATERIAL' });
    expect(r.ok).toBe(true);
    ok('object.mode_set', { mode: 'OBJECT' });
    const parts = doc.listObjects();
    expect(parts).toHaveLength(5);
    for (const o of parts) {
      const mats = new Set(doc.getMesh(o.data!)!.faceMaterials);
      expect(mats.size).toBe(1);
      expect(o.material_slots).toEqual(doc.getObject(building.object)!.material_slots);
    }
    expect(ctx.state.mode).toBe('OBJECT');
    const tree = ok('object.generate_tree', { branch_levels: 1, leaf_density: 0.5 });
    ok('object.select', { objects: [tree.object] });
    ok('object.mode_set', { mode: 'EDIT' });
    ok('mesh.select_all', { action: 'SELECT' });
    expect(run('mesh.separate', { type: 'LOOSE' }).ok).toBe(true);
    expect(doc.listObjects().length).toBeGreaterThan(5 + 3);
  });

  it('passes structured parameters through (fence and pipe points, blob spheres, null window columns)', () => {
    const { doc, ok } = setup();
    const fence = ok('object.generate_fence', {
      points: [
        [0, 0],
        [4, 0, 0.5],
        [4, 4],
      ],
      style: 'RAIL',
    });
    expect(fence.bounds.max[1]).toBeCloseTo(4.05, 1);
    const pipe = ok('object.generate_pipe', {
      points: [
        [0, 0],
        [0, 3],
      ],
      radius: 0.2,
      location: [0, 0, 0],
    });
    expect(pipe.bounds.max[1]).toBeCloseTo(3, 9);
    expect(pipe.bounds.max[2]).toBeCloseTo(0.2, 6);
    const blob = ok('object.generate_blob', {
      spheres: [{ center: [3, 0, 0], radius: 0.5 }],
      smoothness: 0,
      resolution: 24,
      location: [0, 0, 0],
    });
    expect((blob.bounds.min[0] + blob.bounds.max[0]) / 2).toBeCloseTo(3, 1);
    const building = ok('object.generate_building', { window_cols: null, window_cols_side: 0 });
    const glass = doc.getMesh(building.mesh)!.faceMaterials.filter((m) => m === 1).length;
    expect(glass).toBeGreaterThan(0);
  });
});
