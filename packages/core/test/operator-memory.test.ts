import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMPORT_BYTES_PER_FILE_BYTE,
  IMPORT_BYTES_PER_STL_TRIANGLE,
  IMPORT_STORED_BYTES_PER_FILE_BYTE,
  OPERATOR_ESTIMATES,
  OPERATOR_FIXED_BYTES,
  binaryStlTriangles,
  editOperatorMemoryRefusal,
  importEstimate,
  importMemoryRefusal,
  storedMeshBytes,
  createEditorState,
  createOperatorRegistry,
  edgeRingFaces,
  estimateOperator,
  primitiveFaces,
  setOperatorMemoryCheck,
  unestimatedReason,
  type OperatorContext,
  type OperatorMemoryRequest,
} from '../src/operators';
import {
  MeshMemoryError,
  decodedMeshBytes,
  countEdges,
  createGrid,
  createMesh,
  edgeKey,
  selectAllElements,
  selectionFromFaces,
  setMeshMemoryCheck,
  type MeshData,
} from '../src/mesh';
import {
  SceneEvaluator,
  TEXT_BYTES_PER_CHARACTER,
  estimateCurveSurface,
  setGeometryMemoryCheck,
  type GeometryMemoryRequest,
} from '../src/eval';
import { SceneDoc } from '../src/doc/scene-doc';

/*
 * Operators the server runs in its own process could exhaust its heap: one Subdivide of a grid of
 * a million faces stopped the whole server (round 9). With a check installed (the server's), the
 * registry refuses an operator whose estimated peak heap does not fit, with code OUT_OF_MEMORY;
 * decoding a stored mesh and building a text surface ask the same kind of check. Without a check
 * (the browser, render processes) everything runs as before.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  setOperatorMemoryCheck(null);
  setMeshMemoryCheck(null);
  setGeometryMemoryCheck(null);
});

function gridScene(n: number, edit = true) {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx: OperatorContext = {
    doc,
    state,
    origin: { type: 'test' },
    source: 'test',
    report: () => undefined,
  };
  const meshId = doc.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n }));
  const id = doc.addObject({ type: 'MESH', name: 'Grid', data: meshId });
  state.selectedIds = [id];
  state.activeId = id;
  if (edit) {
    state.mode = 'EDIT';
    state.meshSelection = selectAllElements(doc.getMesh(meshId)!);
  }
  return { doc, reg, state, ctx, meshId, id };
}

/**
 * Runs operator `op` in a child process (--trace-gc; operator-memory-child.ts) on a grid of n × n
 * faces (none for 0), every element selected in Edit Mode: its estimate and the peak heap between
 * the marks around the run (bytes). The child's heap limit is 4 GB, above Node's default of about
 * 2 GB: V8 collects less often in a larger heap, and peaks measured in a heap of 1 GB came out up
 * to 38% lower.
 */
function peak(
  op: string,
  n: number,
  params: object,
  mode: 'edit' | 'object' | 'scatter' | 'import' | 'CURVE' | 'FONT',
) {
  const run = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--trace-gc',
      '--max-old-space-size=4096',
      '--import',
      'tsx',
      path.join(here, 'operator-memory-child.ts'),
      op,
      String(n),
      JSON.stringify(params),
      mode,
    ],
    { encoding: 'utf8', cwd: here, timeout: 25_000 },
  );
  const lines = run.stdout.split('\n');
  const start = lines.findIndex((l) => l.startsWith('#MARK before'));
  const end = lines.findIndex((l) => l.startsWith('#MARK done'));
  expect(start, run.stderr).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const base = Number(lines[start].split(' ')[2]);
  // the heap in use before each collection (MB) during the run, and at its end
  let max = Number(lines[end].split(' ')[2]);
  for (const l of lines.slice(start, end)) {
    const m = /([\d.]+) \([\d.]+\) -> [\d.]+ \([\d.]+\) MB/.exec(l);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const out = JSON.parse(lines.find((l) => l.startsWith('{'))!) as {
    ok: boolean;
    error?: string;
    estimate: { bytes: number; result?: { vertices: number } };
    glyphBytes?: number;
    vertices?: number;
  };
  expect(out.ok, out.error).toBe(true);
  return { peak: (max - base) * 1024 * 1024, estimate: out.estimate.bytes, out };
}

describe('operator memory estimates', () => {
  it('cover every registered operator: an estimate, or the reason it cannot grow the geometry much', () => {
    const missing = createOperatorRegistry()
      .list()
      .map((d) => d.id)
      .filter((id) => !OPERATOR_ESTIMATES[id] && !unestimatedReason(id));
    expect(missing).toEqual([]);
    // the operators that multiply geometry have estimates of their own
    for (const id of [
      'mesh.subdivide',
      'mesh.loopcut',
      'mesh.bevel',
      'mesh.spin',
      'mesh.extrude_region_move',
      'mesh.extrude_faces_move',
      'mesh.extrude_edges_move',
      'mesh.inset',
      'mesh.poke',
      'mesh.quads_convert_to_tris',
      'mesh.duplicate_move',
      'mesh.solidify',
      'mesh.bridge_edge_loops',
      'mesh.primitive_grid_add',
      'mesh.primitive_torus_add',
      'object.duplicate',
      'object.join',
      'object.convert',
      'object.modifier_apply',
      'object.generate_terrain',
      'object.generate_tree',
      'import_scene.gltf',
      'import_mesh.stl',
      'object.add_mesh_from_data',
    ])
      expect(OPERATOR_ESTIMATES[id], id).toBeTypeOf('function');
  });

  it('size the result from the parameters and the selection', () => {
    const { ctx, reg } = gridScene(20);
    const sub = (cuts: number) =>
      estimateOperator('mesh.subdivide', ctx, reg.parseParams('mesh.subdivide', { number_cuts: cuts }))!;
    // 400 quads, all selected: (c + 1)² faces each
    expect(sub(1).faces).toBe(1600);
    expect(sub(3).faces).toBe(6400);
    expect(sub(3).bytes).toBeGreaterThan(sub(1).bytes);
    // a loop cut across a grid crosses one row of 20 quads
    expect(estimateOperator('mesh.loopcut', ctx, { edge: [0, 1], number_cuts: 10 })!.faces).toBe(400 + 200);
    expect(primitiveFaces('GRID', { x_subdivisions: 1000, y_subdivisions: 1000 })).toBe(1_000_000);
    expect(primitiveFaces('ICO_SPHERE', { subdivisions: 8 })).toBe(327_680);
    expect(primitiveFaces('CYLINDER', { vertices: 10, end_fill_type: 'TRIFAN' })).toBe(30);
    // outside Edit Mode an Edit Mode operator has nothing to estimate (it fails its poll)
    ctx.state.mode = 'OBJECT';
    expect(estimateOperator('mesh.subdivide', ctx, { number_cuts: 1 })).toBeNull();
  });

  it('walk the edge ring of a loop cut without building the topology', () => {
    const g = createGrid({ x_subdivisions: 4, y_subdivisions: 3 });
    // the ring through the edge [0, 1] crosses the 3 quads of a column; [0, 5] the 4 of a row
    expect(edgeRingFaces(g.faces, g.positions.length / 3, 0, 1)).toBe(3);
    expect(edgeRingFaces(g.faces, g.positions.length / 3, 0, 5)).toBe(4);
    expect(edgeRingFaces(g.faces, g.positions.length / 3, 0, 7)).toBeNull();
  });

  it('let the installed check refuse an operator before it runs: code OUT_OF_MEMORY, nothing changed', () => {
    const { ctx, reg, doc, meshId } = gridScene(10);
    const asked: OperatorMemoryRequest[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req);
      return req.estimate.bytes > 100 * 1024 * 1024 ? `${req.operator} needs too much` : null;
    });
    const before = doc.meshCounts(meshId);
    const res = reg.run(ctx, 'mesh.subdivide', { number_cuts: 50 });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY', error: 'mesh.subdivide needs too much' });
    expect(doc.meshCounts(meshId)).toEqual(before);
    expect(asked[0]).toMatchObject({ operator: 'mesh.subdivide', estimate: { faces: 100 * 51 ** 2 } });
    expect(asked[0].storedBytes).toBeGreaterThan(0);
    // a small one runs; operators without an estimate are not asked about
    expect(reg.run(ctx, 'mesh.subdivide', { number_cuts: 1 }).ok).toBe(true);
    const n = asked.length;
    expect(reg.run(ctx, 'mesh.select_mode', { type: 'FACE' }).ok).toBe(true);
    ctx.state.mode = 'OBJECT';
    expect(reg.run(ctx, 'object.location_clear', {}).ok).toBe(true);
    expect(asked.slice(n).map((r) => r.operator)).toEqual(['mesh.select_mode']);
    // without a check, the same operator runs
    setOperatorMemoryCheck(null);
    ctx.state.mode = 'EDIT';
    ctx.state.meshSelection = selectAllElements(doc.getMesh(meshId)!);
    expect(reg.run(ctx, 'mesh.subdivide', { number_cuts: 3 }).ok).toBe(true);
  });

  it('keep each estimate above the peak heap the operator takes (V8 GC trace in a child process)', () => {
    for (const [op, n, params, mode] of [
      ['mesh.subdivide', 60, { number_cuts: 2 }, 'edit'],
      ['mesh.vertices_smooth', 120, {}, 'edit'],
      ['mesh.extrude_faces_move', 80, { value: 0.1 }, 'edit'],
      ['mesh.primitive_grid_add', 0, { x_subdivisions: 300, y_subdivisions: 300 }, 'object'],
    ] as const) {
      const r = peak(op, n, params, mode);
      expect(r.estimate, op).toBeGreaterThanOrEqual(r.peak);
      // and not far above it (the estimates are the largest measured per face, rounded up)
      expect(r.estimate, op).toBeLessThan(r.peak * 6);
    }
  }, 30_000);

  it('hold where the per-face costs and the young generation make up the peak', () => {
    // per face of the edited mesh (EDIT_BYTES_PER_FACE): 25,600 faces smoothed peak at about 89 MB;
    // per added face (ADDED_FACE_BYTES): two cuts add 51,200 faces (about 150 MB); a grid of 900
    // faces subdivided peaks at about 17 MB, mostly garbage of the young generation, which
    // OPERATOR_FIXED_BYTES covers
    for (const [op, n, params] of [
      ['mesh.vertices_smooth', 160, {}],
      ['mesh.subdivide', 80, { number_cuts: 2 }],
      ['mesh.subdivide', 30, { number_cuts: 1 }],
    ] as const) {
      const r = peak(op, n, params, 'edit');
      expect(r.estimate, `${op} ${n}`).toBeGreaterThanOrEqual(r.peak);
      expect(r.estimate, `${op} ${n}`).toBeLessThan(r.peak * 4);
    }
  }, 30_000);

  it('count the copies Spin keeps of every selected vertex for every step', () => {
    // 10,201 vertices in 12 steps: the 4,800 faces Spin adds take less than its copies
    const r = peak('mesh.spin', 100, { steps: 12 }, 'edit');
    expect(r.estimate).toBeGreaterThanOrEqual(r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 3);
  }, 30_000);

  it('estimate the exports run in the process by the instances they write', () => {
    // 30,000 instances of a plane: the instances cost more than their faces (glTF: about 70 MB at the
    // peak, of which the faces take 9 MB)
    for (const op of ['export_scene.gltf', 'export_mesh.ply'] as const) {
      const r = peak(op, 30_000, {}, 'scatter');
      expect(r.estimate, op).toBeGreaterThanOrEqual(r.peak);
      expect(r.estimate, op).toBeLessThan(r.peak * 3);
    }
  }, 30_000);

  it('estimate the exports run in the process by the faces they write', () => {
    // a grid of 90,000 faces as OBJ (text: about 145 MB at the peak) and as binary STL (about 90 MB)
    for (const op of ['export_scene.obj', 'export_mesh.stl'] as const) {
      const r = peak(op, 300, {}, 'object');
      expect(r.estimate, op).toBeGreaterThanOrEqual(r.peak);
      expect(r.estimate, op).toBeLessThan(r.peak * 3);
    }
  }, 30_000);

  it('estimate Edit Mode operators before Edit Mode is entered: at most what the registry asks with the selection', () => {
    const cases = [
      ['mesh.subdivide', { number_cuts: 2 }],
      ['mesh.bevel', { segments: 3 }],
      ['mesh.extrude_region_move', {}],
      ['mesh.spin', { steps: 8 }],
      ['mesh.inset', {}],
      ['mesh.vertices_smooth', {}],
      ['transform.translate', { value: [0, 0, 1] }],
    ] as const;
    for (const [op, params] of cases)
      for (const faces of [null, [0, 1, 2, 21, 22]] as const) {
        const { ctx, reg, doc, meshId, id } = gridScene(20, false);
        const asked: OperatorMemoryRequest[] = [];
        setOperatorMemoryCheck((req) => (asked.push(req), null));
        const sizes = faces ? { verts: 0, edges: 0, faces: faces.length } : ('all' as const);
        expect(editOperatorMemoryRefusal(ctx, op, reg.parseParams(op, params), id, sizes)).toBeNull();
        // nothing changed: the editor is still in Object Mode, nothing selected in the mesh
        expect(ctx.state.mode).toBe('OBJECT');
        // the registry, in Edit Mode with that selection
        ctx.state.mode = 'EDIT';
        const mesh = doc.getMesh(meshId)!;
        ctx.state.meshSelection = faces ? selectionFromFaces(mesh, [...faces]) : selectAllElements(mesh);
        expect(reg.run(ctx, op, params).ok, op).toBe(true);
        expect(asked.map((r) => r.operator)).toEqual([op, op]);
        const [early, real] = asked.map((r) => r.estimate);
        expect(early.bytes, `${op} ${faces ? 'some' : 'all'}`).toBeLessThanOrEqual(real.bytes);
        expect(early.faces, op).toBeLessThanOrEqual(real.faces);
      }
    // object-mode operators, and no check installed: nothing asked
    const { ctx, id } = gridScene(20, false);
    expect(editOperatorMemoryRefusal(ctx, 'object.shade_smooth', {}, id, 'all')).toBeNull();
    setOperatorMemoryCheck(() => 'refused');
    expect(editOperatorMemoryRefusal(ctx, 'object.shade_smooth', {}, id, 'all')).toBeNull();
    expect(editOperatorMemoryRefusal(ctx, 'mesh.subdivide', { number_cuts: 1 }, id, 'all')).toBe('refused');
  });

  it('size imports from the file: a binary STL by the triangles its header declares, others by their size', () => {
    // a binary STL of 1,000 triangles: an 84-byte header, then 50 bytes per triangle
    const stl = new Uint8Array(84 + 50 * 1000);
    new DataView(stl.buffer).setUint32(80, 1000, true);
    expect(binaryStlTriangles(stl, stl.byteLength)).toBe(1000);
    // a header that does not match the size is not a binary STL
    expect(binaryStlTriangles(stl, stl.byteLength + 1)).toBeNull();
    const stored = decodedMeshBytes({
      vertices: 3000,
      faces: 1000,
      corners: 3000,
      uvs: false,
      colors: false,
    });
    expect(importEstimate('stl', stl, stl.byteLength)).toEqual({
      bytes: OPERATOR_FIXED_BYTES + IMPORT_BYTES_PER_STL_TRIANGLE * 1000 + stored,
      faces: 1000,
      addedStoredBytes: stored,
      lower: 'the size of the file (import fewer or simpler meshes)',
    });
    // the operators read the same from base64, also from a data URI
    const { ctx } = gridScene(1, false);
    const b64 = Buffer.from(stl).toString('base64');
    for (const data_base64 of [b64, `data:model/stl;base64,${b64}`, `  ${b64}\n`])
      expect(estimateOperator('import_mesh.stl', ctx, { data_base64 })).toEqual(
        importEstimate('stl', stl, stl.byteLength),
      );
    // other formats, and STL files that are not binary, by their size
    const text = new TextEncoder().encode('solid x\n  facet normal 0 0 1\n'.repeat(100));
    for (const [format, data] of [
      ['stl', text],
      ['obj', text],
      ['glb', stl],
    ] as const)
      expect(importEstimate(format, data, data.byteLength), format).toMatchObject({
        bytes: OPERATOR_FIXED_BYTES + IMPORT_BYTES_PER_FILE_BYTE * data.byteLength,
        addedStoredBytes: IMPORT_STORED_BYTES_PER_FILE_BYTE * data.byteLength,
      });
    // tools that import without the registry (MCP import_model) ask the installed check the same
    const asked: OperatorMemoryRequest[] = [];
    expect(importMemoryRefusal(ctx.doc, 'stl', stl)).toBeNull();
    setOperatorMemoryCheck((req) => (asked.push(req), 'no room'));
    expect(importMemoryRefusal(ctx.doc, 'stl', stl)).toBe('no room');
    expect(asked[0]).toEqual({
      operator: 'import_mesh.stl',
      estimate: importEstimate('stl', stl, stl.byteLength),
      storedBytes: storedMeshBytes(ctx.doc),
    });
  });

  it('keep the import estimate of a binary STL above the peak heap of importing it (V8 GC trace in a child process)', () => {
    // 180,000 triangles (9 MB), imported from base64: about 120 MB at the peak
    const r = peak('import_mesh.stl', 300, {}, 'import');
    expect(r.estimate).toBeGreaterThanOrEqual(r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 3);
  }, 30_000);

  it('keep the import estimate of other files, by their size, above the peak heap of importing them', () => {
    // an OBJ of 90,000 quads with UVs (8 MB): about 110 MB at the peak
    const r = peak('import_scene.obj', 300, {}, 'import');
    expect(r.estimate).toBeGreaterThanOrEqual(r.peak);
    expect(r.estimate).toBeLessThan(r.peak * 4);
  }, 30_000);

  it('size generated objects from their parameters, above their peak heap', () => {
    // a tree of 197,474 faces and a fence of 133,906 faces (pickets 5 mm wide without gaps)
    for (const [op, params] of [
      ['object.generate_tree', { branch_levels: 4, branches: 5, resolution: 12, leaf_density: 1 }],
      ['object.generate_fence', { length: 100, post_spacing: 2, picket_width: 0.005, picket_gap: 0 }],
    ] as const) {
      const r = peak(op, 0, params, 'object');
      expect(r.estimate, op).toBeGreaterThanOrEqual(r.peak);
      expect(r.estimate, op).toBeLessThan(r.peak * 3);
    }
  }, 30_000);
});

describe('decoding stored meshes', () => {
  it('estimates the decoded heap of a mesh exactly (child process)', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        'tsx',
        path.join(here, 'operator-memory-child.ts'),
        'decode',
        '200',
        '{}',
        'object',
      ],
      { encoding: 'utf8', cwd: here, timeout: 20_000 },
    );
    const out = JSON.parse(run.stdout.split('\n').find((l) => l.startsWith('{'))!) as {
      measured: number;
      estimate: number;
    };
    expect(Math.abs(out.estimate - out.measured) / out.measured).toBeLessThan(0.02);
  });

  it('refuses a mesh the installed check does not decode: the evaluation says why, operators fail with OUT_OF_MEMORY', () => {
    const { doc, reg, ctx, id } = gridScene(10, false);
    // a fresh document from the same state: its meshes are not decoded yet
    const copy = SceneDoc.fromUpdate(doc.encodeState());
    setMeshMemoryCheck(({ layout }) => (layout.faces > 50 ? 'not loaded: too large' : null));
    const meshId = copy.getObject(id)!.data!;
    expect(() => copy.getMesh(meshId)).toThrow(MeshMemoryError);
    const ev = new SceneEvaluator(copy).evaluate(1);
    expect(ev.byId.get(id)!.mesh).toBeUndefined();
    expect(ev.errors).toContainEqual({ source: `mesh:${id}`, message: 'not loaded: too large' });
    const res = reg.run({ ...ctx, doc: copy }, 'object.shade_smooth', {});
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY', error: 'not loaded: too large' });
    // without the check it decodes
    setMeshMemoryCheck(null);
    expect(copy.getMesh(meshId)!.faces.length).toBe(100);
  });

  it('skips the surface of a text the installed check refuses, as an evaluation problem', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const state = createEditorState();
    const ctx: OperatorContext = { doc, state, origin: {}, source: 'test', report: () => undefined };
    expect(reg.run(ctx, 'object.text_add', { body: 'Hello world' }).ok).toBe(true);
    const id = state.activeId!;
    const asked: GeometryMemoryRequest[] = [];
    setGeometryMemoryCheck((req) => {
      asked.push(req);
      return req.type === 'TEXT' ? `${req.estimate.result.faces} faces: no` : null;
    });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(ev.byId.get(id)!.mesh).toBeUndefined();
    // the glyph outlines of its 10 characters filled, at least the 10 characters' measured cost
    const curve = doc.getCurve(doc.getObject(id)!.data!)!;
    const e = estimateCurveSurface(curve, { isText: true, forRender: false });
    expect(ev.errors).toContainEqual({ source: `curve:${id}`, message: `${e.result.faces} faces: no` });
    expect(asked[0]).toMatchObject({ type: 'TEXT', label: 'text surface' });
    expect(asked[0].estimate.bytes).toBe(Math.max(e.bytes, 10 * TEXT_BYTES_PER_CHARACTER));
    expect(asked[0].estimate.lower).toBe('the length of the text or resolution_u');
    setGeometryMemoryCheck(null);
    const built = new SceneEvaluator(doc).evaluate(1).byId.get(id)!.mesh!;
    expect(built.faces.length).toBeGreaterThan(0);
    expect(built.faces.length).toBeLessThanOrEqual(e.result.faces);
  });
});

/** An empty scene with a registry and an editor state, for running operators. */
function scene() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const state = createEditorState();
  const ctx: OperatorContext = {
    doc,
    state,
    origin: { type: 'test' },
    source: 'test',
    report: () => undefined,
  };
  const run = (id: string, params: Record<string, unknown> = {}) => {
    const r = reg.run(ctx, id, params);
    expect(r.ok, `${id}: ${r.error}`).toBe(true);
    return r;
  };
  const estimate = (id: string, params: Record<string, unknown> = {}) =>
    estimateOperator(id, ctx, reg.parseParams(id, params));
  return { doc, reg, state, ctx, run, estimate };
}

describe('linked duplicates', () => {
  /** A grid of 400 faces and 4 linked duplicates of it (one mesh for 5 objects), all selected. */
  function linked() {
    const s = scene();
    s.run('mesh.primitive_grid_add', { x_subdivisions: 20, y_subdivisions: 20 });
    const grid = s.state.activeId!;
    s.run('object.array_place', { objects: [grid], count: 5, linked: true });
    s.state.selectedIds = s.doc.listObjects().map((o) => o.id);
    s.state.activeId = grid;
    expect(s.doc.listMeshBlocks()).toHaveLength(1);
    return { ...s, one: storedMeshBytes(s.doc) };
  }

  it('count every object an operator gives a mesh of its own, and the meshes the project then holds', () => {
    const { doc, run, estimate, one } = linked();
    // Join appends a copy of every object's mesh: 5 × 400 faces, which replace the shared mesh
    const join = estimate('object.join')!;
    expect(join.faces).toBe(2000);
    const five = decodedMeshBytes({
      vertices: 5 * 441,
      faces: 2000,
      corners: 8000,
      uvs: true,
      colors: false,
    });
    expect(join.addedStoredBytes).toBe(five - one);
    // Apply Transform and Set Origin give each object but the last one a copy of the mesh first
    for (const id of ['object.transform_apply', 'object.origin_set']) {
      const e = estimate(id, id === 'object.transform_apply' ? { location: true } : {})!;
      expect(e.faces, id).toBe(2000);
      expect(e.addedStoredBytes, id).toBe(4 * one);
    }
    // shading changes the shared mesh once, Duplicate copies it once
    expect(estimate('object.shade_smooth')).toMatchObject({ faces: 400, addedStoredBytes: 0 });
    expect(estimate('object.duplicate')).toMatchObject({ faces: 400, addedStoredBytes: one });
    // what the project holds afterwards
    const before = storedMeshBytes(doc);
    const apply = estimate('object.transform_apply', { location: true })!;
    run('object.transform_apply', { location: true });
    expect(doc.listMeshBlocks()).toHaveLength(5);
    expect(storedMeshBytes(doc) - before).toBe(apply.addedStoredBytes);
  });

  it('let the check refuse a join of linked duplicates before anything changes', () => {
    const { doc, reg, ctx, one } = linked();
    // a project of one mesh that the join would make five times as large
    setOperatorMemoryCheck((req) =>
      req.storedBytes + req.estimate.addedStoredBytes > 3 * one ? 'too many meshes' : null,
    );
    expect(reg.run(ctx, 'object.join', {})).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(doc.listObjects()).toHaveLength(5);
    expect(doc.listMeshBlocks()).toHaveLength(1);
    // a linked duplicate outside the selection keeps the shared mesh: the join frees nothing
    ctx.state.selectedIds = ctx.state.selectedIds.slice(0, 2);
    const two = estimateOperator('object.join', ctx, {})!;
    expect(two.addedStoredBytes).toBe(
      decodedMeshBytes({ vertices: 882, faces: 800, corners: 3200, uvs: true, colors: false }),
    );
  });

  it('count every linked duplicate Convert bakes into a mesh of its own', () => {
    const { doc, run, estimate, state } = linked();
    const all = state.selectedIds.slice();
    for (const id of all) {
      state.selectedIds = [id];
      state.activeId = id;
      run('object.modifier_add', { type: 'SUBSURF', params: { levels: 1 } });
    }
    const one = estimate('object.convert', { target: 'MESH' })!;
    state.selectedIds = all;
    const five = estimate('object.convert', { target: 'MESH' })!;
    expect(five.faces).toBe(5 * one.faces);
    expect(five.addedStoredBytes).toBe(5 * one.addedStoredBytes);
    const before = storedMeshBytes(doc);
    run('object.convert', { target: 'MESH' });
    expect(doc.listMeshBlocks()).toHaveLength(5);
    expect(storedMeshBytes(doc) - before).toBeLessThanOrEqual(five.addedStoredBytes);
  });
});

describe('curve and text surfaces', () => {
  it('are estimated at least as large as what the evaluation builds (random curves and texts)', () => {
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
    const point = () => ({
      co: [rnd() * 4, rnd() * 4, rnd() < 0.5 ? 0 : rnd()],
      handle_left: null,
      handle_right: null,
      handle_left_type: pick(['AUTO', 'VECTOR', 'ALIGNED', 'FREE']),
      handle_right_type: pick(['AUTO', 'VECTOR']),
      radius: rnd() < 0.1 ? 0 : 0.2 + rnd(),
      tilt: rnd(),
      weight: 1,
    });
    for (let k = 0; k < 150; k++) {
      const doc = SceneDoc.create({ empty: true });
      const isText = rnd() < 0.25;
      const splines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
        type: pick(['BEZIER', 'POLY', 'NURBS']),
        points: Array.from({ length: 1 + Math.floor(rnd() * 12) }, point),
        use_cyclic_u: rnd() < 0.5,
        resolution_u: rnd() < 0.3 ? Math.floor(rnd() * 20) : 0,
        order_u: 2 + Math.floor(rnd() * 4),
        use_endpoint_u: rnd() < 0.5,
        use_smooth: rnd() < 0.7,
        material_index: 0,
      }));
      const data: Record<string, unknown> = {
        dimensions: rnd() < 0.5 ? '2D' : '3D',
        splines,
        resolution_u: 1 + Math.floor(rnd() * 24),
        render_resolution_u: rnd() < 0.3 ? Math.floor(rnd() * 30) : 0,
        bevel_depth: rnd() < 0.6 ? rnd() * 0.2 : 0,
        bevel_resolution: Math.floor(rnd() * 10),
        extrude: rnd() < 0.4 ? rnd() * 0.3 : 0,
        fill_mode: pick(['FULL', 'BACK', 'FRONT', 'HALF', 'NONE', 'BOTH']),
        use_fill_caps: rnd() < 0.3,
        bevel_factor_start: rnd() < 0.3 ? rnd() * 0.5 : 0,
        bevel_factor_end: rnd() < 0.3 ? 0.5 + rnd() * 0.5 : 1,
      };
      if (isText)
        data.body = Array.from({ length: Math.floor(rnd() * 30) }, () => pick([...'AbgQ0%& ?é@\n\tW'])).join(
          '',
        );
      let bevelCurve = null;
      if (!isText && rnd() < 0.2) {
        const profile = doc.addCurve({
          splines: [splines[0]] as never,
          resolution_u: 1 + Math.floor(rnd() * 8),
        });
        data.bevel_mode = 'OBJECT';
        data.bevel_object = doc.addObject({ type: 'CURVE', name: 'Profile', data: profile });
        bevelCurve = doc.getCurve(profile);
      }
      const id = doc.addCurve(data as never);
      doc.addObject({ type: isText ? 'FONT' : 'CURVE', name: 'Curve', data: id });
      for (const forRender of [false, true]) {
        const e = estimateCurveSurface(doc.getCurve(id)!, { isText, forRender, bevelCurve });
        const mesh = new SceneEvaluator(doc)
          .evaluate(1, { forRender })
          .objects.find((o) => o.name === 'Curve')!.mesh;
        const corners = mesh ? mesh.faces.reduce((a, f) => a + f.length, 0) : 0;
        const what = `${k} ${forRender ? 'render' : 'viewport'}`;
        expect(e.result.vertices, what).toBeGreaterThanOrEqual(mesh ? mesh.positions.length / 3 : 0);
        expect(e.result.faces, what).toBeGreaterThanOrEqual(mesh ? mesh.faces.length : 0);
        expect(e.result.corners, what).toBeGreaterThanOrEqual(corners);
      }
    }
    // a text filled flat whose glyphs have holes: bridging each hole into its outline takes more
    // triangles than the outline has points (sample 352 of a longer run of this loop: 10,771
    // corners from 3,589 outline points)
    const doc = SceneDoc.create({ empty: true });
    const id = doc.addCurve({
      dimensions: '2D',
      body: '&@@ \t@&@\t\t0Q\né 0é%0é',
      resolution_u: 21,
      fill_mode: 'FULL',
    } as never);
    doc.addObject({ type: 'FONT', name: 'Text', data: id });
    const e = estimateCurveSurface(doc.getCurve(id)!, { isText: true, forRender: false });
    const mesh = new SceneEvaluator(doc).evaluate(1).objects[0].mesh!;
    expect(e.samples).toBe(3589);
    expect(mesh.faces.reduce((a, f) => a + f.length, 0)).toBe(10_771);
    expect(e.result.corners).toBeGreaterThanOrEqual(10_771);
    expect(e.result.faces).toBeGreaterThanOrEqual(mesh.faces.length);
  });

  it('are estimated above the peak heap of building them (V8 GC trace in a child process)', () => {
    // a smooth tube of 458,532 vertices (round bevel), a POLY zigzag of 400,000 that turns sharply at
    // every point (its edges sharp: the most per vertex), a text of 2,000 characters filled flat, the
    // wire of 249,876 samples of a curve without a surface, and a tube of 10,512 vertices, whose peak
    // is mostly garbage of the young generation (CURVE_FIXED_BYTES)
    for (const [params, type] of [
      [{ __wave: 200, resolution_u: 64, bevel_depth: 0.05, bevel_resolution: 16 }, 'CURVE'],
      [{ __zigzag: 20000, bevel_depth: 0.02, bevel_resolution: 8 }, 'CURVE'],
      [{ __text: 2000, fill_mode: 'BOTH' }, 'FONT'],
      [{ __wave: 2000, resolution_u: 125 }, 'CURVE'],
      [{ __wave: 30, resolution_u: 24, bevel_depth: 0.05, bevel_resolution: 4 }, 'CURVE'],
    ] as const) {
      const r = peak('curve', 0, params, type);
      const what = JSON.stringify(params);
      expect(r.estimate, what).toBeGreaterThanOrEqual(r.peak);
      expect(r.estimate, what).toBeLessThan(r.peak * 3);
      expect(r.out.estimate.result!.vertices, what).toBeGreaterThanOrEqual(r.out.vertices!);
    }
  }, 30_000);

  it('cost at most TEXT_BYTES_PER_CHARACTER per glyph for a text filled flat (what browser editors count)', () => {
    // 6,000 characters, 4,909 glyphs: about 260 MB at the peak
    const r = peak('curve', 0, { __text: 6000, fill_mode: 'BOTH' }, 'FONT');
    expect(r.out.glyphBytes).toBeGreaterThanOrEqual(r.peak);
    expect(r.out.glyphBytes).toBeLessThan(r.peak * 2);
  }, 30_000);

  it('skip a curve surface the installed check refuses, its wire too, and build it when it fits', () => {
    const { doc, run, state } = scene();
    const points = Array.from({ length: 40 }, (_, i) => [i * 0.1, Math.sin(i), 0]);
    run('curve.add_from_points', { points, resolution_u: 24, bevel_depth: 0.05, bevel_resolution: 4 });
    const id = state.activeId!;
    const asked: GeometryMemoryRequest[] = [];
    setGeometryMemoryCheck((req) => {
      asked.push(req);
      return req.type === 'CURVE'
        ? `${req.label}: ${req.estimate.result.faces} faces, lower ${req.estimate.lower}`
        : null;
    });
    const ev = new SceneEvaluator(doc).evaluate(1);
    const e = estimateCurveSurface(doc.getCurve(doc.getObject(id)!.data!)!, {
      isText: false,
      forRender: false,
    });
    expect(ev.byId.get(id)!.mesh).toBeUndefined();
    expect(ev.byId.get(id)!.lines).toBeUndefined();
    expect(ev.errors).toContainEqual({
      source: `curve:${id}`,
      message: `curve surface: ${e.result.faces} faces, lower resolution_u, bevel_resolution or the number of spline points`,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].estimate.bytes).toBe(e.bytes);
    // Convert refuses it rather than baking its wire
    const res = createOperatorRegistry().run(
      { doc, state, origin: { type: 'test' }, source: 'test', report: () => undefined },
      'object.convert',
      { target: 'MESH' },
    );
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(doc.getObject(id)!.type).toBe('CURVE');
    setGeometryMemoryCheck(null);
    const built = new SceneEvaluator(doc).evaluate(1).byId.get(id)!.mesh!;
    expect(built.faces.length).toBeGreaterThan(0);
    expect(built.faces.length).toBeLessThanOrEqual(e.result.faces);
  });

  it('size object.convert of a curve by its surface and a copy of it', () => {
    const { run, state, estimate } = scene();
    const points = Array.from({ length: 330 }, (_, i) => [i * 0.1, Math.sin(0.3 * i), Math.cos(0.2 * i)]);
    // the verifier's curve: 2,863,684 vertices, which took the server down when converted
    run('curve.add_from_points', {
      points,
      type: 'BEZIER',
      resolution_u: 128,
      bevel_depth: 0.05,
      bevel_resolution: 32,
    });
    expect(state.activeId).toBeTruthy();
    const e = estimate('object.convert', { target: 'MESH' })!;
    expect(e.faces).toBeGreaterThanOrEqual(2_863_616);
    // building it (about 0.8 GB at the peak), a copy and the stored mesh: more than 2 GB
    expect(e.bytes).toBeGreaterThan(2 * 1024 ** 3);
    expect(e.lower).toBe('resolution_u, bevel_resolution or the number of spline points');
    // text to 2D curves builds no mesh
    expect(estimate('object.convert', { target: 'CURVE' })).toBeNull();
  });
});

describe('exports run in the process', () => {
  it('count the particle and collection instances they write, each as a mesh of its own', () => {
    const { run, estimate, doc } = scene();
    run('mesh.primitive_plane_add', { size: 20, name: 'Ground' });
    run('mesh.primitive_ico_sphere_add', {
      subdivisions: 2,
      radius: 0.1,
      location: [0, 0, 5],
      name: 'Pebble',
    });
    run('object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count: 300 });
    // the ground and the 300 instances of 80 faces (scatter_add hides the pebble itself in renders)
    expect(doc.resolveObject('Pebble')!.hide_render).toBe(true);
    const obj = estimate('export_scene.obj')!;
    expect(obj.faces).toBe(1 + 300 * 80);
    expect(obj.lower).toMatch(/^the faces of the exported meshes and instances \(/);
    const instances = new SceneEvaluator(doc).evaluate(1, { forRender: true }).instances.length;
    expect(instances).toBeLessThanOrEqual(300);
    // an empty instancing a collection of the two: the ground with its instances and the pebble
    const coll = doc.addCollection({ name: 'Set' });
    for (const o of doc.listObjects()) doc.updateObject(o.id, { collection: coll });
    run('object.collection_instance_add', { collection: coll });
    expect(estimate('export_scene.obj')!.faces).toBe(1 + 300 * 80 + (1 + 300 * 80 + 80));
  });

  it('count curve and text surfaces', () => {
    const { run, estimate } = scene();
    run('object.text_add', { body: 'Hello' });
    expect(estimate('export_mesh.stl')!.faces).toBeGreaterThan(0);
  });

  it("count what the scene's new evaluation keeps of objects they do not write (Convert too)", () => {
    const { run, estimate, state } = scene();
    run('mesh.primitive_grid_add', { x_subdivisions: 20, y_subdivisions: 20 });
    const grid = state.activeId!;
    run('object.text_add', { body: 'Hi' });
    const text = state.activeId!;
    const exported = () => estimate('export_scene.obj', { use_selection: true })!;
    const converted = () => estimate('object.convert', { target: 'MESH' })!;
    const before = { exported: exported(), converted: converted() };
    state.selectedIds = [grid];
    state.activeId = grid;
    run('object.modifier_add', { type: 'SUBSURF', params: { levels: 3, render_levels: 3 } });
    state.selectedIds = [text];
    state.activeId = text;
    // only the text is written or converted, but the evaluation subdivides the grid too
    const subdivided = decodedMeshBytes({
      vertices: 161 * 161,
      faces: 25_600,
      corners: 102_400,
      uvs: true,
      colors: false,
    });
    for (const [what, e] of [
      ['exported', exported()],
      ['converted', converted()],
    ] as const) {
      expect(e.faces, what).toBe(before[what].faces);
      expect(e.bytes - before[what].bytes, what).toBeGreaterThanOrEqual(subdivided);
    }
  });
});

describe('copies of array_place and scatter_on_surface', () => {
  it('count the meshes the project then holds when they are not linked', () => {
    const { run, estimate, state, doc } = scene();
    run('mesh.primitive_grid_add', { x_subdivisions: 20, y_subdivisions: 20, name: 'Grid' });
    const one = storedMeshBytes(doc);
    expect(
      estimate('object.array_place', { objects: ['Grid'], count: 5, linked: false })!.addedStoredBytes,
    ).toBe(4 * one);
    expect(estimate('object.array_place', { objects: ['Grid'], count: 5 })).toBeNull();
    expect(
      estimate('object.array_place', {
        objects: ['Grid'],
        pattern: 'GRID',
        columns: 3,
        rows: 2,
        linked: false,
      })!,
    ).toMatchObject({ addedStoredBytes: 5 * one, lower: 'columns and rows (or pass linked: true)' });
    run('mesh.primitive_plane_add', { size: 10, name: 'Ground' });
    state.selectedIds = [doc.resolveObject('Grid')!.id];
    expect(
      estimate('object.scatter_on_surface', { surface: 'Ground', count: 7, linked: false })!.addedStoredBytes,
    ).toBe(7 * one);
  });
});

describe('countEdges', () => {
  const byKey = (m: MeshData) => {
    const set = new Set<string>();
    for (const f of m.faces) for (let i = 0; i < f.length; i++) set.add(edgeKey(f[i], f[(i + 1) % f.length]));
    for (let i = 0; i < m.looseEdges.length; i += 2) set.add(edgeKey(m.looseEdges[i], m.looseEdges[i + 1]));
    return set.size;
  };

  it('counts the distinct edges like a set of edge keys, also of degenerate and odd meshes', () => {
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const meshes: MeshData[] = [createGrid({ x_subdivisions: 30, y_subdivisions: 20 })];
    for (let k = 0; k < 200; k++) {
      const V = 1 + Math.floor(rnd() * 30);
      meshes.push(
        createMesh({
          positions: new Array(V * 3).fill(0),
          faces: Array.from({ length: Math.floor(rnd() * 20) }, () =>
            Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * V)),
          ),
          looseEdges: Array.from({ length: 2 * Math.floor(rnd() * 5) }, () => Math.floor(rnd() * V)),
        }),
      );
    }
    // indices that are not small whole numbers fall back to the keys
    meshes.push(createMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1.5, 2]] }));
    meshes.push(createMesh({}));
    for (const m of meshes) expect(countEdges(m)).toBe(byKey(m));
  });
});
