import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  type OperatorContext,
} from '../src';
import { signedVolume } from './modifiers-helpers';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  run('mesh.primitive_cube_add', { name: 'Cube' });
  const cube = ctx.state.activeId!;
  const mods = () => doc.getObject(cube)!.modifiers;
  const evaluated = () => new SceneEvaluator(doc).evaluate(ctx.state.frame).byId.get(cube)!.mesh!;
  return { doc, reg, ctx, run, reports, cube, mods, evaluated };
}

describe('modifier operators', () => {
  it('adds modifiers with unique Blender-style names and validated params', () => {
    const { run, mods, evaluated } = setup();
    const a = run('object.modifier_add', { type: 'SUBSURF' });
    expect(a.ok).toBe(true);
    expect(a.result).toMatchObject({ name: 'Subdivision' });
    expect(run('object.modifier_add', { type: 'SUBSURF' }).result.name).toBe('Subdivision.001');
    expect(mods().map((m) => m.name)).toEqual(['Subdivision', 'Subdivision.001']);
    expect(mods()[0]).toMatchObject({
      id: a.result.modifier,
      type: 'SUBSURF',
      show_viewport: true,
      show_render: true,
    });
    expect(mods()[0].params).toMatchObject({ levels: 1, render_levels: 2 });
    expect(evaluated().faces.length).toBe(96);
    // types resolve case-insensitively and by label
    expect(run('object.modifier_add', { type: 'mirror' }).result.name).toBe('Mirror');
    expect(run('object.modifier_add', { type: 'Subdivision Surface' }).result.name).toBe('Subdivision.002');
    expect(run('object.modifier_add', { type: 'ARRAY', name: 'Row', params: { count: 5 } }).result.name).toBe(
      'Row',
    );
    expect(mods().find((m) => m.name === 'Row')!.params.count).toBe(5);
  });

  it('rejects unknown types, invalid params and unknown parameter names', () => {
    const { run, mods } = setup();
    const unknownType = run('object.modifier_add', { type: 'FLUFFY' });
    expect(unknownType.ok).toBe(false);
    expect(unknownType.error).toMatch(/Valid types: .*SUBSURF/);
    const bad = run('object.modifier_add', { type: 'SUBSURF', params: { levels: 99 } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/levels/);
    const typo = run('object.modifier_add', { type: 'SUBSURF', params: { level: 2 } });
    expect(typo.ok).toBe(false);
    expect(typo.error).toMatch(/Unknown parameter 'level'/);
    expect(typo.error).toMatch(/Valid parameters: .*levels.*render_levels/);
    expect(mods()).toHaveLength(0);
  });

  it('only accepts mesh objects', () => {
    const { run, ctx, mods } = setup();
    run('object.camera_add', {});
    const r = run('object.modifier_add', { type: 'SUBSURF' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only mesh objects/);
    // explicit object (by name) works regardless of the active object
    expect(run('object.modifier_add', { type: 'SUBSURF', object: 'Cube' }).ok).toBe(true);
    expect(mods()).toHaveLength(1);
    expect(ctx.state.activeId).not.toBeNull();
    expect(run('object.modifier_add', { type: 'SUBSURF', object: 'Nope' }).error).toMatch(/not found/);
  });

  it('sets params (merged + validated), names and visibility flags', () => {
    const { run, mods, evaluated } = setup();
    run('object.modifier_add', { type: 'SUBSURF' });
    expect(run('object.modifier_set', { modifier: 'Subdivision', params: { levels: 2 } }).ok).toBe(true);
    expect(mods()[0].params).toMatchObject({
      levels: 2,
      render_levels: 2,
      subdivision_type: 'CATMULL_CLARK',
    });
    expect(evaluated().faces.length).toBe(96);
    const typo = run('object.modifier_set', { modifier: 'Subdivision', params: { lvls: 3 } });
    expect(typo.ok).toBe(false);
    expect(typo.error).toMatch(/Valid parameters/);
    expect(
      run('object.modifier_set', { modifier: 'Subdivision', params: { subdivision_type: 'LOOP' } }).ok,
    ).toBe(false);
    expect(mods()[0].params.levels).toBe(2);
    run('object.modifier_set', {
      modifier: 'Subdivision',
      name: 'Smooth',
      show_viewport: false,
      show_expanded: false,
    });
    expect(mods()[0]).toMatchObject({ name: 'Smooth', show_viewport: false, show_expanded: false });
    expect(evaluated().faces.length).toBe(6);
    run('object.modifier_add', { type: 'SUBSURF' });
    expect(run('object.modifier_set', { modifier: 'Subdivision', name: 'Smooth' }).result.name).toBe(
      'Smooth.001',
    );
    expect(run('object.modifier_set', { modifier: 'Missing', name: 'x' }).error).toMatch(/not found.*Smooth/);
  });

  it('moves, copies and removes modifiers', () => {
    const { run, mods, reports } = setup();
    for (const type of ['SUBSURF', 'MIRROR', 'ARRAY']) run('object.modifier_add', { type });
    const names = () => mods().map((m) => m.name);
    run('object.modifier_move_up', { modifier: 'Array' });
    expect(names()).toEqual(['Subdivision', 'Array', 'Mirror']);
    run('object.modifier_move_down', { modifier: 'Subdivision' });
    expect(names()).toEqual(['Array', 'Subdivision', 'Mirror']);
    run('object.modifier_move_to_index', { modifier: 'Mirror', index: 0 });
    expect(names()).toEqual(['Mirror', 'Array', 'Subdivision']);
    expect(run('object.modifier_move_to_index', { modifier: 'Mirror', index: 99 }).result.index).toBe(2);
    expect(run('object.modifier_move_down', { modifier: 'Mirror' }).ok).toBe(true);
    expect(reports.some((r) => /already at position/.test(r))).toBe(true);
    const id = mods()[0].id;
    const copy = run('object.modifier_copy', { modifier: id });
    expect(copy.result).toMatchObject({ name: 'Array.001', index: 1 });
    expect(mods()[1].id).not.toBe(id);
    expect(mods()[1].params).toEqual(mods()[0].params);
    expect(run('object.modifier_remove', { modifier: 'Array' }).ok).toBe(true);
    expect(names()).toEqual(['Array.001', 'Subdivision', 'Mirror']);
  });

  it('applies the stack up to a modifier into single-user mesh data', () => {
    const { doc, run, ctx, cube, mods } = setup();
    run('object.modifier_add', { type: 'SUBSURF' });
    run('object.modifier_add', { type: 'TRIANGULATE' });
    run('object.modifier_add', { type: 'MIRROR' });
    // linked duplicate shares the mesh data
    run('object.duplicate', { linked: true });
    const twin = ctx.state.activeId!;
    expect(doc.getObject(twin)!.data).toBe(doc.getObject(cube)!.data);
    run('object.select', { objects: [cube] });
    const r = run('object.modifier_apply', { modifier: 'Triangulate', object: cube });
    expect(r.ok).toBe(true);
    expect(r.result.applied).toEqual(['Subdivision', 'Triangulate']);
    expect(mods().map((m) => m.name)).toEqual(['Mirror']);
    const meshId = doc.getObject(cube)!.data!;
    expect(meshId).not.toBe(doc.getObject(twin)!.data);
    expect(doc.getMesh(meshId)!.faces.length).toBe(48);
    expect(doc.getMesh(doc.getObject(twin)!.data!)!.faces.length).toBe(6);
  });

  it('skips disabled modifiers, refuses disabled targets and edit mode, and reports failures', () => {
    const { doc, run, cube, mods } = setup();
    run('object.modifier_add', { type: 'SUBSURF' });
    run('object.modifier_add', { type: 'TRIANGULATE' });
    run('object.modifier_set', { modifier: 'Subdivision', show_viewport: false });
    expect(run('object.modifier_apply', { modifier: 'Subdivision' }).error).toMatch(/disabled/);
    expect(run('object.modifier_apply', { modifier: 'Triangulate' }).ok).toBe(true);
    expect(doc.getMesh(doc.getObject(cube)!.data!)!.faces.length).toBe(12);
    expect(mods().map((m) => m.name)).toEqual(['Subdivision']);
    // broken parameters stored on the object are reported
    doc.updateObject(cube, { modifiers: [{ ...mods()[0], show_viewport: true, params: { levels: 42 } }] });
    const broken = run('object.modifier_apply', { modifier: 'Subdivision' });
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/Subdivision.*levels/);
    expect(doc.getMesh(doc.getObject(cube)!.data!)!.faces.length).toBe(12);
    run('object.mode_set', { mode: 'EDIT' });
    expect(run('object.modifier_apply', { modifier: 'Subdivision' }).error).toMatch(/Edit Mode/);
  });

  it('resolves object references by name and applies booleans using the evaluated operand', () => {
    const { doc, run, cube, mods } = setup();
    run('mesh.primitive_cube_add', { name: 'Cutter', location: [1, 0.7, 0.4] });
    const cutterId = doc.findObjectByName('Cutter')!.id;
    expect(
      run('object.modifier_add', { type: 'BOOLEAN', object: cube, params: { object: 'Cutter' } }).ok,
    ).toBe(true);
    expect(mods()[0].params.object).toBe(cutterId);
    expect(
      run('object.modifier_set', { modifier: 'Boolean', object: cube, params: { object: 'Nope' } }).error,
    ).toMatch(/not found/);
    expect(
      run('object.modifier_set', { modifier: 'Boolean', object: cube, params: { object: 'Cube' } }).error,
    ).toMatch(/own object/);
    expect(run('object.modifier_apply', { modifier: 'Boolean', object: cube }).ok).toBe(true);
    expect(signedVolume(doc.getMesh(doc.getObject(cube)!.data!)!)).toBeCloseTo(8 - 2.08, 4);
  });

  it('is undoable', () => {
    const { doc, run, cube, mods } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    run('object.modifier_add', { type: 'SUBSURF' });
    run('object.modifier_set', { modifier: 'Subdivision', params: { levels: 3 } });
    expect(mods()[0].params.levels).toBe(3);
    um.undo();
    expect(mods()[0].params.levels).toBe(1);
    um.undo();
    expect(mods()).toHaveLength(0);
    um.redo();
    um.redo();
    expect(mods()[0].params.levels).toBe(3);
    run('object.modifier_apply', { modifier: 'Subdivision' });
    expect(mods()).toHaveLength(0);
    expect(doc.getMesh(doc.getObject(cube)!.data!)!.faces.length).toBe(384);
    um.undo();
    expect(mods()).toHaveLength(1);
    expect(doc.getMesh(doc.getObject(cube)!.data!)!.faces.length).toBe(6);
  });

  it('describes the operators for UIs and agents', () => {
    const { reg } = setup();
    const info = reg.describe({ category: 'Object' }).filter((o) => o.id.startsWith('object.modifier_'));
    expect(info.map((o) => o.id).sort()).toEqual([
      'object.modifier_add',
      'object.modifier_apply',
      'object.modifier_copy',
      'object.modifier_move_down',
      'object.modifier_move_to_index',
      'object.modifier_move_up',
      'object.modifier_remove',
      'object.modifier_set',
    ]);
    expect(info.find((o) => o.id === 'object.modifier_add')!.description).toMatch(/SUBSURF/);
  });
});
