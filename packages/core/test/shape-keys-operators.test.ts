import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';
import { decodeFloat32 } from '../src/mesh/shape-keys';
import { createMesh } from '../src/mesh/types';

/** A 3-vertex mesh object "Tri" (positions exactly representable as float32). */
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
  const meshId = doc.addMesh(
    'Tri',
    createMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] }),
  );
  const obj = doc.addObject({ type: 'MESH', name: 'Tri', data: meshId });
  ctx.state.activeId = obj;
  ctx.state.selectedIds = [obj];
  const keys = () => doc.getShapeKeys(meshId);
  const keyData = (name: string) => Array.from(decodeFloat32(keys().find((k) => k.name === name)!.data));
  const evaluated = (frame = 1) => new SceneEvaluator(doc).evaluate(frame).byId.get(obj)!.mesh!.positions;
  return { doc, ctx, run, ok, err, meshId, obj, keys, keyData, evaluated };
}

describe('shape key operators', () => {
  it('adds keys copied from the basis or from the current mix', () => {
    const { ok, err, keys, keyData } = setup();
    expect(ok('object.shape_key_add', {})).toMatchObject({ key: 'Key 1', index: 0 });
    expect(keys()[0]).toMatchObject({
      value: 0,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: '',
    });
    expect(keyData('Key 1')).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    ok('object.shape_key_set_positions', { key: 'Key 1', indices: [2], offsets: [[0, 0, 2]] });
    ok('object.shape_key_set', { key: 'Key 1', value: 0.5 });
    const mix = ok('object.shape_key_add', { name: 'Smile', from_mix: true, value: 0.25 });
    expect(mix.key).toBe('Smile');
    expect(keyData('Smile')).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 1]);
    expect(keys()[1].value).toBe(0.25);
    expect(ok('object.shape_key_add', { name: 'Smile' }).key).toBe('Smile.001');
    expect(err('object.shape_key_add', { relative_key: 'Nope' })).toMatch(/Shape key 'Nope' not found/);
    expect(err('object.shape_key_add', { object: 'Missing' })).toMatch(/not found/);
  });

  it('sets absolute positions or offsets from the basis / the key', () => {
    const { ok, err, keyData } = setup();
    ok('object.shape_key_add', { name: 'K' });
    ok('object.shape_key_set_positions', {
      key: 'K',
      positions: [
        [0, 0, 1],
        [1, 0, 1],
        [0, 1, 1],
      ],
    });
    expect(keyData('K')).toEqual([0, 0, 1, 1, 0, 1, 0, 1, 1]);
    ok('object.shape_key_set_positions', { key: 'K', indices: [1], offsets: [[0, 0.5, 0]] }); // from the basis
    expect(keyData('K').slice(3, 6)).toEqual([1, 0.5, 0]);
    ok('object.shape_key_set_positions', {
      key: 'K',
      indices: [0, 2],
      offsets: [
        [0, 0, 1],
        [0, 0, 1],
      ],
      offset_from: 'KEY',
    });
    expect(keyData('K')).toEqual([0, 0, 2, 1, 0.5, 0, 0, 1, 2]);
    expect(err('object.shape_key_set_positions', { key: 'K', positions: [[0, 0, 0]] })).toMatch(/3 vertices/);
    expect(err('object.shape_key_set_positions', { key: 'K', indices: [5], offsets: [[0, 0, 0]] })).toMatch(
      /out of range/,
    );
    expect(err('object.shape_key_set_positions', { key: 'K', indices: [0] })).toMatch(/exactly one/);
    expect(
      err('object.shape_key_set_positions', { key: 'K', indices: [0, 1], offsets: [[0, 0, 0]] }),
    ).toMatch(/same length/);
  });

  it('blends keys by value, slider range, mute and relative keys during evaluation', () => {
    const { ok, err, evaluated } = setup();
    ok('object.shape_key_add', { name: 'Up' });
    ok('object.shape_key_set_positions', {
      key: 'Up',
      offsets: [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
    });
    expect(evaluated()).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    ok('object.shape_key_set', { key: 'Up', value: 0.5 });
    expect(evaluated()).toEqual([0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5]);
    ok('object.shape_key_set', { key: 'Up', value: 2 }); // clamped by slider_max = 1
    expect(evaluated()[2]).toBe(1);
    ok('object.shape_key_set', { key: 'Up', slider_max: 2 });
    expect(evaluated()[2]).toBe(2);
    ok('object.shape_key_set', { key: 'Up', mute: true });
    expect(evaluated()[2]).toBe(0);
    ok('object.shape_key_set', { key: 'Up', mute: false, value: 1 });
    // a key relative to "Up" only adds its difference to "Up": (3 - 1) on top of Up's 1
    ok('object.shape_key_add', { name: 'More', from_mix: true, relative_key: 'Up' });
    ok('object.shape_key_set_positions', { key: 'More', indices: [0], offsets: [[0, 0, 3]] });
    ok('object.shape_key_set', { key: 'More', value: 1 });
    expect(evaluated().slice(0, 6)).toEqual([0, 0, 3, 1, 0, 1]);
    expect(err('object.shape_key_set', { key: 'Up', slider_min: 3 })).toMatch(/slider_min/);
    expect(err('object.shape_key_set', { key: 'Up', relative_key: 'Up' })).toMatch(/itself/);
    expect(err('object.shape_key_set', { key: 'Gone', value: 1 })).toMatch(/not found.*'Up'/);
  });

  it('keyframes values and keeps animation, relative keys and names in sync when renaming', () => {
    const { ok, doc, meshId, keys, evaluated } = setup();
    ok('object.shape_key_add', { name: 'Up' });
    ok('object.shape_key_set_positions', {
      key: 'Up',
      offsets: [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
    });
    ok('object.shape_key_add', { name: 'Rel', relative_key: 'Up' });
    expect(
      ok('object.shape_key_set', { key: 'Up', value: 0, keyframe: true, frame: 1 }).keyframes_inserted,
    ).toBe(1);
    ok('object.shape_key_set', { key: 'Up', value: 1, keyframe: true, frame: 11 });
    expect(evaluated(1)[2]).toBeCloseTo(0);
    expect(evaluated(11)[2]).toBeCloseTo(1);
    expect(evaluated(6)[2]).toBeCloseTo(0.5, 1);
    ok('object.shape_key_set', { key: 'Up', name: 'Lift' });
    expect(keys().map((k) => [k.name, k.relative_key])).toEqual([
      ['Lift', ''],
      ['Rel', 'Lift'],
    ]);
    expect(doc.listFCurves(meshId).map((f) => f.path)).toEqual(['shape_keys["Lift"].value']);
    expect(evaluated(11)[2]).toBeCloseTo(1);
    // editing the animated value without keyframe re-keys the current frame
    ok('object.shape_key_set', { key: 'Lift', value: 0.25 });
    expect(evaluated(1)[2]).toBeCloseTo(0.25);
    ok('object.shape_key_clear', {});
    expect(keys().every((k) => k.value === 0)).toBe(true);
    expect(evaluated(1)[2]).toBeCloseTo(0);
  });

  it('removes keys (with their animation) and applies the mix', () => {
    const { ok, err, doc, meshId, keys } = setup();
    ok('object.shape_key_add', { name: 'A' });
    ok('object.shape_key_add', { name: 'B', relative_key: 'A' });
    ok('object.shape_key_set_positions', {
      key: 'A',
      offsets: [
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
      ],
    });
    ok('object.shape_key_set', { key: 'A', value: 0.5, keyframe: true });
    expect(ok('object.shape_key_remove', { key: 'A' }).removed).toEqual(['A']);
    expect(keys().map((k) => [k.name, k.relative_key])).toEqual([['B', '']]);
    expect(doc.listFCurves(meshId)).toEqual([]);
    ok('object.shape_key_add', { name: 'C' });
    ok('object.shape_key_set_positions', {
      key: 'C',
      offsets: [
        [0, 0, 4],
        [0, 0, 4],
        [0, 0, 4],
      ],
    });
    ok('object.shape_key_set', { key: 'C', value: 0.5 });
    expect(ok('object.shape_key_remove', { all: true, apply_mix: true }).removed).toEqual(['B', 'C']);
    expect(keys()).toEqual([]);
    expect(doc.getMesh(meshId)!.positions).toEqual([0, 0, 2, 1, 0, 2, 0, 1, 2]);
    expect(err('object.shape_key_remove', {})).toMatch(/Pass `key`/);
  });

  it('rejects non-mesh objects and keys that no longer match the mesh', () => {
    const { ok, err, doc, meshId } = setup();
    doc.addObject({ type: 'EMPTY', name: 'E' });
    expect(err('object.shape_key_add', { object: 'E' })).toMatch(/need a mesh/);
    ok('object.shape_key_add', { name: 'K' });
    doc.setMesh(meshId, createMesh({ positions: [0, 0, 0, 1, 0, 0], faces: [] }));
    expect(err('object.shape_key_set_positions', { key: 'K', indices: [0], offsets: [[0, 0, 1]] })).toMatch(
      /has 3 vertices but the mesh has 2/,
    );
  });

  it('makes every operator one undo step and survives snapshots', () => {
    const { ok, doc, meshId, keys, obj, evaluated } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    ok('object.shape_key_add', { name: 'K' });
    ok('object.shape_key_set_positions', { key: 'K', indices: [0], positions: [[0, 0, 5]] });
    ok('object.shape_key_set', { key: 'K', value: 0.2, keyframe: true });
    const snap = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(new SceneEvaluator(snap).evaluate(1).byId.get(obj)!.mesh!.positions).toEqual(evaluated());
    expect(snap.listFCurves(meshId)).toHaveLength(1);
    um.undo();
    expect(keys()[0].value).toBe(0);
    expect(doc.listFCurves(meshId)).toEqual([]);
    um.undo();
    expect(Array.from(decodeFloat32(keys()[0].data)).slice(0, 3)).toEqual([0, 0, 0]);
    um.undo();
    expect(keys()).toEqual([]);
    um.redo();
    expect(keys().map((k) => k.name)).toEqual(['K']);
  });
});
