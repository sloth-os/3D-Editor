import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HEAT_WEIGHTS_BYTES_PER_VERTEX,
  LAYER_OP_BYTES_PER_VERTEX,
  LAYER_WRITE_BYTES_PER_BYTE,
  OPERATOR_ESTIMATES,
  OPERATOR_FIXED_BYTES,
  SAVE_BYTES_PER_LAYER_BYTE,
  SHAPE_KEY_BYTES_PER_VERTEX,
  SHAPE_KEY_STORED_BYTES_PER_VERTEX,
  VERTEX_GROUP_BYTES_PER_VERTEX,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  layerBytes,
  meshLayerBytes,
  projectObjects,
  projectStoredBytes,
  setOperatorMemoryCheck,
  unestimatedReason,
  vertexGroupBytes,
  type OperatorMemoryRequest,
} from '../src/operators';
import { decodedMeshBytes } from '../src/mesh/memory';
import { SceneDoc } from '../src/doc/scene-doc';

/*
 * The estimates of operators that write the vertex groups or shape keys of meshes
 * (operators/memory-layers.ts): parenting to an armature with vertex groups, the vertex group and
 * shape key operators, renaming a bone, duplicating meshes that have them; and what a project keeps
 * and saves of them (memory-objects.ts).
 */

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => setOperatorMemoryCheck(null));

/** A grid of n × n quads ('Grid') and an armature ('Rig') of `bones` + 1 bones, both selected, the armature active. */
function rigged(n: number, bones: number) {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx = { doc, state, origin: { type: 'test' }, source: 'test' as const, report: () => undefined };
  const run = (id: string, params: object = {}) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r;
  };
  const estimate = (id: string, params: object = {}) =>
    estimateOperator(id, ctx, reg.parseParams(id, params));
  run('mesh.primitive_grid_add', { name: 'Grid', x_subdivisions: n, y_subdivisions: n, size: 10 });
  run('object.armature_add', { name: 'Rig' });
  const points = Array.from({ length: bones + 1 }, (_, i) => [-5 + (10 * i) / bones, 0, 0.5]);
  run('armature.chain_add', { object: 'Rig', points });
  const grid = doc.listObjects().find((o) => o.name === 'Grid')!;
  const rig = doc.listObjects().find((o) => o.name === 'Rig')!;
  const select = () => {
    state.selectedIds = [grid.id, rig.id];
    state.activeId = rig.id;
  };
  select();
  const vertices = doc.meshCounts(grid.data!)!.vertices;
  const decoded = decodedMeshBytes({ ...doc.meshCounts(grid.data!)!, uvs: true, colors: false });
  return { doc, reg, state, ctx, run, estimate, grid, rig, select, vertices, decoded };
}

/** What the project keeps and what its save takes (memory-objects.ts). */
const project = (doc: SceneDoc) => ({ kept: projectStoredBytes(doc), save: projectObjects(doc).save });

describe('parenting to an armature with vertex groups', () => {
  it('estimates a group per vertex and deforming bone of every child mesh, which the project then keeps and saves', () => {
    const s = rigged(20, 4);
    // 5 bones (the armature's own and a chain of 4), one of which does not deform
    s.run('armature.bone_update', { object: 'Rig', bone: 'Bone.002', use_deform: false });
    const v = s.vertices;
    const groups = 4 * VERTEX_GROUP_BYTES_PER_VERTEX * v;
    const e = s.estimate('object.parent_set', { type: 'ARMATURE_NAME' })!;
    expect(e).toMatchObject({
      bytes:
        OPERATOR_FIXED_BYTES +
        LAYER_WRITE_BYTES_PER_BYTE * groups +
        LAYER_OP_BYTES_PER_VERTEX * v +
        s.decoded,
      addedStoredBytes: groups,
      addedSaveBytes: SAVE_BYTES_PER_LAYER_BYTE * groups,
      layers: { kind: 'vertex groups', bytes: groups },
      lower:
        'the vertices of the child meshes or the number of deforming bones (type ARMATURE parents them without vertex groups)',
    });
    // ENVELOPE and AUTO compute the weights of every vertex first
    expect(s.estimate('object.parent_set', { type: 'ARMATURE_AUTO' })!.bytes - e.bytes).toBe(
      HEAT_WEIGHTS_BYTES_PER_VERTEX * v,
    );
    expect(s.estimate('object.parent_set', { type: 'ARMATURE_ENVELOPE' })!.bytes).toBeGreaterThan(e.bytes);
    // no vertex groups: an Armature modifier or bone parenting, a few hundred bytes per child
    for (const type of ['OBJECT', 'ARMATURE', 'BONE'])
      expect(s.estimate('object.parent_set', { type })).toBeNull();
    // parent_to names the children and the parent itself
    s.state.selectedIds = [];
    expect(
      s.estimate('object.parent_to', { objects: ['Grid'], parent: 'Rig', type: 'ARMATURE_NAME' })?.bytes,
    ).toBe(e.bytes);
    s.select();
    const before = project(s.doc);
    s.run('object.parent_set', { type: 'ARMATURE_NAME' });
    expect(vertexGroupBytes(s.doc, s.grid.data!)).toBe(groups);
    // what the project counts afterwards: the groups, and the Armature modifier's JSON (a few hundred bytes)
    const after = project(s.doc);
    expect(after.kept - before.kept).toBeGreaterThanOrEqual(e.addedStoredBytes);
    expect(after.kept - before.kept - e.addedStoredBytes).toBeLessThan(2_000);
    expect(after.save - before.save).toBeGreaterThanOrEqual(e.addedSaveBytes!);
    expect(after.save - before.save - e.addedSaveBytes!).toBeLessThan(6_000);
    // ARMATURE_NAME again adds no group, but writes them all again
    const again = s.estimate('object.parent_set', { type: 'ARMATURE_NAME' })!;
    expect(again.addedStoredBytes).toBe(0);
    expect(again.bytes).toBe(e.bytes);
  });

  it('counts a mesh its children share once, and not the armature itself', () => {
    const s = rigged(10, 2);
    const one = s.estimate('object.parent_set', { type: 'ARMATURE_NAME' })!;
    s.state.selectedIds = [s.grid.id];
    s.run('object.duplicate', { linked: true });
    const copy = s.state.selectedIds[0];
    s.state.selectedIds = [s.grid.id, copy, s.rig.id];
    s.state.activeId = s.rig.id;
    expect(s.estimate('object.parent_set', { type: 'ARMATURE_NAME' })).toEqual(one);
  });

  it('is refused before it writes a group when the check refuses it', () => {
    const s = rigged(20, 4);
    let asked: OperatorMemoryRequest | null = null;
    setOperatorMemoryCheck((req) => {
      asked = req;
      return 'too many vertex groups';
    });
    const r = s.reg.run(s.ctx, 'object.parent_set', { type: 'ARMATURE_AUTO' });
    expect(r).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY', error: 'too many vertex groups' });
    expect(asked!.operator).toBe('object.parent_set');
    expect(vertexGroupBytes(s.doc, s.grid.data!)).toBe(0);
    expect(s.doc.getObject(s.grid.id)!.parent).toBeFalsy();
  });
});

describe('the vertex group and shape key operators', () => {
  it('write every group or key of their mesh again, and keep what they add as the project counts it', () => {
    const s = rigged(20, 3);
    s.run('object.parent_set', { type: 'ARMATURE_NAME' });
    s.state.selectedIds = [s.grid.id];
    s.state.activeId = s.grid.id;
    const v = s.vertices;
    const groups = vertexGroupBytes(s.doc, s.grid.data!);
    expect(groups).toBe(4 * VERTEX_GROUP_BYTES_PER_VERTEX * v);
    const write = (bytes: number) =>
      OPERATOR_FIXED_BYTES + LAYER_WRITE_BYTES_PER_BYTE * bytes + LAYER_OP_BYTES_PER_VERTEX * v;
    for (const [id, params] of [
      ['object.vertex_group_rename', { group: 'Bone.001', name: 'Arm' }],
      ['object.vertex_group_normalize_all', {}],
      ['object.vertex_group_normalize', { group: 'Bone' }],
      ['object.vertex_group_remove_from', { group: 'Bone' }],
      ['object.vertex_group_remove', { group: 'Bone' }],
      ['object.vertex_group_assign', { group: 'Bone', weight: 0.5 }],
    ] as const)
      expect(s.estimate(id, params), id).toMatchObject({ bytes: write(groups), addedStoredBytes: 0 });
    // a new group: a weight per vertex more, kept and saved
    const g = VERTEX_GROUP_BYTES_PER_VERTEX * v;
    for (const [id, params] of [
      ['object.vertex_group_add', { name: 'Extra' }],
      ['object.vertex_group_assign', { group: 'Extra', weight: 0.5 }],
      ['object.vertex_group_set_weights', { group: 'Extra', weights: [] }],
    ] as const)
      expect(s.estimate(id, params), id).toMatchObject({
        bytes: write(groups + g),
        addedStoredBytes: g,
        addedSaveBytes: SAVE_BYTES_PER_LAYER_BYTE * g,
        layers: { kind: 'vertex groups', bytes: groups + g },
      });
    const before = project(s.doc);
    s.run('object.vertex_group_add', { name: 'Extra' });
    expect(project(s.doc)).toEqual({
      kept: before.kept + g,
      save: before.save + SAVE_BYTES_PER_LAYER_BYTE * g,
    });
    // shape keys: every key of the mesh, a position per vertex more for a new one
    const k = SHAPE_KEY_BYTES_PER_VERTEX * v;
    const add = s.estimate('object.shape_key_add', {})!;
    expect(add).toMatchObject({
      bytes: write(k) + s.decoded,
      addedStoredBytes: SHAPE_KEY_STORED_BYTES_PER_VERTEX * v,
      addedSaveBytes: SAVE_BYTES_PER_LAYER_BYTE * k,
      layers: { kind: 'shape keys', bytes: k },
      lower: 'the vertices of the mesh or the number of its shape keys',
    });
    const beforeKeys = project(s.doc);
    s.run('object.shape_key_add', { name: 'Up' });
    expect(project(s.doc)).toEqual({
      kept: beforeKeys.kept + add.addedStoredBytes,
      save: beforeKeys.save + add.addedSaveBytes!,
    });
    s.run('object.shape_key_add', { name: 'Down' });
    expect(s.estimate('object.shape_key_set', { key: 'Up', value: 0.5 })).toMatchObject({
      bytes: write(2 * k),
      addedStoredBytes: 0,
    });
    expect(s.estimate('object.shape_key_clear', {})!.bytes).toBe(write(2 * k));
    // these read the mesh too
    expect(
      s.estimate('object.shape_key_set_positions', { key: 'Up', offsets: [[0, 0, 1]], indices: [0] })!.bytes,
    ).toBe(write(2 * k) + s.decoded);
    expect(s.estimate('object.shape_key_remove', { all: true, apply_mix: true })!.bytes).toBe(
      write(2 * k) + s.decoded,
    );
    expect(s.estimate('object.shape_key_remove', { key: 'Up' })!.bytes).toBe(write(2 * k));
    // the groups and keys of the mesh, and their save (6 times their bytes)
    expect(meshLayerBytes(s.doc, s.grid.data!)).toBe(groups + g + 2 * k);
    expect(layerBytes(s.doc)).toBe(groups + g + 2 * k);
    expect(projectObjects(s.doc).layers).toBe(groups + g + 2 * k);
  });

  it('rename a bone: the groups of the meshes the armature deforms follow it', () => {
    const s = rigged(20, 3);
    expect(s.estimate('armature.bone_update', { object: 'Rig', bone: 'Bone.001', name: 'Arm' })).toBeNull();
    s.run('object.parent_set', { type: 'ARMATURE_NAME' });
    const groups = vertexGroupBytes(s.doc, s.grid.data!);
    expect(
      s.estimate('armature.bone_update', { object: 'Rig', bone: 'Bone.001', name: 'Arm' }),
    ).toMatchObject({
      bytes:
        OPERATOR_FIXED_BYTES + LAYER_WRITE_BYTES_PER_BYTE * groups + LAYER_OP_BYTES_PER_VERTEX * s.vertices,
      addedStoredBytes: 0,
      lower: 'the vertex groups of the meshes the armature deforms',
    });
    // other changes of a bone, and a bone no group is named after
    expect(s.estimate('armature.bone_update', { object: 'Rig', bone: 'Bone.001', roll: 1 })).toBeNull();
    expect(
      s.estimate('armature.bone_update', { object: 'Rig', bone: 'Bone.001', name: 'Bone.001' }),
    ).toBeNull();
    s.run('object.vertex_group_remove', { object: 'Grid', group: 'Bone.002' });
    expect(s.estimate('armature.bone_update', { object: 'Rig', bone: 'Bone.002', name: 'X' })).toBeNull();
  });

  it('are estimated, and listed as such', () => {
    for (const id of [
      'object.parent_set',
      'object.parent_to',
      'armature.bone_update',
      'object.vertex_group_add',
      'object.vertex_group_assign',
      'object.vertex_group_normalize',
      'object.vertex_group_normalize_all',
      'object.vertex_group_remove',
      'object.vertex_group_remove_from',
      'object.vertex_group_rename',
      'object.vertex_group_set_weights',
      'object.shape_key_add',
      'object.shape_key_clear',
      'object.shape_key_remove',
      'object.shape_key_set',
      'object.shape_key_set_positions',
    ]) {
      expect(OPERATOR_ESTIMATES[id], id).toBeDefined();
      expect(unestimatedReason(id), id).toBeNull();
    }
  });
});

describe('duplicating meshes with vertex groups and shape keys', () => {
  it('counts the groups and keys the copies get, as the project counts them afterwards', () => {
    const s = rigged(20, 3);
    s.run('object.parent_set', { type: 'ARMATURE_NAME' });
    s.state.selectedIds = [s.grid.id];
    s.state.activeId = s.grid.id;
    s.run('object.shape_key_add', { name: 'Up' });
    const layers = meshLayerBytes(s.doc, s.grid.data!);
    const e = s.estimate('object.duplicate', { linked: false })!;
    // the same objects (an Armature modifier, a parent), without groups and keys
    const plain = rigged(20, 3);
    plain.run('object.parent_set', { type: 'ARMATURE' });
    plain.state.selectedIds = [plain.grid.id];
    plain.state.activeId = plain.grid.id;
    const without = plain.estimate('object.duplicate', { linked: false })!;
    expect(e.bytes - without.bytes).toBe(LAYER_WRITE_BYTES_PER_BYTE * layers);
    const before = project(s.doc);
    s.run('object.duplicate', { linked: false });
    const after = project(s.doc);
    expect(after.kept - before.kept).toBeCloseTo(e.addedStoredBytes, -4);
    expect(after.save - before.save).toBeCloseTo(e.addedSaveBytes!, -4);
    expect(e.addedSaveBytes! - without.addedSaveBytes!).toBe(SAVE_BYTES_PER_LAYER_BYTE * layers);
  });
});

/**
 * Runs object.parent_set with `type` in a child process (operator-memory-rss-child.ts) on a grid of
 * n × n quads parented to an armature of `bones` + 1 bones: its estimate and its peak resident memory
 * (bytes; -1 where the process cannot reset its peak, outside Linux).
 */
function peak(n: number, bones: number, type: string) {
  const run = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=2048',
      '--import',
      'tsx',
      path.join(here, 'operator-memory-rss-child.ts'),
      'parent',
      String(n),
      String(bones),
      type,
    ],
    {
      encoding: 'utf8',
      cwd: here,
      timeout: 25_000,
      env: { ...process.env, MALLOC_MMAP_THRESHOLD_: '131072' },
    },
  );
  const line = run.stdout.split('\n').find((l) => l.startsWith('{'));
  expect(line, run.stderr).toBeDefined();
  return JSON.parse(line!) as { estimate: number; written: number; peak: number };
}

describe('the estimates of vertex group writes hold', () => {
  it('above the peak resident memory of ARMATURE_NAME on 40,401 vertices with 121 bones (child process)', () => {
    // 19.6 MB of weights; every write peaked at 5.0–6.3 times what it wrote with the server's listeners
    const r = peak(200, 120, 'ARMATURE_NAME');
    expect(r.written).toBe(121 * 4 * 201 * 201);
    if (r.peak < 0) return;
    expect(r.estimate).toBeGreaterThanOrEqual(1.1 * r.peak);
    expect(r.estimate).toBeLessThan(4 * r.peak);
  }, 30_000);

  it('above the peak resident memory of ARMATURE_AUTO on 40,401 vertices with 5 bones (child process)', () => {
    // the bone heat of every vertex takes most of it
    const r = peak(200, 4, 'ARMATURE_AUTO');
    if (r.peak < 0) return;
    expect(r.estimate).toBeGreaterThanOrEqual(1.1 * r.peak);
    expect(r.estimate).toBeLessThan(4 * r.peak);
  }, 30_000);
});
