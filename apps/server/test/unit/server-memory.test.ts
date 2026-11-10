import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  createEditorState,
  createGrid,
  createOperatorRegistry,
  enterEditMode,
  estimateCurveSurface,
  estimateOperator,
  geometryMemoryCheck,
  meshMemoryCheck,
  OperatorError,
  operatorMemoryCheck,
  setGeometryMemoryCheck,
  setMeshMemoryCheck,
  setOperatorMemoryCheck,
  storedMeshBytes,
  type OperatorContext,
} from '@3d-editor/core';
import {
  decodeCheck,
  geometryCheck,
  installGeometryMemoryGuard,
  maxProjectMeshBytes,
  meshJsonChars,
  operatorCheck,
  snapshotMeshChars,
  snapshotRefusal,
} from '../../src/render/memory';
import { describeObject, summarizeScene } from '../../src/mcp/scene-summary';

/*
 * The operators of MCP tools and the REST API run in the server's own process, whose JavaScript
 * heap every connection and project shares; V8 ends the whole process when it runs out. The
 * server refuses an operator whose estimated peak heap does not fit into the free heap less the
 * 256 MB it keeps, one that would leave more decoded meshes in a project than half of the heap less
 * those 256 MB, and the decoding of a stored mesh that does not fit (get_scene then lists the
 * stored counts). The heap is injected here (the real checks read V8's heap statistics).
 */

const MB = 1024 * 1024;

afterEach(() => {
  setOperatorMemoryCheck(null);
  setMeshMemoryCheck(null);
  setGeometryMemoryCheck(null);
});

function project(doc = SceneDoc.create({ empty: true })) {
  const registry = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: { type: 'test' },
    source: 'test',
    report: () => undefined,
  };
  return {
    doc,
    ctx,
    run: (id: string, params: Record<string, unknown> = {}) => registry.run(ctx, id, params),
  };
}

describe("operators in the server's process", () => {
  it('refuse an edit operator whose estimated peak heap does not fit, and say what to lower', () => {
    const { doc, ctx, run } = project();
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 50, y_subdivisions: 50 }).ok).toBe(true);
    const meshId = doc.getObject(ctx.state.activeId!)!.data!;
    expect(run('object.mode_set', { mode: 'EDIT' }).ok).toBe(true);
    let collected = 0;
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 400 * MB, collect: () => collected++, heapLimit: () => 2048 * MB }),
    );
    // 4 cuts: 62,500 faces, about 260 MB at its peak, of which 144 MB fit above the reserve
    const res = run('mesh.subdivide', { number_cuts: 4 });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    const need = estimateOperator('mesh.subdivide', ctx, { number_cuts: 4 })!;
    expect(need.faces).toBe(62_500);
    expect(res.error).toBe(
      `not run on the server: it would need about ${Math.round(need.bytes / MB).toLocaleString('en-US')} MB of ` +
        "JavaScript heap for a mesh of about 62,500 faces, and the server's process has 400 MB of its 2,048 MB " +
        'heap free and keeps 256 MB of it for its other work. Lower number_cuts, or select fewer faces to run it ' +
        'on the server (a browser editor runs it in its own memory)',
    );
    // a full garbage collection ran before the refusal, and the mesh is as it was
    expect(collected).toBe(1);
    expect(doc.meshCounts(meshId)!.faces).toBe(2_500);
    // what fits runs: one cut, 10,000 faces
    expect(run('mesh.subdivide', { number_cuts: 1 }).ok).toBe(true);
    expect(doc.meshCounts(meshId)!.faces).toBe(10_000);
  });

  it('refuse Edit Mode on a mesh whose full selection does not fit (MCP edit_mesh enters it without the registry)', () => {
    const { ctx, run } = project();
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 100, y_subdivisions: 100 }).ok).toBe(true);
    const id = ctx.state.activeId!;
    // 32 MB and 600 bytes per face: 38 MB, of which 14 MB fit above the reserve
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 270 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    let err: unknown = null;
    try {
      enterEditMode(ctx, id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toMatchObject({
      code: 'OUT_OF_MEMORY',
      message:
        "Edit Mode on 'Grid': not run on the server: it would need about 38 MB of JavaScript heap for a mesh of " +
        "about 10,000 faces, and the server's process has 270 MB of its 2,048 MB heap free and keeps 256 MB of it " +
        'for its other work. Lower the number of faces of the mesh to run it on the server (a browser editor runs ' +
        'it in its own memory)',
    });
    expect(ctx.state.mode).toBe('OBJECT');
    expect(run('object.mode_set', { mode: 'EDIT' })).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    // with room for it
    setOperatorMemoryCheck(operatorCheck({ heapFree: () => 400 * MB, collect: () => 0 }));
    enterEditMode(ctx, id);
    expect(ctx.state.mode).toBe('EDIT');
  });

  it('refuse an operator that would leave more decoded meshes in the project than the server keeps for one', () => {
    const { doc, ctx, run } = project();
    // a heap of 300 MB keeps (300 - 256) / 2 = 22 MB for the meshes of one project
    expect(maxProjectMeshBytes(300 * MB)).toBe(22 * MB);
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => 0, heapLimit: () => 300 * MB }),
    );
    const grid = { x_subdivisions: 200, y_subdivisions: 200, location: [0, 0, 0] };
    expect(run('mesh.primitive_grid_add', grid).ok).toBe(true);
    expect(run('mesh.primitive_grid_add', { ...grid, location: [3, 0, 0] }).ok).toBe(true);
    // two grids of 40,000 faces take about 10 MB each decoded: a third does not fit
    const before = storedMeshBytes(doc);
    const added = estimateOperator('mesh.primitive_grid_add', ctx, grid)!.addedStoredBytes;
    expect(before).toBeLessThan(22 * MB);
    expect(before + added).toBeGreaterThan(22 * MB);
    const res = run('mesh.primitive_grid_add', { ...grid, location: [6, 0, 0] });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    const mb = (bytes: number) => Math.round(bytes / MB);
    expect(res.error).toBe(
      `not run on the server: the project's meshes would then take about ${mb(before + added)} MB of JavaScript ` +
        `heap decoded (now ${mb(before)} MB), more than the 22 MB the server's process keeps for the meshes of ` +
        'one project (half of its 300 MB heap less the 256 MB it keeps for its other work). Lower ' +
        'x_subdivisions and y_subdivisions, or delete meshes the project no longer needs',
    );
    expect(doc.listObjects()).toHaveLength(2);
    // operators that add no geometry still run
    expect(run('object.shade_smooth').ok).toBe(true);
    // a cube adds next to nothing: there is nothing of it to lower, only meshes to delete
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => 0, heapLimit: () => 290 * MB }),
    );
    const cube = run('mesh.primitive_cube_add', { location: [9, 0, 0] });
    expect(cube).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(cube.error).toMatch(
      / more than the 17 MB the server's process keeps for the meshes of one project \(half of its 290 MB heap less the 256 MB it keeps for its other work\)\. Delete meshes the project no longer needs$/,
    );
  });

  it('run the generators at their defaults on a server with a 1 GB heap (estimated from their parameters)', () => {
    // an empty server with Node's 1 GB heap has about 1,000 MB of its 1,072 MB free; the six generators
    // that check their own size were estimated at the 1,000,000 faces they may build at most (1.3 GB)
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 1000 * MB, collect: () => 0, heapLimit: () => 1072 * MB }),
    );
    for (const kind of ['tree', 'fence', 'spring', 'building', 'pipe', 'arch', 'blob', 'cloud']) {
      const { doc, run } = project();
      expect(run(`object.generate_${kind}`), kind).toMatchObject({ ok: true });
      expect(doc.listObjects(), kind).toHaveLength(1);
    }
  });

  it('name the parameters of a generator to lower when it does not fit', () => {
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 400 * MB, collect: () => 0, heapLimit: () => 1072 * MB }),
    );
    const { ctx, run } = project();
    // 4 levels of 6 branches: 2,377 limbs and 3,960 leaf clumps, about 349,000 faces (480 MB)
    const params = { branch_levels: 4, branches: 6, resolution: 16, leaf_density: 1 };
    const need = estimateOperator(
      'object.generate_tree',
      ctx,
      createOperatorRegistry().parseParams('object.generate_tree', params),
    )!;
    const res = run('object.generate_tree', params);
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toBe(
      `not run on the server: it would need about ${Math.round(need.bytes / MB).toLocaleString('en-US')} MB of ` +
        `JavaScript heap for a mesh of about ${need.faces.toLocaleString('en-US')} faces, and the server's ` +
        'process has 400 MB of its 1,072 MB heap free and keeps 256 MB of it for its other work. Lower ' +
        'branch_levels, branches, leaf_density or resolution to run it on the server (a browser editor runs it ' +
        'in its own memory)',
    );
    // the default tree fits
    expect(run('object.generate_tree').ok).toBe(true);
  });

  it('leave a modifier stack that fails by itself to Convert, which refuses it without building anything', () => {
    const { doc, ctx, run } = project();
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 300, y_subdivisions: 300 }).ok).toBe(true);
    // levels 5 would be 92,160,000 faces: Subdivision Surface refuses more than 4,000,000 itself
    expect(run('object.modifier_add', { type: 'SUBSURF', params: { levels: 5, render_levels: 5 } }).ok).toBe(
      true,
    );
    // a copy of the 90,000 faces would not fit into the 94 MB above the reserve, but Convert copies
    // nothing: it refuses the object for its failed modifier
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 350 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    const res = run('object.convert', { target: 'MESH' });
    expect(res).toMatchObject({ ok: false, code: 'FAILED' });
    expect(res.error).toMatch(
      /^Cannot convert 'Grid': modifier 'Subdivision': Subdivision result too large \(~92160000 faces\); lower the levels\. Nothing was converted/,
    );
    expect(doc.getObject(ctx.state.activeId!)!.modifiers).toHaveLength(1);
  });
});

describe("the server's checks", () => {
  it('are all installed when the render module loads (modifiers, operators, decoding stored meshes)', () => {
    expect([geometryMemoryCheck(), operatorMemoryCheck(), meshMemoryCheck()]).toEqual([null, null, null]);
    installGeometryMemoryGuard();
    expect(geometryMemoryCheck()).toBeTypeOf('function');
    expect(operatorMemoryCheck()).toBeTypeOf('function');
    expect(meshMemoryCheck()).toBeTypeOf('function');
  });
});

describe('linked duplicates', () => {
  it("refuse a join whose mesh would hold every duplicate's copy beyond what the server keeps for a project", () => {
    const { doc, ctx, run } = project();
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 100, y_subdivisions: 100 }).ok).toBe(true);
    const grid = ctx.state.activeId!;
    // 12 objects sharing one mesh of 10,000 faces (2 MB decoded)
    expect(run('object.array_place', { objects: [grid], count: 12, linked: true }).ok).toBe(true);
    ctx.state.selectedIds = doc.listObjects().map((o) => o.id);
    ctx.state.activeId = grid;
    // a heap of 300 MB keeps 22 MB for the meshes of one project
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => 0, heapLimit: () => 300 * MB }),
    );
    const res = run('object.join');
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toBe(
      "not run on the server: the project's meshes would then take about 28 MB of JavaScript heap decoded (now 2 MB), " +
        "more than the 22 MB the server's process keeps for the meshes of one project (half of its 300 MB heap less the " +
        '256 MB it keeps for its other work). Lower the number or size of the joined meshes, or delete meshes the ' +
        'project no longer needs',
    );
    expect(doc.listObjects()).toHaveLength(12);
    // Apply Transform gives each duplicate a copy of its own: 11 more meshes, refused the same way
    const apply = run('object.transform_apply', { location: true });
    expect(apply).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(apply.error).toMatch(/^not run on the server: the project's meshes would then take about 28 MB /);
    expect(doc.listMeshBlocks()).toHaveLength(1);
  });
});

describe('curve surfaces', () => {
  it("are skipped in the server's evaluation when they do not fit, and get_scene says why", () => {
    const { doc, ctx, run } = project();
    const points = Array.from({ length: 100 }, (_, i) => [i * 0.1, Math.sin(0.3 * i), Math.cos(0.2 * i)]);
    expect(
      run('curve.add_from_points', {
        points,
        type: 'BEZIER',
        resolution_u: 64,
        bevel_depth: 0.05,
        bevel_resolution: 8,
      }).ok,
    ).toBe(true);
    const curve = doc.getCurve(doc.getObject(ctx.state.activeId!)!.data!)!;
    const e = estimateCurveSurface(curve, { isText: false, forRender: true });
    // 128,060 vertices at most, about 99 MB to build: 300 MB free leave 44 MB above the reserve
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => 300 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    const s = summarizeScene(doc) as any;
    const message =
      `skipped on the server: this curve surface would need about ${Math.round(e.bytes / MB)} MB of JavaScript ` +
      `heap for a result of about ${e.result.faces.toLocaleString('en-US')} faces, and the server's process has ` +
      '300 MB of its 2,048 MB heap free and keeps 256 MB of it for its other work. Lower resolution_u, ' +
      'bevel_resolution or the number of spline points to evaluate it on the server (a browser editor evaluates ' +
      'it itself)';
    expect(s.problems).toEqual([{ source: 'curve', object: 'Curve', message }]);
    expect(s.counts.evaluated).toMatchObject({ faces: 0 });
    // with room for it (in a copy of the project: evaluations are cached per document state)
    setGeometryMemoryCheck(geometryCheck({ heapFree: () => 600 * MB, collect: () => 0 }));
    const built = summarizeScene(SceneDoc.fromUpdate(doc.encodeState())) as any;
    expect(built.problems).toBeUndefined();
    expect(built.counts.evaluated.faces).toBeGreaterThan(100_000);
  });

  it('refuse Convert of a curve whose surface, copy and stored mesh do not fit, and say what to lower', () => {
    const { ctx, run } = project();
    const points = Array.from({ length: 100 }, (_, i) => [i * 0.1, Math.sin(0.3 * i), Math.cos(0.2 * i)]);
    expect(
      run('curve.add_from_points', {
        points,
        type: 'BEZIER',
        resolution_u: 64,
        bevel_depth: 0.05,
        bevel_resolution: 8,
      }).ok,
    ).toBe(true);
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 400 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    const need = estimateOperator('object.convert', ctx, { target: 'MESH', keep_original: false })!;
    const res = run('object.convert', { target: 'MESH' });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toBe(
      `not run on the server: it would need about ${Math.round(need.bytes / MB)} MB of JavaScript heap for a mesh ` +
        `of about ${need.faces.toLocaleString('en-US')} faces, and the server's process has 400 MB of its 2,048 MB ` +
        'heap free and keeps 256 MB of it for its other work. Lower resolution_u, bevel_resolution or the number of ' +
        'spline points to run it on the server (a browser editor runs it in its own memory)',
    );
    expect(ctx.doc.getObject(ctx.state.activeId!)!.type).toBe('CURVE');
  });
});

describe('exports run in the process', () => {
  it('count the instances of a scatter and refuse an export that would not fit', () => {
    const { run } = project();
    expect(run('mesh.primitive_plane_add', { size: 20, name: 'Ground' }).ok).toBe(true);
    expect(
      run('mesh.primitive_ico_sphere_add', {
        subdivisions: 4,
        radius: 0.1,
        location: [0, 0, 5],
        name: 'Pebble',
      }).ok,
    ).toBe(true);
    expect(run('object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count: 5000 }).ok).toBe(true);
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 1500 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    // 5,000 instances of 1,280 faces: the OBJ holds 6,400,001 faces (about 11 GB to build)
    const res = run('export_scene.obj');
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toMatch(
      /^not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 6,400,001 faces, and the server's process has 1,500 MB of its 2,048 MB heap free and keeps 256 MB of it for its other work\. Lower the faces of the exported meshes and instances \(export fewer objects with use_selection, lower the counts of particle systems, or use the export_scene tool, which builds the file in a render process\) to run it on the server \(a browser editor runs it in its own memory\)$/,
    );
  });
});

describe('project snapshots (REST GET /api/projects/:id/snapshot)', () => {
  function grids(n: number, size: number): SceneDoc {
    const doc = SceneDoc.create({ name: 'Snapshot', empty: true });
    for (let i = 0; i < n; i++) {
      const mesh = doc.addMesh(`Grid${i}`, createGrid({ x_subdivisions: size, y_subdivisions: size }));
      doc.addObject({ type: 'MESH', name: `Grid${i}`, data: mesh, location: [3 * i, 0, 0] });
    }
    return doc;
  }

  it('are refused when the copy of the meshes and its JSON would not fit, and say what to do', () => {
    const doc = grids(2, 100);
    // a grid of 10,000 faces with UVs: 2.48 MB decoded and at most 3.07 MB of JSON (2.3 MB printed)
    const layout = { vertices: 10_201, faces: 10_000, corners: 40_000, uvs: true, colors: false };
    expect(snapshotMeshChars(layout)).toBe(
      72 * 10_201 + 8 * 40_000 + 12 * 10_000 + 48 * 40_000 + 3 * 10_000 + 256,
    );
    expect(JSON.stringify(doc.toSnapshot().meshes[0].mesh).length).toBeLessThan(snapshotMeshChars(layout));
    let collected = 0;
    const refused = snapshotRefusal(doc, {
      heapFree: () => 266 * MB,
      collect: () => collected++,
      heapLimit: () => 2048 * MB,
    });
    expect(refused).toBe(
      "not built on the server: it would need about 11 MB of JavaScript heap (a copy of the meshes and up to 6 MB of JSON), and the server's process has 266 MB of its 2,048 MB heap free and keeps 256 MB of it for its other work. Export the meshes instead (GET /api/projects/:id/export builds the file in a render process), or delete meshes the project no longer needs",
    );
    expect(collected).toBe(1);
    // with room for it
    expect(snapshotRefusal(doc, { heapFree: () => 300 * MB, collect: () => 0 })).toBeNull();
    // JSON longer than a JavaScript string holds: the bound from the counts (6 MB) does not refuse a
    // snapshot whose values print shorter (4.6 MB), counted when the bound is over the limit
    const mesh = doc.getMesh(doc.listMeshBlocks()[0].id)!;
    const json = JSON.stringify(mesh).length;
    expect(meshJsonChars(mesh)).toBeGreaterThanOrEqual(json);
    expect(meshJsonChars(mesh)).toBeLessThan(json + 200);
    expect(JSON.stringify(doc.toSnapshot()).length).toBeLessThan(5 * MB);
    expect(
      snapshotRefusal(doc, { heapFree: () => 4096 * MB, collect: () => 0, maxChars: 5 * MB }),
    ).toBeNull();
    expect(snapshotRefusal(doc, { heapFree: () => 4096 * MB, collect: () => 0, maxChars: 4 * MB })).toBe(
      'not built on the server: the snapshot would be 5 MB of JSON, more than the 4 MB a JavaScript string can hold. Export the meshes instead (GET /api/projects/:id/export builds the file in a render process), or delete meshes the project no longer needs',
    );
  });

  it("pass on the decode refusal of a stored mesh the server's process does not load", () => {
    const stored = SceneDoc.fromUpdate(Y.encodeStateAsUpdate(grids(1, 100).ydoc));
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 257 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    expect(snapshotRefusal(stored, { heapFree: () => 4096 * MB, collect: () => 0 })).toMatch(
      /^this mesh of 20,000 triangles was not loaded on the server: decoding it needs about 2 MB of JavaScript heap/,
    );
  });
});

describe("stored meshes in the server's process", () => {
  /** A project with a grid of 20,000 triangles, opened from its stored state (nothing decoded yet). */
  function stored(): SceneDoc {
    const doc = SceneDoc.create({ name: 'Stored', empty: true });
    const mesh = doc.addMesh('Grid', createGrid({ x_subdivisions: 100, y_subdivisions: 100 }));
    doc.addObject({ type: 'MESH', name: 'Grid', data: mesh });
    return SceneDoc.fromUpdate(Y.encodeStateAsUpdate(doc.ydoc));
  }

  const REFUSED =
    "this mesh of 20,000 triangles was not loaded on the server: decoding it needs about 2 MB of JavaScript heap, and the server's process has 257 MB of its 2,048 MB heap free and keeps 256 MB of it for its other work (the open projects keep their meshes decoded). Delete or simplify large meshes, or work on it in a browser editor that has the project open, which loads it in its own memory";

  it('are not decoded when they do not fit: get_scene lists their stored counts and why', () => {
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 257 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    const s = summarizeScene(stored()) as any;
    expect(s.counts).toMatchObject({ vertices: 10_201, faces: 10_000 });
    expect(s.objects[0].data).toEqual({
      kind: 'mesh',
      mesh: 'Grid',
      users: 1,
      vertices: 10_201,
      faces: 10_000,
      triangles: 20_000,
      not_loaded: REFUSED,
    });
    expect(s.problems).toEqual([{ source: 'mesh', object: 'Grid', message: REFUSED }]);
    expect(s.objects[0].problems).toEqual([`mesh: ${REFUSED}`]);
    // its extent is not known: no bounds (not a box of size 0 at the origin)
    expect(s.objects[0].world_bounds).toBeNull();
    const doc = stored();
    expect(describeObject(doc, doc.listObjects()[0]).world_bounds).toBeNull();
  });

  it('refuse the operators that would decode them, with code OUT_OF_MEMORY', () => {
    const { doc, ctx, run } = project(stored());
    const id = doc.listObjects()[0].id;
    ctx.state.selectedIds = [id];
    ctx.state.activeId = id;
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 257 * MB, collect: () => 0, heapLimit: () => 2048 * MB }),
    );
    expect(run('object.shade_smooth')).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY', error: REFUSED });
    // with room for it, the same mesh loads and the operator runs
    setMeshMemoryCheck(decodeCheck({ heapFree: () => 400 * MB, collect: () => 0 }));
    expect(run('object.shade_smooth').ok).toBe(true);
    expect((summarizeScene(doc) as any).objects[0].data).toMatchObject({ vertices: 10_201, faces: 10_000 });
  });
});

describe('get_scene problems', () => {
  it("list what only the viewport's evaluation has, marked viewport", () => {
    const { doc, ctx, run } = project(SceneDoc.create({ name: 'Viewport', empty: true }));
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 50, y_subdivisions: 50 }).ok).toBe(true);
    // viewport levels 6 (10,240,000 faces) are over Subdivision Surface's own limit; render levels 1 are not
    expect(run('object.modifier_add', { type: 'SUBSURF', params: { levels: 6, render_levels: 1 } }).ok).toBe(
      true,
    );
    expect(ctx.state.activeId).toBeTruthy();
    const s = summarizeScene(doc) as any;
    const message = 'Subdivision result too large (~10240000 faces); lower the levels';
    expect(s.problems).toEqual([
      expect.objectContaining({ object: 'Grid', modifier: 'Subdivision', message, viewport: true }),
    ]);
    const grid = s.objects.find((o: any) => o.name === 'Grid');
    expect(grid.modifier_errors).toEqual([{ modifier: 'Subdivision', message, viewport: true }]);
    // the render evaluation subdivides: what renders show
    expect(s.counts.evaluated.faces).toBe(10_000);
  });

  it('list a modifier both evaluations skip for memory once, though the free heap differs between them', () => {
    const { doc, run } = project(SceneDoc.create({ name: 'Skipped', empty: true }));
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 50, y_subdivisions: 50 }).ok).toBe(true);
    // levels 4: 640,000 faces, about 430 MB, which the 140 MB free above the reserve do not hold
    expect(run('object.modifier_add', { type: 'SUBSURF', params: { levels: 4, render_levels: 4 } }).ok).toBe(
      true,
    );
    // every evaluation finds a little less heap free
    let free = 400;
    setGeometryMemoryCheck(geometryCheck({ heapFree: () => (free -= 3) * MB, collect: () => 0 }));
    const s = summarizeScene(doc) as any;
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0]).toMatchObject({ object: 'Grid', modifier: 'Subdivision' });
    expect(s.problems[0].message).toMatch(
      /^skipped on the server: this Subdivision Surface would need about/,
    );
    // with the viewport's advice, which names both settings
    expect(s.problems[0].message).toMatch(
      /\. Lower levels \(render_levels for renders\) to evaluate it on the server/,
    );
    const grid = s.objects.find((o: any) => o.name === 'Grid');
    expect(grid.modifier_errors).toEqual([{ modifier: 'Subdivision', message: expect.any(String) }]);
    expect(grid.modifier_errors[0].message).toMatch(
      /\. Lower levels \(render_levels for renders\) to evaluate/,
    );
  });
});
