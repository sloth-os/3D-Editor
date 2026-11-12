import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ShapeKeyData } from '../src/doc/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import { decodeFloat32, encodeFloat32 } from '../src/mesh/shape-keys';
import { createMesh } from '../src/mesh/types';
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
 * object.join keeps the vertex groups and shape keys of every joined mesh, as Blender 4.2's Join
 * does (ED_mesh_join_objects_exec and join_mesh_single in source/blender/editors/mesh/meshtools.cc):
 *
 *   // Join this object's vertex groups to the base one's
 *   LISTBASE_FOREACH (bDeformGroup *, dg, &mesh->vertex_group_names) {
 *     // See if this group exists in the object (if it doesn't, add it to the end)
 *     if (!BKE_object_defgroup_find_name(ob, dg->name)) { ... BLI_addtail(&mesh_active->vertex_group_names, odg); }
 *
 *   // For each shape-key in destination mesh:
 *   // - if there's a matching one, copy it across (will need to transform vertices into new space...).
 *   // - otherwise, just copy its own coordinates of mesh (no need to transform vertex coordinates into new space).
 *
 * and a key that only another mesh has is added (`kbn = BKE_keyblock_add(key, kb->name);
 * BKE_keyblock_copy_settings(kbn, kb);`), also when the active mesh has none (`else if (haskey)
 * { key = mesh->key = BKE_key_add(bmain, (ID *)mesh); ... }`).
 */

/** A, B and C as three mesh objects (3, 4 and 3 vertices) with B and C moved; all selected, A active. */
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
  const meshes = {
    A: doc.addMesh('A', createMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] })),
    B: doc.addMesh(
      'B',
      createMesh({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], faces: [[0, 1, 2, 3]] }),
    ),
    C: doc.addMesh('C', createMesh({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], faces: [[0, 1, 2]] })),
  };
  const a = doc.addObject({ type: 'MESH', name: 'A', data: meshes.A });
  // B turned a quarter about Z and moved: (x, y, z) → (2 − y, x, z)
  const b = doc.addObject({
    type: 'MESH',
    name: 'B',
    data: meshes.B,
    location: [2, 0, 0],
    rotation_euler: [0, 0, Math.PI / 2],
  });
  const c = doc.addObject({ type: 'MESH', name: 'C', data: meshes.C, location: [0, 0, 5] });
  ctx.state.selectedIds = [a, b, c];
  ctx.state.activeId = a;
  const run = (id: string, params: object = {}) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r;
  };
  const estimate = (id: string) => estimateOperator(id, ctx, reg.parseParams(id, {}));
  const group = (name: string, weights: number[]) => ({ name, weights: encodeFloat32(weights) });
  const key = (name: string, positions: number[], settings: Partial<ShapeKeyData> = {}): ShapeKeyData => ({
    name,
    value: 0,
    slider_min: 0,
    slider_max: 1,
    mute: false,
    relative_key: '',
    ...settings,
    data: encodeFloat32(positions),
  });
  const groupsOf = (meshId: string) =>
    doc.getVertexGroups(meshId).map((g) => [g.name, Array.from(decodeFloat32(g.weights))]);
  const keysOf = (meshId: string) =>
    doc.getShapeKeys(meshId).map(({ data, ...k }) => ({ ...k, data: Array.from(decodeFloat32(data)) }));
  return { doc, ctx, run, estimate, meshes, a, b, c, group, key, groupsOf, keysOf };
}

/** Expects `actual` to be `expected` within 1e-6 (B's quarter turn is not exact in floats). */
function expectClose(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v, `index ${i}`).toBeCloseTo(expected[i], 6));
}

// where the vertices of B and C are in A's space after the join (A is not moved)
const B_JOINED = [2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 0, 0];
const C_JOINED = [0, 0, 5, 2, 0, 5, 0, 2, 5];

describe('object.join keeps the vertex groups and shape keys of every joined mesh (Blender 4.2)', () => {
  it('merges the vertex groups by name, the active mesh’s first, with weight 0 where a mesh lacks a group', () => {
    const s = setup();
    s.doc.setVertexGroups(s.meshes.A, [s.group('Shared', [0.5, 0.25, 1]), s.group('OnlyA', [1, 1, 1])]);
    s.doc.setVertexGroups(s.meshes.B, [
      s.group('OnlyB', [0.125, 0.25, 0.5, 1]),
      s.group('Shared', [0.75, 0.75, 0.75, 0.75]),
    ]);
    s.run('object.join');
    expect(s.doc.listObjects().map((o) => o.name)).toEqual(['A']);
    expect(s.doc.meshCounts(s.meshes.A)!.vertices).toBe(10);
    expect(s.groupsOf(s.meshes.A)).toEqual([
      ['Shared', [0.5, 0.25, 1, 0.75, 0.75, 0.75, 0.75, 0, 0, 0]],
      ['OnlyA', [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]],
      ['OnlyB', [0, 0, 0, 0.125, 0.25, 0.5, 1, 0, 0, 0]],
    ]);
    // and when the active mesh has none
    const t = setup();
    t.doc.setVertexGroups(t.meshes.C, [t.group('OnlyC', [0.25, 0.5, 1])]);
    t.run('object.join');
    expect(t.groupsOf(t.meshes.A)).toEqual([['OnlyC', [0, 0, 0, 0, 0, 0, 0, 0.25, 0.5, 1]]]);
  });

  it('merges the shape keys by name: each mesh’s own positions moved into the active object’s space, or its vertices where it lacks a key', () => {
    const s = setup();
    s.doc.setShapeKeys(s.meshes.A, [
      s.key('Up', [0, 0, 1, 1, 0, 1, 0, 1, 1], { value: 0.5, relative_key: 'Muted' }),
      s.key('Muted', [0.5, 0, 0, 1.5, 0, 0, 0.5, 1, 0], { value: 1, mute: true }),
    ]);
    s.doc.setShapeKeys(s.meshes.B, [
      s.key('Up', [0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2], { value: 0.25 }),
      s.key('Twist', [0, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0], {
        value: 0.75,
        slider_min: -1,
        slider_max: 2,
        mute: true,
        relative_key: 'Up',
      }),
    ]);
    s.run('object.join');
    const keys = s.keysOf(s.meshes.A);
    expect(keys.map(({ data: _d, ...k }) => k)).toEqual([
      // the active mesh's settings, but the relative key of the last joined mesh that has the key:
      // meshtools.cc sets `kb_map[i]->relative = index_map[kb->relative]` for every key of B
      { name: 'Up', value: 0.5, slider_min: 0, slider_max: 1, mute: false, relative_key: '' },
      { name: 'Muted', value: 1, slider_min: 0, slider_max: 1, mute: true, relative_key: '' },
      // B's settings, unmuted: BKE_keyblock_copy_settings copies value, slider range and relative key, no flags
      { name: 'Twist', value: 0.75, slider_min: -1, slider_max: 2, mute: false, relative_key: 'Up' },
    ]);
    expectClose(keys[0].data, [
      0,
      0,
      1,
      1,
      0,
      1,
      0,
      1,
      1,
      ...[2, 0, 2, 2, 1, 2, 1, 1, 2, 1, 0, 2],
      ...C_JOINED,
    ]);
    expectClose(keys[1].data, [0.5, 0, 0, 1.5, 0, 0, 0.5, 1, 0, ...B_JOINED, ...C_JOINED]);
    expectClose(keys[2].data, [
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      ...[1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0],
      ...C_JOINED,
    ]);
  });

  it('adds the shape keys of the other meshes when the active mesh has none, and shows what the objects showed', () => {
    const s = setup();
    s.doc.setShapeKeys(s.meshes.B, [s.key('Up', [0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2], { value: 0.25 })]);
    const shown = (doc: SceneDoc) => {
      const out: number[] = [];
      for (const [, o] of new SceneEvaluator(doc).evaluate(1).byId) {
        const p = o.mesh!.positions;
        for (let i = 0; i < p.length; i += 3) {
          const m = o.worldMatrix;
          const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
          out.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
        }
      }
      return out;
    };
    const before = shown(s.doc);
    s.run('object.join');
    expect(s.keysOf(s.meshes.A).map((k) => [k.name, k.value])).toEqual([['Up', 0.25]]);
    expectClose(s.keysOf(s.meshes.A)[0].data, [
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      2,
      0,
      2,
      2,
      1,
      2,
      1,
      1,
      2,
      1,
      0,
      2,
      ...C_JOINED,
    ]);
    // B's quarter of its key shown, A and C as they were
    expectClose(shown(s.doc), before);
    expectClose(before.slice(9, 21), [2, 0, 0.5, 2, 1, 0.5, 1, 1, 0.5, 1, 0, 0.5]);
  });

  it('is one undo step that gives every mesh its groups and keys back', () => {
    const s = setup();
    const um = new Y.UndoManager(s.doc.sharedTypes(), {
      trackedOrigins: new Set([s.doc.origin]),
      captureTimeout: 0,
    });
    s.doc.setVertexGroups(s.meshes.B, [s.group('OnlyB', [0.125, 0.25, 0.5, 1])]);
    s.doc.setShapeKeys(s.meshes.C, [s.key('Up', [0, 0, 1, 2, 0, 1, 0, 2, 1])]);
    um.clear();
    const groups = s.groupsOf(s.meshes.B);
    const keys = s.keysOf(s.meshes.C);
    s.run('object.join');
    expect(s.doc.getMeshBlock(s.meshes.B)).toBeNull();
    um.undo();
    expect(
      s.doc
        .listObjects()
        .map((o) => o.name)
        .sort(),
    ).toEqual(['A', 'B', 'C']);
    expect(s.doc.meshCounts(s.meshes.A)!.vertices).toBe(3);
    expect(s.groupsOf(s.meshes.A)).toEqual([]);
    expect(s.keysOf(s.meshes.A)).toEqual([]);
    expect(s.groupsOf(s.meshes.B)).toEqual(groups);
    expect(s.keysOf(s.meshes.C)).toEqual(keys);
    um.redo();
    expect(s.groupsOf(s.meshes.A).map(([name]) => name)).toEqual(['OnlyB']);
    expect(s.keysOf(s.meshes.A).map((k) => k.name)).toEqual(['Up']);
  });

  it('counts the groups and keys it writes for every vertex of the joined mesh, and what the project then keeps', () => {
    const s = setup();
    const plain = s.estimate('object.join')!;
    expect(plain.layers).toBeUndefined();
    s.doc.setVertexGroups(s.meshes.A, [s.group('Shared', [0.5, 0.25, 1]), s.group('OnlyA', [1, 1, 1])]);
    s.doc.setVertexGroups(s.meshes.B, [s.group('OnlyB', [0.125, 0.25, 0.5, 1])]);
    s.doc.setShapeKeys(s.meshes.B, [s.key('Up', [0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2])]);
    s.doc.setShapeKeys(s.meshes.C, [s.key('Down', [0, 0, -1, 2, 0, -1, 0, 2, -1])]);
    const e = s.estimate('object.join')!;
    // 3 groups and 2 keys, each with a value for the 10 vertices of the joined mesh
    const written = 4 * 3 * 10 + 12 * 2 * 10;
    expect(e.layers).toEqual({ kind: 'vertex groups and shape keys', bytes: written });
    expect(e.bytes - plain.bytes).toBe(LAYER_WRITE_BYTES_PER_BYTE * written + LAYER_OP_BYTES_PER_VERTEX * 10);
    const stored = storedMeshBytes(s.doc);
    const layers = layerBytes(s.doc);
    // the groups and keys of A, B and C go with their meshes
    expect(layers).toBe(4 * 2 * 3 + 4 * 1 * 4 + 12 * 1 * 4 + 12 * 1 * 3);
    s.run('object.join');
    expect(storedMeshBytes(s.doc) - stored).toBe(e.addedStoredBytes);
    expect(e.addedStoredBytes - plain.addedStoredBytes).toBe(
      4 * 3 * 10 + 16 * 2 * 10 - (24 + 16 + 16 * 4 + 16 * 3),
    );
    expect(layerBytes(s.doc)).toBe(written);
    expect(e.addedSaveBytes).toBe(SAVE_BYTES_PER_LAYER_BYTE * (written - layers));
  });

  it('keeps the groups and keys of an active object whose mesh another object uses too', () => {
    // the join gives A a mesh of its own (A2 keeps the shared one) and joins into it what A's mesh had
    const s = setup();
    s.doc.setVertexGroups(s.meshes.A, [s.group('OnlyA', [1, 0.5, 0.25])]);
    s.doc.setShapeKeys(s.meshes.A, [s.key('Up', [0, 0, 1, 1, 0, 1, 0, 1, 1], { value: 0.5 })]);
    s.doc.setVertexGroups(s.meshes.B, [s.group('OnlyB', [0.125, 0.25, 0.5, 1])]);
    const a2 = s.doc.addObject({ type: 'MESH', name: 'A2', data: s.meshes.A, location: [0, 0, -5] });
    s.ctx.state.selectedIds = [s.a, s.b];
    const e = s.estimate('object.join')!;
    s.run('object.join');
    const joined = s.doc.getObject(s.a)!.data!;
    expect(joined).not.toBe(s.meshes.A);
    expect(s.doc.meshCounts(joined)!.vertices).toBe(7);
    expect(s.groupsOf(joined)).toEqual([
      ['OnlyA', [1, 0.5, 0.25, 0, 0, 0, 0]],
      ['OnlyB', [0, 0, 0, 0.125, 0.25, 0.5, 1]],
    ]);
    const keys = s.keysOf(joined);
    expect(keys.map((k) => [k.name, k.value])).toEqual([['Up', 0.5]]);
    expectClose(keys[0].data, [0, 0, 1, 1, 0, 1, 0, 1, 1, ...B_JOINED]);
    // what the estimate counted is what the join wrote, and the other user keeps the shared mesh as it was
    expect(e.layers).toEqual({
      kind: 'vertex groups and shape keys',
      bytes: layerBytes(s.doc) - 4 * 3 - 12 * 3,
    });
    expect(s.doc.getObject(a2)!.data).toBe(s.meshes.A);
    expect(s.groupsOf(s.meshes.A)).toEqual([['OnlyA', [1, 0.5, 0.25]]]);
    expect(s.keysOf(s.meshes.A).map((k) => k.name)).toEqual(['Up']);
  });

  it('leaves out the keys of a joined mesh without vertices but keeps its groups, as Blender', () => {
    // meshtools.cc adds another mesh's vertex group names to the active one's for every mesh, and
    // merges its key blocks only inside `if (mesh->verts_num) {`
    const s = setup();
    const emptyMesh = s.doc.addMesh('E', createMesh({ positions: [], faces: [] }));
    s.doc.setShapeKeys(emptyMesh, [s.key('OnlyE', [])]);
    s.doc.setVertexGroups(emptyMesh, [s.group('GroupE', [])]);
    const e = s.doc.addObject({ type: 'MESH', name: 'E', data: emptyMesh });
    s.doc.setShapeKeys(s.meshes.C, [s.key('OnlyC', [0, 0, 1, 2, 0, 1, 0, 2, 1])]);
    s.ctx.state.selectedIds = [s.a, e, s.c];
    const est = s.estimate('object.join')!;
    s.run('object.join');
    expect(s.doc.listObjects().map((o) => o.name)).toEqual(['A', 'B']);
    expect(s.groupsOf(s.meshes.A)).toEqual([['GroupE', [0, 0, 0, 0, 0, 0]]]);
    expect(s.keysOf(s.meshes.A).map((k) => k.name)).toEqual(['OnlyC']);
    // a group and a key, each written for the 6 joined vertices
    expect(est.layers).toEqual({ kind: 'vertex groups and shape keys', bytes: 4 * 6 + 12 * 6 });
    // the active mesh keeps its keys without vertices (Blender joins into its key blocks)
    const t = setup();
    const emptyActive = t.doc.addMesh('E', createMesh({ positions: [], faces: [] }));
    t.doc.setShapeKeys(emptyActive, [t.key('OnlyE', [])]);
    const ea = t.doc.addObject({ type: 'MESH', name: 'E', data: emptyActive });
    Object.assign(t.ctx.state, { selectedIds: [ea, t.c], activeId: ea });
    // and its estimate counts that key, written for the 3 joined vertices
    expect(t.estimate('object.join')!.layers).toEqual({ kind: 'shape keys', bytes: 12 * 3 });
    t.run('object.join');
    const keys = t.keysOf(emptyActive);
    expect(keys.map((k) => k.name)).toEqual(['OnlyE']);
    expectClose(keys[0].data, C_JOINED);
  });
});
