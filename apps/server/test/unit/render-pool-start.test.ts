import { afterAll, describe, expect, it } from 'vitest';
import { RenderPool, type RenderPoolOptions } from '../../src/render/pool';

/*
 * Which render processes the pool starts: a long lease of n threads starts n render processes, not
 * every one of RENDER_WORKERS (a video export that the memory allows one process must not start
 * eight, each about 128 MB before it renders), a larger lease starts the rest, the running ones are
 * leased first, and an interactive lease starts the process kept for interactive renders only. The
 * render processes here are a fake of test/unit/fixtures that is ready at once and answers any
 * request (render-doc-recorder.mjs).
 */

const pools: RenderPool[] = [];
function pool(opts: RenderPoolOptions): RenderPool {
  const p = new RenderPool({
    workerUrl: new URL('./fixtures/render-doc-recorder.mjs', import.meta.url),
    log: { warn: () => {} },
    ...opts,
  });
  pools.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

describe('render processes a lease starts', { timeout: 30_000 }, () => {
  it('starts as many render processes as a long lease takes, the rest for a larger one', async () => {
    const p = pool({ threads: 4 });
    expect([p.running, p.runningLong, p.runningInteractive]).toEqual([0, 0, false]);
    const one = await p.lease(1);
    expect(one.threads).toHaveLength(1);
    // one, not RENDER_WORKERS
    expect([p.running, p.runningLong, p.runningInteractive]).toEqual([1, 1, false]);
    one.release();
    // a lease of 2 starts one more and takes the running one first
    const two = await p.lease(2);
    expect(two.threads).toHaveLength(2);
    expect(two.threads[0]).toBe(one.threads[0]);
    expect(p.runningLong).toBe(2);
    two.release();
    // a long render of every render thread (a path traced image) starts the others
    const all = await p.lease();
    expect(all.threads).toHaveLength(4);
    expect(new Set(all.threads).size).toBe(4);
    expect(p.runningLong).toBe(4);
    all.release();
    // a small lease after it starts nothing and takes the longest running one
    const again = await p.lease(1);
    expect(again.threads).toEqual([one.threads[0]]);
    expect(p.running).toBe(4);
    again.release();
    // never more than RENDER_WORKERS
    const more = await p.lease(9);
    expect(more.threads).toHaveLength(4);
    expect(p.runningLong).toBe(4);
    more.release();
  });

  it('starts what the larger of two long renders waiting at once takes, and gives each its share', async () => {
    const p = pool({ threads: 4 });
    const [a, b] = await Promise.all([p.lease(1), p.lease(3)]);
    expect(a.threads).toHaveLength(1);
    expect(b.threads).toHaveLength(3);
    // the second shares the first one's process only when there is no free one
    expect(p.runningLong).toBe(3);
    expect(new Set([...a.threads, ...b.threads]).size).toBe(3);
    expect(p.activeLongRenders).toBe(2);
    a.release();
    b.release();
    expect(p.activeLongRenders).toBe(0);
  });

  it('starts only the process kept for interactive renders for an interactive lease', async () => {
    const p = pool({ threads: 3 });
    const quick = await p.lease(1, undefined, { interactive: true });
    expect(quick.threads).toHaveLength(1);
    expect([p.running, p.runningLong, p.runningInteractive]).toEqual([1, 0, true]);
    // a long lease of one next to it starts a render process of its own
    const long = await p.lease(1);
    expect(long.threads[0]).not.toBe(quick.threads[0]);
    expect([p.running, p.runningLong, p.runningInteractive]).toEqual([2, 1, true]);
    long.release();
    quick.release();
  });
});
