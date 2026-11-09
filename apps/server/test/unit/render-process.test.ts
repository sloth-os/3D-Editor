import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SceneDoc, createGrid, decodePNG, renderSceneSoftware } from '@3d-editor/core';
import {
  RenderCancelledError,
  RenderOutOfMemoryError,
  RenderPool,
  Renderer,
  closeSharedRenderer,
  isOutOfMemory,
  sharedRenderer,
  type FrameOptions,
  type RenderThread,
} from '../../src/render';
import { crashReason, renderProcessExitError, type RenderPoolOptions } from '../../src/render/pool';
import type { DocRef } from '../../src/render/protocol';
import { OUT_OF_MEMORY_ADVICE, renderToolError } from '../../src/mcp/rendering';

/*
 * Render processes: a render that runs out of memory ends only its render process (the call fails
 * with an explained RenderOutOfMemoryError, the pool logs it and a new process serves the next
 * render), so does a process killed from outside; abandoned work is drained or the process is
 * stopped; documents are only sent to processes that lack them; closing the pool leaves no process.
 *
 * Render processes run the TypeScript sources through tsx (worker-dev.mjs) and start in about a
 * second here, several on a loaded machine: the tests have explicit timeouts.
 */

const pools: RenderPool[] = [];
type Logged = { level: string; msg: string; obj: Record<string, unknown> };
function pool(opts: RenderPoolOptions, logs: Logged[] = []): RenderPool {
  const p = new RenderPool({
    ...opts,
    log: {
      warn: (obj, msg) => logs.push({ level: 'warn', msg, obj: obj as Record<string, unknown> }),
      debug: (obj, msg) => logs.push({ level: 'debug', msg, obj: obj as Record<string, unknown> }),
    },
  });
  pools.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

/** A fake render process of test/unit/fixtures. */
const fixture = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

/** The message a pending request gets when another request ran its process out of memory. */
const SHARED_OOM =
  'the render process ran out of memory while it worked on another render that shared it; this render was ' +
  'not the cause: run it again (a new render process serves it)';

/** Runs `fn` with environment variables set (render processes copy the environment when they start). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

/** The process id of a render thread (render processes only). */
const pidOf = (t: RenderThread): number => (t as unknown as { pid: number }).pid;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** One grid of n × n quads (2 n² triangles). */
function gridScene(n: number): SceneDoc {
  const doc = SceneDoc.create({ name: `grid ${n}`, empty: true });
  doc.addObject({
    type: 'MESH',
    name: 'Grid',
    data: doc.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n, size: 2 })),
  });
  return doc;
}

const solid = (o: Partial<FrameOptions> = {}): FrameOptions => ({
  width: 64,
  height: 48,
  frame: 1,
  engine: 'RASTER',
  shading: 'SOLID',
  ...o,
});

/** Leases the process kept for quick renders (starting it) and returns its pid. */
async function quickPid(p: RenderPool): Promise<number> {
  const lease = await p.lease(1, undefined, { interactive: true });
  const pid = pidOf(lease.threads[0]);
  lease.release();
  return pid;
}

describe('render processes', { timeout: 60_000 }, () => {
  it('answers a render that runs out of memory with an explained error, logs it and renders again in a new process', async () => {
    const logs: Logged[] = [];
    // a heap of 128 MB holds a warmed-up render process, not the 490,000 faces of this grid
    // (980,000 triangles; a grid of 500 × 500 still renders in it)
    const r = new Renderer(pool({ threads: 1, heapLimitMb: 128 }, logs));
    const first = await quickPid(r.pool);
    const t0 = performance.now();
    const err = await r.renderImage({ scene: gridScene(700), projectId: 'big', options: solid() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isOutOfMemory(err)).toBe(true);
    expect((err as RenderOutOfMemoryError).heapLimitMb).toBe(128);
    expect((err as Error).message).toBe(
      'the render process ran out of memory (its JavaScript heap is limited to 128 MB); the server keeps ' +
        'running and starts a new render process for the next render',
    );
    // answered when the process died, not after a timeout
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(alive(first)).toBe(false);
    expect(logs.find((l) => l.msg.startsWith('render process ran out of memory'))?.obj).toMatchObject({
      pid: first,
      heapLimitMb: 128,
    });
    // the next render gets a new process
    const small = SceneDoc.create({ name: 'small' });
    const ok = await r.renderImage({
      scene: small,
      projectId: 'small',
      options: solid({ shading: undefined }),
    });
    expect(ok.mode).toBe('processes');
    expect(Array.from(decodePNG(ok.png).data)).toEqual(
      Array.from(renderSceneSoftware(small, { width: 64, height: 48, frame: 1, engine: 'RASTER' }).data),
    );
    expect(await quickPid(r.pool)).not.toBe(first);
  });

  it('answers the calls of a render process killed from outside (the out-of-memory killer) and replaces it', async () => {
    const r = new Renderer(pool({ threads: 1 }));
    const pid = await quickPid(r.pool);
    // a raster render of a few seconds, killed while it runs
    const render = r.renderImage({
      scene: gridScene(200),
      projectId: 'killed',
      options: solid({ width: 1600, height: 1200, samples: 4 }),
    });
    await new Promise((res) => setTimeout(res, 300));
    process.kill(pid, 'SIGKILL');
    const err = await render.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RenderOutOfMemoryError);
    expect((err as RenderOutOfMemoryError).reason).toBe('killed');
    expect((err as Error).message).toMatch(
      /^the render process was killed \(SIGKILL\), most likely by the system/,
    );
    const again = await r.renderImage({ scene: gridScene(4), projectId: 'killed', options: solid() });
    expect(again.width).toBe(64);
    expect(await quickPid(r.pool)).not.toBe(pid);
  });

  it('keeps a render process whose cancelled work ends in time, and stops one that takes too long', async () => {
    const logs: Logged[] = [];
    const quick = new Renderer(pool({ threads: 1, drainTimeoutMs: 30_000 }, logs));
    const kept = await quickPid(quick.pool);
    const abort = new AbortController();
    const render = quick.renderImage({
      scene: gridScene(60),
      projectId: 'drain',
      options: solid({ width: 640, height: 480 }),
      signal: abort.signal,
    });
    await new Promise((res) => setTimeout(res, 50));
    abort.abort();
    await expect(render).rejects.toBeInstanceOf(RenderCancelledError);
    // the process finishes the abandoned image and comes back: the same process renders next
    await quick.renderImage({ scene: gridScene(4), projectId: 'drain', options: solid() });
    expect(await quickPid(quick.pool)).toBe(kept);

    const slow = new Renderer(pool({ threads: 1, drainTimeoutMs: 50 }, logs));
    const stopped = await quickPid(slow.pool);
    const abort2 = new AbortController();
    const render2 = slow.renderImage({
      scene: gridScene(200),
      projectId: 'drain2',
      options: solid({ width: 1600, height: 1200, samples: 4 }),
      signal: abort2.signal,
    });
    await new Promise((res) => setTimeout(res, 100));
    abort2.abort();
    await expect(render2).rejects.toBeInstanceOf(RenderCancelledError);
    await until(() => !alive(stopped), 10_000, 'the busy process to be stopped');
    expect(logs.some((l) => l.msg === 'stopping a render process busy with cancelled work')).toBe(true);
    // a cancellation is not an unexpected stop
    expect(logs.some((l) => l.msg === 'render process stopped unexpectedly')).toBe(false);
    await slow.renderImage({ scene: gridScene(4), projectId: 'drain2', options: solid() });
    expect(await quickPid(slow.pool)).not.toBe(stopped);
  });

  it('sends a document state only to a process without it, and again when the process dropped it', async () => {
    const p = pool({ threads: 1 });
    const lease = await p.lease(1, undefined, { interactive: true });
    const t = lease.threads[0];
    const r = new Renderer(p);
    const docs = [2, 3, 4, 5].map((n) => gridScene(n));
    const ref = (i: number): DocRef => r.docRef(`doc${i}`, docs[i]);
    /** A DocRef whose state can be asked for only once (counts the copies sent). */
    let sent = 0;
    const counted = (d: DocRef): DocRef => ({
      key: d.key,
      version: d.version,
      get update() {
        sent++;
        return d.update;
      },
    });
    const image = (i: number) =>
      t.call({ type: 'image', doc: counted(ref(i)), options: solid({ width: 8, height: 8 }) });
    try {
      for (const i of [0, 1, 2]) await image(i);
      expect(sent).toBe(3);
      // the process has a, b and c: nothing is sent again
      await image(0);
      expect(sent).toBe(3);
      // a failing request that loaded document b makes b the process's most recent document…
      await expect(
        t.call({ type: 'export', doc: counted(ref(1)), format: 'NOPE' as never, options: {} }),
      ).rejects.toThrow();
      expect(sent).toBe(3);
      // …so the next new document makes it drop c where the pool expected a to go: c is asked for
      // without its state, refused, and sent again with it
      await image(3);
      expect(sent).toBe(4);
      const c = await t.call({
        type: 'image',
        doc: counted(ref(2)),
        options: solid({ width: 8, height: 8 }),
        png: true,
      });
      expect(c).toMatchObject({ width: 8, height: 8, png: expect.any(Uint8Array) });
      expect(sent).toBe(5);
    } finally {
      lease.release();
    }
  });

  it('stops every render process when the pool closes', async () => {
    const p = pool({ threads: 2 });
    const lease = await p.lease();
    const pids = lease.threads.map(pidOf);
    lease.release();
    expect(pids.every(alive)).toBe(true);
    await p.close();
    expect(pids.some(alive)).toBe(false);
  });

  it('tells how a render process ended', () => {
    const oom = renderProcessExitError(
      null,
      'SIGABRT',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      512,
    );
    expect(oom).toBeInstanceOf(RenderOutOfMemoryError);
    expect((oom as RenderOutOfMemoryError).reason).toBe('heap');
    expect(oom.message).toMatch(
      /^the render process ran out of memory \(its JavaScript heap is limited to 512 MB\)/,
    );
    expect((renderProcessExitError(null, 'SIGKILL', '') as RenderOutOfMemoryError).reason).toBe('killed');
    // what Node prints for an uncaught exception: the source line, the error, its stack, its banner
    const stderr =
      'file:///app/dist/render-worker.js:12\n    throw new TypeError(`bad ${x}`);\n    ^\n\n' +
      'TypeError: bad thing\n    at handle (file:///app/dist/render-worker.js:12:11)\n' +
      '    at process.<anonymous> (file:///app/dist/render-worker.js:40:3)\n\nNode.js v22.23.4\n';
    const crash = renderProcessExitError(1, null, stderr);
    expect(crash).not.toBeInstanceOf(RenderOutOfMemoryError);
    expect(crash.message).toBe('the render process exited unexpectedly (exit code 1): TypeError: bad thing');
    expect(crashReason('Error [ERR_X]: no way\n    at y (z.js:1:1)\nNode.js v22.0.0')).toBe(
      'Error [ERR_X]: no way',
    );
    // a thrown value that is not an Error: Node prints it after its hint
    expect(
      crashReason(
        'node:internal/x:1\n  triggerUncaughtException(\n  ^\nnope\n(Use `node --trace-uncaught ...` to show where the exception was thrown)\n\nNode.js v22.23.4',
      ),
    ).toBe('nope');
    expect(renderProcessExitError(null, 'SIGSEGV', '').message).toBe(
      'the render process exited unexpectedly (signal SIGSEGV)',
    );
  });

  it('answers only the request that ran a process out of memory with that error; the requests waiting behind it can run again', async () => {
    const logs: Logged[] = [];
    const p = pool({ threads: 1, heapLimitMb: 128 }, logs);
    const r = new Renderer(p);
    const lease = await p.lease(1, undefined, { interactive: true });
    const t = lease.threads[0];
    const pid = pidOf(t);
    try {
      const big = settle(t.call({ type: 'image', doc: r.docRef('big', gridScene(700)), options: solid() }));
      const behind = settle(t.call({ type: 'ping' }));
      const [a, b] = await Promise.all([big, behind]);
      expect(a).toBeInstanceOf(RenderOutOfMemoryError);
      expect((a as RenderOutOfMemoryError).reason).toBe('heap');
      expect(b).toBeInstanceOf(RenderOutOfMemoryError);
      expect((b as RenderOutOfMemoryError).reason).toBe('shared');
      expect((b as Error).message).toBe(SHARED_OOM);
      // no advice about the scene for the render that was not the cause
      expect(renderToolError(b).message).toBe(`Rendering failed: ${SHARED_OOM}.`);
      expect(renderToolError(b).code).toBe('FAILED');
      expect(renderToolError(a).message).toContain(OUT_OF_MEMORY_ADVICE);
      expect(alive(pid)).toBe(false);
      // a request sent to the ended process later was not the cause either (a long render that
      // shares the process sends its next band there)
      const late = await settle(t.call({ type: 'ping' }));
      expect((late as RenderOutOfMemoryError).reason).toBe('shared');
    } finally {
      lease.release();
    }
  });

  it('fails a long render that shared the render processes with one that ran them out of memory with an error that says it can run again', async () => {
    // two long renders share both render processes; the second one's scene does not fit into
    // their heaps of 128 MB and ends both while the first one's bands wait behind it there
    const r = new Renderer(pool({ threads: 2, heapLimitMb: 128 }));
    const pt = (o: Partial<FrameOptions>): FrameOptions => ({
      ...solid(),
      engine: 'PATHTRACER',
      shading: undefined,
      ...o,
    });
    const small = settle(
      r.renderImage({
        scene: SceneDoc.create({ name: 'small' }),
        projectId: 'small',
        options: pt({ samples: 1_000_000, time_limit: 40 }),
      }),
    );
    // the small render is under way on both processes
    await until(() => r.pool.running === 2 && r.pool.activeLongRenders === 1, 20_000, 'the small render');
    await new Promise((res) => setTimeout(res, 300));
    const big = await settle(
      r.renderImage({ scene: gridScene(700), projectId: 'big', options: pt({ samples: 1 }) }),
    );
    expect(big).toBeInstanceOf(RenderOutOfMemoryError);
    expect((big as RenderOutOfMemoryError).reason).toBe('heap');
    expect(renderToolError(big).message).toContain(OUT_OF_MEMORY_ADVICE);
    const err = await small;
    expect(err).toBeInstanceOf(RenderOutOfMemoryError);
    expect((err as RenderOutOfMemoryError).reason).toBe('shared');
    expect(renderToolError(err).message).toBe(`Rendering failed: ${SHARED_OOM}.`);
    // and it does: new render processes serve it
    const again = await r.renderImage({
      scene: SceneDoc.create({ name: 'small' }),
      projectId: 'small',
      options: pt({ samples: 1 }),
    });
    expect(again.mode).toBe('processes');
  });

  it('replaces a process that reports a failed allocation, answers the requests behind it, and runs test requests only when asked to', async () => {
    const logs: Logged[] = [];
    const p = pool({ threads: 1 }, logs);
    const lease = await withEnv({ RENDER_WORKER_TEST_JOBS: '1' }, () =>
      p.lease(1, undefined, { interactive: true }),
    );
    const t = lease.threads[0];
    const pid = pidOf(t);
    const failed = settle(t.call({ type: 'test-allocate', bytes: 2 ** 40 }));
    const behind = settle(t.call({ type: 'ping' }));
    const [a, b] = await Promise.all([failed, behind]);
    lease.release();
    expect(a).toBeInstanceOf(RenderOutOfMemoryError);
    expect((a as Error).message).toBe(
      'the render process ran out of memory (Array buffer allocation failed); the server keeps running and starts ' +
        'a new render process for the next render',
    );
    expect((b as RenderOutOfMemoryError).reason).toBe('shared');
    await until(() => !alive(pid), 10_000, 'the process to be stopped');
    expect(logs.find((l) => l.msg.startsWith('render process ran out of memory'))?.obj).toMatchObject({
      pid,
    });
    // a new process serves the next request; started without RENDER_WORKER_TEST_JOBS, it refuses test requests
    const next = await p.lease(1, undefined, { interactive: true });
    try {
      expect(pidOf(next.threads[0])).not.toBe(pid);
      await expect(next.threads[0].call({ type: 'test-allocate', bytes: 1 })).rejects.toThrow(
        "'test-allocate' is a test request: render processes answer it only with RENDER_WORKER_TEST_JOBS=1",
      );
    } finally {
      next.release();
    }
  });

  it("gives render processes their own heap limit whatever the server's NODE_OPTIONS say", async () => {
    const p = pool({ threads: 1, heapLimitMb: 160 });
    const lease = await withEnv(
      { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=1024` },
      () => p.lease(1, undefined, { interactive: true }),
    );
    try {
      // what the process reported from V8 when it started (1027 MB with the server's flag)
      expect((lease.threads[0] as unknown as { heapLimitMb: number }).heapLimitMb).toBe(160);
    } finally {
      lease.release();
    }
  });

  it('renders on the main thread after three render processes did not start in time', async () => {
    const logs: Logged[] = [];
    const p = pool({ threads: 1, startTimeoutMs: 300, workerUrl: fixture('render-never-ready.mjs') }, logs);
    const lease = await p.lease(1, undefined, { interactive: true });
    expect(lease.threads[0].kind).toBe('main');
    lease.release();
    expect(p.mode).toBe('main-thread');
    const failed = logs.filter((l) => l.msg === 'render process failed to start');
    expect(failed.map((l) => l.obj.err)).toEqual([
      'Error: the render process did not start within 300 ms',
      'Error: the render process did not start within 300 ms',
    ]);
    expect(
      logs.filter((l) => l.msg === 'render processes unavailable: rendering on the main thread'),
    ).toEqual([
      expect.objectContaining({
        obj: expect.objectContaining({ err: 'the render process did not start within 300 ms' }),
      }),
    ]);
  });

  it("mirrors a process's three documents: a state goes with the first request of each version only", async () => {
    const p = pool({ threads: 1, workerUrl: fixture('render-doc-recorder.mjs') });
    const lease = await p.lease(1, undefined, { interactive: true });
    const t = lease.threads[0];
    const call = (key: string, version: number) =>
      t.call({ type: 'image', doc: { key, version, update: new Uint8Array([1]) }, options: solid() });
    try {
      // [state sent, times the process got the request]: a second attempt would be a refused request
      const seen: [string, number, boolean, number][] = [];
      for (const [key, version] of [
        ['a', 1],
        ['a', 1],
        ['a', 2],
        ['b', 1],
        ['c', 1],
        ['a', 2],
        ['d', 1], // the process drops b, its least recently used document
        ['b', 1],
        ['c', 1], // … and then c
      ] as const) {
        const res = (await call(key, version)) as unknown as { withState: boolean; attempts: number };
        seen.push([key, version, res.withState, res.attempts]);
      }
      expect(seen).toEqual([
        ['a', 1, true, 1],
        ['a', 1, false, 1],
        ['a', 2, true, 1],
        ['b', 1, true, 1],
        ['c', 1, true, 1],
        ['a', 2, false, 1],
        ['d', 1, true, 1],
        ['b', 1, true, 1],
        ['c', 1, true, 1],
      ]);
    } finally {
      lease.release();
    }
  });

  it('tells why a render process crashed (its error, not the Node.js banner); the requests behind it can run again', async () => {
    const logs: Logged[] = [];
    const p = pool({ threads: 1, workerUrl: fixture('render-crash.mjs') }, logs);
    const lease = await p.lease(1, undefined, { interactive: true });
    const t = lease.threads[0];
    const [a, b] = await Promise.all([settle(t.call({ type: 'ping' })), settle(t.call({ type: 'ping' }))]);
    lease.release();
    const reason =
      'the render process exited unexpectedly (exit code 1): TypeError: boom in a render process';
    expect((a as Error).message).toBe(reason);
    expect((b as Error).message).toBe(
      `the render process stopped while it worked on another render that shared it (${reason}); run this render again (a new render process serves it)`,
    );
    expect(logs.find((l) => l.msg === 'render process stopped unexpectedly')?.obj.err).toBe(reason);
  });

  it('ends a busy render process within seconds when its server is killed', async () => {
    const entry = fileURLToPath(new URL('../../src/render/worker-dev.mjs', import.meta.url));
    const server = spawn(process.execPath, [fileURLToPath(fixture('render-orphan.mjs')), entry], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    server.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((res) => server.on('exit', res));
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    try {
      // busy for a minute: only its watchdog ends it (it checks every half second)
      const t0 = performance.now();
      await until(() => !alive(pid), 10_000, 'the orphaned render process to end');
      expect(performance.now() - t0).toBeLessThan(10_000);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('stops the shared render processes when the server shuts down', async () => {
    const r = sharedRenderer({ threads: 1 });
    const pid = await quickPid(r.pool);
    expect(alive(pid)).toBe(true);
    await closeSharedRenderer();
    expect(alive(pid)).toBe(false);
    // a later call starts a new renderer
    expect(sharedRenderer({ threads: 1 })).not.toBe(r);
    await closeSharedRenderer();
  });
});
