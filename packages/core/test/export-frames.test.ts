import { describe, expect, it } from 'vitest';
import { RenderCancelledError } from '../src/export/protocol';
import { renderInOrder, type OrderedRenderOptions } from '../src/export/frames';

/*
 * The frame loop of video exports: frames render ahead on several threads, finish out of order and
 * are written in order, within a count and a byte cap; frames of a dead render process are rendered
 * again elsewhere, and when no thread is left the run ends early (threadsLost) once what was
 * rendered is written, for the caller to go on with a new lease; an item that took down too many
 * processes, errors, aborts and the lease time limit end the run.
 */

/** A fake render thread (only `alive` is read by the loop). */
interface TestThread {
  id: number;
  alive: boolean;
}

function thread(id: number): TestThread {
  return { id, alive: true };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `renderInOrder` and records what happened. */
async function run(
  patch: Partial<OrderedRenderOptions<number, TestThread>> & { delays?: (i: number) => number } = {},
): Promise<{
  result: Awaited<ReturnType<typeof renderInOrder<number, TestThread>>>;
  written: number[];
  rendered: [number, number][];
  /** Most items started and not written yet at once. */
  maxPending: number;
  /** Most renders running at once. */
  maxRunning: number;
}> {
  const threads = patch.threads ?? [thread(1), thread(2), thread(3)];
  const written: number[] = [];
  const rendered: [number, number][] = [];
  let started = 0;
  let maxPending = 0;
  let running = 0;
  let maxRunning = 0;
  const result = await renderInOrder<number, TestThread>({
    count: 12,
    threads,
    maxAhead: 6,
    maxBytes: Infinity,
    itemBytes: 1,
    async render(i, t) {
      started++;
      maxPending = Math.max(maxPending, started - written.length);
      maxRunning = Math.max(maxRunning, ++running);
      rendered.push([i, t.id]);
      await sleep(patch.delays ? patch.delays(i) : 1);
      running--;
      return i * 10;
    },
    async write(i, r) {
      expect(r).toBe(i * 10);
      written.push(i);
      await sleep(0);
    },
    ...patch,
  });
  return { result, written, rendered, maxPending, maxRunning };
}

describe('renderInOrder', () => {
  it('writes out-of-order results in order', async () => {
    // later frames finish first
    const { result, written, rendered } = await run({ delays: (i) => (12 - i) * 3 });
    expect(result).toEqual({ done: 12, retried: 0, threadsLost: false, deaths: [] });
    expect(written).toEqual([...Array(12).keys()]);
    // every thread took frames
    expect(new Set(rendered.map(([, t]) => t)).size).toBe(3);
  });

  it('runs at most maxAhead frames ahead of the writer', async () => {
    const { written, maxPending } = await run({ maxAhead: 2, delays: (i) => (i % 3) * 4 });
    expect(written).toHaveLength(12);
    expect(maxPending).toBeLessThanOrEqual(2);
    const wide = await run({ maxAhead: 64, count: 12, delays: () => 5 });
    // three threads: three renders at a time (one request per thread)
    expect(wide.maxRunning).toBeLessThanOrEqual(3);
  });

  it('goes on rendering ahead while an earlier frame is being written', async () => {
    // writing frame 0 takes long (ffmpeg busy): the threads keep rendering the next frames meanwhile
    const order: string[] = [];
    await renderInOrder<number, TestThread>({
      count: 6,
      threads: [thread(1), thread(2)],
      maxAhead: 4,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i) {
        order.push(`r${i}`);
        await sleep(1);
        return i;
      },
      async write(i) {
        order.push(`w${i}`);
        if (i === 0) await sleep(40);
      },
    });
    // frames 2 and 3 were started before frame 0's write ended (within maxAhead 4)
    const w1 = order.indexOf('w1');
    expect(order.indexOf('r2')).toBeLessThan(w1);
    expect(order.indexOf('r3')).toBeLessThan(w1);
    expect(order.filter((s) => s.startsWith('w'))).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
  });

  it('keeps the bytes of frames in flight and waiting under the cap', async () => {
    // 100 bytes per frame, 250 allowed: two at a time although four may run ahead
    const { written, maxPending } = await run({
      maxAhead: 4,
      itemBytes: 100,
      maxBytes: 250,
      delays: (i) => (i % 2 ? 1 : 8),
    });
    expect(written).toHaveLength(12);
    expect(maxPending).toBeLessThanOrEqual(2);
    // a frame larger than the cap still runs, one at a time
    const huge = await run({ itemBytes: 1000, maxBytes: 10 });
    expect(huge.written).toHaveLength(12);
    expect(huge.maxPending).toBe(1);
  });

  it('holds frames until the slow earlier one is written', async () => {
    const order: string[] = [];
    await renderInOrder<number, TestThread>({
      count: 4,
      threads: [thread(1), thread(2)],
      maxAhead: 4,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i) {
        await sleep(i === 0 ? 40 : 1);
        order.push(`r${i}`);
        return i;
      },
      async write(i) {
        order.push(`w${i}`);
      },
    });
    expect(order.indexOf('w0')).toBeGreaterThan(order.indexOf('r1'));
    expect(order.filter((s) => s.startsWith('w'))).toEqual(['w0', 'w1', 'w2', 'w3']);
  });

  it('renders the frame of a dead process again on another thread', async () => {
    const threads = [thread(1), thread(2)];
    let failed = false;
    const written: number[] = [];
    const result = await renderInOrder<number, TestThread>({
      count: 6,
      threads,
      maxAhead: 4,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i, t) {
        await sleep(2);
        if (i === 2 && !failed) {
          failed = true;
          threads[t.id - 1].alive = false;
          throw new Error('render process exited');
        }
        if (!t.alive) throw new Error('dead thread used');
        return i;
      },
      async write(i) {
        written.push(i);
      },
    });
    expect(result).toMatchObject({ done: 6, retried: 1, threadsLost: false });
    expect(result.deaths.map((e) => e.message)).toEqual(['render process exited']);
    expect(written).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('ends early when every leased process died, once the frames rendered before are written', async () => {
    // the only thread dies on item 2: items 0 and 1 are written, the caller renders the rest anew
    const one = [thread(1)];
    const written: number[] = [];
    const lost = await renderInOrder<number, TestThread>({
      count: 6,
      threads: one,
      maxAhead: 2,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i) {
        await sleep(1);
        if (i === 2) {
          one[0].alive = false;
          throw new Error('render process exited (out of memory)');
        }
        return i;
      },
      async write(i) {
        written.push(i);
      },
    });
    expect(lost).toMatchObject({ done: 2, retried: 0, threadsLost: true });
    expect(lost.deaths.map((e) => e.message)).toEqual(['render process exited (out of memory)']);
    expect(written).toEqual([0, 1]);

    // both threads die while frame 0 is still being written: the run waits for that write and
    // writes the frames already rendered after it (none twice, none lost)
    const two = [thread(1), thread(2)];
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const p = renderInOrder<number, TestThread>({
      count: 10,
      threads: two,
      maxAhead: 4,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i, t) {
        await sleep(2);
        if (i >= 3) {
          two[t.id - 1].alive = false;
          throw new Error(`render process ${t.id} exited`);
        }
        return i;
      },
      async write(i) {
        order.push(`w${i}`);
        if (i === 0) await gate;
      },
    }).then((r) => {
      order.push('end');
      return r;
    });
    await sleep(40);
    // both processes are gone, frame 0 is still being written
    expect(two.every((t) => !t.alive)).toBe(true);
    expect(order).toEqual(['w0']);
    open();
    const r = await p;
    expect(r).toMatchObject({ done: 3, threadsLost: true });
    expect(r.deaths).toHaveLength(2);
    expect(order).toEqual(['w0', 'w1', 'w2', 'end']);
  });

  it('gives up on an item that took down too many render processes', async () => {
    const threads = [thread(1), thread(2), thread(3)];
    const deaths: number[] = [];
    await expect(
      renderInOrder<number, TestThread>({
        count: 4,
        threads,
        maxAhead: 4,
        maxBytes: Infinity,
        itemBytes: 0,
        async render(i, t) {
          await sleep(1);
          if (i === 1) {
            threads[t.id - 1].alive = false;
            throw new Error(`out of memory: process ${t.id} killed`);
          }
          return i;
        },
        async write() {},
        // the second process item 1 takes down ends the run
        retryAfterDeath: (i) => {
          deaths.push(i);
          return deaths.length < 2;
        },
      }),
    ).rejects.toThrow(/out of memory: process \d killed/);
    expect(deaths).toEqual([1, 1]);
  });

  it('never sends an item to a thread that died between two items', async () => {
    const threads = [thread(1), thread(2)];
    const written: number[] = [];
    const result = await renderInOrder<number, TestThread>({
      count: 8,
      threads,
      maxAhead: 4,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i, t) {
        if (!t.alive) throw new Error(`dead thread ${t.id} used`);
        await sleep(2);
        return i;
      },
      async write(i) {
        written.push(i);
        // thread 2 dies while it has nothing to do (another render's request ended it)
        if (i === 1) threads[1].alive = false;
      },
    });
    expect(result).toEqual({ done: 8, retried: 0, threadsLost: false, deaths: [] });
    expect(written).toEqual([...Array(8).keys()]);
    // the last thread dies between two items: nothing fails, the run ends early
    const last = [thread(1)];
    const early = await renderInOrder<number, TestThread>({
      count: 5,
      threads: last,
      maxAhead: 2,
      maxBytes: Infinity,
      itemBytes: 0,
      async render(i, t) {
        if (!t.alive) throw new Error('dead thread used');
        await sleep(1);
        return i;
      },
      async write(i) {
        if (i === 1) last[0].alive = false;
      },
    });
    expect(early).toEqual({ done: 2, retried: 0, threadsLost: true, deaths: [] });
  });

  it('fails on render and write errors', async () => {
    await expect(
      run({
        async render(i) {
          if (i === 4) throw new Error('bad scene');
          return i * 10;
        },
      }),
    ).rejects.toThrow('bad scene');
    await expect(
      run({
        async write(i) {
          if (i === 3) throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    await expect(run({ threads: [] })).rejects.toThrow(/no render threads/);
  });

  it('stops on abort with RenderCancelledError', async () => {
    const abort = new AbortController();
    const p = run({ delays: () => 20, signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(p).rejects.toBeInstanceOf(RenderCancelledError);
    const already = new AbortController();
    already.abort();
    await expect(run({ signal: already.signal })).rejects.toBeInstanceOf(RenderCancelledError);
  });

  it('starts nothing after stopAfterMs and ends once started frames are written', async () => {
    const { result, written } = await run({ count: 200, delays: () => 5, stopAfterMs: 30 });
    expect(result.done).toBeGreaterThan(0);
    expect(result.done).toBeLessThan(200);
    expect(written).toEqual([...Array(result.done).keys()]);
    expect((await run({ count: 0 })).result).toEqual({
      done: 0,
      retried: 0,
      threadsLost: false,
      deaths: [],
    });
  });
});
