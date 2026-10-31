import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createFCurve,
  createMesh,
  createOperatorRegistry,
  encodeFloat32,
  insertKeyframe,
  type OperatorContext,
} from '../src';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const car = doc.addObject({ type: 'EMPTY', name: 'Car', location: [2, 0, 0] });
  const wheel = doc.addObject({ type: 'EMPTY', name: 'Wheel' });
  ctx.state.selectedIds = [wheel];
  ctx.state.activeId = wheel;
  return { doc, reg, ctx, run, ok, reports, car, wheel };
}

const evalAt = (doc: SceneDoc, frame: number) => new SceneEvaluator(doc).evaluate(frame);

describe('anim.driver_add', () => {
  it('drives a channel from variables (by object name) and the frame', () => {
    const { doc, ctx, ok, car, wheel } = setup();
    ctx.state.frame = 10;
    const res = ok('anim.driver_add', {
      path: 'rotation_euler',
      index: 1,
      expression: '-x / 0.5 + frame / 100',
      variables: [{ name: 'x', target: 'Car', path: 'location', index: 0 }],
    });
    expect(res.replaced).toBe(0);
    expect(res.drivers).toHaveLength(1);
    const d = res.drivers[0];
    expect(d).toMatchObject({
      target_type: 'object',
      target_id: wheel,
      target_name: 'Wheel',
      path: 'rotation_euler',
      index: 1,
      error: null,
    });
    expect(d.value).toBeCloseTo(-4 + 0.1, 12);
    expect(d.variables[0]).toMatchObject({ name: 'x', target_id: car, target_name: 'Car', path: 'location' });
    doc.updateObject(car, { location: [3, 0, 0] });
    expect(evalAt(doc, 20).byId.get(wheel)!.data.rotation_euler[1]).toBeCloseTo(-6 + 0.2, 12);
  });

  it('adds one driver per channel with index -1 and replaces existing drivers', () => {
    const { doc, ok, run, wheel } = setup();
    const res = ok('anim.driver_add', { target: 'Wheel', path: 'scale', expression: '1 + frame / 10' });
    expect(res.drivers.map((d: { index: number }) => d.index)).toEqual([0, 1, 2]);
    expect(evalAt(doc, 10).byId.get(wheel)!.data.scale).toEqual([2, 2, 2]);
    const again = ok('anim.driver_add', { target: 'Wheel', path: 'scale', index: 2, expression: '3' });
    expect(again.replaced).toBe(1);
    expect(doc.listDrivers(wheel)).toHaveLength(3);
    const refused = run('anim.driver_add', {
      target: 'Wheel',
      path: 'scale',
      index: 2,
      expression: '4',
      replace: false,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/already has a driver.*replace: true/);
  });

  it('changes nothing when it fails part way through the channels', () => {
    const { doc, ok, run, wheel } = setup();
    ok('anim.driver_add', { target: 'Wheel', path: 'location', index: 1, expression: '5' });
    const before = JSON.stringify(doc.listDrivers(wheel));
    const refused = run('anim.driver_add', {
      target: 'Wheel',
      path: 'location',
      expression: '1',
      replace: false,
    });
    expect(refused.error).toMatch(/location\[1\] already has a driver/);
    expect(JSON.stringify(doc.listDrivers(wheel))).toBe(before); // channel 0 was not added
    // driver_update validates every driver before writing: new variables lacking a name one uses
    ok('anim.driver_add', {
      target: 'Wheel',
      path: 'scale',
      index: 0,
      expression: 'a',
      variables: [{ name: 'a', target: 'Car', path: 'location' }],
    });
    ok('anim.driver_add', {
      target: 'Wheel',
      path: 'scale',
      index: 1,
      expression: 'b',
      variables: [{ name: 'b', target: 'Car', path: 'location' }],
    });
    const drivers = JSON.stringify(doc.listDrivers(wheel));
    const bad = run('anim.driver_update', {
      target: 'Wheel',
      path: 'scale',
      variables: [{ name: 'a', target: 'Car', path: 'location' }],
    });
    expect(bad.error).toMatch(/Invalid driver scale\[1\]: Unknown name 'b'/);
    expect(JSON.stringify(doc.listDrivers(wheel))).toBe(drivers);
  });

  it('reaches object data, materials and shape keys through their objects', () => {
    const { doc, ok, car } = setup();
    const lightData = doc.addLight({ name: 'Key Light', energy: 5 });
    const lamp = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: lightData });
    const mat = doc.addMaterial({ name: 'Paint' });
    const meshId = doc.addMesh('Body', createMesh({ positions: [0, 0, 0], faces: [] }));
    doc.setShapeKeys(meshId, [
      {
        name: 'Dent',
        value: 0,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: encodeFloat32([0, 0, 1]),
      },
    ]);
    const body = doc.addObject({ type: 'MESH', name: 'BodyObj', data: meshId, material_slots: [mat] });
    const x = [{ name: 'x', target: 'Car', path: 'location', index: 0 }];
    expect(
      ok('anim.driver_add', {
        target_type: 'light',
        target: 'Lamp',
        path: 'energy',
        expression: 'x * 100',
        variables: x,
      }).drivers[0].target_id,
    ).toBe(lightData);
    expect(
      ok('anim.driver_add', {
        target_type: 'light',
        target: 'Key Light',
        path: 'energy',
        expression: 'x * 50',
        variables: x,
      }).replaced,
    ).toBe(1);
    expect(
      ok('anim.driver_add', {
        target_type: 'material',
        target: 'BodyObj',
        path: 'roughness',
        expression: 'x / 4',
        variables: x,
      }).drivers[0].target_id,
    ).toBe(mat);
    expect(
      ok('anim.driver_add', {
        target_type: 'mesh',
        target: 'BodyObj',
        path: 'shape_keys["Dent"].value',
        expression: 'x / 2',
        variables: x,
      }).drivers[0].value,
    ).toBe(1);
    ok('anim.driver_add', {
      target_type: 'world',
      path: 'strength',
      expression: 'v',
      variables: [{ name: 'v', target_type: 'light', target: 'Lamp', path: 'energy' }],
    });
    const ev = evalAt(doc, 1);
    expect(ev.byId.get(lamp)!.light!.energy).toBe(100);
    expect(ev.byId.get(body)!.materials[0]!.roughness).toBe(0.5);
    expect(ev.byId.get(body)!.mesh!.positions[2]).toBeCloseTo(1, 6);
    expect(ev.world.strength).toBe(100);
    expect(ev.errors).toEqual([]);
    void car;
  });

  it('validates expressions, variables and paths with precise errors', () => {
    const { run } = setup();
    const err = (params: Record<string, unknown>) => {
      const r = run('anim.driver_add', { path: 'location', index: 0, expression: '1', ...params });
      expect(r.ok).toBe(false);
      return r.error!;
    };
    expect(err({ expression: 'speed * 2' })).toMatch(
      /Unknown name 'speed' in the expression: add a variable named 'speed'/,
    );
    expect(err({ expression: 'sin(frame' })).toMatch(/Expected ',' or '\)'.* at column 10/);
    expect(err({ expression: '' })).toMatch(/Invalid parameters/);
    expect(err({ variables: [{ name: '2x', target: 'Car', path: 'location' }] })).toMatch(
      /Invalid variable name '2x'/,
    );
    expect(err({ variables: [{ name: 'frame', target: 'Car', path: 'location' }] })).toMatch(/reserved/);
    expect(
      err({
        variables: [
          { name: 'a', target: 'Car', path: 'location' },
          { name: 'a', target: 'Car', path: 'scale' },
        ],
      }),
    ).toMatch(/Duplicate variable name 'a'/);
    expect(err({ variables: [{ name: 'a', target: 'Nope', path: 'location' }] })).toMatch(
      /Variable 'a': Object 'Nope' not found/,
    );
    expect(err({ variables: [{ name: 'a', target: 'Car', path: 'lokation' }] })).toMatch(
      /Variable 'a': Property 'lokation' does not exist on object 'Car' \(common properties: location, rotation_euler/,
    );
    expect(err({ variables: [{ name: 'a', target: 'Car', path: 'location', index: 3 }] })).toMatch(
      /Index 3 is out of range/,
    );
    expect(err({ variables: [{ name: 'a', target_type: 'light', path: 'energy' }] })).toMatch(
      /`target` is required/,
    );
    expect(err({ path: 'location', index: 5 })).toMatch(
      /Index 5 is out of range for 'location' \(3 channels, 0..2\)/,
    );
    expect(err({ path: 'name' })).toMatch(/not a number, boolean or numeric vector/);
    expect(err({ path: 'location[' })).toMatch(/Invalid data path/);
    expect(err({ target: 'Ghost' })).toMatch(/Object 'Ghost' not found/);
    expect(err({ target_type: 'light', target: 'Car' })).toMatch(/Object 'Car' \(EMPTY\) has no light data/);
  });

  it('reports keyframed channels and failing drivers', () => {
    const { doc, ok, reports, wheel } = setup();
    doc.setFCurve(
      insertKeyframe(
        createFCurve({ target_type: 'object', target_id: wheel, path: 'location', index: 2 }),
        1,
        4,
      ),
    );
    const res = ok('anim.driver_add', { path: 'location', index: 2, expression: '1 / (frame - 1)' });
    expect(res.drivers[0].error).toMatch(/division by zero/);
    expect(res.drivers[0].value).toBe(4); // keyframed value stays
    expect(reports.map((r) => r.message).join('\n')).toMatch(/is keyframed: the driver overrides/);
    expect(reports.some((r) => r.level === 'WARNING' && /fails at frame 1/.test(r.message))).toBe(true);
  });
});

describe('anim.driver_update / driver_remove / driver_list', () => {
  it('updates expression, variables and mute', () => {
    const { doc, ok, run, wheel } = setup();
    ok('anim.driver_add', { path: 'location', expression: 'frame' });
    const upd = ok('anim.driver_update', {
      path: 'location',
      index: 1,
      expression: 'cx * 2',
      variables: [{ name: 'cx', target: 'Car', path: 'location', index: 0 }],
    });
    expect(upd.drivers).toHaveLength(1);
    expect(upd.drivers[0].value).toBe(4);
    ok('anim.driver_update', { path: 'location', index: 0, mute: true });
    const ev = evalAt(doc, 7).byId.get(wheel)!;
    expect(ev.data.location).toEqual([0, 4, 7]);
    expect(run('anim.driver_update', { path: 'location' }).error).toMatch(/Nothing to update/);
    expect(run('anim.driver_update', { path: 'scale', expression: '1' }).error).toMatch(
      /No driver on 'scale' of object 'Wheel' \(driven: location\[0\], location\[1\], location\[2\]\)/,
    );
    expect(run('anim.driver_update', { path: 'location', expression: 'nope' }).error).toMatch(
      /Unknown name 'nope'/,
    );
    // a failed update changes nothing
    expect(
      doc
        .listDrivers(wheel)
        .map((d) => d.expression)
        .sort(),
    ).toEqual(['cx * 2', 'frame', 'frame']);
  });

  it('removes drivers per channel, per path or all', () => {
    const { doc, ok, run, wheel } = setup();
    ok('anim.driver_add', { path: 'location', expression: 'frame' });
    ok('anim.driver_add', { path: 'scale', expression: '2' });
    expect(ok('anim.driver_remove', { path: 'location', index: 1 }).removed).toEqual([
      `object:${wheel}:location:1`,
    ]);
    expect(ok('anim.driver_remove', { path: 'location' }).removed).toHaveLength(2);
    expect(run('anim.driver_remove', { path: 'location' }).error).toMatch(/No driver on 'location'/);
    expect(ok('anim.driver_remove', {}).removed).toHaveLength(3);
    expect(doc.listDrivers()).toEqual([]);
    expect(run('anim.driver_remove', {}).error).toMatch(/No driver of object 'Wheel'/);
  });

  it('lists drivers with values and errors without creating undo steps', () => {
    const { doc, ok, ctx, wheel, car } = setup();
    ok('anim.driver_add', { path: 'location', index: 0, expression: 'frame * 2' });
    ok('anim.driver_add', { target: 'Car', path: 'location', index: 2, expression: '1 / 0' });
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const all = ok('anim.driver_list', { frame: 3 });
    expect(all.frame).toBe(3);
    expect(all.drivers).toHaveLength(2);
    const w = all.drivers.find((d: { target_id: string }) => d.target_id === wheel);
    expect(w.value).toBe(6);
    const c = all.drivers.find((d: { target_id: string }) => d.target_id === car);
    expect(c.error).toMatch(/division by zero/);
    expect(ok('anim.driver_list', { target: 'Car' }).drivers).toHaveLength(1);
    expect(ok('anim.driver_list', { target_type: 'light' }).drivers).toHaveLength(0);
    ctx.state.frame = 5;
    expect(ok('anim.driver_list', { target: 'Wheel' }).drivers[0].value).toBe(10);
    expect(um.undoStack).toHaveLength(0);
  });

  it('lists malformed stored drivers with their problem instead of failing', () => {
    const { doc, ok, run, car, wheel } = setup();
    // e.g. from an old or foreign snapshot, another client or the JavaScript console
    const bad = (path: string, index: number, variables: unknown) =>
      doc.setDriver({
        target_type: 'object',
        target_id: wheel,
        path,
        index,
        expression: 'frame',
        variables: variables as never,
        mute: false,
      });
    bad('location', 0, {});
    bad('location', 1, [null, 5, { name: 'cx', target_type: 'object', target_id: car, path: 'location', index: 0 }]);
    bad('location', 2, undefined);
    ok('anim.driver_add', { target: 'Car', path: 'location', index: 2, expression: 'frame * 2' });
    expect(evalAt(doc, 3).byId.get(wheel)!.data.location[0]).toBe(3); // the evaluator copes
    const list = ok('anim.driver_list', { frame: 3 }).drivers;
    expect(list).toHaveLength(4);
    const at = (target: string, index: number) =>
      list.find((d: { target_id: string; index: number }) => d.target_id === target && d.index === index);
    expect(at(wheel, 0)).toMatchObject({ value: 3, variables: [], error: 'Driver variables must be a list' });
    expect(at(wheel, 1).variables).toEqual([
      { malformed: null },
      { malformed: 5 },
      expect.objectContaining({ name: 'cx', target_name: 'Car' }),
    ]);
    expect(at(wheel, 1).error).toMatch(/Malformed driver variable/);
    expect(at(wheel, 2)).toMatchObject({ value: 3, variables: [], error: null });
    expect(at(car, 2)).toMatchObject({ value: 6, error: null });
    // updating a malformed driver rewrites its variables as a valid (empty) list
    expect(run('anim.driver_update', { path: 'location', index: 0, mute: true }).ok).toBe(true);
    expect(doc.getDriver(`object:${wheel}:location:0`)).toMatchObject({ variables: [], mute: true });
  });
});

describe('driver operators: undo, persistence and descriptions', () => {
  it('makes every operator one undo step', () => {
    const { doc, ok } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    ok('anim.driver_add', { path: 'location', expression: 'frame' });
    ok('anim.driver_update', { path: 'location', expression: 'frame * 2' });
    ok('anim.driver_remove', { path: 'location', index: 0 });
    expect(doc.listDrivers()).toHaveLength(2);
    um.undo();
    expect(doc.listDrivers()).toHaveLength(3);
    expect(doc.listDrivers()[0].expression).toBe('frame * 2');
    um.undo();
    expect(doc.listDrivers().every((d) => d.expression === 'frame')).toBe(true);
    um.undo();
    expect(doc.listDrivers()).toHaveLength(0);
    um.redo();
    expect(doc.listDrivers()).toHaveLength(3);
  });

  it('keeps drivers across snapshots', () => {
    const { doc, ok, wheel } = setup();
    ok('anim.driver_add', {
      path: 'location',
      index: 2,
      expression: 'cx + frame',
      variables: [{ name: 'cx', target: 'Car', path: 'location' }],
    });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(evalAt(copy, 5).byId.get(wheel)!.data.location[2]).toBe(7);
  });

  it('describes every parameter for agents', () => {
    const { reg } = setup();
    const ids = ['anim.driver_add', 'anim.driver_update', 'anim.driver_remove', 'anim.driver_list'];
    for (const info of reg.describe().filter((i) => ids.includes(i.id))) {
      expect(info.description.length).toBeGreaterThan(80);
      const props = (info.parameters as { properties: Record<string, { description?: string }> }).properties;
      for (const [name, prop] of Object.entries(props))
        expect(prop.description, `${info.id}.${name}`).toBeTruthy();
    }
    expect(reg.describe().filter((i) => ids.includes(i.id))).toHaveLength(4);
  });
});
