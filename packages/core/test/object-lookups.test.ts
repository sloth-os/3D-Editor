import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  FrameState,
  SceneDoc,
  createCube,
  createEditorState,
  createOperatorRegistry,
  type MeshData,
  shownWorld,
  type OperatorContext,
} from '../src';

/*
 * Apply Transform, Set Origin and Convert change many objects one after another. They read the
 * objects' children and data users once for all of them (SceneDoc.childrenIndex and
 * dataUserCounts, kept current as objects get data of their own): looking them up again for each
 * object (SceneDoc.childrenOf and dataUsers read every object) made N objects take time in N²
 * (Apply Transform on 2,000 linked cubes took 36 s, during which the server answered nothing). The
 * results must be those of the lookups made one by one, which the reference below makes again.
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

/** A cube moved off its origin, so that Set Origin moves the origin. */
function cube(dx: number, dy: number, dz: number): MeshData {
  const m = createCube();
  for (let i = 0; i < m.positions.length; i += 3) {
    m.positions[i] += dx;
    m.positions[i + 1] += dy;
    m.positions[i + 2] += dz;
  }
  return m;
}

/**
 * Parents and children (selected or not, over three levels, under an animated object), a mesh used
 * by four objects, two of them with a modifier, meshes of their own, two curve objects sharing their
 * curve, the second a child of the first, and a text object.
 */
function mixedScene(): SceneDoc {
  const doc = SceneDoc.create({ name: 'Mixed', empty: true });
  const ctx = context(doc);
  const shared = doc.addMesh('Shared', cube(0.5, -0.25, 1));
  const solidify = (id: string) =>
    [{ id, name: 'Solidify', type: 'SOLIDIFY', show_viewport: true, show_render: true, params: {} }] as never;
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
    data: doc.addMesh('OwnA', cube(-1, 0, 0.5)),
    location: [0, 1, 0],
    scale: [1.5, 1, 1],
  });
  add('a1', {
    type: 'MESH',
    name: 'A1',
    parent: 'a',
    data: shared,
    rotation_euler: [0, 0.4, 0],
    scale: [2, 2, 2],
  });
  add('b', {
    type: 'MESH',
    name: 'B',
    data: shared,
    location: [4, 0, 0],
    scale: [1, 3, 1],
    modifiers: solidify('s1'),
  });
  add('b1', { type: 'EMPTY', name: 'B1', parent: 'b', location: [0, 0, 2] });
  add('c', {
    type: 'MESH',
    name: 'C',
    data: shared,
    location: [-3, 0, 0],
    rotation_euler: [0, 0, 1],
    modifiers: solidify('s2'),
  });
  add('d', { type: 'MESH', name: 'D', parent: 'b1', data: shared, location: [1, 1, 1] });
  // b moves: the scene shows it elsewhere than its stored location at frame 12
  doc.setFCurve({
    target_type: 'object',
    target_id: 'b',
    path: 'location',
    index: 0,
    keyframes: [
      { frame: 1, value: 4, interpolation: 'LINEAR' },
      { frame: 20, value: 9, interpolation: 'LINEAR' },
    ],
    extrapolation: 'CONSTANT',
    mute: false,
  });
  const path = reg.run(ctx, 'curve.primitive_nurbs_path_add', {
    name: 'Cv1',
    location: [0, -2, 1],
    rotation: [0, 0, 0.5],
    scale: [1, 2, 1],
  });
  expect(path.ok, path.error).toBe(true);
  const cv1 = doc.findObjectByName('Cv1')!;
  add('cv2', { type: 'CURVE', name: 'Cv2', parent: cv1.id, data: cv1.data, location: [0, 1, 0] });
  const text = reg.run(ctx, 'object.text_add', { name: 'Txt', body: 'Hi', scale: [2, 2, 2] });
  expect(text.ok, text.error).toBe(true);
  return doc;
}

/** Ids from a seeded generator, so that two runs that make the same datablocks give them the same ids. */
function seededIds(): void {
  let s = 12345;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      bytes[i] = s >>> 24;
    }
    return bytes;
  }) as never);
}

/**
 * Makes `doc`'s operators look the children and data users up in the document each time they ask
 * for them, as they did one object after another before (the reference).
 */
function lookUpEachTime(doc: SceneDoc): void {
  vi.spyOn(doc, 'childrenIndex').mockImplementation(
    () => ({ get: (id: string | null) => doc.childrenOf(id).map((c) => c.id) }) as never,
  );
  vi.spyOn(doc, 'dataUserCounts').mockImplementation(() => {
    const users = { get: (id: string) => doc.dataUsers(id), set: () => users };
    return users as never;
  });
}

/** Where the scene shows each object at `frame` (world matrices by object name). */
function worlds(doc: SceneDoc, frame: number): Map<string, number[]> {
  const fs = new FrameState(doc, frame);
  return new Map(doc.listObjects().map((o) => [o.name, shownWorld(fs, o.id)]));
}

/** Everything the document holds, for comparison (the snapshot leaves out its metadata dates). */
const state = (doc: SceneDoc) => {
  const { meta: _meta, ...rest } = doc.toSnapshot();
  return rest;
};

const run = (doc: SceneDoc, frame: number, selection: string[], operator: string, params: object) => {
  const ctx = context(doc, frame);
  ctx.state.cursorLocation = [1, 0.5, -2];
  ctx.state.selectedIds = selection.map((n) => doc.findObjectByName(n)!.id);
  ctx.state.activeId = ctx.state.selectedIds[0];
  const reports: string[] = [];
  ctx.report = (level, message) => void reports.push(`${level}: ${message}`);
  seededIds();
  const r = reg.run(ctx, operator, params);
  vi.restoreAllMocks();
  return { ok: r.ok, error: r.error, result: r.result, reports, selected: ctx.state.selectedIds };
};

const SELECTIONS = [
  ['Root', 'A', 'A1', 'B', 'B1', 'C', 'D', 'Cv1', 'Cv2', 'Txt'],
  ['D', 'A1', 'A', 'Root', 'B1', 'B', 'Cv2', 'Cv1'],
  ['B', 'C', 'Cv1', 'Txt'],
  ['A1', 'D', 'C', 'Cv2'],
];

const OPERATORS: [string, object][] = [
  ['object.transform_apply', { location: true, rotation: true, scale: true }],
  ['object.transform_apply', {}],
  ['object.origin_set', { type: 'ORIGIN_CURSOR' }],
  ['object.origin_set', { type: 'ORIGIN_GEOMETRY', center: 'BOUNDS' }],
  ['object.convert', { target: 'MESH' }],
  ['object.convert', { target: 'MESH', keep_original: true }],
];

describe('operators that change many objects', () => {
  it('leave the document the lookups made one by one left', () => {
    let changed = 0;
    for (const [operator, params] of OPERATORS)
      for (const selection of SELECTIONS)
        for (const frame of [1, 12]) {
          const base = mixedScene();
          const reference = copy(base);
          lookUpEachTime(reference);
          const expected = run(reference, frame, selection, operator, params);
          const doc = copy(base);
          const got = run(doc, frame, selection, operator, params);
          const label = `${operator} ${JSON.stringify(params)} [${selection.join(',')}] @${frame}`;
          expect(got, label).toEqual(expected);
          expect(state(doc), label).toEqual(state(reference));
          if (JSON.stringify(state(doc)) !== JSON.stringify(state(base))) changed++;
          // Apply and Set Origin keep where the other objects show, their children too
          if (operator === 'object.convert') continue;
          const shown = worlds(base, frame);
          for (const [name, world] of worlds(doc, frame))
            if (!selection.includes(name))
              world.forEach((v, i) => expect(v, `${label}: ${name}`).toBeCloseTo(shown.get(name)![i], 9));
        }
    // every case changed the document (made meshes their own, moved origins, converted)
    expect(changed).toBe(OPERATORS.length * SELECTIONS.length * 2);
    // what the lookups found: Apply gave each user of the shared mesh and curve data of its own (the
    // last one kept it), Convert copied the shared mesh for the two objects with a modifier, made a
    // mesh of each curve and text object and dropped the curve no object used any more
    const doc = mixedScene();
    const r = run(doc, 1, SELECTIONS[0], 'object.transform_apply', {});
    expect(r.ok, r.error).toBe(true);
    const users = doc
      .listObjects()
      .filter((o) => o.data)
      .map((o) => o.data);
    expect(new Set(users).size).toBe(users.length);
    const converted = mixedScene();
    expect(run(converted, 1, SELECTIONS[0], 'object.convert', { target: 'MESH' }).ok).toBe(true);
    expect(converted.listCurves()).toEqual([]);
    expect(converted.listMeshBlocks().length).toBe(2 + 2 + 3);
  });

  it('read the children and data users once, however many objects they change', () => {
    const calls = (n: number, operator: string, params: object): Record<string, number> => {
      const doc = SceneDoc.create({ empty: true });
      const ctx = context(doc);
      // linked cubes for Apply and Set Origin, curves of their own for Convert
      const curves = operator === 'object.convert';
      const first = curves
        ? reg.run(ctx, 'curve.primitive_bezier_circle_add', { name: 'Item' })
        : reg.run(ctx, 'mesh.primitive_cube_add', { name: 'Item', scale: [2, 1, 1] });
      expect(first.ok, first.error).toBe(true);
      const placed = reg.run(ctx, 'object.array_place', {
        objects: ['Item'],
        linked: !curves,
        count: n,
        offset: [3, 0, 0],
      });
      expect(placed.ok, placed.error).toBe(true);
      ctx.state.selectedIds = doc.objectIds();
      ctx.state.activeId = ctx.state.selectedIds[0];
      ctx.state.cursorLocation = [0, 1, 0];
      const counted = ['listObjects', 'childrenOf', 'dataUsers'] as const;
      const spies = counted.map((m) => vi.spyOn(SceneDoc.prototype, m));
      const r = reg.run(ctx, operator, params);
      expect(r.ok, r.error).toBe(true);
      const out = Object.fromEntries(counted.map((m, i) => [m, spies[i].mock.calls.length]));
      vi.restoreAllMocks();
      // every object changed: the linked cubes got meshes of their own, the curves became meshes
      expect(new Set(doc.listObjects().map((o) => o.data)).size, operator).toBe(n);
      return out;
    };
    for (const [operator, params] of [
      ['object.transform_apply', { scale: true }],
      ['object.origin_set', { type: 'ORIGIN_CURSOR' }],
      ['object.convert', { target: 'MESH' }],
    ] as const) {
      const few = calls(10, operator, params);
      // (one by one, each object listed the scene's objects to find its children and data users)
      expect(calls(60, operator, params), operator).toEqual(few);
      expect(few.childrenOf + few.dataUsers, operator).toBe(0);
    }
  });

  it('count the users of every data value as dataUsers does, also values a malformed document holds', () => {
    const doc = SceneDoc.create({ empty: true });
    const shared = doc.addMesh('Shared', createCube({ size: 1 }));
    const own = doc.addMesh('Own', createCube({ size: 1 }));
    doc.transact(() => {
      for (let i = 0; i < 3; i++) doc.addObject({ type: 'MESH', name: `Linked.${i}`, data: shared });
      doc.addObject({ type: 'MESH', name: 'Single', data: own });
      doc.addObject({ type: 'EMPTY', name: 'Empty' });
      doc.addObject({ type: 'MESH', name: 'Gone', data: 'no-such-mesh' });
    });
    // a client can write any value in an object's data (sync updates are not checked field by field)
    const objects = doc.ydoc.getMap('objects');
    doc.transact(() => {
      for (const name of ['Odd.0', 'Odd.1']) {
        const y = objects.get(doc.findObjectByName('Linked.0')!.id) as Y.Map<unknown>;
        const copy = new Y.Map<unknown>();
        for (const [k, v] of y.entries()) copy.set(k, k === 'name' ? name : k === 'data' ? 5 : v);
        objects.set(`id-${name}`, copy);
      }
    });
    const counts = doc.dataUserCounts();
    for (const data of [shared, own, 'no-such-mesh', 5 as unknown as string, 'unused'])
      expect(counts.get(data) ?? 0, String(data)).toBe(doc.dataUsers(data));
    expect(counts.get(shared)).toBe(3);
    expect(counts.get(5 as unknown as string)).toBe(2);
  });
});
