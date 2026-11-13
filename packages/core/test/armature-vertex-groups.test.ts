import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { decodeFloat32 } from '../src/mesh/shape-keys';
import { createMesh } from '../src/mesh/types';
import { selectionFromVerts } from '../src/mesh/selection';

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
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const err = (id: string, params?: unknown) => {
    const r = run(id, params);
    expect(r.ok, `${id} should fail`).toBe(false);
    return r.error as string;
  };
  // a strip of 4 vertices along +Z
  const meshId = doc.addMesh(
    'Strip',
    createMesh({
      positions: [0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3],
      faces: [],
      looseEdges: [0, 1, 1, 2, 2, 3],
    }),
  );
  const obj = doc.addObject({ type: 'MESH', name: 'Strip', data: meshId });
  ctx.state.activeId = obj;
  ctx.state.selectedIds = [obj];
  const names = () => doc.getVertexGroups(meshId).map((g) => g.name);
  const weights = (name: string) =>
    Array.from(decodeFloat32(doc.getVertexGroups(meshId).find((g) => g.name === name)!.weights)).map(
      (x) => Math.round(x * 1e6) / 1e6,
    );
  return { doc, ctx, run, ok, err, meshId, obj, names, weights };
}

describe('vertex group operators', () => {
  it('adds unique groups and assigns weights by index, selection or to all vertices', () => {
    const { ok, err, ctx, doc, meshId, names, weights } = setup();
    expect(ok('object.vertex_group_add', {})).toMatchObject({ group: 'Group', index: 0 });
    expect(ok('object.vertex_group_add', {}).group).toBe('Group.001');
    expect(weights('Group')).toEqual([0, 0, 0, 0]);
    expect(ok('object.vertex_group_assign', { group: 'Group', indices: [1, 2], weight: 0.5 }).assigned).toBe(
      2,
    );
    expect(weights('Group')).toEqual([0, 0.5, 0.5, 0]);
    ok('object.vertex_group_assign', { group: 'Group', indices: [2, 3], weight: 0.75, type: 'ADD' });
    expect(weights('Group')).toEqual([0, 0.5, 1, 0.75]);
    ok('object.vertex_group_assign', { group: 'Group', indices: [1, 3], weight: 0.6, type: 'SUBTRACT' });
    expect(weights('Group')).toEqual([0, 0, 1, 0.15]);
    // a missing group is created; no indices = every vertex
    ok('object.vertex_group_assign', { group: 'Body' });
    expect(names()).toEqual(['Group', 'Group.001', 'Body']);
    expect(weights('Body')).toEqual([1, 1, 1, 1]);
    // in edit mode, the selected vertices are used
    ctx.state.mode = 'EDIT';
    ctx.state.meshSelection = selectionFromVerts(doc.getMesh(meshId)!, [0]);
    ok('object.vertex_group_remove_from', { group: 'Body' });
    expect(weights('Body')).toEqual([0, 1, 1, 1]);
    ctx.state.mode = 'OBJECT';
    expect(err('object.vertex_group_assign', { group: 'Body', indices: [9] })).toMatch(/out of range/);
    expect(err('object.vertex_group_remove_from', { group: 'Nope' })).toMatch(/'Nope' not found.*'Body'/);
  });

  it('sets weights densely or sparsely and validates the sizes', () => {
    const { ok, err, weights } = setup();
    ok('object.vertex_group_set_weights', { group: 'G', weights: [0.1, 0.2, 0.3, 0.4] });
    expect(weights('G')).toEqual([0.1, 0.2, 0.3, 0.4]);
    ok('object.vertex_group_set_weights', { group: 'G', indices: [0, 3], weights: [1, 0] });
    expect(weights('G')).toEqual([1, 0.2, 0.3, 0]);
    expect(err('object.vertex_group_set_weights', { group: 'G', weights: [1, 1] })).toMatch(/4 vertices/);
    expect(err('object.vertex_group_set_weights', { group: 'G', indices: [0], weights: [1, 1] })).toMatch(
      /same length/,
    );
    expect(err('object.vertex_group_set_weights', { group: 'G', weights: [2, 0, 0, 0] })).toMatch(/weights/);
  });

  it('normalizes all groups (optionally only deform groups, keeping locked groups)', () => {
    const { ok, doc, obj, weights } = setup();
    ok('object.vertex_group_set_weights', { group: 'A', weights: [1, 0.5, 0, 0] });
    ok('object.vertex_group_set_weights', { group: 'B', weights: [1, 0.5, 0.25, 0] });
    ok('object.vertex_group_set_weights', { group: 'Mask', weights: [0.5, 0.5, 0.5, 0.5] });
    expect(ok('object.vertex_group_normalize_all', { locked: ['Mask'] }).normalized).toBe(3);
    expect(weights('Mask')).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(weights('A')).toEqual([0.25, 0.25, 0, 0]);
    expect(weights('B')).toEqual([0.25, 0.25, 0.5, 0]);
    // BONE_DEFORM: only groups named like deform bones of the deforming armature take part
    const arm = doc.addArmature({
      name: 'Rig',
      bones: [
        {
          name: 'A',
          parent: null,
          head: [0, 0, 0],
          tail: [0, 0, 1],
          roll: 0,
          use_connect: false,
          use_deform: true,
          envelope_distance: 0.25,
          envelope_weight: 1,
          head_radius: 0.1,
          tail_radius: 0.05,
        },
        {
          name: 'B',
          parent: null,
          head: [0, 0, 1],
          tail: [0, 0, 2],
          roll: 0,
          use_connect: false,
          use_deform: true,
          envelope_distance: 0.25,
          envelope_weight: 1,
          head_radius: 0.1,
          tail_radius: 0.05,
        },
      ],
    });
    const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: arm });
    ok('object.modifier_add', { object: obj, type: 'ARMATURE', params: { object: 'Rig' } });
    void rig;
    const r = ok('object.vertex_group_normalize_all', { group_select_mode: 'BONE_DEFORM' });
    expect(r.groups).toEqual(['A', 'B']);
    expect(weights('A')).toEqual([0.5, 0.5, 0, 0]);
    expect(weights('B')).toEqual([0.5, 0.5, 1, 0]);
    expect(weights('Mask')).toEqual([0.5, 0.5, 0.5, 0.5]);
    // single group: largest weight becomes 1
    ok('object.vertex_group_normalize', { group: 'Mask' });
    expect(weights('Mask')).toEqual([1, 1, 1, 1]);
  });

  it('renames (updating modifier references) and removes groups', () => {
    const { ok, err, doc, obj, names } = setup();
    ok('object.vertex_group_add', { name: 'Mask' });
    ok('object.vertex_group_add', { name: 'Other' });
    ok('object.modifier_add', { object: obj, type: 'ARMATURE', params: { vertex_group: 'Mask' } });
    expect(ok('object.vertex_group_rename', { group: 'Mask', name: 'Other' }).group).toBe('Other.001');
    expect(doc.getObject(obj)!.modifiers[0].params.vertex_group).toBe('Other.001');
    expect(ok('object.vertex_group_remove', { group: 'Other' }).removed).toEqual(['Other']);
    expect(names()).toEqual(['Other.001']);
    expect(ok('object.vertex_group_remove', { all: true }).removed).toEqual(['Other.001']);
    expect(names()).toEqual([]);
    expect(err('object.vertex_group_remove', {})).toMatch(/Pass `group`/);
    doc.addObject({ type: 'EMPTY', name: 'E' });
    expect(err('object.vertex_group_add', { object: 'E' })).toMatch(/need a mesh/);
  });

  it('drives the Armature modifier and is undoable', () => {
    const { ok, doc, obj, names } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    ok('object.armature_add', { name: 'Rig', bone_name: 'Lift', location: [0, 0, 0] });
    ok('object.modifier_add', { object: 'Strip', type: 'ARMATURE', params: { object: 'Rig' } });
    ok('object.vertex_group_set_weights', {
      object: 'Strip',
      group: 'Lift',
      indices: [2, 3],
      weights: [0.5, 1],
    });
    ok('pose.bone_transform_set', { object: 'Rig', bone: 'Lift', location: [0, 1, 0] }); // bone Y = world +Z
    const pos = new SceneEvaluator(doc).evaluate(1).byId.get(obj)!.mesh!.positions;
    expect(pos).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 4]);
    um.undo();
    um.undo();
    expect(names()).toEqual([]);
    um.redo();
    expect(names()).toEqual(['Lift']);
  });
});
