import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FrameState,
  SceneDoc,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  fcurveKey,
  insertKeyframe,
  type EditorState,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '@3d-editor/core';
import { ModalTransform, type ModalKind } from '../src/viewport/modal-transform';
import type { ViewportEngine } from '../src/viewport/engine';
import type { ProjectSession } from '../src/project/session';

/*
 * The modal G / R / S preview draws what confirming stores: each object's world matrix from the
 * channels the transform operator will store (Blender's Move, Rotate and Scale), its children
 * following that matrix, so the preview's matrices are the ones the scene evaluates after confirming
 * (the object does not jump on Enter). A stand-in engine records the matrix overrides the preview
 * sets; the operator the modal returns runs on the same document.
 */

const deg = Math.PI / 180;
const reg = createOperatorRegistry();

/** A camera looking down at the origin from (3, −8, 6) and a recording stand-in for the engine. */
function fakeEngine() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(3, -8, 6);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const engine = {
    camera,
    ev: null,
    shownPose: { distance: 10 },
    overrides: null as Map<string, number[]> | null,
    meshOverrides: new Map<string, unknown>(),
    project(v: THREE.Vector3) {
      const p = v.clone().project(camera);
      return { x: (p.x + 1) * 400, y: (1 - p.y) * 300 };
    },
    rayAt(x: number, y: number) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(x / 400 - 1, 1 - y / 300), camera);
      return rc;
    },
    viewPlanePoint(x: number, y: number, through: THREE.Vector3) {
      const normal = camera.getWorldDirection(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
      return this.rayAt(x, y).ray.intersectPlane(plane, new THREE.Vector3());
    },
    setMatrixOverrides(m: Map<string, number[]> | null) {
      this.overrides = m ? new Map(m) : null;
    },
    setMeshOverride(id: string, mesh: unknown) {
      if (mesh) this.meshOverrides.set(id, mesh);
      else this.meshOverrides.delete(id);
    },
  };
  return engine;
}

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const state: EditorState = createEditorState();
  const engine = fakeEngine();
  const session = { doc, state, view: { hud: { value: null as string | null } } };
  const ctx: OperatorContext = { doc, state, origin: doc.origin, source: 'test', report: () => undefined };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
  };
  const start = (kind: ModalKind) =>
    new ModalTransform(engine as unknown as ViewportEngine, session as unknown as ProjectSession, kind, {
      x: 420,
      y: 280,
    });
  /** Types the keys (an axis, digits) into a running modal transform. */
  const type = (m: ModalTransform, keys: string) => {
    for (const k of keys) {
      if ('XYZ'.includes(k)) m.setAxis(k as 'X' | 'Y' | 'Z', false);
      else m.typeKey(k);
    }
  };
  /**
   * Confirms the modal transform: the matrices its preview drew, then the world matrices the scene
   * evaluates after the operator it returns ran, for the same objects.
   */
  const confirm = (m: ModalTransform) => {
    const preview = new Map(engine.overrides ?? []);
    const res = m.finish(true)!;
    run(res.operator, res.params);
    const fs = new FrameState(doc, state.frame);
    const after = new Map([...preview.keys()].map((id) => [id, fs.world(id)!]));
    return { preview, after };
  };
  return { doc, state, engine, run, start, type, confirm };
}

const maxDiff = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));

function expectSame(preview: Map<string, Mat4>, after: Map<string, Mat4>, names: Map<string, string>) {
  expect(preview.size).toBeGreaterThan(0);
  for (const [id, m] of preview) expect(maxDiff(m, after.get(id)!), names.get(id)).toBeLessThan(1e-12);
}

describe('the modal preview draws the matrices the scene evaluates after confirming', () => {
  it('S X 2 of a cube turned 30° about Z: Blender’s scale of each axis, not a sheared box', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [0, 0, 30 * deg] });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const m = t.start('resize');
    t.type(m, 'X2');
    const preview = t.engine.overrides!.get(id)!;
    // the result keeps the rotation and scales X by 1.803 and Y by 1.323: no shear
    const x = preview.slice(0, 3);
    const y = preview.slice(4, 7);
    expect(Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2])).toBeLessThan(1e-12);
    expect(Math.hypot(...x)).toBeCloseTo(Math.sqrt(3.25), 12);
    const { preview: p, after } = t.confirm(m);
    expectSame(p, after, new Map([[id, 'A']]));
  });

  it('R of a child of an unevenly scaled parent, and of a parent and its child about Individual Origins', () => {
    for (const pivot of ['MEDIAN_POINT', 'INDIVIDUAL_ORIGINS'] as const) {
      const t = setup();
      const p = t.doc.addObject({
        type: 'EMPTY',
        name: 'P',
        location: [1, 0, 0],
        rotation_euler: [0, 0, 45 * deg],
        scale: [2, 1, 1],
      });
      const c = t.doc.addObject({
        type: 'EMPTY',
        name: 'C',
        location: [0.5, 1, 0],
        rotation_euler: [0.2, 0.1, 0.3],
        parent: p,
      });
      const g = t.doc.addObject({ type: 'EMPTY', name: 'G', location: [0, 0, 1], parent: c });
      t.state.selectedIds = pivot === 'MEDIAN_POINT' ? [c] : [p, c];
      t.state.activeId = c;
      t.state.pivotPoint = pivot;
      const m = t.start('rotate');
      t.type(m, 'Z40');
      const { preview, after } = t.confirm(m);
      const names = new Map([
        [p, 'P'],
        [c, 'C'],
        [g, 'G'],
      ]);
      expect([...preview.keys()].sort(), pivot).toEqual(
        (pivot === 'MEDIAN_POINT' ? [c, g] : [p, c, g]).sort(),
      );
      expectSame(preview, after, names);
    }
  });

  it('G of an object parented to a posed bone and of a child of an animated parent', () => {
    const t = setup();
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.state.activeId!;
    t.run('pose.bone_transform_set', { object: arm, bone: 'Bone', rotation_euler: [0.4, 0, 0.7] });
    t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
    const cube = t.state.activeId!;
    t.state.selectedIds = [cube, arm];
    t.state.activeId = arm;
    t.run('object.parent_set', { type: 'BONE' });
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
    let fc = createFCurve({ target_type: 'object', target_id: p, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 90 * deg, 'LINEAR');
    t.doc.setFCurve(fc);
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [2, 0, 0], parent: p });
    t.state.frame = 6;
    t.state.selectedIds = [cube, c];
    t.state.activeId = cube;
    const m = t.start('translate');
    t.type(m, 'Y1');
    const { preview, after } = t.confirm(m);
    expectSame(
      preview,
      after,
      new Map([
        [cube, 'cube'],
        [c, 'C'],
      ]),
    );
  });

  it('an animated object with auto keying starts from where it shows at the frame', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.state.autoKeying = true;
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const m = t.start('translate');
    t.type(m, 'Y1');
    expect(maxDiff(t.engine.overrides!.get(id)!.slice(12, 15), [5, 1, 0])).toBeLessThan(1e-12);
    const { preview, after } = t.confirm(m);
    expectSame(preview, after, new Map([[id, 'A']]));
    const key = t.doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 }))!
      .keyframes.find((k) => k.frame === 6)!;
    expect(key.value).toBe(5);
  });

  it('an animated object without auto keying keeps where it is moved: the animated channels are keyed at the frame', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const m = t.start('translate');
    t.type(m, 'X1');
    expect(maxDiff(t.engine.overrides!.get(id)!.slice(12, 15), [6, 0, 0])).toBeLessThan(1e-12);
    const { preview, after } = t.confirm(m);
    expectSame(preview, after, new Map([[id, 'A']]));
    const key = t.doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 }))!
      .keyframes.find((k) => k.frame === 6)!;
    expect(key.value).toBe(6);
  });

  it('a constrained object previews with its constraint, as the scene evaluates it; cancelling restores it', () => {
    // Copy Location from a target: the object stays on the target however it is moved
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [4, 0, 0] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [0, 0, 10 * deg] });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    t.run('object.constraint_add', { type: 'COPY_LOCATION', target });
    // cancelling (Esc, right click) draws every object as before and changes nothing
    const before = JSON.stringify(t.doc.toSnapshot());
    const cancelled = t.start('translate');
    t.type(cancelled, 'Z45');
    expect(maxDiff(t.engine.overrides!.get(id)!.slice(12, 15), [4, 0, 0])).toBeLessThan(1e-12);
    expect(cancelled.finish(false)).toBe(null);
    expect(t.engine.overrides).toBe(null);
    expect(JSON.stringify(t.doc.toSnapshot())).toBe(before);
    const m = t.start('rotate');
    t.type(m, 'X30');
    expect(maxDiff(t.engine.overrides!.get(id)!.slice(12, 15), [4, 0, 0])).toBeLessThan(1e-12);
    const { preview, after } = t.confirm(m);
    expectSame(preview, after, new Map([[id, 'A']]));
  });

  it('Ctrl increments and typed values preview what the operator then stores', () => {
    const t = setup();
    const id = t.doc.addObject({
      type: 'EMPTY',
      name: 'A',
      location: [0.2, 0.1, 0],
      rotation_euler: [0, 0, 30 * deg],
      scale: [1, 2, 1],
    });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    // S along the world X axis with Ctrl (steps of 0.1) of an object turned 30° about Z: Blender's
    // Scale changes the scale of each of its axes and keeps it unsheared
    const m = t.start('resize');
    m.setAxis('X', false);
    m.update({ x: 470, y: 330 }, { ctrl: true, shift: false });
    const s = (m as unknown as { scaleValue: Vec3 }).scaleValue;
    expect([s[1], s[2]]).toEqual([1, 1]);
    expect(Math.abs(s[0] * 10 - Math.round(s[0] * 10))).toBeLessThan(1e-9);
    expect(Math.abs(s[0] - 1)).toBeGreaterThan(0.05);
    const scaled = t.confirm(m);
    expectSame(scaled.preview, scaled.after, new Map([[id, 'A']]));
    // R about X with Ctrl (steps of 5°), then a typed angle, which replaces the dragged one
    const r = t.start('rotate');
    r.setAxis('X', false);
    r.update({ x: 300, y: 200 }, { ctrl: true, shift: false });
    const steps = (r as unknown as { rotAngle: number }).rotAngle / (5 * deg);
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    expect(Math.round(steps)).not.toBe(0);
    const dragged = new Map(t.engine.overrides!);
    t.type(r, '17');
    expect((r as unknown as { rotAngle: number }).rotAngle).toBeCloseTo(17 * deg, 15);
    expect(maxDiff(t.engine.overrides!.get(id)!, dragged.get(id)!)).toBeGreaterThan(1e-3);
    const turned = t.confirm(r);
    expectSame(turned.preview, turned.after, new Map([[id, 'A']]));
  });

  it('objects that read a moved object follow it in the preview: constraint owners, drivers, bone children, moved targets', () => {
    const t = setup();
    const e = t.doc.addObject({ type: 'EMPTY', name: 'E', location: [2, 0, 0] });
    // B copies E's location; F, moved too, copies it as well
    const b = t.doc.addObject({ type: 'EMPTY', name: 'B', location: [0, 5, 0] });
    const f = t.doc.addObject({ type: 'EMPTY', name: 'F', location: [0, -5, 0] });
    for (const owner of [b, f]) {
      t.state.selectedIds = [owner];
      t.state.activeId = owner;
      t.run('object.constraint_add', { type: 'COPY_LOCATION', target: e });
    }
    // D's location X is driven by E's location Y
    const d = t.doc.addObject({ type: 'EMPTY', name: 'D', location: [0, 0, 4] });
    t.doc.setDriver({
      target_type: 'object',
      target_id: d,
      path: 'location',
      index: 0,
      expression: 'y * 2',
      variables: [{ name: 'y', target_type: 'object', target_id: e, path: 'location', index: 1 }],
      mute: false,
    });
    // a bone that tracks E, and a cube parented to that bone
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.state.activeId!;
    t.run('pose.constraint_add', { object: arm, bone: 'Bone', type: 'DAMPED_TRACK', target: e });
    t.run('mesh.primitive_cube_add', { location: [0, 1, 2], size: 0.5 });
    const cube = t.state.activeId!;
    t.state.selectedIds = [cube, arm];
    t.state.activeId = arm;
    t.run('object.parent_set', { type: 'BONE' });
    t.state.selectedIds = [e, f];
    t.state.activeId = e;
    const before = new FrameState(t.doc, t.state.frame);
    const m = t.start('translate');
    t.type(m, 'Y3');
    const { preview, after } = t.confirm(m);
    const names = new Map([
      [e, 'E'],
      [b, 'B'],
      [f, 'F'],
      [d, 'D'],
      [cube, 'cube'],
    ]);
    expect([...preview.keys()].filter((id) => names.has(id)).sort()).toEqual([...names.keys()].sort());
    expectSame(preview, after, names);
    // each of them moved
    for (const id of [b, f, d, cube])
      expect(maxDiff(after.get(id)!, before.world(id)!), names.get(id)).toBeGreaterThan(0.1);
    expect(maxDiff(after.get(f)!.slice(12, 15), [2, 3, 0])).toBeLessThan(1e-12);
  });

  it('a channel a driver sets stays as the driver sets it, in the preview as after confirming', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    t.doc.setDriver({
      target_type: 'object',
      target_id: id,
      path: 'rotation_euler',
      index: 2,
      expression: '0.3',
      variables: [],
      mute: false,
    });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const m = t.start('rotate');
    t.type(m, 'Z40');
    const { preview, after } = t.confirm(m);
    expectSame(preview, after, new Map([[id, 'A']]));
    expect(Math.atan2(after.get(id)![1], after.get(id)![0])).toBeCloseTo(0.3, 12);
  });

  it('moving an IK pole target moves the objects parented to the bones it bends', () => {
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 2, 2] });
    const pole = t.doc.addObject({ type: 'EMPTY', name: 'P', location: [2, 0, 1] });
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.state.activeId!;
    t.run('pose.ik_add', { object: arm, bone: 'Bone', target, pole_target: pole, chain_count: 1 });
    t.run('mesh.primitive_cube_add', { location: [1, 0, 1], size: 0.2 });
    const cube = t.state.activeId!;
    t.state.selectedIds = [cube, arm];
    t.state.activeId = arm;
    t.run('object.parent_set', { type: 'BONE' });
    t.state.selectedIds = [pole];
    t.state.activeId = pole;
    const before = new FrameState(t.doc, t.state.frame).world(cube)!;
    const m = t.start('translate');
    t.type(m, 'Y3');
    const { preview, after } = t.confirm(m);
    const names = new Map([
      [pole, 'P'],
      [cube, 'cube'],
    ]);
    expect([...preview.keys()].filter((id) => names.has(id)).sort()).toEqual([...names.keys()].sort());
    expectSame(preview, after, names);
    expect(maxDiff(after.get(cube)!, before)).toBeGreaterThan(0.1);
  });

  it('moving an armature moves the objects parented to its bones and their children, animated ones included', () => {
    const t = setup();
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.state.activeId!;
    t.run('pose.bone_transform_set', { object: arm, bone: 'Bone', rotation_euler: [0.4, 0, 0.7] });
    t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
    const cube = t.state.activeId!;
    t.state.selectedIds = [cube, arm];
    t.state.activeId = arm;
    t.run('object.parent_set', { type: 'BONE' });
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [0, 0, 1], parent: cube });
    let fc = createFCurve({ target_type: 'object', target_id: c, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 4, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.state.selectedIds = [arm];
    t.state.activeId = arm;
    const m = t.start('rotate');
    t.type(m, 'Z35');
    const { preview, after } = t.confirm(m);
    const names = new Map([
      [arm, 'armature'],
      [cube, 'cube'],
      [c, 'C'],
    ]);
    expect([...preview.keys()].sort()).toEqual([...names.keys()].sort());
    expectSame(preview, after, names);
  });

  it('a child with a constraint in its local space follows its moved parent as the scene evaluates it', () => {
    const t = setup();
    const p = t.doc.addObject({
      type: 'EMPTY',
      name: 'P',
      rotation_euler: [0, 0, 40 * deg],
      scale: [2, 1, 1],
    });
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [1, 0.5, 0], parent: p });
    t.state.selectedIds = [c];
    t.state.activeId = c;
    t.run('object.constraint_add', {
      type: 'LIMIT_LOCATION',
      params: { use_max_x: true, max_x: 0.5, owner_space: 'LOCAL' },
    });
    t.state.selectedIds = [p];
    t.state.activeId = p;
    const m = t.start('resize');
    t.type(m, 'X3');
    const { preview, after } = t.confirm(m);
    expectSame(
      preview,
      after,
      new Map([
        [p, 'P'],
        [c, 'C'],
      ]),
    );
  });

  it('Individual Origins: the rotation center is the parent’s origin, a selected child turns about its own', () => {
    const t = setup();
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [3, 0, 0], parent: p });
    t.state.selectedIds = [p, c];
    t.state.activeId = p;
    t.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
    const m = t.start('rotate');
    // Blender's calculateCenterMedian leaves out the kept child (TD_NOCENTER)
    expect(m.pivot.toArray()).toEqual([0, 0, 0]);
    t.type(m, 'Z90');
    const { preview, after } = t.confirm(m);
    expectSame(
      preview,
      after,
      new Map([
        [p, 'P'],
        [c, 'C'],
      ]),
    );
    expect(maxDiff(after.get(c)!.slice(12, 15), [0, 3, 0])).toBeLessThan(1e-12);
  });

  it('S of an object with Copy Transforms mixed Before scales about its origin as Blender reads it for Scale', () => {
    // Blender switches the constraint off for Scale (constraints_list_needinv), so the pivot is the
    // origin without it; for Move it is part of the space and the origin where it is shown
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 4, 0] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    const other = t.doc.addObject({ type: 'EMPTY', name: 'O', location: [3, 0, 0] });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    t.run('object.constraint_add', { type: 'COPY_TRANSFORMS', target, params: { mix_mode: 'BEFORE' } });
    t.state.selectedIds = [id, other];
    t.state.pivotPoint = 'ACTIVE_ELEMENT';
    const moved = t.start('translate');
    expect(maxDiff(moved.pivot.toArray(), [1, 4, 0])).toBeLessThan(1e-12);
    moved.finish(false);
    const m = t.start('resize');
    expect(maxDiff(m.pivot.toArray(), [1, 0, 0])).toBeLessThan(1e-12);
    t.type(m, '2');
    const { preview, after } = t.confirm(m);
    expectSame(
      preview,
      after,
      new Map([
        [id, 'A'],
        [other, 'O'],
      ]),
    );
    // the other object scaled about [1, 0, 0]: its origin went from x 3 to x 5
    expect(maxDiff(after.get(other)!.slice(12, 15), [5, 0, 0])).toBeLessThan(1e-12);
  });

  it('is cheap per pointer move with hundreds of selected objects', () => {
    // 300 selected objects, each with a child: the matrices of 600 objects per move
    const t = setup();
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = t.doc.addObject({
        type: 'EMPTY',
        name: `E${i}`,
        location: [i % 20, Math.floor(i / 20), 0],
        rotation_euler: [0.1 * i, 0.2, 0.3],
        scale: [1 + (i % 3), 1, 0.5],
      });
      t.doc.addObject({ type: 'EMPTY', name: `C${i}`, location: [0, 0, 1], parent: id });
      ids.push(id);
    }
    t.state.selectedIds = ids;
    t.state.activeId = ids[0];
    const m = t.start('rotate');
    const moves = 50;
    const t0 = performance.now();
    for (let k = 0; k < moves; k++) m.update({ x: 420 + k, y: 280 + k / 2 }, { ctrl: false, shift: false });
    const perMove = (performance.now() - t0) / moves;
    expect(t.engine.overrides!.size).toBe(600);
    // measured 2.1–3.4 ms per move in plain runs (five runs) and 3.3–4.1 ms under coverage (three
    // runs); the bound is one frame at 60 Hz
    expect(perMove).toBeLessThan(16);
    m.finish(false);
  });
});
