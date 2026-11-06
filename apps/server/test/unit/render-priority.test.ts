import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { RenderPool } from '../../src/render';
import { RENDER_THREAD_NICE, lowerThreadPriority, renderThreadNice } from '../../src/render/priority';

/*
 * Render threads run below the main thread (nice 10), so the event loop — HTTP requests, health
 * checks, sync, MCP — and V8's garbage collector get a core while every render thread is busy
 * (/healthz answered in hundreds of milliseconds under combined render load before).
 */

/** The nice value of every thread of this process, by thread id (Linux /proc). */
function threadNices(): Map<number, number> {
  const out = new Map<number, number>();
  for (const tid of readdirSync('/proc/self/task')) {
    try {
      const stat = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8');
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

describe('render thread priority', () => {
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

  it('is not changed where the nice value belongs to the whole process', () => {
    expect(lowerThreadPriority(RENDER_THREAD_NICE, 'darwin')).toBeNull();
    expect(lowerThreadPriority(RENDER_THREAD_NICE, 'win32')).toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'render worker threads run at a lower priority than the thread that started them',
    async () => {
      const own = os.getPriority();
      const before = threadNices();
      const pool = new RenderPool({ threads: 1 });
      pools.push(pool);
      const lease = await pool.lease(1);
      await lease.threads[0].call({ type: 'ping' });
      lease.release();
      const started = [...threadNices()].filter(([tid]) => !before.has(tid)).map(([, nice]) => nice);
      // the render worker lowered its own priority…
      expect(Math.max(...started)).toBeGreaterThanOrEqual(Math.max(own, RENDER_THREAD_NICE));
      // …and only its own: the thread serving requests keeps its priority
      expect(os.getPriority()).toBe(own);
    },
    60_000,
  );
});
