import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { RenderPool } from '../../src/render';
import {
  RENDER_OOM_SCORE_ADJ,
  RENDER_THREAD_NICE,
  lowerProcessPriority,
  preferOomKill,
  renderThreadNice,
} from '../../src/render/priority';

/*
 * Render processes run below the server (nice 10), so the event loop — HTTP requests, health
 * checks, sync, MCP — and V8's garbage collector get a core while every render process is busy
 * (/healthz answered in hundreds of milliseconds under combined render load before), and they are
 * the first processes the kernel's out-of-memory killer ends.
 */

/** The nice value of every thread of process `pid`, by thread id (Linux /proc). */
function threadNices(pid: number | 'self'): Map<number, number> {
  const out = new Map<number, number>();
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
      // fields after "(comm)": state is field 3 of stat(5), nice is field 19
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out.set(Number(tid), Number(fields[16]));
    } catch {
      // the thread ended meanwhile
    }
  }
  return out;
}

const pools: RenderPool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

describe('render process priority', () => {
  it('takes RENDER_WORKER_NICE (0–19), else 10', () => {
    expect(renderThreadNice({})).toEqual({ nice: RENDER_THREAD_NICE });
    expect(renderThreadNice({ RENDER_WORKER_NICE: '0' })).toEqual({ nice: 0 });
    expect(renderThreadNice({ RENDER_WORKER_NICE: ' 19 ' })).toEqual({ nice: 19 });
    for (const bad of ['20', '-1', '2.5', 'low'])
      expect(renderThreadNice({ RENDER_WORKER_NICE: bad })).toEqual({
        nice: RENDER_THREAD_NICE,
        problem: expect.stringContaining(`got '${bad}'`),
      });
  });

  it('does not touch the out-of-memory killer outside Linux', () => {
    expect(preferOomKill(RENDER_OOM_SCORE_ADJ, 'darwin')).toBe(false);
    expect(preferOomKill(RENDER_OOM_SCORE_ADJ, 'win32')).toBe(false);
  });

  it('never raises the priority of the calling process', () => {
    // nice 0 is at most the current value: nothing changes
    const before = os.getPriority();
    expect(lowerProcessPriority(0)).toBe(before);
    expect(os.getPriority()).toBe(before);
  });

  it.runIf(process.platform === 'linux')(
    'render processes run every thread at a lower priority, are the first the kernel ends, and the server keeps its priority',
    async () => {
      const own = os.getPriority();
      const ownThreads = threadNices('self');
      const pool = new RenderPool({ threads: 1 });
      pools.push(pool);
      const lease = await pool.lease(1);
      const thread = lease.threads[0] as unknown as {
        pid: number;
        call: (r: { type: 'ping' }) => Promise<unknown>;
      };
      await thread.call({ type: 'ping' });
      lease.release();
      const nices = [...threadNices(thread.pid).values()];
      // the render process lowered every thread it has (main thread, V8's helper threads)…
      expect(nices.length).toBeGreaterThan(1);
      expect(Math.min(...nices)).toBeGreaterThanOrEqual(Math.max(own, RENDER_THREAD_NICE));
      // …asked the kernel to end it first when memory runs out…
      expect(readFileSync(`/proc/${thread.pid}/oom_score_adj`, 'utf8').trim()).toBe(
        String(RENDER_OOM_SCORE_ADJ),
      );
      // …and the server's own threads keep their priority
      expect(os.getPriority()).toBe(own);
      for (const [tid, nice] of threadNices('self'))
        if (ownThreads.has(tid)) expect(nice).toBe(ownThreads.get(tid));
    },
    60_000,
  );
});
