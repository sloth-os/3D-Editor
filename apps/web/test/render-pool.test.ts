import { afterEach, describe, expect, it } from 'vitest';
import { SceneDoc, renderSceneSoftware, type PathTile } from '@3d-editor/core';
import {
  InProcessWorker,
  RenderPool,
  animationFrames,
  animationProblem,
  pathTraceDocument,
  startAnimationRender,
  startPathTrace,
  type WorkerLike,
} from '../src/render';
import { DocumentSnapshot, resetThreadDocument } from '../src/render/pool';
import { RenderWorkerEngine, handleWorkerMessage, referencedImages } from '../src/render/worker-engine';
import { bandRows, nextPassSize, passSamples, planPass, MAX_BAND_ROWS } from '../src/render/schedule';
import { filmRowsToRGBA8 } from '../src/render/preview';
import { renderViewFromMatrices } from '../src/render/view';
import type { PreparedInfo, WorkerRequest, WorkerResponse } from '../src/render/protocol';

const pools: RenderPool[] = [];
function pool(size: number, factory?: (i: number) => WorkerLike): RenderPool {
  const p = new RenderPool({ size, factory: factory ?? (() => new InProcessWorker()), idleMs: 0 });
  pools.push(p);
  return p;
}
afterEach(() => {
  for (const p of pools.splice(0)) p.dispose();
});

/** The default scene (cube, camera, point light) with a tiny render resolution. */
function scene(): SceneDoc {
  const doc = SceneDoc.create();
  doc.updateRender({ resolution_x: 24, resolution_y: 16, samples: 4, max_bounces: 2 });
  return doc;
}

describe('band scheduling', () => {
  it('sizes bands by samples and load balance', () => {
    // one sample per pixel over 64 px: many rows per band, limited by balance and the cap
    expect(bandRows(64, 1000, 1, 4)).toBe(MAX_BAND_ROWS);
    expect(bandRows(64, 24, 1, 4)).toBe(2);
    // wide images and big passes: few rows per band
    expect(bandRows(4096, 2000, 16, 8)).toBe(1);
    expect(bandRows(100, 10, 1, 1)).toBe(4);
  });

  it('plans every row up to the target, grouping rows with equal sample counts', () => {
    const rows = new Int32Array([0, 0, 0, 0, 2, 2, 1, 1, 4, 4]);
    const bands = planPass(rows, 8, 4, 1);
    const covered = new Int32Array(rows);
    for (const [y0, y1, start] of bands) {
      for (let y = y0; y < y1; y++) {
        expect(rows[y]).toBe(start);
        covered[y] = 4;
      }
    }
    expect([...covered]).toEqual(Array(10).fill(4));
    // rows already at the target are skipped
    expect(bands.some(([y0]) => y0 >= 8)).toBe(false);
  });

  it('follows the progressive pass sizes of the core path tracer and fits passes into time', () => {
    const sizes = [1];
    for (let i = 0; i < 6; i++) sizes.push(nextPassSize(sizes[sizes.length - 1]));
    expect(sizes).toEqual([1, 2, 4, 8, 16, 16, 16]);
    expect(passSamples(8, 60, 64, null, 0)).toBe(4);
    expect(passSamples(8, 0, 64, 100, 20)).toBe(5);
    expect(passSamples(8, 0, 64, 10, 20)).toBe(0);
    expect(passSamples(8, 0, 64, 1000, 0)).toBe(8);
  });
});

describe('render worker protocol', () => {
  it('prepares a document snapshot, renders rows and keeps the document between renders', async () => {
    const doc = scene();
    const engine = new RenderWorkerEngine(null);
    const responses: WorkerResponse[] = [];
    const post = (r: WorkerResponse) => void responses.push(r);
    const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
    const first = new DocumentSnapshot(doc).payload(thread);
    expect(first.kind).toBe('full');
    const send = (msg: WorkerRequest) => handleWorkerMessage(engine, msg, post);
    await send({ type: 'prepare', id: 1, job: 7, doc: first, options: { width: 24, height: 16, frame: 1 } });
    const prep = responses.pop()!;
    expect(prep.type).toBe('result');
    const info = (prep as { result: PreparedInfo }).result;
    expect(info).toMatchObject({ width: 24, height: 16, samples: 4, denoise: true, viewTransform: 'AGX' });
    await send({ type: 'rows', id: 2, job: 7, y0: 2, y1: 5, sampleStart: 0, sampleCount: 2 });
    const tile = (responses.pop() as { result: PathTile }).result;
    expect([tile.y0, tile.y1, tile.sampleCount, tile.color.length]).toEqual([2, 5, 2, 3 * 24 * 4]);
    // an edit afterwards travels as a small difference
    doc.updateObject(doc.findObjectByName('Cube')!.id, { location: [0, 0, 1] });
    const second = new DocumentSnapshot(doc).payload(thread);
    expect(second.kind).toBe('diff');
    expect(second.update.length).toBeLessThan(first.update.length / 4);
    await send({ type: 'prepare', id: 3, job: 8, doc: second, options: { width: 24, height: 16, frame: 1 } });
    expect(responses.pop()!.type).toBe('result');
    // released jobs cannot render any more
    await send({ type: 'release', job: 7 });
    await send({ type: 'rows', id: 4, job: 7, y0: 0, y1: 1, sampleStart: 0, sampleCount: 1 });
    expect(responses.pop()).toMatchObject({ type: 'error', id: 4 });
  });

  it('reports a stale document when a difference reaches a worker without the document', async () => {
    const doc = scene();
    const thread = { docKey: null as string | null, stateVector: null as Uint8Array | null };
    new DocumentSnapshot(doc).payload(thread);
    const diff = new DocumentSnapshot(doc).payload(thread);
    const responses: WorkerResponse[] = [];
    await handleWorkerMessage(
      new RenderWorkerEngine(null),
      { type: 'prepare', id: 1, job: 1, doc: diff, options: { width: 4, height: 4, frame: 1 } },
      (r) => void responses.push(r),
    );
    expect(responses[0]).toMatchObject({ type: 'error', code: 'STALE_DOCUMENT' });
    resetThreadDocument(thread);
    expect(new DocumentSnapshot(doc).payload(thread).kind).toBe('full');
  });

  it('finds the image textures a render needs', () => {
    const doc = scene();
    const img = doc.addImage({ name: 'T', mime: 'image/png', width: 1, height: 1, data: new Uint8Array(8) });
    const mat = doc.listMaterials()[0];
    doc.updateMaterial(mat.id, {
      textures: { base_color: { image: img, scale: [1, 1], offset: [0, 0] }, roughness: null },
    });
    const engine = new RenderWorkerEngine(null);
    const { evaluator } = engine.applyDocument({ key: 'k', kind: 'full', update: doc.encodeState() });
    const ev = evaluator.evaluate(1, { forRender: true });
    const items = ev.objects.flatMap((o) =>
      o.mesh ? [{ materials: o.materials } as Parameters<typeof referencedImages>[1][number]] : [],
    );
    expect(referencedImages(ev, items)).toEqual([img]);
  });
});

describe('parallel path tracing', () => {
  it('renders the same image as the core single-threaded path tracer, on any number of workers', async () => {
    const doc = scene();
    const reference = renderSceneSoftware(doc, { width: 24, height: 16, engine: 'PATHTRACER', samples: 5 });
    for (const threads of [1, 3]) {
      const job = startPathTrace(pool(threads), doc, { width: 24, height: 16, frame: 1, samples: 5 });
      const statuses: string[] = [];
      job.subscribe(() => statuses.push(job.status.phase));
      const r = await job.result;
      expect(r).toMatchObject({
        width: 24,
        height: 16,
        samples: 5,
        total: 5,
        stopped: 'done',
        denoised: true,
      });
      expect(Buffer.from(r.data).equals(Buffer.from(reference.data))).toBe(true);
      expect(statuses).toContain('rendering');
      expect(statuses[statuses.length - 1]).toBe('done');
      expect(job.takeDirtyRows()).toEqual([0, 16]);
      expect(Buffer.from(job.pixels).equals(Buffer.from(reference.data))).toBe(true);
    }
  });

  it('keeps worker documents up to date with differences between renders', async () => {
    const doc = scene();
    const p = pool(2);
    await startPathTrace(p, doc, { width: 24, height: 16, frame: 1, samples: 2, denoise: false }).result;
    doc.updateObject(doc.findObjectByName('Cube')!.id, { location: [1, 0, 0.5], scale: [0.5, 0.5, 0.5] });
    const after = await startPathTrace(p, doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 2,
      denoise: false,
    }).result;
    const reference = renderSceneSoftware(doc, {
      width: 24,
      height: 16,
      engine: 'PATHTRACER',
      samples: 2,
      denoise: false,
    });
    expect(Buffer.from(after.data).equals(Buffer.from(reference.data))).toBe(true);
  });

  it('shows a progressive preview and stops with the samples so far when cancelled', async () => {
    const doc = scene();
    const job = startPathTrace(pool(2), doc, { width: 24, height: 16, frame: 1, samples: 4096 });
    let previewed = false;
    await new Promise<void>((resolve) => {
      const off = job.subscribe(() => {
        if (job.status.phase === 'rendering' && job.status.samples >= 2 && !previewed) {
          previewed = true;
          const rows = job.takeDirtyRows();
          expect(rows).not.toBeNull();
          // preview pixels of rendered rows are opaque (the world is the background)
          expect(job.pixels[3]).toBe(255);
          off();
          job.cancel();
          resolve();
        }
      });
    });
    const r = await job.result;
    expect(r.stopped).toBe('cancelled');
    expect(r.denoised).toBe(false);
    expect(r.samples).toBeGreaterThanOrEqual(2);
    expect(r.samples).toBeLessThan(4096);
    expect(job.status.phase).toBe('cancelled');
  });

  it('stops sampling at the time limit after at least one sample per pixel', async () => {
    const doc = scene();
    const job = startPathTrace(pool(2), doc, {
      width: 24,
      height: 16,
      frame: 1,
      samples: 1 << 16,
      timeLimit: 0.3,
    });
    const r = await job.result;
    expect(r.stopped).toBe('time');
    expect(r.samples).toBeGreaterThanOrEqual(1);
    expect(r.samples).toBeLessThan(1 << 16);
  });

  it('carries on when a worker fails, and fails when every worker does', async () => {
    const doc = scene();
    const reference = renderSceneSoftware(doc, { width: 24, height: 16, engine: 'PATHTRACER', samples: 3 });
    /** A worker that crashes on its first band. */
    class Crashing extends InProcessWorker {
      override postMessage(msg: WorkerRequest): void {
        if (msg.type === 'rows') {
          setTimeout(() => this.onerror?.({ message: 'out of memory' } as ErrorEvent), 0);
          return;
        }
        super.postMessage(msg);
      }
    }
    const mixed = pool(3, (i) => (i === 1 ? new Crashing() : new InProcessWorker()));
    const r = await startPathTrace(mixed, doc, { width: 24, height: 16, frame: 1, samples: 3 }).result;
    expect(Buffer.from(r.data).equals(Buffer.from(reference.data))).toBe(true);
    const broken = pool(2, () => new Crashing());
    await expect(
      startPathTrace(broken, doc, { width: 24, height: 16, frame: 1, samples: 3 }).result,
    ).rejects.toThrow(/out of memory/);
  });

  it('renders explicit views and reports preparation failures', async () => {
    const doc = scene();
    const viewSpec = {
      position: [0, -8, 1] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
      fovY: 0.6,
    };
    const r = await startPathTrace(pool(1), doc, { width: 12, height: 8, frame: 1, samples: 1, viewSpec })
      .result;
    const reference = renderSceneSoftware(doc, {
      width: 12,
      height: 8,
      engine: 'PATHTRACER',
      samples: 1,
      view: viewSpec,
    });
    expect(Buffer.from(r.data).equals(Buffer.from(reference.data))).toBe(true);
    await expect(
      startPathTrace(pool(1), doc, { width: 12, height: 8, frame: 1, cameraId: 'Nope' }).result,
    ).rejects.toThrow(/Camera 'Nope' not found/);
  });

  it('builds render views from camera matrices', () => {
    // a camera at (0, -5, 0) looking down +Y (three.js matrixWorldInverse layout, column-major)
    const view = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, -5, 1];
    const v = renderViewFromMatrices(
      view,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0],
      false,
      0.1,
      100,
    );
    const clean = (a: number[]) => a.map((x) => Math.round(x * 1e9) / 1e9 + 0);
    expect(clean(v.eye)).toEqual([0, -5, 0]);
    expect(clean(v.forward)).toEqual([0, 1, 0]);
    expect(clean(v.up)).toEqual([0, 0, 1]);
    expect(clean(v.right)).toEqual([1, 0, 0]);
    expect(v.viewProj).toHaveLength(16);
  });

  it('converts film rows for the progressive preview', () => {
    const film = {
      width: 2,
      height: 2,
      color: new Float32Array([0.36, 0.36, 0.36, 2, 0, 0, 0, 2, 9, 9, 9, 9, 9, 9, 9, 9]),
      rowSamples: new Int32Array([2, 0]),
    };
    const out = new Uint8ClampedArray(16).fill(7);
    filmRowsToRGBA8(film, 0, 2, { exposure: 1, viewTransform: 'STANDARD', displayBackground: null }, out);
    // row 0: mean 0.18 grey (sRGB ≈ 118) and black, opaque; row 1 (no samples) untouched
    expect([...out.subarray(0, 8)]).toEqual([118, 118, 118, 255, 0, 0, 0, 255]);
    expect([...out.subarray(8)]).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
  });
});

describe('animation rendering', () => {
  const solid = (w: number, h: number, v: number) => ({
    width: w,
    height: h,
    data: new Uint8ClampedArray(w * h * 4).fill(v).map((x, i) => (i % 4 === 3 ? 255 : x)),
  });

  it('encodes the frames as APNG or GIF on a worker', async () => {
    const frames = animationFrames(1, 7, 2);
    expect(frames).toEqual([1, 3, 5, 7]);
    for (const format of ['APNG', 'GIF'] as const) {
      const job = startAnimationRender(pool(1), {
        format,
        frames,
        width: 6,
        height: 4,
        fps: 12,
        renderFrame: (f) => ({ done: Promise.resolve(solid(6, 4, f * 30)), cancel: () => undefined }),
      });
      const r = await job.result;
      expect(r).not.toBeNull();
      expect(r!.frames).toEqual(frames);
      expect(r!.cancelled).toBe(false);
      const head = Buffer.from(r!.data.subarray(0, 6)).toString('latin1');
      if (format === 'GIF') expect(head).toBe('GIF89a');
      else {
        expect(r!.data[1]).toBe(0x50); // PNG signature
        expect(Buffer.from(r!.data).includes(Buffer.from('acTL'))).toBe(true);
      }
      expect(job.status.phase).toBe('done');
    }
  });

  it('keeps the finished frames when cancelled and rejects impossible settings', async () => {
    let job: ReturnType<typeof startAnimationRender> | null = null;
    job = startAnimationRender(pool(1), {
      format: 'APNG',
      frames: [1, 2, 3, 4],
      width: 4,
      height: 4,
      fps: 24,
      renderFrame: (f) => {
        if (f === 3) job!.cancel();
        return { done: Promise.resolve(solid(4, 4, 100)), cancel: () => undefined };
      },
    });
    const r = await job.result;
    expect(r!.frames).toEqual([1, 2]);
    expect(r!.cancelled).toBe(true);
    expect(animationProblem('GIF', 4000, 4000, 10)).toMatch(/too many/);
    expect(animationProblem('APNG', 10, 10, 0)).toMatch(/empty/);
    expect(animationProblem('APNG', 4000, 4000, 10)).toBeNull();
  });

  it('path traces animation frames on the shared document', async () => {
    const doc = scene();
    const cube = doc.findObjectByName('Cube')!.id;
    doc.setFCurve({
      target_type: 'object',
      target_id: cube,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: -1, interpolation: 'LINEAR' },
        { frame: 3, value: 1, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const p = pool(2);
    const job = startAnimationRender(p, {
      format: 'GIF',
      frames: [1, 3],
      width: 12,
      height: 8,
      fps: 24,
      renderFrame: (frame) => {
        const pt = startPathTrace(p, doc, { width: 12, height: 8, frame, samples: 1, denoise: false });
        return { done: pt.result, cancel: () => pt.cancel(), job: pt };
      },
    });
    const r = await job.result;
    expect(r!.frames).toEqual([1, 3]);
    expect(job.lastFrame).not.toBeNull();
    // the moved cube changes the image
    const first = renderSceneSoftware(doc, {
      width: 12,
      height: 8,
      frame: 1,
      engine: 'PATHTRACER',
      samples: 1,
      denoise: false,
    });
    expect(Buffer.from(job.lastFrame!.data).equals(Buffer.from(first.data))).toBe(false);
  });
});

describe('shared pool', () => {
  it('path traces through the editor pool', async () => {
    // the shared pool uses module workers, which the test environment lacks: it falls back to the main thread
    const doc = scene();
    const r = await pathTraceDocument(doc, { width: 8, height: 6, frame: 1, samples: 1 }).result;
    expect(r.width).toBe(8);
  });
});
