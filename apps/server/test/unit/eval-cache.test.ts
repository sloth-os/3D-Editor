import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROOT_COLLECTION_ID,
  SceneDoc,
  SceneEvaluator,
  createCube,
  createFCurve,
  createMesh,
  createOperatorRegistry,
  createEditorState,
  defaultSpline,
  defaultSplinePoint,
  encodeFloat32,
  insertKeyframe,
} from '@3d-editor/core';
import { evaluateCached, evaluationStats, MAX_CACHED_EVALUATIONS } from '../../src/mcp/eval-cache';
import { describeObject, summarizeScene } from '../../src/mcp/scene-summary';

/*
 * get_object / get_scene re-evaluated the whole scene on every call (clockwork-orrery v2 #2:
 * ~120 ms per call, so checking motion over many frames took 15–30 s). Evaluations are cached per
 * document state, frame and mode now, with persistent evaluators per document.
 */

const registry = createOperatorRegistry();

function scene(): SceneDoc {
  const doc = SceneDoc.create({ name: 'Cache' });
  const ctx = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  } as Parameters<typeof registry.run>[0];
  const cube = doc.listObjects().find((o) => o.name === 'Cube')!;
  ctx.state.selectedIds = [cube.id];
  ctx.state.activeId = cube.id;
  expect(registry.run(ctx, 'object.modifier_add', { type: 'SUBSURF' }).ok).toBe(true);
  return doc;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evaluation cache', () => {
  it('evaluates a document state once per frame and mode', () => {
    const doc = scene();
    const spy = vi.spyOn(SceneEvaluator.prototype, 'evaluate');
    const a = evaluateCached(doc, 1, 'RENDER');
    expect(evaluateCached(doc, 1, 'RENDER')).toBe(a);
    expect(evaluateCached(doc, 1, 'VIEWPORT')).not.toBe(a);
    expect(evaluateCached(doc, 2, 'RENDER')).not.toBe(a);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[1]?.forRender)).toEqual([true, false, true]);
  });

  it('drops the evaluations when the document changes', () => {
    const doc = scene();
    const before = evaluateCached(doc, 1, 'RENDER');
    const version = evaluationStats(doc).version;
    const cube = doc.listObjects().find((o) => o.name === 'Cube')!;
    doc.transact(() => doc.updateObject(cube.id, { location: [1, 2, 3] }));
    expect(evaluationStats(doc).version).toBeGreaterThan(version);
    const after = evaluateCached(doc, 1, 'RENDER');
    expect(after).not.toBe(before);
    expect(after.byId.get(cube.id)!.worldMatrix.slice(12, 15)).toEqual([1, 2, 3]);
  });

  it('keeps the most recently used evaluations only', () => {
    const doc = scene();
    for (let f = 1; f <= MAX_CACHED_EVALUATIONS + 4; f++) evaluateCached(doc, f, 'RENDER');
    expect(evaluationStats(doc).cached).toBe(MAX_CACHED_EVALUATIONS);
    const misses = evaluationStats(doc).misses;
    evaluateCached(doc, MAX_CACHED_EVALUATIONS + 4, 'RENDER'); // still cached
    evaluateCached(doc, 1, 'RENDER'); // evicted
    expect(evaluationStats(doc).misses).toBe(misses + 1);
  });

  it('serves repeated get_object / get_scene summaries of a frame from one evaluation per mode', () => {
    const doc = scene();
    const spy = vi.spyOn(SceneEvaluator.prototype, 'evaluate');
    const cube = doc.listObjects().find((o) => o.name === 'Cube')!;
    const camera = doc.listObjects().find((o) => o.name === 'Camera')!;
    for (let i = 0; i < 5; i++) {
      describeObject(doc, cube, 7);
      describeObject(doc, camera, 7);
      summarizeScene(doc, { frame: 7 });
    }
    // the cube has a modifier: the viewport may show other geometry, so both modes are evaluated
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('get_scene data users', () => {
  it('counts the users of every data block once per call, not once per listed object', () => {
    // regression: each listed object asked SceneDoc.dataUsers, which reads every object, so a
    // get_scene of 5,000 listed objects among 10,000 read 50 million
    const doc = SceneDoc.create({ name: 'Users', empty: true });
    const shared = doc.addMesh('Shared', createCube({ size: 1 }));
    const own = doc.addMesh('Own', createCube({ size: 1 }));
    // curve and text objects count their users through the other call site
    const rail = doc.addCurve({
      splines: [defaultSpline('POLY', [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([1, 0, 0])])],
    });
    const text = doc.addCurve({ body: 'Hi' });
    doc.transact(() => {
      for (let i = 0; i < 40; i++) doc.addObject({ type: 'MESH', name: `Linked.${i}`, data: shared });
      doc.addObject({ type: 'MESH', name: 'Single', data: own });
      for (let i = 0; i < 3; i++) doc.addObject({ type: 'CURVE', name: `Rail.${i}`, data: rail });
      for (let i = 0; i < 2; i++) doc.addObject({ type: 'FONT', name: `Text.${i}`, data: text });
    });
    const perObject = vi.spyOn(SceneDoc.prototype, 'dataUsers');
    const once = vi.spyOn(SceneDoc.prototype, 'dataUserCounts');
    const usersAtFrame1 = () => {
      const s = summarizeScene(doc, { frame: 1 }) as unknown as {
        objects: { name: string; data: { users: number } }[];
      };
      return new Map(s.objects.map((o) => [o.name, o.data.users]));
    };
    const users = usersAtFrame1();
    expect(users.size).toBe(46);
    expect(users.get('Single')).toBe(1);
    for (let i = 0; i < 40; i++) expect(users.get(`Linked.${i}`)).toBe(40);
    for (let i = 0; i < 3; i++) expect(users.get(`Rail.${i}`)).toBe(3);
    for (let i = 0; i < 2; i++) expect(users.get(`Text.${i}`)).toBe(2);
    expect(perObject).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(1);
    // each call counts again: a change between two calls at the same frame shows in the next one
    doc.addObject({ type: 'MESH', name: 'Linked.40', data: shared });
    expect(usersAtFrame1().get('Linked.0')).toBe(41);
    expect(perObject).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(2);
  });

  it('reads the F-curves and drivers of all objects once per call, not once per listed object', () => {
    // regression: each listed object listed the F-curves and drivers of its id and of its data,
    // and each of those reads went through all of them: get_scene of 5,000 objects among 10,000
    // cubes with 3 F-curves each took 21-27 s
    const doc = SceneDoc.create({ name: 'Animated', empty: true });
    const shared = doc.addMesh('Shared', createMesh({ positions: [0, 0, 0], faces: [] }));
    const key = (name: string) => ({
      name,
      value: 0,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: '',
      data: encodeFloat32([0, 0, 1]),
    });
    doc.setShapeKeys(shared, [key('Lift'), key('Bend')]);
    const names = Array.from({ length: 30 }, (_, i) => `Anim.${String(i).padStart(2, '0')}`);
    doc.transact(() => {
      for (const name of names) {
        const id = doc.addObject({ type: 'MESH', name, data: shared });
        let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 2 });
        fc = insertKeyframe(insertKeyframe(fc, 1, 0, 'LINEAR'), 10, 1, 'LINEAR');
        doc.setFCurve(fc);
        doc.setDriver({
          target_type: 'object',
          target_id: id,
          path: 'rotation_euler',
          index: 2,
          expression: 'frame * 0.1',
          variables: [],
          mute: false,
        });
      }
      // on the shared mesh: listed with every object that uses it
      let lift = createFCurve({
        target_type: 'mesh',
        target_id: shared,
        path: 'shape_keys["Lift"].value',
        index: 0,
      });
      lift = insertKeyframe(insertKeyframe(lift, 1, 0, 'LINEAR'), 10, 1, 'LINEAR');
      doc.setFCurve(lift);
      doc.setDriver({
        target_type: 'mesh',
        target_id: shared,
        path: 'shape_keys["Bend"].value',
        index: 0,
        expression: 'frame / 10',
        variables: [],
        mute: false,
      });
    });
    const fcurves = vi.spyOn(SceneDoc.prototype, 'listFCurves');
    const drivers = vi.spyOn(SceneDoc.prototype, 'listDrivers');
    const s = summarizeScene(doc, { frame: 1 }) as unknown as {
      objects: { name: string; animated?: string[]; drivers?: Record<string, unknown>[] }[];
    };
    // reads of one target's list (an id argument): none; whole-map reads stay a few per call
    expect(fcurves.mock.calls.filter(([id]) => id !== undefined)).toHaveLength(0);
    expect(drivers.mock.calls.filter(([id]) => id !== undefined)).toHaveLength(0);
    expect(fcurves.mock.calls.length + drivers.mock.calls.length).toBeLessThan(10);
    expect(s.objects.map((o) => o.name)).toEqual(names);
    for (const o of s.objects) {
      expect(o.animated).toEqual(['location[2]', 'mesh.shape_keys["Lift"].value[0]']);
      expect(o.drivers).toEqual([
        { path: 'rotation_euler[2]', expression: 'frame * 0.1' },
        { path: 'shape_keys["Bend"].value', on: 'mesh', expression: 'frame / 10' },
      ]);
    }
  });

  it('lists the members of every collection in name order, at most 50 with the total', () => {
    const doc = SceneDoc.create({ name: 'Collections', empty: true });
    const mesh = doc.addMesh('M', createCube({ size: 1 }));
    const a = doc.addCollection({ name: 'A' });
    const b = doc.addCollection({ name: 'B', parent: a });
    doc.addCollection({ name: 'Empty' });
    doc.transact(() => {
      for (const [name, collection] of [
        ['b', a],
        ['a', a],
        ['Root', ROOT_COLLECTION_ID],
        ['c', a],
      ])
        doc.addObject({ type: 'MESH', name, data: mesh, collection });
      for (let i = 59; i >= 0; i--)
        doc.addObject({
          type: 'MESH',
          name: `Many.${String(i).padStart(2, '0')}`,
          data: mesh,
          collection: b,
        });
    });
    const s = summarizeScene(doc, { frame: 1, maxObjects: 3 }) as unknown as {
      collections: { name: string; parent: string | null; objects?: string[]; objects_total?: number }[];
    };
    const byName = new Map(s.collections.map((c) => [c.name, c]));
    expect(byName.get('Scene Collection')!.objects).toEqual(['Root']);
    expect(byName.get('A')!.objects).toEqual(['a', 'b', 'c']);
    expect(byName.get('A')!.objects_total).toBeUndefined();
    expect(byName.get('B')!.parent).toBe('A');
    expect(byName.get('B')!.objects).toEqual(
      Array.from({ length: 50 }, (_, i) => `Many.${String(i).padStart(2, '0')}`),
    );
    expect(byName.get('B')!.objects_total).toBe(60);
    expect(byName.get('Empty')!.objects).toBeUndefined();
  });
});
