import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  buildCurvePath,
  createFCurve,
  createMesh,
  decodeFloat32,
  defaultSpline,
  defaultSplinePoint,
  encodeFloat32,
  evaluateFCurve,
  evaluateSpline,
  insertKeyframe,
  renderItems,
  applyShapeKeys,
  type ShapeKeyData,
  type Spline,
} from '../src';

function polySpline(points: [number, number, number][], cyclic = false): Spline {
  return {
    ...defaultSpline(),
    type: 'POLY',
    use_cyclic_u: cyclic,
    points: points.map((co) => ({ ...defaultSplinePoint(), co })),
  };
}

describe('F-curve extrapolation', () => {
  it('repeats the keyed range with CYCLIC extrapolation', () => {
    let fc = createFCurve({ target_type: 'object', target_id: 'x', path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    fc = { ...fc, extrapolation: 'CYCLIC' };
    expect(evaluateFCurve(fc, 6)).toBeCloseTo(5);
    expect(evaluateFCurve(fc, 16)).toBeCloseTo(5);
    expect(evaluateFCurve(fc, -4)).toBeCloseTo(5);
    expect(evaluateFCurve(fc, 21)).toBeCloseTo(0);
  });
});

describe('shape keys', () => {
  it('blends relative keys by value and reports vertex count mismatches', () => {
    const base = createMesh({ positions: [0, 0, 0, 1, 0, 0], faces: [] });
    const key = (name: string, positions: number[], value: number): ShapeKeyData => ({
      name,
      value,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: '',
      data: encodeFloat32(positions),
    });
    const { mesh, errors } = applyShapeKeys(base, [
      key('Up', [0, 0, 2, 1, 0, 2], 0.5),
      key('Bad', [0, 0, 0], 1),
    ]);
    expect(mesh.positions).toEqual([0, 0, 1, 1, 0, 1]);
    expect(errors).toHaveLength(1);
    expect(Array.from(decodeFloat32(encodeFloat32([1.5, -2])))).toEqual([1.5, -2]);
  });

  it('animates shape key values through mesh F-curves and survives snapshots', () => {
    const doc = new SceneDoc();
    const meshId = doc.addMesh('M', createMesh({ positions: [0, 0, 0], faces: [] }));
    doc.addObject({ type: 'MESH', name: 'O', data: meshId });
    doc.setShapeKeys(meshId, [
      {
        name: 'Lift',
        value: 0,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: encodeFloat32([0, 0, 4]),
      },
    ]);
    doc.setVertexGroups(meshId, [{ name: 'G', weights: encodeFloat32([0.25]) }]);
    let fc = createFCurve({
      target_type: 'mesh',
      target_id: meshId,
      path: 'shape_keys["Lift"].value',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 1, 'LINEAR');
    doc.setFCurve(fc);
    const ev = new SceneEvaluator(doc);
    const at = (f: number) => ev.evaluate(f).objects.find((o) => o.name === 'O')!.mesh!.positions[2];
    expect(at(1)).toBeCloseTo(0);
    expect(at(6)).toBeCloseTo(2);
    expect(at(11)).toBeCloseTo(4);
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(copy.getShapeKeys(meshId)[0].name).toBe('Lift');
    expect(Array.from(decodeFloat32(copy.getVertexGroups(meshId)[0].weights))).toEqual([0.25]);
  });
});

describe('curves', () => {
  it('samples poly and bezier splines and builds arc-length paths', () => {
    const poly = polySpline([
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
    ]);
    expect(evaluateSpline(poly, 12).points).toHaveLength(3);
    const curve = { ...new SceneDoc().getCurve(new SceneDoc().addCurve())!, splines: [poly] };
    const path = buildCurvePath(curve)!;
    expect(path.length).toBeCloseTo(4);
    expect(path.sample(0.5).position).toEqual([2, 0, 0]);
    expect(path.sample(0.75).position[1]).toBeCloseTo(1);
    expect(path.sample(0.75).tangent).toEqual([0, 1, 0]);
    const bez: Spline = { ...poly, type: 'BEZIER' };
    const s = evaluateSpline(bez, 8);
    expect(s.points).toHaveLength(17);
    expect(s.points[16]).toEqual([2, 2, 0]);
  });

  it('evaluates curve objects as wire lines and duplicates their data', () => {
    const doc = new SceneDoc();
    const cid = doc.addCurve({
      splines: [
        polySpline(
          [
            [0, 0, 0],
            [1, 0, 0],
            [1, 1, 0],
          ],
          true,
        ),
      ],
    });
    const id = doc.addObject({ type: 'CURVE', name: 'Path', data: cid });
    const ev = new SceneEvaluator(doc).evaluate(1);
    const o = ev.byId.get(id)!;
    expect(o.curve?.splines).toHaveLength(1);
    expect(o.lines).toBeInstanceOf(Float32Array);
    expect(o.lines!.length).toBe(3 * 6); // three segments, closed
    expect(renderItems(ev)).toHaveLength(0);
  });
});

describe('scene evaluation', () => {
  it('reports driver errors without failing the evaluation', () => {
    const doc = new SceneDoc();
    const id = doc.addObject({ type: 'EMPTY', name: 'E' });
    doc.setDriver({
      target_type: 'object',
      target_id: id,
      path: 'location',
      index: 2,
      expression: '3',
      variables: [],
      mute: false,
    });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(id)!.data.location[2]).toBe(3);
    expect(ev.byId.get(id)!.worldMatrix[14]).toBe(3);
    expect(ev.instances).toEqual([]);
    expect(Array.isArray(ev.errors)).toBe(true);
  });

  it('includes meshes in render items with their world matrices', () => {
    const doc = new SceneDoc();
    doc.populateDefaultScene();
    const ev = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    const items = renderItems(ev, { forRender: true });
    expect(items.map((i) => i.data.name)).toContain('Cube');
    expect(items.every((i) => !i.instance)).toBe(true);
  });
});
