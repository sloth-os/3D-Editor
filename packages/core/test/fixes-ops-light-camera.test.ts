import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  type OperatorContext,
} from '../src';

// Regression tests for phase-3 issues #4, #10, #15, #16, #25, #32, #33 and #34: light and camera
// data could only be edited through datablock ids that no tool exposed, and object.light_add
// ignored its radius.

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
  const run = (id: string, params?: unknown) => reg.run(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result as Record<string, any>;
  };
  const light = (name: string) => doc.getLight(doc.findObjectByName(name)!.data!)!;
  const camera = (name: string) => doc.getCamera(doc.findObjectByName(name)!.data!)!;
  return { doc, reg, ctx, run, ok, reports, light, camera };
}

describe('data.set_property on lights and cameras by object name', () => {
  it('sets spot settings of a light object by its name (lighthouse-cove repro)', () => {
    const { ok, light } = setup();
    ok('object.light_add', { type: 'SPOT', name: 'Beam' });
    ok('data.set_property', { kind: 'lights', target: 'Beam', values: { spot_size: 0.26, spot_blend: 0.4 } });
    expect(light('Beam').spot_size).toBeCloseTo(0.26);
    expect(light('Beam').spot_blend).toBeCloseTo(0.4);
  });

  it('enables camera depth of field and sets an area light shape by object name (domino/product repros)', () => {
    const { ok, light, camera } = setup();
    ok('object.camera_add', { name: 'Camera' });
    ok('object.light_add', { type: 'AREA', name: 'Key Light' });
    ok('data.set_property', {
      kind: 'cameras',
      target: 'Camera',
      values: { dof_use: true, dof_focus_distance: 2.5, dof_aperture_fstop: 1.8 },
    });
    ok('data.set_property', {
      kind: 'lights',
      target: 'Key Light',
      values: { shape: 'RECTANGLE', size: 1.6, size_y: 0.4 },
    });
    expect(camera('Camera')).toMatchObject({
      dof_use: true,
      dof_focus_distance: 2.5,
      dof_aperture_fstop: 1.8,
    });
    expect(light('Key Light')).toMatchObject({ shape: 'RECTANGLE', size: 1.6, size_y: 0.4 });
  });

  it('still accepts datablock ids and names, and validates enum values and ranges', () => {
    const { ok, run, doc, light } = setup();
    const r = ok('object.light_add', { type: 'AREA', name: 'Soft' });
    ok('data.set_property', { kind: 'lights', target: r.light, values: { energy: 250 } });
    expect(light('Soft').energy).toBe(250);
    ok('object.rename', { object: 'Soft', name: 'Softbox' });
    // the light datablock keeps its name 'Soft'
    ok('data.set_property', { kind: 'lights', target: 'Soft', values: { energy: 300 } });
    expect(doc.getLight(r.light)!.energy).toBe(300);
    const bad = run('data.set_property', {
      kind: 'lights',
      target: 'Softbox',
      values: { shape: 'TRIANGLE' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Invalid value for lights field 'shape'.*SQUARE.*RECTANGLE/);
    expect(run('data.set_property', { kind: 'lights', target: 'Softbox', values: { energy: -5 } }).ok).toBe(
      false,
    );
  });

  it('names the missing light and lists the light objects', () => {
    const { ok, run } = setup();
    ok('object.light_add', { type: 'POINT', name: 'Fill' });
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const missing = run('data.set_property', { kind: 'lights', target: 'Nope', values: { energy: 1 } });
    expect(missing.error).toBe(
      "Light 'Nope' not found. Pass the name or id of a light object (light objects: 'Fill') or a light datablock id",
    );
    const wrongType = run('data.set_property', { kind: 'lights', target: 'Cube', values: { energy: 1 } });
    expect(wrongType.error).toContain("Object 'Cube' is a MESH object, not a light object");
  });

  it('resolves meshes and materials through the object using them', () => {
    const { ok, run, doc } = setup();
    ok('mesh.primitive_cube_add', { name: 'Box' });
    ok('data.set_property', { kind: 'meshes', target: 'Box', values: { name: 'BoxMesh' } });
    expect(doc.getMeshBlock(doc.findObjectByName('Box')!.data!)!.name).toBe('BoxMesh');
    ok('material.new', { name: 'Red' });
    ok('data.set_property', { kind: 'materials', target: 'Box', values: { roughness: 0.2 } });
    expect(doc.listMaterials().find((m) => m.name === 'Red')!.roughness).toBeCloseTo(0.2);
    ok('object.material_slot_add');
    ok('material.new', { name: 'Blue' });
    const ambiguous = run('data.set_property', {
      kind: 'materials',
      target: 'Box',
      values: { roughness: 0.5 },
    });
    expect(ambiguous.error).toContain("Object 'Box' has 2 materials ('Red', 'Blue')");
    // a material name wins over an object of the same name
    ok('mesh.primitive_cube_add', { name: 'Red' });
    ok('material.new', { name: 'Paint' });
    ok('data.set_property', { kind: 'materials', target: 'Red', values: { metallic: 1 } });
    expect(doc.listMaterials().find((m) => m.name === 'Red')!.metallic).toBe(1);
    expect(doc.listMaterials().find((m) => m.name === 'Paint')!.metallic).toBe(0);
  });
});

describe('light.properties_set', () => {
  it('changes several lights in one undo step and returns their settings', () => {
    const { ok, doc, light } = setup();
    ok('object.light_add', { type: 'SPOT', name: 'A' });
    ok('object.light_add', { type: 'POINT', name: 'B' });
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const res = ok('light.properties_set', {
      objects: ['A', 'B'],
      energy: 40,
      color: [1, 0.5, 0.25],
      shadow_soft_size: 0.05,
    });
    expect(res.lights.map((l: { object: string }) => l.object)).toEqual(['A', 'B']);
    expect(res.lights[0]).toMatchObject({
      type: 'SPOT',
      energy: 40,
      color: [1, 0.5, 0.25],
      shadow_soft_size: 0.05,
    });
    expect(light('B').energy).toBe(40);
    um.undo();
    expect(light('A').energy).toBe(1000);
    expect(light('B').energy).toBe(1000);
  });

  it('targets the selected light objects by default and warns about settings of other light types', () => {
    const { ok, run, reports, light } = setup();
    ok('object.light_add', { type: 'POINT', name: 'Lamp' }); // selected
    ok('light.properties_set', { spot_size: 0.4, energy: 20 });
    expect(light('Lamp').energy).toBe(20);
    expect(
      reports.some(
        (r) => r.level === 'WARNING' && /spot_size has no effect on this POINT light/.test(r.message),
      ),
    ).toBe(true);
    // switching the type makes the cone count
    ok('light.properties_set', { object: 'Lamp', type: 'SPOT' });
    expect(light('Lamp')).toMatchObject({ type: 'SPOT', spot_size: 0.4 });
    ok('object.select_all', { action: 'DESELECT' });
    const none = run('light.properties_set', { energy: 1 });
    expect(none.ok).toBe(false);
    expect(none.error).toContain(
      "No light object given or selected: pass object (a light object name or id); light objects: 'Lamp'",
    );
    expect(run('light.properties_set', { object: 'Lamp' }).error).toContain('No light properties given');
  });

  it('keys animatable values with keyframe=true and re-keys animated ones', () => {
    const { ok, doc, light, ctx } = setup();
    const { light: id } = ok('object.light_add', { type: 'AREA', name: 'Key' });
    ok('light.properties_set', { object: 'Key', energy: 100, keyframe: true, frame: 1 });
    ok('light.properties_set', { object: 'Key', energy: 500, size: 3, keyframe: true, frame: 20 });
    const fc = doc.listFCurves(id).find((f) => f.path === 'energy')!;
    expect(fc.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [1, 100],
      [20, 500],
    ]);
    expect(new SceneEvaluator(doc).evaluate(20).byId.get(doc.findObjectByName('Key')!.id)!.light!.size).toBe(
      3,
    );
    // an animated channel is re-keyed at the current frame so the edit shows
    ctx.state.frame = 1;
    ok('light.properties_set', { object: 'Key', energy: 150 });
    expect(doc.listFCurves(id).find((f) => f.path === 'energy')!.keyframes[0].value).toBe(150);
    expect(light('Key').energy).toBe(150);
  });
});

describe('camera.properties_set', () => {
  it('enables depth of field with Blender dof names and a focus object', () => {
    const { ok, doc, camera } = setup();
    ok('object.camera_add', { name: 'Cam', location: [0, -10, 1], rotation: [Math.PI / 2, 0, 0] });
    ok('object.empty_add', { name: 'Target', location: [0.5, -4, 0.3] });
    const r = ok('camera.properties_set', {
      dof: { use_dof: true, focus_object: 'Target', aperture_fstop: 1.4 },
      lens: 85,
    });
    expect(r.cameras[0]).toMatchObject({
      object: 'Cam',
      dof_use: true,
      dof_aperture_fstop: 1.4,
      dof_focus_object: 'Target',
      lens: 85,
    });
    expect(camera('Cam').dof_focus_object).toBe(doc.findObjectByName('Target')!.id);
    // the evaluated camera focuses at the depth of the target along the view axis (Blender's dof distance)
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.activeCamera!.camera!.dof_focus_distance).toBeCloseTo(6, 6);
    // clearing the focus object falls back to the focus distance
    ok('camera.properties_set', { object: 'Cam', dof_focus_object: null, dof_focus_distance: 3 });
    expect(new SceneEvaluator(doc).evaluate(1).activeCamera!.camera!.dof_focus_distance).toBe(3);
  });

  it('follows an animated focus object per frame', () => {
    const { ok, doc } = setup();
    ok('object.camera_add', { name: 'Cam', location: [0, 0, 10] }); // looks down -Z
    ok('object.empty_add', { name: 'Ball', location: [0, 0, 6] });
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Ball',
      path: 'location',
      frame: 1,
    });
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Ball',
      path: 'location',
      index: 2,
      frame: 11,
      value: 1,
    });
    ok('camera.properties_set', { dof_use: true, dof_focus_object: 'Ball' });
    const ev = new SceneEvaluator(doc);
    expect(ev.evaluate(1).activeCamera!.camera!.dof_focus_distance).toBeCloseTo(4, 6);
    expect(ev.evaluate(11).activeCamera!.camera!.dof_focus_distance).toBeCloseTo(9, 6);
  });

  it('sets the field of view, validates clipping and defaults to the scene camera', () => {
    const { ok, run, camera, reports } = setup();
    ok('object.camera_add', { name: 'Cam' });
    ok('object.select_all', { action: 'DESELECT' });
    ok('camera.properties_set', { angle: 1 }); // the scene camera
    expect(camera('Cam').lens).toBeCloseTo(36 / (2 * Math.tan(0.5)), 4);
    const clip = run('camera.properties_set', { object: 'Cam', clip_start: 5, clip_end: 2 });
    expect(clip.error).toBe('clip_end (2) must be greater than clip_start (5)');
    expect(run('camera.properties_set', { object: 'Cam', lens: 50, angle: 1 }).error).toContain(
      'either lens or angle',
    );
    ok('camera.properties_set', { object: 'Cam', dof_focus_distance: 4 });
    expect(reports.some((r) => r.level === 'WARNING' && /depth of field is off/.test(r.message))).toBe(true);
    ok('camera.properties_set', { object: 'Cam', type: 'ORTHO', ortho_scale: 12, clip_end: 250 });
    expect(camera('Cam')).toMatchObject({ type: 'ORTHO', ortho_scale: 12, clip_end: 250 });
    const self = run('camera.properties_set', { object: 'Cam', dof_focus_object: 'Cam' });
    expect(self.error).toContain('cannot focus on itself');
  });

  it('is one undo step', () => {
    const { ok, doc, camera } = setup();
    ok('object.camera_add', { name: 'Cam' });
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    ok('camera.properties_set', { object: 'Cam', lens: 24, dof_use: true, clip_end: 80 });
    um.undo();
    expect(camera('Cam')).toMatchObject({ lens: 50, dof_use: false, clip_end: 1000 });
  });
});

describe('object.light_add / object.camera_add settings', () => {
  it('applies radius like Blender: AREA size, POINT/SPOT radius (robot-workcell / product-shot repros)', () => {
    const { ok, light } = setup();
    ok('object.light_add', { name: 'Key_Area', type: 'AREA', energy: 1800, radius: 3, location: [0, 0, 5] });
    expect(light('Key_Area')).toMatchObject({ size: 3, size_y: 3, energy: 1800 });
    ok('object.light_add', { name: 'Bulb', type: 'POINT', radius: 0.4 });
    expect(light('Bulb').shadow_soft_size).toBeCloseTo(0.1);
    ok('object.light_add', { name: 'Default', type: 'AREA' });
    expect(light('Default')).toMatchObject({ size: 1, size_y: 1 });
    ok('object.light_add', { name: 'Sun', type: 'SUN', radius: 5 });
    expect(light('Sun')).toMatchObject({ shadow_soft_size: 0, energy: 1 });
  });

  it('creates a correctly sized soft box in one call', () => {
    const { ok, light } = setup();
    const r = ok('object.light_add', {
      name: 'Softbox',
      type: 'AREA',
      shape: 'RECTANGLE',
      size: 1.6,
      size_y: 0.5,
      radius: 3,
      energy: 300,
      use_shadow: false,
    });
    expect(r).toMatchObject({ name: 'Softbox' });
    expect(light('Softbox')).toMatchObject({
      shape: 'RECTANGLE',
      size: 1.6,
      size_y: 0.5,
      energy: 300,
      use_shadow: false,
    });
  });

  it('adds cameras with depth of field and clipping', () => {
    const { ok, camera } = setup();
    ok('object.empty_add', { name: 'Subject' });
    const r = ok('object.camera_add', {
      name: 'Hero',
      dof_use: true,
      dof_focus_object: 'Subject',
      clip_end: 60,
      angle: 0.5,
    });
    expect(r).toMatchObject({ name: 'Hero' });
    expect(camera('Hero')).toMatchObject({ dof_use: true, clip_end: 60 });
    expect(camera('Hero').lens).toBeCloseTo(36 / (2 * Math.tan(0.25)), 4);
    ok('object.camera_add', { name: 'Plain' });
    expect(camera('Plain')).toMatchObject({ lens: 50, dof_use: false, dof_focus_object: null });
  });

  it('adds orthographic cameras without lens warnings', () => {
    const { ok, camera, reports } = setup();
    ok('object.camera_add', { name: 'Top', type: 'ORTHO', ortho_scale: 12 });
    expect(camera('Top')).toMatchObject({ type: 'ORTHO', ortho_scale: 12, lens: 50 });
    expect(reports.filter((r) => r.level === 'WARNING')).toEqual([]);
  });
});

describe('anim.keyframe_insert_property with object names (#34)', () => {
  it('keys light and camera data through their objects', () => {
    const { ok, run, doc } = setup();
    const { light: lightId } = ok('object.light_add', { type: 'AREA', name: 'Area' });
    const { camera: camId } = ok('object.camera_add', { name: 'Cam X' });
    const a = ok('anim.keyframe_insert_property', {
      target_type: 'light',
      target: 'Area',
      path: 'size',
      frame: 1,
      value: 2,
    });
    expect(a).toEqual({ inserted: 1, target_id: lightId });
    ok('anim.keyframe_insert_property', { target_type: 'camera', target: 'Cam X', path: 'lens', value: 50 });
    expect(doc.listFCurves(lightId).map((f) => f.path)).toEqual(['size']);
    expect(doc.listFCurves(camId).map((f) => f.path)).toEqual(['lens']);
    const wrong = run('anim.keyframe_insert_property', {
      target_type: 'camera',
      target: 'Area',
      path: 'lens',
      value: 1,
    });
    expect(wrong.error).toContain("Object 'Area' is a LIGHT object, not a camera object");
  });
});
