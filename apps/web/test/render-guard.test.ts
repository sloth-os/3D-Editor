import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createFCurve,
  createMesh,
  getModifierDef,
  insertKeyframe,
  meshSize,
  registerBuiltinModifiers,
  registerModifier,
  renderSceneSoftware,
  type MeshData,
  type ModifierData,
} from '@3d-editor/core';
import { InProcessWorker, RenderPool, startPathTrace, type WorkerLike } from '../src/render';
import { ADOPTER_COPIES_STOP, stopsAdopters } from '../src/render/path-trace';
import {
  EvaluationGuard,
  RasterEvaluationGuard,
  SKIPPED_AFTER_REFUSAL,
  bevelEstimate,
  guardedEvaluation,
  type BevelSizeParams,
} from '../src/render/guard';
import {
  BEVEL_HEAP_BYTES,
  COMPILED_BYTES_PER_TRIANGLE,
  INSTANCE_BYTES,
  PREPARE_BYTES_PER_TRIANGLE,
  RASTER_BYTES_PER_TRIANGLE,
  WORKER_BASE_BYTES,
  YOUNG_GENERATION_BYTES,
  estimateRender,
  estimatedNeeds,
  planRenderThreads,
  renderMemory,
  type RenderEstimate,
  type RenderNeeds,
  type TabMemory,
} from '../src/render/memory';
import { DocumentSnapshot } from '../src/render/pool';
import { RenderWorkerEngine } from '../src/render/worker-engine';
import {
  RenderMemoryError,
  type PreparedInfo,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/render/protocol';

/*
 * The check of the first render worker's evaluation (render/guard.ts): every modifier is checked
 * right before it runs, from its real input, so geometry the estimate before the render cannot see
 * (a Bevel limited by angle bevels the edges its input really has) is refused with the reason
 * instead of filling the worker's heap, which ended the whole tab (V8's out-of-memory crash).
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A tab with plenty of memory, the page holding nothing. */
const roomy: TabMemory = {
  budget: 4 * GB,
  heapLimit: 3.76e9,
  heapUsed: 0,
  deviceGB: 8,
  held: { total: 0, heap: 0 },
};

const pools: RenderPool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.dispose();
});

const modifier = (
  id: string,
  type: string,
  params: Record<string, unknown>,
  show_viewport = true,
): ModifierData => ({
  id,
  name: id,
  type,
  show_viewport,
  show_render: true,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

/**
 * The verifier's scene, smaller: the default cube as `n` copies (Array) beveled with 30 segments in
 * renders only (Bevel limited by angle, off in the viewport): 11,532 triangles per copy in renders.
 */
function bevelScene(n: number): SceneDoc {
  const doc = SceneDoc.create();
  doc.updateRender({ resolution_x: 24, resolution_y: 16, samples: 1, max_bounces: 2 });
  const cube = doc.findObjectByName('Cube')!;
  doc.updateObject(cube.id, {
    name: 'BevCube',
    modifiers: [
      modifier('Arr', 'ARRAY', { count: n, relative_offset_displace: [1.5, 0, 0] }),
      modifier('Bev', 'BEVEL', { width: 0.05, segments: 30 }, false),
    ],
  });
  return doc;
}

/** Counts the evaluations of core's Bevel modifier until `restore`. */
function countBevels(): { count: () => number; restore: () => void } {
  registerBuiltinModifiers();
  const def = getModifierDef('BEVEL')!;
  let n = 0;
  registerModifier({
    ...def,
    apply: (mesh, params, ctx) => {
      n++;
      return def.apply(mesh, params, ctx);
    },
  });
  return { count: () => n, restore: () => registerModifier(def) };
}

/**
 * A worker engine with its own thread record, and its prepare of frame 1: with the tab's `memory`,
 * the page's estimate of the document at that frame unless `estimate` is given (null: none).
 */
function engine() {
  const e = new RenderWorkerEngine(null);
  const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
  return {
    engine: e,
    prepare: (
      doc: SceneDoc,
      memory?: TabMemory,
      job = 1,
      estimate?: RenderEstimate | null,
    ): Promise<PreparedInfo> =>
      e.prepare(
        job,
        new DocumentSnapshot(doc).payload(thread),
        { width: 24, height: 16, frame: 1 },
        memory,
        estimate === null ? undefined : (estimate ?? (memory ? estimateRender(doc, true, 1) : undefined)),
      ),
  };
}

const triangles = (m: { faces: number; corners: number }) => m.corners - 2 * m.faces;

describe('Bevel sizes counted from the edges it bevels', () => {
  const def = (() => {
    registerBuiltinModifiers();
    return getModifierDef('BEVEL')!;
  })();
  const ctx = {
    forRender: true,
    frame: 1,
    editMode: false,
    objectMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    getObjectMesh: () => null,
  } as unknown as Parameters<typeof def.apply>[2];
  /** The evaluated mesh of the default cube with `mods`. */
  const evaluated = (mods: ModifierData[]): MeshData => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { modifiers: mods });
    return new SceneEvaluator(doc).evaluate(1, { forRender: true }).byId.get(cube.id)!.mesh!;
  };
  /** An open, wavy grid of n × n quads (a border, and edges at different angles). */
  const wavy = (n: number): MeshData => {
    const positions: number[] = [];
    const faces: number[][] = [];
    for (let y = 0; y <= n; y++)
      for (let x = 0; x <= n; x++) positions.push(x / n, y / n, 0.1 * Math.sin(x) * Math.cos(y));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x;
        faces.push([a, a + 1, a + n + 2, a + n + 1]);
      }
    return createMesh({ positions, faces });
  };
  const params = (p: Partial<BevelSizeParams>) =>
    def.schema.parse({ width: 0.02, ...p }) as unknown as BevelSizeParams & Record<string, unknown>;
  const array = (count: number) => modifier('a', 'ARRAY', { count, relative_offset_displace: [1.5, 0, 0] });
  const subdivided = (levels: number) => modifier('s', 'SUBSURF', { levels, render_levels: levels });
  const grid = (segments: number) => ({ segments, width: 0.002, limit_method: 'NONE' });

  it("counts a cube's beveled faces exactly: strips along its edges, a quad grid at each corner", () => {
    const cube = evaluated([]);
    for (const segments of [1, 2, 3, 30, 31]) {
      const p = params({ segments });
      const real = meshSize(def.apply(cube, p, ctx));
      const est = bevelEstimate(cube, p);
      // 6 faces, 12 strips of S faces, 8 corners: one polygon (S = 1), else 3 sectors of
      // ⌊S/2⌋ × ⌈S/2⌉ quads and a middle polygon for odd S
      expect(est.result.faces, `S = ${segments}`).toBe(real.faces);
      expect(triangles(est.result), `S = ${segments}`).toBeGreaterThanOrEqual(triangles(real));
    }
    expect(bevelEstimate(cube, params({ segments: 30 })).result.faces).toBe(6 + 12 * 30 + 8 * 3 * 15 * 15);
    // its heap as Chrome takes it: per input vertex (more than faces here), per beveled edge and
    // patched corner, and per face it adds
    expect(bevelEstimate(cube, params({ segments: 30 })).bytes).toBe(
      BEVEL_HEAP_BYTES.input * 8 + BEVEL_HEAP_BYTES.element * (12 + 8) + BEVEL_HEAP_BYTES.face * (5766 - 6),
    );
  });

  it('never counts less than core makes: smooth, open, merged and triangulated inputs, both limits and modes', () => {
    const inputs: [string, MeshData][] = [
      ['subdivided', evaluated([modifier('s', 'SUBSURF', { levels: 2, render_levels: 2 })])],
      ['open grid', wavy(10)],
      [
        'merged copies',
        evaluated([
          modifier('a', 'ARRAY', { count: 3, relative_offset_displace: [1, 0, 0], use_merge_vertices: true }),
        ]),
      ],
      ['triangulated', evaluated([modifier('t', 'TRIANGULATE', {})])],
    ];
    for (const [name, mesh] of inputs)
      for (const segments of [1, 2, 3])
        for (const limit_method of ['ANGLE', 'NONE'])
          for (const affect of ['EDGES', 'VERTICES']) {
            const p = params({ segments, limit_method, affect, angle_limit: (5 * Math.PI) / 180 });
            const real = meshSize(def.apply(mesh, p, ctx));
            const est = bevelEstimate(mesh, p).result;
            const label = `${name} S${segments} ${limit_method} ${affect}`;
            expect(est.faces, label).toBeGreaterThanOrEqual(real.faces);
            expect(triangles(est), label).toBeGreaterThanOrEqual(triangles(real));
            // within 2.5 times as many triangles
            expect(triangles(est), label).toBeLessThanOrEqual(2.5 * Math.max(triangles(real), 4));
          }
  });

  it('counts nothing added where no edge is sharp enough, and nothing at all for a zero width', () => {
    // a subdivided cube: its faces meet at less than 30° (Bevel's default limit)
    const smooth = evaluated([modifier('s', 'SUBSURF', { levels: 3, render_levels: 3 })]);
    const p = params({ segments: 8 });
    expect(meshSize(def.apply(smooth, p, ctx)).faces).toBe(smooth.faces.length);
    const est = bevelEstimate(smooth, p);
    expect(est.result.faces).toBe(smooth.faces.length);
    // the topology it builds all the same
    expect(est.bytes).toBe(
      BEVEL_HEAP_BYTES.input * Math.max(smooth.faces.length, smooth.positions.length / 3),
    );
    // limit_method NONE bevels all of them
    expect(bevelEstimate(smooth, params({ segments: 8, limit_method: 'NONE' })).result.faces).toBeGreaterThan(
      10 * smooth.faces.length,
    );
    expect(bevelEstimate(smooth, params({ segments: 8, width: 0 })).bytes).toBe(0);
    // corners only where a sharp edge meets them (affect VERTICES): none here
    const corners = params({ segments: 8, affect: 'VERTICES' });
    expect(meshSize(def.apply(smooth, corners, ctx)).faces).toBe(smooth.faces.length);
    expect(bevelEstimate(smooth, corners).result.faces).toBe(smooth.faces.length);
  });

  it('takes at least the heap Chrome needed for each Bevel measured, and less than 1.7 times it', () => {
    // the smallest --max-old-space-size (MB) with which a dedicated worker of Chrome 153 evaluated the
    // scene with the Bevel in renders only (the scene without it: at most 14 MB); the default cube as
    // copies (Array) or subdivided, its Bevel 0.05 wide by angle (0.002 on every edge)
    const measured: [string, ModifierData[], Partial<BevelSizeParams>, number][] = [
      ['160 copies, 30 segments', [array(160)], { segments: 30 }, 331],
      ['20 copies, 100 segments', [array(20)], { segments: 100 }, 447],
      ['640 copies, 8 segments', [array(640)], { segments: 8 }, 130],
      ['2,000 copies, 2 segments', [array(2000)], { segments: 2 }, 80],
      ['4,000 copies, 1 segment', [array(4000)], { segments: 1 }, 98],
      ['subdivided 6 times, every edge, 2 segments', [subdivided(6)], grid(2), 148],
      ['subdivided 6 times, every edge, 1 segment', [subdivided(6)], grid(1), 94],
    ];
    // (the subdivided cube evaluated once for both)
    const meshes = new Map<string, MeshData>();
    for (const [name, mods, p, mb] of measured) {
      const key = JSON.stringify(mods);
      if (!meshes.has(key)) meshes.set(key, evaluated(mods));
      const bytes = bevelEstimate(meshes.get(key)!, params({ width: 0.05, ...p })).bytes;
      expect(bytes, name).toBeGreaterThanOrEqual(mb * MB);
      expect(bytes, name).toBeLessThan(1.7 * mb * MB);
    }
    // the cube subdivided 4 times as 128 copies (196,608 faces, 196,864 vertices) beveled by angle:
    // nothing to bevel, 258 MB (40 MB without the Bevel)
    expect(BEVEL_HEAP_BYTES.input * 196_864).toBeGreaterThanOrEqual((258 - 40) * MB);
    expect(BEVEL_HEAP_BYTES.input * 196_864).toBeLessThan(1.7 * (258 - 40) * MB);
    // six evaluated meshes of up to 24,576 faces and seven Bevels counted: 0.9 s under coverage with
    // the render tests only, 1.8 s in the whole suite on a busy machine
  }, 15_000);
});

describe('the check of the first worker while it evaluates the scene', () => {
  it("refuses a Bevel that only renders before it runs, naming it, when what it makes does not fit the tab's heap", async () => {
    const doc = bevelScene(1);
    // the estimate cannot see the edges a Bevel limited by angle bevels: the cube's faces only
    expect(estimateRender(doc).triangles).toBe(12);
    // a heap like Chromium's with --max-old-space-size=33: room for the cube, not for its bevels
    const memory = { ...roomy, heapLimit: YOUNG_GENERATION_BYTES + 33 * MB };
    expect(planRenderThreads(estimatedNeeds(estimateRender(doc), 24 * 16), 1, memory).threads).toBe(1);
    const bevels = countBevels();
    const w = engine();
    try {
      const refused = w.prepare(doc, memory);
      await expect(refused).rejects.toThrow(RenderMemoryError);
      await expect(refused).rejects.toThrow(
        /^Path tracing was not started: its render thread needs about 0\.034 GB of JavaScript heap, more than the 0\.032 GB the tab has left for it: a render may fill 0\.032 GB of its 0\.165 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working \(about 11,532 triangles, 384 pixels\), and running out of memory would end the tab\. The Bevel modifier 'Bev' of 'BevCube' would make 11,532 of these triangles \(lower its segments\)\. Lower the triangles \(subdivision render levels, curve and text render resolution, objects in the scene\), or render with the RASTER engine\.$/,
      );
      // the Bevel never ran, and nothing was compiled for the job
      expect(bevels.count()).toBe(0);
      expect(() => w.engine.share(1)).toThrow(/not prepared/);
      // with room for it, the same worker renders the scene with the Bevel: it kept no result evaluated
      // without it
      const info = await w.prepare(doc, roomy, 2);
      expect(bevels.count()).toBe(1);
      expect(info.triangles).toBe(11_532);
    } finally {
      bevels.restore();
    }
  });

  it('checks every modifier from its real input: a Subdivision Surface after a Bevel', async () => {
    const doc = SceneDoc.create();
    doc.updateRender({ resolution_x: 24, resolution_y: 16 });
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, {
      modifiers: [
        modifier('b', 'BEVEL', { width: 0.1, segments: 2 }),
        modifier('s', 'SUBSURF', { levels: 0, render_levels: 3 }),
      ],
    });
    // estimated on the cube's 24 corners: 384 faces; on the beveled cube's 216: 3,456
    const est = estimateRender(doc);
    expect(est.triangles).toBe(2 * 24 * 4 ** 2);
    const fitsEstimate = renderMemory(estimatedNeeds(est, 24 * 16), 1).heap;
    const memory = { ...roomy, heapLimit: YOUNG_GENERATION_BYTES + fitsEstimate + MB };
    expect(planRenderThreads(estimatedNeeds(est, 24 * 16), 1, memory).threads).toBe(1);
    await expect(engine().prepare(doc, memory)).rejects.toThrow(
      /\(about 6,912 triangles, 384 pixels\), and running out of memory would end the tab\. The Subdivision Surface modifier 's' of 'Cube' would make 6,912 of these triangles \(lower its render_levels\)\./,
    );
    // with the heap for it, it renders
    expect((await engine().prepare(doc, { ...roomy, heapLimit: memory.heapLimit + 16 * MB })).triangles).toBe(
      6_912,
    );
  });

  it('counts what a modifier makes once: its peak above its input on top of what the evaluation holds', () => {
    const doc = SceneDoc.create();
    const est = estimateRender(doc);
    // a tab without a budget refuses it, and the refusal keeps what it was refused for
    const guard = new EvaluationGuard(est, 24 * 16, { ...roomy, budget: 0 });
    const made = 2_000_000;
    // its peak above its input, its 2 million triangles included
    const bytes = 500 * MB;
    const reason = guard.before(
      { type: 'BEVEL', label: 'Bevel' },
      { result: { faces: made / 2, corners: 2 * made, vertices: made / 2 }, bytes, lower: 'segments' },
      0,
    );
    expect(reason).toMatch(/^Path tracing was not started: /);
    const needs = guard.refusal!.needs;
    // the compiled scene: the cube and what the modifier makes
    expect(needs.triangles).toBe(12 + made);
    // the heap while it runs: the cube the evaluation holds, its instance and the modifier's peak, the
    // 2 million triangles not a second time
    expect(renderMemory(needs, 1).heap).toBe(
      WORKER_BASE_BYTES + 12 * PREPARE_BYTES_PER_TRIANGLE.heap + INSTANCE_BYTES.heap * est.instances + bytes,
    );
    // a modifier whose peak is no more than its result: the heap of what the scene then holds
    const small = new EvaluationGuard(est, 24 * 16, { ...roomy, budget: 0 });
    small.before(
      { type: 'TRIANGULATE', label: 'Triangulate' },
      { result: { faces: made, corners: 3 * made, vertices: made / 2 }, bytes: MB, lower: '' },
      0,
    );
    expect(renderMemory(small.refusal!.needs, 1).heap).toBe(
      WORKER_BASE_BYTES + (12 + made) * PREPARE_BYTES_PER_TRIANGLE.heap + INSTANCE_BYTES.heap * est.instances,
    );
  });

  it("counts what a modifier makes from its real input: an Array's length, a Boolean's operand, the scene's images", async () => {
    // a tab without a budget refuses the first modifier checked, and says what it would make
    const reason = (doc: SceneDoc) =>
      engine()
        .prepare(doc, { ...roomy, budget: 0 })
        .then(
          () => 'prepared',
          (err: Error) => err.message,
        );
    // an Array fitted to 40 m: 21 copies of the 2 m cube (the length is measured on its input)
    const fitted = SceneDoc.create();
    const cube = fitted.findObjectByName('Cube')!;
    fitted.updateObject(cube.id, {
      modifiers: [modifier('A', 'ARRAY', { fit_type: 'FIT_LENGTH', fit_length: 40 })],
    });
    expect(await reason(fitted)).toContain(
      "The Array modifier 'A' of 'Cube' would make 252 of these triangles (lower its count).",
    );
    // a Boolean with a grid of 1,600 faces: the operand's faces are in its result
    const cut = SceneDoc.create();
    const positions: number[] = [];
    const faces: number[][] = [];
    for (let y = 0; y <= 40; y++) for (let x = 0; x <= 40; x++) positions.push(x / 10 - 2, y / 10 - 2, 0);
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) faces.push([y * 41 + x, y * 41 + x + 1, y * 41 + x + 42, y * 41 + x + 41]);
    const operand = cut.addObject({
      name: 'Cutter',
      type: 'MESH',
      data: cut.addMesh('Grid', createMesh({ positions, faces })),
      hide_render: true,
    });
    cut.updateObject(cut.findObjectByName('Cube')!.id, {
      modifiers: [modifier('b', 'BOOLEAN', { object: operand, operation: 'UNION' })],
    });
    expect(await reason(cut)).toContain(
      "The Boolean modifier 'b' of 'Cube' would make 3,212 of these triangles (lower the faces of both meshes).",
    );
    // the decoded images are in the compiled scene the check counts
    const est = { ...estimateRender(SceneDoc.create(), true, 1), imageBytes: 5 * MB };
    const guard = new EvaluationGuard(est, 24 * 16, { ...roomy, budget: 0 });
    guard.before(
      { type: 'TRIANGULATE', label: 'Triangulate' },
      { result: { faces: 12, corners: 36, vertices: 8 }, bytes: 1, lower: 'the faces of the mesh' },
      12,
    );
    expect(guard.refusal!.needs.sceneBytes).toBe(
      12 * COMPILED_BYTES_PER_TRIANGLE + est.instances * INSTANCE_BYTES.scene + 5 * MB,
    );
  });

  it('holds the last result of each modifier stack, at least what the estimate says the scene holds', () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, {
      modifiers: [
        modifier('s', 'SUBSURF', { levels: 0, render_levels: 2 }),
        modifier('t', 'TRIANGULATE', {}),
      ],
    });
    // an unmodified copy of the cube, stored
    doc.addObject({
      name: 'Plain',
      type: 'MESH',
      data: doc.addMesh('Box', createMesh(doc.getMesh(cube.data!)!)),
    });
    const est = estimateRender(doc);
    expect([est.evaluatedTriangles, est.storedTriangles]).toEqual([192 + 12, 12]);
    const evaluator = new SceneEvaluator(doc);
    const run = () => {
      const guard = new EvaluationGuard(est, 24 * 16, roomy);
      guardedEvaluation(guard, () => evaluator.evaluate(1, { forRender: true }));
      return guard;
    };
    // the triangulated result replaces the subdivided one: 192, not 384
    const first = run();
    expect([first.refusal, first.heldTriangles]).toEqual([null, 12 + 192]);
    // the evaluator keeps its results: nothing is built again, the estimate holds them
    const again = run();
    expect(again.heldTriangles).toBe(12 + 192);
    // more than the estimate said: what the stacks really made
    const low = new EvaluationGuard({ ...est, evaluatedTriangles: 0 }, 24 * 16, roomy);
    guardedEvaluation(low, () => new SceneEvaluator(doc).evaluate(1, { forRender: true }));
    expect(low.heldTriangles).toBe(12 + 192);
  });

  it('leaves the modifiers as they were after the evaluation, also when it throws', () => {
    registerBuiltinModifiers();
    const before = getModifierDef('SUBSURF');
    const guard = new EvaluationGuard(estimateRender(SceneDoc.create()), 1, roomy);
    expect(guardedEvaluation(guard, () => getModifierDef('SUBSURF'))).not.toBe(before);
    expect(getModifierDef('SUBSURF')).toBe(before);
    expect(() =>
      guardedEvaluation(guard, () => {
        throw new Error('evaluation failed');
      }),
    ).toThrow('evaluation failed');
    expect(getModifierDef('SUBSURF')).toBe(before);
  });

  it('builds nothing more after the first refusal: later modifiers are skipped with a short note', () => {
    const doc = bevelScene(6);
    const cube = doc.findObjectByName('BevCube')!;
    const other = doc.addObject({
      name: 'Other',
      type: 'MESH',
      data: cube.data,
      location: [0, 5, 0],
      modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })],
    });
    const guard = new EvaluationGuard(estimateRender(doc), 24 * 16, {
      ...roomy,
      heapLimit: YOUNG_GENERATION_BYTES + 40 * MB,
    });
    const bevels = countBevels();
    try {
      const scene = guardedEvaluation(guard, () => new SceneEvaluator(doc).evaluate(1, { forRender: true }));
      expect(bevels.count()).toBe(0);
      expect(guard.refusal?.type).toBe('BEVEL');
      const errors = (id: string) => scene.byId.get(id)!.modifierErrors.map((e) => e.message);
      expect(errors(cube.id)).toEqual([guard.refusal!.message]);
      // evaluated after the refusal: skipped with a short note, not the reason again
      expect(errors(other)).toEqual([SKIPPED_AFTER_REFUSAL]);
    } finally {
      bevels.restore();
    }
  });

  it('estimates the document at the frame it renders when the page sent no estimate', async () => {
    // a cable stored without a bevel (a wire) whose keyed bevel depth makes a tube at frame 1: 5 spans
    // × 24 samples + 1 points, a ring of 12, 2,880 triangles, triangulated by its modifier
    const doc = SceneDoc.create();
    doc.updateRender({ resolution_x: 24, resolution_y: 16 });
    const point = (i: number) => ({
      co: [i * 0.4, Math.sin(i) * 0.6, 0.3] as [number, number, number],
      handle_left: null,
      handle_right: null,
      handle_left_type: 'AUTO' as const,
      handle_right_type: 'AUTO' as const,
      radius: 1,
      tilt: 0,
      weight: 1,
    });
    const data = doc.addCurve({
      splines: [
        {
          type: 'BEZIER',
          points: [0, 1, 2, 3, 4, 5].map(point),
          use_cyclic_u: false,
          resolution_u: 0,
          order_u: 4,
          use_endpoint_u: true,
          use_smooth: true,
          material_index: 0,
        },
      ],
      resolution_u: 1,
      render_resolution_u: 24,
      bevel_depth: 0,
      bevel_resolution: 4,
    });
    doc.addObject({ name: 'Cable', type: 'CURVE', data, modifiers: [modifier('T', 'TRIANGULATE', {})] });
    doc.setFCurve(
      insertKeyframe(
        createFCurve({ target_type: 'curve', target_id: data, path: 'bevel_depth', index: 0 }),
        1,
        0.05,
      ),
    );
    // a tab without a budget: the check refuses the modifier, with what the evaluation holds
    const memory = { ...roomy, budget: 0 };
    const w = engine();
    const reason = (estimate?: RenderEstimate | null) =>
      w.prepare(doc, memory, 1, estimate).then(
        () => 'prepared',
        (err: Error) => err.message,
      );
    const atFrame = await reason(estimateRender(doc, true, 1));
    expect(atFrame).toContain(
      "The Triangulate modifier 'T' of 'Cable' would make 2,880 of these triangles (lower the faces of the mesh).",
    );
    // the tube is held from the start: counted once as built and once as what the modifier makes
    expect(atFrame).toContain('(about 5,772 triangles, 384 pixels)');
    expect(await reason(null)).toBe(atFrame);
    // the stored values have no tube
    expect(await reason(estimateRender(doc))).toContain('(about 2,892 triangles, 384 pixels)');
  });

  it('checks next to the path traced renders running in the tab', async () => {
    const pool = new RenderPool({ size: 2, idleMs: 0, factory: () => new InProcessWorker() });
    pools.push(pool);
    // a render that holds its workers' memory while it samples
    const cube = SceneDoc.create();
    cube.updateRender({ resolution_x: 24, resolution_y: 16 });
    const first = startPathTrace(pool, cube, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1 << 16,
      memory: roomy,
    });
    await new Promise<void>((resolve) => {
      const off = first.subscribe(() => {
        if (first.status.phase !== 'rendering') return;
        off();
        resolve();
      });
    });
    // what it holds: its 2 workers' worth, with the scene as its first worker compiled it
    const info = await engine().prepare(cube);
    const held = renderMemory(
      {
        triangles: info.triangles,
        evaluatedTriangles: info.evaluatedTriangles,
        instances: info.instances,
        sceneBytes: info.sceneBytes,
        pixels: 24 * 16,
      },
      2,
    ).total;
    // memory for the Bevel scene's estimate next to it, not for its bevels
    const doc = bevelScene(6);
    const estimate = renderMemory(estimatedNeeds(estimateRender(doc), 24 * 16), 1).total;
    const memory = { ...roomy, budget: held + estimate + 8 * MB };
    const bevels = countBevels();
    try {
      const refused = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory });
      await expect(refused.result).rejects.toThrow(
        /GB of which other path traced renders running in it hold \(about 69,192 triangles, 384 pixels\), and running out of memory would end the tab\. The Bevel modifier 'Bev' of 'BevCube' would make 69,192 of these triangles/,
      );
      expect(bevels.count()).toBe(0);
    } finally {
      bevels.restore();
      first.cancel();
      await first.result;
    }
  });
});

describe("the check of a RASTER render's evaluation on the page", () => {
  /** The estimate of the default scene with the given counts of what its evaluation builds. */
  const estimate = (built: number, builtBase: number, instances: number): RenderEstimate => ({
    ...estimateRender(SceneDoc.create()),
    builtTriangles: built,
    builtBaseTriangles: builtBase,
    instances,
  });
  /** A modifier about to run: `bytes` of heap at its peak, a result of `faces` triangles. */
  const run = (bytes: number, faces: number) => ({
    bytes,
    result: { faces, corners: 3 * faces, vertices: faces },
    lower: 'its segments',
  });
  const bevel = { type: 'BEVEL', label: 'Bevel' };

  it('counts what the stacks evaluated so far made, the instances, and the peak of the modifier about to run', () => {
    // 1 MB a render may fill
    const memory = { ...roomy, heapLimit: YOUNG_GENERATION_BYTES + MB };
    const guard = new RasterEvaluationGuard(estimate(1_000, 100, 50), memory);
    // a stack made 5,000 triangles from 10 so far, more than the estimate saw: the evaluation holds
    // them besides the surfaces it built before the modifiers
    guard.after(10, 5_000);
    expect(guard.heldTriangles).toBe(100 + 4_990);
    expect(guard.before(bevel, run(2 * MB, 3_000), 20)).toMatch(/^The RASTER render was not started: /);
    expect(guard.refusal!.needs).toEqual({
      // its result replaces the 20 triangles of its input
      triangles: 100 + 4_990 - 20 + 3_000,
      heap: (100 + 4_990) * RASTER_BYTES_PER_TRIANGLE + 50 * INSTANCE_BYTES.heap + 2 * MB,
    });
    expect(guard.refusal!.triangles).toBe(3_000);
    // at least what the estimate says the evaluation builds
    const early = new RasterEvaluationGuard(estimate(80_000, 100, 0), memory);
    early.before(bevel, run(0, 10), 0);
    expect(early.refusal!.needs).toEqual({
      triangles: 80_000,
      heap: 80_000 * RASTER_BYTES_PER_TRIANGLE,
    });
    // with room, nothing is refused
    expect(
      new RasterEvaluationGuard(estimate(1_000, 100, 50), roomy).before(bevel, run(2 * MB, 3_000), 20),
    ).toBeNull();
  });

  it('suggests the RASTER engine for a modifier the first worker refuses only where it fits the page', () => {
    // 20 MB a render may fill: a render thread needs more than that (32 MB of its own)
    const memory = { ...roomy, heapLimit: YOUNG_GENERATION_BYTES + 20 * MB };
    const refusal = (bytes: number) => {
      const guard = new EvaluationGuard(estimate(1_000, 100, 50), 24 * 16, memory);
      return guard.before(bevel, run(bytes, 3_000), 20);
    };
    // a modifier whose peak fits the page: a RASTER render would evaluate it there
    expect(refusal(MB)).toMatch(/, or render with the RASTER engine\.$/);
    // one whose peak does not
    const both = refusal(30 * MB);
    expect(both).toMatch(/^Path tracing was not started: /);
    expect(both).not.toContain('RASTER');
  });
});

describe('render workers', () => {
  /**
   * A worker that hands messages over like a real one: as structured clones, the buffers in the
   * transfer list moved (detached on the sending side).
   */
  class CloningWorker implements WorkerLike {
    onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    private readonly inner = new InProcessWorker();
    constructor() {
      this.inner.onmessage = (e) =>
        this.onmessage?.({ data: structuredClone(e.data) } as MessageEvent<WorkerResponse>);
    }
    postMessage(msg: WorkerRequest, transfer: Transferable[] = []): void {
      this.inner.postMessage(structuredClone(msg, { transfer }));
    }
    terminate(): void {
      this.inner.terminate();
    }
  }

  it('copies the compiled scene to each other worker and moves its buffers only to the last one', async () => {
    const doc = SceneDoc.create();
    doc.updateRender({ resolution_x: 24, resolution_y: 16, samples: 3, max_bounces: 2 });
    const reference = renderSceneSoftware(doc, { width: 24, height: 16, engine: 'PATHTRACER', samples: 3 });
    const pool = new RenderPool({ size: 4, idleMs: 0, factory: () => new CloningWorker() });
    pools.push(pool);
    const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 3, memory: roomy })
      .result;
    expect(r.threads).toBe(4);
    expect(Buffer.from(r.data).equals(Buffer.from(reference.data))).toBe(true);
  });

  it('starts more workers when the compiled scene leaves room for more than the estimate did', async () => {
    const doc = SceneDoc.create();
    doc.updateRender({ resolution_x: 24, resolution_y: 16 });
    // a material no object uses, with a large image: in the estimate (every material's images), not
    // in what the first worker compiles
    const image = doc.addImage({
      name: 'Big',
      mime: 'image/png',
      width: 2048,
      height: 2048,
      data: new Uint8Array(8),
    });
    doc.addMaterial({ name: 'Unused', textures: { base_color: { image, scale: [1, 1], offset: [0, 0] } } });
    const started: number[] = [];
    const pool = new RenderPool({
      size: 4,
      idleMs: 0,
      factory: (i) => {
        started.push(i);
        return new InProcessWorker();
      },
    });
    pools.push(pool);
    const w = engine();
    const info = await w.prepare(doc);
    const exact: RenderNeeds = {
      triangles: info.triangles,
      evaluatedTriangles: info.evaluatedTriangles,
      instances: info.instances,
      sceneBytes: info.sceneBytes,
      pixels: 24 * 16,
    };
    const memory = { ...roomy, budget: renderMemory(exact, 2).total };
    expect(planRenderThreads(estimatedNeeds(estimateRender(doc), 24 * 16), 4, memory).threads).toBe(1);
    const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 8, memory }).result;
    expect(started).toEqual([0, 1]);
    expect(r.threads).toBe(2);
  });

  /** A pool of 8 in-process workers that records which ones start and which ones are stopped. */
  function trackedPool(): { pool: RenderPool; started: number[]; stopped: number[] } {
    const started: number[] = [];
    const stopped: number[] = [];
    class Tracked extends InProcessWorker {
      constructor(private readonly index: number) {
        super();
      }
      override terminate(): void {
        stopped.push(this.index);
        super.terminate();
      }
    }
    const pool = new RenderPool({
      size: 8,
      idleMs: 0,
      factory: (i) => {
        started.push(i);
        return new Tracked(i);
      },
    });
    pools.push(pool);
    return { pool, started, stopped };
  }

  /** The default scene and a grid of 2 × n² triangles (48,672 for n = 156). */
  function gridScene(n = 156): SceneDoc {
    const doc = SceneDoc.create();
    const positions: number[] = [];
    const faces: number[][] = [];
    for (let y = 0; y <= n; y++)
      for (let x = 0; x <= n; x++) positions.push((2 * x) / n - 1, (2 * y) / n - 1, 0);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x;
        faces.push([a, a + 1, a + n + 2, a + n + 1]);
      }
    doc.addObject({
      name: 'Grid',
      type: 'MESH',
      data: doc.addMesh('Grid', createMesh({ positions, faces })),
    });
    return doc;
  }

  /** The needs of a render of 24 × 16 pixels as its first worker reported them. */
  const needsOf = (info: PreparedInfo): RenderNeeds => ({
    triangles: info.triangles,
    evaluatedTriangles: info.evaluatedTriangles,
    instances: info.instances,
    sceneBytes: info.sceneBytes,
    pixels: 24 * 16,
  });

  it('stops the workers that hold copies of a large compiled scene once the render is over', async () => {
    const { pool, started, stopped } = trackedPool();
    const options = { width: 24, height: 16, frame: 1, samples: 1 };
    const adopters = [1, 2, 3, 4, 5, 6, 7];
    // a light scene: its copies stay with the workers
    const light = SceneDoc.create();
    await startPathTrace(pool, light, { ...options, memory: roomy }).result;
    expect([started, stopped]).toEqual([[0, ...adopters], []]);
    // a grid whose 7 copies take an eighth of the budget of 8 workers or more
    const doc = gridScene();
    const info = await engine().prepare(doc);
    const needs = needsOf(info);
    const memory = { ...roomy, budget: renderMemory(needs, 8).total };
    expect(7 * info.sceneBytes).toBeGreaterThanOrEqual(memory.budget / ADOPTER_COPIES_STOP);
    started.length = 0;
    await startPathTrace(pool, doc, { ...options, memory }).result;
    expect(stopped.sort((a, b) => a - b)).toEqual(adopters);
    // the next render starts them again; the first worker keeps its document
    await startPathTrace(pool, light, { ...options, memory: roomy }).result;
    expect(started).toEqual(adopters);
    // two evaluations and compilations of the grid: 1.6 s alone under coverage, 2.7 s with the
    // other test files
  }, 15_000);

  it('stops no adopter of a large compiled scene while another path traced render runs in the tab', async () => {
    const { pool, started, stopped } = trackedPool();
    // a render of the cube on one thread (the memory its tab allows) that samples until cancelled
    const light = SceneDoc.create();
    light.updateRender({ resolution_x: 24, resolution_y: 16 });
    const lightNeeds = needsOf(await engine().prepare(light));
    const lightMemory = { ...roomy, budget: renderMemory(lightNeeds, 1).total + 16 * MB };
    expect(renderMemory(estimatedNeeds(estimateRender(light, true, 1), 24 * 16), 1).total).toBeLessThan(
      lightMemory.budget,
    );
    expect(planRenderThreads(lightNeeds, 8, lightMemory).threads).toBe(1);
    const running = startPathTrace(pool, light, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1 << 16,
      memory: lightMemory,
    });
    await new Promise<void>((resolve) => {
      const off = running.subscribe(() => {
        if (running.status.phase !== 'rendering') return;
        off();
        resolve();
      });
    });
    expect(started).toEqual([0]);
    try {
      // a grid of 64,800 triangles on all 8 workers next to it, its 7 copies an eighth of its budget
      // or more: stopped once it is over, were it alone
      const doc = gridScene(180);
      const info = await engine().prepare(doc);
      const memory = {
        ...roomy,
        budget: renderMemory(lightNeeds, 1).total + renderMemory(needsOf(info), 8).total,
      };
      expect(stopsAdopters(0, 7, info.sceneBytes, memory.budget)).toBe(true);
      const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory })
        .result;
      expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(r.threads).toBeGreaterThan(1);
      // the other render runs on: its workers stay
      expect(running.running).toBe(true);
      expect(stopped).toEqual([]);
    } finally {
      running.cancel();
      await running.result;
    }
    // the render of the cube held no copies: nothing to stop after it either
    expect(stopped).toEqual([]);
    // two evaluations and compilations of the grid, as above
  }, 15_000);

  it('stops the other workers it started for a render its first worker refused', async () => {
    const { pool, started, stopped } = trackedPool();
    // the estimate leaves room for 2 workers; the first refuses the Bevel the estimate does not see
    const doc = bevelScene(6);
    const estimated = estimatedNeeds(estimateRender(doc, true, 1), 24 * 16);
    const memory = { ...roomy, budget: renderMemory(estimated, 2).total };
    expect(planRenderThreads(estimated, 8, memory).threads).toBe(2);
    const bevels = countBevels();
    try {
      await expect(
        startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory }).result,
      ).rejects.toThrow(/The Bevel modifier 'Bev' of 'BevCube' would make 69,192 of these triangles/);
      expect(bevels.count()).toBe(0);
    } finally {
      bevels.restore();
    }
    expect([started, stopped]).toEqual([[0, 1], [1]]);
    // while another render runs, the workers stay (it may use them)
    stopped.length = 0;
    const light = SceneDoc.create();
    light.updateRender({ resolution_x: 24, resolution_y: 16 });
    const lightNeeds = needsOf(await engine().prepare(light));
    const running = startPathTrace(pool, light, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1 << 16,
      memory: { ...roomy, budget: renderMemory(lightNeeds, 1).total + 16 * MB },
    });
    await new Promise<void>((resolve) => {
      const off = running.subscribe(() => {
        if (running.status.phase !== 'rendering') return;
        off();
        resolve();
      });
    });
    try {
      const next = { ...memory, budget: renderMemory(lightNeeds, 1).total + memory.budget };
      await expect(
        startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory: next }).result,
      ).rejects.toThrow(/The Bevel modifier 'Bev' of 'BevCube'/);
      expect(started.slice(2)).toEqual([1]);
      expect(stopped).toEqual([]);
    } finally {
      running.cancel();
      await running.result;
    }
  });

  it('stops no worker another path traced render may use, and none for copies under an eighth of the budget', () => {
    const budget = 4 * GB;
    // three copies of 200 MB: 600 MB, more than an eighth of 4 GB
    expect(stopsAdopters(0, 3, 200 * MB, budget)).toBe(true);
    // another render runs: it may be using them
    expect(stopsAdopters(1, 3, 200 * MB, budget)).toBe(false);
    // an eighth exactly, and a byte less
    expect(stopsAdopters(0, 2, 256 * MB, budget)).toBe(true);
    expect(stopsAdopters(0, 2, 256 * MB - 1, budget)).toBe(false);
    // no copies
    expect(stopsAdopters(0, 0, 200 * MB, budget)).toBe(false);
  });

  it('renders with only the workers the compiled scene leaves room for, fewer than the estimate started', async () => {
    // the estimate sees the cubes, not what a Bevel limited by angle makes of them: it starts 3
    // workers, and the compiled scene leaves room for 2
    const doc = bevelScene(3);
    const sent: string[][] = Array.from({ length: 4 }, () => []);
    class Recording extends InProcessWorker {
      constructor(private readonly index: number) {
        super();
      }
      override postMessage(msg: WorkerRequest): void {
        sent[this.index].push(msg.type);
        super.postMessage(msg);
      }
    }
    const pool = new RenderPool({ size: 4, idleMs: 0, factory: (i) => new Recording(i) });
    pools.push(pool);
    const info = await engine().prepare(doc);
    const memory = { ...roomy, budget: renderMemory(needsOf(info), 2).total };
    expect(planRenderThreads(estimatedNeeds(estimateRender(doc, true, 1), 24 * 16), 4, memory).threads).toBe(
      3,
    );
    expect(planRenderThreads(needsOf(info), 4, memory).threads).toBe(2);
    const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 4, memory }).result;
    expect(r.threads).toBeLessThanOrEqual(2);
    expect(r.limitedByMemory).toBe(true);
    // the workers beyond them got no copy of the scene and no rows
    for (const s of sent.slice(2)) expect(s.filter((t) => t !== 'release')).toEqual([]);
    // two evaluations of the Bevels (34,596 triangles) and compilations: 0.6 s alone without coverage
  }, 15_000);

  it('counts no worker that got its copy of the compiled scene after the render was over', async () => {
    // the second worker's copy arrives once the render is finishing (its sampling over)
    let finishing = () => {};
    const finished = new Promise<void>((resolve) => (finishing = resolve));
    class Late extends InProcessWorker {
      constructor(private readonly index: number) {
        super();
      }
      override postMessage(msg: WorkerRequest): void {
        if (msg.type === 'finish') {
          finishing();
          setTimeout(() => super.postMessage(msg), 100);
        } else if (this.index === 1 && msg.type === 'adopt') void finished.then(() => super.postMessage(msg));
        else super.postMessage(msg);
      }
    }
    const pool = new RenderPool({ size: 2, idleMs: 0, factory: (i) => new Late(i) });
    pools.push(pool);
    const doc = SceneDoc.create();
    const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory: roomy })
      .result;
    expect(r.threads).toBe(1);
  });

  it('starts only the workers the memory leaves room for', async () => {
    const doc = SceneDoc.create();
    doc.updateRender({ resolution_x: 24, resolution_y: 16 });
    const started: number[] = [];
    const pool = new RenderPool({
      size: 4,
      idleMs: 0,
      factory: (i) => {
        started.push(i);
        return new InProcessWorker();
      },
    });
    pools.push(pool);
    const needs: RenderNeeds = estimatedNeeds(estimateRender(doc), 24 * 16);
    const memory = { ...roomy, budget: renderMemory(needs, 2).total };
    const planned = planRenderThreads(needs, 4, memory).threads;
    expect(planned).toBe(2);
    const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory }).result;
    expect(started).toEqual([0, 1]);
    expect(r.threads).toBeLessThanOrEqual(2);
  });
});
