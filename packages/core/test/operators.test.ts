import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, createEditorState, createOperatorRegistry, type OperatorContext, selectAllElements } from '../src';

function setup(empty = false) {
  const doc = SceneDoc.create({ empty });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (id: string, params?: unknown) => reg.run(ctx, id, params);
  return { doc, reg, ctx, run, reports };
}

describe('operators', () => {
  it('adds primitives at the cursor and selects them', () => {
    const { doc, ctx, run } = setup(true);
    ctx.state.cursorLocation = [1, 2, 3];
    const r = run('mesh.primitive_uv_sphere_add', { segments: 8, ring_count: 4 });
    expect(r.ok).toBe(true);
    const o = doc.getObject(ctx.state.activeId!)!;
    expect(o.name).toBe('Sphere');
    expect(o.location).toEqual([1, 2, 3]);
    expect(ctx.state.selectedIds).toEqual([o.id]);
    expect(doc.getMesh(o.data!)!.positions.length / 3).toBe(8 * 3 + 2);
  });

  it('validates parameters', () => {
    const { run } = setup(true);
    const r = run('mesh.primitive_cube_add', { size: -1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid parameters/);
    expect(run('nope.nothing').error).toMatch(/Unknown operator/);
  });

  it('runs every operator as a single undoable transaction', () => {
    const { doc, run } = setup(true);
    const um = new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });
    run('mesh.primitive_cube_add');
    run('mesh.primitive_cube_add');
    expect(doc.listObjects()).toHaveLength(2);
    um.undo();
    expect(doc.listObjects()).toHaveLength(1);
    um.redo();
    expect(doc.listObjects().map((o) => o.name)).toEqual(['Cube', 'Cube.001']);
  });

  it('transforms selections around the median pivot', () => {
    const { doc, ctx, run } = setup(true);
    run('object.empty_add', { location: [1, 0, 0] });
    const a = ctx.state.activeId!;
    run('object.empty_add', { location: [3, 0, 0] });
    const b = ctx.state.activeId!;
    run('object.select', { objects: [a, b] });
    run('transform.resize', { value: [2, 2, 2] });
    expect(doc.getObject(a)!.location[0]).toBeCloseTo(0);
    expect(doc.getObject(b)!.location[0]).toBeCloseTo(4);
    run('transform.rotate', { value: Math.PI, orient_axis: 'Z' });
    expect(doc.getObject(a)!.location[0]).toBeCloseTo(4);
    run('transform.translate', { value: [0, 0, 1] });
    expect(doc.getObject(a)!.location[2]).toBeCloseTo(1);
  });

  it('duplicates (deep and linked), joins and deletes', () => {
    const { doc, ctx, run } = setup(true);
    run('mesh.primitive_cube_add');
    const cube = ctx.state.activeId!;
    run('object.duplicate', { linked: true, offset: [3, 0, 0] });
    const linked = ctx.state.activeId!;
    expect(doc.getObject(linked)!.data).toBe(doc.getObject(cube)!.data);
    expect(doc.getObject(linked)!.location[0]).toBeCloseTo(3);
    run('object.duplicate', { linked: false });
    const copy = ctx.state.activeId!;
    expect(doc.getObject(copy)!.data).not.toBe(doc.getObject(cube)!.data);
    run('object.select', { objects: [linked, copy, cube], active: cube });
    expect(run('object.join').ok).toBe(true);
    expect(doc.listObjects()).toHaveLength(1);
    expect(doc.getMesh(doc.getObject(cube)!.data!)!.faces.length).toBe(18);
    run('object.delete');
    expect(doc.listObjects()).toHaveLength(0);
  });

  it('applies transforms into mesh data', () => {
    const { doc, ctx, run } = setup(true);
    run('mesh.primitive_cube_add', { location: [0, 0, 0], scale: [2, 1, 1] });
    run('object.transform_apply', { scale: true, rotation: true });
    const o = doc.getObject(ctx.state.activeId!)!;
    expect(o.scale).toEqual([1, 1, 1]);
    const xs = doc.getMesh(o.data!)!.positions.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(2);
  });

  it('enters edit mode and adds primitives into the edit mesh', () => {
    const { doc, ctx, run } = setup(true);
    run('mesh.primitive_cube_add');
    expect(run('object.mode_set', { mode: 'EDIT' }).ok).toBe(true);
    expect(ctx.state.mode).toBe('EDIT');
    expect(ctx.state.meshSelection.verts.size).toBe(8);
    run('mesh.primitive_plane_add', { location: [0, 0, 5] });
    const mesh = doc.getMesh(doc.getObject(ctx.state.activeId!)!.data!)!;
    expect(mesh.faces.length).toBe(7);
    expect(ctx.state.meshSelection.verts.size).toBe(4);
    expect(doc.listObjects()).toHaveLength(1);
    void selectAllElements;
  });

  it('creates meshes from raw data and validates indices', () => {
    const { doc, ctx, run } = setup(true);
    const r = run('object.add_mesh_from_data', {
      name: 'Tri',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 2]],
    });
    expect(r.ok).toBe(true);
    expect(doc.getObject(ctx.state.activeId!)!.name).toBe('Tri');
    expect(run('object.add_mesh_from_data', { vertices: [[0, 0, 0]], faces: [[0, 1, 2]] }).ok).toBe(false);
  });

  it('keyframes objects and sets generic properties', () => {
    const { doc, ctx, run } = setup();
    const cube = doc.findObjectByName('Cube')!;
    run('object.select', { objects: ['Cube'] });
    ctx.state.frame = 1;
    run('anim.keyframe_insert', { type: 'Location' });
    ctx.state.frame = 10;
    run('data.set_property', { kind: 'objects', target: 'Cube', values: { location: [0, 0, 5] } });
    // animated property edits are re-keyed so they stay visible
    expect(doc.listFCurves(cube.id).find((f) => f.index === 2)!.keyframes).toHaveLength(2);
    expect(run('data.set_property', { kind: 'objects', target: 'Cube', values: { nope: 1 } }).ok).toBe(false);
    expect(run('data.set_property', { kind: 'render', values: { resolution_x: 640 } }).ok).toBe(true);
    expect(doc.getRender().resolution_x).toBe(640);
    expect(run('material.new', { name: 'Red', base_color: [1, 0, 0, 1] }).ok).toBe(true);
    expect(doc.getObject(cube.id)!.material_slots).toHaveLength(1);
  });

  it('describes operators with JSON schemas', () => {
    const { reg } = setup(true);
    const info = reg.describe().find((o) => o.id === 'mesh.primitive_cube_add')!;
    expect(info.parameters).toMatchObject({ type: 'object' });
    expect(JSON.stringify(info.parameters)).toContain('size');
  });
});
