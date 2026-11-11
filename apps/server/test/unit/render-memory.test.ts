import { afterAll, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createGrid,
  geometryMemoryCheck,
  setGeometryMemoryCheck,
  type ModifierData,
} from '@3d-editor/core';
import {
  RenderOutOfMemoryError,
  RenderPool,
  Renderer,
  estimateRenderMemory,
  estimateRenderTriangles,
  renderMemoryFromEnv,
} from '../../src/render';
import { RENDER_HEAP_BYTES_PER_TRIANGLE, geometryCheck, serverHeapReserve } from '../../src/render/memory';
import { OUT_OF_MEMORY_ADVICE, renderToolError } from '../../src/mcp/rendering';

/*
 * The server's own process: a render there (single-thread mode: RENDER_WORKERS=0, or render
 * processes could not start) whose estimated heap need does not fit into the server's free heap
 * is refused with an explained error, and a modifier the server evaluates (summaries, Apply) whose
 * estimated peak heap does not fit is skipped with an explained error, instead of running the
 * server out of memory.
 */

const subsurf = (params: Record<string, unknown>): ModifierData => ({
  id: 'm1',
  name: 'Subdivision',
  type: 'SUBSURF',
  show_viewport: true,
  show_render: true,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

const renderers: Renderer[] = [];
afterAll(async () => {
  await Promise.all(renderers.map((r) => r.close()));
});

const MB = 1024 * 1024;

function scene(): SceneDoc {
  return SceneDoc.create({ name: 'memory', empty: true });
}

function addGrid(doc: SceneDoc, n: number, name = 'Grid'): string {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, createGrid({ x_subdivisions: n, y_subdivisions: n })),
  });
}

describe('RENDER_WORKER_MEMORY_MB', () => {
  it('takes whole numbers of megabytes from 64 up (a smaller heap does not hold a warmed-up render process)', () => {
    expect(renderMemoryFromEnv({})).toBeUndefined();
    expect(renderMemoryFromEnv({ RENDER_WORKER_MEMORY_MB: ' ' })).toBeUndefined();
    expect(renderMemoryFromEnv({ RENDER_WORKER_MEMORY_MB: '64' })).toBe(64);
    expect(renderMemoryFromEnv({ RENDER_WORKER_MEMORY_MB: ' 3072 ' })).toBe(3072);
    for (const raw of ['63', '0', '-128', '1.5', '2GB'])
      expect(() => renderMemoryFromEnv({ RENDER_WORKER_MEMORY_MB: raw })).toThrow(
        `RENDER_WORKER_MEMORY_MB must be a whole number of megabytes >= 64 (got '${raw}')`,
      );
  });
});

describe('renders in the server process', () => {
  it('estimate the triangles of a render from the stored meshes and their generating modifiers', () => {
    const doc = scene();
    const grid = addGrid(doc, 10); // 200 triangles
    expect(estimateRenderTriangles(doc)).toBe(200);
    doc.updateObject(grid, {
      modifiers: [
        {
          id: 'm1',
          name: 'Subdivision',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { levels: 1, render_levels: 2 },
        },
        {
          id: 'm2',
          name: 'Array',
          type: 'ARRAY',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { count: 3 },
        },
        {
          id: 'm3',
          name: 'Mirror',
          type: 'MIRROR',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { use_axis: [true, true, false] },
        },
        {
          id: 'm4',
          name: 'Off',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: false,
          show_in_editmode: true,
          show_expanded: true,
          params: { render_levels: 3 },
        },
      ],
    });
    expect(estimateRenderTriangles(doc)).toBe(200 * 16 * 3 * 4);
    // objects hidden from renders are left out; a linked duplicate with the same stack counts once
    const cube = doc.addObject({ type: 'MESH', name: 'Cube', data: doc.addMesh('Cube', createCube()) });
    doc.addObject({ type: 'MESH', name: 'Cube 2', data: doc.getObject(cube)!.data! });
    expect(estimateRenderTriangles(doc)).toBe(200 * 16 * 3 * 4 + 12);
    doc.updateObject(cube, { hide_render: true });
    expect(estimateRenderTriangles(doc)).toBe(200 * 16 * 3 * 4 + 12);
  });

  it('estimate the heap of a render: its meshes, the peak of their modifiers, the render of their result', () => {
    const doc = scene();
    const grid = addGrid(doc, 100); // 20,000 triangles
    expect(estimateRenderMemory(doc)).toEqual({
      triangles: 20_000,
      bytes: 20_000 * RENDER_HEAP_BYTES_PER_TRIANGLE,
    });
    // one level: 40,000 quads (80,000 triangles); the subdivision's peak (700 bytes per face,
    // 28,000,000) is more than the render of its result (320 bytes per triangle, 25,600,000)
    doc.updateObject(grid, { modifiers: [subsurf({ levels: 0, render_levels: 1 })] });
    expect(estimateRenderMemory(doc)).toEqual({
      triangles: 80_000,
      bytes: 20_000 * RENDER_HEAP_BYTES_PER_TRIANGLE + 40_000 * 700,
    });
  });

  it('refuse a render the free heap cannot hold, with an explained error, and render one it can', async () => {
    // a heap of 1,024 MB with 300 MB free: 256 MB stay for the rest of the server, 44 MB for the render
    const free = 300 * MB;
    const r = new Renderer(new RenderPool({ threads: 0 }), {
      heapFree: () => free,
      collectGarbage: () => undefined,
      heapLimit: () => 1024 * MB,
    });
    renderers.push(r);
    const big = scene();
    addGrid(big, 400); // 320,000 triangles: about 98 MB
    expect(320_000 * RENDER_HEAP_BYTES_PER_TRIANGLE).toBeGreaterThan(free - serverHeapReserve(1024 * MB));
    const options = { width: 32, height: 24, frame: 1, engine: 'RASTER' as const, shading: 'SOLID' as const };
    const exportCall = () => r.exportScene({ scene: big, projectId: 'big', format: 'obj', options: {} });
    for (const call of [
      () => r.renderImage({ scene: big, projectId: 'big', options }),
      () =>
        r.renderImage({
          scene: big,
          projectId: 'big',
          options: { ...options, engine: 'PATHTRACER', shading: undefined, samples: 1 },
        }),
      exportCall,
      () =>
        r.renderAnimation({
          scene: big,
          projectId: 'big',
          format: 'PNG_SEQUENCE',
          frame_start: 1,
          frame_end: 1,
          frame_step: 1,
          width: 32,
          height: 24,
          base: { engine: 'RASTER' },
        }),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RenderOutOfMemoryError);
      expect((err as RenderOutOfMemoryError).reason).toBe('refused');
      const what = call === exportCall ? 'export' : 'render';
      expect((err as Error).message).toMatch(
        new RegExp(
          `^out of memory: this ${what} was not started: it needs about 98 MB of JavaScript heap \\(about 320,000 triangles\\), and ${what}s run in the server's own process \\(its render processes are off: RENDER_WORKERS=0, or they could not start\\), which has 300 MB of its 1024 MB heap free; running out of it would stop the server$`,
        ),
      );
      expect(renderToolError(err).message).toBe(
        `Rendering failed: ${(err as Error).message}. ${OUT_OF_MEMORY_ADVICE}`,
      );
      expect(renderToolError(err).code).toBe('OUT_OF_MEMORY');
    }
    const small = scene();
    addGrid(small, 100); // 20,000 triangles: about 6 MB
    const ok = await r.renderImage({ scene: small, projectId: 'small', options });
    expect(ok).toMatchObject({ mode: 'main-thread', width: 32, height: 24 });
  });

  it('count the subdivision of a mesh: a few stored triangles can need far more heap', async () => {
    // 20 MB for the render: a grid of 20,000 triangles fits; with one level of Subdivision
    // Surface for renders it needs about 33 MB (80,000 triangles at 160 bytes, 13 MB, used to pass)
    let collected = 0;
    const r = new Renderer(new RenderPool({ threads: 0 }), {
      heapFree: () => 276 * MB,
      collectGarbage: () => collected++,
      heapLimit: () => 1024 * MB,
    });
    renderers.push(r);
    const doc = scene();
    const grid = addGrid(doc, 100);
    const options = { width: 16, height: 16, frame: 1, engine: 'RASTER' as const, shading: 'SOLID' as const };
    await r.renderImage({ scene: doc, projectId: 'grid', options });
    expect(collected).toBe(0);
    doc.updateObject(grid, { modifiers: [subsurf({ levels: 0, render_levels: 1 })] });
    const err = await r.renderImage({ scene: doc, projectId: 'grid', options }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(
      /^out of memory: this render was not started: it needs about 33 MB of JavaScript heap \(about 80,000 triangles\)/,
    );
    // a full garbage collection ran before the render was refused
    expect(collected).toBe(1);
  });
});

describe("modifiers evaluated in the server's process", () => {
  const evaluate = (doc: SceneDoc) => new SceneEvaluator(doc).evaluate(1, { forRender: true }).objects[0];

  it("are checked against the server's free heap once its render module is loaded", () => {
    expect(geometryMemoryCheck()).toBeTypeOf('function');
  });

  it('skip a modifier whose peak heap does not fit, with an explained error, after a garbage collection', () => {
    const before = geometryMemoryCheck();
    let free = 270 * MB;
    let collected = 0;
    setGeometryMemoryCheck(
      geometryCheck({ heapFree: () => free, collect: () => collected++, heapLimit: () => 1024 * MB }),
    );
    try {
      const doc = scene();
      const grid = addGrid(doc, 50);
      // 40,000 faces at 700 bytes: 27 MB, more than the 14 MB the server can spare
      doc.updateObject(grid, { modifiers: [subsurf({ levels: 2, render_levels: 2 })] });
      const skipped = evaluate(doc);
      expect(skipped.mesh!.faces.length).toBe(50 * 50);
      expect(skipped.modifierErrors).toHaveLength(1);
      expect(skipped.modifierErrors[0].modifierId).toBe('m1');
      expect(skipped.modifierErrors[0].message).toMatch(
        /^skipped on the server: this Subdivision Surface would need about 27 MB of JavaScript heap for a result of about 40,000 faces, and the server's process has 270 MB of its [\d,]+ MB heap free and keeps 256 MB of it for its other work\. Lower render_levels to evaluate it on the server \(a browser editor evaluates it itself\)$/,
      );
      expect(collected).toBe(1);
      // once a collection freed enough, it runs
      free = 300 * MB;
      expect(evaluate(doc).mesh!.faces.length).toBe(40_000);
      expect(collected).toBe(1);
    } finally {
      setGeometryMemoryCheck(before);
    }
  });
});
