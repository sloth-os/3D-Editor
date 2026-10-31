import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  compose4,
  createConstraint,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  decompose4,
  defaultBone,
  defaultSpline,
  defaultSplinePoint,
  insertKeyframe,
  invert4,
  lookAt4,
  multiply4,
  translation4,
  type ConstraintData,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';

const loc = (m: Mat4): Vec3 => [m[12], m[13], m[14]];

function expectVec(a: readonly number[], b: readonly number[], digits = 5) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

function evaluator(doc: SceneDoc) {
  const ev = new SceneEvaluator(doc);
  return (frame = 1) => ev.evaluate(frame, { noPhysics: true });
}

function addConstraint(doc: SceneDoc, id: string, c: ConstraintData) {
  doc.updateObject(id, { constraints: [...doc.getObject(id)!.constraints, c] });
}

describe('constraints in scene evaluation', () => {
  it('aims the default camera at the cube through the operator registry and the evaluator', () => {
    const doc = SceneDoc.create();
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => {},
    };
    const r = reg.run<any>(ctx, 'object.constraint_add', {
      object: 'Camera',
      type: 'TRACK_TO',
      target: 'Cube',
    });
    expect(r.ok).toBe(true);
    const ev = evaluator(doc)();
    const cam = ev.activeCamera!;
    expect(cam.constraintErrors).toEqual([]);
    const eye = loc(cam.worldMatrix);
    expectVec(cam.worldMatrix, invert4(lookAt4(eye, [0, 0, 0], [0, 0, 1])));
    // the stored transform is untouched: constraints only change the evaluated matrix
    expect(doc.getObject(cam.id)!.rotation_euler).toEqual([1.109, 0, 0.815]);
  });

  it('never hangs or throws on dependency cycles and reports them', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [0, 0, 0] });
    const b = doc.addObject({ type: 'EMPTY', name: 'B', location: [5, 0, 0] });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', location: [0, 5, 0] });
    addConstraint(doc, a, createConstraint('TRACK_TO', { target: b }));
    addConstraint(doc, b, createConstraint('TRACK_TO', { target: a }));
    const ev = evaluator(doc)();
    const errors = ev.objects.flatMap((o) => o.constraintErrors);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/dependency cycle/);
    for (const o of ev.objects) expect(o.worldMatrix.every(Number.isFinite)).toBe(true);
    // a longer loop A → B → C → A
    addConstraint(doc, b, createConstraint('COPY_LOCATION', { target: c }));
    addConstraint(doc, c, createConstraint('COPY_ROTATION', { target: a }));
    const ev2 = evaluator(doc)();
    expect(ev2.objects.flatMap((o) => o.constraintErrors).length).toBeGreaterThan(0);
    // and a constraint targeting its own object
    addConstraint(doc, a, createConstraint('COPY_LOCATION', { target: a }));
    const self = evaluator(doc)().byId.get(a)!.constraintErrors;
    expect(self.map((e) => e.message)).toContain('A constraint cannot use its own object as target');
  });

  it('evaluates chains of constrained objects independent of evaluation order', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = doc.addObject({ type: 'EMPTY', name: 'Z-first', location: [1, 2, 3] });
    const middle = doc.addObject({ type: 'EMPTY', name: 'M-middle', location: [0, 0, 10] });
    const last = doc.addObject({ type: 'EMPTY', name: 'A-last' });
    addConstraint(
      doc,
      middle,
      createConstraint('COPY_LOCATION', { target: first, params: { use_z: false } }),
    );
    addConstraint(doc, last, createConstraint('COPY_LOCATION', { target: middle }));
    const ev = evaluator(doc)();
    expectVec(loc(ev.byId.get(middle)!.worldMatrix), [1, 2, 10]);
    expectVec(loc(ev.byId.get(last)!.worldMatrix), [1, 2, 10]);
    expect(ev.objects.flatMap((o) => o.constraintErrors)).toEqual([]);
    // deleting the target leaves a dangling id: reported, transform unchanged
    doc.removeObject(first);
    const ev2 = evaluator(doc)();
    expect(ev2.byId.get(middle)!.constraintErrors[0].message).toBe(`Target object '${first}' not found`);
    expectVec(loc(ev2.byId.get(middle)!.worldMatrix), [0, 0, 10]);
  });

  it('follows a circle path with an animated eval_time', () => {
    const doc = SceneDoc.create({ empty: true });
    const n = 72;
    const points = Array.from({ length: n }, (_, i) =>
      defaultSplinePoint([3 * Math.cos((2 * Math.PI * i) / n), 3 * Math.sin((2 * Math.PI * i) / n), 0]),
    );
    const curveData = doc.addCurve({
      splines: [{ ...defaultSpline('POLY'), use_cyclic_u: true, points }],
      path_duration: 48,
    });
    const circle = doc.addObject({ type: 'CURVE', name: 'Orbit', data: curveData, location: [0, 0, 2] });
    const moon = doc.addObject({ type: 'EMPTY', name: 'Moon' });
    addConstraint(
      doc,
      moon,
      createConstraint('FOLLOW_PATH', { target: circle, params: { use_curve_follow: true } }),
    );
    let fc = createFCurve({ target_type: 'curve', target_id: curveData, path: 'eval_time', index: 0 });
    fc = insertKeyframe(fc, 0, 0, 'LINEAR');
    fc = insertKeyframe(fc, 48, 48, 'LINEAR');
    doc.setFCurve({ ...fc, extrapolation: 'LINEAR' });
    const at = evaluator(doc);
    expectVec(loc(at(0).byId.get(moon)!.worldMatrix), [3, 0, 2]);
    expectVec(loc(at(12).byId.get(moon)!.worldMatrix), [0, 3, 2]);
    expectVec(loc(at(24).byId.get(moon)!.worldMatrix), [-3, 0, 2]);
    expectVec(loc(at(60).byId.get(moon)!.worldMatrix), [0, 3, 2]); // second lap
    const m = at(12).byId.get(moon)!.worldMatrix;
    // +Y along the direction of travel (a polyline path's tangent is its segment direction: within 2.5°)
    expectVec([m[4], m[5], m[6]], [-1, 0, 0], 1);
    expectVec([m[8], m[9], m[10]], [0, 0, 1], 5); // +Z up
    expect(at(12).byId.get(moon)!.constraintErrors).toEqual([]);
  });

  it('animates constraint influence through F-curves', () => {
    const doc = SceneDoc.create({ empty: true });
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    const t = doc.addObject({ type: 'EMPTY', name: 'T', location: [10, 0, 0] });
    addConstraint(doc, o, createConstraint('COPY_LOCATION', { target: t }));
    let fc = createFCurve({
      target_type: 'object',
      target_id: o,
      path: 'constraints["Copy Location"].influence',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 1, 'LINEAR');
    doc.setFCurve(fc);
    const at = evaluator(doc);
    expectVec(loc(at(1).byId.get(o)!.worldMatrix), [0, 0, 0]);
    expectVec(loc(at(6).byId.get(o)!.worldMatrix), [5, 0, 0]);
    expectVec(loc(at(11).byId.get(o)!.worldMatrix), [10, 0, 0]);
  });

  it('animates parameters even when they are missing from the stored params', () => {
    const doc = SceneDoc.create({ empty: true });
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    const t = doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 0, 1] });
    // a hand-written constraint without stored parameters (defaults apply)
    addConstraint(doc, o, { ...createConstraint('FLOOR', { target: t }), params: {} });
    let fc = createFCurve({
      target_type: 'object',
      target_id: o,
      path: 'constraints["Floor"].offset',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 2, 'LINEAR');
    doc.setFCurve(fc);
    const at = evaluator(doc);
    expectVec(loc(at(1).byId.get(o)!.worldMatrix), [0, 0, 1]);
    expectVec(loc(at(11).byId.get(o)!.worldMatrix), [0, 0, 3]);
  });

  it('evaluates LOCAL spaces relative to parents, and parentless objects in their own frame', () => {
    const doc = SceneDoc.create({ empty: true });
    const parent = doc.addObject({
      type: 'EMPTY',
      name: 'P',
      location: [10, 0, 0],
      rotation_euler: [0, 0, Math.PI / 2],
    });
    const child = doc.addObject({ type: 'EMPTY', name: 'Child', parent, location: [5, 0, 0] });
    const loner = doc.addObject({
      type: 'EMPTY',
      name: 'Loner',
      location: [0, 3, 0],
      rotation_euler: [0, 0, Math.PI / 2],
    });
    const reader = doc.addObject({ type: 'EMPTY', name: 'Reader' });
    addConstraint(
      doc,
      child,
      createConstraint('LIMIT_LOCATION', { params: { use_max_x: true, max_x: 2, owner_space: 'LOCAL' } }),
    );
    addConstraint(
      doc,
      loner,
      createConstraint('LIMIT_LOCATION', { params: { use_max_x: true, max_x: 1, owner_space: 'LOCAL' } }),
    );
    addConstraint(
      doc,
      reader,
      createConstraint('COPY_LOCATION', { target: child, params: { target_space: 'LOCAL' } }),
    );
    const ev = evaluator(doc)();
    expectVec(loc(ev.byId.get(child)!.worldMatrix), [10, 2, 0]);
    // Blender: local space of a parentless object = its own rotation frame (x along its rotated X axis)
    expectVec(loc(ev.byId.get(loner)!.worldMatrix), [0, 1, 0]);
    // the child's location relative to its parent is (5,0,0) before its own constraint ran
    expectVec(loc(ev.byId.get(reader)!.worldMatrix), [2, 0, 0]);
    const world = createConstraint('LIMIT_LOCATION', { params: { use_max_x: true, max_x: 2 } });
    doc.updateObject(child, { constraints: [world] });
    expectVec(loc(evaluator(doc)().byId.get(child)!.worldMatrix), [2, 5, 0]);
  });

  it('targets posed bones of armature objects', () => {
    const doc = SceneDoc.create({ empty: true });
    const arm = doc.addArmature({ bones: [defaultBone('Bone', [0, 0, 0], [0, 0, 2])] });
    const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: arm, location: [0, 0, 1] });
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    addConstraint(
      doc,
      o,
      createConstraint('COPY_LOCATION', { target: rig, subtarget: 'Bone', params: { head_tail: 1 } }),
    );
    const ev = evaluator(doc)();
    expect(ev.byId.get(o)!.constraintErrors).toEqual([]);
    expectVec(loc(ev.byId.get(o)!.worldMatrix), [0, 0, 3]);
    addConstraint(doc, o, createConstraint('COPY_ROTATION', { target: rig, subtarget: 'Missing' }));
    expect(evaluator(doc)().byId.get(o)!.constraintErrors[0].message).toMatch(/Bone 'Missing' not found/);
  });

  it('keeps unconstrained objects and parenting untouched', () => {
    const doc = SceneDoc.create({ empty: true });
    const p = doc.addObject({ type: 'EMPTY', name: 'P', location: [1, 0, 0] });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', parent: p, location: [0, 1, 0], scale: [2, 2, 2] });
    const t = doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 0, 5] });
    addConstraint(doc, p, createConstraint('COPY_LOCATION', { target: t }));
    const ev = evaluator(doc)();
    // the child follows its constrained parent
    expectVec(
      ev.byId.get(c)!.worldMatrix,
      multiply4(translation4([0, 0, 5]), compose4([0, 1, 0], [0, 0, 0], [2, 2, 2])),
    );
    expect(decompose4(ev.byId.get(t)!.worldMatrix).location).toEqual([0, 0, 5]);
  });
});
