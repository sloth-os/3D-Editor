import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  TEXT_BYTES_PER_CHARACTER,
  createFCurve,
  createMesh,
  curveToMesh,
  defaultCurve,
  defaultProcedural,
  estimateModifier,
  evaluateCurveSplines,
  insertKeyframe,
  meshSize,
  renderSceneSoftware,
  type AnimTargetType,
  type CurveData,
  type MeshData,
  type ModifierData,
  type Spline,
} from '@3d-editor/core';
import {
  InProcessWorker,
  RenderPool,
  pathTraceDocument,
  startAnimationRender,
  startPathTrace,
  type WorkerLike,
} from '../src/render';
import {
  BEVEL_HEAP_BYTES,
  COMPILED_BYTES_PER_TRIANGLE,
  DEFAULT_DEVICE_GB,
  FINISH_BYTES_PER_PIXEL,
  INSTANCE_BYTES,
  JS_HEAP_SHARE,
  MAX_RENDER_BUDGET,
  PAGE_BYTES_PER_PIXEL,
  PAGE_HEAP_BYTES,
  PREPARE_BYTES_PER_TRIANGLE,
  WORKER_BASE_BYTES,
  YOUNG_GENERATION_BYTES,
  RASTER_BYTES_PER_TRIANGLE,
  bevelHeap,
  curveSurfaceSize,
  estimateRender,
  estimatedNeeds,
  pageHeapEstimate,
  planRenderThreads,
  rasterNeeds,
  rasterRefusal,
  refusalFigures,
  renderMemory,
  renderMemoryBudget,
  splineSampleCount,
  tabMemory,
  usableHeap,
  type RenderNeeds,
  type TabMemory,
} from '../src/render/memory';
import { DocumentSnapshot } from '../src/render/pool';
import { RenderWorkerEngine } from '../src/render/worker-engine';
import { RenderMemoryError, type PreparedInfo, type WorkerRequest } from '../src/render/protocol';
import { pathTraceInfo } from '../src/ui/dialogs/Dialogs';

/*
 * The memory guard of browser path tracing (render/memory.ts, path-trace.ts, worker-engine.ts): one
 * worker evaluates and compiles the scene, the others adopt a copy of the compiled scene, as many as
 * the tab's memory allows, and a render that cannot fit one worker is refused with an explanation
 * (it ended the whole tab before: V8 out of memory in a render worker): before any worker starts
 * when the estimate from the document shows it, else by the first worker before it compiles.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A tab with plenty of memory (8 GB device, Chrome's 3.76 GB heap limit, an idle page). */
const roomy: TabMemory = {
  budget: 4 * GB,
  heapLimit: 3.76e9,
  heapUsed: 50 * MB,
  deviceGB: 8,
  held: { total: 0, heap: 0 },
};

const pools: RenderPool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.dispose();
});

/** A pool of in-process workers that records the requests each one gets (prepare: with its document kind). */
function recordingPool(size: number): {
  pool: RenderPool;
  sent: string[][];
  started: number[];
} {
  const sent: string[][] = Array.from({ length: size }, () => []);
  const started: number[] = [];
  class Recording extends InProcessWorker {
    constructor(private readonly index: number) {
      super();
    }
    override postMessage(msg: WorkerRequest): void {
      sent[this.index].push(msg.type === 'prepare' ? `prepare:${msg.doc.kind}` : msg.type);
      super.postMessage(msg);
    }
  }
  const pool = new RenderPool({
    size,
    idleMs: 0,
    factory: (i): WorkerLike => {
      started.push(i);
      return new Recording(i);
    },
  });
  pools.push(pool);
  return { pool, sent, started };
}

/** The default scene (cube, camera, point light) with a tiny render resolution. */
function scene(): SceneDoc {
  const doc = SceneDoc.create();
  doc.updateRender({ resolution_x: 24, resolution_y: 16, samples: 3, max_bounces: 2 });
  return doc;
}

/** A flat grid of n × n quads (2 m wide). */
function grid(doc: SceneDoc, n: number): string {
  const positions: number[] = [];
  const faces: number[][] = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) positions.push((2 * x) / n - 1, (2 * y) / n - 1, 0);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      faces.push([a, a + 1, a + n + 2, a + n + 1]);
    }
  return doc.addMesh(`Grid ${n}`, createMesh({ positions, faces }));
}

const modifier = (
  id: string,
  type: string,
  params: Record<string, unknown>,
  show_render = true,
): ModifierData => ({
  id,
  name: id,
  type,
  show_viewport: true,
  show_render,
  show_in_editmode: true,
  show_expanded: true,
  params,
});

/**
 * A Bezier cable of `n` points with a round bevel: one segment per span in the viewport, dense in
 * renders (`render_resolution_u` samples per span, a ring of 4 + 2 × `bevel_resolution` points).
 */
function cable(doc: SceneDoc, n: number, renderResolution: number, bevelResolution: number): string {
  const data = doc.addCurve({
    splines: [wave('BEZIER', n)],
    resolution_u: 1,
    render_resolution_u: renderResolution,
    bevel_depth: 0.05,
    bevel_resolution: bevelResolution,
  });
  return doc.addObject({ name: 'Cable', type: 'CURVE', data });
}

/** A spline of `n` points along a wave (AUTO handles unless `handles` says otherwise). */
function wave(
  type: Spline['type'],
  n: number,
  cyclic = false,
  handles?: (i: number) => 'AUTO' | 'VECTOR',
): Spline {
  return {
    type,
    points: Array.from({ length: n }, (_, i) => ({
      co: [i * 0.4 - n * 0.2, Math.sin(i) * 0.6, 0.3] as [number, number, number],
      handle_left: null,
      handle_right: null,
      handle_left_type: handles?.(i) ?? 'AUTO',
      handle_right_type: handles?.(i) ?? 'AUTO',
      radius: 1,
      tilt: 0,
      weight: 1,
    })),
    use_cyclic_u: cyclic,
    resolution_u: 0,
    order_u: 4,
    use_endpoint_u: true,
    use_smooth: true,
    material_index: 0,
  };
}

/** What the first worker reports for `doc` at `frame` (exact triangles, instances and bytes). */
async function preparedInfo(doc: SceneDoc, width: number, height: number, frame = 1): Promise<PreparedInfo> {
  const engine = new RenderWorkerEngine(null);
  const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
  return engine.prepare(1, new DocumentSnapshot(doc).payload(thread), { width, height, frame });
}

/** Keys `path` of a datablock: `keys` as [frame, value] pairs. */
function key(doc: SceneDoc, type: AnimTargetType, id: string, path: string, keys: [number, number][]): void {
  let fc = createFCurve({ target_type: type, target_id: id, path, index: 0 });
  for (const [frame, value] of keys) fc = insertKeyframe(fc, frame, value);
  doc.setFCurve(fc);
}

/** The needs of a render as its first worker reported them. */
const needsOf = (info: PreparedInfo): RenderNeeds => ({
  triangles: info.triangles,
  evaluatedTriangles: info.evaluatedTriangles,
  instances: info.instances,
  sceneBytes: info.sceneBytes,
  pixels: info.width * info.height,
});

describe('memory of browser path traced renders', () => {
  it('gives a render half the device memory the browser reports, at most 4 GB', () => {
    expect(renderMemoryBudget(8)).toBe(4 * GB);
    expect(renderMemoryBudget(4)).toBe(2 * GB);
    expect(renderMemoryBudget(1)).toBe(0.5 * GB);
    expect(renderMemoryBudget(16)).toBe(MAX_RENDER_BUDGET);
    // unknown (Firefox, Safari): an 8 GB device
    expect(renderMemoryBudget(null)).toBe(renderMemoryBudget(DEFAULT_DEVICE_GB));
    const mem = tabMemory();
    expect(mem.budget).toBeGreaterThan(0);
    expect(mem.heapLimit).toBeGreaterThan(0);
    // a browser without performance.memory (Firefox, Safari): a heap limit of 4 GB is assumed
    const before = Object.getOwnPropertyDescriptor(performance, 'memory');
    Object.defineProperty(performance, 'memory', { value: undefined, configurable: true });
    try {
      expect(tabMemory().heapLimit).toBe(4 * GB);
    } finally {
      if (before) Object.defineProperty(performance, 'memory', before);
      else delete (performance as { memory?: unknown }).memory;
    }
  });

  it("takes the heap of the page from its scene, not from the browser's figure, which counts its ArrayBuffers", async () => {
    const perf = performance as { memory?: unknown };
    const before = Object.getOwnPropertyDescriptor(performance, 'memory');
    const browserFigure = (usedJSHeapSize: number) =>
      Object.defineProperty(performance, 'memory', {
        value: { jsHeapSizeLimit: 0.5 * GB, usedJSHeapSize },
        configurable: true,
      });
    try {
      // Chrome's usedJSHeapSize counts ArrayBuffers too (631 MiB for a page of three 720 × 720 grids
      // whose heap held 262 MiB) and can keep the figure of its first read (10 MB): neither counts
      for (const used of [10 * MB, 631 * MB]) {
        browserFigure(used);
        expect(tabMemory().heapUsed).toBe(0);
        expect(tabMemory(300 * MB).heapUsed).toBe(300 * MB);
        expect(tabMemory(1 * MB).heapUsed).toBe(1 * MB);
        expect(tabMemory(300 * MB).heapLimit).toBe(0.5 * GB);
      }
      // the page evaluates the scene for the viewport: its levels, not the render levels
      const doc = scene();
      const cube = doc.findObjectByName('Cube')!;
      doc.updateObject(cube.id, { modifiers: [modifier('s', 'SUBSURF', { levels: 2, render_levels: 4 })] });
      expect(estimateRender(doc, false).evaluatedTriangles).toBe(2 * 24 * 4);
      expect(estimateRender(doc).evaluatedTriangles).toBe(2 * 24 * 4 ** 3);
      // the stored cube, decoded, besides the result it is the input of
      expect(pageHeapEstimate(doc)).toBe(
        PAGE_HEAP_BYTES.base +
          3 * PAGE_HEAP_BYTES.object +
          (12 + 2 * 24 * 4) * PAGE_HEAP_BYTES.triangle +
          INSTANCE_BYTES.heap,
      );
      // two grids whose viewport subdivision (2,097,152 triangles each) holds half a gigabyte of the
      // page's heap: a render of them (render levels 0) is refused by the heap the page holds, which
      // neither of the browser's figures shows
      doc.updateObject(cube.id, { modifiers: [] });
      const plane = grid(doc, 64);
      for (const name of ['A', 'B'])
        doc.addObject({
          name,
          type: 'MESH',
          data: plane,
          modifiers: [modifier('s', 'SUBSURF', { levels: 4, render_levels: 0 })],
        });
      expect(estimateRender(doc, false).evaluatedTriangles).toBe(12 + 2 * 2 * 4096 * 4 * 4 ** 3);
      expect(pageHeapEstimate(doc)).toBeGreaterThan(usableHeap(0.5 * GB));
      browserFigure(10 * MB);
      const { pool, started } = recordingPool(2);
      const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1 });
      // the page alone uses more than the share a render may fill: the tab has none left, and the
      // figures say so instead of a room of 0.00 GB "of that"
      await expect(job.result).rejects.toThrow(
        /needs about 0\.03 GB of JavaScript heap, and the tab has none left for it: a render may fill 0\.37 GB of its 0\.50 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working, and the page is estimated to use 0\.4\d GB \(about/,
      );
      expect(started).toEqual([]);
      // without the subdivided grids the page holds little: the browser's 631 MiB, ArrayBuffers
      // included, do not refuse the render (they did: every render of a page with large meshes was
      // refused once that figure passed the share)
      browserFigure(631 * MB);
      for (const name of ['A', 'B']) doc.removeObject(doc.findObjectByName(name)!.id);
      const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1 }).result;
      expect(r.samples).toBe(1);
    } finally {
      if (before) Object.defineProperty(performance, 'memory', before);
      else delete perf.memory;
    }
  });

  it('estimates the triangles a render compiles and the ones its first worker evaluates', () => {
    const doc = SceneDoc.create();
    const subsurf = (show_render = true) =>
      modifier(`m${show_render}`, 'SUBSURF', { levels: 1, render_levels: 2 }, show_render);
    // the default cube: 6 quads
    expect(estimateRender(doc)).toMatchObject({ triangles: 12, evaluatedTriangles: 12, instances: 1 });
    const cube = doc.findObjectByName('Cube')!;
    // Subdivision Surface at its render levels: 24 corners × 4^(2-1) quads
    doc.updateObject(cube.id, { modifiers: [subsurf()] });
    expect(estimateRender(doc).triangles).toBe(2 * 96);
    // a linked duplicate with modifiers is evaluated and compiled per object, as core does
    const copy = doc.addObject({ name: 'Copy', type: 'MESH', data: cube.data, modifiers: [subsurf()] });
    expect(estimateRender(doc)).toMatchObject({
      triangles: 4 * 96,
      evaluatedTriangles: 4 * 96,
      instances: 2,
    });
    // unmodified users of a mesh share it
    doc.updateObject(cube.id, { modifiers: [] });
    doc.updateObject(copy, { modifiers: [] });
    doc.addObject({ name: 'Third', type: 'MESH', data: cube.data });
    expect(estimateRender(doc)).toMatchObject({ triangles: 12, evaluatedTriangles: 12, instances: 3 });
    // an object hidden in renders is not compiled, but the first worker evaluates it all the same,
    // at its render levels; a modifier off in renders does not run
    doc.updateObject(cube.id, { hide_render: true, modifiers: [subsurf()] });
    doc.updateObject(copy, { modifiers: [subsurf(false)] });
    expect(estimateRender(doc)).toMatchObject({
      triangles: 12,
      evaluatedTriangles: 12 + 2 * 96,
      instances: 2,
    });
    // faces of any size: n corners make n − 2 triangles
    const shapes = doc.addMesh(
      'Shapes',
      createMesh({
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0, 3, 0.5, 0],
        faces: [
          [0, 1, 2],
          [1, 4, 6, 5, 2],
        ],
      }),
    );
    doc.addObject({ name: 'Shapes', type: 'MESH', data: shapes });
    expect(estimateRender(doc).triangles).toBe(12 + 1 + 3);
  });

  it('reports what the first worker evaluated beyond what it compiled: objects hidden in renders', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    doc.addObject({
      name: 'Hidden',
      type: 'MESH',
      data: cube.data,
      hide_render: true,
      modifiers: [modifier('s', 'SUBSURF', { levels: 0, render_levels: 2 })],
    });
    const info = await preparedInfo(doc, 24, 16);
    expect([info.triangles, info.evaluatedTriangles, info.instances]).toEqual([12, 12 + 2 * 96, 1]);
    expect(estimateRender(doc)).toMatchObject({
      triangles: 12,
      evaluatedTriangles: 12 + 2 * 96,
      instances: 1,
    });
  });

  it('counts Array copies that fit a length from the size of the mesh, through the modifiers before it', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    // 2 m cube, copies 2 m apart to fill 9 m: 5 copies of the 12 triangles
    doc.updateObject(cube.id, {
      modifiers: [
        modifier('t', 'TRIANGULATE', {}),
        modifier('a', 'ARRAY', {
          fit_type: 'FIT_LENGTH',
          fit_length: 9,
          relative_offset_displace: [1, 0, 0],
        }),
      ],
    });
    expect(estimateRender(doc).triangles).toBe(5 * 12);
    expect((await preparedInfo(doc, 24, 16)).triangles).toBe(5 * 12);
  });

  it('measures the size of a mesh an Array fits to a length once per decoded mesh, again once it changes', () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, {
      modifiers: [
        modifier('a', 'ARRAY', {
          fit_type: 'FIT_LENGTH',
          fit_length: 9,
          relative_offset_displace: [1, 0, 0],
        }),
      ],
    });
    // the reads of the decoded mesh's vertex positions (its size along the offset is measured from them)
    let reads = 0;
    const getMesh = doc.getMesh.bind(doc);
    const counted = new WeakMap<object, MeshData>();
    doc.getMesh = (id: string) => {
      const m = getMesh(id);
      if (!m) return m;
      let c = counted.get(m);
      if (!c) {
        c = new Proxy(m, { get: (t, k) => (k === 'positions' && reads++, Reflect.get(t, k)) });
        counted.set(m, c);
      }
      return c;
    };
    // 2 m cube, copies 2 m apart to fill 9 m: 5 copies; the next render of the same mesh reads nothing
    expect(estimateRender(doc).triangles).toBe(5 * 12);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    expect(estimateRender(doc).triangles).toBe(5 * 12);
    expect(reads).toBe(0);
    // a cube half as large, measured from the new mesh: copies 1 m apart fill 9 m with 10
    const half = getMesh(cube.data!)!;
    doc.setMesh(cube.data!, { ...half, positions: half.positions.map((v) => v / 2) });
    expect(estimateRender(doc).triangles).toBe(10 * 12);
    expect(reads).toBeGreaterThan(0);
  });

  it('estimates the heap the modifiers of one object take while the first worker evaluates them', () => {
    const doc = SceneDoc.create();
    expect(estimateRender(doc).evaluationHeap).toBe(0);
    const cube = doc.findObjectByName('Cube')!;
    const size = meshSize(doc.getMesh(cube.data!)!);
    const sub2 = modifier('s', 'SUBSURF', { render_levels: 2 });
    const peak = (m: ModifierData, input = size) => estimateModifier(m, input, { forRender: true });
    // one modifier: its estimated peak (core estimateModifier, as the server counts it)
    doc.updateObject(cube.id, { modifiers: [sub2] });
    expect(estimateRender(doc).evaluationHeap).toBe(peak(sub2).bytes);
    expect(peak(sub2).bytes).toBeGreaterThan(0);
    // a stack: the peaks of its modifiers add up, each from the result of the one before
    const array = modifier('a', 'ARRAY', { count: 3 });
    doc.updateObject(cube.id, { modifiers: [sub2, array] });
    expect(peak(array, peak(sub2).result).bytes).toBeGreaterThan(0);
    const stack = peak(sub2).bytes + peak(array, peak(sub2).result).bytes;
    expect(estimateRender(doc).evaluationHeap).toBe(stack);
    // objects are evaluated one after the other: the largest stack counts, not their sum
    const other = doc.addObject({ name: 'Other', type: 'MESH', data: cube.data, modifiers: [sub2] });
    expect(estimateRender(doc).evaluationHeap).toBe(stack);
    // an object hidden in renders is evaluated all the same
    doc.updateObject(other, { hide_render: true });
    doc.updateObject(cube.id, { modifiers: [] });
    expect(estimateRender(doc).evaluationHeap).toBe(peak(sub2).bytes);
    // text: its glyphs (core TEXT_BYTES_PER_CHARACTER, as the server counts them)
    doc.updateObject(other, { modifiers: [] });
    const text = doc.addCurve({ body: 'Hi there' });
    doc.addObject({ name: 'Text', type: 'FONT', data: text });
    expect(estimateRender(doc).evaluationHeap).toBe(7 * TEXT_BYTES_PER_CHARACTER);
  });

  it('counts the points core samples from splines for renders, without sampling them', () => {
    const curve = (splines: Spline[], render_resolution_u: number): CurveData => ({
      ...defaultCurve('c', 'c'),
      splines,
      resolution_u: 2,
      render_resolution_u,
    });
    const cases: Spline[] = [
      wave('BEZIER', 9),
      wave('BEZIER', 9, true),
      // straight segments between two VECTOR handles: their start point only
      wave('BEZIER', 9, false, (i) => (i % 3 ? 'VECTOR' : 'AUTO')),
      wave('NURBS', 9),
      wave('NURBS', 9, true),
      // cyclic with two points: sampled open
      wave('NURBS', 2, true),
      wave('POLY', 9, true),
      // a spline that would pass 250,000 points: core lowers its resolution
      wave('BEZIER', 300),
    ];
    for (const s of cases)
      for (const res of [12, 1024]) {
        const c = curve([s], res);
        const sampled = evaluateCurveSplines(c, true)[0];
        expect(splineSampleCount(c, s)).toEqual({ points: sampled.points.length, cyclic: sampled.cyclic });
        // the viewport's resolution when not rendering
        expect(splineSampleCount(c, s, false).points).toBe(evaluateCurveSplines(c, false)[0].points.length);
      }
    expect(splineSampleCount(curve([wave('BEZIER', 300)], 1024), wave('BEZIER', 300)).points).toBe(
      299 * 833 + 1,
    );
  });

  it('counts no surface for a curve core would not build: over 3,000,000 vertices', () => {
    const doc = SceneDoc.create({ empty: true });
    // a ring of 68 points along 15 × 1024 + 1 samples: 1,044,548 vertices, built
    const built = cable(doc, 16, 1024, 32);
    const surface = (id: string) =>
      curveSurfaceSize(doc, doc.getCurve(doc.getObject(id)!.data!)!, false).surface.faces;
    expect(surface(built)).toBe(15 * 1024 * 68);
    // 63 × 1024 + 1 samples: 4,386,884 vertices; core builds none (a wire, which renders nothing)
    const dense = cable(doc, 64, 1024, 32);
    const curve = doc.getCurve(doc.getObject(dense)!.data!)!;
    expect(curveToMesh(curve, { forRender: true, isText: false }).mesh).toBeNull();
    expect(surface(dense)).toBe(0);
  });

  it('counts a Boolean modifier with the faces of its operand as evaluated', () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    const operand = doc.addObject({
      name: 'Cutter',
      type: 'MESH',
      data: cube.data,
      hide_render: true,
      modifiers: [modifier('s', 'SUBSURF', { render_levels: 2 })],
    });
    const bool = modifier('b', 'BOOLEAN', { object: operand, operation: 'UNION' });
    doc.updateObject(cube.id, { modifiers: [bool] });
    const size = meshSize(doc.getMesh(cube.data!)!);
    const result = estimateModifier(bool, size, { forRender: true, operandFaces: () => 96 }).result;
    expect(result.faces).toBe(6 + 96);
    expect(estimateRender(doc).triangles).toBe(result.corners - 2 * result.faces);
  });

  it('counts the surfaces of curves and text as core builds them, without building them', async () => {
    const doc = SceneDoc.create({ empty: true });
    // 5 spans × 24 samples + 1 points, a ring of 12: 120 × 12 quads
    cable(doc, 6, 24, 4);
    const curve = estimateRender(doc);
    expect(curve).toMatchObject({ triangles: 2 * 120 * 12, evaluatedTriangles: 2 * 120 * 12, instances: 1 });
    const exact = await preparedInfo(doc, 24, 16);
    expect([exact.triangles, exact.evaluatedTriangles, exact.instances]).toEqual([
      2 * 120 * 12,
      2 * 120 * 12,
      1,
    ]);
    // text: its glyph outlines filled and extruded (the fills are counted at their largest)
    const text = doc.addCurve({ body: 'Path Tracer', extrude: 0.05, render_resolution_u: 6 });
    doc.addObject({ name: 'Text', type: 'FONT', data: text });
    const both = estimateRender(doc);
    const built = (await preparedInfo(doc, 24, 16)).triangles;
    expect(built).toBeGreaterThan(exact.triangles + 500);
    expect(both.triangles).toBeGreaterThanOrEqual(built);
    expect(both.triangles).toBeLessThan(built * 1.1);
    // a curve without bevel or extrusion has no surface: nothing to render
    doc.updateCurve(doc.getObject(doc.findObjectByName('Cable')!.id)!.data!, { bevel_depth: 0 });
    expect(estimateRender(doc).triangles).toBe(both.triangles - 2 * 120 * 12);
  });

  it('counts the scene at the frame it renders: keyed and driven curve values, keyed modifier settings and shape keys', async () => {
    const doc = scene();
    // a cable stored without a bevel (a wire, which renders nothing) whose bevel depth is keyed: a
    // tube at frame 1, none from frame 10; its render resolution driven to 24 samples per span
    const data = doc.getObject(cable(doc, 6, 4, 4))!.data!;
    doc.updateCurve(data, { bevel_depth: 0 });
    key(doc, 'curve', data, 'bevel_depth', [
      [1, 0.05],
      [10, 0],
    ]);
    doc.setDriver({
      target_type: 'curve',
      target_id: data,
      path: 'render_resolution_u',
      index: 0,
      expression: '24',
      variables: [],
      mute: false,
    });
    // the cube subdivided twice in renders by a keyed render_levels (once as stored)
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })] });
    key(doc, 'object', cube.id, 'modifiers["Sub"].render_levels', [[1, 2]]);
    // 5 spans × 24 samples + 1 points, a ring of 12: 120 × 12 quads; the cube's 6 × 4² quads
    const atFrame = estimateRender(doc, true, 1);
    expect(atFrame).toMatchObject({ triangles: 2 * 120 * 12 + 2 * 6 * 16, instances: 2 });
    const exact = await preparedInfo(doc, 24, 16, 1);
    expect([exact.triangles, exact.instances]).toEqual([atFrame.triangles, atFrame.instances]);
    // the curve's surface is built before any modifier runs: what the first worker holds as stored
    expect(atFrame.storedTriangles).toBe(2 * 120 * 12);
    // no tube at frame 10, and none as stored, where the cube is subdivided once
    expect(estimateRender(doc, true, 10).triangles).toBe(2 * 6 * 16);
    expect((await preparedInfo(doc, 24, 16, 10)).triangles).toBe(2 * 6 * 16);
    expect(estimateRender(doc).triangles).toBe(2 * 6 * 4);
    // two objects of one mesh with a shape key keyed from 0: one geometry each at frame 1
    const keyed = scene();
    const box = keyed.findObjectByName('Cube')!;
    keyed.addObject({ name: 'Twin', type: 'MESH', data: box.data, location: [3, 0, 0] });
    const positions = new Float32Array(keyed.getMesh(box.data!)!.positions);
    keyed.setShapeKeys(box.data!, [
      {
        name: 'Key',
        value: 0,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: new Uint8Array(positions.map((p) => p * 1.2).buffer),
      },
    ]);
    key(keyed, 'mesh', box.data!, 'shape_keys["Key"].value', [[1, 0.5]]);
    expect((await preparedInfo(keyed, 24, 16, 1)).evaluatedTriangles).toBe(24);
    expect(estimateRender(keyed, true, 1).evaluatedTriangles).toBe(24);
    expect(estimateRender(keyed).evaluatedTriangles).toBe(12);
  });

  it('counts bevel objects, clamped bevel resolutions, end caps and glyph fills with holes as core builds them', () => {
    const doc = SceneDoc.create({ empty: true });
    const point = (co: [number, number, number]) => ({
      co,
      handle_left: null,
      handle_right: null,
      handle_left_type: 'AUTO' as const,
      handle_right_type: 'AUTO' as const,
      radius: 1,
      tilt: 0,
      weight: 1,
    });
    // a closed 2D profile, the bevel object of a cable
    const profile = doc.addCurve({
      dimensions: '2D',
      splines: [
        { ...wave('BEZIER', 3, true), points: [point([0, 0, 0]), point([0.1, 0.1, 0]), point([0.2, 0, 0])] },
      ],
    });
    const profileObject = doc.addObject({ name: 'Profile', type: 'CURVE', data: profile });
    const base = (o: Partial<CurveData>): CurveData => ({ ...defaultCurve('c', 'c'), ...o });
    const built = (curve: CurveData, isText = false) => {
      const m = curveToMesh(curve, {
        forRender: true,
        isText,
        getBevelCurve: (id) => {
          const o = doc.getObject(id);
          return o?.type === 'CURVE' && o.data ? doc.getCurve(o.data) : null;
        },
        getBevelScale: () => [1, 1],
      }).mesh;
      return m ? meshSize(m) : { faces: 0, corners: 0, vertices: 0 };
    };
    const tris = (m: { faces: number; corners: number }) => m.corners - 2 * m.faces;
    const exact: [string, CurveData][] = [
      [
        'bevel object',
        base({
          splines: [wave('BEZIER', 6)],
          render_resolution_u: 16,
          bevel_mode: 'OBJECT',
          bevel_object: profileObject,
        }),
      ],
      // core clamps bevel_resolution to 32
      [
        'bevel resolution 64',
        base({
          splines: [wave('BEZIER', 6)],
          render_resolution_u: 16,
          bevel_depth: 0.05,
          bevel_resolution: 64,
        }),
      ],
      [
        'open sweep with caps',
        base({
          splines: [wave('BEZIER', 8)],
          render_resolution_u: 12,
          bevel_depth: 0.1,
          bevel_resolution: 3,
          use_fill_caps: true,
        }),
      ],
      // a closed spline: a quad between its last and first rings too
      [
        'cyclic sweep',
        base({
          splines: [wave('BEZIER', 6, true)],
          render_resolution_u: 8,
          bevel_depth: 0.05,
          bevel_resolution: 2,
        }),
      ],
    ];
    for (const [name, curve] of exact) {
      const counted = curveSurfaceSize(doc, curve, false).surface;
      expect(counted.faces, name).toBe(built(curve).faces);
      expect(tris(counted), name).toBe(tris(built(curve)));
    }
    expect(tris(curveSurfaceSize(doc, exact[0][1], false).surface)).toBeGreaterThan(1000);
    // flat glyph fills: an 8 has two holes, a B two, an o one; counted at their largest
    for (const body of ['8', 'B', 'o', 'B8%']) {
      const text = base({ body, resolution_u: 12, fill_mode: 'BOTH' });
      const counted = tris(curveSurfaceSize(doc, text, true).surface);
      expect(counted, body).toBeGreaterThanOrEqual(tris(built(text, true)));
      expect(counted, body).toBeLessThan(tris(built(text, true)) * 1.1);
    }
  });

  it('counts a wire curve through its modifiers, and linked meshes with shape keys per object', async () => {
    // a curve without a surface feeds its wire to its modifiers: a Screw makes a surface of it
    const doc = scene();
    const wire = doc.addCurve({ splines: [wave('POLY', 6)], bevel_depth: 0 });
    doc.addObject({
      name: 'Wire',
      type: 'CURVE',
      data: wire,
      modifiers: [modifier('s', 'SCREW', { steps: 8, render_steps: 8 })],
    });
    const est = estimateRender(doc);
    const info = await preparedInfo(doc, 24, 16);
    expect(info.triangles).toBeGreaterThan(12);
    expect(est.triangles).toBeGreaterThanOrEqual(info.triangles);
    // two objects of one mesh with an active shape key: one geometry each
    const keyed = scene();
    const cube = keyed.findObjectByName('Cube')!;
    keyed.addObject({ name: 'Twin', type: 'MESH', data: cube.data, location: [3, 0, 0] });
    const positions = new Float32Array(keyed.getMesh(cube.data!)!.positions);
    keyed.setShapeKeys(cube.data!, [
      {
        name: 'Key',
        value: 0.5,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: new Uint8Array(positions.map((p) => p * 1.2).buffer),
      },
    ]);
    const twins = await preparedInfo(keyed, 24, 16);
    expect(twins.evaluatedTriangles).toBe(24);
    expect(estimateRender(keyed).evaluatedTriangles).toBe(24);
    // muted, they share it again
    keyed.setShapeKeys(cube.data!, [{ ...keyed.getShapeKeys(cube.data!)[0], mute: true }]);
    expect(estimateRender(keyed).evaluatedTriangles).toBe(12);
  });

  it('counts particles as renders and the viewport show them: on or off, display percentage, grid lattice', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    const tri = doc.addObject({ name: 'Tri', type: 'MESH', data: cube.data, location: [10, 0, 0] });
    const system = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
      { id: 'p', name: 'P', show_viewport: true, show_render: true, settings, ...extra },
    ];
    // 40 particles, 25% of them in the viewport; off in renders
    doc.updateObject(cube.id, {
      particle_systems: system(
        {
          count: 40,
          display_percentage: 25,
          instance_type: 'OBJECT',
          instance_object: tri,
          particle_size: 0.05,
        },
        { show_render: false },
      ) as never,
    });
    expect([estimateRender(doc).instances, (await preparedInfo(doc, 24, 16)).instances]).toEqual([2, 2]);
    // the viewport (the page's own heap) shows a quarter of them
    expect(estimateRender(doc, false).instances).toBe(2 + 10);
    // (the cube and the instanced copy share their mesh: 12 triangles; 4 objects)
    expect(pageHeapEstimate(doc)).toBe(
      PAGE_HEAP_BYTES.base +
        4 * PAGE_HEAP_BYTES.object +
        12 * PAGE_HEAP_BYTES.triangle +
        12 * INSTANCE_BYTES.heap,
    );
    // a grid of 4 cells along each side, emitted from the cube's volume: up to 4³ lattice points
    doc.updateObject(cube.id, {
      particle_systems: system({
        distribution: 'GRID',
        grid_resolution: 4,
        emit_from: 'VOLUME',
        instance_type: 'OBJECT',
        instance_object: tri,
        particle_size: 0.05,
      }) as never,
    });
    expect(estimateRender(doc).instances).toBe(2 + 4 ** 3);
    expect((await preparedInfo(doc, 24, 16)).instances).toBe(2 + 4 ** 3);
  });

  it("counts the page's heap from what it keeps for the viewport: objects, decoded meshes, built geometry", () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    // objects hidden in renders too: the cube (3 objects, its 12 triangles)
    doc.updateObject(cube.id, { hide_render: true });
    expect(estimateRender(doc, false)).toMatchObject({
      triangles: 0,
      evaluatedTriangles: 12,
      meshTriangles: 12,
    });
    const base = PAGE_HEAP_BYTES.base + 3 * PAGE_HEAP_BYTES.object;
    expect(pageHeapEstimate(doc)).toBe(base + 12 * PAGE_HEAP_BYTES.triangle);
    // a modifier stack keeps its input besides its result: the stored cube and the 48 triangles of
    // its subdivision (the page held 105 MiB for a 360 × 360 grid and its subdivision, 85 bytes per
    // triangle of both)
    doc.updateObject(cube.id, { modifiers: [modifier('s', 'SUBSURF', { levels: 1, render_levels: 0 })] });
    expect(estimateRender(doc, false)).toMatchObject({
      evaluatedTriangles: 48,
      meshTriangles: 12,
      builtTriangles: 48,
    });
    expect(pageHeapEstimate(doc)).toBe(base + (12 + 48) * PAGE_HEAP_BYTES.triangle);
    // a linked copy shares the decoded mesh: one more object, the same 12 triangles
    doc.updateObject(cube.id, { modifiers: [] });
    doc.addObject({ name: 'Copy', type: 'MESH', data: cube.data, location: [3, 0, 0] });
    expect(pageHeapEstimate(doc)).toBe(
      base + PAGE_HEAP_BYTES.object + 12 * PAGE_HEAP_BYTES.triangle + INSTANCE_BYTES.heap,
    );
  });

  it('counts particle and collection instances, and the objects they instance, hidden or not', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    const plane = doc.addMesh(
      'Plane',
      createMesh({ positions: [-4, -4, 0, 4, -4, 0, 4, 4, 0, -4, 4, 0], faces: [[0, 1, 2, 3]] }),
    );
    const emitter = doc.addObject({ name: 'Emitter', type: 'MESH', data: plane, location: [0, 0, -2] });
    doc.updateObject(emitter, {
      particle_systems: [
        {
          id: 'p',
          name: 'P',
          show_viewport: true,
          show_render: true,
          settings: { count: 30, instance_type: 'OBJECT', instance_object: cube.id, particle_size: 0.1 },
        },
      ],
    });
    // the cube is instanced: compiled though it is hidden in renders
    doc.updateObject(cube.id, { hide_render: true });
    const est = estimateRender(doc);
    const info = await preparedInfo(doc, 24, 16);
    expect([est.triangles, est.instances]).toEqual([12 + 2, 30 + 1]);
    expect([info.triangles, info.instances]).toEqual([12 + 2, 30 + 1]);
    // a collection instance: the objects of its (hidden) collection, once per instance
    const parts = doc.addCollection({ name: 'Parts', hide_viewport: true });
    const part = doc.addMesh(
      'Tri',
      createMesh({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] }),
    );
    doc.addObject({ name: 'Part', type: 'MESH', data: part, collection: parts });
    doc.addObject({
      name: 'Instancer',
      type: 'EMPTY',
      instance_type: 'COLLECTION',
      instance_collection: parts,
    });
    const withCollection = estimateRender(doc);
    const exact = await preparedInfo(doc, 24, 16);
    expect([withCollection.triangles, withCollection.instances]).toEqual([12 + 2 + 1, 30 + 1 + 1]);
    expect([exact.triangles, exact.instances]).toEqual([12 + 2 + 1, 30 + 1 + 1]);
  });

  it('plans as many workers as the memory allows, and refuses with an explanation when one does not fit', () => {
    const needs = { triangles: 1_045_750, sceneBytes: 166_164_585, pixels: 1280 * 720 };
    // the heavy scene measured in Chrome fits 4 workers into a 4 GB budget
    expect(planRenderThreads(needs, 4, roomy)).toEqual({ threads: 4, limited: false, refusal: null });
    // a budget for 2 of them
    const two = renderMemory(needs, 2).total;
    expect(planRenderThreads(needs, 4, { ...roomy, budget: two })).toEqual({
      threads: 2,
      limited: true,
      refusal: null,
    });
    // the second worker: its own heap, a copy of the compiled scene, and the page's copy it is handed
    // with one more on its way; every further worker its own heap and copy
    const one = renderMemory(needs, 1).total;
    expect(two - one).toBe(WORKER_BASE_BYTES + 3 * needs.sceneBytes);
    expect(renderMemory(needs, 3).total - two).toBe(WORKER_BASE_BYTES + needs.sceneBytes);
    // the image: the page's film and preview, and the denoising worker's
    expect(
      renderMemory({ ...needs, pixels: 1000 }, 1).total - renderMemory({ ...needs, pixels: 0 }, 1).total,
    ).toBe(1000 * (PAGE_BYTES_PER_PIXEL + FINISH_BYTES_PER_PIXEL));
    // the first worker's heap: what it evaluated (more than it compiles when objects are hidden in
    // renders), its instances and the evaluation still to come, in the total and in the heap
    const more = {
      ...needs,
      evaluatedTriangles: needs.triangles + 1000,
      instances: 10,
      evaluationHeap: 5 * MB,
    };
    const extra = 1000 * PREPARE_BYTES_PER_TRIANGLE.heap + 10 * INSTANCE_BYTES.heap + 5 * MB;
    expect(renderMemory(more, 2).heap - renderMemory(needs, 2).heap).toBe(extra);
    expect(renderMemory(more, 2).total - renderMemory(needs, 2).total).toBe(extra);
    expect(renderMemory(needs, 2).heap - renderMemory(needs, 1).heap).toBe(WORKER_BASE_BYTES);
    // not even one: refused, with the numbers and what to do
    const tight = planRenderThreads(needs, 4, { ...roomy, budget: 0.5 * GB, deviceGB: 1 });
    expect(tight.threads).toBe(0);
    expect(tight.refusal).toMatch(
      /^Path tracing was not started: it needs about \d+\.\d GB of memory with one render thread, more than the 0\.5 GB a render may use in this tab \(half the device memory the browser reports, 1 GB, at most 4\.0 GB\)/,
    );
    expect(tight.refusal).toContain('(about 1.0 million triangles, 921,600 pixels)');
    // a browser that does not report the device memory (Firefox, Safari)
    expect(planRenderThreads(needs, 4, { ...roomy, budget: 0.5 * GB, deviceGB: null }).refusal).toContain(
      'more than the 0.5 GB a render may use in this tab (half the device memory, taken as 8 GB where the browser does not report it, at most 4.0 GB)',
    );
    // other path traced renders running in the tab hold all of it: none is left, not "0.0 GB left"
    expect(
      planRenderThreads(needs, 4, {
        ...roomy,
        budget: 0.5 * GB,
        deviceGB: 1,
        held: { total: 0.6 * GB, heap: 0 },
      }).refusal,
    ).toMatch(
      /^Path tracing was not started: it needs about \d+\.\d GB of memory with one render thread, and none is left of the 0\.5 GB a render may use in this tab \(half the device memory the browser reports, 1 GB, at most 4\.0 GB\): other path traced renders running in it hold 0\.6 GB \(about 1\.0 million triangles/,
    );
    // small scenes by their count
    expect(planRenderThreads({ ...needs, triangles: 12 }, 4, { ...roomy, budget: 0 }).refusal).toContain(
      '(about 12 triangles, 921,600 pixels)',
    );
    // objects hidden in renders, evaluated all the same, named when they hold much of it
    expect(
      planRenderThreads({ ...needs, evaluatedTriangles: needs.triangles + 400_000 }, 4, {
        ...roomy,
        budget: 0,
      }).refusal,
    ).toContain(
      '(about 1.4 million triangles, 0.4 million of them in objects hidden in renders, which are evaluated all the same, 921,600 pixels)',
    );
    expect(tight.refusal).toContain('running out of memory would end the tab');
    // the image counts towards the memory, and the RASTER engine is suggested only where a RASTER
    // render of the scene fits the page (rasterRefusal)
    expect(tight.refusal).toMatch(
      /Lower the resolution or the triangles \(subdivision render levels, curve and text render resolution, objects in the scene\)\.$/,
    );
    expect(
      planRenderThreads({ ...needs, rasterFits: true }, 4, { ...roomy, budget: 0.5 * GB, deviceGB: 1 })
        .refusal,
    ).toMatch(
      /Lower the resolution or the triangles \(subdivision render levels, curve and text render resolution, objects in the scene\), or render with the RASTER engine\.$/,
    );
    // the JavaScript heap of the tab (Chrome: one 4 GB cage for the page and its workers)
    const full = planRenderThreads(needs, 4, { ...roomy, heapUsed: 3.1e9 });
    expect(full.threads).toBe(0);
    expect(full.refusal).toMatch(
      /its render thread needs about 0\.\d\d GB of JavaScript heap, more than the 0\.09 GB the tab has left for it: a render may fill 2\.98 GB of its 3\.50 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working, and the page is estimated to use 2\.89 GB of that/,
    );
    // ... the heap other path traced renders hold in it included
    const heap = renderMemory(needs, 1).heap;
    const room = usableHeap(roomy.heapLimit) - roomy.heapUsed;
    expect(planRenderThreads(needs, 1, { ...roomy, held: { total: 0, heap: room - heap - 1 } }).threads).toBe(
      1,
    );
    const others = room - heap + 1;
    const held = planRenderThreads(needs, 1, { ...roomy, held: { total: 0, heap: others } });
    expect(held.threads).toBe(0);
    const figures = held.refusal!.match(
      /more than the (\d\.\d+) GB the tab has left for it: a render may fill (\d\.\d+) GB of its \d\.\d+ GB heap limit, .*, and the page and the path traced renders running in it are estimated to use (\d\.\d+) GB of that/,
    );
    expect(figures, held.refusal!).not.toBeNull();
    // one byte short: three decimals, the need rounded up, the share down and the use up, keep the
    // need and the room apart, and every figure has them
    const digits = figures![3].split('.')[1].length;
    expect(digits).toBe(3);
    expect(figures![3]).toBe((Math.ceil(((roomy.heapUsed + others) / GB) * 1000) / 1000).toFixed(3));
    // the figures add up: the room is the share less what the page and the renders use, as printed
    expect(Math.round((Number(figures![2]) - Number(figures![3])) * 10 ** digits)).toBe(
      Math.round(Number(figures![1]) * 10 ** digits),
    );
  });

  it("keeps the young generation's part of a small JavaScript heap free: a worker runs out at its old generation", () => {
    // Chrome 153 with --max-old-space-size=400 reports a limit of 497 MB: a worker's old generation is
    // full at 400 MB, below 0.85 of the limit (422 MB)
    const limit = 497 * MB;
    expect(usableHeap(limit)).toBe(limit - YOUNG_GENERATION_BYTES);
    expect(usableHeap(limit)).toBeLessThan(400 * MB);
    // the default limit (3,586 MB): 0.85 of it
    expect(usableHeap(3586 * MB)).toBe(3586 * MB * JS_HEAP_SHARE);
    // none of a limit smaller than the young generation
    expect(usableHeap(100 * MB)).toBe(0);
    // a render thread of 380 MB of heap: within 0.85 of the limit, not within its old generation
    const tab = { ...roomy, heapLimit: limit, heapUsed: 0 };
    const needs: RenderNeeds = {
      triangles: 0,
      sceneBytes: 0,
      pixels: 0,
      evaluationHeap: 380 * MB - WORKER_BASE_BYTES,
    };
    expect(renderMemory(needs, 1).heap).toBeLessThan(limit * JS_HEAP_SHARE);
    const refused = planRenderThreads(needs, 1, tab);
    expect(refused.threads).toBe(0);
    expect(refused.refusal).toContain(
      "its render thread needs about 0.37 GB of JavaScript heap, more than the 0.35 GB the tab has left for it: a render may fill 0.35 GB of its 0.49 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working (about",
    );
    expect(
      planRenderThreads({ ...needs, evaluationHeap: 340 * MB - WORKER_BASE_BYTES }, 1, tab).threads,
    ).toBe(1);
  });

  it("estimates a Bevel's heap as Chrome takes it: per input face or vertex, edge and corner it bevels, face it adds", () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    const size = meshSize(doc.getMesh(cube.data!)!);
    // on every edge (limit_method NONE): core counts what it adds (12 edges of 2 faces, 8 corners of
    // 4), and its own heap per face is Node's
    const none = modifier('b', 'BEVEL', { width: 0.1, segments: 2, limit_method: 'NONE' });
    doc.updateObject(cube.id, { modifiers: [none] });
    const core = estimateModifier(none, size, { forRender: true });
    const added = core.result.faces - size.faces;
    expect(added).toBe(Math.round((size.corners / 2) * 2 + size.vertices * 4));
    const browser = bevelHeap(size, added, size.corners / 2 + size.vertices);
    expect(browser).toBe(
      BEVEL_HEAP_BYTES.input * 8 + BEVEL_HEAP_BYTES.element * (12 + 8) + BEVEL_HEAP_BYTES.face * added,
    );
    expect(estimateRender(doc).evaluationHeap).toBe(browser);
    expect(core.bytes).toBeGreaterThan(2 * browser);
    // by angle (the default): no face counted, the topology it builds all the same
    doc.updateObject(cube.id, { modifiers: [modifier('b', 'BEVEL', { width: 0.1, segments: 2 })] });
    expect(estimateRender(doc).evaluationHeap).toBe(BEVEL_HEAP_BYTES.input * 8);
    // other modifiers as core estimates them
    const sub = modifier('s', 'SUBSURF', { render_levels: 2 });
    doc.updateObject(cube.id, { modifiers: [sub] });
    expect(estimateRender(doc).evaluationHeap).toBe(estimateModifier(sub, size, { forRender: true }).bytes);
  });

  it('prepares on one worker; the others adopt a copy of its compiled scene and render the same image', async () => {
    const doc = scene();
    // the first worker reports the size of what the others copy: the cube's 12 triangles and the
    // typed arrays of the compiled scene (its BVH, the camera, the materials)
    const info = await preparedInfo(doc, 24, 16);
    expect([info.triangles, info.evaluatedTriangles, info.instances]).toEqual([12, 12, 1]);
    expect(info.sceneBytes).toBeGreaterThan(12 * 36);
    expect(info.sceneBytes).toBeLessThan(MB);
    const reference = renderSceneSoftware(doc, { width: 24, height: 16, engine: 'PATHTRACER', samples: 3 });
    const { pool, sent } = recordingPool(4);
    const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 3, memory: roomy });
    const r = await job.result;
    expect(Buffer.from(r.data).equals(Buffer.from(reference.data))).toBe(true);
    expect([r.threads, r.limitedByMemory]).toEqual([4, false]);
    // only the first worker gets the document
    expect(sent[0]).toContain('prepare:full');
    expect(sent[0]).toContain('share');
    for (const s of sent.slice(1)) {
      expect(s.filter((t) => t.startsWith('prepare'))).toEqual([]);
      expect(s).toContain('adopt');
    }
  });

  it('frees the compiled scene of a job with its tracer when the job is released', async () => {
    const engine = new RenderWorkerEngine(null);
    const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
    await engine.prepare(7, new DocumentSnapshot(scene()).payload(thread), { width: 8, height: 8, frame: 1 });
    expect(engine.share(7).scene.geometries.length).toBe(1);
    engine.release(7);
    expect(() => engine.share(7)).toThrow(/render job 7 is not prepared on this worker/);
    expect(() => engine.rows(7, 0, 1, 0, 1)).toThrow(/render job 7 is not prepared on this worker/);
  });

  it('renders with fewer workers when the tab has memory for fewer, and says so', async () => {
    const doc = scene();
    const needs = needsOf(await preparedInfo(doc, 24, 16));
    const memory = { ...roomy, budget: renderMemory(needs, 2).total };
    const reference = renderSceneSoftware(doc, { width: 24, height: 16, engine: 'PATHTRACER', samples: 3 });
    const { pool, sent } = recordingPool(4);
    const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 3, memory });
    const r = await job.result;
    expect(Buffer.from(r.data).equals(Buffer.from(reference.data))).toBe(true);
    expect([r.threads, r.limitedByMemory, job.status.limitedByMemory]).toEqual([2, true, true]);
    expect(sent[1]).toContain('adopt');
    expect(sent[1]).toContain('rows');
    // the workers beyond the memory get no part of the render
    for (const s of sent.slice(2)) expect(s.filter((t) => t !== 'release')).toEqual([]);
    // the render window says why it renders with fewer threads
    const info = (limitedByMemory: boolean) =>
      pathTraceInfo(
        {
          status: { ...job.status, phase: 'rendering', threads: 2, limitedByMemory },
          elapsedMs: 1000,
          width: 24,
          height: 16,
        },
        1,
      );
    expect(info(true)).toContain('| 2 threads (memory) |');
    expect(info(false)).toContain('| 2 threads |');
  });

  it('refuses a render that does not fit one worker before any worker starts, with the reason', async () => {
    const doc = scene();
    const { pool, started } = recordingPool(4);
    const memory = { ...roomy, budget: 64 * MB, deviceGB: 0.125 };
    // 1024×1024 pixels need about 240 MB for the film, the preview and denoising
    const job = startPathTrace(pool, doc, { width: 1024, height: 1024, frame: 1, samples: 1, memory });
    await expect(job.result).rejects.toThrow(
      /^Path tracing was not started: it needs about 0\.\d GB of memory with one render thread, more than the 0\.1 GB a render may use in this tab/,
    );
    expect(job.status.phase).toBe('failed');
    expect(job.status.error).toMatch(/Lower the resolution or the triangles/);
    expect(started).toEqual([]);
  });

  it('refuses a render of curves that are dense only in renders before any worker starts', async () => {
    const doc = scene();
    // 15 spans × 16 samples + 1 points, a ring of 20: 9,600 triangles in renders, 600 in the viewport
    cable(doc, 16, 16, 8);
    const est = estimateRender(doc);
    expect(est.triangles).toBe(12 + 2 * 240 * 20);
    expect(estimateRender(doc, false).triangles).toBe(12 + 2 * 15 * 20);
    const cubeOnly = renderMemory(estimatedNeeds(estimateRender(scene()), 24 * 16), 1).total;
    const withCable = renderMemory(estimatedNeeds(est, 24 * 16), 1).total;
    // room for the cube, not for the cable's render surface: refused before any worker evaluates it
    const { pool, started } = recordingPool(2);
    const memory = { ...roomy, budget: (cubeOnly + withCable) / 2, deviceGB: 0.25 };
    const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory });
    await expect(job.result).rejects.toThrow(
      /^Path tracing was not started: .*\(about 9,612 triangles, 384 pixels\)/,
    );
    expect(started).toEqual([]);
    // with room for it, it renders
    const r = await startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1,
      memory: { ...roomy, budget: withCable },
    }).result;
    expect(r.threads).toBeGreaterThan(0);
  });

  it('refuses before any worker starts a curve whose surface only its keyed bevel depth makes', async () => {
    const doc = scene();
    // stored without a bevel: a wire, nothing to render; keyed at frame 1: 15 spans × 16 samples + 1
    // points, a ring of 20, 9,600 triangles the first worker builds before any modifier runs
    const data = doc.getObject(cable(doc, 16, 16, 8))!.data!;
    doc.updateCurve(data, { bevel_depth: 0 });
    key(doc, 'curve', data, 'bevel_depth', [[1, 0.05]]);
    const stored = renderMemory(estimatedNeeds(estimateRender(doc), 24 * 16), 1).total;
    const atFrame = renderMemory(estimatedNeeds(estimateRender(doc, true, 1), 24 * 16), 1).total;
    expect(atFrame).toBeGreaterThan(stored);
    // room for the cube, not for the tube: refused before any worker evaluates it
    const { pool, started } = recordingPool(2);
    const memory = { ...roomy, budget: (stored + atFrame) / 2, deviceGB: 0.25 };
    const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory });
    await expect(job.result).rejects.toThrow(
      /^Path tracing was not started: .*\(about 9,612 triangles, 384 pixels\)/,
    );
    expect(started).toEqual([]);
    // with room for it, it renders
    const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory: roomy })
      .result;
    expect(r.threads).toBeGreaterThan(0);
  });

  it('plans a render of another frame than the viewport shows from the scene at the frame it renders', async () => {
    const doc = scene();
    // a wire at frame 1, the frame the viewport shows; a tube from frame 10 on (keyed bevel depth)
    const data = doc.getObject(cable(doc, 16, 16, 8))!.data!;
    doc.updateCurve(data, { bevel_depth: 0 });
    key(doc, 'curve', data, 'bevel_depth', [
      [1, 0],
      [10, 0.05],
    ]);
    const wire = renderMemory(estimatedNeeds(estimateRender(doc, true, 1), 24 * 16), 1).total;
    const tube = renderMemory(estimatedNeeds(estimateRender(doc, true, 10), 24 * 16), 1).total;
    expect(tube).toBeGreaterThan(wire);
    // room for the wire, not for the tube: a render of frame 10 (Render Animation, render_image with
    // a frame) is refused before any worker starts
    const { pool, started } = recordingPool(2);
    const memory = { ...roomy, budget: (wire + tube) / 2, deviceGB: 0.25 };
    const job = startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 10,
      pageFrame: 1,
      samples: 1,
      memory,
    });
    await expect(job.result).rejects.toThrow(
      /^Path tracing was not started: .*\(about 9,612 triangles, 384 pixels\)/,
    );
    expect(started).toEqual([]);
    // and one of frame 1 renders
    const r = await startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 1,
      pageFrame: 1,
      samples: 1,
      memory,
    }).result;
    expect(r.threads).toBeGreaterThan(0);
  });

  it('refuses a render of objects hidden in renders that the first worker would evaluate all the same', async () => {
    const doc = scene();
    doc.updateObject(doc.findObjectByName('Cube')!.id, { hide_render: true });
    // a grid hidden in renders, subdivided for renders: 524,288 triangles the first worker evaluates
    doc.addObject({
      name: 'Hidden grid',
      type: 'MESH',
      data: grid(doc, 32),
      hide_render: true,
      modifiers: [modifier('s', 'SUBSURF', { levels: 0, render_levels: 4 })],
    });
    const est = estimateRender(doc);
    expect(est).toMatchObject({ triangles: 0, evaluatedTriangles: 12 + 2 * 4096 * 4 ** 3, instances: 0 });
    const { pool, started } = recordingPool(2);
    const job = startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1,
      memory: { ...roomy, budget: 64 * MB, deviceGB: 0.125 },
    });
    await expect(job.result).rejects.toThrow(
      /\(about 0\.5 million triangles, 0\.5 million of them in objects hidden in renders, which are evaluated all the same, 384 pixels\)/,
    );
    expect(started).toEqual([]);
  });

  it('refuses on the first worker a scene that does not fit once evaluated, before compiling it', async () => {
    // what the estimate did not show (here a stale estimate of nothing) and no modifier checked while
    // the scene was evaluated: the exact triangles, instances and images of what it compiles decide
    const doc = scene();
    const plane = grid(doc, 40);
    doc.addObject({ name: 'Grid', type: 'MESH', data: plane });
    // a linked duplicate: one geometry, evaluated and compiled once, two instances
    doc.addObject({ name: 'Linked', type: 'MESH', data: plane, location: [0, 0, 1] });
    const cube = doc.findObjectByName('Cube')!;
    const image = doc.addImage({
      name: 'Tex',
      mime: 'image/png',
      width: 64,
      height: 32,
      data: new Uint8Array(8),
    });
    doc.updateMaterial(cube.material_slots[0]!, {
      textures: { base_color: { image, scale: [1, 1], offset: [0, 0] } },
    });
    const exact = await preparedInfo(doc, 24, 16);
    expect([exact.triangles, exact.evaluatedTriangles, exact.instances]).toEqual([12 + 3200, 12 + 3200, 3]);
    // decoded images (4 bytes per pixel) count in the estimate too: the materials' and the world's
    const sky = doc.addImage({
      name: 'Sky',
      mime: 'image/png',
      width: 16,
      height: 8,
      data: new Uint8Array(8),
    });
    doc.updateWorld({ environment: 'IMAGE', environment_image: sky });
    expect(estimateRender(doc).imageBytes).toBe(64 * 32 * 4 + 16 * 8 * 4);
    expect(estimatedNeeds(estimateRender(doc), 384).sceneBytes).toBe(
      3212 * COMPILED_BYTES_PER_TRIANGLE + 3 * INSTANCE_BYTES.scene + 64 * 32 * 4 + 16 * 8 * 4,
    );
    doc.updateWorld({ environment: 'SKY', environment_image: null });
    // what the first worker checks: compiled triangles and instances, and the decoded image
    const checked: RenderNeeds = {
      triangles: 3212,
      evaluatedTriangles: 3212,
      instances: 3,
      sceneBytes: 3212 * COMPILED_BYTES_PER_TRIANGLE + 3 * INSTANCE_BYTES.scene + 64 * 32 * 4,
      pixels: 24 * 16,
    };
    const nothing = {
      triangles: 0,
      evaluatedTriangles: 0,
      storedTriangles: 0,
      instances: 0,
      builtInstances: 0,
      evaluationHeap: 0,
      imageBytes: 0,
      builtTriangles: 0,
      builtBaseTriangles: 0,
      meshTriangles: 0,
    };
    const engine = new RenderWorkerEngine(null);
    const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
    const prepare = (budget: number, job: number, estimate = nothing) =>
      engine.prepare(
        job,
        new DocumentSnapshot(doc).payload(thread),
        { width: 24, height: 16, frame: 1 },
        { ...roomy, budget, deviceGB: 1 },
        estimate,
      );
    // one byte short: refused, with the exact numbers, nothing compiled or kept for the job; a RASTER
    // render of what the estimate says fits the page
    const refused = prepare(renderMemory(checked, 1).total - 1, 1);
    await expect(refused).rejects.toThrow(RenderMemoryError);
    await expect(refused).rejects.toThrow(
      /^Path tracing was not started: it needs about 0\.\d+ GB of memory with one render thread, more than the 0\.\d+ GB a render may use in this tab .*\(about 3,212 triangles, 384 pixels\).*, or render with the RASTER engine\.$/,
    );
    expect(() => engine.share(1)).toThrow(/not prepared/);
    // an estimate whose geometry would not fit the page's heap either: no RASTER engine to suggest
    const heavy = { ...nothing, builtTriangles: 100_000_000 };
    await expect(prepare(renderMemory(checked, 1).total - 1, 7, heavy)).rejects.toThrow(
      /objects in the scene\)\.$/,
    );
    // with that byte it compiles
    expect((await prepare(renderMemory(checked, 1).total, 2)).triangles).toBe(3212);
    // the world's image counts too, on the first worker as in the estimate
    doc.updateWorld({ environment: 'IMAGE', environment_image: sky });
    const withSky = { ...checked, sceneBytes: checked.sceneBytes + 16 * 8 * 4 };
    await expect(prepare(renderMemory(withSky, 1).total - 1, 3)).rejects.toThrow(RenderMemoryError);
    expect((await prepare(renderMemory(withSky, 1).total, 4)).triangles).toBe(3212);
    // a procedural texture samples no image, even with one set in its slot: in neither
    doc.updateWorld({ environment: 'SKY', environment_image: null });
    doc.updateMaterial(cube.material_slots[0]!, {
      textures: {
        base_color: {
          image,
          scale: [1, 1],
          offset: [0, 0],
          procedural: defaultProcedural('NOISE'),
        },
      },
    });
    expect(estimateRender(doc).imageBytes).toBe(0);
    const procedural = { ...checked, sceneBytes: checked.sceneBytes - 64 * 32 * 4 };
    expect((await prepare(renderMemory(procedural, 1).total, 5)).triangles).toBe(3212);
  });

  it("suggests the RASTER engine after the first worker's evaluation only where it fits beside the page's heap", async () => {
    // a cable whose surface only renders and no modifier: nothing is checked while it is evaluated,
    // the first worker refuses it once it is, for a heap of 64 MB a render may fill
    const doc = scene();
    cable(doc, 32, 64, 8);
    const e = estimateRender(doc);
    const raster = rasterNeeds(e).heap;
    const engine = new RenderWorkerEngine(null);
    const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
    const refusal = (pageHeap: number) =>
      engine
        .prepare(
          1,
          new DocumentSnapshot(doc).payload(thread),
          { width: 24, height: 16, frame: 1 },
          { ...roomy, heapLimit: YOUNG_GENERATION_BYTES + 64 * MB, heapUsed: pageHeap },
          e,
        )
        .then(
          () => '',
          (err: Error) => err.message,
        );
    // the page holds 20 MB: a RASTER render of the cable fits beside it
    expect(await refusal(20 * MB)).toMatch(
      /^Path tracing was not started: its render thread needs about .*, or render with the RASTER engine\.$/,
    );
    // the page holds all but half of what a RASTER render of it needs: no RASTER engine to suggest
    const near = await refusal(64 * MB - raster / 2);
    expect(near).toMatch(
      /^Path tracing was not started: its render thread needs about .*objects in the scene\)\.$/,
    );
    expect(near).not.toContain('RASTER');
  });

  it('keeps the document on a worker that refused a render: the next render sends only what changed', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    // a Bevel limited by angle that renders only, refused before it runs while the scene is evaluated
    doc.updateObject(cube.id, {
      modifiers: [modifier('b', 'BEVEL', { width: 0.2, segments: 24 })],
    });
    const estimated = renderMemory(estimatedNeeds(estimateRender(doc), 24 * 16), 1).total;
    const memory = { ...roomy, budget: estimated + 1024 };
    const { pool, sent } = recordingPool(2);
    const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory });
    await expect(job.result).rejects.toThrow(
      /^Path tracing was not started: .*The Bevel modifier 'b' of 'Cube'/,
    );
    expect(sent[0].filter((t) => t !== 'release')).toEqual(['prepare:full']);
    // the same worker renders it with room for it, beveled
    const reference = renderSceneSoftware(doc, { width: 24, height: 16, engine: 'PATHTRACER', samples: 1 });
    const again = await startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1,
      memory: roomy,
    }).result;
    expect(again.threads).toBe(2);
    expect(Buffer.from(again.data).equals(Buffer.from(reference.data))).toBe(true);
    expect(sent[0].filter((t) => t.startsWith('prepare'))).toEqual(['prepare:full', 'prepare:diff']);
  });

  it('refuses a render whose modifiers would not fit while the first worker evaluates them', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { modifiers: [modifier('s', 'SUBSURF', { levels: 0, render_levels: 5 })] });
    const est = estimateRender(doc);
    expect(est.evaluationHeap).toBeGreaterThan(0);
    const needs = { ...estimatedNeeds(est, 24 * 16), evaluationHeap: 0 };
    const scene1 = renderMemory(needs, 1).total;
    const withEvaluation = renderMemory({ ...needs, evaluationHeap: est.evaluationHeap }, 1).total;
    expect(withEvaluation - scene1).toBe(est.evaluationHeap);
    // room for the compiled scene, not for the evaluation that makes it: refused before any worker starts
    const { pool, started } = recordingPool(2);
    const refused = startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1,
      memory: { ...roomy, budget: scene1 + (withEvaluation - scene1) / 2 },
    });
    await expect(refused.result).rejects.toThrow(/^Path tracing was not started: it needs about /);
    expect(started).toEqual([]);
    // with room for both it renders
    const r = await startPathTrace(pool, doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1,
      memory: { ...roomy, budget: withEvaluation },
    }).result;
    expect(r.threads).toBeGreaterThan(0);
  });

  it('counts a render from its start: two started at once share the budget while they prepare', async () => {
    const doc = scene();
    const one = renderMemory(estimatedNeeds(estimateRender(doc), 24 * 16), 1).total;
    const memory = { ...roomy, budget: one * 1.5 };
    const { pool, sent } = recordingPool(2);
    const first = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory });
    // started in the same moment: the first one's worker has not reported its scene yet
    const second = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1, memory });
    await expect(second.result).rejects.toThrow(/of which other path traced renders running in it hold/);
    expect((await first.result).threads).toBeGreaterThan(0);
    // refused before its first worker evaluated anything: only the first render prepared
    expect(sent.flat().filter((t) => t.startsWith('prepare'))).toHaveLength(1);
  });

  it('counts what the path traced renders running in the tab hold: a second one gets what is left', async () => {
    const doc = scene();
    const needs = needsOf(await preparedInfo(doc, 24, 16));
    // memory for a render with 2 workers and one with 1 (each has its first worker and its image)
    const memory = { ...roomy, budget: renderMemory(needs, 2).total + renderMemory(needs, 1).total };
    const { pool } = recordingPool(2);
    const first = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1 << 16, memory });
    await new Promise<void>((resolve) => {
      const off = first.subscribe(() => {
        if (first.status.phase !== 'rendering') return;
        off();
        resolve();
      });
    });
    expect([first.status.threads > 0, first.status.limitedByMemory]).toEqual([true, false]);
    // while the first holds 2 workers' worth, the second fits 1 of its 2
    const second = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 2, memory });
    const r = await second.result;
    expect([r.threads, r.limitedByMemory]).toEqual([1, true]);
    first.cancel();
    await first.result;
    // with the first one over, a render gets the whole budget again
    const third = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 2, memory })
      .result;
    expect([third.threads, third.limitedByMemory]).toEqual([2, false]);
    // and with less than one worker's worth left, the reason names what the others hold
    const big = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1 << 16, memory });
    await new Promise<void>((resolve) => {
      const off = big.subscribe(() => {
        if (big.status.phase !== 'rendering') return;
        off();
        resolve();
      });
    });
    const tight = { ...memory, budget: renderMemory(needs, 2).total + renderMemory(needs, 1).total - 1 };
    const refused = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 2, memory: tight });
    // one byte short: the need rounded up and the room down, three decimals apart
    const message = await refused.result.then(
      () => '',
      (err: Error) => err.message,
    );
    const figures = message.match(
      /it needs about (0\.\d{3}) GB of memory with one render thread, more than the (0\.\d{3}) GB left of the (0\.\d{3}) GB a render may use in this tab \(.*\), (0\.\d{3}) GB of which other path traced renders running in it hold/,
    );
    expect(figures, message).not.toBeNull();
    expect(Number(figures![1])).toBeGreaterThan(Number(figures![2]));
    // the figures add up: the room is the budget less what the others hold, as printed
    expect(Math.round((Number(figures![3]) - Number(figures![4])) * 1000)).toBe(
      Math.round(Number(figures![2]) * 1000),
    );
    big.cancel();
    await big.result;
  });

  it('fails a path traced animation with the reason instead of ending the tab', async () => {
    const doc = scene();
    const { pool } = recordingPool(2);
    const memory = { ...roomy, budget: 64 * MB, deviceGB: 0.125 };
    const anim = startAnimationRender(pool, {
      format: 'APNG',
      frames: [1, 2],
      width: 1024,
      height: 1024,
      fps: 24,
      renderFrame: (frame) => {
        const pt = startPathTrace(pool, doc, { width: 1024, height: 1024, frame, samples: 1, memory });
        return { done: pt.result, cancel: () => pt.cancel(), job: pt };
      },
    });
    await expect(anim.result).rejects.toThrow(/^Path tracing was not started: /);
  });

  it('refuses through the editor pool by the device memory the browser reports (renders for agents)', async () => {
    const nav = navigator as { deviceMemory?: number };
    const before = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', { value: 0.25, configurable: true });
    try {
      expect(tabMemory().budget).toBe(0.125 * GB);
      const r = pathTraceDocument(scene(), { width: 4096, height: 4096, frame: 1, samples: 1 }).result;
      await expect(r).rejects.toThrow(
        /more than the 0\.1 GB a render may use in this tab \(half the device memory the browser reports, 0\.25 GB, at most 4\.0 GB\)/,
      );
      expect(nav.deviceMemory).toBe(0.25);
    } finally {
      if (before) Object.defineProperty(navigator, 'deviceMemory', before);
      else delete (navigator as { deviceMemory?: number }).deviceMemory;
    }
  });
});

describe('RASTER renders on the page', () => {
  it('counts what a RASTER render builds on the page: surfaces and modifier and shape key results, not stored meshes', () => {
    const doc = scene();
    // the default cube as stored: the page has decoded it for the viewport already
    expect(estimateRender(doc)).toMatchObject({ builtTriangles: 0, builtBaseTriangles: 0 });
    const cube = doc.findObjectByName('Cube')!;
    // a Subdivision Surface result (6 quads × 4² at render level 2) is built, from a stored mesh
    doc.updateObject(cube.id, { modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 2 })] });
    expect(estimateRender(doc)).toMatchObject({ builtTriangles: 2 * 6 * 16, builtBaseTriangles: 0 });
    // the viewport's level 0 for the page's own evaluation: the modifier hands its input on
    expect(estimateRender(doc, false)).toMatchObject({ builtTriangles: 0, builtBaseTriangles: 0 });
    // a curve's surface is built before its modifiers, and kept besides their result: 5 spans × 4 + 1
    // points, a ring of 12, and the surface subdivided once
    doc.updateObject(cube.id, { modifiers: [] });
    const cableObject = cable(doc, 6, 4, 4);
    const surface = 2 * 20 * 12;
    expect(estimateRender(doc)).toMatchObject({ builtTriangles: surface, builtBaseTriangles: surface });
    doc.updateObject(cableObject, {
      modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })],
    });
    expect(estimateRender(doc)).toMatchObject({
      builtTriangles: surface + 2 * 4 * (surface / 2),
      builtBaseTriangles: surface,
    });
    // a mesh with a shape key at work and no modifier: the keyed copy is built, the stored one kept
    const keyed = scene();
    const box = keyed.findObjectByName('Cube')!;
    const positions = new Float32Array(keyed.getMesh(box.data!)!.positions);
    keyed.setShapeKeys(box.data!, [
      {
        name: 'Key',
        value: 0.5,
        slider_min: 0,
        slider_max: 1,
        mute: false,
        relative_key: '',
        data: new Uint8Array(positions.map((p) => p * 1.2).buffer),
      },
    ]);
    expect(estimateRender(keyed)).toMatchObject({ builtTriangles: 12, builtBaseTriangles: 12 });
    // with a modifier after it the keyed copy is not kept: the modifier's result is what the
    // evaluation keeps (a Subdivision Surface at render level 1: 48 triangles)
    keyed.updateObject(box.id, { modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })] });
    expect(estimateRender(keyed)).toMatchObject({ builtTriangles: 48, builtBaseTriangles: 0 });
    // what that adds to the page's heap: the built geometry, the evaluated instances and the heaviest
    // object's evaluation
    const e = estimateRender(doc);
    expect(rasterNeeds(e)).toEqual({
      triangles: e.builtTriangles,
      heap:
        e.builtTriangles * RASTER_BYTES_PER_TRIANGLE + e.instances * INSTANCE_BYTES.heap + e.evaluationHeap,
      instances: e.instances,
      buildsNothing: false,
    });
  });

  it("refuses a RASTER render whose geometry does not fit what the tab's heap has left, saying why", () => {
    // a heap like Chromium's with --max-old-space-size=400 (limit 497 MB), the page using 20 MB
    const tab: TabMemory = { ...roomy, heapLimit: 497 * MB, heapUsed: 20 * MB };
    const room = usableHeap(tab.heapLimit) - tab.heapUsed;
    const needs = { triangles: 4_317_196, heap: 4_317_196 * RASTER_BYTES_PER_TRIANGLE };
    expect(rasterRefusal({ ...needs, heap: room }, tab)).toBeNull();
    expect(rasterRefusal(needs, tab)).toBe(
      'The RASTER render was not started: the geometry it evaluates at the render settings needs about ' +
        "0.48 GB of JavaScript heap, more than the 0.33 GB the tab has left for it: a render may fill 0.35 GB of its 0.49 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working, " +
        'and the page is estimated to use 0.02 GB of that (about 4.3 million triangles: curve and text surfaces, modifier and ' +
        'shape key results), and running out of memory would end the tab. Lower the triangles (subdivision ' +
        'render levels, curve and text render resolution, objects in the scene).',
    );
    // one byte more than the room: three decimals keep them apart
    expect(rasterRefusal({ ...needs, heap: room + 1 }, tab)).toMatch(
      /needs about (0\.\d{3}) GB of JavaScript heap, more than the (0\.\d{3}) GB the tab has left/,
    );
    // what the path traced renders running in the tab hold is not the page's to use
    const held = { ...tab, held: { total: 0, heap: room / 2 } };
    expect(rasterRefusal({ ...needs, heap: room / 2 }, held)).toBeNull();
    expect(rasterRefusal({ ...needs, heap: room / 2 + MB }, held)).toContain(
      'and the page and the path traced renders running in it are estimated to use',
    );
    // the modifier its evaluation would not run, by name
    expect(
      rasterRefusal(
        {
          ...needs,
          cause: { name: "the Bevel modifier 'Bev' of 'Cube'", lower: 'its segments', triangles: 69_192 },
        },
        tab,
      ),
    ).toContain(
      "would end the tab. The Bevel modifier 'Bev' of 'Cube' would make 69,192 of these triangles (lower its segments).",
    );
  });

  it("does not refuse a RASTER render that builds nothing beyond what the page holds, whatever the page's estimate says", () => {
    // regression: four 720 × 720 grids, a page estimated at 0.449 GB (it held 345 MiB after a garbage
    // collection), were refused in a tab with a heap limit of 0.485 GB: "needs about 0.001 GB of
    // JavaScript heap, and the tab has none left for it … (about 0 triangles …)"; with the check
    // believing a larger heap, they rendered and the page held 346 MiB
    const doc = scene();
    const plane = grid(doc, 16);
    for (const name of ['A', 'B', 'C', 'D']) doc.addObject({ name, type: 'MESH', data: plane });
    const e = estimateRender(doc, true, 1);
    expect(e).toMatchObject({ builtTriangles: 0, instances: 5, builtInstances: 0, evaluationHeap: 0 });
    const needs = rasterNeeds(e);
    expect(needs).toEqual({ triangles: 0, heap: 5 * INSTANCE_BYTES.heap, instances: 5, buildsNothing: true });
    // an evaluation that runs (a modifier's heap while it runs) builds something, even into no triangles
    expect(rasterNeeds({ ...e, evaluationHeap: MB })).toMatchObject({
      heap: 5 * INSTANCE_BYTES.heap + MB,
      buildsNothing: false,
    });
    // the page's own heap past the share a render may fill, path traced renders running beside it
    const full: TabMemory = {
      ...roomy,
      heapLimit: 497 * MB,
      heapUsed: 0.449 * GB,
      held: { total: GB, heap: 0.3 * GB },
    };
    expect(usableHeap(full.heapLimit)).toBeLessThan(full.heapUsed);
    expect(rasterRefusal(needs, full)).toBeNull();
    // the same need from what builds something is refused there
    expect(rasterRefusal({ ...needs, buildsNothing: false }, full)).toMatch(
      /^The RASTER render was not started: .*and the tab has none left for it/,
    );
    // particles build their instances: a hundred cubes on the first grid, refused beside that page,
    // saying what it evaluates and what to lower
    const grids = doc.findObjectByName('A')!;
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(grids.id, {
      particle_systems: [
        {
          id: 'p',
          name: 'P',
          show_viewport: true,
          show_render: true,
          settings: { count: 100, instance_type: 'OBJECT', instance_object: cube.id, particle_size: 0.1 },
        },
      ],
    });
    const scattered = rasterNeeds(estimateRender(doc, true, 1));
    expect(scattered).toMatchObject({ triangles: 0, instances: 105, buildsNothing: false });
    const page = { ...full, heapUsed: usableHeap(full.heapLimit) - 1, held: { total: 0, heap: 0 } };
    expect(rasterRefusal(scattered, page)).toBe(
      'The RASTER render was not started: the geometry it evaluates at the render settings needs about ' +
        "0.001 GB of JavaScript heap, and the tab has none left for it: a render may fill 0.352 GB of its 0.485 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working, " +
        'and the page is estimated to use 0.353 GB (about 105 instances of objects, particles and collections, and no curve or ' +
        'text surface, modifier or shape key result), and running out of memory would end the tab. Lower the ' +
        'instances (particle counts, instanced collections, objects in the scene).',
    );
    // a collection instanced whole builds its objects' instances too
    doc.updateObject(grids.id, { particle_systems: [] });
    const parts = doc.addCollection({ name: 'Parts', hide_viewport: true });
    doc.addObject({ name: 'Part', type: 'MESH', data: plane, collection: parts });
    doc.addObject({
      name: 'Instancer',
      type: 'EMPTY',
      instance_type: 'COLLECTION',
      instance_collection: parts,
    });
    expect(estimateRender(doc, true, 1)).toMatchObject({ builtTriangles: 0, builtInstances: 1 });
    expect(rasterNeeds(estimateRender(doc, true, 1)).buildsNothing).toBe(false);
    // and a modifier that runs, a shape key at work, a curve's surface: all build geometry
    const subdivided = scene();
    const box = subdivided.findObjectByName('Cube')!;
    subdivided.updateObject(box.id, {
      modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })],
    });
    expect(rasterNeeds(estimateRender(subdivided, true, 1))).toMatchObject({
      triangles: 48,
      buildsNothing: false,
    });
    const curved = scene();
    cable(curved, 6, 4, 4);
    expect(rasterNeeds(estimateRender(curved, true, 1)).buildsNothing).toBe(false);
    // a Subdivision Surface at level 0 hands its input on: nothing built
    subdivided.updateObject(box.id, {
      modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 0 })],
    });
    expect(rasterNeeds(estimateRender(subdivided, true, 1)).buildsNothing).toBe(true);
  });

  it('leaves out what the evaluator of RASTER renders keeps, which goes first, and counts it for path traced renders', () => {
    // a RASTER render of the cube subdivided in renders, with room for it beside the page's own heap,
    // but not beside the geometry an earlier RASTER render kept as well
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })] });
    const raster = rasterNeeds(estimateRender(doc, true, 1));
    const limit = 497 * MB;
    const pageHeap = usableHeap(limit) - raster.heap - MB;
    const kept = 2 * MB;
    const perf = Object.getOwnPropertyDescriptor(performance, 'memory');
    Object.defineProperty(performance, 'memory', { value: { jsHeapSizeLimit: limit }, configurable: true });
    try {
      const tab = tabMemory(pageHeap, kept);
      expect(tab).toMatchObject({ heapUsed: pageHeap + kept, rasterKept: kept });
      expect(rasterRefusal(raster, tab)).toBeNull();
      expect(rasterRefusal(raster, { ...tab, rasterKept: 0 })).toMatch(
        /^The RASTER render was not started: /,
      );
      // what it prints is the page's own heap, without what goes first
      const need = raster.heap + 2 * MB;
      const f = refusalFigures(need, usableHeap(limit), pageHeap, 2);
      expect(rasterRefusal({ ...raster, heap: need }, tab)).toContain(
        `and the page is estimated to use ${f.used} GB of that`,
      );
      // a path traced render counts it: room for its heap beside the page and the kept geometry, and
      // none with a byte more
      const needs = estimatedNeeds(estimateRender(doc, true, 1), 24 * 16);
      const own = usableHeap(limit) - renderMemory(needs, 1).heap - kept;
      expect(planRenderThreads(needs, 1, tabMemory(own, kept)).threads).toBe(1);
      expect(planRenderThreads(needs, 1, tabMemory(own + 1, kept))).toMatchObject({ threads: 0 });
    } finally {
      if (perf) Object.defineProperty(performance, 'memory', perf);
      else delete (performance as { memory?: unknown }).memory;
    }
  });

  it('prints the figures of a refusal so that they add up and the need never prints like the room', () => {
    // one decimal: 0.9 GB needed, 0.3 GB left of 2.0 GB, 1.7 GB of which others hold
    expect(refusalFigures(0.9 * GB, 2 * GB, 1.7 * GB)).toEqual({
      need: '0.9',
      total: '2.0',
      used: '1.7',
      room: '0.3',
      digits: 1,
    });
    // rounded alone, 0.35 GB less 0.09 GB would print 0.27 GB of room: the room is what they print
    expect(refusalFigures(0.38 * GB, 0.3549 * GB, 0.0851 * GB, 2)).toMatchObject({
      total: '0.35',
      used: '0.09',
      room: '0.26',
    });
    // a figure that is not 0 never prints as 0: 3 MB with three decimals
    expect(refusalFigures(0.5 * GB, 0.4 * GB, 3 * MB, 2)).toEqual({
      need: '0.500',
      total: '0.400',
      used: '0.003',
      room: '0.397',
      digits: 3,
    });
    // nor does the room that is left: 31 MB of 94 MB
    expect(refusalFigures(32 * MB, 94 * MB, 63 * MB)).toMatchObject({
      need: '0.031',
      total: '0.092',
      used: '0.062',
      room: '0.030',
    });
    // a need one byte over the room: three decimals, the need rounded up, the total down, the use up
    const f = refusalFigures(0.5 * GB + 1, 0.7 * GB, 0.2 * GB);
    expect(Number(f.need)).toBeGreaterThan(Number(f.room));
    expect(Number(f.total) - Number(f.used)).toBeCloseTo(Number(f.room), 9);
    // when the use takes it all, there is no room
    expect(refusalFigures(0.03 * GB, 0.37 * GB, 0.63 * GB, 2).room).toBeNull();
    // nor do a need or a use under half a megabyte: 0.001 GB at least (a RASTER render that builds
    // nothing needs a few kilobytes, for the objects it evaluates, where the page leaves no room)
    expect(refusalFigures(1600, 0.352 * GB, 0.617 * GB, 2)).toEqual({
      need: '0.001',
      total: '0.352',
      used: '0.617',
      room: null,
      digits: 3,
    });
    expect(refusalFigures(0.5 * GB, 0.4 * GB, 100 * 1024, 2)).toMatchObject({ used: '0.001', room: '0.399' });
    // and so for any figures (a need larger than the room, as in a refusal)
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 5000; i++) {
      const scale = [0.0001, 0.01, 1, 4][i % 4] * GB;
      const total = 32 * MB + rnd() * scale;
      const used = rnd() < 0.2 ? 0 : rnd() * total * (rnd() < 0.1 ? 2 : 1);
      const need = Math.max(0, total - used) + 1 + rnd() * scale;
      const f = refusalFigures(need, total, used, rnd() < 0.5 ? 1 : 2);
      expect(f.digits).toBeLessThanOrEqual(3);
      expect(Number(f.need)).toBeGreaterThan(0);
      if (used > 0) expect(Number(f.used)).toBeGreaterThan(0);
      if (f.room !== null) {
        expect(Number(f.total) - Number(f.used)).toBeCloseTo(Number(f.room), 9);
        expect(Number(f.need)).toBeGreaterThan(Number(f.room));
      }
    }
  });

  it('suggests the RASTER engine right after a RASTER render, whose kept geometry goes first, and counts that geometry for the path traced render', async () => {
    // the cube subdivided in renders; an earlier RASTER render kept geometry (`pageHeld`, from the
    // engine) that leaves no room for a path traced render, nor for the next RASTER render next to it:
    // that render lets it go first, so it fits, and the refusal says so
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })] });
    const limit = 497 * MB;
    const raster = rasterNeeds(estimateRender(doc, true, 1)).heap;
    const pageHeld = usableHeap(limit) - pageHeapEstimate(doc, 1) - raster / 2;
    const perf = Object.getOwnPropertyDescriptor(performance, 'memory');
    Object.defineProperty(performance, 'memory', { value: { jsHeapSizeLimit: limit }, configurable: true });
    try {
      const { pool, started } = recordingPool(2);
      const options = { width: 24, height: 16, frame: 1, samples: 1, pageFrame: 1 };
      const refused = startPathTrace(pool, doc, { ...options, pageHeld });
      await expect(refused.result).rejects.toThrow(
        /^Path tracing was not started: its render thread needs about .*, or render with the RASTER engine\.$/,
      );
      expect(started).toEqual([]);
      // without that geometry the path traced render starts
      const job = startPathTrace(pool, doc, { ...options, pageHeld: 0 });
      await expect(job.result).resolves.toMatchObject({ width: 24, height: 16 });
    } finally {
      if (perf) Object.defineProperty(performance, 'memory', perf);
      else delete (performance as { memory?: unknown }).memory;
    }
  });

  it('suggests the RASTER engine for a path traced render it refuses only where a RASTER render fits the page', async () => {
    const { pool } = recordingPool(2);
    // a tab of 64 MB budget: the image of 1024 × 1024 pixels does not fit, the scene's geometry does
    const memory = { ...roomy, budget: 64 * MB, deviceGB: 0.125 };
    const fits = startPathTrace(pool, scene(), { width: 1024, height: 1024, frame: 1, samples: 1, memory });
    await expect(fits.result).rejects.toThrow(/, or render with the RASTER engine\.$/);
    // a cable whose surface would not fit the page's heap either
    const dense = scene();
    cable(dense, 32, 1024, 32);
    const heap = { ...memory, heapLimit: 497 * MB, heapUsed: 20 * MB };
    const refused = startPathTrace(pool, dense, {
      width: 1024,
      height: 1024,
      frame: 1,
      samples: 1,
      memory: heap,
    });
    const message = await refused.result.then(
      () => '',
      (err: Error) => err.message,
    );
    expect(message).toMatch(/^Path tracing was not started: /);
    expect(message).not.toContain('RASTER');
    expect(rasterRefusal(rasterNeeds(estimateRender(dense, true, 1)), heap)).not.toBeNull();
    // a RASTER render of the cube subdivided in renders fits the page with 1 MB to spare, but not next
    // to the heap a path traced render running in the tab holds: suggested only while none runs
    const subdivided = () => {
      const doc = scene();
      const cube = doc.findObjectByName('Cube')!;
      doc.updateObject(cube.id, { modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 1 })] });
      return doc;
    };
    const raster = rasterNeeds(estimateRender(subdivided(), true, 1)).heap;
    const page = { ...memory, heapLimit: 497 * MB, heapUsed: usableHeap(497 * MB) - raster - MB };
    const big = { width: 1024, height: 1024, frame: 1, samples: 1, memory: page };
    await expect(startPathTrace(pool, subdivided(), big).result).rejects.toThrow(
      /, or render with the RASTER engine\.$/,
    );
    const running = startPathTrace(pool, scene(), {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1 << 16,
      memory: roomy,
    });
    await new Promise<void>((resolve) => {
      const off = running.subscribe(() => {
        if (running.status.phase !== 'rendering') return;
        off();
        resolve();
      });
    });
    const next = await startPathTrace(pool, subdivided(), big).result.then(
      () => '',
      (err: Error) => err.message,
    );
    expect(next).toMatch(/^Path tracing was not started: /);
    expect(next).not.toContain('RASTER');
    running.cancel();
    await running.result;
    // the room shrinks while the first worker prepares (here the budget; in a tab, renders that start
    // meanwhile): the plan with the compiled scene refuses the render, and suggests RASTER all the same
    const one = recordingPool(1);
    const shrinking = { ...roomy };
    const late = startPathTrace(one.pool, scene(), {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1,
      memory: shrinking,
    });
    shrinking.budget = 0;
    await expect(late.result).rejects.toThrow(
      /^Path tracing was not started: .*, or render with the RASTER engine\.$/,
    );
    // refused once its first worker had prepared the scene
    expect(one.sent.flat().filter((t) => t.startsWith('prepare'))).toHaveLength(1);
  });

  it("counts the bevel object's curve at the frame it renders, as the first worker builds it", async () => {
    const doc = scene();
    // an open profile of 3 points (no fill of its own) sampled at its render resolution, keyed from 2
    // to 24 samples per span: 5 and 49 points, 13 as stored
    const profile = doc.addCurve({ dimensions: '2D', splines: [wave('BEZIER', 3)], render_resolution_u: 6 });
    const profileObject = doc.addObject({
      name: 'Profile',
      type: 'CURVE',
      data: profile,
      location: [0, 5, 0],
    });
    key(doc, 'curve', profile, 'render_resolution_u', [
      [1, 2],
      [10, 24],
    ]);
    const data = doc.getObject(cable(doc, 6, 4, 4))!.data!;
    doc.updateCurve(data, { bevel_mode: 'OBJECT', bevel_object: profileObject });
    // the cable's 21 points swept by the profile: 20 × 12 quads as stored
    expect(estimateRender(doc, true).triangles).toBe(12 + 2 * 20 * 12);
    for (const [frame, quads] of [
      [1, 20 * 4],
      [10, 20 * 48],
    ]) {
      expect(estimateRender(doc, true, frame).triangles).toBe(12 + 2 * quads);
      expect((await preparedInfo(doc, 24, 16, frame)).triangles).toBe(12 + 2 * quads);
    }
  });

  it("takes the page's heap from its viewport geometry at the frame the viewport shows, by default the one it renders", async () => {
    const perf = performance as { memory?: unknown };
    const before = Object.getOwnPropertyDescriptor(performance, 'memory');
    // a heap limit of 300 MB
    Object.defineProperty(performance, 'memory', {
      value: { jsHeapSizeLimit: 300 * MB, usedJSHeapSize: 10 * MB },
      configurable: true,
    });
    try {
      // a grid subdivided four times in the viewport at frame 1 (keyed; stored and from frame 10: none)
      const doc = scene();
      doc.addObject({
        name: 'Grid',
        type: 'MESH',
        data: grid(doc, 64),
        modifiers: [modifier('Sub', 'SUBSURF', { levels: 0, render_levels: 0 })],
      });
      const id = doc.findObjectByName('Grid')!.id;
      key(doc, 'object', id, 'modifiers["Sub"].levels', [
        [1, 4],
        [10, 0],
      ]);
      expect(pageHeapEstimate(doc, 1)).toBeGreaterThan(usableHeap(300 * MB));
      expect(pageHeapEstimate(doc)).toBeLessThan(20 * MB);
      expect(pageHeapEstimate(doc, 10)).toBeLessThan(20 * MB);
      const { pool, started } = recordingPool(2);
      await expect(
        startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1 }).result,
      ).rejects.toThrow(
        /and the tab has none left for it: .*, and the page is estimated to use 0\.\d\d GB \(about/,
      );
      expect(started).toEqual([]);
      const r = await startPathTrace(pool, doc, { width: 24, height: 16, frame: 10, samples: 1 }).result;
      expect(r.samples).toBe(1);
      // the page holds the viewport's evaluation: at the frame the viewport shows where it is given
      await expect(
        startPathTrace(pool, doc, { width: 24, height: 16, frame: 10, pageFrame: 1, samples: 1 }).result,
      ).rejects.toThrow(
        /and the tab has none left for it: .*, and the page is estimated to use 0\.\d\d GB \(about/,
      );
      const shown = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, pageFrame: 10, samples: 1 });
      expect((await shown.result).samples).toBe(1);
      // what the page holds besides its scene counts too (the geometry the evaluator of RASTER
      // final renders keeps): all the room the share leaves beside the page's scene
      const held = usableHeap(300 * MB) - pageHeapEstimate(doc, 10);
      await expect(
        startPathTrace(pool, doc, {
          width: 24,
          height: 16,
          frame: 10,
          pageFrame: 10,
          pageHeld: held,
          samples: 1,
        }).result,
      ).rejects.toThrow(
        /^Path tracing was not started: its render thread needs about .*, and the page is estimated to use /,
      );
    } finally {
      if (before) Object.defineProperty(performance, 'memory', before);
      else delete perf.memory;
    }
  });
});
