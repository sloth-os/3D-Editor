import { afterEach, describe, expect, it } from 'vitest';
import {
  MODIFIER_BYTES_PER_INPUT_FACE,
  MODIFIER_BYTES_PER_RESULT_FACE,
  SceneDoc,
  SceneEvaluator,
  createMesh,
  getModifierDef,
  meshSize,
  registerBuiltinModifiers,
  registerModifier,
  renderSceneSoftware,
  type MeshData,
  type ModifierData,
} from '@3d-editor/core';
import { InProcessWorker, RenderPool, startPathTrace, type WorkerLike } from '../src/render';
import { ADOPTER_COPIES_STOP } from '../src/render/path-trace';
import {
  EvaluationGuard,
  SKIPPED_AFTER_REFUSAL,
  bevelEstimate,
  guardedEvaluation,
  type BevelSizeParams,
} from '../src/render/guard';
import {
  estimateRender,
  estimatedNeeds,
  planRenderThreads,
  renderMemory,
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

/** A worker engine with its own thread record, and its prepare. */
function engine() {
  const e = new RenderWorkerEngine(null);
  const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
  return {
    engine: e,
    prepare: (doc: SceneDoc, memory?: TabMemory, job = 1): Promise<PreparedInfo> =>
      e.prepare(
        job,
        new DocumentSnapshot(doc).payload(thread),
        { width: 24, height: 16, frame: 1 },
        memory,
        memory ? estimateRender(doc) : undefined,
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
    // its heap: core's per input face and per face it adds
    expect(bevelEstimate(cube, params({ segments: 30 })).bytes).toBe(
      MODIFIER_BYTES_PER_INPUT_FACE.BEVEL * 8 + MODIFIER_BYTES_PER_RESULT_FACE.BEVEL_ADDED * (5766 - 6),
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
      for (const segments of [1, 2, 5])
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
    expect(est.bytes).toBe(
      MODIFIER_BYTES_PER_INPUT_FACE.BEVEL * Math.max(smooth.faces.length, smooth.positions.length / 3),
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
});

describe('the check of the first worker while it evaluates the scene', () => {
  it("refuses a Bevel that only renders before it runs, naming it, when what it makes does not fit the tab's heap", async () => {
    const doc = bevelScene(6);
    // the estimate cannot see the edges a Bevel limited by angle bevels: the Array's copies only
    expect(estimateRender(doc).triangles).toBe(6 * 12);
    // a heap like Chromium's with --max-old-space-size=60: room for the copies, not for the bevels
    const memory = { ...roomy, heapLimit: 100 * MB };
    expect(planRenderThreads(estimatedNeeds(estimateRender(doc), 24 * 16), 1, memory).threads).toBe(1);
    const bevels = countBevels();
    const w = engine();
    try {
      const refused = w.prepare(doc, memory);
      await expect(refused).rejects.toThrow(RenderMemoryError);
      await expect(refused).rejects.toThrow(
        /^Path tracing was not started: its render thread needs about 0\.10 GB of JavaScript heap, and the tab, which already uses 0\.0 GB, has 0\.08 GB of its 0\.1 GB left for it \(about 69,192 triangles, 384 pixels\), and running out of memory would end the tab\. The Bevel modifier 'Bev' of 'BevCube' would make 69,192 of these triangles \(lower its segments\)\. Lower the resolution or the triangles/,
      );
      // the Bevel never ran, and nothing was compiled for the job
      expect(bevels.count()).toBe(0);
      expect(() => w.engine.share(1)).toThrow(/not prepared/);
      // with room for it, the same worker renders the scene with the Bevel: it kept no result evaluated
      // without it
      const info = await w.prepare(doc, roomy, 2);
      expect(bevels.count()).toBe(1);
      expect(info.triangles).toBe(6 * 11_532);
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
        modifier('s', 'SUBSURF', { levels: 0, render_levels: 4 }),
      ],
    });
    // estimated on the cube's 24 corners: 1,536 faces; on the beveled cube's 216: 13,824
    const est = estimateRender(doc);
    expect(est.triangles).toBe(2 * 24 * 4 ** 3);
    const fitsEstimate = renderMemory(estimatedNeeds(est, 24 * 16), 1).heap;
    const memory = { ...roomy, heapLimit: (fitsEstimate + 4 * MB) / 0.85 };
    expect(planRenderThreads(estimatedNeeds(est, 24 * 16), 1, memory).threads).toBe(1);
    await expect(engine().prepare(doc, memory)).rejects.toThrow(
      /\(about 27,648 triangles, 384 pixels\), and running out of memory would end the tab\. The Subdivision Surface modifier 's' of 'Cube' would make 27,648 of these triangles \(lower its render_levels\)\./,
    );
    // with the heap for it, it renders
    expect((await engine().prepare(doc, { ...roomy, heapLimit: memory.heapLimit + 16 * MB })).triangles).toBe(
      27_648,
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
    const guard = new EvaluationGuard(estimateRender(doc), 24 * 16, { ...roomy, heapLimit: 100 * MB });
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

  it('stops the workers that hold copies of a large compiled scene once the render is over', async () => {
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
      size: 4,
      idleMs: 0,
      factory: (i) => {
        started.push(i);
        return new Tracked(i);
      },
    });
    pools.push(pool);
    const options = { width: 24, height: 16, frame: 1, samples: 2 };
    // a light scene: its copies stay with the workers
    const light = SceneDoc.create();
    await startPathTrace(pool, light, { ...options, memory: roomy }).result;
    expect([started, stopped]).toEqual([[0, 1, 2, 3], []]);
    // a grid of 64,800 triangles whose 3 copies take an eighth of the budget of 4 workers or more
    const doc = SceneDoc.create();
    const n = 180;
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
    const info = await engine().prepare(doc);
    const needs: RenderNeeds = {
      triangles: info.triangles,
      evaluatedTriangles: info.evaluatedTriangles,
      instances: info.instances,
      sceneBytes: info.sceneBytes,
      pixels: 24 * 16,
    };
    const memory = { ...roomy, budget: renderMemory(needs, 4).total };
    expect(3 * info.sceneBytes).toBeGreaterThanOrEqual(memory.budget / ADOPTER_COPIES_STOP);
    started.length = 0;
    await startPathTrace(pool, doc, { ...options, memory }).result;
    expect(stopped.sort()).toEqual([1, 2, 3]);
    // the next render starts them again; the first worker keeps its document
    await startPathTrace(pool, light, { ...options, memory: roomy }).result;
    expect(started).toEqual([1, 2, 3]);
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
