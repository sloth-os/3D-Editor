import { describe, expect, it } from 'vitest';
import {
  FrameState,
  ObjectTransform,
  SceneDoc,
  axisAngle4,
  createConstraint,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  defaultBone,
  defaultPoseBone,
  defaultSpline,
  defaultSplinePoint,
  insertKeyframe,
  normalize3,
  scaling4,
  selectionPivot,
  translation4,
  type ConstraintData,
  type Mat4,
  type OperatorContext,
  type PivotPoint,
  type TransformMode,
  type Vec3,
} from '../src';

/*
 * The modal Move, Rotate and Scale preview (ObjectTransform.worlds) against what the scene shows
 * once the operator stored the channels: objects that read a moved object through other
 * datablocks (a driver of a curve, light, material, camera, the world or a shape key that a driver
 * of the object reads), and scenes with dependency cycles, whose evaluation depends on the order
 * objects are evaluated in (the viewport and the operators evaluate them in the document's order).
 */

const reg = createOperatorRegistry();

/** What the viewport shows: every object evaluated in the document's order (SceneEvaluator). */
function settled(fs: FrameState): FrameState {
  for (const o of fs.objects) fs.world(o.id);
  return fs;
}

function context(doc: SceneDoc): OperatorContext {
  return { doc, state: createEditorState(), origin: doc.origin, source: 'test', report: () => undefined };
}

const maxRel = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i]))) / Math.max(1, ...b.map(Math.abs));

describe('the transform preview follows every datablock between the moved objects and their readers', () => {
  it('shows an object whose driver reads a curve datablock that a moved object drives', () => {
    const doc = SceneDoc.create({ empty: true });
    const m = doc.addObject({ type: 'EMPTY', name: 'M' });
    const data = doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([1, 0, 0])] },
      ],
    });
    doc.addObject({ type: 'CURVE', name: 'Path', data });
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [5, 0, 0] });
    doc.setDriver({
      target_type: 'curve',
      target_id: data,
      path: 'eval_time',
      index: 0,
      expression: 'v * 10',
      variables: [{ name: 'v', target_type: 'object', target_id: m, path: 'location', index: 0 }],
      mute: false,
    });
    doc.setDriver({
      target_type: 'object',
      target_id: a,
      path: 'location',
      index: 2,
      expression: 't * 0.05',
      variables: [{ name: 't', target_type: 'curve', target_id: data, path: 'eval_time', index: 0 }],
      mute: false,
    });
    const xf = new ObjectTransform(new FrameState(doc, 1), [m], 'MEDIAN_POINT', 'TRANSLATE');
    const preview = xf.worlds(xf.channels(translation4([1, 0, 0]), [0, 0, 0]));
    expect(Array.from(preview.get(a)!.slice(12, 15))).toEqual([5, 0, 0.5]);
    const ctx = context(doc);
    ctx.state.selectedIds = [m];
    ctx.state.activeId = m;
    expect(reg.run(ctx, 'transform.translate', { value: [1, 0, 0] }).ok).toBe(true);
    expect(Array.from(new FrameState(doc, 1).world(a)!.slice(12, 15))).toEqual([5, 0, 0.5]);
  });

  it('follows a chain of drivers through a material, a light, a camera, the world and a shape key', () => {
    const doc = SceneDoc.create({ empty: true });
    const ctx = context(doc);
    const m = doc.addObject({ type: 'EMPTY', name: 'M' });
    const material = doc.addMaterial({ name: 'Mat' });
    const light = doc.addLight({ type: 'POINT' });
    const camera = doc.addCamera({});
    expect(reg.run(ctx, 'mesh.primitive_cube_add', {}).ok).toBe(true);
    const cube = ctx.state.activeId!;
    const mesh = doc.getObject(cube)!.data!;
    doc.setShapeKeys(mesh, [
      { name: 'Basis', value: 0, data: doc.getMesh(mesh)!.positions.slice() },
      { name: 'Key', value: 0, data: doc.getMesh(mesh)!.positions.slice() },
    ] as never);
    const a = doc.addObject({ type: 'EMPTY', name: 'A', location: [0, 2, 0] });
    const drive = (
      target: [string, string, string],
      expression: string,
      variable: [string, string, string],
    ) =>
      doc.setDriver({
        target_type: target[0] as 'object',
        target_id: target[1],
        path: target[2],
        index: 0,
        expression,
        variables: [
          {
            name: 'v',
            target_type: variable[0] as 'object',
            target_id: variable[1],
            path: variable[2],
            index: 0,
          },
        ],
        mute: false,
      });
    drive(['material', material, 'roughness'], 'v * 0.1', ['object', m, 'location']);
    drive(['light', light, 'energy'], 'v * 10', ['material', material, 'roughness']);
    drive(['camera', camera, 'lens'], 'v * 10', ['light', light, 'energy']);
    drive(['world', 'world', 'strength'], 'v / 100', ['camera', camera, 'lens']);
    drive(['mesh', mesh, 'shape_keys["Key"].value'], 'v', ['world', 'world', 'strength']);
    drive(['object', a, 'location'], 'v * 3', ['mesh', mesh, 'shape_keys["Key"].value']);
    // M at x = 2: roughness 0.2, energy 2, lens 20, strength 0.2, shape key 0.2, A.x 0.6
    const xf = new ObjectTransform(new FrameState(doc, 1), [m], 'MEDIAN_POINT', 'TRANSLATE');
    const preview = xf.worlds(xf.channels(translation4([2, 0, 0]), [0, 0, 0]));
    expect(preview.get(a)![12]).toBeCloseTo(0.6, 12);
    ctx.state.selectedIds = [m];
    ctx.state.activeId = m;
    expect(reg.run(ctx, 'transform.translate', { value: [2, 0, 0] }).ok).toBe(true);
    const after = new FrameState(doc, 1).world(a)!;
    expect(maxRel(preview.get(a)!, after)).toBe(0);
    // the cube uses the mesh whose shape key changes, but nothing of its matrix reads it
    expect(preview.has(cube)).toBe(false);
  });

  it('moves a Follow Path follower of every curve object whose shared curve datablock a moved object drives', () => {
    const doc = SceneDoc.create({ empty: true });
    const m = doc.addObject({ type: 'EMPTY', name: 'M' });
    const data = doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([10, 0, 0])] },
      ],
    });
    doc.addObject({ type: 'CURVE', name: 'Path A', data });
    const pathB = doc.addObject({ type: 'CURVE', name: 'Path B', data, location: [0, 3, 0] });
    const follower = doc.addObject({
      type: 'EMPTY',
      name: 'Follower',
      constraints: [createConstraint('FOLLOW_PATH', { target: pathB })],
    });
    doc.setDriver({
      target_type: 'curve',
      target_id: data,
      path: 'eval_time',
      index: 0,
      expression: 'v * 10',
      variables: [{ name: 'v', target_type: 'object', target_id: m, path: 'location', index: 0 }],
      mute: false,
    });
    const xf = new ObjectTransform(new FrameState(doc, 1), [m], 'MEDIAN_POINT', 'TRANSLATE');
    const preview = xf.worlds(xf.channels(translation4([3, 0, 0]), [0, 0, 0]));
    const ctx = context(doc);
    ctx.state.selectedIds = [m];
    ctx.state.activeId = m;
    expect(reg.run(ctx, 'transform.translate', { value: [3, 0, 0] }).ok).toBe(true);
    const after = new FrameState(doc, 1).world(follower)!;
    // eval_time 30 of the path's 100 frames: 3 along it
    expect(after[12]).toBeCloseTo(3, 9);
    expect(preview.get(follower)).toEqual(after);
  });

  it('reads datablocks the move leaves alone from the frame state it started from, also on a driver loop', () => {
    // a driver loop between a material and a light, which nothing moved reads: what each gets
    // depends on which is resolved first, Early (first by name) resolving the light; Reader reads
    // the material and the moved object, so it is evaluated anew, but the loop must not be
    const doc = SceneDoc.create({ empty: true });
    const material = doc.addMaterial({ name: 'Mat', roughness: 0.5 });
    const light = doc.addLight({ type: 'POINT', energy: 10 });
    const early = doc.addObject({ type: 'EMPTY', name: 'Early' });
    const moved = doc.addObject({ type: 'EMPTY', name: 'Moved' });
    const reader = doc.addObject({ type: 'EMPTY', name: 'Reader' });
    const drive = (target: [string, string, string], expression: string, vars: [string, string, string][]) =>
      doc.setDriver({
        target_type: target[0] as 'object',
        target_id: target[1],
        path: target[2],
        index: 0,
        expression,
        variables: vars.map(([type, id, path], i) => ({
          name: `v${i}`,
          target_type: type as 'object',
          target_id: id,
          path,
          index: 0,
        })),
        mute: false,
      });
    drive(['material', material, 'roughness'], 'v0 * 0.1', [['light', light, 'energy']]);
    drive(['light', light, 'energy'], 'v0 + 1', [['material', material, 'roughness']]);
    drive(['object', early, 'location'], 'v0', [['light', light, 'energy']]);
    drive(['object', reader, 'location'], 'v0 + v1', [
      ['material', material, 'roughness'],
      ['object', moved, 'location'],
    ]);
    const xf = new ObjectTransform(new FrameState(doc, 1), [moved], 'MEDIAN_POINT', 'TRANSLATE');
    const preview = xf.worlds(xf.channels(translation4([2, 0, 0]), [0, 0, 0]));
    const ctx = context(doc);
    ctx.state.selectedIds = [moved];
    ctx.state.activeId = moved;
    expect(reg.run(ctx, 'transform.translate', { value: [2, 0, 0] }).ok).toBe(true);
    const after = settled(new FrameState(doc, 1)).world(reader)!;
    // the light first: roughness 10 · 0.1 = 1, so Reader is at 1 + 2
    expect(after[12]).toBeCloseTo(3, 12);
    expect(preview.get(reader)).toEqual(after);
  });
});

/**
 * The preview of a transform of `ids` by `m` (`op` with `params`, Move, Rotate or Scale as `mode`,
 * about the median of their origins) at `frame`, and what the scene shows once the operator ran with
 * auto keying on or off: the objects whose matrices differ at all, by name.
 */
function previewMismatches(
  doc: SceneDoc,
  ids: string[],
  mode: TransformMode,
  m: Mat4,
  op: string,
  params: Record<string, unknown>,
  opts: { frame?: number; autoKeying?: boolean } = {},
) {
  const frame = opts.frame ?? 1;
  const autoKeying = !!opts.autoKeying;
  const xf = new ObjectTransform(new FrameState(doc, frame), ids, 'MEDIAN_POINT', mode);
  const view = settled(new FrameState(doc, frame));
  const ctx = context(doc);
  Object.assign(ctx.state, { frame, selectedIds: ids, activeId: ids[0], autoKeying });
  const center = xf.pivot(ctx.state);
  const preview = xf.worlds(xf.channels(m, center), { autoKeying });
  const r = reg.run(ctx, op, mode === 'TRANSLATE' ? params : { ...params, center });
  if (!r.ok) throw new Error(r.error);
  const after = settled(new FrameState(doc, frame));
  const mismatches: string[] = [];
  for (const o of after.objects) {
    const a = after.world(o.id);
    const shown = preview.get(o.id) ?? view.world(o.id);
    if (a && shown && maxRel(shown, a) > 0)
      mismatches.push(`${o.name}${preview.has(o.id) ? '' : ' (not in the preview)'}`);
  }
  return { mismatches, preview, after };
}

/** A driver of `target` (`[type, id, path, index]`) computing `expression` from variable `v`. */
function drive(
  doc: SceneDoc,
  target: [string, string, string, number],
  expression: string,
  v: [string, string, string, number],
) {
  doc.setDriver({
    target_type: target[0] as 'object',
    target_id: target[1],
    path: target[2],
    index: target[3],
    expression,
    variables: [{ name: 'v', target_type: v[0] as 'object', target_id: v[1], path: v[2], index: v[3] }],
    mute: false,
  });
}

describe('the transform preview where IK chains are solved together or a dependency cycle is near', () => {
  it('moves the bones of every IK chain solved together with the chain whose target moves', () => {
    // the pose evaluator solves the chains B3 → B0 (target T1) and B4 → B2 (target T2) together,
    // as they share B2: moving T2 also turns B0 and B1, which only the chain of B3 holds
    const doc = SceneDoc.create({ empty: true });
    const t1 = doc.addObject({ type: 'EMPTY', name: 'T1', location: [1, 0, 3] });
    const t2 = doc.addObject({ type: 'EMPTY', name: 'T2', location: [-1, 0.5, 2.5] });
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({
        bones: [
          defaultBone('B0', [0, 0, 0], [0, 0, 1]),
          { ...defaultBone('B1', [0, 0, 1], [0, 0, 2]), parent: 'B0', use_connect: true },
          { ...defaultBone('B2', [0, 0, 2], [0, 0, 3]), parent: 'B1', use_connect: true },
          { ...defaultBone('B3', [0, 0, 3], [0, 0, 4]), parent: 'B2', use_connect: true },
          { ...defaultBone('B4', [0, 0, 3], [0.5, 0, 3.8]), parent: 'B2', use_connect: true },
        ],
      }),
    });
    const ik = (target: string, chain_count: number) => ({
      ...createConstraint('IK' as ConstraintData['type'], { target }),
      params: { chain_count },
    });
    doc.updateObject(rig, {
      pose: {
        bones: {
          B0: defaultPoseBone(),
          B1: defaultPoseBone(),
          B2: defaultPoseBone(),
          B3: { ...defaultPoseBone(), constraints: [ik(t1, 4)] },
          B4: { ...defaultPoseBone(), constraints: [ik(t2, 2)] },
        },
      } as never,
    });
    const child0 = doc.addObject({
      type: 'EMPTY',
      name: 'ChildOfB0',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'B0',
    });
    const child1 = doc.addObject({
      type: 'EMPTY',
      name: 'ChildOfB1',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'B1',
    });
    const reader = doc.addObject({
      type: 'EMPTY',
      name: 'ReaderOfB1',
      constraints: [createConstraint('COPY_LOCATION', { target: rig, subtarget: 'B1' })],
    });
    const before = settled(new FrameState(doc, 1)).world(child1)!;
    const { mismatches, preview, after } = previewMismatches(
      doc,
      [t2],
      'TRANSLATE',
      translation4([-1, 0, 0.5]),
      'transform.translate',
      { value: [-1, 0, 0.5] },
    );
    expect(maxRel(before, after.world(child1)!)).toBeGreaterThan(0.1);
    expect(mismatches).toEqual([]);
    for (const id of [child0, child1, reader]) expect(preview.has(id)).toBe(true);
  });

  it('evaluates the scene in name order where a driver loop runs through the values of an object the move reaches', () => {
    // AB copies X's rotation, so turning X reaches AB's matrix, not its values; but AB's Z location
    // is driven through a loop (the world's strength, a material's roughness, AB's Z location),
    // which the viewport enters at AA, first by name, so AB shows z 3, not 4
    const doc = SceneDoc.create({ empty: true });
    const x = doc.addObject({ type: 'EMPTY', name: 'X', location: [3, 0, 0] });
    const aa = doc.addObject({ type: 'EMPTY', name: 'AA', location: [0, 5, 0] });
    const ab = doc.addObject({
      type: 'EMPTY',
      name: 'AB',
      constraints: [createConstraint('COPY_ROTATION', { target: x })],
    });
    const material = doc.addMaterial({ name: 'Mat' });
    drive(doc, ['object', ab, 'location', 2], 'v * 2 + 1', ['world', 'world', 'strength', 0]);
    drive(doc, ['material', material, 'roughness', 0], 'v * 0.1 + 0.2', ['object', ab, 'location', 2]);
    drive(doc, ['world', 'world', 'strength', 0], 'v * 3', ['material', material, 'roughness', 0]);
    drive(doc, ['object', aa, 'location', 1], 'v', ['world', 'world', 'strength', 0]);
    const { mismatches, preview, after } = previewMismatches(
      doc,
      [x],
      'ROTATE',
      axisAngle4([0, 0, 1], 0.5),
      'transform.rotate',
      { value: 0.5, axis: [0, 0, 1] },
    );
    expect(after.world(ab)![14]).toBeCloseTo(3, 12);
    expect(preview.has(ab)).toBe(true);
    expect(mismatches).toEqual([]);
  });

  it('evaluates the scene in name order where a pose cycle sits in an armature the move reaches through another bone', () => {
    // T is parented to B2 and is the IK target of B3's chain (B3, B2, B0): a cycle inside the pose,
    // which evaluating M first or the rig's bones first breaks at different places; moving M
    // reaches the rig through B1, which tracks M, and M copies the rotation of B0, on the cycle
    const doc = SceneDoc.create({ empty: true });
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({
        bones: [
          defaultBone('B0', [0, 0, 0], [0, 0, 1]),
          { ...defaultBone('B1', [0, 0, 1], [1, 0, 1.5]), parent: 'B0' },
          { ...defaultBone('B2', [0, 0, 1], [0, 0, 2]), parent: 'B0', use_connect: true },
          { ...defaultBone('B3', [0, 0, 2], [0, 0.5, 2.8]), parent: 'B2', use_connect: true },
        ],
      }),
    });
    const t = doc.addObject({
      type: 'EMPTY',
      name: 'T',
      parent: rig,
      parent_type: 'BONE',
      parent_bone: 'B2',
      location: [0.8, 0.3, 0],
    });
    const m = doc.addObject({
      type: 'EMPTY',
      name: 'M',
      location: [2, 1, 0],
      constraints: [createConstraint('COPY_ROTATION', { target: rig, subtarget: 'B0' })],
    });
    doc.updateObject(rig, {
      pose: {
        bones: {
          B0: { ...defaultPoseBone(), rotation_euler: [0.3, 0, 0] },
          B1: {
            ...defaultPoseBone(),
            constraints: [createConstraint('DAMPED_TRACK' as ConstraintData['type'], { target: m })],
          },
          B2: { ...defaultPoseBone(), rotation_euler: [0.2, 0.1, 0] },
          B3: {
            ...defaultPoseBone(),
            constraints: [
              {
                ...createConstraint('IK' as ConstraintData['type'], { target: t }),
                params: { chain_count: 0 },
              },
            ],
          },
        },
      } as never,
    });
    const { mismatches, preview } = previewMismatches(
      doc,
      [m],
      'TRANSLATE',
      translation4([0, 0, 1]),
      'transform.translate',
      {
        value: [0, 0, 1],
      },
    );
    expect(preview.has(m)).toBe(true);
    expect(mismatches).toEqual([]);
  });

  it('replaces the values a driver loop reads as confirming stores and keys them, with auto keying and without', () => {
    // X's X scale is driven through a loop that reads its own value before the driver (1 stored):
    // 0.1 · that + 1. Moving X writes its location only; auto keying keys the scale too, with the
    // value it shows (1.1), which the loop then reads: 1.11
    for (const autoKeying of [false, true]) {
      const doc = SceneDoc.create({ empty: true });
      const x = doc.addObject({ type: 'EMPTY', name: 'X' });
      const material = doc.addMaterial({ name: 'Mat' });
      drive(doc, ['object', x, 'scale', 0], 'v * 0.5 + 1', ['material', material, 'roughness', 0]);
      drive(doc, ['material', material, 'roughness', 0], 'v * 0.2', ['object', x, 'scale', 0]);
      const { mismatches, after } = previewMismatches(
        doc,
        [x],
        'TRANSLATE',
        translation4([1, 0, 0]),
        'transform.translate',
        { value: [1, 0, 0] },
        { autoKeying },
      );
      expect(after.world(x)![0]).toBeCloseTo(autoKeying ? 1.11 : 1.1, 12);
      expect(mismatches, `auto keying ${autoKeying}`).toEqual([]);
    }
  });

  it('keeps the keys of an animated channel that a driver loop sets, which a move does not key', () => {
    // X's X location is keyed (5 at frame 6) and driven through a loop that reads its keyed value:
    // 0.5 · 5. A move writes the location, but does not key a driven channel, so its keys still give
    // 5 there and X stays at 2.5
    const doc = SceneDoc.create({ empty: true });
    const x = doc.addObject({ type: 'EMPTY', name: 'X' });
    const material = doc.addMaterial({ name: 'Mat' });
    const fc = createFCurve({ target_type: 'object', target_id: x, path: 'location', index: 0 });
    doc.setFCurve(insertKeyframe(insertKeyframe(fc, 1, 0, 'LINEAR'), 11, 10, 'LINEAR'));
    drive(doc, ['object', x, 'location', 0], 'v * 0.5', ['material', material, 'roughness', 0]);
    drive(doc, ['material', material, 'roughness', 0], 'v', ['object', x, 'location', 0]);
    const { mismatches, after } = previewMismatches(
      doc,
      [x],
      'TRANSLATE',
      translation4([1, 0, 1]),
      'transform.translate',
      { value: [1, 0, 1] },
      { frame: 6 },
    );
    expect(Array.from(after.world(x)!.slice(12, 15))).toEqual([2.5, 0, 1]);
    expect(mismatches).toEqual([]);
  });

  it('shows exactly the channels confirming stores: a rotation by a whole turn stores nothing', () => {
    // the rotation it computes comes back about 1e-16 off, less than rounding, so it writes nothing
    const doc = SceneDoc.create({ empty: true });
    const parent = doc.addObject({
      type: 'EMPTY',
      name: 'P',
      location: [0.5, -1, 2],
      rotation_euler: [0.9, -0.4, 1.2],
      scale: [1.5, 0.7, 2.2],
    });
    const child = doc.addObject({
      type: 'EMPTY',
      name: 'C',
      location: [1.1, 0.3, -0.7],
      rotation_euler: [0.2, 0.4, 0.6],
      parent,
    });
    const m = axisAngle4(normalize3([0.3, 0.5, 0.8]), 2 * Math.PI);
    const xf = new ObjectTransform(new FrameState(doc, 1), [child], 'MEDIAN_POINT', 'ROTATE');
    expect(xf.channels(m, xf.start(child)!.basis.center).get(child)).toEqual(xf.start(child)!.held);
    const { mismatches } = previewMismatches(doc, [child], 'ROTATE', m, 'transform.rotate', {
      value: 2 * Math.PI,
      axis: normalize3([0.3, 0.5, 0.8]),
    });
    expect(mismatches).toEqual([]);
  });
});

/** An armature object named Rig with `bones` and the pose bones `pose` gives (by bone name). */
function rigWith(
  doc: SceneDoc,
  bones: ReturnType<typeof defaultBone>[],
  pose: (rig: string) => Record<string, unknown>,
) {
  const rig = doc.addObject({ type: 'ARMATURE', name: 'Rig', data: doc.addArmature({ bones }) });
  doc.updateObject(rig, { pose: { bones: pose(rig) } as never });
  return rig;
}

/** An empty named `name` parented to bone `bone` of `rig`. */
const boneChild = (doc: SceneDoc, rig: string, bone: string, name = 'Y') =>
  doc.addObject({
    type: 'EMPTY',
    name,
    parent: rig,
    parent_type: 'BONE',
    parent_bone: bone,
    location: [0.3, 0, 0],
  });

describe('the transform preview follows what a moved object changes inside a pose', () => {
  /**
   * Moves `moved` by `v` and checks that the preview shows what the scene shows afterwards, and
   * that `child` (parented to a bone the move reaches) moves and is in the preview.
   */
  function checkBoneChild(doc: SceneDoc, moved: string, child: string, v: Vec3) {
    const before = settled(new FrameState(doc, 1)).world(child)!;
    const { mismatches, preview, after } = previewMismatches(
      doc,
      [moved],
      'TRANSLATE',
      translation4(v),
      'transform.translate',
      { value: v },
    );
    expect(maxRel(before, after.world(child)!)).toBeGreaterThan(1e-3);
    expect(preview.has(child)).toBe(true);
    expect(mismatches).toEqual([]);
  }

  it('solves an IK chain anew when a constraint of one of its bones reads the moved object', () => {
    // B copies 0.6 of X's location and reaches for T with R (chain_count 2): moving X moves B's
    // start, so the chain turns R, which Y hangs from
    const doc = SceneDoc.create({ empty: true });
    const t = doc.addObject({ type: 'EMPTY', name: 'T', location: [0.8, 0.3, 1.6] });
    const x = doc.addObject({ type: 'EMPTY', name: 'X', location: [0.2, 0.1, 1.3] });
    const ik = createConstraint('IK' as ConstraintData['type'], { target: t });
    const rig = rigWith(
      doc,
      [defaultBone('R', [0, 0, 0], [0, 0, 1]), { ...defaultBone('B', [0, 0, 1.2], [0, 0, 2]), parent: 'R' }],
      () => ({
        R: defaultPoseBone(),
        B: {
          ...defaultPoseBone(),
          constraints: [
            createConstraint('COPY_LOCATION', { target: x, influence: 0.6 }),
            { ...ik, params: { chain_count: 2 } },
          ],
        },
      }),
    );
    checkBoneChild(doc, x, boneChild(doc, rig, 'R'), [0.3, -0.2, 0.1]);
  });

  it('follows a bone constraint that targets another bone of the same armature', () => {
    // B1 tracks X; B2 copies B1's rotation, and Y hangs from B2
    const doc = SceneDoc.create({ empty: true });
    const x = doc.addObject({ type: 'EMPTY', name: 'X', location: [2, 1, 3] });
    const rig = rigWith(
      doc,
      [
        defaultBone('R', [0, 0, 0], [0, 0, 1]),
        { ...defaultBone('B1', [0, 0, 1], [0, 0, 2]), parent: 'R' },
        { ...defaultBone('B2', [0, 0, 1], [1, 0, 1]), parent: 'R' },
      ],
      (self) => ({
        R: defaultPoseBone(),
        B1: {
          ...defaultPoseBone(),
          constraints: [createConstraint('DAMPED_TRACK' as ConstraintData['type'], { target: x })],
        },
        B2: {
          ...defaultPoseBone(),
          constraints: [
            createConstraint('COPY_ROTATION' as ConstraintData['type'], { target: self, subtarget: 'B1' }),
          ],
        },
      }),
    );
    checkBoneChild(doc, x, boneChild(doc, rig, 'B2'), [-1, 0.5, 0]);
  });

  it('starts an IK chain without its tail (use_tail off) at the parent of the IK bone', () => {
    // B reaches for T with its parent P only (chain_count 1, use_tail off), and Y hangs from P
    const doc = SceneDoc.create({ empty: true });
    const t = doc.addObject({ type: 'EMPTY', name: 'T', location: [1, 0, 1.5] });
    const ik = createConstraint('IK' as ConstraintData['type'], { target: t });
    const rig = rigWith(
      doc,
      [
        defaultBone('R', [0, 0, 0], [0, 0, 1]),
        { ...defaultBone('P', [0, 0, 1], [0, 0, 2]), parent: 'R', use_connect: true },
        { ...defaultBone('B', [0, 0, 2], [0, 0, 3]), parent: 'P', use_connect: true },
      ],
      () => ({
        R: defaultPoseBone(),
        P: defaultPoseBone(),
        B: { ...defaultPoseBone(), constraints: [{ ...ik, params: { chain_count: 1, use_tail: false } }] },
      }),
    );
    checkBoneChild(doc, t, boneChild(doc, rig, 'P'), [-1, 0.5, 0.2]);
  });

  it('evaluates the scene in name order where two objects drive each other', () => {
    // Alpha's Z location reads Zed's Y location and Zed's Y location reads Alpha's Z location: the
    // viewport enters the loop at Alpha, first by name, also when Zed moves
    const doc = SceneDoc.create({ empty: true });
    const alpha = doc.addObject({ type: 'EMPTY', name: 'Alpha', location: [0, 0, 5] });
    const zed = doc.addObject({ type: 'EMPTY', name: 'Zed', location: [3, 1, 0] });
    drive(doc, ['object', alpha, 'location', 2], 'v + 1', ['object', zed, 'location', 1]);
    drive(doc, ['object', zed, 'location', 1], 'v * 0.5', ['object', alpha, 'location', 2]);
    const { mismatches, preview } = previewMismatches(
      doc,
      [zed],
      'TRANSLATE',
      translation4([1, 2, 0.5]),
      'transform.translate',
      { value: [1, 2, 0.5] },
    );
    expect(preview.has(alpha)).toBe(true);
    expect(mismatches).toEqual([]);
  });
});

/**
 * A dependency cycle inside a pose, which the scene evaluates differently depending on where its
 * evaluation enters it: T is parented to bone B2 of Rig and is the IK target of B3's chain (B3, B2,
 * B0). X, parented to B0, reads the cycle: evaluated first, it shows no matrix (its bone breaks the
 * cycle there), while the viewport, which evaluates the objects by name (A_T first), shows it on
 * B0.
 */
function poseCycleScene() {
  const doc = SceneDoc.create({ empty: true });
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
  const t = doc.addObject({
    type: 'EMPTY',
    name: 'A_T',
    parent: rig,
    parent_type: 'BONE',
    parent_bone: 'B2',
    location: [0.8, 0.3, 0],
  });
  const ik = createConstraint('IK' as ConstraintData['type'], { target: t });
  doc.updateObject(rig, {
    pose: {
      bones: {
        B0: { ...defaultPoseBone(), rotation_euler: [0.3, 0, 0] },
        B2: { ...defaultPoseBone(), rotation_euler: [0.2, 0.1, 0] },
        B3: { ...defaultPoseBone(), constraints: [{ ...ik, params: { chain_count: 0 } }] },
      },
    } as never,
  });
  const x = doc.addObject({
    type: 'EMPTY',
    name: 'X',
    parent: rig,
    parent_type: 'BONE',
    parent_bone: 'B0',
    location: [0.2, 0, 0.1],
  });
  expect(new FrameState(doc, 1).world(x)).toBeNull();
  const shown = settled(new FrameState(doc, 1)).world(x)!;
  expect(shown).not.toBeNull();
  return { doc, rig, t, x, shown };
}

describe('the transform reads what a dependency cycle gives as the viewport shows it', () => {
  it('starts an object that reads a cycle where the viewport shows it', () => {
    const { doc, x, shown } = poseCycleScene();
    const ctx = context(doc);
    Object.assign(ctx.state, { selectedIds: [x], activeId: x });
    expect(selectionPivot(doc, ctx.state, 'MEDIAN_POINT')).toEqual([shown[12], shown[13], shown[14]]);
    expect(reg.run(ctx, 'transform.translate', { value: [0, 0, 1] }).ok).toBe(true);
    const after = settled(new FrameState(doc, 1)).world(x)!;
    expect(maxRel(after.slice(12, 15), [shown[12], shown[13], shown[14] + 1])).toBeLessThan(1e-12);
  });

  it('places the Active Element pivot on an active object that reads a cycle, which it does not move', () => {
    const { doc, x, shown } = poseCycleScene();
    const u = doc.addObject({ type: 'EMPTY', name: 'U', location: [5, 0, 0] });
    const state = createEditorState();
    Object.assign(state, { selectedIds: [u], activeId: x });
    expect(selectionPivot(doc, state, 'ACTIVE_ELEMENT')).toEqual([shown[12], shown[13], shown[14]]);
  });

  it('previews an object that reads both the moved object and a cycle the move does not reach', () => {
    // Q is X's child and copies half of M's location
    const { doc, x } = poseCycleScene();
    const m = doc.addObject({ type: 'EMPTY', name: 'M', location: [3, 0, 0] });
    const q = doc.addObject({
      type: 'EMPTY',
      name: 'Q',
      parent: x,
      location: [0, 1, 0],
      constraints: [createConstraint('COPY_LOCATION', { target: m, influence: 0.5 })],
    });
    const { mismatches, preview } = previewMismatches(
      doc,
      [m],
      'TRANSLATE',
      translation4([0, 2, 1]),
      'transform.translate',
      { value: [0, 2, 1] },
    );
    expect(preview.has(q)).toBe(true);
    expect(mismatches).toEqual([]);
  });
});

describe('Edit Mode reads the edited object where the scene shows it, also on a dependency cycle', () => {
  /** A cube parented to bone B0 of the pose cycle, in Edit Mode with every vertex selected. */
  function editedOnCycle() {
    const { doc, rig } = poseCycleScene();
    const ctx = context(doc);
    expect(reg.run(ctx, 'mesh.primitive_cube_add', { name: 'M', size: 0.2 }).ok).toBe(true);
    const m = ctx.state.activeId!;
    doc.updateObject(m, { parent: rig, parent_type: 'BONE', parent_bone: 'B0', location: [0.2, 0, 0.1] });
    // evaluated first, it enters the cycle at its own bone and has no matrix
    expect(new FrameState(doc, 1).world(m)).toBeNull();
    const shown = settled(new FrameState(doc, 1)).world(m)!;
    expect(reg.run(ctx, 'object.mode_set', { mode: 'EDIT' }).ok).toBe(true);
    const verts = () => {
      const p = doc.getMesh(doc.getObject(m)!.data!)!.positions;
      const w = settled(new FrameState(doc, 1)).world(m)!;
      const out: number[] = [];
      for (let i = 0; i < p.length; i += 3)
        for (let k = 0; k < 3; k++)
          out.push(w[k] * p[i] + w[4 + k] * p[i + 1] + w[8 + k] * p[i + 2] + w[12 + k]);
      return out;
    };
    return { doc, ctx, shown, verts };
  }

  it('places the pivot of the selected vertices where the viewport shows them', () => {
    const { doc, ctx, shown } = editedOnCycle();
    // the median of the cube's vertices is its origin
    const pivot = selectionPivot(doc, ctx.state, 'MEDIAN_POINT');
    expect(maxRel(pivot, [shown[12], shown[13], shown[14]])).toBeLessThan(1e-9);
  });

  it('moves the vertices in the space the viewport shows the object in', () => {
    const { ctx, verts } = editedOnCycle();
    const before = verts();
    expect(reg.run(ctx, 'transform.translate', { value: [0, 0, 1] }).ok).toBe(true);
    // the mesh keeps 32-bit floats
    expect(
      maxRel(
        verts(),
        before.map((v, i) => (i % 3 === 2 ? v + 1 : v)),
      ),
    ).toBeLessThan(1e-6);
  });

  it('rotates the vertices about a given center in that space', () => {
    // with `center` the operator finds no pivot: the vertices' space is read on its own
    const { ctx, shown, verts } = editedOnCycle();
    const before = verts();
    const c: Vec3 = [shown[12], shown[13], shown[14]];
    expect(reg.run(ctx, 'transform.rotate', { value: Math.PI / 2, orient_axis: 'Z', center: c }).ok).toBe(
      true,
    );
    // a quarter turn about Z through c: (x, y) - c turns to (-(y - cy), x - cx)
    const turned = before.map((v, i) => {
      const k = i % 3;
      const x = before[i - k] - c[0];
      const y = before[i - k + 1] - c[1];
      return k === 0 ? c[0] - y : k === 1 ? c[1] + x : v;
    });
    expect(maxRel(verts(), turned)).toBeLessThan(1e-6);
  });
});

/**
 * A random scene: two armatures with a 3-bone chain each (IK with pole targets, bone constraints
 * reading objects and the other armature), curves (one curve datablock shared by two objects),
 * empties with object and bone parents and every kind of object constraint, drivers between
 * objects, of bones, of curve data, and through a material, a light and the world; animated
 * channels. With `dag`, every relation points to an object earlier in a random ranking (no cycle
 * at the level of objects); else cycles of every kind can appear, also through poses and drivers.
 */
function randomScene(rnd: () => number, dag: boolean) {
  const pick = <T>(l: readonly T[]): T => l[Math.floor(rnd() * l.length)];
  const rand3 = (s = 2): Vec3 => [rnd() * 2 * s - s, rnd() * 2 * s - s, rnd() * 2 * s - s];
  const doc = SceneDoc.create({ empty: true });
  const rigs = [0, 1].map((r) =>
    doc.addObject({
      type: 'ARMATURE',
      name: `Rig${r}`,
      location: rand3(),
      rotation_euler: rand3(1),
      data: doc.addArmature({
        bones: [
          defaultBone('B0', [0, 0, 0], [0, 0, 1]),
          { ...defaultBone('B1', [0, 0, 1], [0, 0.5, 2]), parent: 'B0', use_connect: rnd() < 0.5 },
          { ...defaultBone('B2', [0, 0.5, 2], [0, 1, 2.8]), parent: 'B1', use_connect: rnd() < 0.5 },
        ],
      }),
    }),
  );
  const curveData = [0, 1].map(() =>
    doc.addCurve({
      splines: [
        {
          ...defaultSpline('POLY'),
          points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint(rand3(3)), defaultSplinePoint(rand3(3))],
        },
      ],
    }),
  );
  const curves = [
    doc.addObject({ type: 'CURVE', name: 'P0', data: curveData[0], location: rand3() }),
    doc.addObject({ type: 'CURVE', name: 'P1', data: curveData[1], location: rand3() }),
    doc.addObject({ type: 'CURVE', name: 'P2', data: curveData[0], location: rand3() }),
  ];
  const objs = Array.from({ length: 6 }, (_, i) =>
    doc.addObject({
      type: 'EMPTY',
      name: `O${i}`,
      location: rand3(),
      rotation_euler: rand3(1.5),
      scale: rnd() < 0.4 ? [1, 1, 1] : [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
    }),
  );
  const all = [...rigs, ...curves, ...objs];
  const ranked = [...all].sort(() => rnd() - 0.5);
  const rank = new Map(ranked.map((id, i) => [id, i]));
  const below = (id: string, list: readonly string[]) =>
    dag ? list.filter((x) => rank.get(x)! < rank.get(id)!) : list.filter((x) => x !== id);
  (dag ? ranked : all).forEach((id, i, pool) => {
    if (i === 0 || rnd() < 0.45) return;
    const parent = pool[Math.floor(rnd() * i)];
    if (rigs.includes(parent) && rnd() < 0.7)
      doc.updateObject(id, { parent, parent_type: 'BONE', parent_bone: pick(['B0', 'B1', 'B2']) });
    else doc.updateObject(id, { parent });
  });
  const types = [
    'COPY_LOCATION',
    'COPY_ROTATION',
    'COPY_SCALE',
    'COPY_TRANSFORMS',
    'DAMPED_TRACK',
    'CHILD_OF',
    'LIMIT_DISTANCE',
    'PIVOT',
    'FOLLOW_PATH',
    'CLAMP_TO',
  ] as const;
  for (const id of [...objs, ...curves]) {
    const list: ConstraintData[] = [];
    for (let j = Math.floor(rnd() * 3); j > 0; j--) {
      const type = pick(types);
      const pool = type === 'FOLLOW_PATH' || type === 'CLAMP_TO' ? below(id, curves) : below(id, all);
      if (!pool.length) continue;
      const target = pick(pool);
      const params: Record<string, unknown> = {};
      if (type.startsWith('COPY_')) {
        params.target_space = pick(['WORLD', 'LOCAL']);
        params.owner_space = pick(['WORLD', 'LOCAL']);
      }
      if (type === 'COPY_TRANSFORMS') params.mix_mode = pick(['REPLACE', 'BEFORE', 'AFTER']);
      list.push(
        createConstraint(type, {
          target,
          subtarget: rigs.includes(target) && rnd() < 0.7 ? pick(['B0', 'B1', 'B2']) : '',
          params,
        }),
      );
    }
    if (list.length) doc.updateObject(id, { constraints: list });
  }
  rigs.forEach((rig, r) => {
    const other = rigs[1 - r];
    const objPool = below(rig, objs);
    const otherOk = !dag || rank.get(other)! < rank.get(rig)!;
    const bones: Record<string, Record<string, unknown>> = {
      B0: { ...defaultPoseBone(), rotation_euler: rand3(0.5) },
      B1: { ...defaultPoseBone(), rotation_euler: rand3(0.5) },
      B2: { ...defaultPoseBone(), rotation_euler: rand3(0.5) },
    };
    if (objPool.length && rnd() < 0.7) {
      const ik = createConstraint('IK' as ConstraintData['type'], { target: pick(objPool) });
      bones.B2.constraints = [
        { ...ik, params: { chain_count: 2, ...(rnd() < 0.5 ? { pole_target: pick(objPool) } : {}) } },
      ];
    }
    if (rnd() < 0.5 && (objPool.length || otherOk))
      bones.B0.constraints = [
        createConstraint(pick(['COPY_LOCATION', 'DAMPED_TRACK', 'COPY_ROTATION'] as const), {
          target: otherOk && (rnd() < 0.3 || !objPool.length) ? other : pick(objPool),
        }),
      ];
    doc.updateObject(rig, { pose: { bones } as never });
  });
  // drivers: objects reading earlier ones, curve data, and a chain through a material, a light and
  // the world read by an object
  const order = dag ? ranked : all;
  const variable = (target_type: string, target_id: string, path: string) =>
    [{ name: 'v', target_type, target_id, path, index: 0 }] as never;
  for (let i = 1; i < order.length; i++)
    if (rnd() < 0.25)
      doc.setDriver({
        target_type: 'object',
        target_id: order[i],
        path: pick(['location', 'rotation_euler', 'scale']),
        index: Math.floor(rnd() * 3),
        expression: 'v * 0.3 + 1',
        variables: variable('object', order[Math.floor(rnd() * i)], pick(['location', 'rotation_euler'])),
        mute: false,
      });
  const source = pick(objs);
  const readers = dag ? objs.filter((x) => rank.get(x)! > rank.get(source)!) : objs;
  const curveUsers = curves.filter((c) => doc.getObject(c)!.data === curveData[0]);
  if (!dag || curveUsers.every((c) => rank.get(c)! > rank.get(source)!))
    doc.setDriver({
      target_type: 'curve',
      target_id: curveData[0],
      path: 'eval_time',
      index: 0,
      expression: 'v * 10 + 20',
      variables: variable('object', source, 'location'),
      mute: false,
    });
  const material = doc.addMaterial({ name: 'Mat' });
  const light = doc.addLight({ type: 'POINT' });
  doc.setDriver({
    target_type: 'material',
    target_id: material,
    path: 'roughness',
    index: 0,
    expression: 'v * 0.1',
    variables: variable('object', source, 'location'),
    mute: false,
  });
  doc.setDriver({
    target_type: 'light',
    target_id: light,
    path: 'energy',
    index: 0,
    expression: 'v * 10',
    variables: variable('material', material, 'roughness'),
    mute: false,
  });
  doc.setDriver({
    target_type: 'world',
    target_id: 'world',
    path: 'strength',
    index: 0,
    expression: 'v / 10',
    variables: variable('light', light, 'energy'),
    mute: false,
  });
  if (readers.length)
    doc.setDriver({
      target_type: 'object',
      target_id: pick(readers),
      path: 'location',
      index: 2,
      expression: 'v * 0.5',
      variables: variable(pick(['world', 'curve']), pick([['world'], [curveData[0]]])[0], 'strength'),
      mute: false,
    });
  if (readers.length)
    doc.setDriver({
      target_type: 'object',
      target_id: pick(readers),
      path: 'location',
      index: 1,
      expression: 'v * 0.05',
      variables: variable('curve', curveData[0], 'eval_time'),
      mute: false,
    });
  for (const id of all)
    if (rnd() < 0.3) {
      const path = pick(['location', 'rotation_euler', 'scale']);
      const v = (): number => (path === 'scale' ? 0.5 + rnd() : rnd() * 4 - 2);
      const fc = createFCurve({ target_type: 'object', target_id: id, path, index: Math.floor(rnd() * 3) });
      doc.setFCurve(insertKeyframe(insertKeyframe(fc, 1, v()), 11, v()));
    }
  return { doc, all, pick, rand3 };
}

/**
 * Runs random transforms in random scenes: the transform must start from what the viewport shows,
 * the preview must give what a full evaluation in the document's order gives once the channels are
 * replaced, and what the scene shows after the operator ran (auto keying on and off).
 */
function checkPreviews(seed: number, count: number, dag: boolean) {
  const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
  const fails: string[] = [];
  let previewed = 0;
  for (let n = 0; n < count; n++) {
    const { doc, all, pick, rand3 } = randomScene(rnd, dag);
    const ctx = context(doc);
    const frame = 2 + Math.floor(rnd() * 8);
    const sel = [...new Set([pick(all), pick(all)])];
    const pivot = pick(['MEDIAN_POINT', 'CURSOR', 'INDIVIDUAL_ORIGINS', 'ACTIVE_ELEMENT'] as PivotPoint[]);
    const mode = pick(['TRANSLATE', 'ROTATE', 'RESIZE'] as TransformMode[]);
    Object.assign(ctx.state, {
      frame,
      selectedIds: sel,
      activeId: pick(sel),
      pivotPoint: pivot,
      cursorLocation: rand3(3),
      autoKeying: rnd() < 0.5,
    });
    const fs = new FrameState(doc, frame);
    const xf = new ObjectTransform(fs, sel, pivot, mode);
    const view = settled(new FrameState(doc, frame));
    // what the transform reads (its objects' matrices, the pivot) is what the viewport shows
    for (const { id } of xf.targets) {
      const a = fs.world(id);
      const b = view.world(id);
      if (!!a !== !!b || (a && b && maxRel(a, b) > 0)) fails.push(`scene ${n}: start != view (${id})`);
    }
    const center = xf.pivot(ctx.state);
    const viewCenter = new ObjectTransform(view, sel, pivot, mode).pivot(ctx.state);
    if (maxRel(center, viewCenter) > 0) fails.push(`scene ${n}: pivot != view`);
    let m: Mat4;
    let op: string;
    let params: Record<string, unknown>;
    if (mode === 'TRANSLATE') {
      const v = rand3(1.5);
      [m, op, params] = [translation4(v), 'transform.translate', { value: v }];
    } else if (mode === 'ROTATE') {
      const axis = normalize3(rand3(1));
      const angle = (rnd() * 2 - 1) * Math.PI;
      [m, op, params] = [axisAngle4(axis, angle), 'transform.rotate', { value: angle, axis, center }];
    } else {
      const f: Vec3 = [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()];
      [m, op, params] = [scaling4(f), 'transform.resize', { value: f, center }];
    }
    const channels = xf.channels(m, center);
    const preview = xf.worlds(channels);
    previewed += preview.size;
    const full = settled(new FrameState(doc, frame, null, { base: fs, channels }));
    const r = reg.run(ctx, op, params);
    if (!r.ok) {
      fails.push(`scene ${n}: ${op} failed: ${r.error}`);
      continue;
    }
    const after = settled(new FrameState(doc, frame));
    for (const id of all) {
      const shown = preview.get(id) ?? view.world(id);
      const f = full.world(id);
      const a = after.world(id);
      if (!shown || !f || !a) continue;
      if (maxRel(shown, f) > 1e-12) fails.push(`scene ${n} ${mode} ${pivot}: preview != full (${id})`);
      if (maxRel(shown, a) > 1e-9) fails.push(`scene ${n} ${mode} ${pivot}: preview != result (${id})`);
    }
  }
  return { fails, previewed };
}

describe('the transform preview gives what the scene shows once the operator ran (seeded)', () => {
  it('in random scenes without dependency cycles between objects', () => {
    const { fails, previewed } = checkPreviews(7, 60, true);
    expect(fails).toEqual([]);
    expect(previewed).toBeGreaterThan(200);
  });

  it('in random scenes with dependency cycles, also through poses and drivers', () => {
    const { fails, previewed } = checkPreviews(5, 60, false);
    expect(fails).toEqual([]);
    expect(previewed).toBeGreaterThan(200);
  });

  it('where a cycle runs through an armature pose that an object reads in LOCAL space', () => {
    // O5 is the child (Child Of) of O2; O2 copies the scale of bone B0 in LOCAL space, which reads
    // the whole pose of the rig, whose IK bone B2 reaches for O5: evaluating O5 first or O2 first
    // breaks the cycle at different places, and the viewport evaluates them by name
    const doc = SceneDoc.create({ empty: true });
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({
        bones: [
          defaultBone('B0', [0, 0, 0], [0, 0, 1]),
          { ...defaultBone('B1', [0, 0, 1], [0, 0.5, 2]), parent: 'B0' },
          { ...defaultBone('B2', [0, 0.5, 2], [0, 1, 2.8]), parent: 'B1' },
        ],
      }),
    });
    const o2 = doc.addObject({ type: 'EMPTY', name: 'O2', location: [1, 0, 0] });
    const o5 = doc.addObject({ type: 'EMPTY', name: 'O5', location: [0, 1, 2] });
    doc.updateObject(o2, {
      constraints: [
        createConstraint('COPY_SCALE', {
          target: rig,
          subtarget: 'B0',
          params: { target_space: 'LOCAL', owner_space: 'WORLD' },
        }),
      ],
    });
    doc.updateObject(o5, { constraints: [createConstraint('CHILD_OF', { target: o2 })] });
    const ik = createConstraint('IK' as ConstraintData['type'], { target: o5 });
    doc.updateObject(rig, {
      pose: {
        bones: {
          B0: { ...defaultPoseBone(), scale: [1.5, 1, 1] },
          B1: defaultPoseBone(),
          B2: { ...defaultPoseBone(), constraints: [{ ...ik, params: { chain_count: 2 } }] },
        },
      } as never,
    });
    const ctx = context(doc);
    ctx.state.selectedIds = [o5];
    ctx.state.activeId = o5;
    const fs = new FrameState(doc, 1);
    const xf = new ObjectTransform(fs, [o5], 'MEDIAN_POINT', 'TRANSLATE');
    const view = settled(new FrameState(doc, 1));
    expect(fs.world(o5)).toEqual(view.world(o5));
    const preview = xf.worlds(xf.channels(translation4([0, 0, 1]), [0, 0, 0]));
    expect(reg.run(ctx, 'transform.translate', { value: [0, 0, 1] }).ok).toBe(true);
    const after = settled(new FrameState(doc, 1));
    for (const id of [rig, o2, o5]) expect(preview.get(id) ?? view.world(id)).toEqual(after.world(id));
  });
});
