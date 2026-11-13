import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  bevelCount,
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
  setSimulationMemoryCheck,
  simulationMemoryCheck,
  storedMeshBytes,
  projectStoredBytes,
  importMemoryRefusal,
  OBJECT_STORED_BYTES,
  DATABLOCK_STORED_BYTES,
  OBJECT_JSON_STORED_BYTES,
  extraJsonChars,
  SAVE_BYTES_PER_KEPT_BYTE,
  projectObjects,
  saveBytes,
  type OperatorContext,
} from '@3d-editor/core';
import {
  GC_MIN_INTERVAL_MS,
  checkMainThreadRender,
  collectGarbage,
  decodeCheck,
  estimateRenderMemory,
  geometryCheck,
  installGeometryMemoryGuard,
  maxProjectMeshBytes,
  meshJsonChars,
  operatorCheck,
  refusedDecodeMessage,
  refusedOperatorMessage,
  refusedSimulationMessage,
  serverHeapReserve,
  skippedModifierMessage,
  snapshotMeshChars,
  snapshotRefusal,
  storedMeshesMessage,
  throttledGarbageCollector,
} from '../../src/render/memory';
import { describeObject, summarizeScene } from '../../src/mcp/scene-summary';
import { meshData } from '../../src/mcp/mesh-data';

/*
 * The operators of MCP tools and the REST API run in the server's own process, whose JavaScript
 * heap every connection and project shares; V8 ends the whole process when it runs out. The
 * server refuses an operator whose estimated peak heap does not fit into the free heap less what it
 * keeps (a quarter of the heap, at least 256 MB: 256 MB of the heap of 1,024 MB most tests here
 * give it), one that would leave more decoded meshes in a project than half of the heap less that,
 * and the decoding of a stored mesh that does not fit (get_scene then lists the stored counts). The
 * heap is injected here (the real checks read V8's heap statistics).
 */

const MB = 1024 * 1024;

afterEach(() => {
  setOperatorMemoryCheck(null);
  setMeshMemoryCheck(null);
  setGeometryMemoryCheck(null);
  setSimulationMemoryCheck(null);
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
      operatorCheck({ heapFree: () => 400 * MB, collect: () => collected++, heapLimit: () => 1024 * MB }),
    );
    // 4 cuts: 62,500 faces, about 260 MB at its peak, of which 144 MB fit above the reserve
    const res = run('mesh.subdivide', { number_cuts: 4 });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    const need = estimateOperator('mesh.subdivide', ctx, { number_cuts: 4 })!;
    expect(need.faces).toBe(62_500);
    expect(res.error).toBe(
      `not run on the server: it would need about ${Math.round(need.bytes / MB).toLocaleString('en-US')} MB of ` +
        "JavaScript heap for a mesh of about 62,500 faces, and the server's process has 400 MB of its 1,024 MB " +
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
      operatorCheck({ heapFree: () => 270 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
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
        "about 10,000 faces, and the server's process has 270 MB of its 1,024 MB heap free and keeps 256 MB of it " +
        'for its other work. Lower the number of faces of the mesh to run it on the server (a browser editor runs ' +
        'it in its own memory)',
    });
    expect(ctx.state.mode).toBe('OBJECT');
    expect(run('object.mode_set', { mode: 'EDIT' })).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    // with room for it
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 400 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
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
    // two grids of 40,000 faces take about 10 MB each decoded (and their objects about 14 KB each): a
    // third does not fit
    const before = projectStoredBytes(doc);
    expect(before).toBe(storedMeshBytes(doc) + 2 * (OBJECT_STORED_BYTES + DATABLOCK_STORED_BYTES.meshes));
    const added = estimateOperator('mesh.primitive_grid_add', ctx, grid)!.addedStoredBytes;
    expect(before).toBeLessThan(22 * MB);
    expect(before + added).toBeGreaterThan(22 * MB);
    const res = run('mesh.primitive_grid_add', { ...grid, location: [6, 0, 0] });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    const mb = (bytes: number) => Math.round(bytes / MB);
    // needs rounded up (the limit rounded down): a refused need never shows as the limit; a save of
    // the project takes three times what its 3 objects and their meshes' datablocks keep (126 KB)
    const up = (bytes: number) => Math.ceil(bytes / MB);
    const save = saveBytes(3 * (OBJECT_STORED_BYTES + DATABLOCK_STORED_BYTES.meshes));
    expect(save).toBe(126_000);
    expect(res.error).toBe(
      `not run on the server: the project's meshes, objects, keyframes and images would then take about ${up(before + added)} MB of ` +
        `memory (now ${mb(before)} MB with 2 objects), and a save of it about 1 MB more for a moment ` +
        `(3 times what its objects, datablocks and keyframes take, 5 times its images): ${up(before + added) + 1} MB in all, more than ` +
        "the 22 MB the server's process keeps for one project (half of its 300 MB heap less the 256 MB it keeps " +
        'for its other work). Lower x_subdivisions and y_subdivisions, or delete objects and meshes the project no ' +
        'longer needs',
    );
    expect(doc.listObjects()).toHaveLength(2);
    // operators that add nothing still run
    expect(run('object.shade_smooth').ok).toBe(true);
    // a project already past it (grown in a browser editor, or with a smaller heap): a cube or an
    // empty adds next to nothing, but adds; there is nothing of them to lower, only objects to delete
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => 0, heapLimit: () => 290 * MB }),
    );
    const past =
      `not run on the server: the project's meshes, objects, keyframes and images already take about ${up(before)} MB of memory ` +
      `with 2 objects, and a save of it about 1 MB more for a moment (3 times what its objects, datablocks ` +
      `and keyframes take, 5 times its images): ${up(before) + 1} MB in all, more than the 17 MB the server's process keeps for one ` +
      'project (half of its 290 MB heap less the 256 MB it keeps for its other work), and this operator would ' +
      'add to them. Delete objects and meshes the project no longer needs';
    for (const op of ['mesh.primitive_cube_add', 'object.empty_add']) {
      const res = run(op, { location: [9, 0, 0] });
      expect(res, op).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY', error: past });
    }
    // within it before, past it after, nothing to lower: only objects to delete
    expect(
      storedMeshesMessage(
        {
          operator: 'x',
          storedBytes: 10 * MB,
          estimate: { bytes: 0, faces: 0, addedStoredBytes: 20 * MB, lower: '' },
        },
        300 * MB,
      ),
    ).toBe(
      "not run on the server: the project's meshes, objects, keyframes and images would then take about 30 MB of memory " +
        "(now 10 MB), more than the 22 MB the server's process keeps for one project (half of its 300 MB heap " +
        'less the 256 MB it keeps for its other work). Delete objects and meshes the project no longer needs',
    );
  });

  // eight generators build their meshes: 1.8 s under coverage instrumentation
  it(
    'run the generators at their defaults on a server with a 1 GB heap (estimated from their parameters)',
    { timeout: 15_000 },
    () => {
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
    },
  );

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
        'process has 400 MB of its 1,072 MB heap free and keeps 268 MB of it for its other work. Lower ' +
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
      operatorCheck({ heapFree: () => 350 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    const res = run('object.convert', { target: 'MESH' });
    expect(res).toMatchObject({ ok: false, code: 'FAILED' });
    expect(res.error).toMatch(
      /^Cannot convert 'Grid': modifier 'Subdivision': Subdivision result too large \(~92160000 faces\); lower the levels\. Nothing was converted/,
    );
    expect(doc.getObject(ctx.state.activeId!)!.modifiers).toHaveLength(1);
  });
});

describe('imports and operators that add objects', () => {
  it('say how a browser editor runs a refused import: editor_command run_operator with the file in base64', () => {
    const { doc, run } = project();
    setOperatorMemoryCheck(operatorCheck({ heapFree: () => 300 * MB, heapLimit: () => 1024 * MB }));
    // a binary STL that declares 400,000 triangles
    const stl = new Uint8Array(84 + 50 * 400_000);
    new DataView(stl.buffer).setUint32(80, 400_000, true);
    const browser = (operator: string) =>
      `(a browser editor runs it in its own memory: editor_command {command: 'run_operator', params: ` +
      `{operator: '${operator}', params: {data_base64}}})`;
    const res = run('import_mesh.stl', { data_base64: Buffer.from(stl).toString('base64') });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toMatch(
      /^not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 400,000 faces, and the server's process has 300 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work\. Lower the size of the file \(import fewer or simpler meshes\) to run it on the server /,
    );
    expect(res.error!.endsWith(browser('import_mesh.stl'))).toBe(true);
    // MCP import_model asks the same check, named after the import operator of the file's format
    for (const [format, operator] of [
      ['stl', 'import_mesh.stl'],
      ['glb', 'import_scene.gltf'],
    ] as const)
      expect(importMemoryRefusal(doc, format, stl)?.endsWith(browser(operator)), format).toBe(true);
    // other operators: the browser editor without a command
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 1000, y_subdivisions: 1000 }).error).toMatch(
      /to run it on the server \(a browser editor runs it in its own memory\)$/,
    );
  });

  it('name the objects an operator would add in its refusal', () => {
    const { ctx, run } = project();
    expect(run('mesh.primitive_cube_add', {}).ok).toBe(true);
    ctx.state.selectedIds = [ctx.state.activeId!];
    // 2,999 linked copies: about 13 KB each at the peak (69 MB with the young generation's 32 MB, more
    // than the 44 MB free above the reserve), 11 KB each kept (and 33 KB more each while the project is
    // saved: 126 MB in all, within the 384 MB a heap of 1,024 MB keeps for one project)
    setOperatorMemoryCheck(operatorCheck({ heapFree: () => 300 * MB, heapLimit: () => 1024 * MB }));
    const res = run('object.array_place', { count: 3_000, linked: true });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toMatch(
      /^not run on the server: it would need about [\d,]+ MB of JavaScript heap for 2,999 new objects, and the server's process has 300 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work\. Lower count to run it on the server \(a browser editor runs it in its own memory\)$/,
    );
    expect(ctx.doc.objectIds()).toHaveLength(1);
  });

  it('round what a refused project would take up and the limit down, so that the first is the larger', () => {
    const refused = (limitMb: number, storedBytes: number, added: number) =>
      storedMeshesMessage(
        {
          operator: 'x',
          storedBytes,
          estimate: { bytes: 0, faces: 0, addedStoredBytes: added, lower: 'count' },
        },
        limitMb * MB,
      );
    // a heap of 2,098 MB keeps (2,098 - 524.5) / 2 = 786.75 MB for one project: 786 MB, rounded down
    expect(maxProjectMeshBytes(2098 * MB)).toBe(786.75 * MB);
    // 786.8 MB: about 787 MB, more than the 786 MB (rounded to the nearest, both were 787)
    expect(refused(2098, 786.5 * MB, 0.3 * MB)).toMatch(
      /would then take about 787 MB of memory \(now 787 MB\), more than the 786 MB the server's process keeps/,
    );
    expect(refused(2098, 786.75 * MB + 1, 1)).toMatch(/already take about 787 MB .* more than the 786 MB /);
    // a heap of 2,097 MB keeps 786.375 MB: 786.4 MB is about 787 MB, rounded up (to the nearest, 786)
    expect(maxProjectMeshBytes(2097 * MB)).toBe(786.375 * MB);
    expect(refused(2097, 700 * MB, 86.4 * MB)).toMatch(
      /would then take about 787 MB .* more than the 786 MB /,
    );
    expect(refused(2097, 786.4 * MB, 1)).toMatch(/already take about 787 MB .* more than the 786 MB /);
  });

  it('refuse objects whose save the server could not hold, also with its heap free', () => {
    // the server saves a project after every change (core storage/project-store.ts syncDocument): the
    // save decodes the whole stored state three times, about three times what the project's objects
    // keep, and saves of 70,000 linked cubes, which the limit per project allowed by what they keep,
    // ended a server of Node's default heap. 9,999 linked copies keep 105 MB, within the 384 MB a heap
    // of 1,024 MB keeps for one project, but a save of them takes 315 MB more for a moment
    const { doc, ctx, run } = project();
    expect(run('mesh.primitive_cube_add', {}).ok).toBe(true);
    ctx.state.selectedIds = [ctx.state.activeId!];
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    const params = { count: 10_000, linked: true };
    const e = estimateOperator('object.array_place', ctx, params)!;
    expect(e.addedStoredBytes).toBe(9_999 * OBJECT_STORED_BYTES);
    expect(e.addedSaveBytes).toBe(SAVE_BYTES_PER_KEPT_BYTE * 9_999 * OBJECT_STORED_BYTES);
    const before = projectStoredBytes(doc);
    const kept = before + e.addedStoredBytes;
    const save = saveBytes(projectObjects(doc).bytes) + e.addedSaveBytes!;
    expect(kept).toBeLessThan(maxProjectMeshBytes(1024 * MB));
    expect(kept + save).toBeGreaterThan(maxProjectMeshBytes(1024 * MB));
    const res = run('object.array_place', params);
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    const up = (bytes: number) => Math.ceil(bytes / MB);
    expect([up(kept), up(save)]).toEqual([105, 315]);
    expect(res.error).toBe(
      "not run on the server: the project's meshes, objects, keyframes and images would then take about 105 MB of memory " +
        'with 9,999 new objects (now 0 MB with 1 object), and a save of it about 315 MB more for a moment (3 times ' +
        "what its objects, datablocks and keyframes take, 5 times its images): 420 MB in all, more than the 384 MB the server's " +
        'process keeps for one project (half of its 1,024 MB heap less the 256 MB it keeps for its other work). ' +
        'Lower count, or delete objects and meshes the project no longer needs',
    );
    expect(doc.objectIds()).toHaveLength(1);
    // 2,999 copies keep 32 MB and a save of them takes 95 MB more: they fit
    expect(run('object.array_place', { count: 3_000, linked: true }).ok).toBe(true);
    expect(doc.objectIds()).toHaveLength(3_000);
    // a project already past it with its save (grown in a browser editor): nothing to lower
    setOperatorMemoryCheck(
      operatorCheck({ heapFree: () => 4096 * MB, collect: () => 0, heapLimit: () => 500 * MB }),
    );
    const now = projectStoredBytes(doc);
    const nowSave = saveBytes(projectObjects(doc).bytes);
    expect(now).toBeLessThan(maxProjectMeshBytes(500 * MB));
    expect(now + nowSave).toBeGreaterThan(maxProjectMeshBytes(500 * MB));
    expect(run('object.empty_add', {}).error).toBe(
      `not run on the server: the project's meshes, objects, keyframes and images already take about ${up(now)} MB of memory ` +
        `with 3,000 objects, and a save of it about ${up(nowSave)} MB more for a moment (3 times what its ` +
        `objects, datablocks and keyframes take, 5 times its images): ${up(now) + up(nowSave)} MB in all, more than the 122 MB the ` +
        "server's process keeps for one project (half of its 500 MB heap less the 256 MB it keeps for its other " +
        'work), and this operator would add to them. Delete objects and meshes the project no longer needs',
    );
  });
});

describe("the server's checks", () => {
  it('are all installed when the render module loads (modifiers, operators, decoding stored meshes, rigid body simulations)', () => {
    expect([
      geometryMemoryCheck(),
      operatorMemoryCheck(),
      meshMemoryCheck(),
      simulationMemoryCheck(),
    ]).toEqual([null, null, null, null]);
    installGeometryMemoryGuard();
    expect(geometryMemoryCheck()).toBeTypeOf('function');
    expect(operatorMemoryCheck()).toBeTypeOf('function');
    expect(meshMemoryCheck()).toBeTypeOf('function');
    // the server's: frames no heap holds are refused, what to lower named
    const frames = {
      bodies: { simulated: 1e6, kinematic: 0 },
      frame: 20_000,
      frames: 19_999,
      bytes: 2 ** 50,
    };
    expect(simulationMemoryCheck()?.(frames)).toMatch(
      /^not simulated on the server: simulating 1,000,000 rigid bodies to frame 20,000 keeps 19,999 more frames of their poses, .*Lower the rigid body world's frame range/,
    );
  });
});

describe("the server's heap near its limit", () => {
  // V8 ends a process ("Ineffective mark-compacts near heap limit") when four full garbage
  // collections in a row leave its old generation at 80% of its limit or more while the program ran
  // for less than 40% of the time between them; the young generation (48 MB) is part of the limit
  it('keeps a quarter of the heap free, at least 256 MB: what the checks let in stays below 80% of the old generation', () => {
    expect(serverHeapReserve(688 * MB)).toBe(256 * MB); // --max-old-space-size=640
    expect(serverHeapReserve(2096 * MB)).toBe(524 * MB); // Node's default on a machine with 16 GB
    for (const oldSpace of [384, 640, 976, 1024, 1280, 1536, 2048, 4096, 8192]) {
      const limit = (oldSpace + 48) * MB;
      expect(limit - serverHeapReserve(limit), `${oldSpace} MB`).toBeLessThan(0.8 * oldSpace * MB);
    }
    // the meshes of one project: half of the heap less the reserve (786 MB of the default heap)
    expect(maxProjectMeshBytes(2096 * MB)).toBe(786 * MB);
    const check = operatorCheck({ heapFree: () => 2000 * MB, collect: () => 0, heapLimit: () => 2096 * MB });
    const estimate = { bytes: 1500 * MB, faces: 1_000_000, addedStoredBytes: 0, lower: 'number_cuts' };
    expect(check({ operator: 'mesh.subdivide', estimate, storedBytes: 0 })).toMatch(
      /the server's process has 2,000 MB of its 2,096 MB heap free and keeps 524 MB of it for its other work\. /,
    );
    expect(
      check({ operator: 'mesh.subdivide', estimate: { ...estimate, bytes: 1400 * MB }, storedBytes: 0 }),
    ).toBeNull();
  });

  it('runs a full garbage collection before refusing, at most one a second for refusals in a row', () => {
    let now = 0;
    let runs = 0;
    let took = 100;
    const collect = throttledGarbageCollector({
      gc: () => {
        runs++;
        now += took;
        return true;
      },
      now: () => now,
    });
    const check = decodeCheck({ heapFree: () => 600 * MB, collect, heapLimit: () => 1024 * MB });
    const layout = { vertices: 1_000_000, faces: 1_000_000, corners: 4_000_000, uvs: true, colors: false };
    // 400 MB: more than the 344 MB free above the reserve
    const req = { layout, bytes: 400 * MB };
    for (let i = 0; i < 6; i++)
      expect(check(req)).toMatch(/^this mesh of 2,000,000 triangles was not loaded/);
    expect(runs).toBe(1);
    // the next one a second after the last ended
    now += GC_MIN_INTERVAL_MS - 1;
    check(req);
    expect(runs).toBe(1);
    now += 1;
    check(req);
    expect(runs).toBe(2);
    // after a collection of 0.5 s, the guards wait four times as long: 2 s
    now += GC_MIN_INTERVAL_MS;
    took = 500;
    expect(collect()).toBe(true);
    now += 1999;
    expect(collect()).toBe(false);
    now += 1;
    expect(collect()).toBe(true);
    expect(runs).toBe(4);
    // a request larger than the whole heap less the reserve is refused without a collection
    now += 10_000;
    expect(check({ layout, bytes: 800 * MB })).toMatch(/^this mesh/);
    expect(runs).toBe(4);
    // the guards' own collector, which every check uses by default, is throttled the same way
    collectGarbage();
    expect(collectGarbage()).toBe(false);
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
    // a save of the project takes three times what its 12 objects and one mesh datablock keep (405 KB)
    const json = doc.listObjects().reduce((sum, o) => sum + extraJsonChars(o), 0);
    expect(saveBytes(projectObjects(doc).bytes)).toBe(
      3 * (12 * OBJECT_STORED_BYTES + DATABLOCK_STORED_BYTES.meshes + OBJECT_JSON_STORED_BYTES * json),
    );
    expect(saveBytes(projectObjects(doc).bytes)).toBeLessThan(406_000);
    expect(res.error).toBe(
      "not run on the server: the project's meshes, objects, keyframes and images would then take about 29 MB of memory " +
        '(now 2 MB with 12 objects), and a save of it about 1 MB more for a moment (3 times what its objects, ' +
        "datablocks and keyframes take, 5 times its images): 30 MB in all, more than the 22 MB the server's process keeps for one " +
        'project (half of its 300 MB heap less the 256 MB it keeps for its other work). Lower the number or size ' +
        'of the joined meshes, or delete objects and meshes the project no longer needs',
    );
    expect(doc.listObjects()).toHaveLength(12);
    // Apply Transform gives each duplicate a copy of its own: 11 more meshes, refused the same way
    const apply = run('object.transform_apply', { location: true });
    expect(apply).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(apply.error).toMatch(
      /^not run on the server: the project's meshes, objects, keyframes and images would then take about 29 MB /,
    );
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
      geometryCheck({ heapFree: () => 300 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    const s = summarizeScene(doc) as any;
    const message =
      `skipped on the server: this curve surface would need about ${Math.round(e.bytes / MB)} MB of JavaScript ` +
      `heap for a result of about ${e.result.faces.toLocaleString('en-US')} faces, and the server's process has ` +
      '300 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work. Lower resolution_u, ' +
      'bevel_resolution or the number of spline points to evaluate it on the server (a browser editor evaluates ' +
      'it itself)';
    expect(s.problems).toEqual([{ source: 'curve', object: 'Curve', message }]);
    expect(s.counts.evaluated).toMatchObject({ faces: 0 });
    // with room for it (in a copy of the project: evaluations are cached per document state)
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => 600 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
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
      operatorCheck({ heapFree: () => 400 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    const need = estimateOperator('object.convert', ctx, { target: 'MESH', keep_original: false })!;
    const res = run('object.convert', { target: 'MESH' });
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toBe(
      `not run on the server: it would need about ${Math.round(need.bytes / MB)} MB of JavaScript heap for a mesh ` +
        `of about ${need.faces.toLocaleString('en-US')} faces, and the server's process has 400 MB of its 1,024 MB ` +
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
      operatorCheck({ heapFree: () => 1500 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    // 5,000 instances of 1,280 faces: the OBJ holds 6,400,001 faces (about 11 GB to build)
    const res = run('export_scene.obj');
    expect(res).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY' });
    expect(res.error).toMatch(
      /^not run on the server: it would need about [\d,]+ MB of JavaScript heap for a mesh of about 6,400,001 faces, and the server's process has 1,500 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work\. Lower the faces of the exported meshes and instances \(export fewer objects with use_selection, lower the counts of particle systems, or use the export_scene tool, which builds the file in a render process\) to run it on the server \(a browser editor runs it in its own memory\)$/,
    );
  });
});

describe('renders in the process', () => {
  /**
   * Triangles a render is estimated to show: a flat grid of 100 × 100 quads (or a cube), plain and
   * with a Bevel of `params`.
   */
  function bevelledGrid(
    params: Record<string, unknown>,
    flags: { show_render?: boolean } = {},
    add: [string, Record<string, unknown>] = [
      'mesh.primitive_grid_add',
      { x_subdivisions: 100, y_subdivisions: 100 },
    ],
  ) {
    const { doc, run } = project();
    expect(run(...add).ok).toBe(true);
    const plain = estimateRenderMemory(doc).triangles;
    expect(run('object.modifier_add', { type: 'BEVEL', params }).ok).toBe(true);
    if (flags.show_render !== undefined)
      expect(run('object.modifier_set', { modifier: 'Bevel', ...flags }).ok).toBe(true);
    const o = doc.listObjects()[0];
    return { plain, triangles: estimateRenderMemory(doc).triangles, mesh: doc.getMesh(o.data!)! };
  }

  it('count a Bevel limited by angle by the edges it bevels on the stored mesh (none of a flat grid)', () => {
    const params = { limit_method: 'ANGLE', width: 0.01, segments: 30 };
    const grid = bevelledGrid(params);
    expect(grid.plain).toBe(20_000);
    // as if every edge were sharp: about 60 times as many
    expect(grid.triangles).toBe(grid.plain);
    // a cube: its 12 edges are sharp (90°, more than the angle limit of 30°)
    const cube = bevelledGrid(params, {}, ['mesh.primitive_cube_add', {}]);
    const c = bevelCount(cube.mesh, { ...params, angle_limit: Math.PI / 6, affect: 'EDGES' });
    expect(c.edges).toBe(12);
    expect(cube.triangles).toBe(c.result.corners - 2 * c.result.faces);
    expect(cube.triangles).toBeGreaterThan(100 * cube.plain);
  });

  it('leave out the modifiers a render does not run: hidden in renders, or disabled by their type (a Bevel of width 0)', () => {
    const heavy = bevelledGrid({ limit_method: 'NONE', width: 0.01, segments: 20 });
    expect(heavy.triangles).toBeGreaterThan(10 * heavy.plain);
    const hidden = bevelledGrid({ limit_method: 'NONE', width: 0.01, segments: 20 }, { show_render: false });
    expect(hidden.triangles).toBe(hidden.plain);
    const disabled = bevelledGrid({ limit_method: 'NONE', width: 0, segments: 20 });
    expect(disabled.triangles).toBe(disabled.plain);
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
      heapLimit: () => 1024 * MB,
    });
    expect(refused).toBe(
      "not built on the server: it would need about 11 MB of JavaScript heap (a copy of the meshes and up to 6 MB of JSON), and the server's process has 266 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work. Export the meshes instead (GET /api/projects/:id/export builds the file in a render process), or delete meshes the project no longer needs",
    );
    expect(collected).toBe(1);
    // with room for it
    expect(
      snapshotRefusal(doc, { heapFree: () => 300 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    ).toBeNull();
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
      'not built on the server: the snapshot would be more than the 4 MB of JSON a JavaScript string can hold. Export the meshes instead (GET /api/projects/:id/export builds the file in a render process), or delete meshes the project no longer needs',
    );
    // the count stops once it is past the limit: after the positions of a mesh, before its faces
    const positions = JSON.stringify(Array.from(mesh.positions)).length;
    expect(meshJsonChars(mesh, positions)).toBe(128 + positions);
    expect(meshJsonChars(mesh, 100)).toBe(meshJsonChars(mesh, positions));
    expect(meshJsonChars(mesh, 100)).toBeLessThan(meshJsonChars(mesh));
    // and the meshes after the one that took it past the limit are not counted at all
    const second = doc.listMeshBlocks()[1].id;
    const getMesh = doc.getMesh.bind(doc);
    let read = 0;
    doc.getMesh = (id) => {
      const m = getMesh(id);
      if (id !== second || !m) return m;
      return new Proxy(m, {
        get: (target, key, receiver) => {
          if (key === 'positions') read++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    };
    expect(snapshotRefusal(doc, { heapFree: () => 4096 * MB, collect: () => 0, maxChars: 100 })).toMatch(
      /^not built on the server: the snapshot would be more than the 0 MB of JSON/,
    );
    expect(read).toBe(0);
  });

  it("pass on the decode refusal of a stored mesh the server's process does not load", () => {
    const stored = SceneDoc.fromUpdate(Y.encodeStateAsUpdate(grids(1, 100).ydoc));
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 257 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
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
    "this mesh of 20,000 triangles was not loaded on the server: decoding it needs about 2 MB of JavaScript heap, and the server's process has 257 MB of its 1,024 MB heap free and keeps 256 MB of it for its other work (the open projects keep their meshes decoded). Delete or simplify large meshes, or work on it in a browser editor that has the project open, which loads it in its own memory";

  it('are not decoded when they do not fit: get_scene lists their stored counts and why', () => {
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 257 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
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
      decodeCheck({ heapFree: () => 257 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    expect(run('object.shade_smooth')).toMatchObject({ ok: false, code: 'OUT_OF_MEMORY', error: REFUSED });
    // with room for it, the same mesh loads and the operator runs
    setMeshMemoryCheck(
      decodeCheck({ heapFree: () => 400 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    expect(run('object.shade_smooth').ok).toBe(true);
    expect((summarizeScene(doc) as any).objects[0].data).toMatchObject({ vertices: 10_201, faces: 10_000 });
  });
});

describe('get_scene problems', () => {
  it('list every problem of an object, and the problems of a shared datablock on each object using it', () => {
    const { doc, run } = project(SceneDoc.create({ name: 'Problems', empty: true }));
    expect(run('mesh.primitive_cube_add', { name: 'Cube' }).ok).toBe(true);
    expect(run('material.new', { name: 'Paint' }).ok).toBe(true);
    // a linked duplicate: the same mesh and material
    expect(run('object.duplicate', { linked: true }).ok).toBe(true);
    // drivers that fail at every frame: one of the shared material, three of the first cube
    const material = { target_type: 'material', target: 'Paint', path: 'roughness', expression: '1 / 0' };
    expect(run('anim.driver_add', material).ok).toBe(true);
    expect(
      run('anim.driver_add', { target: 'Cube', path: 'location', index: -1, expression: '2 / 0' }).ok,
    ).toBe(true);
    const s = summarizeScene(doc) as any;
    const problems = (name: string) => [...s.objects.find((o: any) => o.name === name).problems].sort();
    const fails = (expression: string) => `driver: division by zero at column 3 in "${expression}"`;
    expect(problems('Cube')).toEqual([fails('1 / 0'), fails('2 / 0'), fails('2 / 0'), fails('2 / 0')]);
    expect(problems('Cube.001')).toEqual([fails('1 / 0')]);
    expect(s.problems).toHaveLength(4);
  });

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
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => (free -= 3) * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
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

  it('are named by get_mesh_data too: its evaluated geometry says which modifier the server left out and why', () => {
    const { doc, run } = project(SceneDoc.create({ name: 'Skipped', empty: true }));
    expect(run('mesh.primitive_grid_add', { x_subdivisions: 50, y_subdivisions: 50 }).ok).toBe(true);
    expect(run('object.modifier_add', { type: 'SUBSURF', params: { levels: 4, render_levels: 4 } }).ok).toBe(
      true,
    );
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => 400 * MB, collect: () => 0, heapLimit: () => 1024 * MB }),
    );
    const grid = doc.listObjects()[0];
    const data = meshData(doc, grid, { source: 'RENDER', frame: 1, include: [] }) as any;
    // the 2,500 faces of the grid, without the Subdivision Surface
    expect(data.totals.faces).toBe(2500);
    expect(data.modifier_errors).toEqual([{ modifier: 'Subdivision', message: expect.any(String) }]);
    expect(data.modifier_errors[0].message).toMatch(
      /^skipped on the server: this Subdivision Surface would need about [\d,]+ MB of JavaScript heap/,
    );
    expect(data.modifier_errors_note).toBe(
      'this geometry is the result without the modifiers listed in modifier_errors: the evaluation left ' +
        'each of them out for the reason given (get_scene lists them too)',
    );
    // the stored mesh has nothing left out
    const base = meshData(doc, grid, { source: 'BASE', frame: 1, include: [] }) as any;
    expect(base.modifier_errors).toBeUndefined();
    // a modifier Blender's rule disables (a Bevel of width 0) is named too, as get_scene names it
    const small = project(SceneDoc.create({ name: 'Disabled', empty: true }));
    expect(small.run('mesh.primitive_grid_add', { x_subdivisions: 10, y_subdivisions: 10 }).ok).toBe(true);
    expect(small.run('object.modifier_add', { type: 'BEVEL', params: { width: 0 } }).ok).toBe(true);
    const o = small.doc.listObjects()[0];
    const viewport = meshData(small.doc, o, { source: 'EVALUATED', frame: 1, include: [] }) as any;
    expect(viewport.totals.faces).toBe(100);
    expect(viewport.modifier_errors).toEqual([
      {
        modifier: 'Bevel',
        disabled: true,
        message: "the Bevel modifier 'Bevel' has a width of 0, so it changes nothing",
      },
    ]);
  });
});

describe('counts in the memory messages', () => {
  const free = 10 * 1024 * 1024;
  const limit = 1024 * 1024 * 1024;

  it('are singular for one: 1 face, 1 new keyframe, 1 more frame, 1 triangle', () => {
    const op = (faces: number, keyframes: number) =>
      refusedOperatorMessage(
        {
          operator: 'mesh.subdivide',
          estimate: { bytes: 900 * 1024 * 1024, faces, addedStoredBytes: 0, keyframes, lower: 'the cuts' },
          storedBytes: 0,
        },
        free,
        limit,
      );
    expect(op(1, 1)).toContain('for a mesh of about 1 face and 1 new keyframe, and ');
    expect(op(2, 2)).toContain('for a mesh of about 2 faces and 2 new keyframes, and ');
    expect(op(0, 1)).toContain('heap for 1 new keyframe, and ');
    const modifier = (faces: number) =>
      skippedModifierMessage(
        {
          type: 'SUBSURF',
          label: 'Subdivision Surface',
          estimate: {
            result: { vertices: 4, faces, corners: 4 * faces },
            bytes: 900 * 1024 * 1024,
            lower: 'levels',
          },
        },
        free,
        limit,
      );
    expect(modifier(1)).toContain('for a result of about 1 face, and ');
    expect(modifier(4)).toContain('for a result of about 4 faces, and ');
    const decode = (faces: number) =>
      refusedDecodeMessage(
        {
          layout: { vertices: 3, faces, corners: 3 * faces, uvs: false, colors: false },
          bytes: 900 * 1024 * 1024,
        },
        free,
        limit,
      );
    expect(decode(1)).toMatch(/^this mesh of 1 triangle was not loaded/);
    expect(decode(2)).toMatch(/^this mesh of 2 triangles was not loaded/);
    const simulation = (frames: number) =>
      refusedSimulationMessage(
        { bodies: { simulated: 1, kinematic: 0 }, frame: 2, frames, bytes: 900 * 1024 * 1024 },
        free,
        limit,
      );
    expect(simulation(1)).toContain(
      'simulating 1 rigid body to frame 2 keeps 1 more frame of its pose, about',
    );
    expect(simulation(3)).toContain(
      'simulating 1 rigid body to frame 2 keeps 3 more frames of its pose, about',
    );
    const bodies = (simulated: number, kinematic: number) =>
      refusedSimulationMessage(
        { bodies: { simulated, kinematic }, frame: 2, frames: 1, bytes: 900 * 1024 * 1024 },
        free,
        limit,
      );
    expect(bodies(1, 1)).toContain(
      'simulating 2 rigid bodies to frame 2 keeps 1 more frame of their poses, about',
    );
    expect(bodies(0, 1)).toContain(
      'simulating 1 rigid body to frame 2 keeps 1 more frame of its pose, about',
    );
    // a render of one triangle in the server's own process with no heap free
    const doc = SceneDoc.create({ empty: true });
    doc.addObject({
      type: 'MESH',
      name: 'Tri',
      data: doc.addMesh('Tri', {
        ...createGrid({ x_subdivisions: 1, y_subdivisions: 1 }),
        faces: [[0, 1, 2]],
      }),
    });
    expect(() =>
      checkMainThreadRender(
        doc,
        () => 0,
        () => undefined,
      ),
    ).toThrow(/\(about 1 triangle\)/);
    doc.ydoc.destroy();
  });
});
