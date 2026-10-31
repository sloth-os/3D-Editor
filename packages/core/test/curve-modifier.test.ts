import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createMesh,
  createOperatorRegistry,
  defaultSpline,
  defaultSplinePoint,
  describeModifierTypes,
  encodeFloat32,
  identity4,
  modifierDependencies,
  modifierObjectParams,
  type ModifierData,
  type OperatorContext,
  type Spline,
  type SplinePoint,
  type Vec3,
} from '../src';

const pt = (co: Vec3, extra: Partial<SplinePoint> = {}): SplinePoint => ({
  ...defaultSplinePoint(co),
  ...extra,
});
const poly = (points: SplinePoint[], extra: Partial<Spline> = {}): Spline => ({
  ...defaultSpline('POLY', points),
  ...extra,
});
const circle = (r: number): Spline => ({
  ...defaultSpline('BEZIER', [pt([-r, 0, 0]), pt([0, r, 0]), pt([r, 0, 0]), pt([0, -r, 0])]),
  use_cyclic_u: true,
});

/** A row of vertices along X (x = 0..length) at the given y/z offsets. */
function rod(length: number, steps: number, offsets: [number, number][] = [[0, 0]]) {
  const positions: number[] = [];
  for (const [y, z] of offsets) for (let i = 0; i <= steps; i++) positions.push((length * i) / steps, y, z);
  return createMesh({ positions, faces: [] });
}

function modifier(params: Record<string, unknown>): ModifierData {
  return {
    id: 'm1',
    name: 'Curve',
    type: 'CURVE',
    show_viewport: true,
    show_render: true,
    show_in_editmode: true,
    show_expanded: true,
    params,
  };
}

function scene(
  spline: Spline,
  meshPositions: number[],
  params: Record<string, unknown> = {},
  curveExtra = {},
) {
  const doc = new SceneDoc();
  const cid = doc.addCurve({ splines: [spline], ...curveExtra });
  const curveObj = doc.addObject({ type: 'CURVE', name: 'Path', data: cid });
  const meshId = doc.addMesh('Rod', createMesh({ positions: meshPositions, faces: [] }));
  const obj = doc.addObject({
    type: 'MESH',
    name: 'Rod',
    data: meshId,
    modifiers: [modifier({ object: curveObj, ...params })],
  });
  const ev = new SceneEvaluator(doc);
  const positions = () => {
    const o = ev.evaluate(1).byId.get(obj)!;
    return { p: o.mesh!.positions, errors: o.modifierErrors };
  };
  return { doc, cid, curveObj, obj, meshId, positions };
}

const at = (p: number[], i: number): Vec3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];

describe('CURVE modifier', () => {
  it('is registered with Blender parameters and its curve dependency', () => {
    const info = describeModifierTypes().find((d) => d.type === 'CURVE')!;
    expect(info).toMatchObject({ label: 'Curve', category: 'DEFORM' });
    expect(info.defaults).toMatchObject({
      object: null,
      deform_axis: 'POS_X',
      use_radius: true,
      use_stretch: false,
    });
    expect(modifierObjectParams('CURVE')).toEqual(['object']);
    expect(modifierDependencies(modifier({ object: 'abc' }))).toEqual(['abc']);
  });

  it('leaves the mesh unchanged along a straight curve starting at the origin', () => {
    const src = rod(4, 8, [
      [0, 0],
      [0.5, 0.25],
      [-0.5, -1],
    ]).positions;
    const { positions } = scene(poly([pt([0, 0, 0]), pt([10, 0, 0])]), src);
    const { p, errors } = positions();
    expect(errors).toEqual([]);
    p.forEach((v, i) => expect(v).toBeCloseTo(src[i], 9));
  });

  it('bends the mesh around a circle (arc length along the deform axis)', () => {
    const R = 2;
    const src = rod(Math.PI * R, 32, [
      [0, 0],
      [0, 0.3],
    ]).positions;
    const { p } = scene(circle(R), src).positions();
    for (let i = 0; i <= 32; i++) {
      const v = at(p, i);
      expect(Math.hypot(v[0], v[1])).toBeCloseTo(R, 2);
      expect(v[2]).toBeCloseTo(0, 9);
      // z offsets keep their height (Z-up / minimum twist frame of a flat curve)
      expect(at(p, 33 + i)[2]).toBeCloseTo(0.3, 6);
    }
    // half way round: the circle starts at (−R, 0) and runs clockwise through (0, R)
    expect(at(p, 32)[0]).toBeCloseTo(R, 1);
    expect(at(p, 16)[1]).toBeCloseTo(R, 1);
  });

  it('maps every deform axis as a rotation and extrapolates past the ends', () => {
    const path = poly([pt([0, 0, 0]), pt([10, 0, 0])]);
    const run = (axis: string, v: Vec3) => at(scene(path, [...v], { deform_axis: axis }).positions().p, 0);
    expect(run('POS_X', [3, 1, 2])).toEqual([3, 1, 2].map((x) => expect.closeTo(x, 9)));
    expect(run('NEG_X', [-3, 1, 2])).toEqual([3, -1, 2].map((x) => expect.closeTo(x, 9)));
    expect(run('POS_Y', [1, 3, 2])).toEqual([3, -1, 2].map((x) => expect.closeTo(x, 9)));
    expect(run('NEG_Y', [1, -3, 2])).toEqual([3, 1, 2].map((x) => expect.closeTo(x, 9)));
    expect(run('POS_Z', [1, 2, 3])).toEqual([3, 1, 2].map((x) => expect.closeTo(x, 9)));
    expect(run('NEG_Z', [1, 2, -3])).toEqual([3, 1, -2].map((x) => expect.closeTo(x, 9)));
    // beyond the end the mesh continues straight along the end tangent
    expect(run('POS_X', [12, 0, 0])[0]).toBeCloseTo(12);
    expect(run('POS_X', [-2, 0, 0])[0]).toBeCloseTo(-2);
  });

  it('scales by the curve radius and stretches to the curve length', () => {
    const path = poly([pt([0, 0, 0], { radius: 2 }), pt([10, 0, 0], { radius: 2 })]);
    expect(at(scene(path, [1, 0, 1]).positions().p, 0)[2]).toBeCloseTo(2);
    expect(at(scene(path, [1, 0, 1], { use_radius: false }).positions().p, 0)[2]).toBeCloseTo(1);
    const stretched = scene(poly([pt([0, 0, 0]), pt([10, 0, 0])]), [0, 0, 0, 1, 0, 0], {
      use_stretch: true,
    }).positions().p;
    expect(at(stretched, 1)[0]).toBeCloseTo(10);
    expect(at(stretched, 0)[0]).toBeCloseTo(0);
  });

  it('honours object transforms of the mesh and the curve', () => {
    const R = 2;
    const src = rod(3, 6).positions;
    const base = scene(circle(R), src).positions().p;
    const s = scene(circle(R), src);
    s.doc.updateObject(s.curveObj, { location: [5, 1, 2] });
    s.doc.updateObject(s.obj, { location: [5, 1, 2] });
    // moving both objects together does not change the mesh in its own space
    s.positions().p.forEach((v, i) => expect(v).toBeCloseTo(base[i], 6));
    // moving only the mesh along the deform axis slides it along the curve
    const slide = scene(circle(R), [0, 0, 0]);
    slide.doc.updateObject(slide.obj, { location: [Math.PI * R, 0, 0] });
    const local = at(slide.positions().p, 0);
    expect(local[0] + Math.PI * R).toBeCloseTo(R, 1);
  });

  it('re-evaluates when the curve changes and weights by vertex group', () => {
    const s = scene(poly([pt([0, 0, 0]), pt([10, 0, 0])]), [1, 0, 0, 2, 0, 0]);
    expect(at(s.positions().p, 1)[1]).toBeCloseTo(0);
    s.doc.updateCurve(s.cid, { splines: [poly([pt([0, 0, 0]), pt([0, 10, 0])])] });
    expect(at(s.positions().p, 1)[1]).toBeCloseTo(2);
    s.doc.setVertexGroups(s.meshId, [{ name: 'Tip', weights: encodeFloat32([0, 0.5]) }]);
    s.doc.updateObject(s.obj, { modifiers: [modifier({ object: s.curveObj, vertex_group: 'Tip' })] });
    const p = s.positions().p;
    expect(at(p, 0)).toEqual([1, 0, 0].map((x) => expect.closeTo(x, 9)));
    expect(at(p, 1)).toEqual([1, 1, 0].map((x) => expect.closeTo(x, 9)));
    s.doc.updateObject(s.obj, { modifiers: [modifier({ object: s.curveObj, vertex_group: 'Nope' })] });
    expect(s.positions().errors[0].message).toMatch(/Vertex group/);
  });

  it('reports missing or non-curve targets without failing the evaluation', () => {
    const s = scene(poly([pt([0, 0, 0]), pt([1, 0, 0])]), [1, 2, 3], { object: 'missing' });
    const r = s.positions();
    expect(r.p).toEqual([1, 2, 3]);
    expect(r.errors[0].message).toMatch(/not a curve/);
    const unset = scene(poly([pt([0, 0, 0]), pt([1, 0, 0])]), [1, 2, 3], { object: null }).positions();
    expect(unset.errors).toEqual([]);
    expect(unset.p).toEqual([1, 2, 3]);
    const degenerate = scene(poly([pt([1, 1, 1]), pt([1, 1, 1])]), [1, 2, 3]).positions();
    expect(degenerate.errors).toHaveLength(1);
  });

  it('works without an evaluator context path provider', async () => {
    const { curveModifier } = await import('../src/modifiers/curve');
    const mesh = createMesh({ positions: [0, 0, 0], faces: [] });
    const ctx = {
      frame: 1,
      objectMatrix: identity4(),
      getObjectMesh: () => null,
      forRender: false,
      editMode: false,
    };
    expect(() => curveModifier.apply(mesh, curveModifier.schema.parse({ object: 'x' }), ctx)).toThrow(
      /not available/,
    );
    expect(curveModifier.apply(mesh, curveModifier.schema.parse({}), ctx)).toBe(mesh);
  });

  it('can be added with object.modifier_add using the curve name', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => {},
    };
    const path = reg.run<{ object: string }>(ctx, 'curve.primitive_nurbs_path_add', { location: [0, 0, 0] });
    expect(path.ok).toBe(true);
    reg.run(ctx, 'mesh.primitive_cylinder_add', {
      radius: 0.1,
      depth: 4,
      rotation: [0, Math.PI / 2, 0],
      location: [0, 0, 0],
    });
    const r = reg.run(ctx, 'object.modifier_add', { type: 'CURVE', params: { object: 'NurbsPath' } });
    expect(r.ok).toBe(true);
    const cyl = doc.getObject(ctx.state.activeId!)!;
    expect(cyl.modifiers[0].params.object).toBe(path.result!.object);
    const ev = new SceneEvaluator(doc).evaluate(1).byId.get(cyl.id)!;
    expect(ev.modifierErrors).toEqual([]);
    expect(ev.mesh!.positions.every(Number.isFinite)).toBe(true);
  });
});
