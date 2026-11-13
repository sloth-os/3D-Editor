import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  createPlane,
  decodePNG,
  newRigidBody,
  renderAnimation,
  renderSceneSoftware,
  type SoftwareRenderOptions,
} from '@3d-editor/core';
import {
  RenderCancelledError,
  RenderPool,
  Renderer,
  type FrameOptions,
  type RenderThread,
} from '../../src/render';
import { pathTraceParallel } from '../../src/render/path-trace';
import { renderAnimationParallel } from '../../src/render/animation';
import type { RenderRequest } from '../../src/render/pool';

/*
 * The render pool: parallel path tracing gives exactly the single-thread image, renders can be
 * cancelled and time limited, animations match core renderAnimation, quick raster renders never
 * wait for long renders, fresh threads are warmed up outside time limits, APNG frames are
 * compressed on render threads, rigid body simulations run once per render (not on every thread)
 * and the pool falls back to the main thread when render processes cannot start.
 *
 * Render processes run the TypeScript sources through tsx (worker-dev.mjs), which takes seconds to
 * start on a loaded machine: the tests have explicit timeouts and the shared pool is started first.
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

/** A thread that records the requests sent to it. */
function recording(t: RenderThread, calls: RenderRequest['type'][]): RenderThread {
  return {
    id: t.id,
    kind: t.kind,
    call: (req) => {
      calls.push(req.type);
      return t.call(req);
    },
    release: (job) => t.release(job),
    get pending() {
      return t.pending;
    },
    get alive() {
      return t.alive;
    },
  };
}

/** A ground plane and three falling boxes (rigid bodies), 5 substeps. */
function physicsScene(): SceneDoc {
  const doc = SceneDoc.create({ name: 'physics', empty: true });
  const ground = doc.addObject({
    type: 'MESH',
    name: 'Ground',
    data: doc.addMesh('Ground', createPlane({ size: 20 })),
  });
  doc.updateObject(ground, { rigid_body: { ...newRigidBody('PASSIVE'), collision_shape: 'BOX' } });
  for (let i = 0; i < 3; i++) {
    const box = doc.addObject({
      type: 'MESH',
      name: `Box${i}`,
      data: doc.addMesh(`Box${i}`, createCube({ size: 1 })),
      location: [i * 1.5 - 1.5, 0, 2 + i],
      rotation_euler: [0.3 * i, 0.2, 0],
    });
    doc.updateObject(box, { rigid_body: { ...newRigidBody('ACTIVE'), collision_shape: 'BOX' } });
  }
  const camera = doc.addObject({
    type: 'CAMERA',
    name: 'Camera',
    data: doc.addCamera({ name: 'Camera' }),
    location: [0, -14, 4],
    rotation_euler: [1.35, 0, 0],
  });
  doc.addObject({ type: 'LIGHT', name: 'Sun', data: doc.addLight({ name: 'Sun', type: 'SUN', energy: 3 }) });
  doc.updateScene({
    camera,
    rigidbody_world: {
      enabled: true,
      frame_start: 1,
      frame_end: 60,
      substeps_per_frame: 5,
      solver_iterations: 10,
      time_scale: 1,
    },
  });
  return doc;
}

describe('render pool', { timeout: 120_000 }, () => {
  const two = renderer(2);
  const main = renderer(0);

  // start the render processes before the first test (tsx transpiles the sources on start-up)
  beforeAll(async () => {
    const lease = await two.pool.lease();
    lease.release();
  }, 120_000);

  it('path traces in parallel exactly like a single-thread render', async () => {
    const doc = scene();
    const opts = frame();
    const reference = renderSceneSoftware(doc, opts as SoftwareRenderOptions);
    const parallel = await two.renderImage({ scene: doc, projectId: 'p', options: opts });
    expect(parallel).toMatchObject({
      engine: 'PATHTRACER',
      threads: 2,
      mode: 'processes',
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

  it('finishes renders when a render process dies (its work moves to the others)', async () => {
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
    // frames of an animation are rendered again on another thread (a new process replaces the dead one)
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

  it('quick raster renders do not wait for long renders holding every render thread (review #2)', async () => {
    const doc = scene();
    // start the thread kept for quick renders first (booting a tsx render process takes seconds under
    // load): a quick render while the render threads are leased brings it up
    const hold = await two.pool.lease();
    await two.renderImage({
      scene: doc,
      projectId: 'quick',
      options: frame({ engine: 'RASTER', samples: 1 }),
    });
    hold.release();
    const long = two.renderImage({
      scene: doc,
      projectId: 'quick',
      options: frame({ width: 96, height: 64, samples: 100_000, time_limit: 6 }),
    });
    // wait until the long render holds the threads
    for (let i = 0; i < 400 && two.pool.activeLongRenders === 0; i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(two.pool.activeLongRenders).toBe(1);
    const t0 = performance.now();
    const quick = await two.renderImage({
      scene: doc,
      projectId: 'quick',
      options: frame({ engine: 'RASTER', samples: 1 }),
    });
    const quickMs = performance.now() - t0;
    expect(quick.engine).toBe('RASTER');
    // the long render is still running: the raster render did not wait for it
    expect(two.pool.activeLongRenders).toBe(1);
    expect(quickMs).toBeLessThan(5000);
    const done = await long;
    expect(done.pathtrace!.stopped).toBe('time');
  });

  it('warms fresh threads up before a time-limited render starts (review #4)', async () => {
    // a new pool: its threads start (and warm up) when the render asks for them
    const cold = renderer(2);
    const r = await cold.renderImage({
      scene: scene(),
      projectId: 'cold',
      options: frame({ width: 64, height: 48, samples: 64, time_limit: 1.5 }),
    });
    expect(r.threads).toBe(2);
    // the bug: start-up, document loading and JIT warm-up ate the budget and left 1 sample per pixel
    expect(r.pathtrace!.samples).toBeGreaterThan(1);
  });

  it('compresses APNG frames on a render thread, not on the main thread (review #11)', async () => {
    const doc = SceneDoc.create({ name: 'apng' });
    const cube = doc.findObjectByName('Cube')!;
    doc.setFCurve({
      target_type: 'object',
      target_id: cube.id,
      path: 'location',
      index: 2,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 4, value: 2, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const lease = await two.pool.lease();
    const calls: RenderRequest['type'][] = [];
    try {
      const out = await renderAnimationParallel(
        lease.threads.map((t) => recording(t, calls)),
        two.docRef('apng', doc),
        { format: 'APNG', frames: [1, 2, 3, 4], width: 32, height: 24, fps: 24, base: { engine: 'RASTER' } },
      );
      const core = renderAnimation(doc, {
        format: 'APNG',
        frame_start: 1,
        frame_end: 4,
        width: 32,
        height: 24,
        engine: 'RASTER',
      });
      expect(Buffer.from(out.data!).equals(Buffer.from(core.data!))).toBe(true);
    } finally {
      lease.release();
    }
    expect(calls.filter((c) => c === 'apng-add')).toHaveLength(4);
    expect(calls).toContain('apng-finish');
  });

  it('simulates rigid bodies once per document version and shares the matrices with every thread (phase-3 #26)', async () => {
    const doc = physicsScene();
    const r = renderer(0);
    const lease = await r.pool.lease(1, undefined, { interactive: true });
    const calls: RenderRequest['type'][] = [];
    const thread = recording(lease.threads[0], calls);
    try {
      const ref = r.docRef('rb', doc);
      const first = await r.physics(doc, ref, [30, 45], thread);
      expect(calls).toEqual(['simulate']);
      const f30 = first!.get(30)!;
      expect(f30.ids).toHaveLength(3);
      expect(f30.matrices).toHaveLength(48);
      // the boxes fell: their matrices are not the start transforms
      expect(f30.matrices[14]).toBeLessThan(2);
      // again (same document version): no simulation, the same matrices
      const again = await r.physics(doc, r.docRef('rb', doc), [45, 30], thread);
      expect(calls).toEqual(['simulate']);
      expect(again!.get(30)).toBe(f30);
      // frames up to the world's start frame have nothing simulated
      expect((await r.physics(doc, r.docRef('rb', doc), [1], thread))!.get(1)!.ids).toEqual([]);
      // a change makes a new version: simulated again (a thread's own cache keeps it cheap)
      doc.updateWorld({ strength: 2 });
      await r.physics(doc, r.docRef('rb', doc), [30], thread);
      expect(calls.filter((c) => c === 'simulate')).toHaveLength(3);
      // scenes without rigid bodies do not ask threads at all
      expect(await r.physics(scene(), r.docRef('none', scene()), [30], thread)).toBeNull();
    } finally {
      lease.release();
    }
  });

  it('renders simulated frames exactly like the core renderer, after threads dropped their caches (phase-3 #26)', async () => {
    const doc = physicsScene();
    const opts = frame({ frame: 40, width: 48, height: 32, samples: 3 });
    const reference = new Uint8Array(renderSceneSoftware(doc, opts as SoftwareRenderOptions).data);
    const pooled = renderer(2, { cacheIdleMs: 50, idleTimeoutMs: 600_000 });
    const a = await pooled.renderImage({ scene: doc, projectId: 'rb2', options: opts });
    expect(pixels(a.png)).toEqual(reference);
    // the threads drop their documents (and simulation caches) when idle; the shared matrices stay
    await new Promise((res) => setTimeout(res, 1200));
    const t0 = performance.now();
    const b = await pooled.renderImage({ scene: doc, projectId: 'rb2', options: opts });
    expect(pixels(b.png)).toEqual(reference);
    expect(performance.now() - t0).toBeLessThan(20_000);
    // raster frames and animations use the same matrices
    const raster = await pooled.renderImage({
      scene: doc,
      projectId: 'rb2',
      options: frame({ frame: 40, width: 48, height: 32, engine: 'RASTER', samples: 1 }),
    });
    expect(pixels(raster.png)).toEqual(
      new Uint8Array(
        renderSceneSoftware(doc, { width: 48, height: 32, frame: 40, engine: 'RASTER', samples: 1 }).data,
      ),
    );
    const anim = await pooled.renderAnimation({
      scene: doc,
      projectId: 'rb2',
      format: 'PNG_SEQUENCE',
      frame_start: 10,
      frame_end: 40,
      frame_step: 15,
      width: 32,
      height: 24,
      base: { engine: 'RASTER', samples: 1 },
    });
    const core = renderAnimation(doc, {
      format: 'PNG_SEQUENCE',
      frame_start: 10,
      frame_end: 40,
      frame_step: 15,
      width: 32,
      height: 24,
      engine: 'RASTER',
      samples: 1,
    });
    expect(anim.files!.map((f) => f.name)).toEqual(['frame_0010.png', 'frame_0025.png', 'frame_0040.png']);
    anim.files!.forEach((f, i) =>
      expect(Buffer.from(f.data).equals(Buffer.from(core.files![i].data))).toBe(true),
    );
  });

  it('falls back to the main thread when render processes cannot start', async () => {
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
