import { describe, expect, it } from 'vitest';
import { SceneDoc, createEditorState, createOperatorRegistry, type OperatorContext } from '../src';

// Regression tests for leftover issues of the phase-3 projects and verify rounds:
// - robot-workcell: constraint.describe {frame} reported the stored constraint influence instead of
//   the evaluated (animated) one;
// - product-shot: camera.properties_set returned the stored dof_focus_distance (10 m) while a
//   dof_focus_object overrode it;
// - data.set_property skipped camera.properties_set's cross-field checks (clip_end > clip_start, a
//   camera focusing on itself);
// - resolveDatablock: a name matching an object (data A) and another datablock (B) silently picked
//   one of them;
// - anim.extrapolation_set on a data curve also changed same-named channels of other datablocks.

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const warnings = () => reports.filter((r) => r.level === 'WARNING').map((r) => r.message);
  return { doc, ctx, run, ok, reports, warnings };
}

describe('constraint.describe reports the evaluated influence', () => {
  function carry() {
    const t = setup();
    t.ok('object.empty_add', { name: 'Carrier', location: [2, 0, 1] });
    t.ok('mesh.primitive_cube_add', { name: 'Box', size: 0.4, location: [0, 0, 0.2] });
    t.ok('object.constraint_add', { object: 'Box', type: 'CHILD_OF', name: 'Child Of', target: 'Carrier' });
    for (const [frame, value] of [
      [10, 0],
      [20, 1],
    ])
      t.ok('anim.keyframe_insert_property', {
        target_type: 'object',
        target: 'Box',
        path: 'constraints["Child Of"].influence',
        frame,
        value,
        interpolation: 'LINEAR',
      });
    // move the carrier after the hand-off is set up: the box only follows it with influence > 0
    t.ok('object.transform_set', { objects: ['Carrier'], location: [2, 0, 2] });
    return t;
  }

  it('lists the animated influence at the frame and the stored one next to it (robot-workcell repro)', () => {
    const { ok, doc } = carry();
    const stored = doc.findObjectByName('Box')!.constraints[0].influence;
    expect(stored).toBe(1);
    const at5 = ok('constraint.describe', { object: 'Box', frame: 5 });
    expect(at5.frame).toBe(5);
    expect(at5.constraints[0]).toMatchObject({ name: 'Child Of', influence: 0, stored_influence: 1 });
    // influence 0: the box stays where it is
    expect(at5.world_location).toEqual([0, 0, 0.2]);
    const at15 = ok('constraint.describe', { object: 'Box', frame: 15 });
    expect(at15.constraints[0].influence).toBeCloseTo(0.5, 9);
    expect(at15.constraints[0].stored_influence).toBe(1);
    // half way between the unconstrained place and following the carrier's 1 m rise
    expect(at15.world_location[2]).toBeCloseTo(0.7, 6);
    const at25 = ok('constraint.describe', { object: 'Box', frame: 25 });
    expect(at25.constraints[0].influence).toBe(1);
    expect(at25.world_location[2]).toBeCloseTo(1.2, 6);
  });

  it('agrees with the world transform it reports and lists stored_params only when animated', () => {
    const { ok, doc } = setup();
    ok('object.empty_add', { name: 'E', location: [5, 0, 0] });
    ok('object.constraint_add', {
      object: 'E',
      type: 'LIMIT_LOCATION',
      name: 'Limit',
      params: { use_max_x: true, max_x: 3 },
    });
    let d = ok('constraint.describe', { object: 'E', frame: 1 });
    expect(d.constraints[0]).not.toHaveProperty('stored_params');
    expect(d.world_location[0]).toBeCloseTo(3, 9);
    for (const [frame, value] of [
      [1, 1],
      [11, 4],
    ])
      ok('anim.keyframe_insert_property', {
        target_type: 'object',
        target: 'E',
        path: 'constraints["Limit"].max_x',
        frame,
        value,
        interpolation: 'LINEAR',
      });
    d = ok('constraint.describe', { object: 'E', frame: 1 });
    expect(d.constraints[0].params.max_x).toBeCloseTo(1, 9);
    expect(d.world_location[0]).toBeCloseTo(1, 9);
    d = ok('constraint.describe', { object: 'E', frame: 6 });
    expect(d.constraints[0].params.max_x).toBeCloseTo(2.5, 9);
    expect(d.constraints[0].stored_params.max_x).toBe(doc.findObjectByName('E')!.constraints[0].params.max_x);
    expect(d.world_location[0]).toBeCloseTo(2.5, 9);
  });
});

describe('camera.properties_set reports the evaluated focus distance', () => {
  it('returns the depth of the focus object, the stored value as stored_dof_focus_distance (product-shot repro)', () => {
    const { ok } = setup();
    ok('object.empty_add', { name: 'Target', location: [0, 0, 0] });
    ok('object.camera_add', { name: 'Cam', location: [0, -2, 0] });
    ok('object.look_at', { objects: ['Cam'], point: [0, 0, 0] });
    const r = ok('camera.properties_set', { object: 'Cam', dof_use: true, dof_focus_object: 'Target' });
    expect(r.cameras[0].dof_focus_object).toBe('Target');
    expect(r.cameras[0].dof_focus_distance).toBeCloseTo(2, 6);
    expect(r.cameras[0].stored_dof_focus_distance).toBe(10);
    // without a focus object the stored distance is the evaluated one: no second field
    const plain = ok('camera.properties_set', { object: 'Cam', dof_focus_object: '', dof_focus_distance: 3 });
    expect(plain.cameras[0].dof_focus_distance).toBe(3);
    expect(plain.cameras[0]).not.toHaveProperty('stored_dof_focus_distance');
  });

  it('follows the focus object at the current frame', () => {
    const { ok, ctx } = setup();
    ok('object.empty_add', { name: 'Target', location: [0, 0, 0] });
    ok('object.camera_add', { name: 'Cam', location: [0, -2, 0] });
    ok('object.look_at', { objects: ['Cam'], point: [0, 0, 0] });
    for (const [frame, y] of [
      [1, 0],
      [11, 3],
    ])
      ok('anim.keyframe_insert_property', {
        target_type: 'object',
        target: 'Target',
        path: 'location',
        index: 1,
        frame,
        value: y,
        interpolation: 'LINEAR',
      });
    ctx.state.frame = 11;
    const r = ok('camera.properties_set', { object: 'Cam', dof_focus_object: 'Target' });
    expect(r.cameras[0].dof_focus_distance).toBeCloseTo(5, 6);
  });
});

describe('data.set_property applies the camera cross-field checks', () => {
  it('refuses clip_end <= clip_start and a camera focusing on itself, like camera.properties_set', () => {
    const { ok, run, doc } = setup();
    ok('object.camera_add', { name: 'Cam' });
    ok('object.empty_add', { name: 'Target', location: [0, 3, 0] });
    const cam = () => doc.getCamera(doc.findObjectByName('Cam')!.data!)!;
    const clipStart = cam().clip_start;
    let r = run('data.set_property', { kind: 'cameras', target: 'Cam', values: { clip_end: clipStart / 2 } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PARAMS');
    expect(r.error).toMatch(/clip_end .* must be greater than clip_start/);
    r = run('data.set_property', {
      kind: 'cameras',
      target: 'Cam',
      values: { clip_start: 50, clip_end: 40 },
    });
    expect(r.ok).toBe(false);
    r = run('data.set_property', { kind: 'cameras', target: 'Cam', values: { dof_focus_object: 'Cam' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PARAMS');
    expect(r.error).toMatch(/cannot focus on itself/);
    // by id too
    r = run('data.set_property', {
      kind: 'cameras',
      target: 'Cam',
      values: { dof_focus_object: doc.findObjectByName('Cam')!.id },
    });
    expect(r.ok).toBe(false);
    expect(cam().dof_focus_object).toBeNull();
    // valid changes still work
    ok('data.set_property', { kind: 'cameras', target: 'Cam', values: { clip_start: 0.5, clip_end: 500 } });
    ok('data.set_property', { kind: 'cameras', target: 'Cam', values: { dof_focus_object: 'Target' } });
    expect(cam()).toMatchObject({ clip_start: 0.5, clip_end: 500 });
    expect(cam().dof_focus_object).toBe(doc.findObjectByName('Target')!.id);
  });
});

describe('ambiguous datablock references are reported', () => {
  /** Light objects X and Y, then renamed so that object 'X' uses the light data called 'Y'. */
  function swapped() {
    const t = setup();
    t.ok('object.light_add', { type: 'POINT', name: 'X' });
    t.ok('object.light_add', { type: 'POINT', name: 'Y' });
    const lx = t.doc.findObjectByName('X')!.data!;
    const ly = t.doc.findObjectByName('Y')!.data!;
    expect(t.doc.getLight(lx)!.name).toBe('X');
    expect(t.doc.getLight(ly)!.name).toBe('Y');
    t.ok('object.rename', { object: 'X', name: 'Tmp' });
    t.ok('object.rename', { object: 'Y', name: 'X' });
    return { ...t, lx, ly };
  }

  it('data.set_property keeps the documented order (object first) and warns naming both choices', () => {
    const { ok, doc, lx, ly, warnings } = swapped();
    const before = doc.getLight(lx)!.energy;
    ok('data.set_property', { kind: 'lights', target: 'X', values: { energy: 123 } });
    expect(doc.getLight(ly)!.energy).toBe(123);
    expect(doc.getLight(lx)!.energy).toBe(before);
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'X' names both the light object 'X'");
    expect(w[0]).toContain("light data is 'Y'");
    expect(w[0]).toContain("another light datablock called 'X'");
    expect(w[0]).toContain("'Tmp'");
    expect(w[0]).toContain(lx);
    // following the hint reaches the other datablock without a warning
    ok('data.set_property', { kind: 'lights', target: lx, values: { energy: 7 } });
    ok('data.set_property', { kind: 'lights', target: 'Tmp', values: { energy: 8 } });
    expect(doc.getLight(lx)!.energy).toBe(8);
    expect(warnings()).toHaveLength(1);
  });

  it('light.properties_set and anim.keyframe_insert_property warn too', () => {
    const { ok, warnings } = swapped();
    ok('light.properties_set', { object: 'X', energy: 50 });
    expect(warnings()).toHaveLength(1);
    ok('anim.keyframe_insert_property', { target_type: 'light', target: 'X', path: 'energy', frame: 1 });
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toContain("'X' names both the light object 'X'");
  });

  it('no warning when the name is unambiguous', () => {
    const { ok, warnings } = setup();
    ok('object.light_add', { type: 'POINT', name: 'Lamp' });
    ok('data.set_property', { kind: 'lights', target: 'Lamp', values: { energy: 5 } });
    ok('light.properties_set', { object: 'Lamp', energy: 6 });
    expect(warnings()).toEqual([]);
  });

  it('materials: a material name wins over an object with one material, with a warning', () => {
    const { ok, doc, warnings } = setup();
    ok('mesh.primitive_cube_add', { name: 'Gold' });
    ok('material.new', { name: 'Brass' }); // assigned to the selected cube
    ok('material.new', { name: 'Gold', assign: false });
    const gold = doc.listMaterials().find((m) => m.name === 'Gold')!;
    const brass = doc.listMaterials().find((m) => m.name === 'Brass')!;
    ok('data.set_property', { kind: 'materials', target: 'Gold', values: { roughness: 0.11 } });
    expect(doc.getMaterial(gold.id)!.roughness).toBe(0.11);
    expect(doc.getMaterial(brass.id)!.roughness).not.toBe(0.11);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("names both the material 'Gold' and the object 'Gold'");
    expect(warnings()[0]).toContain("'Brass'");
  });

  it('target_type/target of the animation tools: a datablock name wins, with a warning', () => {
    const { ok, doc, lx, ly, warnings } = swapped();
    for (const id of [lx, ly])
      for (const frame of [1, 10])
        ok('anim.keyframe_insert_property', { target_type: 'light', target: id, path: 'energy', frame });
    expect(warnings()).toEqual([]);
    const r = ok('anim.extrapolation_set', { target_type: 'light', target: 'X', type: 'LINEAR' });
    expect(r).toMatchObject({ fcurves: 1, changed: 1 });
    const extrapolation = (id: string) => doc.listFCurves(id).find((f) => f.path === 'energy')!.extrapolation;
    expect(extrapolation(lx)).toBe('LINEAR');
    expect(extrapolation(ly) ?? 'CONSTANT').toBe('CONSTANT');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("'X' names both the light datablock 'X' and the object 'X'");
    expect(warnings()[0]).toContain(ly);
  });
});

describe('anim.extrapolation_set target selection', () => {
  /** A lamp whose object viewport color and light color are both animated (same path 'color'). */
  function lamp() {
    const t = setup();
    t.ok('object.light_add', { type: 'POINT', name: 'Lamp' });
    for (const target_type of ['object', 'light'])
      for (const frame of [1, 10])
        t.ok('anim.keyframe_insert_property', { target_type, target: 'Lamp', path: 'color', frame });
    const o = t.doc.findObjectByName('Lamp')!;
    const curves = (type: string) =>
      [...t.doc.listFCurves(o.id), ...t.doc.listFCurves(o.data!)].filter(
        (f) => f.target_type === type && f.path === 'color',
      );
    expect(curves('object').length).toBe(4);
    expect(curves('light').length).toBe(3);
    return { ...t, curves };
  }

  it("changes only the light data's color curves, not the object's viewport color (leftover repro)", () => {
    const { ok, curves } = lamp();
    const r = ok('anim.extrapolation_set', {
      target_type: 'light',
      target: 'Lamp',
      path: 'color',
      type: 'CYCLIC',
    });
    expect(r).toEqual({ type: 'CYCLIC', fcurves: 3, changed: 3 });
    expect(curves('light').every((f) => f.extrapolation === 'CYCLIC')).toBe(true);
    expect(curves('object').every((f) => (f.extrapolation ?? 'CONSTANT') === 'CONSTANT')).toBe(true);
    // the object's own curves through target_type object
    ok('anim.extrapolation_set', { target_type: 'object', target: 'Lamp', path: 'color', type: 'LINEAR' });
    expect(curves('object').every((f) => f.extrapolation === 'LINEAR')).toBe(true);
    expect(curves('light').every((f) => f.extrapolation === 'CYCLIC')).toBe(true);
  });

  it('defaults to the active object, and objects / include_data still work as before', () => {
    const { ok, ctx, doc, curves } = lamp();
    ctx.state.activeId = doc.findObjectByName('Lamp')!.id;
    ok('anim.extrapolation_set', { target_type: 'light', type: 'LINEAR' });
    expect(curves('light').every((f) => f.extrapolation === 'LINEAR')).toBe(true);
    const r = ok('anim.extrapolation_set', { objects: ['Lamp'], include_data: true, type: 'CYCLIC' });
    expect(r.fcurves).toBe(7);
    expect([...curves('light'), ...curves('object')].every((f) => f.extrapolation === 'CYCLIC')).toBe(true);
  });

  it('rejects mixed or incomplete targets and names the datablock when nothing matches', () => {
    const { run, ok } = lamp();
    let r = run('anim.extrapolation_set', {
      target_type: 'light',
      target: 'Lamp',
      objects: ['Lamp'],
      type: 'LINEAR',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PARAMS');
    r = run('anim.extrapolation_set', {
      target_type: 'light',
      target: 'Lamp',
      include_data: true,
      type: 'LINEAR',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PARAMS');
    r = run('anim.extrapolation_set', { target: 'Lamp', type: 'LINEAR' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/needs target_type/);
    r = run('anim.extrapolation_set', {
      target_type: 'light',
      target: 'Lamp',
      path: 'energy',
      type: 'LINEAR',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(r.error).toContain("on light 'Lamp'");
    ok('object.camera_add', { name: 'Cam' });
    r = run('anim.extrapolation_set', { target_type: 'light', target: 'Cam', type: 'LINEAR' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
  });
});
