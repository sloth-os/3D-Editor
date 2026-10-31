import { describe, expect, it } from 'vitest';
import { DriverError, driverProblems, evaluateDriver, type DriverReadFn } from '../src/anim/drivers';
import {
  SceneDoc,
  SceneEvaluator,
  createFCurve,
  createMesh,
  encodeFloat32,
  insertKeyframe,
  type AnimTargetType,
  type DriverData,
  type DriverVariable,
} from '../src';

const v = (name: string, target_id: string, path: string, index = 0, target_type: AnimTargetType = 'object'): DriverVariable => ({
  name,
  target_type,
  target_id,
  path,
  index,
});

function driver(
  target_id: string,
  path: string,
  index: number,
  expression: string,
  variables: DriverVariable[] = [],
  target_type: AnimTargetType = 'object',
): DriverData {
  return { target_type, target_id, path, index, expression, variables, mute: false };
}

/** The DriverError thrown by `fn`. */
function driverError(fn: () => unknown): DriverError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DriverError);
    return e as DriverError;
  }
  throw new Error('expected a DriverError');
}

const table: Record<string, number> = { 'object:A:location:0': 2, 'object:A:location:1': 3, 'light:L:energy:0': 100 };
const read: DriverReadFn = (type, id, path, index) => table[`${type}:${id}:${path}:${index}`];

describe('evaluateDriver', () => {
  it('binds variables by name and the current frame', () => {
    const d = driver('B', 'location', 0, 'x * y + frame / 10 + sqrt(e_)', [
      v('x', 'A', 'location', 0),
      v('y', 'A', 'location', 1),
      v('e_', 'L', 'energy', 0, 'light'),
    ]);
    expect(evaluateDriver(d, 20, read)).toBe(2 * 3 + 2 + 10);
    expect(evaluateDriver(driver('B', 'location', 0, '7'), 1, read)).toBe(7);
    expect(evaluateDriver(driver('B', 'location', 0, 'frame'), 12.5, read)).toBe(12.5);
  });

  it('reports unreadable variables, even unused ones', () => {
    const missing = driver('B', 'location', 0, 'x + 1', [v('x', 'A', 'location', 0), v('gone', 'Z', 'scale', 2)]);
    const e = driverError(() => evaluateDriver(missing, 1, read));
    expect(e.message).toMatch(/Variable 'gone' cannot be read: object 'Z' scale\[2\] does not exist/);
    const nan = driverError(() =>
      evaluateDriver(driver('B', 'location', 0, 'x', [v('x', 'A', 'location', 0)]), 1, () => NaN),
    );
    expect(nan.message).toMatch(/Variable 'x' .* is NaN/);
    const throwing = driverError(() =>
      evaluateDriver(driver('B', 'location', 0, 'x', [v('x', 'A', 'location', 0)]), 1, () => {
        throw new Error('boom');
      }),
    );
    expect(throwing.message).toMatch(/cannot be read/);
  });

  it('reports syntax, name and math errors as DriverErrors', () => {
    expect(driverError(() => evaluateDriver(driver('B', 'location', 0, '1 +'), 1, read)).message).toMatch(
      /Unexpected end of the expression.* at column 4/,
    );
    expect(driverError(() => evaluateDriver(driver('B', 'location', 0, 'speed * 2'), 1, read)).message).toMatch(
      /Unknown name 'speed'/,
    );
    expect(driverError(() => evaluateDriver(driver('B', 'location', 0, '1 / (frame - 1)'), 1, read)).message).toMatch(
      /division by zero/,
    );
    expect(driverError(() => evaluateDriver(driver('B', 'location', 0, '10 ** 400'), 1, read)).message).toMatch(
      /evaluated to Infinity/,
    );
    expect(driverError(() => evaluateDriver(driver('B', 'location', 0, ''), 1, read)).message).toMatch(/empty/);
    const dup = driver('B', 'location', 0, 'x', [v('x', 'A', 'location', 0), v('x', 'A', 'location', 1)]);
    expect(driverError(() => evaluateDriver(dup, 1, read)).message).toMatch(/Duplicate variable name 'x'/);
    const reserved = driver('B', 'location', 0, '1', [v('frame', 'A', 'location', 0), v('sin', 'A', 'location', 0)]);
    expect(driverError(() => evaluateDriver(reserved, 1, read)).message).toMatch(/reserved.*built-in function/);
    const malformed = { ...driver('B', 'location', 0, '1'), variables: [null, { name: 'q' }] } as unknown as DriverData;
    expect(driverError(() => evaluateDriver(malformed, 1, read)).message).toMatch(/Malformed.*'q' cannot be read/);
    const noVars = { ...driver('B', 'location', 0, 'frame'), variables: undefined } as unknown as DriverData;
    expect(evaluateDriver(noVars, 3, read)).toBe(3);
    const nonString = { ...driver('B', 'location', 0, ''), expression: 5 } as unknown as DriverData;
    expect(driverError(() => evaluateDriver(nonString, 1, read)).message).toMatch(/empty/);
  });

  it('lists static problems of a driver', () => {
    expect(driverProblems(driver('B', 'location', 0, 'a + frame * pi', [v('a', 'A', 'location', 0)]))).toEqual([]);
    const p = driverProblems(driver('B', 'location', 0, 'a + b + toString', [v('a', 'A', 'location', 0), v('a', 'A', 'scale', 0)]));
    expect(p.join('\n')).toMatch(/Duplicate variable name 'a'/);
    expect(p.join('\n')).toMatch(/Unknown name 'b' in the expression: add a variable named 'b' \(variables: 'a'\)/);
    expect(p.join('\n')).toMatch(/Unknown name 'toString'/);
    expect(driverProblems(driver('B', 'location', 0, '(')).join()).toMatch(/Unexpected end/);
    expect(driverProblems(driver('B', 'location', 0, 'x')).join()).toMatch(/the driver has no variables/);
    const bad = { expression: '1', variables: [{ name: 'k', path: '', target_id: 3, index: -1 }] } as unknown as DriverData;
    expect(driverProblems(bad).join('\n')).toMatch(/no data path[\s\S]*no target[\s\S]*invalid index/);
  });
});

describe('drivers in scene evaluation', () => {
  function keyed(doc: SceneDoc, id: string, path: string, index: number, keys: [number, number][]) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path, index });
    for (const [f, val] of keys) fc = insertKeyframe(fc, f, val, 'LINEAR');
    doc.setFCurve(fc);
  }

  it('drives properties from the frame, after F-curves', () => {
    const doc = new SceneDoc();
    const id = doc.addObject({ type: 'EMPTY', name: 'E' });
    keyed(doc, id, 'location', 2, [
      [1, 0],
      [11, 10],
    ]);
    doc.setDriver(driver(id, 'location', 2, 'frame / 10'));
    doc.setDriver(driver(id, 'rotation_euler', 2, 'radians(frame * 10)'));
    const ev = new SceneEvaluator(doc).evaluate(5);
    const o = ev.byId.get(id)!;
    expect(o.data.location[2]).toBe(0.5);
    expect(o.worldMatrix[14]).toBe(0.5);
    expect(o.data.rotation_euler[2]).toBeCloseTo((50 * Math.PI) / 180, 12);
    expect(ev.errors).toEqual([]);
  });

  it('lets drivers read their own (animated) object, including the driven channel', () => {
    const doc = new SceneDoc();
    const id = doc.addObject({ type: 'EMPTY', name: 'Self', location: [0, 3, 0] });
    keyed(doc, id, 'location', 0, [
      [1, 0],
      [11, 10],
    ]);
    doc.setDriver(driver(id, 'location', 2, 'x * 2', [v('x', id, 'location', 0)]));
    doc.setDriver(driver(id, 'location', 1, 'y + 1', [v('y', id, 'location', 1)]));
    const o = new SceneEvaluator(doc).evaluate(4).byId.get(id)!;
    expect(o.data.location[0]).toBe(3);
    expect(o.data.location[2]).toBe(6);
    expect(o.data.location[1]).toBe(4);
  });

  it('reads other objects through their own drivers, and survives dependency cycles', () => {
    const doc = new SceneDoc();
    const a = doc.addObject({ type: 'EMPTY', name: 'A' });
    const b = doc.addObject({ type: 'EMPTY', name: 'B' });
    doc.setDriver(driver(a, 'location', 0, 'frame'));
    doc.setDriver(driver(b, 'location', 0, 'ax + 1', [v('ax', a, 'location', 0)]));
    let ev = new SceneEvaluator(doc).evaluate(7);
    expect(ev.byId.get(a)!.data.location[0]).toBe(7);
    expect(ev.byId.get(b)!.data.location[0]).toBe(8);
    // cycle A.y ← B.y ← A.y: the object resolved first reads the other one, which sees the first one's
    // undriven value (FrameState's contract), so both end with the same value and nothing throws
    doc.updateObject(a, { location: [0, 5, 0] });
    doc.updateObject(b, { location: [0, 9, 0] });
    doc.setDriver(driver(a, 'location', 1, 'by', [v('by', b, 'location', 1)]));
    doc.setDriver(driver(b, 'location', 1, 'ay', [v('ay', a, 'location', 1)]));
    ev = new SceneEvaluator(doc).evaluate(1);
    const ay = ev.byId.get(a)!.data.location[1];
    const by = ev.byId.get(b)!.data.location[1];
    expect(ay).toBe(by);
    expect([5, 9]).toContain(ay);
    expect(ev.errors).toEqual([]);
  });

  it('reports failing drivers and keeps the animated value', () => {
    const doc = new SceneDoc();
    const id = doc.addObject({ type: 'EMPTY', name: 'E', location: [1, 2, 3] });
    doc.setDriver(driver(id, 'location', 2, 'gone * 2', [v('gone', 'missing-object', 'location', 0)]));
    doc.setDriver(driver(id, 'location', 0, '1 / 0'));
    doc.setDriver({ ...driver(id, 'location', 1, '100'), mute: true });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(id)!.data.location).toEqual([1, 2, 3]);
    const sources = ev.errors.map((e) => e.source).sort();
    expect(sources).toEqual([`driver:object:${id}:location:0`, `driver:object:${id}:location:2`]);
    expect(ev.errors.find((e) => e.source.endsWith(':2'))!.message).toMatch(/Variable 'gone' cannot be read/);
    expect(ev.errors.find((e) => e.source.endsWith(':0'))!.message).toMatch(/division by zero/);
  });

  it('drives every datablock type and reads custom properties', () => {
    const doc = new SceneDoc();
    const ctrl = doc.addObject({ type: 'EMPTY', name: 'Ctrl', location: [0.25, 0, 0], custom_props: { amount: 4 } });
    const mat = doc.addMaterial({ name: 'M' });
    const meshId = doc.addMesh('Mesh', createMesh({ positions: [0, 0, 0], faces: [] }));
    doc.setShapeKeys(meshId, [
      { name: 'Up', value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: '', data: encodeFloat32([0, 0, 2]) },
    ]);
    const meshObj = doc.addObject({ type: 'MESH', name: 'Obj', data: meshId, material_slots: [mat] });
    const lightData = doc.addLight({ name: 'L', energy: 10 });
    const light = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: lightData });
    const camData = doc.addCamera({ name: 'C' });
    const cam = doc.addObject({ type: 'CAMERA', name: 'Cam', data: camData });
    const curveData = doc.addCurve({ name: 'Cu' });
    const curveObj = doc.addObject({ type: 'CURVE', name: 'CurveObj', data: curveData });
    const x = [v('x', ctrl, 'location', 0)];
    doc.setDriver(driver(mat, 'base_color', 0, 'x * 2', x, 'material'));
    doc.setDriver(driver(lightData, 'energy', 0, 'x * 1000', x, 'light'));
    doc.setDriver(driver(camData, 'lens', 0, '20 + amount', [v('amount', ctrl, 'custom_props["amount"]')], 'camera'));
    doc.setDriver(driver('world', 'strength', 0, 'x * 4', x, 'world'));
    doc.setDriver(driver(meshId, 'shape_keys["Up"].value', 0, 'x * 2', x, 'mesh'));
    doc.setDriver(driver(curveData, 'bevel_depth', 0, 'x / 5', x, 'curve'));
    doc.setDriver(driver(ctrl, 'custom_props["amount"]', 0, 'frame', [], 'object'));
    const ev = new SceneEvaluator(doc).evaluate(6);
    expect(ev.errors).toEqual([]);
    expect(ev.byId.get(meshObj)!.materials[0]!.base_color[0]).toBe(0.5);
    expect(ev.byId.get(light)!.light!.energy).toBe(250);
    expect(ev.byId.get(cam)!.camera!.lens).toBe(26); // reads the driven custom property (frame 6)
    expect(ev.world.strength).toBe(1);
    expect(ev.byId.get(meshObj)!.mesh!.positions[2]).toBeCloseTo(1, 6);
    expect(ev.byId.get(curveObj)!.curve!.bevel_depth).toBe(0.05);
  });

  it('keeps drivers in snapshots', () => {
    const doc = new SceneDoc();
    const id = doc.addObject({ type: 'EMPTY', name: 'E' });
    doc.setDriver(driver(id, 'scale', 1, '1 + frame / 100'));
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(copy.listDrivers()).toEqual(doc.listDrivers());
    expect(new SceneEvaluator(copy).evaluate(50).byId.get(id)!.data.scale[1]).toBe(1.5);
  });
});
