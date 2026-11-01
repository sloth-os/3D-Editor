import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  evaluateCurveSplines,
  isClosedManifold,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';

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
  const run = <T = Record<string, any>>(id: string, params?: unknown) => {
    const r = reg.run<T>(ctx, id, params);
    return r;
  };
  const ok = <T = Record<string, any>>(id: string, params?: unknown): T => {
    const r = run<T>(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result as T;
  };
  return { doc, reg, ctx, run, ok };
}

const CURVE_OPS = [
  'curve.primitive_bezier_curve_add',
  'curve.primitive_bezier_circle_add',
  'curve.primitive_nurbs_curve_add',
  'curve.primitive_nurbs_circle_add',
  'curve.primitive_nurbs_path_add',
  'curve.primitive_poly_add',
  'curve.add_from_points',
  'curve.spline_add',
  'curve.spline_set_points',
  'curve.spline_remove',
  'curve.switch_direction',
  'curve.cyclic_toggle',
  'curve.handle_type_set',
  'curve.properties_set',
  'curve.keyframe_insert',
  'object.text_add',
  'font.text_set',
];

describe('curve primitives', () => {
  it('adds Blender-like primitives at the cursor, selected and active', () => {
    const { doc, ctx, ok } = setup();
    ctx.state.cursorLocation = [1, 2, 3];
    const r = ok('curve.primitive_bezier_curve_add', { radius: 2 });
    const o = doc.getObject(r.object)!;
    expect(o).toMatchObject({ type: 'CURVE', name: 'BezierCurve', location: [1, 2, 3] });
    expect(ctx.state.activeId).toBe(o.id);
    expect(ctx.state.selectedIds).toEqual([o.id]);
    const c = doc.getCurve(o.data!)!;
    expect(c.splines[0].type).toBe('BEZIER');
    expect(c.splines[0].points.map((p) => p.co)).toEqual([
      [-2, 0, 0],
      [2, 0, 0],
    ]);
    expect(c.splines[0].points[0].handle_left).toEqual([-3, -1, 0]);
    const circle = doc.getCurve(
      doc.getObject(ok('curve.primitive_bezier_circle_add', { location: [0, 0, 0] }).object)!.data!,
    )!;
    expect(circle.splines[0].use_cyclic_u).toBe(true);
    expect(circle.splines[0].points).toHaveLength(4);
    const path = doc.getCurve(ok('curve.primitive_nurbs_path_add').curve)!;
    expect(path.splines[0]).toMatchObject({ type: 'NURBS', order_u: 5, use_endpoint_u: true });
    expect(path.splines[0].points.map((p) => p.co[0])).toEqual([-2, -1, 0, 1, 2]);
    const ncircle = doc.getCurve(ok('curve.primitive_nurbs_circle_add', { radius: 2 }).curve)!;
    expect(
      ncircle.splines[0].points.filter((p) => Math.abs(p.weight - 0.25 * Math.SQRT2) < 1e-12),
    ).toHaveLength(4);
    // Blender's corner weights make the order-4 NURBS circle round within 1%
    const radii = evaluateCurveSplines(ncircle)[0].points.map((p) => Math.hypot(p[0], p[1]));
    expect(Math.min(...radii)).toBeGreaterThan(2 * 0.99);
    expect(Math.max(...radii)).toBeLessThan(2 * 1.01);
    expect(doc.getCurve(ok('curve.primitive_nurbs_curve_add').curve)!.splines[0].use_endpoint_u).toBe(false);
  });

  it('accepts curve fields directly and needs Object Mode', () => {
    const { doc, ctx, ok, run } = setup();
    const r = ok('curve.primitive_bezier_circle_add', { bevel_depth: 0.2, dimensions: '2D', name: 'Ring' });
    expect(doc.getCurve(r.curve)).toMatchObject({ bevel_depth: 0.2, dimensions: '2D', name: 'Ring' });
    expect(r.name).toBe('Ring');
    ctx.state.mode = 'EDIT';
    expect(run('curve.primitive_bezier_circle_add').error).toMatch(/Object Mode/);
    expect(run('curve.primitive_bezier_circle_add', { radius: -1 }).ok).toBe(false);
  });
});

describe('curves from points', () => {
  it('creates POLY, BEZIER and NURBS curves from point lists', () => {
    const { doc, ok } = setup();
    const poly = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      cyclic: true,
      bevel_depth: 0.05,
    });
    const c = doc.getCurve(poly.curve)!;
    expect(c.splines[0]).toMatchObject({ type: 'POLY', use_cyclic_u: true });
    expect(c.bevel_depth).toBe(0.05);
    expect(poly.points).toBe(3);
    const bez = ok('curve.add_from_points', {
      type: 'BEZIER',
      handle_type: 'VECTOR',
      points: [[0, 0, 0], { co: [1, 0, 0], radius: 2, tilt: 0.5, handle_left: [0.5, 1, 0] }, [2, 0, 0]],
    });
    const pts = doc.getCurve(bez.curve)!.splines[0].points;
    expect(pts[0].handle_left_type).toBe('VECTOR');
    expect(pts[1]).toMatchObject({
      radius: 2,
      tilt: 0.5,
      handle_left: [0.5, 1, 0],
      handle_left_type: 'FREE',
      handle_right_type: 'VECTOR',
    });
    const nurbs = ok('curve.add_from_points', {
      type: 'NURBS',
      order_u: 3,
      points: [{ co: [0, 0, 0], weight: 2 }, [1, 1, 0], [2, 0, 0]],
    });
    expect(doc.getCurve(nurbs.curve)!.splines[0]).toMatchObject({ order_u: 3 });
    expect(doc.getCurve(nurbs.curve)!.splines[0].points[0].weight).toBe(2);
    const p2 = ok('curve.primitive_poly_add', {
      points: [
        [0, 0, 0],
        [0, 0, 1],
      ],
    });
    expect(p2.type).toBe('POLY');
  });

  it('validates points', () => {
    const { run } = setup();
    expect(run('curve.add_from_points', { points: [] }).ok).toBe(false);
    expect(run('curve.add_from_points', { points: [[0, 0]] }).ok).toBe(false);
    expect(run('curve.add_from_points', { points: [{ co: [0, 0, 0], radius: -1 }] }).ok).toBe(false);
  });
});

describe('spline editing', () => {
  it('adds, replaces, reverses and removes splines', () => {
    const { doc, ok, run } = setup();
    const r = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    expect(
      ok('curve.spline_add', {
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [1, 2, 0],
        ],
        type: 'BEZIER',
        material_index: 1,
      }),
    ).toEqual({
      spline_index: 1,
      spline_count: 2,
    });
    ok('curve.spline_set_points', {
      object: r.name,
      spline_index: 0,
      points: [[0, 0, 0], { co: [2, 0, 0], radius: 0.5, tilt: 0.3 }, [2, 2, 0]],
      cyclic: true,
    });
    let c = doc.getCurve(r.curve)!;
    expect(c.splines[0].points).toHaveLength(3);
    expect(c.splines[0].use_cyclic_u).toBe(true);
    expect(c.splines[0].points[1].radius).toBe(0.5);
    expect(c.splines[1].material_index).toBe(1);
    ok('curve.switch_direction', { spline_index: 0 });
    c = doc.getCurve(r.curve)!;
    expect(c.splines[0].points.map((p) => p.co)).toEqual([
      [2, 2, 0],
      [2, 0, 0],
      [0, 0, 0],
    ]);
    // tilt is measured around the direction of travel, so reversing negates it (like Blender)
    expect(c.splines[0].points.map((p) => p.tilt)).toEqual([0, -0.3, 0]);
    ok('curve.cyclic_toggle', { spline_index: 0 });
    expect(doc.getCurve(r.curve)!.splines[0].use_cyclic_u).toBe(false);
    ok('curve.cyclic_toggle', { cyclic: true });
    expect(doc.getCurve(r.curve)!.splines.every((s) => s.use_cyclic_u)).toBe(true);
    ok('curve.handle_type_set', { spline_index: 1, type: 'VECTOR', points: [1] });
    const pts = doc.getCurve(r.curve)!.splines[1].points;
    expect(pts.map((p) => p.handle_left_type)).toEqual(['AUTO', 'VECTOR', 'AUTO']);
    expect(run('curve.spline_remove', { spline_index: 5 }).error).toMatch(/out of range/);
    expect(ok('curve.spline_remove', { spline_index: 0 })).toEqual({ spline_count: 1 });
  });

  it('only edits curve objects', () => {
    const { ok, run } = setup();
    ok('mesh.primitive_cube_add');
    expect(run('curve.spline_add', { points: [[0, 0, 0]] }).error).toMatch(/MESH object/);
    expect(run('curve.properties_set', { object: 'Nope', bevel_depth: 1 }).error).toMatch(/not found/);
    ok('object.text_add');
    expect(run('curve.spline_add', { points: [[0, 0, 0]] }).error).toMatch(/FONT object/);
  });
});

describe('curve properties', () => {
  it('sets geometry fields and resolves bevel objects by name', () => {
    const { doc, ok, run } = setup();
    const profile = ok('curve.primitive_bezier_circle_add', { radius: 0.1, name: 'Profile' });
    const r = ok('curve.primitive_bezier_curve_add');
    const res = ok('curve.properties_set', {
      bevel_object: 'Profile',
      bevel_factor_end: 0.5,
      fill_mode: 'HALF',
    });
    expect(res).toEqual({
      bevel_object: profile.object,
      bevel_mode: 'OBJECT',
      bevel_factor_end: 0.5,
      fill_mode: 'HALF',
    });
    expect(doc.getCurve(r.curve)!.bevel_object).toBe(profile.object);
    expect(run('curve.properties_set', { bevel_object: r.object }).error).toMatch(/itself/);
    ok('object.text_add', { name: 'Label' });
    expect(run('curve.properties_set', { object: r.object, bevel_object: 'Label' }).error).toMatch(
      /must be a curve/,
    );
    expect(run('curve.properties_set', { object: r.object }).error).toMatch(/No properties/);
    expect(run('curve.properties_set', { object: r.object, bevel_factor_end: 2 }).ok).toBe(false);
    ok('curve.properties_set', { object: r.object, bevel_object: null });
    expect(doc.getCurve(r.curve)!.bevel_object).toBeNull();
    // the bevel object profile is used by the evaluator
    ok('curve.properties_set', { object: r.object, bevel_object: 'Profile' });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(r.object)!.mesh).toBeDefined();
  });
});

describe('text operators', () => {
  it('adds text objects with layout metrics', () => {
    const { doc, ok } = setup();
    const r = ok('object.text_add', {
      body: 'Hello\nWorld',
      size: 2,
      align_x: 'CENTER',
      extrude: 0.1,
      location: [0, 0, 1],
    });
    const o = doc.getObject(r.object)!;
    expect(o).toMatchObject({ type: 'FONT', name: 'Text', location: [0, 0, 1] });
    const c = doc.getCurve(o.data!)!;
    expect(c).toMatchObject({
      body: 'Hello\nWorld',
      size: 2,
      align_x: 'CENTER',
      extrude: 0.1,
      fill_mode: 'BOTH',
      dimensions: '2D',
    });
    expect(r.lines).toBe(2);
    expect(r.width).toBeGreaterThan(5);
    expect(r.bounds.min[0]).toBeCloseTo(-r.bounds.max[0]);
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(isClosedManifold(ev.byId.get(o.id)!.mesh!)).toBe(true);
  });

  it('changes and appends text', () => {
    const { doc, ok, run } = setup();
    const r = ok('object.text_add', { body: 'Score: ' });
    expect(ok('font.text_set', { body: '42', append: true }).body).toBe('Score: 42');
    ok('font.text_set', { object: r.object, shear: 0.2, align_y: 'CENTER' });
    expect(doc.getCurve(r.curve)).toMatchObject({ body: 'Score: 42', shear: 0.2, align_y: 'CENTER' });
    expect(run('font.text_set', {}).error).toMatch(/Nothing to change/);
    ok('curve.primitive_bezier_circle_add');
    expect(run('font.text_set', { body: 'x' }).error).toMatch(/CURVE object/);
  });
});

describe('object.convert', () => {
  it('bakes curves into meshes keeping name, transform and materials', () => {
    const { doc, ctx, ok } = setup();
    const r = ok('curve.primitive_bezier_circle_add', {
      bevel_depth: 0.1,
      location: [1, 0, 0],
      name: 'Hoop',
    });
    const mat = doc.addMaterial({ name: 'Gold' });
    doc.updateObject(r.object, { material_slots: [mat] });
    ok('curve.keyframe_insert', { path: 'bevel_depth', frame: 1 });
    const res = ok('object.convert', { target: 'MESH' });
    expect(res.converted).toEqual([{ object: r.object, name: 'Hoop', type: 'MESH' }]);
    const o = doc.getObject(r.object)!;
    expect(o).toMatchObject({ type: 'MESH', name: 'Hoop', location: [1, 0, 0], material_slots: [mat] });
    const m = doc.getMesh(o.data!)!;
    expect(isClosedManifold(m)).toBe(true);
    // the curve data and its animation are gone
    expect(doc.getCurve(r.curve)).toBeNull();
    expect(doc.listFCurves(r.curve)).toHaveLength(0);
    expect(ctx.state.selectedIds).toEqual([r.object]);
  });

  it('turns wires into loose edges and text into meshes or curves', () => {
    const { doc, ctx, ok } = setup();
    const wire = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
    });
    ok('object.convert');
    const wm = doc.getMesh(doc.getObject(wire.object)!.data!)!;
    expect(wm.faces).toHaveLength(0);
    expect(wm.looseEdges).toEqual([0, 1, 1, 2]);
    const t = ok('object.text_add', { body: 'AB', extrude: 0.05 });
    const asCurve = ok('object.convert', { target: 'CURVE', keep_original: true });
    const copy = doc.getObject(asCurve.converted[0].object)!;
    expect(copy.type).toBe('CURVE');
    expect(copy.id).not.toBe(t.object);
    expect(doc.getObject(t.object)!.type).toBe('FONT');
    const cc = doc.getCurve(copy.data!)!;
    expect(cc.splines.length).toBeGreaterThanOrEqual(5); // A (outline + counter), B (outline + 2 counters)
    expect(cc.splines.every((s) => s.type === 'POLY' && s.use_cyclic_u)).toBe(true);
    expect(ctx.state.selectedIds).toEqual([copy.id]);
    // the converted curve evaluates like the text did
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(isClosedManifold(ev.byId.get(copy.id)!.mesh!)).toBe(true);
    ctx.state.selectedIds = [t.object];
    ok('object.convert');
    const tm = doc.getMesh(doc.getObject(t.object)!.data!)!;
    expect(isClosedManifold(tm)).toBe(true);
  });

  it('keeps the geometry animation of text converted to a curve (the layout is baked)', () => {
    const { doc, ok } = setup();
    const t = ok('object.text_add', { body: 'Hi', extrude: 0.05, location: [0, 0, 0] });
    ok('curve.keyframe_insert', { path: 'extrude', frame: 1, value: 0 });
    ok('curve.keyframe_insert', { path: 'extrude', frame: 11, value: 0.2 });
    ok('curve.keyframe_insert', { path: 'size', frame: 1, value: 1 });
    ok('curve.keyframe_insert', { path: 'size', frame: 11, value: 2 });
    const top = (frame: number) => {
      const m = new SceneEvaluator(doc).evaluate(frame).byId.get(t.object)!.mesh!;
      return Math.max(...m.positions.filter((_, i) => i % 3 === 2));
    };
    expect(top(11)).toBeCloseTo(0.2);
    const r = ok('object.convert', { target: 'CURVE' });
    expect(r.converted).toEqual([{ object: t.object, name: 'Text', type: 'CURVE' }]);
    const data = doc.getObject(t.object)!.data!;
    expect(data).not.toBe(t.curve);
    // extrude keeps animating the converted curve; the text size channel is gone with the text
    expect(doc.listFCurves(data).map((f) => f.path)).toEqual(['extrude']);
    expect(doc.listFCurves(t.curve)).toHaveLength(0);
    expect(top(6)).toBeCloseTo(0.1);
    expect(top(11)).toBeCloseTo(0.2);
  });

  it('keeps the original mesh object and its modifiers with keep_original', () => {
    const { doc, ctx, ok } = setup();
    const m = ok('mesh.primitive_cube_add', { size: 1 });
    const id = m.object ?? m.id;
    ok('object.modifier_add', { object: id, type: 'SUBSURF' });
    ctx.state.selectedIds = [id];
    const r = ok('object.convert', { target: 'MESH', keep_original: true });
    expect(r.converted).toHaveLength(1);
    const copy = doc.getObject(r.converted[0].object)!;
    expect(copy.id).not.toBe(id);
    expect(copy).toMatchObject({ type: 'MESH', modifiers: [] });
    expect(doc.getMesh(copy.data!)!.positions.length / 3).toBe(26);
    // the original is untouched
    const orig = doc.getObject(id)!;
    expect(orig.modifiers).toHaveLength(1);
    expect(orig.data).not.toBe(copy.data);
    expect(doc.getMesh(orig.data!)!.positions.length / 3).toBe(8);
    expect(ctx.state.selectedIds).toEqual([copy.id]);
  });
});

const toWorld = (w: Mat4, p: readonly number[]): Vec3 => [
  w[0] * p[0] + w[4] * p[1] + w[8] * p[2] + w[12],
  w[1] * p[0] + w[5] * p[1] + w[9] * p[2] + w[13],
  w[2] * p[0] + w[6] * p[1] + w[10] * p[2] + w[14],
];

/** World positions of an object's evaluated mesh vertices (or of its sampled splines). */
function worldGeometry(doc: SceneDoc, id: string, frame = 1, what: 'mesh' | 'splines' = 'mesh'): Vec3[] {
  const e = new SceneEvaluator(doc).evaluate(frame).byId.get(id)!;
  if (what === 'splines')
    return evaluateCurveSplines(e.curve!).flatMap((s) => s.points.map((p) => toWorld(e.worldMatrix, p)));
  const out: Vec3[] = [];
  for (let i = 0; i < e.mesh!.positions.length; i += 3)
    out.push(toWorld(e.worldMatrix, e.mesh!.positions.slice(i, i + 3)));
  return out;
}

function expectSamePoints(a: Vec3[], b: Vec3[], digits = 9): void {
  expect(b).toHaveLength(a.length);
  a.forEach((p, i) => p.forEach((v, k) => expect(b[i][k]).toBeCloseTo(v, digits)));
}

describe('object transforms of curves and text', () => {
  it('applies scale to curves and text without changing what they look like', () => {
    const { doc, ctx, ok } = setup();
    const c = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0.5],
      ],
      type: 'BEZIER',
      bevel_depth: 0.1,
      location: [0, 0, 0],
      scale: [3, 3, 3],
    });
    const t = ok('object.text_add', {
      body: 'Hi!',
      location: [0, 2, 0],
      scale: [2, 2, 2],
      extrude: 0.05,
      offset_x: 0.5,
    });
    const curveBefore = worldGeometry(doc, c.object);
    const textBefore = worldGeometry(doc, t.object);
    ctx.state.selectedIds = [c.object, t.object];
    ok('object.transform_apply', { scale: true, rotation: true });
    expect(doc.getObject(c.object)!.scale).toEqual([1, 1, 1]);
    expect(doc.getObject(t.object)!.scale).toEqual([1, 1, 1]);
    expectSamePoints(curveBefore, worldGeometry(doc, c.object));
    expectSamePoints(textBefore, worldGeometry(doc, t.object));
    // Blender's "Apply Properties": radius and font size carry the scale
    for (const p of doc.getCurve(c.curve)!.splines[0].points) expect(p.radius).toBeCloseTo(3, 12);
    expect(doc.getCurve(t.curve)).toMatchObject({ size: 2, extrude: 0.1, offset_x: 1 });
    // without properties the thickness is not carried over (as asked)
    const c2 = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      bevel_depth: 0.1,
      scale: [2, 2, 2],
    });
    ok('object.transform_apply', { properties: false });
    expect(doc.getCurve(c2.curve)!.splines[0].points.map((p) => p.radius)).toEqual([1, 1]);
  });

  it('applies rotation, location and non-uniform scale to 3D curves (handles keep the shape)', () => {
    const { doc, ctx, ok } = setup();
    const c = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0.5, 0],
        [2, -0.5, 0.3],
        [3, 0, 0],
      ],
      type: 'BEZIER',
      location: [1, 2, 3],
      rotation: [0.3, -0.5, 1.1],
      scale: [1, 2, 0.5],
    });
    const before = worldGeometry(doc, c.object, 1, 'splines');
    ctx.state.selectedIds = [c.object];
    ok('object.transform_apply', { location: true, rotation: true, scale: true });
    expect(doc.getObject(c.object)).toMatchObject({
      location: [0, 0, 0],
      rotation_euler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expectSamePoints(before, worldGeometry(doc, c.object, 1, 'splines'));
    // AUTO handles would be recomputed differently after a non-uniform scale: they became ALIGNED
    const pts = doc.getCurve(c.curve)!.splines[0].points;
    expect(pts.every((p) => p.handle_left_type === 'ALIGNED' && p.handle_right_type === 'ALIGNED')).toBe(
      true,
    );
    // a uniform transform keeps AUTO handles
    const u = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 0],
      ],
      type: 'BEZIER',
      rotation: [0, 0, 1],
      scale: [2, 2, 2],
    });
    const ub = worldGeometry(doc, u.object, 1, 'splines');
    ok('object.transform_apply');
    expectSamePoints(ub, worldGeometry(doc, u.object, 1, 'splines'));
    expect(doc.getCurve(u.curve)!.splines[0].points.every((p) => p.handle_left_type === 'AUTO')).toBe(true);
  });

  it('keeps 2D curves in their plane and text unrotated, refusing before anything changes', () => {
    const { doc, ctx, ok, run } = setup();
    const cube = ok('mesh.primitive_cube_add', { size: 1, scale: [2, 2, 2] });
    const cubeId = cube.object ?? cube.id;
    const flat = ok('curve.primitive_bezier_circle_add', {
      dimensions: '2D',
      extrude: 0.1,
      location: [3, 1, 0],
      rotation: [0, 0, 0.7],
    });
    const before = worldGeometry(doc, flat.object);
    ctx.state.selectedIds = [cubeId, flat.object];
    // a rotation about Z and an X/Y location fit the plane
    ok('object.transform_apply', { location: true, rotation: true, scale: true });
    expectSamePoints(before, worldGeometry(doc, flat.object));
    expect(doc.getObject(flat.object)!.location).toEqual([0, 0, 0]);
    // a rotation about X does not: nothing changes, not even the cube
    ok('curve.properties_set', { object: flat.object, dimensions: '2D' });
    doc.updateObject(flat.object, { rotation_euler: [Math.PI / 2, 0, 0] });
    doc.updateObject(cubeId, { scale: [2, 2, 2] });
    const r = run('object.transform_apply', { rotation: true, scale: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/2D curve stays in its local XY plane/);
    expect(doc.getObject(cubeId)!.scale).toEqual([2, 2, 2]);
    // text only takes its scale
    const t = ok('object.text_add', { body: 'Up', rotation: [Math.PI / 2, 0, 0], scale: [2, 2, 2] });
    const tb = worldGeometry(doc, t.object);
    expect(run('object.transform_apply', { rotation: true, scale: true }).error).toMatch(
      /text can only have its scale applied/,
    );
    ok('object.transform_apply', { rotation: false, scale: true });
    expect(doc.getObject(t.object)!.rotation_euler[0]).toBeCloseTo(Math.PI / 2);
    expectSamePoints(tb, worldGeometry(doc, t.object));
    // a zero rotation is no problem, a non-uniform text scale is
    doc.updateObject(t.object, { rotation_euler: [0, 0, 0], scale: [2, 1, 1] });
    expect(run('object.transform_apply', { rotation: true, scale: true }).error).toMatch(
      /uniform, positive X\/Y scale/,
    );
    doc.updateObject(t.object, { scale: [1.5, 1.5, 1.5] });
    ok('object.transform_apply', { rotation: true, scale: true });
    // size 2 (from the first apply) × 1.5
    expect(doc.getCurve(t.curve)!.size).toBeCloseTo(3);
  });

  it('keeps hierarchies in place when parents and children are applied together', () => {
    const { doc, ctx, ok, run } = setup();
    const p = ok('mesh.primitive_cube_add', { size: 1, scale: [2, 2, 2] });
    const pid = p.object ?? p.id;
    const t = ok('object.text_add', { body: 'Hi', location: [1, 0, 0] });
    const c = ok('curve.add_from_points', {
      points: [
        [0, 3, 0],
        [1, 3, 0],
      ],
      bevel_depth: 0.1,
      location: [0, 0, 0],
    });
    doc.setParent(t.object, pid, true);
    doc.setParent(c.object, pid, true);
    const tb = worldGeometry(doc, t.object);
    const cb = worldGeometry(doc, c.object);
    ctx.state.selectedIds = [pid, t.object, c.object];
    ok('object.transform_apply');
    expectSamePoints(tb, worldGeometry(doc, t.object));
    expectSamePoints(cb, worldGeometry(doc, c.object));
    // a rotation a parent passes down to its text child stays on the text, with a warning
    const q = ok('mesh.primitive_cube_add', { size: 1 });
    const qid = q.object ?? q.id;
    const t2 = ok('object.text_add', { body: 'Yo', location: [0, 0, 2] });
    doc.setParent(t2.object, qid, true);
    doc.updateObject(qid, { rotation_euler: [0.6, 0, 0] });
    const t2b = worldGeometry(doc, t2.object);
    ctx.state.selectedIds = [qid, t2.object];
    const r = run('object.transform_apply', { rotation: true, scale: true });
    expect(r.ok).toBe(true);
    expect(r.reports.some((x) => x.level === 'WARNING' && /keeps its transform/.test(x.message))).toBe(true);
    expect(doc.getObject(qid)!.rotation_euler).toEqual([0, 0, 0]);
    expectSamePoints(t2b, worldGeometry(doc, t2.object));
  });

  it('copies shared curve data and lets animated channels follow, in one undo step', () => {
    const { doc, ctx, ok } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const a = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      bevel_depth: 0.1,
      scale: [2, 2, 2],
    });
    const b = doc.addObject({ type: 'CURVE', name: 'Twin', data: a.curve, location: [0, 3, 0] });
    const twinBefore = worldGeometry(doc, b);
    ctx.state.selectedIds = [a.object];
    ok('object.transform_apply');
    expect(doc.getObject(a.object)!.data).not.toBe(a.curve);
    expect(doc.getObject(b)!.data).toBe(a.curve);
    expectSamePoints(twinBefore, worldGeometry(doc, b));
    // keyframed text size and offset follow the applied scale
    const t = ok('object.text_add', { body: 'Grow', scale: [2, 2, 2] });
    ok('curve.keyframe_insert', { path: 'size', frame: 1, value: 1 });
    ok('curve.keyframe_insert', { path: 'size', frame: 11, value: 3 });
    const at11 = worldGeometry(doc, t.object, 11);
    ok('object.transform_apply');
    expect(doc.getFCurve(`curve:${t.curve}:size:0`)!.keyframes.map((k) => k.value)).toEqual([2, 6]);
    expectSamePoints(at11, worldGeometry(doc, t.object, 11));
    um.undo();
    expect(doc.getObject(t.object)!.scale).toEqual([2, 2, 2]);
    expect(doc.getFCurve(`curve:${t.curve}:size:0`)!.keyframes.map((k) => k.value)).toEqual([1, 3]);
    expect(doc.getCurve(t.curve)!.size).toBe(1);
  });

  it('keeps the animation of shared curve data on the copy an applied object gets', () => {
    const { doc, ctx, ok } = setup();
    const a = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      bevel_depth: 0.1,
      location: [0, 0, 0],
      scale: [2, 2, 2],
    });
    const twin = doc.addObject({ type: 'CURVE', name: 'Twin', data: a.curve, location: [0, 3, 0] });
    ok('curve.keyframe_insert', { object: a.object, path: 'bevel_factor_end', frame: 1, value: 0 });
    ok('curve.keyframe_insert', { object: a.object, path: 'bevel_factor_end', frame: 11, value: 1 });
    doc.setDriver({
      target_type: 'curve',
      target_id: a.curve,
      path: 'bevel_depth',
      index: 0,
      expression: 'var + 0.1',
      variables: [{ name: 'var', target_type: 'curve', target_id: a.curve, path: 'extrude', index: 0 }],
      mute: false,
    });
    const at6 = worldGeometry(doc, a.object, 6);
    const twinAt6 = worldGeometry(doc, twin, 6);
    ctx.state.selectedIds = [a.object];
    ok('object.transform_apply');
    const data = doc.getObject(a.object)!.data!;
    expect(data).not.toBe(a.curve);
    // the half-grown tube looks the same at frame 6, for both users of the data
    expectSamePoints(at6, worldGeometry(doc, a.object, 6));
    expectSamePoints(twinAt6, worldGeometry(doc, twin, 6));
    expect(doc.listFCurves(data).map((f) => f.path)).toEqual(['bevel_factor_end']);
    expect(doc.listFCurves(a.curve).map((f) => f.path)).toEqual(['bevel_factor_end']);
    // drivers are copied too, reading the copy where they read the data itself
    const driver = doc.listDrivers(data)[0];
    expect(driver).toMatchObject({ path: 'bevel_depth', target_id: data });
    expect(driver.variables[0].target_id).toBe(data);
    expect(doc.listDrivers(a.curve)[0].variables[0].target_id).toBe(a.curve);
    // origin_set copies shared data the same way
    const b = doc.addObject({ type: 'CURVE', name: 'Third', data, location: [0, -3, 0] });
    ctx.state.selectedIds = [b];
    ok('object.origin_set', { type: 'ORIGIN_GEOMETRY' });
    expect(doc.getObject(b)!.data).not.toBe(data);
    expect(doc.listFCurves(doc.getObject(b)!.data!).map((f) => f.path)).toEqual(['bevel_factor_end']);
  });

  it('sets the origin of curves (control points) and text (offsets) without moving them', () => {
    const { doc, ctx, ok } = setup();
    const c = ok('curve.add_from_points', {
      points: [
        [1, 1, 0],
        [3, 1, 0],
        [3, 2, 1],
      ],
      bevel_depth: 0.1,
      location: [5, 0, 0],
    });
    const before = worldGeometry(doc, c.object);
    ctx.state.selectedIds = [c.object];
    ok('object.origin_set', { type: 'ORIGIN_GEOMETRY', center: 'MEDIAN' });
    const o = doc.getObject(c.object)!;
    // the origin moves onto the median of the control points (in world space)
    expect(o.location[0]).toBeCloseTo(5 + 7 / 3);
    expect(o.location[1]).toBeCloseTo(4 / 3);
    expect(o.location[2]).toBeCloseTo(1 / 3);
    expectSamePoints(before, worldGeometry(doc, c.object));
    // text: the offsets centre the glyphs on the origin
    const t = ok('object.text_add', { body: 'Text', location: [0, 0, 0] });
    const tb = worldGeometry(doc, t.object);
    ok('object.origin_set', { type: 'ORIGIN_GEOMETRY' });
    expectSamePoints(tb, worldGeometry(doc, t.object));
    const text = doc.getCurve(t.curve)!;
    expect(text.offset_x).toBeLessThan(0);
    const xs = worldGeometry(doc, t.object).map((p) => p[0] - doc.getObject(t.object)!.location[0]);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 6);
    // ORIGIN_CURSOR: the origin goes to the cursor, the curve stays where it is
    ctx.state.selectedIds = [c.object];
    ctx.state.cursorLocation = [0, 0, 0];
    ok('object.origin_set', { type: 'ORIGIN_CURSOR' });
    for (const v of doc.getObject(c.object)!.location) expect(v).toBeCloseTo(0, 9);
    expectSamePoints(before, worldGeometry(doc, c.object));
    // GEOMETRY_ORIGIN moves the geometry instead: its bounds (points ± radius) centre on the origin
    ok('object.origin_set', { type: 'GEOMETRY_ORIGIN', center: 'BOUNDS' });
    for (const v of doc.getObject(c.object)!.location) expect(v).toBeCloseTo(0, 9);
    const cos = doc.getCurve(c.curve)!.splines[0].points.map((p) => p.co);
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(...cos.map((p) => p[k])) - 1;
      const hi = Math.max(...cos.map((p) => p[k])) + 1;
      expect(lo + hi).toBeCloseTo(0, 9);
    }
    expect(worldGeometry(doc, c.object)[0][0]).not.toBeCloseTo(before[0][0], 3);
  });

  it('shades curves smooth or flat through their splines', () => {
    const { doc, ok, run } = setup();
    const c = ok('curve.primitive_bezier_circle_add', { bevel_depth: 0.1 });
    ok('object.shade_flat');
    expect(doc.getCurve(c.curve)!.splines.every((s) => s.use_smooth === false)).toBe(true);
    const ev = new SceneEvaluator(doc);
    expect(ev.evaluate(1).byId.get(c.object)!.mesh!.faceSmooth.some(Boolean)).toBe(false);
    ok('object.shade_smooth');
    expect(ev.evaluate(1).byId.get(c.object)!.mesh!.faceSmooth.every(Boolean)).toBe(true);
    ok('object.text_add', { body: 'A' });
    const r = run('object.shade_flat');
    expect(r.ok).toBe(true);
    expect(r.reports.some((x) => x.level === 'WARNING' && /always smooth/.test(x.message))).toBe(true);
  });
});

describe('agent-facing results and validation', () => {
  it('lists mesh objects whose modifiers object.convert applied', () => {
    const { doc, ctx, ok } = setup();
    const m = ok('mesh.primitive_cube_add', { size: 1 });
    const id = m.object ?? m.id;
    ok('object.modifier_add', { object: id, type: 'SUBSURF' });
    const plain = ok('mesh.primitive_cube_add', { size: 1 });
    ctx.state.selectedIds = [id, plain.object ?? plain.id];
    const r = ok('object.convert', { target: 'MESH' });
    expect(doc.getObject(id)!.modifiers).toHaveLength(0);
    // the cube without modifiers had nothing to convert
    expect(r.converted).toEqual([{ object: id, name: doc.getObject(id)!.name, type: 'MESH' }]);
  });

  it('rejects keyframes on channels that do not exist', () => {
    const { doc, run, ok } = setup();
    const c = ok('curve.add_from_points', {
      name: 'C',
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      bevel_depth: 0.1,
    });
    const err = (params: Record<string, unknown>) =>
      run('curve.keyframe_insert', { object: 'C', frame: 1, ...params }).error;
    expect(err({ path: 'splines[0].points[3].co', value: 2 })).toMatch(/has no point 3 \(it has 3 points\)/);
    expect(err({ path: 'splines[1].points[0].radius', value: 2 })).toMatch(/has no spline 1/);
    expect(err({ path: 'bevel_depth', index: 4, value: 0.5 })).toMatch(/single value/);
    expect(err({ path: 'splines[0].points[1].co', index: 3, value: 1 })).toMatch(/use 0\.\.2/);
    expect(err({ path: 'splines[0].points[1].handle_left', value: 1 })).toMatch(/no stored handle_left/);
    expect(err({ path: 'size', value: 2 })).toMatch(/only affects text/);
    expect(doc.listFCurves(c.curve)).toHaveLength(0);
    // valid channels still work, scalars with index 0 or -1
    expect(
      ok('curve.keyframe_insert', { object: 'C', path: 'bevel_depth', index: 0, frame: 1 }).inserted,
    ).toBe(1);
    expect(
      ok('curve.keyframe_insert', { object: 'C', path: 'splines[0].points[2].co', frame: 1 }).inserted,
    ).toBe(3);
    expect(
      ok('curve.keyframe_insert', { object: 'C', path: 'splines[0].points[2].tilt', frame: 1, value: 1 })
        .inserted,
    ).toBe(1);
  });

  it('documents the side positive offsets go to', () => {
    const { doc, ok, reg } = setup();
    const ring = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * 2 * Math.PI;
      return [Math.cos(a), Math.sin(a), 0];
    });
    const maxX = (id: string) => Math.max(...worldGeometry(doc, id).map((p) => p[0]));
    // counter-clockwise 3D loop: positive offsets go to the left of travel, i.e. inwards
    const ccw = ok('curve.add_from_points', {
      points: ring,
      type: 'BEZIER',
      cyclic: true,
      bevel_depth: 0.05,
      offset: 0.2,
      location: [0, 0, 0],
    });
    expect(maxX(ccw.object)).toBeLessThan(0.9);
    // reversed (clockwise) it grows, and 2D outlines always grow
    const cw = ok('curve.add_from_points', {
      points: [...ring].reverse(),
      type: 'BEZIER',
      cyclic: true,
      bevel_depth: 0.05,
      offset: 0.2,
      location: [0, 0, 0],
    });
    expect(maxX(cw.object)).toBeGreaterThan(1.2);
    const flat = ok('curve.add_from_points', {
      points: ring,
      type: 'BEZIER',
      cyclic: true,
      dimensions: '2D',
      extrude: 0.05,
      offset: 0.2,
      location: [0, 0, 0],
    });
    expect(maxX(flat.object)).toBeGreaterThan(1.15);
    // open 2D splines have no outside: the offset goes to the left of the direction of travel
    const open = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [2, 0, 0],
      ],
      dimensions: '2D',
      extrude: 0.05,
      offset: 0.2,
      location: [0, 0, 0],
    });
    for (const p of worldGeometry(doc, open.object)) expect(p[1]).toBeCloseTo(0.2, 9);
    const info = reg.describe().find((i) => i.id === 'curve.properties_set')!;
    const offset = (info.parameters as { properties: Record<string, { description: string }> }).properties
      .offset;
    expect(offset.description).toMatch(/counter-clockwise loop shrinks/);
    expect(offset.description).toMatch(/left of the direction of travel \(seen from \+Z\) on open splines/);
  });
});

describe('undo, snapshots and descriptions', () => {
  it('makes every operator one undo step', () => {
    const { doc, ok } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const r = ok('curve.add_from_points', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    ok('curve.properties_set', { bevel_depth: 0.3 });
    ok('curve.spline_add', {
      points: [
        [0, 1, 0],
        [1, 1, 0],
      ],
    });
    expect(doc.getCurve(r.curve)!.splines).toHaveLength(2);
    um.undo();
    expect(doc.getCurve(r.curve)!.splines).toHaveLength(1);
    expect(doc.getCurve(r.curve)!.bevel_depth).toBe(0.3);
    um.undo();
    expect(doc.getCurve(r.curve)!.bevel_depth).toBe(0);
    um.undo();
    expect(doc.listObjects()).toHaveLength(0);
    expect(doc.listCurves()).toHaveLength(0);
    um.redo();
    expect(doc.listObjects()).toHaveLength(1);
    const t = ok('object.text_add', { body: 'Hi' });
    ok('object.convert');
    um.undo();
    expect(doc.getObject(t.object)!.type).toBe('FONT');
    expect(doc.getCurve(t.curve)!.body).toBe('Hi');
  });

  it('survives snapshot round trips with identical geometry', () => {
    const { doc, ok } = setup();
    ok('curve.primitive_bezier_circle_add', { bevel_depth: 0.1, dimensions: '2D', extrude: 0.2 });
    ok('object.text_add', { body: 'Snap', extrude: 0.05, bevel_depth: 0.01 });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    const a = new SceneEvaluator(doc).evaluate(1);
    const b = new SceneEvaluator(copy).evaluate(1);
    for (const o of a.objects) {
      const other = b.byId.get(o.id)!;
      expect(other.curve).toEqual(o.curve);
      expect(other.mesh!.positions).toEqual(o.mesh!.positions);
    }
  });

  it('describes every parameter for AI agents', () => {
    const { reg } = setup();
    const infos = reg.describe();
    for (const id of CURVE_OPS) {
      const info = infos.find((i) => i.id === id);
      expect(info, id).toBeDefined();
      expect(info!.description.length, id).toBeGreaterThan(40);
      const props =
        (info!.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [name, schema] of Object.entries(props))
        expect(schema.description, `${id}.${name}`).toBeTruthy();
    }
    expect(infos.find((i) => i.id === 'object.convert')!.description).toMatch(/text/);
  });
});
