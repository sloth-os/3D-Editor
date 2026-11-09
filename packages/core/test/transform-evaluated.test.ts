import { describe, expect, it } from 'vitest';
import {
  FrameState,
  SceneDoc,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  fcurveKey,
  insertKeyframe,
  type OperatorContext,
  type Vec3,
} from '../src';
import { IDENTITY, blenderTransform, eulToMat3, fromMat4, type M3 } from './blender-transform-port';

/*
 * Move, Rotate and Scale, the snap operators and the operators that keep world matrices work on
 * what the scene shows at the current frame, as Blender's do: an object parented to a bone moves in
 * the bone's (posed) axes, a child of an animated, posed or constrained parent in its parent's
 * evaluated axes, and an animated object starts from the values it shows at the frame. The
 * expected channels come from the port of Blender's transform code (blender-transform-port.ts),
 * given the parent matrix the scene evaluates (FrameState.parent).
 */

const deg = Math.PI / 180;
const reg = createOperatorRegistry();

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r;
  };
  const select = (ids: string[], active = ids[ids.length - 1]) => {
    ctx.state.selectedIds = ids;
    ctx.state.activeId = active;
  };
  /** The world matrix the scene evaluates at the current frame. */
  const world = (id: string) => new FrameState(doc, ctx.state.frame).world(id)!;
  const origin = (id: string): Vec3 => world(id).slice(12, 15) as Vec3;
  return { doc, ctx, run, select, world, origin };
}

type Setup = ReturnType<typeof setup>;

/**
 * The spec's scene: an armature at the origin (its bone along +Z), a cube at [1, 2, 3] parented to
 * the bone, the cube selected and active.
 */
function boneChild(t: Setup) {
  t.run('object.armature_add', { location: [0, 0, 0] });
  const arm = t.ctx.state.activeId!;
  t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
  const cube = t.ctx.state.activeId!;
  t.select([cube, arm], arm);
  t.run('object.parent_set', { type: 'BONE' });
  t.select([cube]);
  return { arm, cube };
}

const near = (a: readonly number[], b: readonly number[], tol = 1e-12) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tol * Math.max(1, Math.abs(b[i])));
const maxDiff = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const axisAngle = (axis: Vec3, angle: number): M3 => {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y + s * z, t * x * z - s * y],
    [t * x * y - s * z, t * y * y + c, t * y * z + s * x],
    [t * x * z + s * y, t * y * z - s * x, t * z * z + c],
  ];
};

describe('an object parented to a bone moves, turns and scales in the bone’s axes, as Blender', () => {
  it('the spec’s cube on the default bone: G Y 1, R Z 90° and S Y 2 about the origin', () => {
    // Blender: G Y moves the evaluated origin along Y (it moved along Z, the armature's Y in the
    // bone's frame), R Z 90° about the origin takes it from (1, 2, 3) to (−2, 1, 3) with its X axis
    // along world Y, S Y 2 about the origin takes it to (1, 4, 3)
    const cases: [string, unknown, Vec3, Vec3][] = [
      ['transform.translate', { value: [0, 1, 0] }, [1, 3, 3], [1, 0, 0]],
      ['transform.rotate', { value: 90 * deg, orient_axis: 'Z' }, [-2, 1, 3], [0, 1, 0]],
      ['transform.resize', { value: [1, 2, 1] }, [1, 4, 3], [1, 0, 0]],
    ];
    for (const [op, params, at, xAxis] of cases) {
      const t = setup();
      const { cube } = boneChild(t);
      t.ctx.state.pivotPoint = 'CURSOR';
      t.ctx.state.cursorLocation = [0, 0, 0];
      expect(near(t.origin(cube), [1, 2, 3]), 'before').toBe(true);
      t.run(op, params);
      const w = t.world(cube);
      expect(maxDiff(w.slice(12, 15), at), `${op} origin`).toBeLessThan(1e-12);
      const x = w.slice(0, 3);
      const l = Math.hypot(...x);
      expect(
        maxDiff(
          x.map((v) => v / l),
          xAxis,
        ),
        `${op} X axis`,
      ).toBeLessThan(1e-12);
    }
  });

  it('with the bone posed and the armature turned and scaled: what Blender stores (random cases)', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
    for (let n = 0; n < 60; n++) {
      const t = setup();
      t.run('object.armature_add', { location: [rnd() * 2, rnd() * 2, rnd() * 2] });
      const arm = t.ctx.state.activeId!;
      t.doc.updateObject(arm, {
        rotation_euler: [rnd() * 6, rnd() * 2 - 1, rnd() * 6],
        scale: [0.5 + rnd() * 2, 0.5 + rnd() * 2, 0.5 + rnd() * 2],
      });
      t.run('pose.bone_transform_set', {
        object: arm,
        bone: 'Bone',
        location: [rnd(), rnd(), rnd()],
        rotation_euler: [rnd() * 3, rnd() * 3, rnd() * 3],
        scale: [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
      });
      const child = t.doc.addObject({
        type: 'EMPTY',
        name: 'C',
        location: [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2],
        rotation_euler: [rnd() * 6, rnd() * 2 - 1, rnd() * 6],
        scale: [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
        parent: arm,
        parent_type: 'BONE',
        parent_bone: 'Bone',
      });
      t.select([child]);
      const aboutCursor = rnd() < 0.5;
      t.ctx.state.pivotPoint = aboutCursor ? 'CURSOR' : 'MEDIAN_POINT';
      t.ctx.state.cursorLocation = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
      const fs = new FrameState(t.doc, 1);
      const parent = fromMat4(fs.parent(child));
      const o = t.doc.getObject(child)!;
      const start = { loc: o.location, rot: o.rotation_euler, scale: o.scale };
      const center = aboutCursor ? t.ctx.state.cursorLocation : fs.world(child)!.slice(12, 15);
      const kind = Math.floor(rnd() * 3);
      let ref: ReturnType<typeof blenderTransform>;
      if (kind === 0) {
        const offset = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
        t.run('transform.translate', { value: offset });
        ref = blenderTransform(start, parent, 'TRANSLATE', IDENTITY, center, offset);
      } else if (kind === 1) {
        const axis = Math.floor(rnd() * 3);
        const angle = (rnd() * 2 - 1) * Math.PI;
        t.run('transform.rotate', { value: angle, orient_axis: 'XYZ'[axis] });
        ref = blenderTransform(
          start,
          parent,
          'ROTATE',
          eulToMat3([0, 1, 2].map((k) => (k === axis ? angle : 0))),
          center,
        );
      } else {
        const f = [0.5 + rnd() * 2, 0.5 + rnd() * 2, 0.5 + rnd() * 2];
        t.run('transform.resize', { value: f });
        ref = blenderTransform(
          start,
          parent,
          'RESIZE',
          IDENTITY.map((c, k) => c.map((v) => v * f[k])),
          center,
        );
      }
      const got = t.doc.getObject(child)!;
      const what = `case ${n} (${['G', 'R', 'S'][kind]}${aboutCursor ? ' about the cursor' : ''})`;
      expect(maxDiff(got.location, ref.loc) / Math.max(1, ...ref.loc.map(Math.abs)), what).toBeLessThan(
        1e-12,
      );
      expect(maxDiff(got.scale, ref.scale), what).toBeLessThan(1e-12);
      if (ref.cosY > 0.01) expect(maxDiff(got.rotation_euler, ref.rot), what).toBeLessThan(1e-11);
    }
  });

  it('a child of the bone child, selected alone, moves in the bone child’s evaluated axes', () => {
    const t = setup();
    const { cube } = boneChild(t);
    const grandchild = t.doc.addObject({ type: 'EMPTY', name: 'G', location: [0, 0, 2], parent: cube });
    const before = t.origin(grandchild);
    t.select([grandchild]);
    t.run('transform.translate', { value: [0, 1, 0] });
    expect(maxDiff(t.origin(grandchild), [before[0], before[1] + 1, before[2]])).toBeLessThan(1e-12);
  });

  it('pivots are the origins where the scene shows the objects (Median Point, Active Element)', () => {
    // the cube shows at (1, 2, 3), the other object at (3, 2, 5): R X 180° about their median
    // (2, 2, 4), or the cube's origin with Active Element
    for (const pivot of ['MEDIAN_POINT', 'BOUNDING_BOX_CENTER', 'ACTIVE_ELEMENT'] as const) {
      const t = setup();
      const { cube } = boneChild(t);
      const other = t.doc.addObject({ type: 'EMPTY', name: 'O', location: [3, 2, 5] });
      t.select([cube, other], pivot === 'ACTIVE_ELEMENT' ? cube : other);
      t.ctx.state.pivotPoint = pivot;
      t.run('transform.rotate', { value: 180 * deg, orient_axis: 'X' });
      const center = pivot === 'ACTIVE_ELEMENT' ? [1, 2, 3] : [2, 2, 4];
      const turn = (p: number[]) => [p[0], 2 * center[1] - p[1], 2 * center[2] - p[2]];
      expect(maxDiff(t.origin(cube), turn([1, 2, 3])), pivot).toBeLessThan(1e-12);
      expect(maxDiff(t.origin(other), turn([3, 2, 5])), pivot).toBeLessThan(1e-12);
    }
  });
});

describe('children of animated, posed and constrained parents move in their parents’ evaluated axes', () => {
  it('a parent turned by animation at a frame between its keys', () => {
    const t = setup();
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
    let fc = createFCurve({ target_type: 'object', target_id: p, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 90 * deg, 'LINEAR');
    t.doc.setFCurve(fc);
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [2, 0, 0], parent: p });
    t.ctx.state.frame = 6; // P turned 45°
    const before = t.origin(c);
    t.select([c]);
    t.run('transform.translate', { value: [1, 0, 0] });
    expect(maxDiff(t.origin(c), [before[0] + 1, before[1], before[2]])).toBeLessThan(1e-12);
    // and a rotation about the world Z axis through the cursor at the origin turns it there
    t.ctx.state.pivotPoint = 'CURSOR';
    const at = t.origin(c);
    t.run('transform.rotate', { value: 90 * deg, orient_axis: 'Z' });
    expect(maxDiff(t.origin(c), [-at[1], at[0], at[2]])).toBeLessThan(1e-12);
  });

  it('a parent turned by a constraint (Copy Rotation of a turned target)', () => {
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', rotation_euler: [0, 0, 90 * deg] });
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P', location: [1, 0, 0] });
    t.select([p]);
    t.run('object.constraint_add', { type: 'COPY_ROTATION', target });
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [2, 0, 0], parent: p });
    expect(maxDiff(t.origin(c), [1, 2, 0])).toBeLessThan(1e-12);
    t.select([c]);
    t.run('transform.translate', { value: [1, 0, 0] });
    expect(maxDiff(t.origin(c), [2, 2, 0])).toBeLessThan(1e-12);
  });
});

describe('an object’s own constraints', () => {
  it('are switched off for its origin (Blender’s td->center): a Copy Location target does not move the median', () => {
    // A shows at the target's (5, 0, 0) but its own origin, animated to (0, 0, 0) at the frame, is
    // what counts; with B at (2, 0, 0) the median point is (1, 0, 0), about which R Z 90° takes B to
    // (1, 1, 0)
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [5, 0, 0] });
    const a = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [9, 9, 9] });
    for (let index = 0; index < 3; index++)
      t.doc.setFCurve(
        insertKeyframe(createFCurve({ target_type: 'object', target_id: a, path: 'location', index }), 1, 0),
      );
    t.select([a]);
    t.run('object.constraint_add', { type: 'COPY_LOCATION', target });
    const b = t.doc.addObject({ type: 'EMPTY', name: 'B', location: [2, 0, 0] });
    t.select([a, b], b);
    t.run('transform.rotate', { value: 90 * deg, orient_axis: 'Z' });
    expect(maxDiff(t.doc.getObject(b)!.location, [1, 1, 0])).toBeLessThan(1e-12);
  });

  it('are part of the space when they need it (Child Of inheriting the location): G X moves the shown origin along X', () => {
    // Blender's constraints_list_needinv: with a Child Of target turned 90° about Z the move is taken
    // through the constraint, so the object moves along world X (without it, along world Y)
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', rotation_euler: [0, 0, 90 * deg] });
    const o = t.doc.addObject({ type: 'EMPTY', name: 'O', location: [1, 0, 0] });
    t.select([o]);
    t.run('object.constraint_add', { type: 'CHILD_OF', target });
    // the constraint sets its inverse when it gets a target: clear it so the target's turn shows
    const c = t.doc.getObject(o)!.constraints[0];
    t.doc.updateObject(o, {
      constraints: [
        { ...c, params: { ...c.params, inverse_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } },
      ],
    });
    const before = t.origin(o);
    expect(maxDiff(before, [0, 1, 0])).toBeLessThan(1e-12);
    t.run('transform.translate', { value: [1, 0, 0] });
    expect(maxDiff(t.origin(o), [1, 1, 0])).toBeLessThan(1e-12);
  });
});

describe('an animated object starts from the values it shows at the current frame', () => {
  /** An empty whose location X is keyed 0 at frame 1 and 10 at frame 11, and rotation Z 0° → 90°. */
  function animated(t: Setup) {
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [0, 3, 0] });
    for (const [path, index, v0, v1] of [
      ['location', 0, 0, 10],
      ['rotation_euler', 2, 0, 90 * deg],
    ] as const) {
      let fc = createFCurve({ target_type: 'object', target_id: id, path, index });
      fc = insertKeyframe(fc, 1, v0, 'LINEAR');
      fc = insertKeyframe(fc, 11, v1, 'LINEAR');
      t.doc.setFCurve(fc);
    }
    t.ctx.state.frame = 6; // X 5, Z 45°
    t.select([id]);
    return id;
  }
  const key = (t: Setup, id: string, path: string, index: number) =>
    t.doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index }))!
      .keyframes.find((k) => k.frame === 6)?.value;

  it('without auto keying: the animated channels it changes are keyed at the frame, so the object shows what it did', () => {
    const t = setup();
    const id = animated(t);
    const fcurves = () => t.doc.listFCurves(id).length;
    t.run('transform.translate', { value: [1, 2, 0] });
    expect(t.doc.getObject(id)!.location).toEqual([6, 5, 0]);
    // X is animated: keyed at the frame with the moved value; Y is not: stored, no F-curve made
    expect(key(t, id, 'location', 0)).toBe(6);
    expect(fcurves()).toBe(2);
    // the rotation it left as it was is not keyed
    expect(key(t, id, 'rotation_euler', 2)).toBe(undefined);
    expect(maxDiff(t.origin(id), [6, 5, 0])).toBeLessThan(1e-12);
    // a turn about the object's own origin keys the animated Z rotation, not the location again
    const located = JSON.stringify(
      t.doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 })),
    );
    t.run('transform.rotate', { value: 10 * deg, orient_axis: 'Z' });
    expect(key(t, id, 'rotation_euler', 2)! / deg).toBeCloseTo(55, 12);
    expect(
      JSON.stringify(
        t.doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 })),
      ),
    ).toBe(located);
    expect(new FrameState(t.doc, 6).byId.get(id)!.rotation_euler[2] / deg).toBeCloseTo(55, 12);
    // a scale changes no animated channel: nothing is keyed, no F-curve made
    t.run('transform.resize', { value: [2, 2, 2] });
    expect(t.doc.getObject(id)!.scale).toEqual([2, 2, 2]);
    expect(fcurves()).toBe(2);
    // the keys elsewhere are kept: frame 11 still shows X 10
    expect(new FrameState(t.doc, 11).byId.get(id)!.location[0]).toBe(10);
  });

  it('without auto keying: a muted F-curve and a driven channel are not keyed', () => {
    const t = setup();
    const id = animated(t);
    const k = fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    t.doc.setFCurve({ ...t.doc.getFCurve(k)!, mute: true });
    t.run('transform.translate', { value: [1, 0, 0] });
    // muted: the stored value shows (0 stored + 1), the muted curve keeps its two keys
    expect(t.doc.getFCurve(k)!.keyframes.length).toBe(2);
    expect(maxDiff(t.origin(id), [1, 3, 0])).toBeLessThan(1e-12);
    // a driver sets the Z rotation: its F-curve is not keyed, the driver keeps deciding it
    t.doc.setDriver({
      target_type: 'object',
      target_id: id,
      path: 'rotation_euler',
      index: 2,
      expression: '0.5',
      variables: [],
      mute: false,
    });
    const r = fcurveKey({ target_type: 'object', target_id: id, path: 'rotation_euler', index: 2 });
    const curve = JSON.stringify(t.doc.getFCurve(r));
    t.run('transform.rotate', { value: 10 * deg, orient_axis: 'Z' });
    expect(JSON.stringify(t.doc.getFCurve(r))).toBe(curve);
    expect(new FrameState(t.doc, 6).byId.get(id)!.rotation_euler[2]).toBe(0.5);
  });

  it('with auto keying: the keys at the frame hold what the object shows moved', () => {
    const t = setup();
    const id = animated(t);
    t.ctx.state.autoKeying = true;
    t.run('transform.translate', { value: [1, 0, 0] });
    expect(key(t, id, 'location', 0)).toBe(6);
    // the rotation it left as it was is keyed as it shows (45°), not with the stored 0
    expect(key(t, id, 'rotation_euler', 2)! / deg).toBeCloseTo(45, 12);
    expect(maxDiff(t.origin(id), [6, 3, 0])).toBeLessThan(1e-12);
    t.run('transform.rotate', { value: 10 * deg, orient_axis: 'Z' });
    expect(key(t, id, 'rotation_euler', 2)! / deg).toBeCloseTo(55, 12);
    expect(key(t, id, 'location', 0)).toBe(6);
  });
});

describe('the Snap menu, Set Transform and Clear key animated channels as Move does', () => {
  /** An empty at [0, 3, 0] whose location X is keyed 0 at frame 1 and 10 at frame 11; frame 6. */
  function animatedX(t: Setup) {
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [0, 3, 0], scale: [2, 2, 2] });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.ctx.state.frame = 6;
    t.select([id]);
    return id;
  }
  const keyAt6 = (t: Setup, id: string, path: string, index: number) =>
    t.doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index }))
      ?.keyframes.find((k) => k.frame === 6)?.value;

  it('Selection to Cursor and Selection to Grid start from the shown location and key the animated X', () => {
    const t = setup();
    const id = animatedX(t);
    t.ctx.state.cursorLocation = [7, 1, 2];
    t.run('view3d.snap_selected_to_cursor');
    expect(maxDiff(t.origin(id), [7, 1, 2])).toBeLessThan(1e-12);
    expect(keyAt6(t, id, 'location', 0)).toBe(7);
    // Y and Z are not animated: stored, no F-curve made
    expect(t.doc.listFCurves(id).length).toBe(1);
    t.ctx.state.cursorLocation = [7.4, 1, 2];
    t.run('view3d.snap_selected_to_cursor');
    t.run('view3d.snap_selected_to_grid', { grid_size: 1 });
    expect(maxDiff(t.origin(id), [7, 1, 2])).toBeLessThan(1e-12);
    expect(keyAt6(t, id, 'location', 0)).toBe(7);
  });

  it('Set Transform keys an animated channel it sets, with auto keying every channel', () => {
    const t = setup();
    const id = animatedX(t);
    t.run('object.transform_set', { location: [8, 4, 0] });
    expect(keyAt6(t, id, 'location', 0)).toBe(8);
    expect(t.doc.listFCurves(id).length).toBe(1);
    expect(maxDiff(t.origin(id), [8, 4, 0])).toBeLessThan(1e-12);
    // setting the value the channel shows keys nothing
    const curve = JSON.stringify(t.doc.listFCurves(id));
    t.run('object.transform_set', { location: [8, 4, 0] });
    expect(JSON.stringify(t.doc.listFCurves(id))).toBe(curve);
    t.ctx.state.autoKeying = true;
    t.run('object.transform_set', { scale: [3, 3, 3] });
    expect(t.doc.listFCurves(id).length).toBe(9);
    expect(keyAt6(t, id, 'scale', 0)).toBe(3);
    expect(keyAt6(t, id, 'location', 0)).toBe(8);
  });

  it('Clear Location sets the animated X to 0 at the frame; with auto keying Clear keys its channels, as Blender', () => {
    const t = setup();
    const id = animatedX(t);
    t.run('object.location_clear');
    expect(maxDiff(t.origin(id), [0, 0, 0])).toBeLessThan(1e-12);
    expect(keyAt6(t, id, 'location', 0)).toBe(0);
    expect(t.doc.listFCurves(id).length).toBe(1);
    expect(new FrameState(t.doc, 11).byId.get(id)!.location[0]).toBe(10);
    t.ctx.state.autoKeying = true;
    t.run('object.scale_clear');
    // Blender's Clear Scale keys its Scale keying set: the three scale channels, nothing else
    expect(
      t.doc
        .listFCurves(id)
        .map((fc) => `${fc.path}[${fc.index}]`)
        .sort(),
    ).toEqual(['location[0]', 'scale[0]', 'scale[1]', 'scale[2]']);
    expect([0, 1, 2].map((i) => keyAt6(t, id, 'scale', i))).toEqual([1, 1, 1]);
    expect(t.doc.getObject(id)!.scale).toEqual([1, 1, 1]);
  });
});

describe('Median Point and Bounding Box Center leave out selected children of selected parents (B3)', () => {
  it('R Z 90° of P at the origin and its child C at (3, 0, 0), both selected, turns about P', () => {
    // Blender: C is not part of the transform (set_trans_object_base_flags) and does not count
    for (const pivot of ['MEDIAN_POINT', 'BOUNDING_BOX_CENTER'] as const) {
      const t = setup();
      const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
      const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [3, 0, 0], parent: p });
      t.select([p, c], p);
      t.ctx.state.pivotPoint = pivot;
      t.run('transform.rotate', { value: 90 * deg, orient_axis: 'Z' });
      expect(t.doc.getObject(p)!.location, pivot).toEqual([0, 0, 0]);
      expect(maxDiff(t.origin(c), [0, 3, 0]), pivot).toBeLessThan(1e-12);
    }
  });
});

describe('LOCAL orientation rebuilds an axis the active object scales to 0 (B4)', () => {
  it('G X 1 LOCAL moves along the rebuilt X axis: the cross product of Y and Z', () => {
    const t = setup();
    const a = t.doc.addObject({
      type: 'EMPTY',
      name: 'A',
      location: [1, 0, 0],
      rotation_euler: [0, 0, 30 * deg],
      scale: [0, 1, 1],
    });
    t.select([a]);
    t.run('transform.translate', { value: [1, 0, 0], orient_type: 'LOCAL' });
    expect(maxDiff(t.doc.getObject(a)!.location, [1 + Math.cos(30 * deg), 0.5, 0])).toBeLessThan(1e-12);
  });

  it('R X 100° LOCAL turns both objects about the rebuilt axis, as Blender', () => {
    const t = setup();
    const objs = [
      { loc: [1, 0, 0], rot: [0, 0, 30 * deg], scale: [0, 1, 1] },
      { loc: [3, 1, 0], rot: [0.3, 0.2, 0.1], scale: [1, 1, 1] },
    ];
    const ids = objs.map((o, i) =>
      t.doc.addObject({
        type: 'EMPTY',
        name: 'AB'[i],
        location: o.loc as Vec3,
        rotation_euler: o.rot as Vec3,
        scale: o.scale as Vec3,
      }),
    );
    t.select([ids[1], ids[0]], ids[0]);
    t.run('transform.rotate', { value: 100 * deg, orient_axis: 'X', orient_type: 'LOCAL' });
    const axis: Vec3 = [Math.cos(30 * deg), Math.sin(30 * deg), 0];
    const center = [2, 0.5, 0];
    objs.forEach((o, i) => {
      const ref = blenderTransform(o, null, 'ROTATE', axisAngle(axis, 100 * deg), center);
      const got = t.doc.getObject(ids[i])!;
      expect(maxDiff(got.location, ref.loc), `${'AB'[i]} location`).toBeLessThan(1e-12);
      expect(maxDiff(got.rotation_euler, ref.rot), `${'AB'[i]} rotation`).toBeLessThan(1e-12);
    });
  });
});

describe('snapping uses where the scene shows the objects, as Blender’s snap operators', () => {
  it('Selection to Cursor, Selection to Grid, Cursor to Active and Cursor to Selected with a bone child', () => {
    const t = setup();
    const { cube } = boneChild(t);
    t.ctx.state.cursorLocation = [-1, 4, 2];
    t.run('view3d.snap_selected_to_cursor');
    expect(maxDiff(t.origin(cube), [-1, 4, 2])).toBeLessThan(1e-12);
    t.doc.updateObject(cube, { location: [0.3, 0.4, -0.2] });
    t.run('view3d.snap_selected_to_grid', { grid_size: 0.5 });
    const g = t.origin(cube);
    for (const v of g) expect(Math.abs(v * 2 - Math.round(v * 2))).toBeLessThan(1e-12);
    t.run('view3d.snap_cursor_to_active');
    expect(maxDiff(t.ctx.state.cursorLocation, g)).toBeLessThan(1e-12);
    const other = t.doc.addObject({ type: 'EMPTY', name: 'O', location: [5, 5, 5] });
    t.select([cube, other]);
    t.run('view3d.snap_cursor_to_selected');
    expect(
      maxDiff(
        t.ctx.state.cursorLocation,
        g.map((v) => (v + 5) / 2),
      ),
    ).toBeLessThan(1e-12);
  });

  it('Selection to Cursor, also without offset, leaves a selected child of a selected parent to follow it', () => {
    // Blender's snap_selected_to_location skips an object whose parent (or an ancestor) is
    // selected too, with and without use_offset; Selection to Grid moves every selected object
    for (const use_offset of [false, true]) {
      const t = setup();
      const parent = t.doc.addObject({
        type: 'EMPTY',
        name: 'P',
        location: [1, 0, 0],
        rotation_euler: [0, 0, 0.5],
      });
      const child = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [0, 2, 0] });
      t.doc.updateObject(child, { parent });
      t.select([parent, child], parent);
      t.ctx.state.cursorLocation = [5, 5, 5];
      const offset = t.origin(child).map((v, i) => v - t.origin(parent)[i]);
      t.run('view3d.snap_selected_to_cursor', { use_offset });
      expect(t.doc.getObject(child)!.location, `use_offset ${use_offset}`).toEqual([0, 2, 0]);
      const at = use_offset ? [5 - offset[0] / 2, 5 - offset[1] / 2, 5 - offset[2] / 2] : [5, 5, 5];
      expect(maxDiff(t.origin(parent), at), `use_offset ${use_offset}`).toBeLessThan(1e-12);
      expect(
        maxDiff(
          t.origin(child),
          t.origin(parent).map((v, i) => v + offset[i]),
        ),
      ).toBeLessThan(1e-12);
    }
  });

  it('Cursor to Selected takes the bounding box center with that pivot point and leaves the cursor without a selection', () => {
    const t = setup();
    const ids = [
      [0, 0, 0],
      [1, 0, 0],
      [4, 2, 0],
    ].map((l, i) => t.doc.addObject({ type: 'EMPTY', name: `E${i}`, location: l as Vec3 }));
    t.select(ids);
    t.ctx.state.pivotPoint = 'BOUNDING_BOX_CENTER';
    t.run('view3d.snap_cursor_to_selected');
    expect(t.ctx.state.cursorLocation).toEqual([2, 1, 0]);
    t.ctx.state.pivotPoint = 'MEDIAN_POINT';
    t.run('view3d.snap_cursor_to_selected');
    expect(maxDiff(t.ctx.state.cursorLocation, [5 / 3, 2 / 3, 0])).toBeLessThan(1e-15);
    t.select([]);
    t.run('view3d.snap_cursor_to_selected');
    expect(maxDiff(t.ctx.state.cursorLocation, [5 / 3, 2 / 3, 0])).toBeLessThan(1e-15);
  });

  it('auto keying keys the snapped location where the object shows it', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [0.4, 1.6, 0] });
    t.select([id]);
    t.ctx.state.autoKeying = true;
    t.ctx.state.frame = 3;
    t.run('view3d.snap_selected_to_grid', { grid_size: 1 });
    expect(t.doc.listFCurves(id).map((f) => [f.path, f.index, f.keyframes[0].value])).toEqual([
      ['location', 0, 0],
      ['location', 1, 2],
      ['location', 2, 0],
    ]);
  });
});

describe('operators that keep world matrices keep them where the scene shows the objects', () => {
  it('parenting to a bone child and clearing that parent with Keep Transform', () => {
    const t = setup();
    const { cube } = boneChild(t);
    const o = t.doc.addObject({
      type: 'EMPTY',
      name: 'O',
      location: [4, -1, 2],
      rotation_euler: [0.1, 0.2, 0.3],
      scale: [1, 2, 0.5],
    });
    const w0 = t.world(o);
    t.select([o, cube], cube);
    t.run('object.parent_set', { type: 'OBJECT', keep_transform: true });
    expect(t.doc.getObject(o)!.parent).toBe(cube);
    expect(maxDiff(t.world(o), w0)).toBeLessThan(1e-12);
    t.select([o]);
    t.run('object.parent_clear', { type: 'CLEAR_KEEP_TRANSFORM' });
    expect(t.doc.getObject(o)!.parent).toBe(null);
    expect(maxDiff(t.world(o), w0)).toBeLessThan(1e-12);
  });

  it('parenting to an animated parent at a frame between its keys', () => {
    const t = setup();
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
    let fc = createFCurve({ target_type: 'object', target_id: p, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.ctx.state.frame = 6;
    const o = t.doc.addObject({ type: 'EMPTY', name: 'O', location: [1, 2, 3] });
    t.run('object.parent_to', { objects: [o], parent: p, keep_transform: true });
    expect(maxDiff(t.origin(o), [1, 2, 3])).toBeLessThan(1e-12);
  });

  it('deleting a bone child keeps its child where it shows', () => {
    const t = setup();
    const { cube } = boneChild(t);
    const g = t.doc.addObject({ type: 'EMPTY', name: 'G', location: [0, 0, 2], parent: cube });
    const w0 = t.world(g);
    t.run('object.delete', { objects: [cube] });
    expect(maxDiff(t.world(g), w0)).toBeLessThan(1e-12);
  });

  it('Duplicate with an offset moves the copy of a bone child by the offset in the world', () => {
    const t = setup();
    const { cube } = boneChild(t);
    t.run('object.duplicate', { offset: [0, 1, 0] });
    const copy = t.ctx.state.activeId!;
    expect(copy).not.toBe(cube);
    expect(maxDiff(t.origin(copy), [1, 3, 3])).toBeLessThan(1e-12);
  });

  it('Set Origin of a bone child keeps its geometry where it shows; to the 3D cursor it puts the origin there', () => {
    const t = setup();
    const { cube } = boneChild(t);
    const g = t.doc.addObject({ type: 'EMPTY', name: 'G', location: [0, 1, 0], parent: cube });
    const gw = t.world(g);
    const corners = () => {
      const w = t.world(cube);
      const m = t.doc.getMesh(t.doc.getObject(cube)!.data!)!;
      return [0, 1, 2].map((i) =>
        [0, 1, 2].map(
          (r) =>
            w[r] * m.positions[i * 3] +
            w[4 + r] * m.positions[i * 3 + 1] +
            w[8 + r] * m.positions[i * 3 + 2] +
            w[12 + r],
        ),
      );
    };
    const before = corners();
    t.ctx.state.cursorLocation = [0.5, 2.5, 3.5];
    t.run('object.origin_set', { type: 'ORIGIN_CURSOR' });
    expect(maxDiff(t.origin(cube), [0.5, 2.5, 3.5])).toBeLessThan(1e-12);
    corners().forEach((c, i) => expect(maxDiff(c, before[i]), `corner ${i}`).toBeLessThan(1e-12));
    expect(maxDiff(t.world(g), gw)).toBeLessThan(1e-12);
  });

  describe('Set Origin and Apply Transform of an object with an animated rotation use the rotation it shows, as Blender', () => {
    // a cube at [1, 2, 3] whose Z rotation is keyed 0° at frame 1 and 90° at frame 11; frame 6: 45°
    const animatedCube = (t: Setup) => {
      t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
      const cube = t.ctx.state.activeId!;
      let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'rotation_euler', index: 2 });
      fc = insertKeyframe(fc, 1, 0, 'LINEAR');
      fc = insertKeyframe(fc, 11, 90 * deg, 'LINEAR');
      t.doc.setFCurve(fc);
      t.ctx.state.frame = 6;
      t.select([cube]);
      return cube;
    };
    const corners = (t: Setup, id: string) => {
      const w = t.world(id);
      const m = t.doc.getMesh(t.doc.getObject(id)!.data!)!;
      return [0, 1, 2, 3].map((i) =>
        [0, 1, 2].map(
          (r) =>
            w[r] * m.positions[i * 3] +
            w[4 + r] * m.positions[i * 3 + 1] +
            w[8 + r] * m.positions[i * 3 + 2] +
            w[12 + r],
        ),
      );
    };
    it('Set Origin to the cursor moves the location by the offset turned by the shown 45°: the geometry stays', () => {
      const t = setup();
      const cube = animatedCube(t);
      const before = corners(t, cube);
      t.ctx.state.cursorLocation = [1.5, 2.5, 3.5];
      t.run('object.origin_set', { type: 'ORIGIN_CURSOR' });
      expect(maxDiff(t.origin(cube), [1.5, 2.5, 3.5])).toBeLessThan(1e-12);
      // (mesh positions are stored as 32-bit floats)
      corners(t, cube).forEach((c, i) => expect(maxDiff(c, before[i]), `corner ${i}`).toBeLessThan(1e-6));
    });

    it('Apply Rotation bakes the shown 45° into the mesh; the keys go on turning it, as in Blender once the frame changes', () => {
      const u = setup();
      const c2 = animatedCube(u);
      const v0 = u.doc.getMesh(u.doc.getObject(c2)!.data!)!.positions.slice(0, 3);
      u.run('object.transform_apply', { rotation: true, scale: false });
      const v1 = u.doc.getMesh(u.doc.getObject(c2)!.data!)!.positions.slice(0, 3);
      const c45 = Math.cos(45 * deg);
      expect(maxDiff([...v1], [c45 * v0[0] - c45 * v0[1], c45 * v0[0] + c45 * v0[1], v0[2]])).toBeLessThan(
        1e-6,
      );
      expect(u.doc.getObject(c2)!.rotation_euler).toEqual([0, 0, 0]);
    });
  });

  it('Join puts the joined geometry where the scene shows it', () => {
    const t = setup();
    const { cube } = boneChild(t);
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0] });
    const active = t.ctx.state.activeId!;
    const shown = (() => {
      const w = t.world(cube);
      const m = t.doc.getMesh(t.doc.getObject(cube)!.data!)!;
      return [0, 1, 2].map(
        (r) => w[r] * m.positions[0] + w[4 + r] * m.positions[1] + w[8 + r] * m.positions[2] + w[12 + r],
      );
    })();
    t.select([cube, active], active);
    t.run('object.join');
    const m = t.doc.getMesh(t.doc.getObject(active)!.data!)!;
    const found = [...Array(m.positions.length / 3).keys()].some(
      (i) => maxDiff([m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]], shown) < 1e-12,
    );
    expect(found).toBe(true);
  });

  it('Edit Mode moves the vertices of a bone child by the world offset', () => {
    const t = setup();
    const { cube } = boneChild(t);
    t.run('object.mode_set', { mode: 'EDIT' });
    t.run('mesh.select_all', { action: 'SELECT' });
    const vertexWorld = () => {
      const w = t.world(cube);
      const m = t.doc.getMesh(t.doc.getObject(cube)!.data!)!;
      return [0, 1, 2].map(
        (r) => w[r] * m.positions[0] + w[4 + r] * m.positions[1] + w[8 + r] * m.positions[2] + w[12 + r],
      );
    };
    const before = vertexWorld();
    t.run('transform.translate', { value: [0, 1, 0] });
    expect(maxDiff(vertexWorld(), [before[0], before[1] + 1, before[2]])).toBeLessThan(1e-12);
  });
});
