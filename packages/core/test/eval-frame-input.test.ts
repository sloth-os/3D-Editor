import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import type { FCurve } from '../src/doc/types';
import { docChangeToken } from '../src/doc/change-token';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { encodeFloat32 } from '../src';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import {
  FRAME_INPUT_BYTES_PER_CURVE,
  FRAME_INPUT_BYTES_PER_OBJECT,
  FRAME_INPUT_BYTES_PER_POSE_BONE,
  clearFrameInput,
  frameInput,
  frameInputCacheBytes,
  setFrameInputFreezing,
} from '../src/eval/frame-input';
import { createActor, moveAlongPath } from '../src/desk/characters';
import { createCube, createPlane } from '../src/mesh/primitives';
import { createEditorState, createOperatorRegistry } from '../src/operators';
import { getShots, setShots } from '../src/desk/shots';

/*
 * The frame states of a document share one reading of it (eval/frame-input.ts), read again whenever
 * the document may have changed (doc/change-token.ts). Evaluated scenes must be the same as when
 * every frame state reads the document anew, bit for bit.
 */

/** The first difference between `a` and `b` (numbers bit for bit), or null when there is none. */
function difference(a: unknown, b: unknown, at = ''): string | null {
  if (typeof a === 'number' || typeof b === 'number')
    return Object.is(a, b) ? null : `${at}: ${String(a)} ≠ ${String(b)}`;
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
    return `${at}: ${String(a)} ≠ ${String(b)}`;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    const x = Array.from(a as ArrayLike<number>);
    const y = Array.from(b as ArrayLike<number>);
    return difference(x, y, at);
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return `${at}: maps differ in size`;
    for (const [k, v] of a) {
      const d = difference(v, b.get(k), `${at}[${String(k)}]`);
      if (d) return d;
    }
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array ≠ object`;
  const keys = (o: object) =>
    Object.keys(o)
      .filter((k) => (o as Record<string, unknown>)[k] !== undefined)
      .sort();
  const ka = keys(a);
  const kb = keys(b);
  if (ka.join() !== kb.join()) return `${at}: keys ${ka.join()} ≠ ${kb.join()}`;
  for (const k of ka) {
    const d = difference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

function operators(doc: SceneDoc) {
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx = { doc, state, origin: { type: 'test' }, source: 'test' as const, report: () => undefined };
  return (id: string, params: object = {}) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r.result as Record<string, unknown>;
  };
}

const key = (
  target: string,
  path: string,
  index: number,
  keys: [number, number][],
  o: Partial<FCurve> = {},
) => {
  let fc = createFCurve({ target_type: 'object', target_id: target, path, index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v);
  return { ...fc, ...o };
};

/**
 * A scene of everything a frame state reads: two walking actors (poses, bone constraints), keyed
 * objects (Bezier, cyclic with a modifier, muted, empty curves), a parent chain, object constraints,
 * drivers (objects, shape keys, materials), a shape key keyed on its mesh, rigid bodies and a
 * curve whose stored keys are out of order (as a peer may write them).
 */
function richScene(): { doc: SceneDoc; ids: Record<string, string> } {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ frame_start: 1, frame_end: 72 });
  const run = operators(doc);
  const ids: Record<string, string> = {};
  const walker = createActor(doc, { kind: 'adult', location: [0, 0, 0], facing_deg: 180 });
  const dog = createActor(doc, { kind: 'dog', location: [3, 0, 0], facing_deg: 180 });
  moveAlongPath(
    doc,
    walker.actor,
    [
      [1, 4, 0],
      [-1, 8, 0],
    ],
    { frame_start: 1, frame_end: 72 },
  );
  moveAlongPath(doc, dog.actor, [[4, 5, 0]], { frame_start: 10, frame_end: 60 });
  ids.walker = walker.actor;
  ids.dog = dog.actor;
  const cube = doc.addMesh('Cube', createCube({ size: 0.5 }));
  ids.box = doc.addObject({ type: 'MESH', name: 'Box', data: cube, location: [0, 0, 1] });
  doc.setFCurve(
    key(ids.box, 'location', 0, [
      [1, 0],
      [24, 3],
      [48, -1],
      [72, 2],
    ]),
  );
  doc.setFCurve(
    key(
      ids.box,
      'rotation_euler',
      2,
      [
        [1, 0],
        [30, 1.5],
      ],
      { extrapolation: 'CYCLIC' },
    ),
  );
  doc.setFCurve(
    key(
      ids.box,
      'location',
      2,
      [
        [1, 1],
        [12, 2],
      ],
      {
        modifiers: [
          { type: 'NOISE', params: { scale: 4, strength: 0.5, phase: 1, offset: 0, depth: 0 } },
          { type: 'STEPPED', params: { frame_step: 2, frame_offset: 0 } },
        ],
      },
    ),
  );
  doc.setFCurve(
    key(
      ids.box,
      'scale',
      0,
      [
        [1, 1],
        [72, 9],
      ],
      { mute: true },
    ),
  );
  doc.setFCurve(createFCurve({ target_type: 'object', target_id: ids.box, path: 'scale', index: 1 }));
  ids.child = doc.addObject({
    type: 'MESH',
    name: 'Child',
    data: cube,
    location: [1, 0, 0],
    parent: ids.box,
  });
  ids.follower = doc.addObject({ type: 'EMPTY', name: 'Follower', location: [0, 3, 0] });
  run('object.constraint_add', {
    type: 'COPY_LOCATION',
    object: ids.follower,
    target: ids.box,
    influence: 0.5,
  });
  ids.camera = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ name: 'Cam' }),
    location: [0, -8, 2],
  });
  run('object.constraint_add', { type: 'TRACK_TO', object: ids.camera, target: ids.walker });
  // drivers on an object, a shape key and a material
  const keyed = doc.addMesh('Keyed', createPlane({ size: 1 }));
  doc.setShapeKeys(keyed, [
    {
      name: 'Lift',
      value: 0,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: '',
      data: encodeFloat32(Array.from({ length: 12 }, (_, i) => (i % 3 === 2 ? 1 : 0))),
    },
  ]);
  const material = doc.addMaterial({ name: 'Paint' });
  ids.sheet = doc.addObject({
    type: 'MESH',
    name: 'Sheet',
    data: keyed,
    location: [-3, 0, 0],
    material_slots: [material],
  });
  doc.setFCurve({
    ...key(keyed, 'shape_keys["Lift"].value', 0, [
      [1, 0],
      [40, 1],
    ]),
    target_type: 'mesh',
    target_id: keyed,
  });
  const x = [{ name: 'x', target_type: 'object' as const, target_id: ids.box, path: 'location', index: 0 }];
  doc.setDriver({
    target_type: 'object',
    target_id: ids.sheet,
    path: 'rotation_euler',
    index: 2,
    expression: 'x * 0.5 + frame / 100',
    variables: x,
    mute: false,
  });
  doc.setDriver({
    target_type: 'material',
    target_id: material,
    path: 'base_color',
    index: 0,
    expression: 'abs(x) / 4',
    variables: x,
    mute: false,
  });
  // stored keys out of frame order, as written by a peer that does not sort them
  const unsorted = key(ids.sheet, 'location', 1, [
    [1, 0],
    [20, 2],
    [50, -2],
  ]);
  doc
    .map('fcurves')
    .set(`object:${ids.sheet}:location:1`, { ...unsorted, keyframes: [...unsorted.keyframes].reverse() });
  // rigid bodies: one falling on a floor, one carried by its keys
  const opsDoc = run;
  ids.crate = doc.addObject({ type: 'MESH', name: 'Crate', data: cube, location: [6, 0, 3] });
  ids.floor = doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 20 })),
    location: [0, 0, -1],
  });
  ids.lift = doc.addObject({ type: 'MESH', name: 'Lift', data: cube, location: [8, 0, 0] });
  opsDoc('rigidbody.object_add', { objects: [ids.crate], type: 'ACTIVE' });
  opsDoc('rigidbody.object_add', { objects: [ids.floor], type: 'PASSIVE' });
  opsDoc('rigidbody.object_add', { objects: [ids.lift], type: 'PASSIVE' });
  opsDoc('rigidbody.object_settings_set', { objects: [ids.lift], kinematic: true });
  doc.setFCurve(
    key(ids.lift, 'location', 2, [
      [1, 0],
      [40, 2],
    ]),
  );
  return { doc, ids };
}

/** A copy of `doc` without a change token (its Y.Doc destroyed): every frame state reads it anew. */
function uncached(doc: SceneDoc): SceneDoc {
  const copy = SceneDoc.fromUpdate(doc.encodeState());
  copy.ydoc.destroy();
  return copy;
}

/** What a frame state gives for every object of the scene at `frame`. */
function frameStateAt(doc: SceneDoc, frame: number) {
  const fs = new FrameState(doc, frame);
  const objects = doc.objectIds().map((id) => ({
    id,
    data: fs.get('object', id),
    local: fs.local(id),
    world: fs.world(id),
    pose: fs.pose(id),
  }));
  return { objects, matrices: fs.allWorldMatrices(), errors: fs.errors };
}

/** What renders read of an evaluated scene. */
function evaluatedAt(ev: SceneEvaluator, frame: number) {
  const s = ev.evaluate(frame, { forRender: true });
  return {
    errors: s.errors,
    objects: s.objects.map((o) => ({
      id: o.id,
      data: o.data,
      world: o.worldMatrix,
      local: o.localMatrix,
      pose: o.pose,
      positions: o.mesh?.positions,
      simulated: o.simulated,
      materials: o.materials,
      constraintErrors: o.constraintErrors,
    })),
  };
}

const FRAMES = [1, 5, 12.5, 24, 24, 31, 40, 47.25, 60, 72, 90, 0, -3, 36];

describe('the frame states of a document', () => {
  let scene: ReturnType<typeof richScene>;
  beforeAll(() => {
    scene = richScene();
  });

  it('give what reading the document anew gives, bit for bit, at every frame', () => {
    const fresh = uncached(scene.doc);
    // read in a scrambled order: the cache must not depend on the frames seen before
    for (const frame of [...FRAMES, ...FRAMES.slice().reverse()]) {
      const cached = frameStateAt(scene.doc, frame);
      const reference = frameStateAt(fresh, frame);
      expect(difference(cached, reference), `frame ${frame}`).toBeNull();
    }
    expect(frameInputCacheBytes(scene.doc)).toBeGreaterThan(0);
    expect(frameInputCacheBytes(fresh)).toBe(0);
  });

  it('give the evaluator what reading the document anew gives (poses, meshes, simulation, drivers)', () => {
    const fresh = uncached(scene.doc);
    const a = new SceneEvaluator(scene.doc);
    const b = new SceneEvaluator(fresh);
    // the simulation steps from the start: frames in order, then back
    const frames = [1, 2, 3, 10, 24, 40, 41, 60, 12, 72];
    for (const frame of frames) {
      const x = evaluatedAt(a, frame);
      const y = evaluatedAt(b, frame);
      expect(difference(x, y), `frame ${frame}`).toBeNull();
    }
    // the scene animates what it should: the crate falls, the lift rises, the shape key and the walker move
    const at = (frame: number, id: string) => a.evaluate(frame).byId.get(id)!;
    expect(at(40, scene.ids.crate).worldMatrix[14]).toBeLessThan(2);
    expect(at(40, scene.ids.lift).worldMatrix[14]).toBeCloseTo(2, 5);
    expect(at(40, scene.ids.sheet).mesh!.positions[2]).toBeCloseTo(1, 5);
    expect(at(72, scene.ids.walker).worldMatrix[13]).toBeGreaterThan(4);
  });

  it('give the same as a frame state that reads the stored values again (the cache dropped first)', () => {
    for (const frame of FRAMES) {
      const cached = frameStateAt(scene.doc, frame);
      clearFrameInput(scene.doc);
      expect(frameInputCacheBytes(scene.doc)).toBe(0);
      expect(difference(cached, frameStateAt(scene.doc, frame)), `frame ${frame}`).toBeNull();
    }
  });

  it('share one reading per document state, kept per Y.Doc and counted by its size', () => {
    const { doc } = scene;
    const input = frameInput(doc);
    expect(frameInput(doc)).toBe(input);
    for (const frame of FRAMES) void new FrameState(doc, frame).allWorldMatrices();
    expect(frameInput(doc)).toBe(input);
    // another facade over the same Y.Doc shares it; another document has its own
    expect(frameInput(new SceneDoc(doc.ydoc))).toBe(input);
    const other = SceneDoc.fromUpdate(doc.encodeState());
    expect(frameInput(other)).not.toBe(input);
    // its size: per object, pose bone, and F-curve or driver it indexes (keyed and not muted)
    let bones = 0;
    for (const o of doc.listObjects()) bones += Object.keys(o.pose?.bones ?? {}).length;
    let curves = 0;
    for (const fc of doc.listFCurves()) if (!fc.mute && fc.keyframes.length) curves++;
    const drivers = doc.listDrivers().filter((d) => !d.mute).length;
    expect(bones).toBeGreaterThan(20);
    expect(frameInputCacheBytes(doc)).toBe(
      FRAME_INPUT_BYTES_PER_OBJECT * doc.objectIds().length +
        FRAME_INPUT_BYTES_PER_POSE_BONE * bones +
        FRAME_INPUT_BYTES_PER_CURVE * (curves + drivers),
    );
    expect(input.bytes).toBe(frameInputCacheBytes(doc));
  });

  it('find the keys of a curve stored out of frame order', () => {
    const { doc, ids } = scene;
    const stored = doc.map('fcurves').get(`object:${ids.sheet}:location:1`) as FCurve;
    expect(stored.keyframes[0].frame).toBe(50);
    const keys = frameInput(doc).keys(stored);
    expect(keys.map((k) => k.frame)).toEqual([1, 20, 50]);
    expect(stored.keyframes[0].frame).toBe(50);
    const at20 = new FrameState(doc, 20).get<{ location: number[] }>('object', ids.sheet)!.location[1];
    expect(at20).toBe(2);
  });
});

describe('the reading of a document', () => {
  function keyed() {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 2, 3] });
    doc.setFCurve(
      key(a, 'location', 0, [
        [1, 0],
        [11, 10],
      ]),
    );
    return { doc, a };
  }
  const xAt = (doc: SceneDoc, id: string, frame: number) =>
    new FrameState(doc, frame).get<{ location: number[] }>('object', id)?.location;

  it('is read again after every change, and dropped as soon as one starts', () => {
    const { doc, a } = keyed();
    expect(xAt(doc, a, 6)).toEqual([5, 2, 3]);
    expect(frameInputCacheBytes(doc)).toBeGreaterThan(0);
    doc.updateObject(a, { location: [1, 7, 3] });
    // the change dropped it: nothing is kept until a frame state reads the document again
    expect(frameInputCacheBytes(doc)).toBe(0);
    expect(xAt(doc, a, 6)).toEqual([5, 7, 3]);
    // dropped when a transaction starts, before it changes anything; one read during a transaction
    // is not kept past it (a later write of the transaction may have made it stale)
    doc.transact(() => {
      expect(frameInputCacheBytes(doc)).toBe(0);
      expect(xAt(doc, a, 6)).toEqual([5, 7, 3]);
      expect(frameInputCacheBytes(doc)).toBeGreaterThan(0);
    });
    expect(frameInputCacheBytes(doc)).toBe(0);
    doc.setFCurve(
      key(a, 'location', 0, [
        [1, 0],
        [11, 20],
      ]),
    );
    expect(xAt(doc, a, 6)).toEqual([10, 7, 3]);
    doc.removeFCurve(`object:${a}:location:0`);
    expect(xAt(doc, a, 6)).toEqual([1, 7, 3]);
    doc.removeObject(a);
    expect(xAt(doc, a, 6)).toBeUndefined();
  });

  it('sees every change made earlier in the same transaction, writes and deletions', () => {
    const { doc, a } = keyed();
    const b = doc.addObject({ type: 'EMPTY', name: 'B' });
    doc.transact(() => {
      expect(xAt(doc, a, 6)).toEqual([5, 2, 3]);
      doc.updateObject(a, { location: [0, 4, 0] });
      expect(xAt(doc, a, 6)).toEqual([5, 4, 0]);
      doc.updateObject(a, { location: [0, 5, 0] });
      expect(xAt(doc, a, 6)).toEqual([5, 5, 0]);
      doc.removeFCurve(`object:${a}:location:0`);
      expect(xAt(doc, a, 6)).toEqual([0, 5, 0]);
      doc.removeObject(b);
      expect(new FrameState(doc, 6).byId.has(b)).toBe(false);
      // reading twice without a change in between reads once
      const input = frameInput(doc);
      expect(frameInput(doc)).toBe(input);
    });
    expect(xAt(doc, a, 6)).toEqual([0, 5, 0]);
  });

  it("is up to date in the document's change listeners, and in edits they make in reaction", () => {
    const { doc, a } = keyed();
    const seen: number[][] = [];
    const tokens: (string | null)[] = [];
    let reacted = false;
    doc.onChange(() => {
      tokens.push(docChangeToken(doc));
      seen.push(xAt(doc, a, 1)!);
      if (reacted) return;
      reacted = true;
      // an edit in reaction to an edit: the listener's own transaction (its listeners run after this one)
      doc.updateObject(a, { location: [0, 9, 9] });
      seen.push(xAt(doc, a, 1)!);
    });
    xAt(doc, a, 1);
    const before = docChangeToken(doc);
    doc.updateObject(a, { location: [0, 3, 3] });
    expect(tokens[0]).not.toBe(before);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(seen).toEqual([
      [0, 3, 3],
      [0, 9, 9],
      [0, 9, 9],
    ]);
    expect(xAt(doc, a, 1)).toEqual([0, 9, 9]);
    // desk/shots.ts caches by the same token: shots read in a listener are the ones just written
    let shots = -1;
    doc.onChange(() => (shots = getShots(doc).length));
    setShots(doc, [{ name: 'One', frame_start: 1, frame_end: 24 }]);
    expect(shots).toBe(1);
  });

  it('follows undo and redo', () => {
    const { doc, a } = keyed();
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    expect(xAt(doc, a, 6)).toEqual([5, 2, 3]);
    doc.updateObject(a, { location: [0, 8, 8] });
    doc.setFCurve(
      key(a, 'location', 0, [
        [1, 0],
        [11, 100],
      ]),
    );
    expect(xAt(doc, a, 6)).toEqual([50, 8, 8]);
    undo.undo();
    expect(xAt(doc, a, 6)).toEqual([5, 8, 8]);
    undo.undo();
    expect(xAt(doc, a, 6)).toEqual([5, 2, 3]);
    undo.redo();
    undo.redo();
    expect(xAt(doc, a, 6)).toEqual([50, 8, 8]);
  });

  it("follows a peer's updates", () => {
    const { doc, a } = keyed();
    const peer = SceneDoc.fromUpdate(doc.encodeState());
    expect(xAt(peer, a, 6)).toEqual([5, 2, 3]);
    const vector = Y.encodeStateVector(peer.ydoc);
    doc.updateObject(a, { location: [0, -1, -1] });
    doc.setFCurve(
      key(a, 'location', 0, [
        [1, 0],
        [11, -10],
      ]),
    );
    peer.applyUpdate(Y.encodeStateAsUpdate(doc.ydoc, vector));
    expect(xAt(peer, a, 6)).toEqual([-5, -1, -1]);
    // and the peer's own frames, read in its own update's transaction
    let inside: number[] | undefined;
    peer.ydoc.on('afterTransaction', () => (inside = xAt(peer, a, 11)));
    doc.updateObject(a, { location: [0, 4, 4] });
    peer.applyUpdate(Y.encodeStateAsUpdate(doc.ydoc, Y.encodeStateVector(peer.ydoc)));
    expect(inside).toEqual([-10, 4, 4]);
  });

  it("sees a peer's writes and deletions applied inside a transaction, in the frames read after them", () => {
    const { doc, a } = keyed();
    const b = doc.addObject({ type: 'EMPTY', name: 'B' });
    const peer = SceneDoc.fromUpdate(doc.encodeState());
    const since = (vector: Uint8Array) => Y.encodeStateAsUpdate(doc.ydoc, vector);
    let vector = Y.encodeStateVector(doc.ydoc);
    // a new curve: insertions only
    doc.setFCurve(
      key(a, 'location', 1, [
        [1, 0],
        [11, 10],
      ]),
    );
    const insertion = since(vector);
    vector = Y.encodeStateVector(doc.ydoc);
    doc.updateObject(a, { location: [0, 6, 6] });
    const write = since(vector);
    vector = Y.encodeStateVector(doc.ydoc);
    doc.removeObject(b);
    const removal = since(vector);
    peer.transact(() => {
      expect(xAt(peer, a, 6)).toEqual([5, 2, 3]);
      // the peer's items integrate here: no local write in this transaction
      peer.applyUpdate(insertion);
      expect(xAt(peer, a, 6)).toEqual([5, 5, 3]);
      peer.applyUpdate(write);
      expect(xAt(peer, a, 6)).toEqual([5, 5, 6]);
      expect(new FrameState(peer, 6).byId.has(b)).toBe(true);
      peer.applyUpdate(removal);
      expect(new FrameState(peer, 6).byId.has(b)).toBe(false);
    });
  });

  it('is read once per evaluation of a document that keeps none, with a rigid body world or without', () => {
    const { doc, a } = keyed();
    for (const enabled of [true, false]) {
      doc.updateScene({ rigidbody_world: { ...doc.getScene().rigidbody_world, enabled } });
      const copy = uncached(doc);
      // a reading of a document that keeps none copies its F-curves (SceneDoc.listFCurves)
      const reads = vi.spyOn(copy, 'listFCurves');
      const ev = new SceneEvaluator(copy);
      expect([1, 6, 11].map((f) => ev.evaluate(f).byId.get(a)!.data.location[0])).toEqual([0, 5, 10]);
      expect(reads, `rigid body world ${enabled ? 'on' : 'off'}`).toHaveBeenCalledTimes(3);
    }
  });

  it('is not kept for a document whose Y.Doc is destroyed, which is read anew every time', () => {
    const { doc, a } = keyed();
    expect(xAt(doc, a, 6)).toEqual([5, 2, 3]);
    doc.ydoc.destroy();
    expect(frameInputCacheBytes(doc)).toBe(0);
    expect(docChangeToken(doc)).toBeNull();
    expect(xAt(doc, a, 6)).toEqual([5, 2, 3]);
    expect(frameInput(doc)).not.toBe(frameInput(doc));
    expect(frameInputCacheBytes(doc)).toBe(0);
  });
});

describe('the change token of a document', () => {
  it('changes with every transaction and every write within one, and only then', () => {
    const doc = SceneDoc.create({ empty: true });
    const t0 = docChangeToken(doc);
    expect(docChangeToken(doc)).toBe(t0);
    const a = doc.addObject({ type: 'EMPTY', name: 'A' });
    const t1 = docChangeToken(doc);
    expect(t1).not.toBe(t0);
    expect(docChangeToken(doc)).toBe(t1);
    const inside: (string | null)[] = [];
    doc.transact(() => {
      inside.push(docChangeToken(doc));
      inside.push(docChangeToken(doc));
      doc.updateObject(a, { location: [1, 0, 0] });
      inside.push(docChangeToken(doc));
      doc.map('objects').delete(a);
      inside.push(docChangeToken(doc));
    });
    expect(inside[0]).toBe(inside[1]);
    expect(new Set(inside).size).toBe(3);
    expect(new Set([t0, t1, ...inside, docChangeToken(doc)]).size).toBe(6);
  });
});

describe('the input frame states share', () => {
  let was: boolean;
  beforeAll(() => {
    was = setFrameInputFreezing(true);
  });
  afterAll(() => {
    setFrameInputFreezing(was);
  });

  it('is never written: evaluations, bakes and simulations of a frozen input run unchanged', () => {
    const { doc, ids } = richScene();
    const reference = uncached(doc);
    const ev = new SceneEvaluator(doc);
    const evRef = new SceneEvaluator(reference);
    for (const frame of [1, 2, 12, 30, 48, 72]) {
      expect(difference(evaluatedAt(ev, frame), evaluatedAt(evRef, frame)), `frame ${frame}`).toBeNull();
      expect(difference(frameStateAt(doc, frame), frameStateAt(reference, frame))).toBeNull();
    }
    const input = frameInput(doc);
    expect(Object.isFrozen(input.raw[0])).toBe(true);
    expect(Object.isFrozen(input.curves.values().next().value![0].keyframes[0])).toBe(true);
    // operators that sample frames read it too
    const run = operators(doc);
    run('anim.bake_transforms', { objects: [ids.follower, ids.child], frame_start: 1, frame_end: 24 });
    run('rigidbody.bake_to_keyframes', { objects: [ids.crate], frame_start: 1, frame_end: 20 });
    expect(new FrameState(doc, 10).world(ids.follower)).not.toBeNull();
  });

  it('throws on a write, and frame states hand out objects of their own', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 2, 3] });
    const input = frameInput(doc);
    const raw = input.rawById.get(a)!;
    expect(() => {
      raw.location[0] = 5;
    }).toThrow(TypeError);
    // a caller replacing what it got changes its own copy, not later frames
    const got = new FrameState(doc, 1).get<{ location: number[]; name: string }>('object', a)!;
    expect(got).not.toBe(raw);
    got.location = [9, 9, 9];
    got.name = 'Changed';
    expect(new FrameState(doc, 1).get<{ location: number[]; name: string }>('object', a)).toMatchObject({
      location: [1, 2, 3],
      name: 'A',
    });
  });
});

describe('a test run', () => {
  it('freezes what frame states share, so that code writing into it fails its tests', () => {
    // vitest.config.ts sets EVAL_FREEZE_INPUT=1 for the core, server and web projects: a write into an
    // evaluated object's nested values would otherwise change the later frames of its document
    expect(process.env.EVAL_FREEZE_INPUT).toBe('1');
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 2, 3] });
    const got = new FrameState(doc, 1).get<{ location: number[] }>('object', a)!;
    expect(() => {
      got.location[2] = 0;
    }).toThrow(TypeError);
    expect(new FrameState(doc, 2).get<{ location: number[] }>('object', a)!.location).toEqual([1, 2, 3]);
  });
});
