import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ShapeKeyData } from '../src/doc/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import { decodeFloat32, encodeFloat32 } from '../src/mesh/shape-keys';
import {
  LAYER_OP_BYTES_PER_VERTEX,
  LAYER_WRITE_BYTES_PER_BYTE,
  SAVE_BYTES_PER_LAYER_BYTE,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  layerBytes,
  storedMeshBytes,
  type OperatorContext,
} from '../src/operators';

/*
 * Apply Object Transform and Set Origin move the shape keys of a mesh with its vertices, as Blender
 * 4.2 does (source/blender/editors/object/object_transform.cc: `BKE_mesh_transform(mesh, mat, true);`
 * and `BKE_mesh_translate(mesh, cent_neg, true);`, whose `do_keys` moves every key block:
 *
 *   if (do_keys && mesh->key) {
 *     LISTBASE_FOREACH (KeyBlock *, kb, &mesh->key->block) { ... mul_m4_v3(mat, fp); ...
 *
 * in blenkernel/intern/mesh.cc), and the copy they make of a mesh other objects use too keeps its
 * vertex groups and shape keys (object_relations.cc single_obdata_users copies the mesh with
 * BKE_id_copy_ex(…, LIB_ID_COPY_DEFAULT | LIB_ID_COPY_ACTIONS), and LIB_ID_COPY_DEFAULT is
 * LIB_ID_COPY_SHAPEKEY).
 */

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => {},
  };
  const run = (id: string, params: object = {}) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r;
  };
  const estimate = (id: string, params: object = {}) =>
    estimateOperator(id, ctx, reg.parseParams(id, params));
  run('mesh.primitive_cube_add', {
    name: 'A',
    location: [1, 2, 3],
    rotation: [0.3, 0.2, 0.1],
    scale: [2, 1.5, -1],
  });
  const a = ctx.state.activeId!;
  const mesh = doc.getObject(a)!.data!;
  const base = Array.from(doc.getMesh(mesh)!.positions);
  // Up raises every vertex by 1; Side, relative to Up, moves them along x and y
  const key = (name: string, move: (p: number[]) => number[], settings: Partial<ShapeKeyData>) => {
    const data: number[] = [];
    for (let i = 0; i < base.length; i += 3) data.push(...move(base.slice(i, i + 3)));
    return {
      name,
      value: 1,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: '',
      ...settings,
      data: encodeFloat32(data),
    };
  };
  const up = key('Up', ([x, y, z]) => [x, y, z + 1], {});
  const side = key('Side', ([x, y, z]) => [x + 0.5, y - 0.25, z + 1], { value: 0.5, relative_key: 'Up' });
  /**
   * Where the evaluated mesh of `id` shows its vertices in the world, after setting the values of its
   * keys named in `values` (they keep them).
   */
  const shown = (id: string, values: Record<string, number> = {}) => {
    const meshId = doc.getObject(id)!.data!;
    doc.setShapeKeys(
      meshId,
      doc.getShapeKeys(meshId).map((k) => ({ ...k, value: values[k.name] ?? k.value })),
    );
    const o = new SceneEvaluator(doc).evaluate(ctx.state.frame).byId.get(id)!;
    const m = o.worldMatrix;
    const p = o.mesh!.positions;
    const out: number[] = [];
    for (let i = 0; i < p.length; i += 3)
      out.push(
        m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12],
        m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13],
        m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14],
      );
    return out;
  };
  const group = { name: 'Group', weights: encodeFloat32([1, 0.5, 0.25, 0, 1, 0.5, 0.25, 0]) };
  return { doc, ctx, run, estimate, a, mesh, up, side, group, shown };
}

function expectClose(actual: number[], expected: number[], digits = 5) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v, `index ${i}`).toBeCloseTo(expected[i], digits));
}

const groupsOf = (doc: SceneDoc, meshId: string) =>
  doc.getVertexGroups(meshId).map((g) => [g.name, Array.from(decodeFloat32(g.weights))]);
const keysOf = (doc: SceneDoc, meshId: string) =>
  doc.getShapeKeys(meshId).map(({ data, ...k }) => ({ ...k, data: Array.from(decodeFloat32(data)) }));

describe('Apply Transform and Set Origin keep the shape keys and vertex groups of a mesh', () => {
  it('Apply Transform moves the shape keys with the vertices: the mesh shows as before at every key value', () => {
    const s = setup();
    s.doc.setShapeKeys(s.mesh, [s.up, s.side]);
    const values = [
      { Up: 1, Side: 0.5 },
      { Up: 0.25, Side: 1 },
      { Up: 0, Side: 0 },
    ];
    const before = values.map((v) => s.shown(s.a, v));
    s.run('object.transform_apply', { location: true, rotation: true, scale: true });
    expect(s.doc.getObject(s.a)!.scale).toEqual([1, 1, 1]);
    values.forEach((v, i) => expectClose(s.shown(s.a, v), before[i]));
  });

  it('Set Origin moves the shape keys with the vertices', () => {
    for (const type of ['ORIGIN_CURSOR', 'ORIGIN_GEOMETRY', 'GEOMETRY_ORIGIN'] as const) {
      const s = setup();
      s.doc.setShapeKeys(s.mesh, [s.up, s.side]);
      s.doc.updateObject(s.a, { location: [1, 2, 3] });
      s.ctx.state.cursorLocation = [4, -1, 2];
      s.doc.setMesh(s.mesh, {
        ...s.doc.getMeshCopy(s.mesh)!,
        // off centre, so that the origin moves for ORIGIN_GEOMETRY and the geometry for GEOMETRY_ORIGIN
        positions: Array.from(s.doc.getMesh(s.mesh)!.positions, (v, i) => v + [0.5, 0.25, 1][i % 3]),
      });
      const before = [s.shown(s.a, { Up: 0, Side: 0 }), s.shown(s.a, { Up: 1, Side: 0.5 })];
      s.run('object.origin_set', { type });
      const after = [s.shown(s.a, { Up: 0, Side: 0 }), s.shown(s.a, { Up: 1, Side: 0.5 })];
      if (type === 'GEOMETRY_ORIGIN') {
        // the geometry moves onto the origin; the keys move with it, so they move it as before
        expect(Math.abs(after[0][0] - before[0][0])).toBeGreaterThan(0.1);
        expectClose(
          after[1].map((v, i) => v - after[0][i]),
          before[1].map((v, i) => v - before[0][i]),
        );
      } else {
        expect(s.doc.getObject(s.a)!.location, type).not.toEqual([1, 2, 3]);
        expectClose(after[0], before[0]);
        expectClose(after[1], before[1]);
      }
    }
  });

  it('give a linked duplicate a mesh of its own with the vertex groups and shape keys of the shared one', () => {
    for (const [op, params] of [
      ['object.transform_apply', { location: true, rotation: true, scale: true }],
      ['object.origin_set', { type: 'ORIGIN_CURSOR' }],
    ] as const) {
      const s = setup();
      s.doc.setShapeKeys(s.mesh, [s.up, s.side]);
      s.doc.setVertexGroups(s.mesh, [s.group]);
      const twin = s.doc.addObject({
        ...s.doc.getObject(s.a)!,
        id: undefined,
        name: 'Twin',
        location: [0, 0, -4],
      });
      s.ctx.state.cursorLocation = [4, -1, 2];
      const groups = groupsOf(s.doc, s.mesh);
      const keys = keysOf(s.doc, s.mesh);
      const positions = Array.from(s.doc.getMesh(s.mesh)!.positions);
      const before = s.shown(s.a);
      s.run(op, params);
      const copy = s.doc.getObject(s.a)!.data!;
      expect(copy, op).not.toBe(s.mesh);
      expect(groupsOf(s.doc, copy), op).toEqual(groups);
      expect(
        keysOf(s.doc, copy).map(({ data: _d, ...k }) => k),
        op,
      ).toEqual(keys.map(({ data: _d, ...k }) => k));
      expectClose(s.shown(s.a), before);
      // the other user keeps the shared mesh as it was
      expect(s.doc.getObject(twin)!.data).toBe(s.mesh);
      expect(Array.from(s.doc.getMesh(s.mesh)!.positions)).toEqual(positions);
      expect(groupsOf(s.doc, s.mesh)).toEqual(groups);
      expect(keysOf(s.doc, s.mesh)).toEqual(keys);
    }
  });

  it('count the groups and keys the copies get and the keys they move, and what the project then keeps', () => {
    for (const [op, params] of [
      ['object.transform_apply', { location: true, rotation: true, scale: true }],
      ['object.origin_set', { type: 'ORIGIN_CURSOR' }],
    ] as const) {
      const s = setup();
      s.doc.addObject({ ...s.doc.getObject(s.a)!, id: undefined, name: 'Twin' });
      const plain = s.estimate(op, params)!;
      expect(plain.layers, op).toBeUndefined();
      s.doc.setShapeKeys(s.mesh, [s.up, s.side]);
      s.doc.setVertexGroups(s.mesh, [s.group]);
      const e = s.estimate(op, params)!;
      // A gets a copy of the mesh with its group (8 weights) and 2 keys (8 positions each), whose keys
      // are then written again, moved
      const groupBytes = 4 * 8;
      const keyBytes = 12 * 8 * 2;
      const written = groupBytes + keyBytes + keyBytes;
      expect(e.layers, op).toEqual({ kind: 'vertex groups and shape keys', bytes: written });
      expect(e.bytes - plain.bytes, op).toBe(
        LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * 2 * 8,
      );
      expect(e.addedStoredBytes - plain.addedStoredBytes, op).toBe(groupBytes + 16 * 2 * 8);
      expect(e.addedSaveBytes, op).toBe(SAVE_BYTES_PER_LAYER_BYTE * (groupBytes + keyBytes));
      const stored = storedMeshBytes(s.doc);
      const layers = layerBytes(s.doc);
      s.run(op, params);
      expect(storedMeshBytes(s.doc) - stored, op).toBe(e.addedStoredBytes);
      expect(layerBytes(s.doc) - layers, op).toBe(groupBytes + keyBytes);
      // a mesh of its own: its keys are written again, moved, and nothing is added
      const own = s.estimate(op, params)!;
      expect(own.layers, op).toEqual({ kind: 'shape keys', bytes: keyBytes });
      expect(own.addedStoredBytes, op).toBe(0);
      expect(own.addedSaveBytes, op).toBe(0);
      // and without keys it writes no layer
      s.doc.setShapeKeys(s.doc.getObject(s.a)!.data!, []);
      expect(s.estimate(op, params)!.layers, op).toBeUndefined();
    }
  });
});
