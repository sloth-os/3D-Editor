import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FrameState,
  SceneDoc,
  createConstraint,
  createEditorState,
  createFCurve,
  createMesh,
  createOperatorRegistry,
  defaultSpline,
  defaultSplinePoint,
  fcurveKey,
  insertKeyframe,
  transformPoint3,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';

/*
 * Cases the operators of Move, Rotate, Scale, Set Origin, Apply, Clear, Set Transform, Delete and
 * the Snap menu must get right, each with its expected values worked out by hand from what
 * Blender does (constraints_list_needinv for the constraints that stay in the space a transform
 * moves an object in, keepChildrenWorld after an origin move, the parent a deleted object's
 * children get, the channels the operators write and key).
 */

const reg = createOperatorRegistry();
const deg = Math.PI / 180;

const maxDiff = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const translationOf = (m: Mat4): Vec3 => [m[12], m[13], m[14]];

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const state = createEditorState();
  const ctx: OperatorContext = { doc, state, origin: doc.origin, source: 'test', report: () => undefined };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
  };
  const select = (...ids: string[]) => {
    state.selectedIds = ids;
    state.activeId = ids[ids.length - 1];
  };
  const world = (id: string) => new FrameState(doc, state.frame).world(id)!;
  /** A POLY curve object along its own X axis from 0 to 10, at the origin turned by `rotZ` about Z. */
  const path = (rotZ = 0) => {
    const data = doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([10, 0, 0])] },
      ],
    });
    return doc.addObject({ type: 'CURVE', name: 'Path', data, rotation_euler: [0, 0, rotZ] });
  };
  return { doc, state, run, select, world, path };
}

/** The keys of each object's map (by object name) that the Yjs transactions of `fn` set. */
function objectWrites(doc: SceneDoc, fn: () => void): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const objects = doc.map('objects');
  const listener = (tr: Y.Transaction) => {
    for (const [type, keys] of tr.changed) {
      if (!(type instanceof Y.Map) || type.parent !== objects) continue;
      const name = String(type.get('name'));
      for (const k of keys) if (k !== null) (out[name] ??= new Set()).add(k);
    }
  };
  doc.ydoc.on('afterTransaction', listener);
  try {
    fn();
  } finally {
    doc.ydoc.off('afterTransaction', listener);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

describe('constraints that stay in the space a transform moves an object in', () => {
  it('Follow Path: Move converts the offset through the path’s space, so the follower moves with the pointer', () => {
    const t = setup();
    const p = t.path(90 * deg);
    const id = t.doc.addObject({ type: 'EMPTY', name: 'Follower' });
    t.doc.updateObject(id, { constraints: [createConstraint('FOLLOW_PATH', { target: p })] });
    const before = t.world(id);
    t.select(id);
    t.run('transform.translate', { value: [1, 0, 0] });
    // Blender: location += smtx · offset, smtx = local · (world with the constraint)⁻¹ = Rz(−90°)
    expect(maxDiff(t.doc.getObject(id)!.location, [0, -1, 0])).toBeLessThan(1e-12);
    expect(maxDiff(translationOf(t.world(id)), [before[12] + 1, before[13], before[14]])).toBeLessThan(1e-12);
  });

  it('Clamp To: Rotate about the 3D cursor turns the origin where the constraint shows it', () => {
    const t = setup();
    const p = t.path();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'Clamped', location: [5, 3, 0] });
    t.doc.updateObject(id, { constraints: [createConstraint('CLAMP_TO', { target: p })] });
    expect(maxDiff(translationOf(t.world(id)), [5, 0, 0])).toBeLessThan(1e-12);
    t.state.pivotPoint = 'CURSOR';
    t.state.cursorLocation = [0, 0, 0];
    t.select(id);
    t.run('transform.rotate', { value: 90 * deg, orient_axis: 'Z' });
    // td->center is (5, 0, 0): it goes to (0, 5, 0), so the location moves by (−5, 5, 0)
    expect(maxDiff(t.doc.getObject(id)!.location, [0, 8, 0])).toBeLessThan(1e-12);
    expect(maxDiff(t.doc.getObject(id)!.rotation_euler, [0, 0, 90 * deg])).toBeLessThan(1e-12);
  });

  it('Copy Transforms mixed Before Split counts only for Rotate: Move and Scale read the object without it', () => {
    const t = setup();
    const target = t.doc.addObject({
      type: 'EMPTY',
      name: 'Target',
      location: [2, 0, 0],
      rotation_euler: [0, 0, 90 * deg],
    });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'Copier', location: [1, 0, 0] });
    t.doc.updateObject(id, {
      constraints: [createConstraint('COPY_TRANSFORMS', { target, params: { mix_mode: 'BEFORE_SPLIT' } })],
    });
    const before = t.world(id);
    t.select(id);
    t.run('transform.translate', { value: [1, 0, 0] });
    expect(t.doc.getObject(id)!.location).toEqual([2, 0, 0]);
    expect(maxDiff(translationOf(t.world(id)), [before[12] + 1, before[13], before[14]])).toBeLessThan(1e-12);
    // Scale 2 about the cursor at the origin: the origin read without the constraint, (2, 0, 0)
    t.state.pivotPoint = 'CURSOR';
    t.state.cursorLocation = [0, 0, 0];
    t.run('transform.resize', { value: [2, 2, 2] });
    expect(maxDiff(t.doc.getObject(id)!.location, [4, 0, 0])).toBeLessThan(1e-12);
    expect(maxDiff(t.doc.getObject(id)!.scale, [2, 2, 2])).toBeLessThan(1e-12);
  });
});

describe('operators that keep what the scene shows', () => {
  it('Set Origin of a child before its parent keeps the geometry of both where it was', () => {
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], name: 'Parent' });
    const parent = t.state.activeId!;
    t.run('mesh.primitive_cube_add', { location: [3, 0, 0], name: 'Child' });
    const child = t.state.activeId!;
    t.doc.updateObject(child, { parent });
    // move each mesh off its origin (Set Origin then moves the origin back onto the geometry)
    const shift = (id: string, d: Vec3) => {
      const o = t.doc.getObject(id)!;
      const m = structuredClone(t.doc.getMesh(o.data!)!);
      for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) m.positions[i + k] += d[k];
      t.doc.setMesh(o.data!, m);
    };
    shift(parent, [1, 0, 0]);
    shift(child, [0, 2, 0]);
    const vertices = (id: string) => {
      const m = t.doc.getMesh(t.doc.getObject(id)!.data!)!;
      const w = t.world(id);
      const out: Vec3[] = [];
      for (let i = 0; i < m.positions.length; i += 3)
        out.push(transformPoint3(w, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]));
      return out.flat();
    };
    const before = { parent: vertices(parent), child: vertices(child) };
    t.select(child, parent);
    t.run('object.origin_set', { type: 'ORIGIN_GEOMETRY' });
    expect(maxDiff(vertices(parent), before.parent)).toBeLessThan(1e-12);
    expect(maxDiff(vertices(child), before.child)).toBeLessThan(1e-12);
    expect(maxDiff(translationOf(t.world(child)), [3, 2, 0])).toBeLessThan(1e-12);
  });

  it('Set Origin writes no location when the origin is on the geometry already (up to rounding)', () => {
    const t = setup();
    // five vertices on X whose coordinates sum to 0, but whose median sums up to 2.8e-17
    const xs = [
      0.5121113657951355, 1.3869032859802246, -0.8559283018112183, -1.445825219154358, 0.40273886919021606,
    ];
    const data = t.doc.addMesh('Points', createMesh({ positions: xs.flatMap((x) => [x, 0, 0]) }));
    const id = t.doc.addObject({ type: 'MESH', name: 'Points', data, rotation_euler: [0.3, 0.2, 0.1] });
    const m = t.doc.getMesh(data)!;
    let mean = 0;
    for (let i = 0; i < xs.length; i++) mean += m.positions[i * 3] / xs.length;
    expect(mean).not.toBe(0);
    expect(Math.abs(mean)).toBeLessThan(1e-16);
    t.select(id);
    const writes = objectWrites(t.doc, () => t.run('object.origin_set', { type: 'ORIGIN_GEOMETRY' }));
    expect(writes).toEqual({});
    expect(t.doc.getObject(id)!.location).toEqual([0, 0, 0]);
  });

  it('Delete gives the children of the deleted object its parent, keeping where they are', () => {
    const t = setup();
    const grand = t.doc.addObject({
      type: 'EMPTY',
      name: 'Grandparent',
      location: [1, 0, 0],
      rotation_euler: [0, 0, 90 * deg],
    });
    const parent = t.doc.addObject({ type: 'EMPTY', name: 'Parent', location: [2, 0, 0], parent: grand });
    const child = t.doc.addObject({ type: 'EMPTY', name: 'Child', location: [0, 3, 0], parent });
    const before = t.world(child);
    t.select(parent);
    t.run('object.delete');
    expect(t.doc.getObject(child)!.parent).toBe(grand);
    expect(maxDiff(t.world(child), before)).toBeLessThan(1e-12);
  });

  it('Clear Location, Rotation and Scale write nothing when the channel is cleared already', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [0.5, 0, 0] });
    t.select(id);
    expect(objectWrites(t.doc, () => t.run('object.location_clear'))).toEqual({});
    expect(objectWrites(t.doc, () => t.run('object.scale_clear'))).toEqual({});
    expect(objectWrites(t.doc, () => t.run('object.rotation_clear'))).toEqual({ A: ['rotation_euler'] });
  });

  it('Apply Location resets the stored location whatever the animated one shows', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [3, 0, 0] });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, -5, 'LINEAR');
    fc = insertKeyframe(fc, 11, 5, 'LINEAR');
    t.doc.setFCurve(fc);
    // at frame 6 the animated location shows 0, its stored value is 3
    t.state.frame = 6;
    expect(translationOf(t.world(id))[0]).toBeCloseTo(0, 12);
    t.select(id);
    t.run('object.transform_apply', { location: true, rotation: false, scale: false });
    expect(t.doc.getObject(id)!.location).toEqual([0, 0, 0]);
  });

  it('Apply Location writes no location stored as 0 already, also where the animated one shows another value', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 1 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.select(id);
    const writes = objectWrites(t.doc, () =>
      t.run('object.transform_apply', { location: true, rotation: false, scale: false }),
    );
    expect(writes.A ?? []).not.toContain('location');
  });

  it('Set Transform with auto keying keys the values the object shows, an animated one included', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.state.autoKeying = true;
    t.select(id);
    t.run('object.transform_set', { rotation_euler: [0, 0, 1] });
    const key = t.doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 }))!
      .keyframes.find((k) => k.frame === 6)!;
    expect(key.value).toBe(5);
    expect(maxDiff(translationOf(t.world(id)), [5, 0, 0])).toBeLessThan(1e-12);
  });

  it('Selection to Cursor keeping the offset with the Active Element pivot puts the active object on the cursor', () => {
    const t = setup();
    const a = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    const b = t.doc.addObject({ type: 'EMPTY', name: 'B', location: [2, 0, 0] });
    t.select(a, b);
    t.state.pivotPoint = 'ACTIVE_ELEMENT';
    t.state.cursorLocation = [10, 0, 0];
    t.run('view3d.snap_selected_to_cursor', { use_offset: true });
    expect(t.doc.getObject(b)!.location).toEqual([10, 0, 0]);
    expect(t.doc.getObject(a)!.location).toEqual([8, 0, 0]);
  });
});

describe('Set Origin and Apply Transform on animated channels', () => {
  /** A cube whose X location is keyed 0 at frame 1 and 10 at frame 11, its mesh moved by `offset`. */
  function animatedCube(
    t: ReturnType<typeof setup>,
    offset: Vec3,
    path: 'location' | 'rotation_euler' = 'location',
  ) {
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], name: 'Cube' });
    const id = t.state.activeId!;
    const o = t.doc.getObject(id)!;
    const m = structuredClone(t.doc.getMesh(o.data!)!);
    for (let i = 0; i < m.positions.length; i += 3)
      for (let k = 0; k < 3; k++) m.positions[i + k] += offset[k];
    t.doc.setMesh(o.data!, m);
    const index = path === 'location' ? 0 : 2;
    let fc = createFCurve({ target_type: 'object', target_id: id, path, index });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, path === 'location' ? 10 : 90 * deg, 'LINEAR');
    t.doc.setFCurve(fc);
    return { id, key: fcurveKey({ target_type: 'object', target_id: id, path, index }) };
  }
  const vertices = (t: ReturnType<typeof setup>, id: string) => {
    const m = t.doc.getMesh(t.doc.getObject(id)!.data!)!;
    const w = t.world(id);
    const out: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3)
      out.push(...transformPoint3(w, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]));
    return out;
  };
  const keys = (t: ReturnType<typeof setup>, key: string) =>
    t.doc.getFCurve(key)!.keyframes.map((k) => [k.frame, k.value]);

  it('Set Origin keys the animated location at the frame, so the geometry stays where it shows there', () => {
    const t = setup();
    const { id, key } = animatedCube(t, [1, 0, 0]);
    t.state.frame = 6;
    const before = vertices(t, id);
    t.select(id);
    t.run('object.origin_set', { type: 'ORIGIN_GEOMETRY' });
    expect(maxDiff(vertices(t, id), before)).toBeLessThan(1e-12);
    // the origin moved by 1 on X: 5 + 1 keyed at frame 6; the other keys stay
    expect(keys(t, key)).toEqual([
      [1, 0],
      [6, 6],
      [11, 10],
    ]);
    // at the other keyframes the geometry shows moved by the opposite of the origin move
    t.state.frame = 1;
    expect(translationOf(t.world(id))[0]).toBe(0);
  });

  it('Apply Location keys the animated location 0 at the frame; Apply Rotation the animated rotation', () => {
    const t = setup();
    const { id, key } = animatedCube(t, [0, 0, 0]);
    t.state.frame = 6;
    const before = vertices(t, id);
    t.select(id);
    t.run('object.transform_apply', { location: true, rotation: false, scale: false });
    expect(maxDiff(vertices(t, id), before)).toBeLessThan(1e-12);
    expect(keys(t, key)).toEqual([
      [1, 0],
      [6, 0],
      [11, 10],
    ]);
    const r = setup();
    const turned = animatedCube(r, [0, 0, 0], 'rotation_euler');
    r.state.frame = 6;
    const shown = vertices(r, turned.id);
    r.select(turned.id);
    r.run('object.transform_apply', { location: false, rotation: true, scale: false });
    // the mesh stores its turned positions as 32-bit floats
    expect(maxDiff(vertices(r, turned.id), shown)).toBeLessThan(1e-6);
    expect(keys(r, turned.key)).toEqual([
      [1, 0],
      [6, 0],
      [11, 90 * deg],
    ]);
  });

  it('a child’s animated location is keyed at the frame when its parent’s origin moves', () => {
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], name: 'Parent' });
    const parent = t.state.activeId!;
    const p = t.doc.getObject(parent)!;
    const m = structuredClone(t.doc.getMesh(p.data!)!);
    for (let i = 0; i < m.positions.length; i += 3) m.positions[i] += 1;
    t.doc.setMesh(p.data!, m);
    const child = t.doc.addObject({ type: 'EMPTY', name: 'Child', parent });
    let fc = createFCurve({ target_type: 'object', target_id: child, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    const before = t.world(child);
    t.select(parent);
    t.run('object.origin_set', { type: 'ORIGIN_GEOMETRY' });
    expect(maxDiff(t.world(child), before)).toBeLessThan(1e-12);
    const key = fcurveKey({ target_type: 'object', target_id: child, path: 'location', index: 0 });
    expect(keys(t, key)).toEqual([
      [1, 0],
      [6, 4],
      [11, 10],
    ]);
  });
  it('a child’s rotation animated beyond a full turn keeps its turn when its parent’s origin moves', () => {
    // the child shows 6.5 rad at frame 6: kept where it is, it keeps that rotation, which writes and
    // keys nothing (6.5 − 2π, the same turn read without the value it holds, would be keyed)
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], name: 'Parent' });
    const parent = t.state.activeId!;
    const child = t.doc.addObject({ type: 'EMPTY', name: 'Child', parent, location: [0, 2, 0] });
    let fc = createFCurve({ target_type: 'object', target_id: child, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 6, 'LINEAR');
    fc = insertKeyframe(fc, 11, 7, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.state.cursorLocation = [1, 0, 0];
    const before = t.world(child);
    t.select(parent);
    t.run('object.origin_set', { type: 'ORIGIN_CURSOR' });
    expect(maxDiff(t.world(child), before)).toBeLessThan(1e-12);
    const key = fcurveKey({ target_type: 'object', target_id: child, path: 'rotation_euler', index: 2 });
    expect(keys(t, key)).toEqual([
      [1, 6],
      [11, 7],
    ]);
  });

  it('Set Origin keys nothing with auto keying on, as Blender’s does not', () => {
    const t = setup();
    t.state.autoKeying = true;
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], name: 'Cube' });
    const id = t.state.activeId!;
    t.state.cursorLocation = [1, 2, 3];
    t.select(id);
    t.run('object.origin_set', { type: 'ORIGIN_CURSOR' });
    expect(t.doc.getObject(id)!.location).toEqual([1, 2, 3]);
    expect(t.doc.listFCurves(id)).toEqual([]);
  });
});

describe('layout operators on animated objects key what they change, from what the objects show', () => {
  /** A cube at (0, 0, 3) whose rotation Z is keyed 0 at frame 1 and 90° at frame 11, shown at frame 6. */
  function turningCube(t: ReturnType<typeof setup>) {
    t.run('mesh.primitive_cube_add', { location: [0, 0, 3], name: 'Cube' });
    const id = t.state.activeId!;
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 90 * deg, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.select(id);
    return { id, key: fcurveKey({ target_type: 'object', target_id: id, path: 'rotation_euler', index: 2 }) };
  }
  const rotationZ = (m: readonly number[]) => Math.atan2(m[1], m[0]);

  it('Drop to Ground moves the object and leaves its animated rotation as it shows', () => {
    const t = setup();
    const { id, key } = turningCube(t);
    t.run('object.drop_to_ground');
    expect(rotationZ(t.world(id))).toBeCloseTo(45 * deg, 12);
    expect(t.doc.getFCurve(key)!.keyframes.map((k) => k.frame)).toEqual([1, 11]);
    expect(translationOf(t.world(id))[2]).toBeCloseTo(1, 9);
  });

  it('with auto keying it keys the rotation the object shows at the frame', () => {
    const t = setup();
    const { id, key } = turningCube(t);
    t.state.autoKeying = true;
    t.run('object.drop_to_ground');
    expect(rotationZ(t.world(id))).toBeCloseTo(45 * deg, 12);
    expect(t.doc.getFCurve(key)!.keyframes.find((k) => k.frame === 6)!.value).toBeCloseTo(45 * deg, 12);
    const z = t.doc.getFCurve(
      fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 2 }),
    )!;
    expect(z.keyframes.map((k) => [k.frame, k.value])).toEqual([[6, 1]]);
  });

  it('Set Dimensions of an animated scale keys the new scale at the frame', () => {
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], name: 'Cube' });
    const id = t.state.activeId!;
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'scale', index: 0 });
    fc = insertKeyframe(fc, 1, 1, 'LINEAR');
    fc = insertKeyframe(fc, 11, 3, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.frame = 6;
    t.select(id);
    // the cube is 2 wide, scaled by 2 at frame 6: 4 wide; 8 wide is a scale of 4
    t.run('object.dimensions_set', { x: 8, objects: [id] });
    expect(t.world(id)[0]).toBeCloseTo(4, 12);
    expect(t.doc.getFCurve(fcurveKey(fc))!.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [1, 1],
      [6, 4],
      [11, 3],
    ]);
  });
});
