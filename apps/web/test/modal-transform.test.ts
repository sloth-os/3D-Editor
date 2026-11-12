import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FrameState,
  SceneDoc,
  axisAngle4,
  multiply4,
  createEditorState,
  createConstraint,
  createFCurve,
  createOperatorRegistry,
  defaultBone,
  defaultPoseBone,
  defaultSpline,
  defaultSplinePoint,
  evaluateScene,
  fcurveKey,
  insertKeyframe,
  type ConstraintData,
  type EditorState,
  type Mat4,
  type MeshData,
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
  const start = (kind: ModalKind, mouse = { x: 420, y: 280 }) =>
    new ModalTransform(
      engine as unknown as ViewportEngine,
      session as unknown as ProjectSession,
      kind,
      mouse,
    );
  /** Types the keys (an axis, digits) into a running modal transform. */
  const type = (m: ModalTransform, keys: string) => {
    for (const k of keys) {
      if ('XYZ'.includes(k)) m.setAxis(k as 'X' | 'Y' | 'Z', false);
      else m.typeKey(k);
    }
  };
  /**
   * Confirms the modal transform: the matrices its preview drew, then the world matrices the scene
   * evaluates after the operator it returns (`res`) ran, for the same objects.
   */
  const confirm = (m: ModalTransform) => {
    const preview = new Map(engine.overrides ?? []);
    const res = m.finish(true)!;
    run(res.operator, res.params);
    const fs = new FrameState(doc, state.frame);
    const after = new Map([...preview.keys()].map((id) => [id, fs.world(id)!]));
    return { preview, after, res };
  };
  /** The header the running modal transform shows. */
  const hud = () => session.view.hud.value;
  return { doc, state, engine, run, start, type, confirm, hud };
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

  it('a rigid body mid-simulation moves on from where the simulation shows it; cancelling changes nothing', () => {
    // Blender reads the location and rotation from the simulated matrix (ObjectToTransData) and
    // restores the channels on cancel (BKE_rigidbody_aftertrans_update)
    const t = setup();
    t.run('mesh.primitive_plane_add', { size: 20 });
    t.run('rigidbody.object_add', { type: 'PASSIVE' });
    t.run('mesh.primitive_cube_add', { location: [0, 0, 5], rotation: [0.3, 0, 0] });
    const id = t.state.activeId!;
    t.run('rigidbody.object_add', { type: 'ACTIVE' });
    t.state.frame = 30;
    const shown = evaluateScene(t.doc, 30).byId.get(id)!.worldMatrix;
    expect(Math.abs(shown[14] - 1)).toBeLessThan(1e-2);
    const before = JSON.stringify(t.doc.toSnapshot());
    const cancelled = t.start('translate');
    t.type(cancelled, 'X1');
    const moved = [shown[12] + 1, shown[13], shown[14]];
    expect(maxDiff(t.engine.overrides!.get(id)!, [...shown.slice(0, 12), ...moved, 1])).toBeLessThan(1e-12);
    expect(cancelled.finish(false)).toBe(null);
    expect(t.engine.overrides).toBe(null);
    expect(JSON.stringify(t.doc.toSnapshot())).toBe(before);
    const m = t.start('translate');
    t.type(m, 'X1');
    const { preview, after } = t.confirm(m);
    // the channels hold where it was put (the simulation then starts from there)
    expectSame(preview, after, new Map([[id, 'Cube']]));
    expect(maxDiff(t.doc.getObject(id)!.location, moved)).toBeLessThan(1e-12);
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

  it('G of a Follow Path follower moves it with the pointer: the offset goes through the path’s space', () => {
    const t = setup();
    const data = t.doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([10, 0, 0])] },
      ],
    });
    const path = t.doc.addObject({ type: 'CURVE', name: 'Path', data, rotation_euler: [0, 0, 90 * deg] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'F' });
    t.doc.updateObject(id, { constraints: [createConstraint('FOLLOW_PATH', { target: path })] });
    const before = new FrameState(t.doc, t.state.frame).world(id)!;
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const m = t.start('translate');
    t.type(m, 'X1');
    expect(
      maxDiff(t.engine.overrides!.get(id)!.slice(12, 15), [before[12] + 1, before[13], before[14]]),
    ).toBeLessThan(1e-12);
    const { preview, after } = t.confirm(m);
    expectSame(preview, after, new Map([[id, 'F']]));
    expect(maxDiff(t.doc.getObject(id)!.location, [0, -1, 0])).toBeLessThan(1e-12);
  });

  it('G and S of an object with Copy Transforms mixed Before Split read it without the constraint', () => {
    const t = setup();
    const target = t.doc.addObject({
      type: 'EMPTY',
      name: 'T',
      location: [2, 0, 0],
      rotation_euler: [0, 0, 90 * deg],
    });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    t.doc.updateObject(id, {
      constraints: [createConstraint('COPY_TRANSFORMS', { target, params: { mix_mode: 'BEFORE_SPLIT' } })],
    });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const before = new FrameState(t.doc, t.state.frame).world(id)!;
    const g = t.start('translate');
    t.type(g, 'X1');
    expect(
      maxDiff(t.engine.overrides!.get(id)!.slice(12, 15), [before[12] + 1, before[13], before[14]]),
    ).toBeLessThan(1e-12);
    const moved = t.confirm(g);
    expectSame(moved.preview, moved.after, new Map([[id, 'A']]));
    expect(t.doc.getObject(id)!.location).toEqual([2, 0, 0]);
    // S 2 about the 3D cursor at the origin: the origin read without the constraint, (2, 0, 0)
    t.state.pivotPoint = 'CURSOR';
    t.state.cursorLocation = [0, 0, 0];
    const s = t.start('resize');
    t.type(s, '2');
    const { preview, after } = t.confirm(s);
    expectSame(preview, after, new Map([[id, 'A']]));
    expect(maxDiff(t.doc.getObject(id)!.location, [4, 0, 0])).toBeLessThan(1e-12);
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

  it('R about the view axis previews exactly what confirming stores', () => {
    // transform.rotate normalizes the axis it is given again, which changes the last bits of this
    // view's axis: the preview builds its rotation the same way, so not one bit differs
    const t = setup();
    t.engine.camera.position.set(4, -6, 7);
    t.engine.camera.lookAt(0, 0, 0);
    t.engine.camera.updateMatrixWorld(true);
    const parent = t.doc.addObject({
      type: 'EMPTY',
      name: 'P',
      location: [1, 2, 0.5],
      rotation_euler: [0.4, 0.1, 0.9],
    });
    const child = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [0.5, 0, 1], parent });
    t.state.selectedIds = [parent];
    t.state.activeId = parent;
    const m = t.start('rotate');
    t.type(m, '30');
    const { preview, after } = t.confirm(m);
    expect([...preview.keys()].sort()).toEqual([parent, child].sort());
    for (const [id, w] of preview) expect(w).toEqual(after.get(id));
  });

  it('with auto keying, previews the values confirming keys, which a driver loop reads', () => {
    // X's X scale is driven through a loop that reads its value before the driver (stored 1):
    // 0.1 · that + 1 = 1.1; auto keying keys the scale too, with the 1.1 it shows, so afterwards the
    // loop reads 1.1 and gives 1.11
    const t = setup();
    const x = t.doc.addObject({ type: 'EMPTY', name: 'X' });
    const material = t.doc.addMaterial({ name: 'Mat' });
    t.doc.setDriver({
      target_type: 'object',
      target_id: x,
      path: 'scale',
      index: 0,
      expression: 'v * 0.5 + 1',
      variables: [{ name: 'v', target_type: 'material', target_id: material, path: 'roughness', index: 0 }],
      mute: false,
    });
    t.doc.setDriver({
      target_type: 'material',
      target_id: material,
      path: 'roughness',
      index: 0,
      expression: 'v * 0.2',
      variables: [{ name: 'v', target_type: 'object', target_id: x, path: 'scale', index: 0 }],
      mute: false,
    });
    t.state.autoKeying = true;
    t.state.selectedIds = [x];
    t.state.activeId = x;
    const m = t.start('translate');
    t.type(m, 'X1');
    const { preview, after } = t.confirm(m);
    expect(after.get(x)![0]).toBeCloseTo(1.11, 12);
    expect(preview.get(x)).toEqual(after.get(x));
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
    // the baseline, measured here: what evaluating every object of the scene once costs, from the
    // document read once (as a transform reads it); the median of ten runs after three warm-ups
    const read = new FrameState(t.doc, t.state.frame);
    const runs: number[] = [];
    for (let k = 0; k < 13; k++) {
      const t0 = performance.now();
      const fs = new FrameState(t.doc, t.state.frame, null, { base: read });
      for (const o of fs.objects) fs.world(o.id);
      runs.push(performance.now() - t0);
    }
    const scene = runs.slice(3).sort((x, y) => x - y)[5];
    t.state.selectedIds = ids;
    t.state.activeId = ids[0];
    const m = t.start('rotate');
    const moves = 50;
    const t0 = performance.now();
    for (let k = 0; k < moves; k++) m.update({ x: 420 + k, y: 280 + k / 2 }, { ctrl: false, shift: false });
    const perMove = (performance.now() - t0) / moves;
    expect(t.engine.overrides!.size).toBe(600);
    // about one evaluation of the scene per move: measured 0.87–1.13 times the scene's evaluation in
    // plain runs and 0.93–1.17 under coverage (five runs each; 2.8–5.3 ms per move)
    expect(perMove).toBeLessThan(scene * 4);
    m.finish(false);
  });

  it('stays cheap in a scene with a dependency cycle, unless the moved objects touch the cycle', () => {
    // 300 objects, each with a child, and two objects whose Copy Location constraints read each other
    const t = setup();
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = t.doc.addObject({ type: 'EMPTY', name: `E${i}`, location: [i % 20, Math.floor(i / 20), 0] });
      t.doc.addObject({ type: 'EMPTY', name: `C${i}`, location: [0, 0, 1], parent: id });
      ids.push(id);
    }
    const a = t.doc.addObject({ type: 'EMPTY', name: 'CycA', location: [0, 0, 5] });
    const b = t.doc.addObject({ type: 'EMPTY', name: 'CycB', location: [1, 0, 5] });
    t.doc.updateObject(a, {
      constraints: [createConstraint('COPY_LOCATION', { target: b, influence: 0.5 })],
    });
    t.doc.updateObject(b, {
      constraints: [createConstraint('COPY_LOCATION', { target: a, influence: 0.5 })],
    });
    const perMove = (m: ModalTransform) => {
      const moves = 20;
      const t0 = performance.now();
      for (let k = 0; k < moves; k++) m.update({ x: 420 + k, y: 280 + k / 2 }, { ctrl: false, shift: false });
      return (performance.now() - t0) / moves;
    };
    // the baseline, measured here: what evaluating every object of the scene once costs, from the
    // document read once (as a transform reads it)
    const read = new FrameState(t.doc, t.state.frame);
    const evaluate = () => {
      const fs = new FrameState(t.doc, t.state.frame, null, { base: read });
      for (const o of fs.objects) fs.world(o.id);
    };
    const runs: number[] = [];
    for (let k = 0; k < 13; k++) {
      const t0 = performance.now();
      evaluate();
      runs.push(performance.now() - t0);
    }
    // the median of the last ten runs (the first three warm up)
    const scene = runs.slice(3).sort((x, y) => x - y)[5];
    // the cycle does not touch the moved object: only it and its child are evaluated anew
    t.state.selectedIds = [ids[0]];
    t.state.activeId = ids[0];
    const m = t.start('rotate');
    const apart = perMove(m);
    expect(t.engine.overrides!.size).toBe(2);
    m.finish(false);
    // measured 0.030–0.053 times the scene's evaluation per move in plain runs and 0.019–0.026
    // under coverage (five runs each)
    expect(apart).toBeLessThan(scene / 4);
    // moving an object on the cycle evaluates the whole scene in the document's order, as the
    // viewport does, so the preview shows what confirming shows
    t.state.selectedIds = [a];
    t.state.activeId = a;
    const g = t.start('translate');
    const onCycle = perMove(g);
    t.type(g, 'X1');
    const { preview, after } = t.confirm(g);
    expectSame(preview, after, new Map([...preview.keys()].map((id) => [id, t.doc.getObject(id)!.name])));
    expect(preview.has(b)).toBe(true);
    // measured 0.66–0.96 times the scene's evaluation per move in plain runs and 0.74–1.08 under
    // coverage (five runs each)
    expect(onCycle).toBeLessThan(scene * 4);
  });

  it('R in Edit Mode turns the vertices of a mesh on a dependency cycle about its origin as the viewport shows it', () => {
    // M is parented to bone B0 of a pose cycle (the IK target of B3's chain is parented to B2):
    // evaluated first, M shows no matrix; the viewport, which evaluates the objects by name, shows
    // it on B0
    const t = setup();
    const doc = t.doc;
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({
        bones: [
          defaultBone('B0', [0, 0, 0], [0, 0, 1]),
          { ...defaultBone('B2', [0, 0, 1], [0, 0, 2]), parent: 'B0', use_connect: true },
          { ...defaultBone('B3', [0, 0, 2], [0, 0.5, 2.8]), parent: 'B2', use_connect: true },
        ],
      }),
    });
    const target = doc.addObject({
      type: 'EMPTY',
      name: 'A_T',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'B2',
      location: [0.8, 0.3, 0],
    });
    const ik = createConstraint('IK' as ConstraintData['type'], { target });
    doc.updateObject(rig, {
      pose: {
        bones: {
          B0: { ...defaultPoseBone(), rotation_euler: [0.3, 0, 0] },
          B2: { ...defaultPoseBone(), rotation_euler: [0.2, 0.1, 0] },
          B3: { ...defaultPoseBone(), constraints: [{ ...ik, params: { chain_count: 0 } }] },
        },
      } as never,
    });
    t.run('mesh.primitive_cube_add', { name: 'M', size: 0.2 });
    const m = t.state.activeId!;
    doc.updateObject(m, { parent: rig, parent_type: 'BONE', parent_bone: 'B0', location: [0.2, 0, 0.1] });
    t.run('object.mode_set', { mode: 'EDIT' });
    const shown = () => {
      const fs = new FrameState(doc, t.state.frame);
      for (const o of fs.objects) fs.world(o.id);
      return fs.world(m)!;
    };
    const world = (w: Mat4, p: ArrayLike<number>) =>
      Array.from(p, (_, i) => {
        const v = i - (i % 3);
        const k = i % 3;
        return w[k] * p[v] + w[4 + k] * p[v + 1] + w[8 + k] * p[v + 2] + w[12 + k];
      });
    const centroid = (p: number[]) =>
      [0, 1, 2].map((k) => p.filter((_, i) => i % 3 === k).reduce((a, b) => a + b, 0) / (p.length / 3));
    const origin = shown().slice(12, 15);
    const base = world(shown(), doc.getMesh(doc.getObject(m)!.data!)!.positions);
    // every vertex is selected: the pivot is the cube's origin, where the viewport shows it
    expect(maxDiff(centroid(base), origin)).toBeLessThan(1e-9);
    const r = t.start('rotate');
    t.type(r, 'Z90');
    const preview = world(shown(), (t.engine.meshOverrides.get(m) as MeshData).positions);
    expect(maxDiff(preview, base)).toBeGreaterThan(0.05);
    expect(maxDiff(centroid(preview), origin)).toBeLessThan(1e-9);
    const res = r.finish(true)!;
    t.run(res.operator, res.params);
    // confirming stores what the preview showed (the mesh keeps 32-bit floats)
    const stored = world(shown(), doc.getMesh(doc.getObject(m)!.data!)!.positions);
    expect(maxDiff(stored, preview)).toBeLessThan(1e-6);
  });
});

describe('an axis key pressed again constrains in the active object’s axes (LOCAL), a third time not at all', () => {
  /*
   * Blender 4.2's transform_event_modal_constraint (transform.cc) moves on to the next of the
   * transform's orientation slots on each press of the constraint in use (the scene's orientation,
   * GLOBAL by default; then LOCAL; then none), and the operators it confirms store orient_type LOCAL
   * with the value in those axes. The header names the orientation ("along local X"). Move, Rotate
   * and Scale do so here (transform.translate, transform.rotate and transform.resize with orient_type
   * LOCAL).
   */
  /** An empty turned 20° about X, 40° about Y and 30° about Z: its own X axis, in the world. */
  const turned = (t: ReturnType<typeof setup>) => {
    const id = t.doc.addObject({
      type: 'EMPTY',
      name: 'A',
      location: [1, 2, 3],
      rotation_euler: [20 * deg, 40 * deg, 30 * deg],
    });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const localX: Vec3 = [
      Math.cos(40 * deg) * Math.cos(30 * deg),
      Math.cos(40 * deg) * Math.sin(30 * deg),
      -Math.sin(40 * deg),
    ];
    return { id, localX };
  };
  const rotation = (w: readonly number[]) => [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => w[i]);

  it('G X X 2 moves 2 along the object’s own X axis: the header, the preview and transform.translate agree', () => {
    const t = setup();
    const { id, localX } = turned(t);
    const m = t.start('translate');
    t.type(m, 'X');
    expect(t.hud()).toContain('along global X');
    t.type(m, 'X');
    expect(t.hud()).toContain('along local X');
    t.type(m, '2');
    expect(t.hud()).toBe('D: 2.0000 m  0.0000 m  0.0000 m (2.0000 m)  along local X  [2]');
    const { preview, after, res } = t.confirm(m);
    expect(res).toEqual({
      operator: 'transform.translate',
      params: { value: [2, 0, 0], orient_type: 'LOCAL' },
    });
    // not one bit differs between what the preview drew and what the operator stored
    expect(preview.get(id)).toEqual(after.get(id));
    const location = t.doc.getObject(id)!.location;
    expect(maxDiff(location, [1 + 2 * localX[0], 2 + 2 * localX[1], 3 + 2 * localX[2]])).toBeLessThan(1e-12);
  });

  it('a third press of the key removes the constraint; another axis constrains in the global orientation again', () => {
    const t = setup();
    turned(t);
    const m = t.start('translate');
    t.type(m, 'XXX');
    expect(m.axis).toBeNull();
    expect(t.hud()).not.toMatch(/along|locking/);
    t.type(m, 'X');
    expect(t.hud()).toContain('along global X');
    t.type(m, 'Y');
    expect(t.hud()).toContain('along global Y');
    t.type(m, 'Y');
    expect(t.hud()).toContain('along local Y');
    t.type(m, 'Z');
    expect(t.hud()).toContain('along global Z');
    m.setAxis('Z', true);
    expect(t.hud()).toContain('locking global Z');
    m.setAxis('Z', true);
    expect(t.hud()).toContain('locking local Z');
    m.setAxis('Z', true);
    expect(m.axis).toBeNull();
    t.type(m, '2');
    // without a constraint a typed value moves along the world's X axis
    expect(m.finish(true)).toEqual({ operator: 'transform.translate', params: { value: [2, 0, 0] } });
  });

  it('R X X 30 turns 30° about the object’s own X axis (transform.rotate, orient_type LOCAL)', () => {
    const t = setup();
    const { id } = turned(t);
    const before = t.doc.worldMatrix(id);
    const m = t.start('rotate');
    t.type(m, 'XX30');
    expect(t.hud()).toBe('Rot: 30.00°  along local X  [30]');
    const { preview, after, res } = t.confirm(m);
    expect(res.params).toEqual({
      value: 30 * deg,
      orient_axis: 'X',
      orient_type: 'LOCAL',
      center: [1, 2, 3],
    });
    expect(preview.get(id)).toEqual(after.get(id));
    // turning about the object's own X axis: its rotation followed by 30° about X
    const expected = multiply4(before, axisAngle4([1, 0, 0], 30 * deg));
    expect(maxDiff(rotation(after.get(id)!), rotation(expected))).toBeLessThan(1e-12);
  });

  it('S X X 2 scales 2 along the object’s own X axis (transform.resize, orient_type LOCAL); a third press removes it', () => {
    const t = setup();
    const { id } = turned(t);
    const m = t.start('resize');
    t.type(m, 'X');
    expect(t.hud()).toContain('along global X');
    t.type(m, 'X');
    expect(t.hud()).toContain('along local X');
    t.type(m, '2');
    expect(t.hud()).toBe('Scale X: 2.0000  Y: 1.0000  Z: 1.0000  along local X  [2]');
    const { preview, after, res } = t.confirm(m);
    expect(res).toEqual({
      operator: 'transform.resize',
      params: { value: [2, 1, 1], orient_type: 'LOCAL', center: [1, 2, 3] },
    });
    expect(preview.get(id)).toEqual(after.get(id));
    // along its own X axis: the scale of X doubles, the rotation and the location stay
    const o = t.doc.getObject(id)!;
    expect(maxDiff(o.scale, [2, 1, 1])).toBeLessThan(1e-12);
    expect(o.rotation_euler).toEqual([20 * deg, 40 * deg, 30 * deg]);
    expect(o.location).toEqual([1, 2, 3]);
    // a third press removes the constraint
    const s = t.start('resize');
    t.type(s, 'XXX');
    expect(s.axis).toBeNull();
    expect(t.hud()).not.toMatch(/along|locking/);
    s.finish(false);
  });

  it('S Shift+Y Shift+Y 3 scales in the plane of the object’s own X and Z axes; with the LOCAL orientation S Y is local', () => {
    const t = setup();
    const { id } = turned(t);
    const m = t.start('resize');
    m.setAxis('Y', true);
    m.setAxis('Y', true);
    t.type(m, '3');
    expect(t.hud()).toBe('Scale X: 3.0000  Y: 1.0000  Z: 3.0000  locking local Y  [3]');
    const { preview, after, res } = t.confirm(m);
    expect(res.params).toEqual({ value: [3, 1, 3], orient_type: 'LOCAL', center: [1, 2, 3] });
    expect(preview.get(id)).toEqual(after.get(id));
    expect(maxDiff(t.doc.getObject(id)!.scale, [3, 1, 3])).toBeLessThan(1e-12);
    // the editor's transform orientation LOCAL: the first press is local, the second global
    t.state.transformOrientation = 'LOCAL';
    const s = t.start('resize');
    t.type(s, 'Y');
    expect(t.hud()).toContain('along local Y');
    t.type(s, 'Y');
    expect(t.hud()).toContain('along global Y');
    t.type(s, '2');
    expect(s.finish(true)).toEqual({
      operator: 'transform.resize',
      params: { value: [1, 2, 1], center: [1, 2, 3] },
    });
  });

  it('G Shift+X Shift+X keeps a drag in the plane of the object’s own Y and Z axes (locking local X)', () => {
    const t = setup();
    const { id, localX } = turned(t);
    const m = t.start('translate');
    m.setAxis('X', true);
    m.setAxis('X', true);
    m.update({ x: 520, y: 240 }, { ctrl: false, shift: false });
    expect(t.hud()).toContain('locking local X');
    const start = t.doc.getObject(id)!.location;
    const { preview, after, res } = t.confirm(m);
    const value = res.params.value as number[];
    expect(res.params.orient_type).toBe('LOCAL');
    expect(value[0]).toBe(0);
    expect(Math.hypot(value[1], value[2])).toBeGreaterThan(0.1);
    expect(preview.get(id)).toEqual(after.get(id));
    const moved = t.doc.getObject(id)!.location.map((v, i) => v - start[i]);
    expect(Math.abs(moved[0] * localX[0] + moved[1] * localX[1] + moved[2] * localX[2])).toBeLessThan(1e-12);
  });

  it('locking local X of a sheared object drags in the plane through its own Y and Z axes', () => {
    // a child turned 45° under a parent scaled 3 along Y has axes that are not perpendicular: the
    // plane holds its Y and Z axes (Blender's constraint_plane_calc: their cross product is the
    // normal), which is not the plane perpendicular to its X axis
    const t = setup();
    const parent = t.doc.addObject({
      type: 'EMPTY',
      name: 'P',
      scale: [1, 3, 1],
      rotation_euler: [0, 0, 30 * deg],
    });
    const id = t.doc.addObject({
      type: 'EMPTY',
      name: 'C',
      location: [1, 0, 0],
      rotation_euler: [0, 0, 45 * deg],
      parent,
    });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    const w = t.doc.worldMatrix(id);
    const axis = (k: number) => new THREE.Vector3(w[k * 4], w[k * 4 + 1], w[k * 4 + 2]).normalize();
    expect(Math.abs(axis(0).dot(axis(1)))).toBeGreaterThan(0.1);
    const pivot = new THREE.Vector3(w[12], w[13], w[14]);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3().crossVectors(axis(1), axis(2)).normalize(),
      pivot,
    );
    const at = (x: number, y: number) => t.engine.rayAt(x, y).ray.intersectPlane(plane, new THREE.Vector3())!;
    const expected = at(520, 240).sub(at(420, 280));
    const m = t.start('translate');
    m.setAxis('X', true);
    m.setAxis('X', true);
    m.update({ x: 520, y: 240 }, { ctrl: false, shift: false });
    const { preview, after } = t.confirm(m);
    expect(preview.get(id)).toEqual(after.get(id));
    const moved = [12, 13, 14].map((i) => after.get(id)![i] - w[i]);
    expect(maxDiff(moved, expected.toArray())).toBeLessThan(1e-9);
  });

  it('Ctrl snaps a move along the local axis to whole grid steps along that axis', () => {
    const t = setup();
    const { id, localX } = turned(t);
    const m = t.start('translate');
    t.type(m, 'XX');
    m.update({ x: 560, y: 230 }, { ctrl: true, shift: false });
    const { res } = t.confirm(m);
    const value = res.params.value as number[];
    // the view is 10 m away: the grid's step is 1 m
    expect(value[0]).not.toBe(0);
    expect(value).toEqual([Math.round(value[0]), 0, 0]);
    const moved = t.doc.getObject(id)!.location.map((v, i) => v - [1, 2, 3][i]);
    expect(
      maxDiff(
        moved,
        localX.map((v) => v * value[0]),
      ),
    ).toBeLessThan(1e-12);
  });

  it('an axis drag that starts or ends over the pivot moves by the whole drag (a point at 0 along the axis counts)', () => {
    // regression: the drag along the axis was skipped when the pointer's point on the axis, at the
    // start or now, was the pivot itself (parameter 0). A front orthographic view: rays along +Y,
    // 100 px per metre, the origin under the pointer at (420, 280).
    const t = setup();
    t.engine.rayAt = (x: number, y: number) =>
      new THREE.Raycaster(
        new THREE.Vector3((x - 420) / 100, -10, (280 - y) / 100),
        new THREE.Vector3(0, 1, 0),
      );
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    // starts over the pivot (the origin)
    const m = t.start('translate');
    t.type(m, 'X');
    m.update({ x: 570, y: 300 }, { ctrl: false, shift: false });
    expect(t.hud()).toBe('D: 1.5000 m  0.0000 m  0.0000 m (1.5000 m)  along global X');
    const { preview, after, res } = t.confirm(m);
    expect(res).toEqual({ operator: 'transform.translate', params: { value: [1.5, 0, 0] } });
    expect(preview.get(id)).toEqual(after.get(id));
    expect(t.doc.getObject(id)!.location).toEqual([1.5, 0, 0]);
    // ends over the pivot (now at X 1.5, under x 570)
    const back = t.start('translate', { x: 720, y: 280 });
    t.type(back, 'X');
    back.update({ x: 570, y: 250 }, { ctrl: false, shift: false });
    expect(t.hud()).toBe('D: -1.5000 m  0.0000 m  0.0000 m (1.5000 m)  along global X');
    t.confirm(back);
    expect(t.doc.getObject(id)!.location).toEqual([0, 0, 0]);
  });

  it('a typed value with a plane constraint moves along the first axis the plane keeps (Blender’s constraintNumInput)', () => {
    // regression: G Shift+X 2 moved 2 along X, the axis the plane leaves out
    const t = setup();
    const { id } = turned(t);
    const m = t.start('translate');
    m.setAxis('X', true);
    t.type(m, '2');
    expect(t.hud()).toBe('D: 0.0000 m  2.0000 m  0.0000 m (2.0000 m)  locking global X  [2]');
    const { res } = t.confirm(m);
    expect(res.params).toEqual({ value: [0, 2, 0] });
    expect(maxDiff(t.doc.getObject(id)!.location, [1, 4, 3])).toBeLessThan(1e-12);
  });

  it('with the LOCAL transform orientation the first press is local, the second global', () => {
    const t = setup();
    const { id } = turned(t);
    t.state.transformOrientation = 'LOCAL';
    const m = t.start('translate');
    t.type(m, 'X');
    expect(t.hud()).toContain('along local X');
    t.type(m, 'X');
    expect(t.hud()).toContain('along global X');
    t.type(m, '2');
    const { res } = t.confirm(m);
    expect(res.params).toEqual({ value: [2, 0, 0] });
    expect(maxDiff(t.doc.getObject(id)!.location, [3, 2, 3])).toBeLessThan(1e-12);
  });

  it('in Edit Mode G X X 1 moves the selected vertices along the edited object’s own X axis', () => {
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [1, 2, 3], rotation: [0, 0, 90 * deg] });
    const id = t.state.activeId!;
    t.run('object.mode_set', { mode: 'EDIT' });
    const doc = t.doc;
    const positions = () => Array.from(doc.getMesh(doc.getObject(id)!.data!)!.positions);
    const before = positions();
    const m = t.start('translate');
    t.type(m, 'XX1');
    expect(t.hud()).toContain('along local X');
    const preview = Array.from((t.engine.meshOverrides.get(id) as MeshData).positions);
    const res = m.finish(true)!;
    expect(res).toEqual({
      operator: 'transform.translate',
      params: { value: [1, 0, 0], orient_type: 'LOCAL' },
    });
    t.run(res.operator, res.params);
    const after = positions();
    expect(maxDiff(after, preview)).toBeLessThan(1e-6);
    // the object is turned 90° about Z: its X axis is the world's Y, its local coordinates move by X 1
    expect(
      maxDiff(
        after.map((v, i) => v - before[i]),
        before.map((_, i) => (i % 3 === 0 ? 1 : 0)),
      ),
    ).toBeLessThan(1e-6);
  });

  it('with several objects, G, R and S X X move, turn and scale each along its own axes: the preview is what the operator stores', () => {
    // Blender's setLocalConstraint: several objects each in their own axes (A, the active one,
    // turned 90° about Z, so its X is the world's Y; B not turned)
    const scene = () => {
      const t = setup();
      const a = t.doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [0, 0, 90 * deg] });
      const b = t.doc.addObject({ type: 'EMPTY', name: 'B', location: [4, 0, 0] });
      t.state.selectedIds = [a, b];
      t.state.activeId = a;
      return {
        t,
        a,
        b,
        names: new Map([
          [a, 'A'],
          [b, 'B'],
        ]),
      };
    };
    {
      // S X X 2 about the median point (2, 0, 0): B doubles along the world's X, to (6, 0, 0)
      const { t, a, b, names } = scene();
      const m = t.start('resize');
      t.type(m, 'XX2');
      expect(t.hud()).toContain('along local X');
      const { preview, after, res } = t.confirm(m);
      expect(res.params).toEqual({ value: [2, 1, 1], orient_type: 'LOCAL', center: [2, 0, 0] });
      expectSame(preview, after, names);
      expect(maxDiff(t.doc.getObject(a)!.scale, [2, 1, 1])).toBeLessThan(1e-12);
      expect(maxDiff(t.doc.getObject(a)!.location, [0, 0, 0])).toBeLessThan(1e-12);
      expect(maxDiff(t.doc.getObject(b)!.scale, [2, 1, 1])).toBeLessThan(1e-12);
      expect(maxDiff(t.doc.getObject(b)!.location, [6, 0, 0])).toBeLessThan(1e-12);
    }
    {
      // G X X 1: A along the world's Y, B along the world's X
      const { t, a, b, names } = scene();
      const m = t.start('translate');
      t.type(m, 'XX1');
      const { preview, after } = t.confirm(m);
      expectSame(preview, after, names);
      expect(maxDiff(t.doc.getObject(a)!.location, [0, 1, 0])).toBeLessThan(1e-12);
      expect(maxDiff(t.doc.getObject(b)!.location, [5, 0, 0])).toBeLessThan(1e-12);
    }
    {
      // R X X 90 about (2, 0, 0): A about the world's Y axis, B about the world's X axis
      const { t, a, b, names } = scene();
      const m = t.start('rotate');
      t.type(m, 'XX90');
      const { preview, after } = t.confirm(m);
      expectSame(preview, after, names);
      const turnA = multiply4(axisAngle4([0, 1, 0], 90 * deg), axisAngle4([0, 0, 1], 90 * deg));
      // A's origin, (−2, 0, 0) from the pivot, turned 90° about Y: (0, 0, 2) from it
      expect(maxDiff(after.get(a)!, [...turnA.slice(0, 12), 2, 0, 2, 1])).toBeLessThan(1e-12);
      const turnB = axisAngle4([1, 0, 0], 90 * deg);
      expect(maxDiff(after.get(b)!, [...turnB.slice(0, 12), 4, 0, 0, 1])).toBeLessThan(1e-12);
    }
  });
});
