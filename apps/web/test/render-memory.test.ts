import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  TEXT_BYTES_PER_CHARACTER,
  createMesh,
  curveToMesh,
  defaultCurve,
  estimateModifier,
  evaluateCurveSplines,
  meshSize,
  renderSceneSoftware,
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
  PREPARE_BYTES_PER_TRIANGLE,
  WORKER_BASE_BYTES,
  YOUNG_GENERATION_BYTES,
  bevelHeap,
  curveSurfaceSize,
  estimateRender,
  estimatedNeeds,
  pageHeapEstimate,
  planRenderThreads,
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

/** What the first worker reports for `doc` (exact triangles, instances and bytes). */
async function preparedInfo(doc: SceneDoc, width: number, height: number): Promise<PreparedInfo> {
  const engine = new RenderWorkerEngine(null);
  const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
  return engine.prepare(1, new DocumentSnapshot(doc).payload(thread), { width, height, frame: 1 });
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
  });

  it('takes the heap of the page from its scene where the browser reports a figure it seldom refreshes', async () => {
    const perf = performance as { memory?: unknown };
    const before = Object.getOwnPropertyDescriptor(performance, 'memory');
    // Chrome without cross-origin isolation: usedJSHeapSize stays at its first value for 20 minutes
    Object.defineProperty(performance, 'memory', {
      value: { jsHeapSizeLimit: 0.5 * GB, usedJSHeapSize: 10 * MB },
      configurable: true,
    });
    try {
      expect(tabMemory().heapUsed).toBe(10 * MB);
      expect(tabMemory(300 * MB).heapUsed).toBe(300 * MB);
      expect(tabMemory(1 * MB).heapUsed).toBe(10 * MB);
      // the page evaluates the scene for the viewport: its levels, not the render levels
      const doc = scene();
      const cube = doc.findObjectByName('Cube')!;
      doc.updateObject(cube.id, { modifiers: [modifier('s', 'SUBSURF', { levels: 2, render_levels: 4 })] });
      expect(estimateRender(doc, false).evaluatedTriangles).toBe(2 * 24 * 4);
      expect(estimateRender(doc).evaluatedTriangles).toBe(2 * 24 * 4 ** 3);
      expect(pageHeapEstimate(doc)).toBe(2 * 24 * 4 * PREPARE_BYTES_PER_TRIANGLE.heap + INSTANCE_BYTES.heap);
      // two grids whose viewport subdivision (2,097,152 triangles each) holds 0.6 GB of the page's
      // heap: a render of them (render levels 0) is refused by the heap the page holds, which the
      // stale 10 MB do not show
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
      const { pool, started } = recordingPool(2);
      const job = startPathTrace(pool, doc, { width: 24, height: 16, frame: 1, samples: 1 });
      await expect(job.result).rejects.toThrow(
        /needs about 0\.03 GB of JavaScript heap, and the tab, which already uses 0\.6 GB, has 0\.00 GB of its 0\.5 GB left/,
      );
      expect(started).toEqual([]);
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
    // (the cube and the instanced copy share their mesh: 12 triangles)
    expect(pageHeapEstimate(doc)).toBe(12 * PREPARE_BYTES_PER_TRIANGLE.heap + 12 * INSTANCE_BYTES.heap);
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

  it("counts the page's heap from what it evaluates for the viewport: objects hidden in renders too", () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateObject(cube.id, { hide_render: true });
    expect(estimateRender(doc, false)).toMatchObject({ triangles: 0, evaluatedTriangles: 12 });
    expect(pageHeapEstimate(doc)).toBe(12 * PREPARE_BYTES_PER_TRIANGLE.heap);
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
    expect(tight.refusal).toContain(
      'Lower the resolution or the triangles (subdivision render levels, curve and text render resolution, objects in the scene), or render with the RASTER engine.',
    );
    // the JavaScript heap of the tab (Chrome: one 4 GB cage for the page and its workers)
    const full = planRenderThreads(needs, 4, { ...roomy, heapUsed: 3.1e9 });
    expect(full.threads).toBe(0);
    expect(full.refusal).toMatch(
      /its render thread needs about 0\.\d GB of JavaScript heap, and the tab, which already uses 2\.9 GB, has 0\.\d GB of its 3\.5 GB left for it/,
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
    expect(held.refusal).toContain(
      `of JavaScript heap, and the tab, which already uses ${((roomy.heapUsed + others) / GB).toFixed(1)} GB`,
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
      'its render thread needs about 0.37 GB of JavaScript heap, and the tab, which already uses 0.0 GB, has 0.35 GB of its 0.5 GB left for it',
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
      evaluationHeap: 0,
      imageBytes: 0,
    };
    const engine = new RenderWorkerEngine(null);
    const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
    const prepare = (budget: number, job: number) =>
      engine.prepare(
        job,
        new DocumentSnapshot(doc).payload(thread),
        { width: 24, height: 16, frame: 1 },
        { ...roomy, budget, deviceGB: 1 },
        nothing,
      );
    // one byte short: refused, with the exact numbers, nothing compiled or kept for the job
    const refused = prepare(renderMemory(checked, 1).total - 1, 1);
    await expect(refused).rejects.toThrow(RenderMemoryError);
    await expect(refused).rejects.toThrow(
      /^Path tracing was not started: it needs about 0\.\d+ GB of memory with one render thread, more than the 0\.\d+ GB a render may use in this tab .*\(about 3,212 triangles, 384 pixels\)/,
    );
    expect(() => engine.share(1)).toThrow(/not prepared/);
    // with that byte it compiles
    expect((await prepare(renderMemory(checked, 1).total, 2)).triangles).toBe(3212);
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
      /it needs about (0\.\d{3}) GB of memory with one render thread, more than the (0\.\d{3}) GB left of the 0\.\d GB a render may use in this tab \(.*\), 0\.\d GB of which other path traced renders running in it hold/,
    );
    expect(figures, message).not.toBeNull();
    expect(Number(figures![1])).toBeGreaterThan(Number(figures![2]));
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
