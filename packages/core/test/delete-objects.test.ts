import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  FrameState,
  SceneDoc,
  createCube,
  createEditorState,
  createOperatorRegistry,
  dataKindOf,
  fcurveKey,
  shownWorld,
  type ConstraintData,
  type OperatorContext,
} from '../src';

/*
 * Deleting objects (object.delete, object.join, SceneDoc.removeObjects) handles all of them in one
 * pass over the document. Removing them one by one looked up every object, animation curve,
 * driver and data user again for each, so deleting N objects took time in N² (1,000 linked cubes:
 * 4–6 s, during which the server answered nothing). The results must be those of the one-by-one
 * path, kept below as it was.
 */

const reg = createOperatorRegistry();

afterEach(() => vi.restoreAllMocks());

function context(doc: SceneDoc, frame = 1): OperatorContext {
  return { doc, state: createEditorState({ frame }), origin: doc.origin, source: 'test', report: () => {} };
}

/** A copy of `doc` (same ids and values), in a document of its own. */
function copy(doc: SceneDoc): SceneDoc {
  const y = new Y.Doc();
  Y.applyUpdate(y, Y.encodeStateAsUpdate(doc.ydoc));
  return new SceneDoc(y);
}

const constraint = (id: string, type: ConstraintData['type'], target: string): ConstraintData => ({
  id,
  name: id,
  type,
  mute: false,
  influence: 1,
  target,
  subtarget: '',
  show_expanded: true,
  params: {},
});

/**
 * Parents and children over three levels (an animated, rotated and scaled root), meshes shared by
 * several objects and meshes of their own, F-curves and drivers on the objects and on their data,
 * drivers, constraints and modifiers that read objects that are deleted, a collection, and the scene
 * camera among the deleted objects.
 */
function mixedScene(): SceneDoc {
  const doc = SceneDoc.create({ name: 'Mixed', empty: true });
  const shared = doc.addMesh('Shared', createCube());
  const coll = doc.addCollection({ name: 'Props' });
  const add = (id: string, init: Parameters<SceneDoc['addObject']>[0]) => doc.addObject(init, id);
  add('root', {
    type: 'EMPTY',
    name: 'Root',
    location: [1, 2, 3],
    rotation_euler: [0.3, -0.2, 0.9],
    scale: [2, 1, 0.5],
  });
  add('a', {
    type: 'MESH',
    name: 'A',
    parent: 'root',
    data: doc.addMesh('OwnA', createCube()),
    location: [0, 1, 0],
  });
  add('a1', { type: 'MESH', name: 'A1', parent: 'a', data: shared, rotation_euler: [0, 0.4, 0] });
  add('a2', { type: 'MESH', name: 'A2', parent: 'a1', data: shared, scale: [1, 3, 1], collection: coll });
  add('b', { type: 'MESH', name: 'B', parent: 'root', data: shared, location: [4, 0, 0] });
  add('b1', { type: 'EMPTY', name: 'B1', parent: 'b', location: [0, 0, 2] });
  add('c', {
    type: 'MESH',
    name: 'C',
    data: doc.addMesh('OwnC', createCube()),
    constraints: [constraint('k1', 'COPY_LOCATION', 'b')],
    modifiers: [
      {
        id: 'm1',
        name: 'Array',
        type: 'ARRAY',
        show_viewport: true,
        show_render: true,
        params: { offset_object: 'a' },
      },
    ] as never,
  });
  add('cam', { type: 'CAMERA', name: 'Cam', parent: 'b1', data: doc.addCamera({ name: 'CamData' }) });
  doc.updateScene({ camera: 'cam' });
  // animation: the root moves (where the scene shows it differs from its stored values), the
  // deleted objects and their data have curves and drivers, and other objects' drivers read them
  for (const [target, index] of [
    ['root', 0],
    ['a', 2],
    ['b1', 1],
  ] as const)
    doc.setFCurve({
      target_type: 'object',
      target_id: target,
      path: 'location',
      index,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 20, value: 5, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
  doc.setDriver({
    target_type: 'object',
    target_id: 'a1',
    path: 'rotation_euler',
    index: 2,
    expression: 'frame * 0.1',
    variables: [],
    mute: false,
  });
  doc.setDriver({
    target_type: 'object',
    target_id: 'c',
    path: 'location',
    index: 1,
    expression: 'v',
    variables: [{ name: 'v', target_type: 'object', target_id: 'b', path: 'location', index: 0 }],
    mute: false,
  });
  return doc;
}

/** The one-by-one removal of SceneDoc.removeObject as it was (the reference). */
function removeOneByOne(doc: SceneDoc, id: string): void {
  const o = doc.getObject(id);
  if (!o) return;
  doc.transact(() => {
    for (const child of doc.childrenOf(id)) doc.setParent(child.id, o.parent, true);
    doc.map('objects').delete(id);
    for (const fc of doc.listFCurves(id)) doc.map('fcurves').delete(fcurveKey(fc));
    if (o.data && doc.dataUsers(o.data) === 0) {
      const kind = dataKindOf(o.type);
      if (kind) doc.map(kind).delete(o.data);
    }
    for (const d of doc.listDrivers(id)) doc.map('drivers').delete(fcurveKey(d));
    if (doc.getScene().camera === id) doc.updateScene({ camera: null });
  });
}

/** object.delete as it was: one object after another, children kept where the scene shows them. */
function deleteOneByOne(doc: SceneDoc, ids: readonly string[], frame: number): void {
  const fs = new FrameState(doc, frame);
  doc.transact(() => {
    for (const id of ids) {
      const o = doc.getObject(id);
      if (!o) continue;
      const parent = o.parent && o.parent !== id && doc.getObject(o.parent) ? o.parent : null;
      for (const child of doc.childrenOf(id)) {
        const evaluated = {
          world: shownWorld(fs, child.id),
          parentWorld: parent ? shownWorld(fs, parent) : null,
        };
        doc.setParent(child.id, parent, true, evaluated);
      }
      removeOneByOne(doc, id);
    }
  });
}

/** Everything the document holds, for comparison (the snapshot leaves out its metadata dates). */
const state = (doc: SceneDoc) => {
  const { meta: _meta, ...rest } = doc.toSnapshot();
  return rest;
};

const ORDERS: string[][] = [
  ['a', 'a1', 'b'],
  ['a2', 'a1', 'a'],
  ['b', 'root', 'cam', 'a1'],
  ['root', 'a', 'b', 'a2', 'b1'],
  ['b1', 'b', 'b1', 'c'],
  ['a1', 'a2', 'a', 'b', 'b1', 'cam', 'c', 'root'],
];

describe('deleting objects in one pass', () => {
  it('object.delete leaves the document the one-by-one path left, in any order', () => {
    for (const ids of ORDERS)
      for (const frame of [1, 12]) {
        const base = mixedScene();
        const reference = copy(base);
        deleteOneByOne(reference, ids, frame);
        const doc = copy(base);
        const ctx = context(doc, frame);
        ctx.state.selectedIds = ['c', ...ids];
        ctx.state.activeId = ids[0];
        const r = reg.run(ctx, 'object.delete', { objects: ids });
        expect(r.ok, r.error).toBe(true);
        expect(state(doc), `${ids.join(',')} @${frame}`).toEqual(state(reference));
        // the deleted objects left the selection, the active one with them
        expect(ctx.state.selectedIds).toEqual(ids.includes('c') ? [] : ['c']);
        expect(ctx.state.activeId).toBeNull();
      }
    // what the scene keeps: unused data removed, shared data kept while an object uses it
    const doc = copy(mixedScene());
    expect(reg.run(context(doc), 'object.delete', { objects: ['a', 'a1', 'b', 'cam'] }).ok).toBe(true);
    expect(doc.getObject('a2')!.parent).toBe('root');
    expect(doc.getObject('b1')!.parent).toBe('root');
    expect(doc.listMeshBlocks().map((m) => m.name)).toEqual(['OwnC', 'Shared']);
    expect(doc.getScene().camera).toBeNull();
    expect(doc.listFCurves().map((fc) => fc.target_id)).toEqual(['root', 'b1']);
    expect(doc.listDrivers().map((d) => d.target_id)).toEqual(['c']);
  });

  it('SceneDoc.removeObjects leaves the document removeObject one by one left', () => {
    for (const ids of ORDERS) {
      const base = mixedScene();
      const reference = copy(base);
      for (const id of ids) removeOneByOne(reference, id);
      const doc = copy(base);
      doc.removeObjects(ids);
      expect(state(doc), ids.join(',')).toEqual(state(reference));
      // and removeObject removes one the same way
      const single = copy(base);
      const one = copy(base);
      single.removeObject(ids[0]);
      removeOneByOne(one, ids[0]);
      expect(state(single)).toEqual(state(one));
    }
  });

  it('looks the scene up once, however many objects object.delete and object.join remove', () => {
    const calls = (n: number, operator: string): Record<string, number> => {
      const doc = SceneDoc.create({ empty: true });
      const ctx = context(doc);
      expect(reg.run(ctx, 'mesh.primitive_cube_add', { name: 'Cube' }).ok).toBe(true);
      const linked = operator === 'object.delete';
      expect(
        reg.run(ctx, 'object.array_place', { objects: ['Cube'], linked, count: n, offset: [3, 0, 0] }).ok,
      ).toBe(true);
      // a parent for every other object, so that children are re-parented as their parents go
      const ids = doc.objectIds();
      for (let i = 1; i < ids.length; i += 2) doc.updateObject(ids[i], { parent: ids[i - 1] });
      ctx.state.selectedIds = ids;
      ctx.state.activeId = ids[0];
      const counted = ['listObjects', 'listFCurves', 'listDrivers', 'dataUsers', 'childrenOf'] as const;
      const spies = counted.map((m) => vi.spyOn(SceneDoc.prototype, m));
      const r = reg.run(ctx, operator, {});
      expect(r.ok, r.error).toBe(true);
      const out = Object.fromEntries(counted.map((m, i) => [m, spies[i].mock.calls.length]));
      vi.restoreAllMocks();
      return out;
    };
    for (const operator of ['object.delete', 'object.join']) {
      const few = calls(10, operator);
      // (one by one, each object listed the scene's objects twice, its curves, drivers and data users)
      expect(calls(60, operator), operator).toEqual(few);
    }
  });
});
