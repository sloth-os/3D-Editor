import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, createCube, ROOT_COLLECTION_ID, fcurveKey, evaluateScene, SceneEvaluator } from '../src';

function syncDocs(a: SceneDoc, b: SceneDoc) {
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
}

describe('SceneDoc', () => {
  it('creates the default scene', () => {
    const doc = SceneDoc.create({ name: 'Test' });
    expect(doc.name).toBe('Test');
    const names = doc.listObjects().map((o) => o.name);
    expect(names).toEqual(['Camera', 'Cube', 'Light']);
    const cube = doc.findObjectByName('Cube')!;
    expect(doc.getMesh(cube.data!)!.faces.length).toBe(6);
    expect(doc.getScene().camera).toBe(doc.findObjectByName('Camera')!.id);
    expect(doc.listCollections()[0].id).toBe(ROOT_COLLECTION_ID);
  });

  it('keeps names unique Blender-style', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'Empty' });
    const b = doc.addObject({ type: 'EMPTY', name: 'Empty' });
    const c = doc.addObject({ type: 'EMPTY', name: 'Empty' });
    expect([a, b, c].map((id) => doc.getObject(id)!.name)).toEqual(['Empty', 'Empty.001', 'Empty.002']);
    expect(doc.rename('objects', c, 'Empty')).toBe('Empty.002');
  });

  it('reports changes once per transaction with local/remote flags', () => {
    const doc = SceneDoc.create({ empty: true });
    const events: { local: boolean; changed: string[] }[] = [];
    doc.onChange((c) => events.push({ local: c.local, changed: [...(c.changed.get('objects') ?? [])] }));
    const id = doc.addObject({ type: 'EMPTY', name: 'A' });
    doc.transact(() => {
      doc.updateObject(id, { location: [1, 2, 3] });
      doc.updateObject(id, { scale: [2, 2, 2] });
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ local: true, changed: [id] });
    const other = new SceneDoc();
    const remoteEvents: boolean[] = [];
    other.onChange((c) => remoteEvents.push(c.local));
    other.applyUpdate(doc.encodeState());
    expect(remoteEvents).toEqual([false]);
    expect(other.getObject(id)!.location).toEqual([1, 2, 3]);
  });

  it('merges concurrent edits to different fields (CRDT)', () => {
    const a = SceneDoc.create({ name: 'P' });
    const b = new SceneDoc();
    syncDocs(a, b);
    const cubeId = a.findObjectByName('Cube')!.id;
    a.updateObject(cubeId, { location: [5, 0, 0] });
    b.updateObject(cubeId, { name: 'Box' });
    syncDocs(a, b);
    for (const d of [a, b]) {
      expect(d.getObject(cubeId)!.location).toEqual([5, 0, 0]);
      expect(d.getObject(cubeId)!.name).toBe('Box');
    }
  });

  it('parents with keep-transform and removes objects safely', () => {
    const doc = SceneDoc.create({ empty: true });
    const parent = doc.addObject({ type: 'EMPTY', name: 'P', location: [1, 0, 0], scale: [2, 2, 2] });
    const child = doc.addObject({ type: 'EMPTY', name: 'C', location: [3, 0, 0] });
    doc.setParent(child, parent, true);
    const w = doc.worldMatrix(child);
    expect(w[12]).toBeCloseTo(3);
    expect(doc.getObject(child)!.location[0]).toBeCloseTo(1);
    expect(() => doc.setParent(parent, child)).toThrow();
    doc.removeObject(parent);
    expect(doc.getObject(child)!.parent).toBeNull();
    expect(doc.worldMatrix(child)[12]).toBeCloseTo(3);
  });

  it('garbage-collects object data with the last user', () => {
    const doc = SceneDoc.create({ empty: true });
    const mesh = doc.addMesh('M', createCube());
    const a = doc.addObject({ type: 'MESH', name: 'A', data: mesh });
    const b = doc.addObject({ type: 'MESH', name: 'B', data: mesh });
    doc.removeObject(a);
    expect(doc.getMesh(mesh)).not.toBeNull();
    doc.removeObject(b);
    expect(doc.getMesh(mesh)).toBeNull();
  });

  it('snapshot round-trip preserves everything', () => {
    const doc = SceneDoc.create({ name: 'Snap' });
    const cube = doc.findObjectByName('Cube')!;
    doc.setFCurve({
      target_type: 'object',
      target_id: cube.id,
      path: 'location',
      index: 2,
      extrapolation: 'CONSTANT',
      mute: false,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 11, value: 10, interpolation: 'LINEAR' },
      ],
    });
    const copy = SceneDoc.fromSnapshot(doc.toSnapshot());
    expect(copy.toSnapshot()).toEqual(doc.toSnapshot());
    expect(
      copy.getFCurve(fcurveKey({ target_type: 'object', target_id: cube.id, path: 'location', index: 2 })),
    ).not.toBeNull();
  });

  it('evaluates animation and parenting', () => {
    const doc = SceneDoc.create({ empty: true });
    const p = doc.addObject({ type: 'EMPTY', name: 'P' });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', parent: p, location: [1, 0, 0] });
    doc.setFCurve({
      target_type: 'object',
      target_id: p,
      path: 'location',
      index: 2,
      extrapolation: 'CONSTANT',
      mute: false,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 11, value: 10, interpolation: 'LINEAR' },
      ],
    });
    const ev = evaluateScene(doc, 6);
    expect(ev.byId.get(c)!.worldMatrix[14]).toBeCloseTo(5);
    expect(ev.byId.get(c)!.worldMatrix[12]).toBeCloseTo(1);
    const ev2 = new SceneEvaluator(doc).evaluate(20);
    expect(ev2.byId.get(p)!.data.location[2]).toBeCloseTo(10);
  });
});
