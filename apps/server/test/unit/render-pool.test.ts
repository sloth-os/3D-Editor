import { afterAll, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  decodePNG,
  renderAnimation,
  renderSceneSoftware,
  type SoftwareRenderOptions,
} from '@3d-editor/core';
import { RenderCancelledError, RenderPool, Renderer, type FrameOptions } from '../../src/render';
import { pathTraceParallel } from '../../src/render/path-trace';
import { renderAnimationParallel } from '../../src/render/animation';

/*
 * The render pool: parallel path tracing gives exactly the single-thread image, renders can be
 * cancelled and time limited, animations match core renderAnimation, and the pool falls back to
 * the main thread when workers cannot start.
 */

const renderers: Renderer[] = [];
function renderer(threads: number, extra: ConstructorParameters<typeof RenderPool>[0] = {}): Renderer {
  const r = new Renderer(new RenderPool({ threads, ...extra }));
  renderers.push(r);
  return r;
}

afterAll(async () => {
  await Promise.all(renderers.map((r) => r.close()));
});

function scene(): SceneDoc {
  const doc = SceneDoc.create({ name: 'pool test' });
  doc.updateRender({ engine: 'PATHTRACER', samples: 64, max_bounces: 3 });
  return doc;
}

const frame = (o: Partial<FrameOptions> = {}): FrameOptions => ({
  width: 40,
  height: 30,
  frame: 1,
  engine: 'PATHTRACER',
  samples: 6,
  ...o,
});

function pixels(png: Uint8Array): Uint8Array {
  return new Uint8Array(decodePNG(png).data);
}

describe('render pool', () => {
  const two = renderer(2);
  const main = renderer(0);

  it('path traces in parallel exactly like a single-thread render', async () => {
    const doc = scene();
    const opts = frame();
    const reference = renderSceneSoftware(doc, opts as SoftwareRenderOptions);
    const parallel = await two.renderImage({ scene: doc, projectId: 'p', options: opts });
    expect(parallel).toMatchObject({
      engine: 'PATHTRACER',
      threads: 2,
      mode: 'workers',
      width: 40,
      height: 30,
    });
    expect(parallel.pathtrace).toMatchObject({ samples: 6, requested: 6, stopped: 'done' });
    expect(pixels(parallel.png)).toEqual(new Uint8Array(reference.data));
    const single = await main.renderImage({ scene: doc, projectId: 'p', options: opts });
    expect(single).toMatchObject({ threads: 1, mode: 'main-thread' });
    expect(Buffer.from(single.png).equals(Buffer.from(parallel.png))).toBe(true);
    // raster renders run on one thread with the same result as the core renderer
    const raster = await two.renderImage({
      scene: doc,
      projectId: 'p',
      options: frame({ engine: 'RASTER', samples: 2 }),
    });
    expect(raster.engine).toBe('RASTER');
    expect(pixels(raster.png)).toEqual(
      new Uint8Array(
        renderSceneSoftware(doc, { width: 40, height: 30, frame: 1, engine: 'RASTER', samples: 2 }).data,
      ),
    );
  });

  it('renders the current document state (threads update their cached copy)', async () => {
    const doc = scene();
    const ref1 = two.docRef('p2', doc);
    expect(two.docRef('p2', doc).version).toBe(ref1.version);
    const first = await two.renderImage({ scene: doc, projectId: 'p2', options: frame({ samples: 2 }) });
    doc.updateWorld({ color: [1, 0, 0], strength: 1 });
    expect(two.docRef('p2', doc).version).not.toBe(ref1.version);
    const second = await two.renderImage({ scene: doc, projectId: 'p2', options: frame({ samples: 2 }) });
    expect(Buffer.from(first.png).equals(Buffer.from(second.png))).toBe(false);
    expect(pixels(second.png)).toEqual(
      new Uint8Array(renderSceneSoftware(doc, frame({ samples: 2 }) as SoftwareRenderOptions).data),
    );
  });

  it('stops sampling at the time limit', async () => {
    const t0 = performance.now();
    const r = await two.renderImage({
      scene: scene(),
      projectId: 'p3',
      options: frame({ width: 64, height: 48, samples: 100_000, time_limit: 0.6 }),
    });
    expect(r.pathtrace!.stopped).toBe('time');
    expect(r.pathtrace!.samples).toBeGreaterThanOrEqual(1);
    expect(r.pathtrace!.samples).toBeLessThan(100_000);
    expect(performance.now() - t0).toBeLessThan(8000);
  });

  it('cancels renders (also while they wait for threads) and keeps the pool usable', async () => {
    const doc = scene();
    const abort = new AbortController();
    const progress: number[] = [];
    const long = two.renderImage({
      scene: doc,
      projectId: 'p4',
      options: frame({ width: 96, height: 64, samples: 4096 }),
      signal: abort.signal,
      onProgress: (p) => {
        progress.push(p.progress);
        if (p.progress >= 2) abort.abort();
      },
    });
    // a second render waits for the threads; aborting it rejects at once
    const waitingAbort = new AbortController();
    const waiting = two.renderImage({
      scene: doc,
      projectId: 'p4',
      options: frame({ samples: 1 }),
      signal: waitingAbort.signal,
    });
    waitingAbort.abort();
    await expect(waiting).rejects.toBeInstanceOf(RenderCancelledError);
    const t0 = performance.now();
    await expect(long).rejects.toBeInstanceOf(RenderCancelledError);
    expect(progress[0]).toBe(1);
    expect(performance.now() - t0).toBeLessThan(5000);
    // the threads come back once their abandoned bands finish
    const after = await two.renderImage({ scene: doc, projectId: 'p4', options: frame({ samples: 1 }) });
    expect(after.threads).toBe(2);
  });

  it('renders animations like core renderAnimation (frames in parallel, or bands)', async () => {
    const doc = SceneDoc.create({ name: 'anim' });
    const cube = doc.findObjectByName('Cube')!;
    doc.setFCurve({
      target_type: 'object',
      target_id: cube.id,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: -2, interpolation: 'LINEAR' },
        { frame: 7, value: 2, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const base = { frame_start: 1, frame_end: 7, frame_step: 3, width: 32, height: 24 };
    for (const format of ['CONTACT_SHEET', 'GIF', 'APNG'] as const) {
      const ours = await two.renderAnimation({
        scene: doc,
        projectId: 'anim',
        format,
        ...base,
        base: { engine: 'RASTER' },
      });
      const core = renderAnimation(doc, { format, ...base, engine: 'RASTER' });
      expect(ours).toMatchObject({ frames: [1, 4, 7], parallelism: 'FRAMES', threads: 2, cancelled: false });
      expect(Buffer.from(ours.data!).equals(Buffer.from(core.data!))).toBe(true);
    }
    // one path traced frame on two threads: bands of the frame
    const pt = await two.renderAnimation({
      scene: doc,
      projectId: 'anim',
      format: 'PNG_SEQUENCE',
      frame_start: 4,
      frame_end: 4,
      frame_step: 1,
      width: 24,
      height: 16,
      base: { engine: 'PATHTRACER', samples: 3 },
    });
    const corePt = renderAnimation(doc, {
      format: 'PNG_SEQUENCE',
      frame_start: 4,
      frame_end: 4,
      width: 24,
      height: 16,
      engine: 'PATHTRACER',
      samples: 3,
    });
    expect(pt.parallelism).toBe('BANDS');
    expect(pt.files!.map((f) => f.name)).toEqual(['frame_0004.png']);
    expect(Buffer.from(pt.files![0].data).equals(Buffer.from(corePt.files![0].data))).toBe(true);
    await expect(
      two.renderAnimation({
        scene: doc,
        projectId: 'anim',
        format: 'GIF',
        ...base,
        frame_end: 0,
        base: { engine: 'RASTER' },
      }),
    ).rejects.toThrow(/before frame_start/);
  });

  it('finishes renders when a worker thread dies (its work moves to the others)', async () => {
    const r = renderer(2);
    const doc = scene();
    const opts = frame({ samples: 10 });
    const stop = (t: unknown) => (t as { terminate(): void }).terminate();
    let lease = await r.pool.lease();
    expect(lease.threads).toHaveLength(2);
    let killed = false;
    const res = await pathTraceParallel(lease.threads, r.docRef('crash', doc), opts, {
      onProgress: (p) => {
        if (!killed && p.samples >= 1) {
          killed = true;
          stop(lease.threads[1]);
        }
      },
    });
    lease.release();
    expect(killed).toBe(true);
    expect(res.pathtrace).toMatchObject({ samples: 10, threads: 1 });
    expect(new Uint8Array(res.data!)).toEqual(
      new Uint8Array(renderSceneSoftware(doc, opts as SoftwareRenderOptions).data),
    );
    // frames of an animation are rendered again on another thread (a new worker replaces the dead one)
    lease = await r.pool.lease();
    expect(lease.threads).toHaveLength(2);
    let frames = 0;
    const anim = await renderAnimationParallel(
      lease.threads,
      r.docRef('crash', doc),
      {
        format: 'PNG_SEQUENCE',
        frames: [1, 2, 3, 4],
        width: 24,
        height: 16,
        fps: 24,
        base: { engine: 'RASTER' },
      },
      {
        onProgress: () => {
          if (++frames === 1) stop(lease.threads[0]);
        },
      },
    );
    lease.release();
    expect(anim.files!.map((f) => f.name)).toEqual([
      'frame_0001.png',
      'frame_0002.png',
      'frame_0003.png',
      'frame_0004.png',
    ]);
    expect(anim.cancelled).toBe(false);
  });

  it('falls back to the main thread when workers cannot start', async () => {
    const broken = renderer(2, { workerUrl: new URL('file:///nonexistent/render-worker.mjs') });
    const doc = scene();
    const r = await broken.renderImage({ scene: doc, projectId: 'p5', options: frame({ samples: 2 }) });
    expect(r.mode).toBe('main-thread');
    expect(broken.pool.mode).toBe('main-thread');
    expect(pixels(r.png)).toEqual(
      new Uint8Array(renderSceneSoftware(doc, frame({ samples: 2 }) as SoftwareRenderOptions).data),
    );
  });
});
