import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  evaluateFCurve,
  fcurveKey,
  insertKeyframe,
  type Mat4,
  type OperatorContext,
} from '../src';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const undoManager = () =>
    new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });
  return { doc, reg, ctx, run, ok, reports, undoManager };
}

function key(
  doc: SceneDoc,
  id: string,
  path: string,
  index: number,
  keys: [number, number][],
  interpolation: 'LINEAR' | 'BEZIER' = 'LINEAR',
) {
  let fc = createFCurve({ target_type: 'object', target_id: id, path, index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, interpolation);
  doc.setFCurve(fc);
}

const worldAt = (doc: SceneDoc, id: string, frame: number): Mat4 =>
  new SceneEvaluator(doc).evaluate(frame).byId.get(id)!.worldMatrix;

function expectMatrixClose(a: Mat4, b: Mat4, digits = 6) {
  for (let i = 0; i < 16; i++) expect(a[i], `element ${i}`).toBeCloseTo(b[i], digits);
}

describe('anim.extrapolation_set', () => {
  it('switches extrapolation of the selected objects (optionally one property, or with data)', () => {
    const { doc, ctx, ok, run } = setup();
    const lightData = doc.addLight({ name: 'L' });
    const id = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: lightData });
    key(doc, id, 'location', 0, [
      [1, 0],
      [11, 10],
    ]);
    key(doc, id, 'rotation_euler', 2, [
      [1, 0],
      [11, 1],
    ]);
    doc.setFCurve(
      insertKeyframe(
        insertKeyframe(
          createFCurve({ target_type: 'light', target_id: lightData, path: 'energy', index: 0 }),
          1,
          0,
        ),
        11,
        10,
      ),
    );
    ctx.state.selectedIds = [id];
    const loc = () => new SceneEvaluator(doc).evaluate(16).byId.get(id)!.data.location[0];
    expect(ok('anim.extrapolation_set', { type: 'CYCLIC' })).toEqual({
      type: 'CYCLIC',
      fcurves: 2,
      changed: 2,
    });
    expect(loc()).toBeCloseTo(5, 9);
    ok('anim.extrapolation_set', { type: 'LINEAR', path: 'location' });
    expect(loc()).toBeCloseTo(15, 9);
    expect(
      doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'rotation_euler', index: 2 }))!
        .extrapolation,
    ).toBe('CYCLIC');
    const withData = ok('anim.extrapolation_set', {
      objects: ['Lamp'],
      type: 'CONSTANT',
      include_data: true,
    });
    expect(withData.fcurves).toBe(3);
    expect(loc()).toBe(10);
    expect(doc.listFCurves(lightData)[0].extrapolation).toBe('CONSTANT');
    expect(run('anim.extrapolation_set', { type: 'CYCLIC', path: 'scale' }).error).toMatch(
      /No animation curves for 'scale'/,
    );
    ctx.state.selectedIds = [];
    expect(run('anim.extrapolation_set', { type: 'CYCLIC' }).error).toMatch(/No objects selected/);
  });

  it('is one undo step for all curves', () => {
    const { doc, ok, undoManager } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'Bob' });
    for (let i = 0; i < 3; i++)
      key(doc, id, 'location', i, [
        [1, 0],
        [11, i + 1],
      ]);
    const um = undoManager();
    expect(ok('anim.extrapolation_set', { objects: ['Bob'], type: 'LINEAR' }).changed).toBe(3);
    expect(doc.listFCurves(id).every((fc) => fc.extrapolation === 'LINEAR')).toBe(true);
    um.undo();
    expect(doc.listFCurves(id).every((fc) => fc.extrapolation === 'CONSTANT')).toBe(true);
    um.redo();
    expect(doc.listFCurves(id).every((fc) => fc.extrapolation === 'LINEAR')).toBe(true);
  });
});

describe('anim.keyframes_insert_many', () => {
  it('keys one channel from frame and value lists', () => {
    const { doc, ctx, ok } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'E' });
    ctx.state.activeId = id;
    const res = ok('anim.keyframes_insert_many', {
      path: 'location',
      index: 2,
      frames: [10, 1, 5],
      values: [1, 0, 2],
      interpolation: 'LINEAR',
    });
    expect(res).toEqual({
      fcurve: `object:${id}:location:2`,
      inserted: 3,
      keyframes: 3,
      frame_range: [1, 10],
    });
    const z = (f: number) => new SceneEvaluator(doc).evaluate(f).byId.get(id)!.data.location[2];
    expect(z(3)).toBe(1);
    expect(z(7.5)).toBe(1.5);
    // merge: a key within 0.001 frames is replaced, the others stay
    const merged = ok('anim.keyframes_insert_many', {
      target: 'E',
      path: 'location',
      index: 2,
      frames: [5.0004, 20],
      values: [4, 0],
    });
    expect(merged.keyframes).toBe(4);
    expect(doc.getFCurve(res.fcurve)!.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [1, 0],
      [5.0004, 4],
      [10, 1],
      [20, 0],
    ]);
    // replace + duplicate frames in one batch (the later one wins) + easing + extrapolation
    const replaced = ok('anim.keyframes_insert_many', {
      target: 'E',
      path: 'location',
      index: 2,
      frames: [0, 10, 10.0002],
      values: [0, 3, 8],
      interpolation: 'LINEAR',
      easing: 'EASE_IN',
      replace: true,
      extrapolation: 'CYCLIC',
    });
    expect(replaced.inserted).toBe(2);
    const fc = doc.getFCurve(res.fcurve)!;
    expect(fc.keyframes.map((k) => k.value)).toEqual([0, 8]);
    expect(fc.extrapolation).toBe('CYCLIC');
    expect(evaluateFCurve(fc, 5.0001)).toBeCloseTo(8 * 0.25, 3);
  });

  it('validates the channel and list lengths', () => {
    const { doc, ctx, run } = setup();
    ctx.state.activeId = doc.addObject({ type: 'EMPTY', name: 'E' });
    const err = (p: Record<string, unknown>) =>
      run('anim.keyframes_insert_many', { path: 'location', frames: [1, 2], values: [0, 1], ...p }).error;
    expect(err({ values: [1] })).toMatch(/frames \(2\) and values \(1\) must have the same length/);
    expect(err({ index: 3 })).toMatch(/Index 3 is out of range/);
    expect(err({ path: 'hide_select' })).toMatch(/not animatable/);
    expect(err({ path: 'location', target: 'nobody' })).toMatch(/not found/);
    expect(err({ frames: [], values: [] })).toMatch(/Invalid parameters/);
    expect(err({ values: [0, Number.NaN] })).toMatch(/Invalid parameters/);
  });

  it('handles large batches quickly as one undo step', () => {
    const { doc, ctx, ok, undoManager } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'E' });
    ctx.state.activeId = id;
    const um = undoManager();
    const frames = Array.from({ length: 20000 }, (_, i) => i);
    const t0 = performance.now();
    const res = ok('anim.keyframes_insert_many', {
      path: 'scale',
      index: 0,
      frames,
      values: frames.map((f) => Math.sin(f / 50)),
    });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(res.inserted).toBe(20000);
    um.undo();
    expect(doc.listFCurves(id)).toHaveLength(0);
  });
});

describe('anim.turntable', () => {
  function cubeScene() {
    const s = setup();
    const mesh = s.doc.addMesh('Cube', createCube({ size: 2 }));
    const cube = s.doc.addObject({ type: 'MESH', name: 'Cube', data: mesh, location: [1, 2, 0.5] });
    s.doc.updateScene({ frame_start: 1, frame_end: 100 });
    return { ...s, cube };
  }
  const position = (m: Mat4) => [m[12], m[13], m[14]];

  it('orbits a new camera around the target in a seamless linear loop', () => {
    const { doc, ok } = cubeScene();
    const res = ok('anim.turntable', { target: 'Cube' });
    expect(res.center).toEqual([1, 2, 0.5]);
    expect(res.loop_frames).toBe(100);
    expect(doc.getScene().camera).toBe(res.camera);
    const cam = doc.getObject(res.camera)!;
    expect(cam.type).toBe('CAMERA');
    expect(cam.parent).toBe(res.pivot);
    const r = res.radius;
    const h = res.height;
    // auto distance frames the bounding sphere (radius √3) for a 50 mm lens at 16:9
    const fov = 2 * Math.atan(Math.tan(Math.atan(18 / 50)) / (16 / 9));
    expect(Math.hypot(r, h)).toBeCloseTo((Math.sqrt(3) / Math.sin(fov / 2)) * 1.1, 6);
    expect(Math.atan2(h, r)).toBeCloseTo(0.3, 9);
    const at = (f: number) => position(worldAt(doc, res.camera, f));
    const start = at(1);
    expect(start[0]).toBeCloseTo(1, 9);
    expect(start[1]).toBeCloseTo(2 - r, 9);
    expect(start[2]).toBeCloseTo(0.5 + h, 9);
    const half = at(51);
    expect(half[0]).toBeCloseTo(1, 9);
    expect(half[1]).toBeCloseTo(2 + r, 9);
    const quarter = at(26); // counter-clockwise: -Y → +X
    expect(quarter[0]).toBeCloseTo(1 + r, 9);
    expect(quarter[1]).toBeCloseTo(2, 9);
    // seamless: frame_end + 1 equals frame_start, and it keeps looping
    const wrap = at(101);
    for (let i = 0; i < 3; i++) expect(wrap[i]).toBeCloseTo(start[i], 9);
    const later = at(151);
    for (let i = 0; i < 3; i++) expect(later[i]).toBeCloseTo(half[i], 9);
    // the camera looks at the centre (-Z axis) with +Y up and no roll
    for (const f of [1, 17, 51, 88]) {
      const m = worldAt(doc, res.camera, f);
      const p = position(m);
      const to = [1 - p[0], 2 - p[1], 0.5 - p[2]];
      const len = Math.hypot(to[0], to[1], to[2]);
      expect(-m[8]).toBeCloseTo(to[0] / len, 9);
      expect(-m[9]).toBeCloseTo(to[1] / len, 9);
      expect(-m[10]).toBeCloseTo(to[2] / len, 9);
      expect(m[2]).toBeCloseTo(0, 9); // camera X axis stays horizontal
    }
  });

  it('reuses an existing camera, runs clockwise and honours explicit placement', () => {
    const { doc, ok, reports } = cubeScene();
    const camData = doc.addCamera({ name: 'C' });
    const cam = doc.addObject({ type: 'CAMERA', name: 'Shot', data: camData, location: [9, 9, 9] });
    key(doc, cam, 'location', 0, [
      [1, 0],
      [10, 5],
    ]);
    doc.setDriver({
      target_type: 'object',
      target_id: cam,
      path: 'rotation_euler',
      index: 0,
      expression: '1',
      variables: [],
      mute: false,
    });
    const res = ok('anim.turntable', {
      camera: 'Shot',
      center: [0, 0, 1],
      radius: 4,
      height: 3,
      direction: 'CW',
      frame_start: 10,
      frame_end: 49,
      start_angle: 0,
      set_active_camera: false,
      set_frame_range: true,
    });
    expect(res.camera).toBe(cam);
    expect(res.removed_camera_animation).toEqual({ fcurves: 1, drivers: 1 });
    expect(doc.getScene().camera).toBeNull();
    expect(doc.getScene().frame_start).toBe(10);
    expect(doc.getScene().frame_end).toBe(49);
    const p = (f: number) => position(worldAt(doc, cam, f));
    expect(p(10)[0]).toBeCloseTo(4, 9);
    expect(p(10)[1]).toBeCloseTo(0, 9);
    expect(p(10)[2]).toBeCloseTo(4, 9);
    expect(p(20)[0]).toBeCloseTo(0, 9); // quarter turn clockwise: +X → -Y
    expect(p(20)[1]).toBeCloseTo(-4, 9);
    expect(reports.join()).not.toMatch(/constraints/);
  });

  it('frames the whole scene without a target and validates its inputs', () => {
    const { doc, ok, run, cube } = cubeScene();
    const res = ok('anim.turntable', {});
    expect(res.center).toEqual([1, 2, 0.5]);
    expect(run('anim.turntable', { camera: 'Cube' }).error).toMatch(/is a MESH object, not a camera/);
    expect(run('anim.turntable', { camera: 'Nope' }).error).toMatch(/Camera 'Nope' not found/);
    expect(run('anim.turntable', { target: 'Nope' }).error).toMatch(/Object 'Nope' not found/);
    expect(run('anim.turntable', { frame_start: 10, frame_end: 5 }).error).toMatch(/before frame_start/);
    expect(run('anim.turntable', { radius: 0 }).error).toMatch(/Invalid parameters/);
    void cube;
    void doc;
  });

  it('is one undo step', () => {
    const { doc, ok, undoManager } = cubeScene();
    const um = undoManager();
    ok('anim.turntable', { target: 'Cube' });
    expect(doc.listObjects()).toHaveLength(3);
    um.undo();
    expect(doc.listObjects()).toHaveLength(1);
    expect(doc.listFCurves()).toHaveLength(0);
    expect(doc.getScene().camera).toBeNull();
  });
});

describe('anim.bake_transforms', () => {
  function constrainedScene() {
    const s = setup();
    const target = s.doc.addObject({ type: 'EMPTY', name: 'Target' });
    key(s.doc, target, 'location', 0, [
      [1, -5],
      [21, 5],
    ]);
    key(
      s.doc,
      target,
      'location',
      1,
      [
        [1, 4],
        [11, -2],
        [21, 4],
      ],
      'BEZIER',
    );
    const follower = s.doc.addObject({ type: 'EMPTY', name: 'Follower', location: [0, 0, 3] });
    const camData = s.doc.addCamera({ name: 'C' });
    const cam = s.doc.addObject({ type: 'CAMERA', name: 'Cam', data: camData, location: [0, -10, 4] });
    s.ok('object.constraint_add', {
      object: 'Follower',
      type: 'COPY_LOCATION',
      target: 'Target',
      params: { use_z: false },
    });
    s.ok('object.track_set', { objects: ['Cam'], target: 'Target' });
    s.doc.updateScene({ frame_start: 1, frame_end: 21 });
    return { ...s, target, follower, cam };
  }

  it('reproduces constraint-driven motion with keyframes and clears the constraints', () => {
    const { doc, ok, follower, cam, undoManager } = constrainedScene();
    const frames = Array.from({ length: 21 }, (_, i) => i + 1);
    const before = new Map(frames.map((f) => [f, [worldAt(doc, follower, f), worldAt(doc, cam, f)]]));
    const um = undoManager();
    const res = ok('anim.bake_transforms', { objects: ['Follower', 'Cam'], clear_constraints: true });
    expect(res).toMatchObject({ frame_start: 1, frame_end: 21, frames: 21, cleared_constraints: 2, step: 1 });
    expect(res.objects.map((o: { keyframes: number }) => o.keyframes)).toEqual([189, 189]);
    expect(doc.getObject(follower)!.constraints).toEqual([]);
    expect(doc.getObject(cam)!.constraints).toEqual([]);
    for (const f of [...frames, 4.5]) {
      if (!before.has(f)) continue;
      expectMatrixClose(worldAt(doc, follower, f), before.get(f)![0]);
      expectMatrixClose(worldAt(doc, cam, f), before.get(f)![1]);
    }
    // continuous eulers
    const rz = doc.getFCurve(
      fcurveKey({ target_type: 'object', target_id: cam, path: 'rotation_euler', index: 2 }),
    )!.keyframes;
    for (let i = 1; i < rz.length; i++)
      expect(Math.abs(rz[i].value - rz[i - 1].value)).toBeLessThan(Math.PI / 2);
    um.undo();
    expect(doc.getObject(follower)!.constraints).toHaveLength(1);
    expect(doc.listFCurves(follower)).toHaveLength(0);
  });

  it('bakes relative to parents, or in world space with clear_parents', () => {
    const { doc, ok } = setup();
    const parent = doc.addObject({ type: 'EMPTY', name: 'Parent', location: [1, 0, 0] });
    key(doc, parent, 'rotation_euler', 2, [
      [1, 0],
      [11, Math.PI],
    ]);
    const child = doc.addObject({
      type: 'EMPTY',
      name: 'Child',
      parent,
      location: [2, 0, 0],
      scale: [1, 2, 1],
    });
    const other = doc.addObject({ type: 'EMPTY', name: 'Other', parent, location: [0, 3, 0] });
    doc.setDriver({
      target_type: 'object',
      target_id: child,
      path: 'location',
      index: 2,
      expression: 'frame / 10',
      variables: [],
      mute: false,
    });
    const before = [1, 4, 7, 11].map((f) => worldAt(doc, child, f));
    const beforeOther = [1, 4, 7, 11].map((f) => worldAt(doc, other, f));
    const rel = ok('anim.bake_transforms', {
      objects: ['Child'],
      frame_start: 1,
      frame_end: 11,
      step: 3,
      channels: ['location'],
    });
    expect(rel.removed_drivers).toBe(1);
    expect(rel.frames).toBe(4); // 1, 4, 7, 10
    expect(doc.getObject(child)!.parent).toBe(parent);
    expect(doc.listFCurves(child).map((f) => f.path)).toEqual(['location', 'location', 'location']);
    [1, 4, 7].forEach((f, i) => expectMatrixClose(worldAt(doc, child, f), before[i]));
    const world = ok('anim.bake_transforms', {
      objects: ['Other'],
      frame_start: 1,
      frame_end: 11,
      clear_parents: true,
      channels: ['location'],
    });
    expect(world.channels).toEqual(['location', 'rotation_euler', 'scale']);
    expect(doc.getObject(other)!.parent).toBeNull();
    [1, 4, 7, 11].forEach((f, i) => expectMatrixClose(worldAt(doc, other, f), beforeOther[i]));
  });

  it('removes F-curve modifiers of baked channels and keeps keys outside the range', () => {
    const { doc, ok, run } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'E' });
    key(doc, id, 'location', 0, [
      [-10, 7],
      [1, 0],
      [5, 4],
      [30, 9],
    ]);
    ok('anim.fmodifier_add', {
      target: 'E',
      path: 'location',
      index: 0,
      type: 'NOISE',
      params: { strength: 2 },
    });
    const noisy = [1, 2, 3, 4, 5].map((f) => worldAt(doc, id, f)[12]);
    const res = ok('anim.bake_transforms', {
      objects: ['E'],
      frame_start: 1,
      frame_end: 5,
      channels: ['location'],
    });
    expect(res.removed_modifiers).toBe(1);
    const fc = doc.getFCurve(
      fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 }),
    )!;
    expect(fc.modifiers).toBeUndefined();
    expect(fc.keyframes.map((k) => k.frame)).toEqual([-10, 1, 2, 3, 4, 5, 30]);
    [1, 2, 3, 4, 5].forEach((f, i) => expect(worldAt(doc, id, f)[12]).toBeCloseTo(noisy[i], 9));
    expect(run('anim.bake_transforms', { objects: ['E'], frame_start: 5, frame_end: 1 }).error).toMatch(
      /before frame_start/,
    );
    expect(run('anim.bake_transforms', { objects: ['E'], frame_start: 1, frame_end: 20000 }).error).toMatch(
      /Too many frames/,
    );
    expect(run('anim.bake_transforms', { objects: [] }).error).toMatch(/No objects selected/);
  });
});
