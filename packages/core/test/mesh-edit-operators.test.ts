import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  countInconsistentEdges,
  createEditorState,
  createOperatorRegistry,
  isClosedManifold,
  meshStats,
  validateMesh,
  type MeshData,
  type OperatorContext,
} from '../src';

function setup(opts: { scale?: [number, number, number]; location?: [number, number, number] } = {}) {
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
  const run = (id: string, params?: unknown) => reg.run(ctx, id, params);
  expect(run('mesh.primitive_cube_add', { location: opts.location ?? [0, 0, 0], scale: opts.scale }).ok).toBe(
    true,
  );
  const objectId = ctx.state.activeId!;
  expect(run('object.mode_set', { mode: 'EDIT' }).ok).toBe(true);
  const mesh = (): MeshData => doc.getMesh(doc.getObject(objectId)!.data!)!;
  const um = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return { doc, reg, ctx, run, mesh, reports, objectId, um };
}

function expectValidClosed(m: MeshData) {
  expect(validateMesh(m)).toEqual([]);
  expect(countInconsistentEdges(m)).toBe(0);
  expect(isClosedManifold(m)).toBe(true);
}

describe('edit-mode selection operators', () => {
  it('selects all/none and switches select modes', () => {
    const { ctx, run } = setup();
    expect(ctx.state.meshSelection.verts.size).toBe(8);
    expect(run('mesh.select_all', { action: 'DESELECT' }).ok).toBe(true);
    expect(ctx.state.meshSelection.verts.size).toBe(0);
    run('mesh.select_all');
    expect(ctx.state.meshSelection.faces.size).toBe(6);
    run('mesh.select_all', { action: 'DESELECT' });
    run('mesh.select_elements', { verts: [1] });
    const r = run('mesh.select_mode', { type: 'FACE', use_expand: true });
    expect(r.ok).toBe(true);
    expect(ctx.state.selectMode).toBe('FACE');
    expect(ctx.state.meshSelection.faces.size).toBe(3);
    run('mesh.select_mode', { type: 'VERT' });
    expect(ctx.state.meshSelection.verts.size).toBe(7);
  });

  it('selects explicit elements and reports invalid indices', () => {
    const { ctx, run } = setup();
    run('mesh.select_mode', { type: 'FACE' });
    const r = run('mesh.select_elements', { faces: [5] });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ selected_faces: 1, selected_verts: 4, vertices: 8, faces: 6 });
    expect([...ctx.state.meshSelection.faces]).toEqual([5]);
    const bad = run('mesh.select_elements', { verts: [42] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/out of range/);
    expect(run('mesh.select_elements', { edges: [[0, 7]] }).error).toMatch(/does not exist/);
  });

  it('selects top faces by world-space normal on a rotated object', () => {
    const { doc, ctx, run, objectId } = setup();
    doc.updateObject(objectId, { rotation_euler: [Math.PI / 2, 0, 0] });
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_by_normal', { direction: [0, 0, 1], angle: 0.1 });
    // Local +Y (face 3) points up in world space after a +90° rotation about X.
    expect([...ctx.state.meshSelection.faces]).toEqual([3]);
  });

  it('runs loop, ring, linked, more/less, loose, random and non-manifold selection', () => {
    const { ctx, run } = setup();
    run('mesh.select_mode', { type: 'EDGE' });
    run('mesh.select_all', { action: 'DESELECT' });
    expect(run('mesh.loop_select', { edge: [0, 1] }).ok).toBe(true);
    expect(ctx.state.meshSelection.edges.size).toBe(1); // cube corners are 3-valent
    run('mesh.edgering_select', { edge: [0, 1] });
    expect(ctx.state.meshSelection.edges.size).toBe(4);
    run('mesh.select_mode', { type: 'VERT' });
    run('mesh.select_all', { action: 'DESELECT' });
    run('mesh.select_elements', { verts: [0] });
    run('mesh.select_more');
    expect(ctx.state.meshSelection.verts.size).toBe(7);
    run('mesh.select_less');
    expect(ctx.state.meshSelection.verts.size).toBe(1);
    run('mesh.select_linked');
    expect(ctx.state.meshSelection.verts.size).toBe(8);
    run('mesh.select_loose');
    expect(ctx.state.meshSelection.verts.size).toBe(0);
    run('mesh.select_random', { ratio: 1, seed: 1 });
    expect(ctx.state.meshSelection.verts.size).toBe(8);
    run('mesh.select_non_manifold', { extend: false });
    expect(ctx.state.meshSelection.verts.size).toBe(0);
    run('mesh.select_mode', { type: 'FACE' });
    expect(run('mesh.select_non_manifold').error).toMatch(/face selection mode/);
  });

  it('requires edit mode', () => {
    const { ctx, run } = setup();
    ctx.state.mode = 'OBJECT';
    const r = run('mesh.extrude_region_move', { value: [0, 0, 1] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Edit Mode/);
    expect(run('mesh.select_all').ok).toBe(false);
  });
});

describe('edit-mode modeling operators', () => {
  it('extrudes the top face and undoes it as one step', () => {
    const { ctx, run, mesh, um } = setup();
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [5] });
    const r = run('mesh.extrude_region_move', { value: [0, 0, 1] });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ vertices: 12, faces: 10, selected_faces: 1 });
    expectValidClosed(mesh());
    const top = [...ctx.state.meshSelection.verts];
    for (const v of top) expect(mesh().positions[v * 3 + 2]).toBeCloseTo(2);
    um.undo();
    expect(meshStats(mesh())).toMatchObject({ vertices: 8, faces: 6 });
    um.redo();
    expect(meshStats(mesh())).toMatchObject({ vertices: 12, faces: 10 });
  });

  it('converts world-space offsets into object space', () => {
    const { run, mesh, ctx } = setup({ scale: [1, 1, 2] });
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [5] });
    run('mesh.extrude_region_move', { value: [0, 0, 2] });
    for (const v of ctx.state.meshSelection.verts) expect(mesh().positions[v * 3 + 2]).toBeCloseTo(2);
    run('mesh.duplicate_move', { value: [0, 0, 4] });
    expect(meshStats(mesh()).faces).toBe(11);
    for (const v of ctx.state.meshSelection.verts) expect(mesh().positions[v * 3 + 2]).toBeCloseTo(4);
  });

  it('merges at the 3D cursor given in world space', () => {
    const { ctx, run, mesh } = setup({ location: [10, 0, 0] });
    ctx.state.cursorLocation = [10, 0, 5];
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [5] });
    expect(run('mesh.merge', { type: 'CURSOR' }).result).toMatchObject({ vertices: 5, faces: 5 });
    const p = mesh().positions;
    const tip = [0, 1, 2, 3, 4].find((v) => p[v * 3 + 2] > 4)!;
    expect(Array.from(p.slice(tip * 3, tip * 3 + 3))).toEqual([0, 0, 5]);
    expectValidClosed(mesh());
    // In face select mode a lone vertex cannot stay selected (Blender behaviour).
    expect(ctx.state.meshSelection.verts.size).toBe(0);
  });

  it('runs the core modeling tools in sequence and keeps the mesh valid', () => {
    const { run, mesh, reports } = setup();
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [5] });
    expect(run('mesh.inset', { thickness: 0.2, depth: 0.1 }).result).toMatchObject({
      vertices: 12,
      faces: 10,
    });
    expect(run('mesh.extrude_region_shrink_fatten', { value: 0.5 }).ok).toBe(true);
    expect(run('mesh.extrude_faces_move', { value: 0.25 }).ok).toBe(true);
    expect(run('mesh.poke', { offset: 0.1 }).ok).toBe(true);
    expectValidClosed(mesh());
    run('mesh.select_all', { action: 'SELECT' });
    expect(run('mesh.subdivide', { number_cuts: 1 }).ok).toBe(true);
    expectValidClosed(mesh());
    expect(run('mesh.quads_convert_to_tris').ok).toBe(true);
    expect(mesh().faces.every((f) => f.length === 3)).toBe(true);
    expect(run('mesh.tris_convert_to_quads').ok).toBe(true);
    expect(run('mesh.vertices_smooth', { factor: 0.3, repeat: 2 }).ok).toBe(true);
    expect(run('mesh.normals_make_consistent').ok).toBe(true);
    expectValidClosed(mesh());
    expect(run('mesh.remove_doubles', { threshold: 0.0001 }).ok).toBe(true);
    expect(reports.some((m) => /Removed 0 vertice/.test(m))).toBe(true);
  });

  it('loop cuts, deletes and fills', () => {
    const { run, mesh, ctx } = setup();
    const r = run('mesh.loopcut', { edge: [0, 1], number_cuts: 2 });
    expect(r.result).toMatchObject({ vertices: 16, faces: 14 });
    expect(ctx.state.meshSelection.verts.size).toBe(8);
    expectValidClosed(mesh());
    expect(run('mesh.loopcut', { edge: [0, 7] }).error).toMatch(/does not exist/);
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [5] });
    expect(run('mesh.delete', { type: 'FACE' }).result).toMatchObject({ faces: 13 });
    expect(isClosedManifold(mesh())).toBe(false);
    run('mesh.select_mode', { type: 'EDGE' });
    run('mesh.select_non_manifold');
    expect(ctx.state.meshSelection.edges.size).toBe(4);
    expect(run('mesh.edge_face_add').ok).toBe(true);
    expectValidClosed(mesh());
  });

  it('dissolves, marks edges and creases', () => {
    const { run, mesh } = setup();
    run('mesh.select_mode', { type: 'EDGE' });
    run('mesh.select_elements', { edges: [[1, 5]] });
    expect(run('mesh.mark_seam').ok).toBe(true);
    expect(run('mesh.mark_sharp').ok).toBe(true);
    expect(run('transform.edge_crease', { value: 0.5 }).ok).toBe(true);
    const attr = mesh().edgeAttrs['1,5'];
    expect(attr.seam).toBe(true);
    expect(attr.sharp).toBe(true);
    expect(attr.crease).toBeCloseTo(0.5);
    expect(run('mesh.dissolve_edges').result).toMatchObject({ faces: 5 });
    expectValidClosed(mesh());
    run('mesh.select_mode', { type: 'VERT' });
    run('mesh.select_elements', { verts: [0] });
    expect(run('mesh.dissolve_verts').result).toMatchObject({ vertices: 7 });
    expectValidClosed(mesh());
  });

  it('fails with a clear message when nothing relevant is selected', () => {
    const { run } = setup();
    run('mesh.select_all', { action: 'DESELECT' });
    const r = run('mesh.inset', { thickness: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No faces selected/);
    expect(run('mesh.extrude_region_move').error).toMatch(/selected/);
  });

  it('separates the selection into a new object with the same transform and materials', () => {
    const { doc, ctx, run, mesh, objectId } = setup({ location: [1, 2, 3] });
    ctx.state.mode = 'OBJECT';
    run('material.new', { name: 'Red' });
    ctx.state.mode = 'EDIT';
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [5] });
    const r = run('mesh.separate', { type: 'SELECTED' });
    expect(r.ok).toBe(true);
    const { objects } = r.result as { objects: string[] };
    expect(objects).toHaveLength(1);
    const o = doc.getObject(objects[0])!;
    expect(o.location).toEqual([1, 2, 3]);
    expect(o.material_slots).toEqual(doc.getObject(objectId)!.material_slots);
    expect(meshStats(doc.getMesh(o.data!)!)).toMatchObject({ vertices: 4, faces: 1 });
    expect(meshStats(mesh())).toMatchObject({ faces: 5 });
    expect(ctx.state.selectedIds).toContain(objects[0]);
    expect(run('mesh.separate', { type: 'LOOSE' }).error).toMatch(/one connected part/);
  });

  it('describes every edit operator with a schema', () => {
    const { reg } = setup();
    const ids = reg.describe().map((d) => d.id);
    for (const id of [
      'mesh.select_all',
      'mesh.select_elements',
      'mesh.loop_select',
      'mesh.extrude_region_move',
      'mesh.inset',
      'mesh.loopcut',
      'mesh.subdivide',
      'mesh.delete',
      'mesh.merge',
      'mesh.separate',
      'transform.edge_crease',
    ])
      expect(ids).toContain(id);
    for (const d of reg
      .describe()
      .filter((x) => x.id.startsWith('mesh.') && !x.id.startsWith('mesh.primitive'))) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.parameters).toMatchObject({ type: 'object' });
    }
  });
});

describe('advanced and UV operators', () => {
  it('bevels all edges of the cube and undoes it', () => {
    const { run, mesh, ctx, um } = setup();
    const r = run('mesh.bevel', { offset: 0.2, segments: 1 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ vertices: 24, faces: 26 });
    expectValidClosed(mesh());
    expect(ctx.state.meshSelection.faces.size).toBeGreaterThan(0);
    const round = run('mesh.bevel', { offset: 0.05, segments: 3, affect: 'EDGES' });
    expect(round.ok).toBe(true);
    expectValidClosed(mesh());
    um.undo();
    um.undo();
    expect(meshStats(mesh())).toMatchObject({ vertices: 8, faces: 6 });
    run('mesh.select_all', { action: 'DESELECT' });
    run('mesh.select_elements', { verts: [0] });
    expect(run('mesh.bevel', { offset: 0.3, affect: 'VERTICES' }).result).toMatchObject({
      vertices: 10,
      faces: 7,
    });
  });

  it('insets two faces and bridges them into a tunnel', () => {
    const { run, mesh } = setup();
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [4, 5] });
    run('mesh.inset', { thickness: 0.3, use_individual: true });
    const r = run('mesh.bridge_edge_loops', { number_cuts: 2 });
    expect(r.ok).toBe(true);
    expectValidClosed(mesh());
    expect(meshStats(mesh()).faces).toBe(6 + 8 - 2 + 12); // inset walls, bridged faces removed, 3 bands
  });

  it('spins around the 3D cursor by default', () => {
    const { ctx, run, mesh } = setup();
    ctx.state.cursorLocation = [3, 0, 0];
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_elements', { faces: [1] }); // +X face
    const r = run('mesh.spin', { steps: 8, angle: Math.PI, axis: [0, 0, 1] });
    expect(r.ok).toBe(true);
    expect(validateMesh(mesh())).toEqual([]);
    expect(countInconsistentEdges(mesh())).toBe(0);
    // Half a turn around x=3 moves the end cap to x ∈ [5, 7].
    const xs = [...ctx.state.meshSelection.verts].map((v) => mesh().positions[v * 3]);
    expect(Math.min(...xs)).toBeCloseTo(5, 4);
    expect(Math.max(...xs)).toBeCloseTo(5, 4);
  });

  it('symmetrizes and solidifies', () => {
    const { run, mesh } = setup();
    expect(run('mesh.symmetrize', { direction: 'POSITIVE_Y' }).result).toMatchObject({
      vertices: 12,
      faces: 10,
    });
    expectValidClosed(mesh());
    run('mesh.select_mode', { type: 'FACE' });
    run('mesh.select_all', { action: 'SELECT' });
    run('mesh.delete', { type: 'FACE' });
    run('mesh.primitive_plane_add');
    expect(run('mesh.solidify', { thickness: 0.1 }).result).toMatchObject({ vertices: 8, faces: 6 });
    expectValidClosed(mesh());
  });

  it('projects UVs on the selection (or everything) and is undoable', () => {
    const { run, mesh, um } = setup();
    const before = mesh().uvs!.map((u) => u.slice());
    for (const id of [
      'uv.smart_project',
      'uv.unwrap',
      'uv.cube_project',
      'uv.cylinder_project',
      'uv.sphere_project',
      'uv.reset',
    ]) {
      const r = run(id);
      expect(r.ok, `${id}: ${r.error}`).toBe(true);
      expect(validateMesh(mesh())).toEqual([]);
    }
    run('uv.smart_project', { island_margin: 0.05 });
    for (const uv of mesh().uvs!) for (const x of uv) expect(x >= 0 && x <= 1).toBe(true);
    for (let i = 0; i < 7; i++) um.undo();
    mesh().uvs!.forEach((u, f) => u.forEach((x, i) => expect(x).toBeCloseTo(before[f][i], 5)));
  });
});
