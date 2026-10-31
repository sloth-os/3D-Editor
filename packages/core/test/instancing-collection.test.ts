import { describe, expect, it } from 'vitest';
import {
  MAX_INSTANCE_DEPTH,
  ROOT_COLLECTION_ID,
  SceneDoc,
  SceneEvaluator,
  compose4,
  createCube,
  defaultSpline,
  defaultSplinePoint,
  multiply4,
  renderItems,
  translation4,
  type EvaluatedScene,
  type Mat4,
  type Vec3,
} from '../src';

function expectMatrix(a: Mat4, b: Mat4, digits = 9): void {
  expect(a).toHaveLength(16);
  for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

function cubeObject(
  doc: SceneDoc,
  name: string,
  collection: string,
  t: { location?: Vec3; rotation?: Vec3; scale?: Vec3; parent?: string } = {},
): string {
  const mesh = doc.addMesh(name, createCube({ size: 1 }));
  return doc.addObject({
    type: 'MESH',
    name,
    data: mesh,
    collection,
    location: t.location ?? [0, 0, 0],
    rotation_euler: t.rotation ?? [0, 0, 0],
    scale: t.scale ?? [1, 1, 1],
    parent: t.parent ?? null,
  });
}

function instancer(
  doc: SceneDoc,
  name: string,
  collection: string,
  t: { location?: Vec3; rotation?: Vec3; scale?: Vec3; in?: string } = {},
): string {
  return doc.addObject({
    type: 'EMPTY',
    name,
    instance_type: 'COLLECTION',
    instance_collection: collection,
    collection: t.in ?? ROOT_COLLECTION_ID,
    location: t.location ?? [0, 0, 0],
    rotation_euler: t.rotation ?? [0, 0, 0],
    scale: t.scale ?? [1, 1, 1],
  });
}

const evaluate = (doc: SceneDoc, forRender = false): EvaluatedScene =>
  new SceneEvaluator(doc).evaluate(1, { forRender });

describe('collection instances', () => {
  it('places every object at owner · translate(-instance_offset) · source world', () => {
    const doc = SceneDoc.create({ empty: true });
    const coll = doc.addCollection({ name: 'Props', instance_offset: [1, 2, 0] });
    const a = cubeObject(doc, 'A', coll, { location: [1, 0, 0], rotation: [0, 0, 0.3], scale: [1, 2, 1] });
    const b = cubeObject(doc, 'B', coll, { location: [0, 3, 1] });
    const e = instancer(doc, 'Inst', coll, {
      location: [10, 0, 0],
      rotation: [0, 0, Math.PI / 2],
      scale: [2, 2, 2],
    });
    const ev = evaluate(doc);
    expect(ev.errors).toEqual([]);
    const owner = compose4([10, 0, 0], [0, 0, Math.PI / 2], [2, 2, 2]);
    const P = multiply4(owner, translation4([-1, -2, 0]));
    const byId = new Map(ev.instances.map((i) => [i.id, i]));
    expect(ev.instances).toHaveLength(2);
    expect(byId.get(`${e}:${a}`)!.sourceId).toBe(a);
    expect(byId.get(`${e}:${a}`)!.ownerId).toBe(e);
    expectMatrix(byId.get(`${e}:${a}`)!.matrix, multiply4(P, ev.byId.get(a)!.worldMatrix));
    expectMatrix(byId.get(`${e}:${b}`)!.matrix, multiply4(P, ev.byId.get(b)!.worldMatrix));
    // B's origin (0,3,1) → offset (-1,1,1) → scaled ×2 (-2,2,2) → rotated 90° (-2,-2,2) → +(10,0,0)
    const m = byId.get(`${e}:${b}`)!.matrix;
    expect([m[12], m[13], m[14]].map((x) => +x.toFixed(9))).toEqual([8, -2, 2]);
  });

  it('includes child collections recursively, parented sources and curve/text geometry only', () => {
    const doc = SceneDoc.create({ empty: true });
    const top = doc.addCollection({ name: 'Top' });
    const child = doc.addCollection({ name: 'Child', parent: top });
    const grandChild = doc.addCollection({ name: 'Grand', parent: child });
    const p = cubeObject(doc, 'Parent', top, { location: [0, 0, 5] });
    const c = cubeObject(doc, 'ChildCube', child, { location: [1, 0, 0], parent: p });
    const g = cubeObject(doc, 'GrandCube', grandChild);
    const light = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: doc.addLight(), collection: child });
    const curve = doc.addCurve({
      bevel_depth: 0.1,
      splines: [
        {
          ...defaultSpline('POLY'),
          points: [
            { ...defaultSplinePoint(), co: [0, 0, 0] },
            { ...defaultSplinePoint(), co: [1, 0, 0] },
          ],
        },
      ],
    });
    const tube = doc.addObject({ type: 'CURVE', name: 'Tube', data: curve, collection: grandChild });
    const wire = doc.addObject({
      type: 'CURVE',
      name: 'Wire',
      data: doc.addCurve({
        splines: [{ ...defaultSpline('POLY'), points: [{ ...defaultSplinePoint(), co: [0, 0, 0] }] }],
      }),
      collection: grandChild,
    });
    const e = instancer(doc, 'Inst', top, { location: [0, 10, 0] });
    const ev = evaluate(doc);
    const sources = ev.instances.map((i) => i.sourceId).sort();
    // every member with evaluated geometry (meshes; curves/text with a surface) is instanced
    const withGeometry = [p, c, g, tube, wire].filter((id) => !!ev.byId.get(id)!.mesh);
    expect(withGeometry).toEqual(expect.arrayContaining([p, c, g]));
    expect(sources).toEqual(withGeometry.sort());
    expect(sources).not.toContain(light);
    const child0 = ev.instances.find((i) => i.sourceId === c)!;
    // parented source: its world matrix (parent at z=5) is used
    expect(child0.matrix.slice(12, 15)).toEqual([1, 10, 5]);
    expect(ev.instances.every((i) => i.ownerId === e)).toBe(true);
  });

  it('instances hidden source collections and objects; visibility follows the owner', () => {
    const doc = SceneDoc.create({ empty: true });
    const coll = doc.addCollection({ name: 'Hidden', hide_viewport: true, hide_render: true });
    const a = cubeObject(doc, 'A', coll);
    doc.updateObject(a, { hide_viewport: true, hide_render: true });
    const e = instancer(doc, 'Inst', coll, { location: [3, 0, 0] });
    for (const forRender of [false, true]) {
      const ev = evaluate(doc, forRender);
      expect(ev.instances).toHaveLength(1);
      const items = renderItems(ev, { forRender });
      expect(items.map((i) => i.id)).toEqual([`${e}:${a}`]);
      expect(items[0]).toMatchObject({ instance: true, ownerId: e, mesh: ev.byId.get(a)!.mesh });
      expect(items[0].worldMatrix.slice(12, 15)).toEqual([3, 0, 0]);
    }
    doc.updateObject(e, { hide_viewport: true });
    const hidden = evaluate(doc);
    expect(hidden.instances).toHaveLength(1);
    expect(renderItems(hidden)).toHaveLength(0);
    expect(renderItems(evaluate(doc, true), { forRender: true })).toHaveLength(1);
  });

  it('expands nested collection instances', () => {
    const doc = SceneDoc.create({ empty: true });
    const inner = doc.addCollection({ name: 'Inner', instance_offset: [0, 0, 1] });
    const outer = doc.addCollection({ name: 'Outer', instance_offset: [2, 0, 0] });
    const s = cubeObject(doc, 'Leaf', inner, { location: [0, 1, 0] });
    const e2 = instancer(doc, 'InnerInst', inner, { in: outer, location: [5, 0, 0], rotation: [0.4, 0, 0] });
    const k = cubeObject(doc, 'OuterCube', outer);
    const e1 = instancer(doc, 'OuterInst', outer, { location: [0, 0, 7], scale: [1, 1, 3] });
    const ev = evaluate(doc);
    expect(ev.errors).toEqual([]);
    const top = ev.instances.filter((i) => i.ownerId === e1);
    // OuterCube directly + Leaf through the nested instancer
    expect(top.map((i) => i.sourceId).sort()).toEqual([k, s].sort());
    const leaf = top.find((i) => i.sourceId === s)!;
    expect(leaf.id).toBe(`${e1}:${e2}:${s}`);
    const expected = multiply4(
      multiply4(ev.byId.get(e1)!.worldMatrix, translation4([-2, 0, 0])),
      multiply4(
        multiply4(ev.byId.get(e2)!.worldMatrix, translation4([0, 0, -1])),
        ev.byId.get(s)!.worldMatrix,
      ),
    );
    expectMatrix(leaf.matrix, expected);
    // the nested instancer still instances at its own (real) place, owned by itself
    expect(ev.instances.filter((i) => i.ownerId === e2)).toHaveLength(1);
  });

  it(`limits nesting to ${MAX_INSTANCE_DEPTH} levels`, () => {
    const doc = SceneDoc.create({ empty: true });
    const colls: string[] = [];
    for (let i = 0; i < 12; i++) colls.push(doc.addCollection({ name: `C${i}` }));
    // C_i contains a cube and an instancer of C_{i+1}
    const cubes: string[] = [];
    for (let i = 0; i < 12; i++) {
      cubes.push(cubeObject(doc, `Cube${i}`, colls[i], { location: [i, 0, 0] }));
      if (i < 11) instancer(doc, `I${i}`, colls[i + 1], { in: colls[i] });
    }
    const root = instancer(doc, 'Root', colls[0]);
    const ev = evaluate(doc);
    const fromRoot = ev.instances.filter((i) => i.ownerId === root).map((i) => i.sourceId);
    expect(fromRoot.sort()).toEqual(cubes.slice(0, MAX_INSTANCE_DEPTH).sort());
    expect(ev.errors.some((e) => /nested deeper than 8 levels/.test(e.message))).toBe(true);
    expect(ev.errors.every((e) => e.source.startsWith('instances:'))).toBe(true);
  });

  it('skips an instancer inside its own collection and breaks instancing cycles', () => {
    const doc = SceneDoc.create({ empty: true });
    const c = doc.addCollection({ name: 'Self' });
    const a = cubeObject(doc, 'A', c);
    const self = instancer(doc, 'SelfInst', c, { in: c, location: [0, 5, 0] });
    let ev = evaluate(doc);
    const own = ev.instances.filter((i) => i.ownerId === self);
    expect(own.map((i) => i.sourceId)).toEqual([a]);
    expect(ev.errors.map((e) => e.message).join('\n')).toMatch(/inside the collection 'Self' it instances/);

    // A ↔ B cycle through two collections
    const doc2 = SceneDoc.create({ empty: true });
    const ca = doc2.addCollection({ name: 'CA' });
    const cb = doc2.addCollection({ name: 'CB' });
    const xa = cubeObject(doc2, 'XA', ca);
    const xb = cubeObject(doc2, 'XB', cb);
    const ia = instancer(doc2, 'IA', cb, { in: ca, location: [1, 0, 0] });
    instancer(doc2, 'IB', ca, { in: cb, location: [0, 1, 0] });
    const top = instancer(doc2, 'Top', ca);
    ev = evaluate(doc2);
    expect(ev.errors.some((e) => /cycle/i.test(e.message))).toBe(true);
    const fromTop = ev.instances.filter((i) => i.ownerId === top).map((i) => i.sourceId);
    expect(fromTop).toContain(xa);
    expect(fromTop).toContain(xb);
    expect(ev.instances.filter((i) => i.ownerId === ia).length).toBeGreaterThan(0);
    expect(ev.instances.length).toBeLessThan(50);
  });

  it('reports invalid setups without failing the evaluation', () => {
    const doc = SceneDoc.create({ empty: true });
    const c = doc.addCollection({ name: 'C' });
    cubeObject(doc, 'A', c);
    const missing = instancer(doc, 'Missing', 'no-such-collection');
    const rootInst = instancer(doc, 'Root', ROOT_COLLECTION_ID);
    const meshInst = cubeObject(doc, 'MeshInst', ROOT_COLLECTION_ID);
    doc.updateObject(meshInst, { instance_type: 'COLLECTION', instance_collection: c });
    const none = doc.addObject({ type: 'EMPTY', name: 'NoColl', instance_type: 'COLLECTION' });
    const ev = evaluate(doc);
    expect(ev.instances).toEqual([]);
    const bySource = (id: string) =>
      ev.errors.filter((e) => e.source === `instances:${id}`).map((e) => e.message);
    expect(bySource(missing).join()).toMatch(/missing collection/);
    expect(bySource(rootInst).join()).toMatch(/Scene Collection/);
    expect(bySource(meshInst).join()).toMatch(/Only empties/);
    expect(bySource(none)).toEqual([]);
  });

  it('caches results: unchanged scenes return the identical instance arrays', () => {
    const doc = SceneDoc.create({ empty: true });
    const c = doc.addCollection({ name: 'C' });
    const a = cubeObject(doc, 'A', c);
    const e = instancer(doc, 'Inst', c);
    const evaluator = new SceneEvaluator(doc);
    const first = evaluator.evaluate(1).instances;
    const second = evaluator.evaluate(1).instances;
    expect(second).toBe(first);
    // a fresh evaluator of the same document shares the cache
    expect(new SceneEvaluator(doc).evaluate(1).instances).toBe(first);
    // unrelated edits keep the instances
    doc.addMaterial({ name: 'Unrelated' });
    expect(evaluator.evaluate(1).instances).toBe(first);
    // moving the owner or a source updates them
    doc.updateObject(e, { location: [0, 0, 4] });
    const moved = evaluator.evaluate(1).instances;
    expect(moved).not.toBe(first);
    expect(moved[0].matrix[14]).toBe(4);
    doc.updateObject(a, { location: [1, 0, 0] });
    expect(evaluator.evaluate(1).instances[0].matrix.slice(12, 15)).toEqual([1, 0, 4]);
    // changing the collection offset updates them as well
    doc.updateCollection(c, { instance_offset: [1, 0, 0] });
    expect(evaluator.evaluate(1).instances[0].matrix.slice(12, 15)).toEqual([0, 0, 4]);
  });

  it('follows animated owners', () => {
    const doc = SceneDoc.create({ empty: true });
    const c = doc.addCollection({ name: 'C' });
    cubeObject(doc, 'A', c);
    const e = instancer(doc, 'Inst', c);
    doc.setFCurve({
      target_type: 'object',
      target_id: e,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 11, value: 10, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const evaluator = new SceneEvaluator(doc);
    expect(evaluator.evaluate(6).instances[0].matrix[12]).toBeCloseTo(5);
    expect(evaluator.evaluate(11).instances[0].matrix[12]).toBeCloseTo(10);
  });
});
