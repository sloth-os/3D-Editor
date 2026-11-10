import { describe, expect, it } from 'vitest';
import {
  FrameState,
  SceneDoc,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  fcurveKey,
  insertKeyframe,
  type AnimTargetType,
  type OperatorContext,
} from '../src';

/*
 * Duplicate (Shift+D) and Duplicate Linked (Alt+D) and the animation of what they copy, as in
 * Blender with its default Duplicate Data settings (U.dupflag includes Action): a duplicate gets its
 * own copy of the keyframes and drivers of the object and, unless linked, of its data (a mesh's shape
 * keys, a curve, a light, a camera); drivers of the copies that read a duplicated datablock read its
 * copy (copy_object_set_idnew). Linked duplicates share the data and so its animation.
 */

const reg = createOperatorRegistry();

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const state = createEditorState();
  const ctx: OperatorContext = { doc, state, origin: doc.origin, source: 'test', report: () => undefined };
  const run = <T = unknown>(id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result as T;
  };
  const animate = (
    type: AnimTargetType,
    id: string,
    path: string,
    index: number,
    from: number,
    to: number,
  ) => {
    let fc = createFCurve({ target_type: type, target_id: id, path, index });
    fc = insertKeyframe(fc, 1, from, 'LINEAR');
    fc = insertKeyframe(fc, 11, to, 'LINEAR');
    doc.setFCurve(fc);
  };
  const keys = (type: AnimTargetType, id: string, path: string, index: number) =>
    doc
      .getFCurve(fcurveKey({ target_type: type, target_id: id, path, index }))
      ?.keyframes.map((k) => [k.frame, k.value]);
  const select = (...ids: string[]) => {
    state.selectedIds = ids;
    state.activeId = ids[ids.length - 1];
  };
  const duplicate = (params: { linked?: boolean; offset?: number[] } = {}) =>
    run<{ objects: string[] }>('object.duplicate', params).objects;
  return { doc, state, run, animate, keys, select, duplicate };
}

describe('Duplicate copies the animation of what it copies', () => {
  it('the copy gets its own keyframes and drivers, a driver reading the original reading the copy', () => {
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'Target', location: [0, 0, 2] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    t.animate('object', id, 'location', 0, 0, 10);
    // rotation Z driven by its own X location and by the target's Z location
    t.doc.setDriver({
      target_type: 'object',
      target_id: id,
      path: 'rotation_euler',
      index: 2,
      expression: 'x + z',
      variables: [
        { name: 'x', target_type: 'object', target_id: id, path: 'location', index: 0 },
        { name: 'z', target_type: 'object', target_id: target, path: 'location', index: 2 },
      ],
      mute: false,
    });
    t.select(id);
    const [copy] = t.duplicate();
    expect(t.keys('object', copy, 'location', 0)).toEqual([
      [1, 0],
      [11, 10],
    ]);
    const driver = t.doc.getDriver(
      fcurveKey({ target_type: 'object', target_id: copy, path: 'rotation_euler', index: 2 }),
    )!;
    // its own location (the copy's), the target that was not duplicated (the original target)
    expect(driver.variables.map((v) => v.target_id)).toEqual([copy, target]);
    // the copies are independent: a key edited on the original leaves the copy as it was
    t.animate('object', id, 'location', 0, 0, 20);
    expect(t.keys('object', copy, 'location', 0)).toEqual([
      [1, 0],
      [11, 10],
    ]);
    // a driver reading a duplicated object reads its copy
    t.select(id, target);
    const [a2, t2] = t.duplicate();
    const d2 = t.doc.getDriver(
      fcurveKey({ target_type: 'object', target_id: a2, path: 'rotation_euler', index: 2 }),
    )!;
    expect(d2.variables.map((v) => v.target_id)).toEqual([a2, t2]);
  });

  it('Duplicate copies the animation of the data; data two duplicated objects share is copied once', () => {
    const t = setup();
    t.run('object.light_add', { type: 'POINT', name: 'Lamp' });
    const lamp = t.state.activeId!;
    const light = t.doc.getObject(lamp)!.data!;
    t.animate('light', light, 'energy', 0, 100, 200);
    const twin = t.doc.addObject({ type: 'LIGHT', name: 'Twin', data: light });
    t.select(lamp, twin);
    const [c1, c2] = t.duplicate();
    const copied = t.doc.getObject(c1)!.data!;
    expect(copied).not.toBe(light);
    expect(t.doc.getObject(c2)!.data).toBe(copied);
    expect(t.keys('light', copied, 'energy', 0)).toEqual([
      [1, 100],
      [11, 200],
    ]);
    t.state.frame = 6;
    expect(new FrameState(t.doc, 6).get<{ energy: number }>('light', copied)!.energy).toBeCloseTo(150, 12);
    // shape keys: the copied mesh keeps their keyframes
    t.run('mesh.primitive_cube_add', { name: 'Box' });
    const box = t.state.activeId!;
    t.run('object.shape_key_add', { object: box, name: 'Basis' });
    t.run('object.shape_key_add', { object: box, name: 'Smile' });
    const mesh = t.doc.getObject(box)!.data!;
    const path = 'shape_keys["Smile"].value';
    t.animate('mesh', mesh, path, 0, 0, 1);
    t.select(box);
    const [boxCopy] = t.duplicate();
    const meshCopy = t.doc.getObject(boxCopy)!.data!;
    expect(meshCopy).not.toBe(mesh);
    expect(t.keys('mesh', meshCopy, path, 0)).toEqual([
      [1, 0],
      [11, 1],
    ]);
  });

  it('Duplicate Linked shares the data and its animation and copies the object’s keyframes', () => {
    const t = setup();
    t.run('object.light_add', { type: 'POINT', name: 'Lamp' });
    const lamp = t.state.activeId!;
    const light = t.doc.getObject(lamp)!.data!;
    t.animate('light', light, 'energy', 0, 100, 200);
    t.animate('object', lamp, 'location', 2, 0, 5);
    t.select(lamp);
    const [copy] = t.duplicate({ linked: true });
    expect(t.doc.getObject(copy)!.data).toBe(light);
    expect(t.doc.listFCurves(light).length).toBe(1);
    expect(t.keys('object', copy, 'location', 2)).toEqual([
      [1, 0],
      [11, 5],
    ]);
  });

  it('Duplicate Linked leaves the drivers of the shared data reading the original', () => {
    // the curve datablock is not copied, so its driver stays as it is (Blender relinks only copies)
    const t = setup();
    const data = t.doc.addCurve({ splines: [] } as never);
    const curve = t.doc.addObject({ type: 'CURVE', name: 'C', data });
    t.doc.setDriver({
      target_type: 'curve',
      target_id: data,
      path: 'eval_time',
      index: 0,
      expression: 'v * 2',
      variables: [{ name: 'v', target_type: 'object', target_id: curve, path: 'location', index: 0 }],
      mute: false,
    });
    t.select(curve);
    const [copy] = t.duplicate({ linked: true });
    expect(t.doc.getObject(copy)!.data).toBe(data);
    const drivers = t.doc.listDrivers(data);
    expect(drivers.length).toBe(1);
    expect(drivers[0].variables[0].target_id).toBe(curve);
  });

  it('an offset moves an animated copy as Move does: its location is keyed at the frame', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    t.animate('object', id, 'location', 0, 0, 10);
    t.state.frame = 6;
    t.select(id);
    const [copy] = t.duplicate({ offset: [2, 0, 0] });
    expect(t.keys('object', copy, 'location', 0)).toEqual([
      [1, 0],
      [6, 7],
      [11, 10],
    ]);
    expect(new FrameState(t.doc, 6).world(copy)![12]).toBeCloseTo(7, 12);
    // the original keeps its keys
    expect(t.keys('object', id, 'location', 0)).toEqual([
      [1, 0],
      [11, 10],
    ]);
  });
});
