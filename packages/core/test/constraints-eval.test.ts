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
  defaultPoseBone,
  defaultSpline,
  defaultSplinePoint,
  insertKeyframe,
  invert4,
  lookAt4,
  multiply4,
  translation4,
  type ConstraintData,
  type EvaluatedScene,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';
import { FrameState } from '../src/eval/frame-state';

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

/** Constraint error messages of every object, by object name. */
function errorsByName(ev: EvaluatedScene): Record<string, string[]> {
  return Object.fromEntries(ev.objects.map((o) => [o.name, o.constraintErrors.map((e) => e.message)]));
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

  it('reports and skips every constraint on a dependency cycle, whatever the evaluation order', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [0, 0, 0] });
    const b = doc.addObject({ type: 'EMPTY', name: 'B', location: [5, 0, 0] });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', location: [0, 5, 0] });
    addConstraint(doc, a, createConstraint('TRACK_TO', { target: b }));
    addConstraint(doc, b, createConstraint('TRACK_TO', { target: a }));
    const ev = evaluator(doc)();
    expect(errorsByName(ev)).toEqual({
      A: ["Target 'B' is part of a dependency cycle: A [Track To] → B [Track To] → A"],
      B: ["Target 'A' is part of a dependency cycle: B [Track To] → A [Track To] → B"],
      C: [],
    });
    // neither is half applied: both keep their unconstrained transform
    expectVec(ev.byId.get(a)!.worldMatrix, translation4([0, 0, 0]));
    expectVec(ev.byId.get(b)!.worldMatrix, translation4([5, 0, 0]));
    // renaming changes the evaluation order, not the result
    doc.updateObject(a, { name: 'Z' });
    const renamed = evaluator(doc)();
    expect(errorsByName(renamed)).toEqual({
      Z: ["Target 'B' is part of a dependency cycle: Z [Track To] → B [Track To] → Z"],
      B: ["Target 'Z' is part of a dependency cycle: B [Track To] → Z [Track To] → B"],
      C: [],
    });
    for (const o of renamed.objects) expectVec(o.worldMatrix, ev.byId.get(o.id)!.worldMatrix);
    // a longer loop A → B → C → A: every constraint on it is reported
    addConstraint(doc, b, createConstraint('COPY_LOCATION', { target: c }));
    addConstraint(doc, c, createConstraint('COPY_ROTATION', { target: a }));
    const ev2 = evaluator(doc)();
    const all = ev2.objects.flatMap((o) => o.constraintErrors.map((e) => e.message));
    expect(all).toHaveLength(4);
    for (const m of all) expect(m).toMatch(/is part of a dependency cycle: /);
    expect(ev2.byId.get(c)!.constraintErrors[0].message).toBe(
      "Target 'Z' is part of a dependency cycle: C [Copy Rotation] → Z [Track To] → B [Copy Location] → C",
    );
    // and a constraint targeting its own object
    addConstraint(doc, a, createConstraint('COPY_LOCATION', { target: a }));
    const self = evaluator(doc)().byId.get(a)!.constraintErrors;
    expect(self.map((e) => e.message)).toContain('A constraint cannot use its own object as target');
  });

  it('detects cycles closed through parenting and keeps the child on its parent', () => {
    const doc = SceneDoc.create({ empty: true });
    const cam = doc.addObject({ type: 'CAMERA', name: 'Camera', location: [0, -10, 0] });
    const focus = doc.addObject({ type: 'EMPTY', name: 'Focus', parent: cam, location: [2, 0, 0] });
    addConstraint(doc, cam, createConstraint('TRACK_TO', { target: focus }));
    const check = (camName: string) => {
      const ev = evaluator(doc)();
      expect(ev.byId.get(cam)!.constraintErrors.map((e) => e.message)).toEqual([
        `Target 'Focus' is part of a dependency cycle: ${camName} [Track To] → Focus [parent] → ${camName}`,
      ]);
      expect(ev.byId.get(focus)!.constraintErrors).toEqual([]);
      expectVec(ev.byId.get(cam)!.worldMatrix, translation4([0, -10, 0]));
      // the child is placed by its (unconstrained) parent, not with an identity parent
      expectVec(loc(ev.byId.get(focus)!.worldMatrix), [2, -10, 0]);
    };
    check('Camera');
    doc.updateObject(cam, { name: 'ZCamera' }); // evaluated after its child now
    check('ZCamera');

    // the same through a constraint of the parent (Damped Track aiming at its own child)
    const arm = doc.addObject({ type: 'EMPTY', name: 'Arm', location: [10, 0, 0] });
    const hand = doc.addObject({ type: 'EMPTY', name: 'Hand', parent: arm, location: [0, 5, 0] });
    addConstraint(doc, arm, createConstraint('DAMPED_TRACK', { target: hand }));
    const ev = evaluator(doc)();
    expect(ev.byId.get(arm)!.constraintErrors[0].message).toMatch(
      /^Target 'Hand' is part of a dependency cycle/,
    );
    expectVec(loc(ev.byId.get(hand)!.worldMatrix), [10, 5, 0]);
    expectVec(ev.byId.get(arm)!.worldMatrix, translation4([10, 0, 0]));
  });

  it('detects cycles through curve targets and bone parents', () => {
    const doc = SceneDoc.create({ empty: true });
    const rider = doc.addObject({ type: 'EMPTY', name: 'Rider', location: [0, 0, 1] });
    const data = doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([4, 0, 0])] },
      ],
    });
    // the path is parented to the object that follows it
    const path = doc.addObject({ type: 'CURVE', name: 'Track', data, parent: rider });
    addConstraint(doc, rider, createConstraint('FOLLOW_PATH', { target: path }));
    const arm = doc.addArmature({ bones: [defaultBone('Bone', [0, 0, 0], [0, 0, 2])] });
    const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: arm });
    const prop = doc.addObject({
      type: 'EMPTY',
      name: 'Prop',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'Bone',
    });
    addConstraint(doc, rig, createConstraint('COPY_LOCATION', { target: prop }));
    const ev = evaluator(doc)();
    expect(errorsByName(ev)).toEqual({
      Prop: [],
      Rider: ["Target 'Track' is part of a dependency cycle: Rider [Follow Path] → Track [parent] → Rider"],
      Rig: [
        "Target 'Prop' is part of a dependency cycle: Rig [Copy Location] → Prop [parent bone 'Bone'] → Rig",
      ],
      Track: [],
    });
    expectVec(loc(ev.byId.get(rider)!.worldMatrix), [0, 0, 1]);
    expectVec(loc(ev.byId.get(path)!.worldMatrix), [0, 0, 1]);
    // bone children sit at the tail of their bone
    expectVec(loc(ev.byId.get(prop)!.worldMatrix), [0, 0, 2]);
  });

  it('ignores relations that are not evaluated and relations inside armature poses', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A' });
    const b = doc.addObject({ type: 'EMPTY', name: 'B', location: [5, 0, 0] });
    const ab = createConstraint('COPY_LOCATION', { target: b, mute: true });
    addConstraint(doc, a, ab);
    addConstraint(doc, b, createConstraint('COPY_ROTATION', { target: a }));
    const check = () => expect(evaluator(doc)().objects.flatMap((o) => o.constraintErrors)).toEqual([]);
    check(); // muted
    doc.updateObject(a, { constraints: [{ ...ab, mute: false, influence: 0 }] });
    check(); // no influence
    doc.updateObject(a, { constraints: [{ ...ab, mute: false, params: { use_x: 'yes' } }] });
    const ev = evaluator(doc)();
    expect(ev.byId.get(a)!.constraintErrors[0].message).toMatch(/^Invalid parameters/);
    expect(ev.byId.get(b)!.constraintErrors).toEqual([]);

    // an IK target following a bone that is not part of the IK chain is not a cycle
    const arm = doc.addArmature({
      bones: [defaultBone('Chest', [3, 0, 0], [3, 0, 1]), defaultBone('Arm', [0, 0, 0], [0, 0, 1])],
    });
    const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: arm });
    const goal = doc.addObject({ type: 'EMPTY', name: 'Goal' });
    addConstraint(doc, goal, createConstraint('COPY_LOCATION', { target: rig, subtarget: 'Chest' }));
    const ik = {
      ...createConstraint('IK' as ConstraintData['type'], { target: goal }),
      params: { chain_count: 1 },
    };
    doc.updateObject(rig, { pose: { bones: { Arm: { ...defaultPoseBone(), constraints: [ik] } } } });
    const ev2 = evaluator(doc)();
    expect(ev2.byId.get(goal)!.constraintErrors).toEqual([]);
    expectVec(loc(ev2.byId.get(goal)!.worldMatrix), [3, 0, 0]);
  });

  it('survives loops of parent links (corrupt data)', () => {
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    const b = doc.addObject({ type: 'EMPTY', name: 'B', location: [0, 1, 0] });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', location: [0, 0, 1] });
    // e.g. two devices parenting A and B to each other at the same time
    doc.updateObject(a, { parent: b });
    doc.updateObject(b, { parent: a });
    doc.updateObject(c, { parent: a });
    addConstraint(doc, c, createConstraint('LIMIT_LOCATION', { params: { use_max_z: true, max_z: 0 } }));
    const ev = evaluator(doc)();
    for (const o of ev.objects) expect(o.worldMatrix.every(Number.isFinite)).toBe(true);
    expect(ev.objects.flatMap((o) => o.constraintErrors)).toEqual([]);
    expect(loc(ev.byId.get(c)!.worldMatrix)[2]).toBeCloseTo(0, 9);
  });

  it('evaluates very long constraint chains without deep recursion', () => {
    const doc = SceneDoc.create({ empty: true });
    const n = 1500;
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < n; i++)
        ids.push(
          doc.addObject({ type: 'EMPTY', name: `N${String(i).padStart(5, '0')}`, location: [1, 0, 0] }),
        );
      // each object copies the next one's location and adds its own: the head ends at x = n
      for (let i = 0; i < n - 1; i++)
        doc.updateObject(ids[i], {
          constraints: [
            createConstraint('COPY_LOCATION', { target: ids[i + 1], params: { use_offset: true } }),
          ],
        });
    });
    const ev = evaluator(doc)();
    expect(ev.objects.flatMap((o) => o.constraintErrors)).toEqual([]);
    expect(ev.byId.get(ids[0])!.worldMatrix[12]).toBeCloseTo(n, 6);
    expect(ev.byId.get(ids[n - 100])!.worldMatrix[12]).toBeCloseTo(100, 6);
    // a single object of a fresh frame state (what operators do), and a parent chain
    expect(new FrameState(doc, 1).world(ids[0])![12]).toBeCloseTo(n, 6);
    // closing the chain into a ring: every constraint reports the loop
    doc.updateObject(ids[n - 1], {
      constraints: [createConstraint('COPY_LOCATION', { target: ids[0], params: { use_offset: true } })],
    });
    const ring = evaluator(doc)();
    const messages = ring.objects.flatMap((o) => o.constraintErrors.map((e) => e.message));
    expect(messages).toHaveLength(n);
    expect(ring.byId.get(ids[0])!.constraintErrors[0].message).toBe(
      "Target 'N00001' is part of a dependency cycle (a loop through 1500 objects, including 'N00000')",
    );
    for (const id of ids) expect(ring.byId.get(id)!.worldMatrix[12]).toBe(1);
  });

  it('evaluates long chains a pose bone reads while another object is being evaluated', () => {
    const doc = SceneDoc.create({ empty: true });
    const n = 1500;
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < n; i++)
        ids.push(
          doc.addObject({ type: 'EMPTY', name: `N${String(i).padStart(5, '0')}`, location: [1, 0, 0] }),
        );
      for (let i = 0; i < n - 1; i++)
        doc.updateObject(ids[i], {
          constraints: [
            createConstraint('COPY_LOCATION', { target: ids[i + 1], params: { use_offset: true } }),
          ],
        });
    });
    // bone B copies the chain head; 'AAA' (evaluated first) hangs from bone B, so the chain is
    // first asked for from inside the evaluation of AAA
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({ bones: [defaultBone('B', [0, 0, 0], [0, 0, 1])] }),
    });
    const copy = createConstraint('COPY_LOCATION', { target: ids[0] });
    doc.updateObject(rig, { pose: { bones: { B: { ...defaultPoseBone(), constraints: [copy] } } } });
    const child = doc.addObject({
      type: 'EMPTY',
      name: 'AAA',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'B',
    });
    const ev = evaluator(doc)();
    expect(ev.objects.flatMap((o) => o.constraintErrors)).toEqual([]);
    expect(ev.errors).toEqual([]);
    expect(ev.byId.get(ids[0])!.worldMatrix[12]).toBeCloseTo(n, 6);
    expectVec(loc(ev.byId.get(child)!.worldMatrix), [n, 0, 1]); // at the tail of the bone
  });

  it('solves an object once when a cycle closes inside an armature pose, whatever the order', () => {
    // A copies D, D hangs from bone B, bone B copies A: a cycle the object graph cannot see (pose
    // relations are resolved bone by bone). A's constraint reports it and is skipped; no stale
    // error next to a constrained result, and the same result for every evaluation order.
    for (const names of [
      { a: 'A', d: 'D', r: 'R' },
      { a: 'Z', d: 'D', r: 'R' },
      { a: 'A', d: 'Z', r: 'R' },
      { a: 'B', d: 'C', r: 'A' },
    ]) {
      const doc = SceneDoc.create({ empty: true });
      const r = doc.addObject({
        type: 'ARMATURE',
        name: names.r,
        data: doc.addArmature({ bones: [defaultBone('B', [0, 0, 0], [0, 0, 1])] }),
      });
      const a = doc.addObject({ type: 'EMPTY', name: names.a, location: [7, 0, 0] });
      const d = doc.addObject({
        type: 'EMPTY',
        name: names.d,
        parent: r,
        parent_type: 'BONE',
        parent_bone: 'B',
      });
      doc.updateObject(a, { constraints: [createConstraint('COPY_LOCATION', { target: d })] });
      const copy = createConstraint('COPY_LOCATION', { target: a });
      doc.updateObject(r, { pose: { bones: { B: { ...defaultPoseBone(), constraints: [copy] } } } });
      const cycle = [`Target '${names.d}' is part of a dependency cycle`];
      const ev = evaluator(doc)();
      expect(ev.byId.get(a)!.constraintErrors.map((e) => e.message)).toEqual(cycle);
      expectVec(loc(ev.byId.get(a)!.worldMatrix), [7, 0, 0]);
      expectVec(loc(ev.byId.get(d)!.worldMatrix), [7, 0, 1]);
      // a fresh frame state asked for A first (what operators do) agrees
      const fs = new FrameState(doc, 1);
      expectVec(loc(fs.world(a)!), [7, 0, 0]);
      expect(fs.constraintErrors.get(a)!.map((e) => e.message)).toEqual(cycle);
    }
  });

  it('gives the same result for any object names in random scenes (seeded)', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    const types = [
      'COPY_LOCATION',
      'COPY_ROTATION',
      'COPY_TRANSFORMS',
      'TRACK_TO',
      'DAMPED_TRACK',
      'LOCKED_TRACK',
      'CHILD_OF',
      'LIMIT_DISTANCE',
      'FOLLOW_PATH',
      'CLAMP_TO',
    ] as const;
    let cyclic = 0;
    const snapshot = (doc: SceneDoc, ids: string[]) => {
      const ev = evaluator(doc)();
      return ids.map((id) => {
        const o = ev.byId.get(id)!;
        expect(o.worldMatrix.every(Number.isFinite)).toBe(true);
        cyclic += o.constraintErrors.filter((e) => /dependency cycle/.test(e.message)).length;
        return [
          o.worldMatrix.map((v) => Math.round(v * 1e6) / 1e6),
          o.constraintErrors.map((e) => e.constraintId),
        ];
      });
    };
    for (let scene = 0; scene < 120; scene++) {
      const doc = SceneDoc.create({ empty: true });
      const rand3 = (): Vec3 => [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
      const ids = Array.from({ length: 7 }, (_, i) =>
        doc.addObject({ type: 'EMPTY', name: `O${i}`, location: rand3(), rotation_euler: rand3() }),
      );
      const bones = [
        defaultBone('B0', [0, 0, 0], [0, 0, 1]),
        { ...defaultBone('B1', [0, 0, 1], [0, 1, 2]), parent: 'B0' },
      ];
      const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: doc.addArmature({ bones }) });
      const points = [
        defaultSplinePoint([0, 0, 0]),
        defaultSplinePoint([3, 0, 0]),
        defaultSplinePoint([3, 3, 0]),
      ];
      const data = doc.addCurve({ splines: [{ ...defaultSpline('POLY'), points }] });
      const curve = doc.addObject({ type: 'CURVE', name: 'Path', data });
      const all = [...ids, rig, curve];
      // random object / bone parents (no parent loops) and constraints on objects, bones of the rig
      // and the curve - including cycles through constraints and parents and self targets
      all.forEach((id, i) => {
        const parent = i > 0 && rnd() < 0.35 ? all[Math.floor(rnd() * i)] : null;
        if (parent === rig && rnd() < 0.7)
          doc.updateObject(id, { parent, parent_type: 'BONE', parent_bone: pick(['B0', 'B1']) });
        else if (parent) doc.updateObject(id, { parent });
        const constraints = Array.from({ length: Math.floor(rnd() * 3) }, () => {
          const type = pick(types);
          const target = type === 'FOLLOW_PATH' || type === 'CLAMP_TO' ? curve : pick(all);
          const subtarget = target === rig && rnd() < 0.7 ? pick(['B0', 'B1']) : '';
          return createConstraint(type, { target, subtarget, influence: rnd() < 0.3 ? 0.5 : 1 });
        });
        doc.updateObject(id, { constraints });
      });
      const before = snapshot(doc, all);
      // reverse the evaluation order (objects are evaluated by name)
      all.forEach((id, i) => doc.updateObject(id, { name: `Z${99 - i}` }));
      expect(snapshot(doc, all)).toEqual(before);
    }
    expect(cyclic).toBeGreaterThan(50); // the scenes do exercise cycles
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
