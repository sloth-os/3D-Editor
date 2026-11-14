import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrid, type SceneDoc } from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import { Renderer } from '../../src/render';
import {
  RENDER_MMAP_THRESHOLD_BYTES,
  RenderPool,
  type ProcessThread,
  type RenderThread,
} from '../../src/render/pool';
import type { DocRef, FrameOptions, ProcessMemory } from '../../src/render/protocol';
import { defaultFfmpegPath, hasFfmpeg } from '../../src/video/ffmpeg';
import { VideoExports, type ExportJob } from '../../src/video';
import { exportNeedsOf } from '../../src/video/exporter';
import { RENDER_PROCESS_BASE_BYTES, type MemoryReader } from '../../src/video/memory';
import { videoExportParamsSchema } from '../../src/video/params';
import { planExport } from '../../src/video/plan';
import { exportScene, fakeContext } from '../helpers/video-fake-renderer';

/*
 * Memory of video exports with real render processes and the real ffmpeg: the render processes
 * drop the renderer's working buffers when told (release-buffers, and the idle clear), and the
 * memory goes back to the system (the pool starts them with a fixed glibc mmap threshold); an export
 * renders on the render processes its memory estimate allows (job status `render`), also right
 * after another one (the processes it reuses are asked what they hold), and an export the machine
 * has no memory for is refused before anything starts. Skipped without ffmpeg unless
 * FFMPEG_REQUIRED=1 (CI installs it).
 */

const run = (await hasFfmpeg(defaultFfmpegPath())) || process.env.FFMPEG_REQUIRED === '1';
const MiB = 1024 * 1024;

const settled = (j: ExportJob) => ['done', 'failed', 'cancelled'].includes(j.status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!run)('video export memory with render processes and ffmpeg', { timeout: 180_000 }, () => {
  let renderer: Renderer;
  let exportDir = '';

  beforeAll(async () => {
    renderer = new Renderer(new RenderPool({ threads: 2 }));
    exportDir = await mkdtemp(path.join(tmpdir(), 'video-memory-'));
  });

  afterAll(async () => {
    await renderer?.close();
    if (exportDir) await rm(exportDir, { recursive: true, force: true });
  });

  /** What each long-render process of `r` holds now (after the requests sent to it before). */
  async function held(r = renderer): Promise<ProcessMemory[]> {
    const lease = await r.pool.lease(Infinity);
    try {
      return await Promise.all(lease.threads.map((t) => t.call<ProcessMemory>({ type: 'memory' })));
    } finally {
      lease.release();
    }
  }

  /** Asks `t` what it holds until `ok` (at most 5 s: V8 frees array buffers on a background thread). */
  async function heldUntil(t: RenderThread, ok: (m: ProcessMemory) => boolean): Promise<ProcessMemory> {
    let now = await t.call<ProcessMemory>({ type: 'memory' });
    for (let i = 0; i < 50 && !ok(now); i++) {
      await sleep(100);
      now = await t.call<ProcessMemory>({ type: 'memory' });
    }
    return now;
  }

  /**
   * Renders a 1280×720 frame with shadows and ambient occlusion on `t` (over 100 MB of the
   * renderer's working buffers) and returns what the process holds right after. The buffers are
   * held through WeakRefs once the render returned, so a garbage collection in between can take
   * them: both requests are sent together, so that the process mostly handles them in one turn
   * (a buffer it used is kept until that turn ends), and when a collection came in between anyway,
   * the frame is rendered again.
   */
  async function renderedHolding(t: RenderThread, ref: DocRef, frame: number): Promise<ProcessMemory> {
    const options: FrameOptions = {
      width: 1280,
      height: 720,
      frame,
      engine: 'RASTER',
      samples: 2,
      desk: { look: 'material', shadows: true, ao: true, msaa: true, passes: ['beauty', 'depth'] },
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      const [, m] = await Promise.all([
        t.call({ type: 'image', doc: ref, options, png: false }),
        t.call<ProcessMemory>({ type: 'memory' }),
      ]);
      if (m.arrayBuffers > 100 * MiB) return m;
    }
    throw new Error('the render process never held its working buffers right after a frame');
  }

  async function finished(exports: VideoExports, id: string): Promise<ExportJob> {
    for (let i = 0; i < 20; i++) {
      const job = await exports.status(id, { waitS: 10 });
      if (settled(job)) return job;
    }
    throw new Error(`export ${id} did not finish`);
  }

  function groundScene(): SceneDoc {
    const { doc } = exportScene({ shots: 1, frames: 4 });
    doc.transact(() =>
      doc.addObject({
        type: 'MESH',
        name: 'Ground',
        data: doc.addMesh('Ground', createGrid({ x_subdivisions: 120, y_subdivisions: 120, size: 20 })),
      }),
    );
    return doc;
  }

  it.skipIf(!existsSync('/proc/self/environ'))(
    'starts render processes with a fixed glibc mmap threshold',
    async () => {
      const lease = await renderer.pool.lease(1);
      try {
        const t = lease.threads[0] as ProcessThread;
        await t.call({ type: 'ping' });
        const environ = readFileSync(`/proc/${t.pid}/environ`, 'utf8').split('\0');
        const expected = process.env.MALLOC_MMAP_THRESHOLD_ ?? String(RENDER_MMAP_THRESHOLD_BYTES);
        expect(environ).toContain(`MALLOC_MMAP_THRESHOLD_=${expected}`);
      } finally {
        lease.release();
      }
    },
  );

  it('drops the renderer’s working buffers when told, and their memory goes back to the system', async () => {
    const ref = renderer.docRef('warm', groundScene());
    const lease = await renderer.pool.lease(1);
    const t = lease.threads[0] as ProcessThread;
    try {
      // release-buffers (the end of an export)
      const kept = await renderedHolding(t, ref, 1);
      t.releaseBuffers();
      const after = await heldUntil(t, (m) => m.arrayBuffers < 32 * MiB && m.rss < kept.rss - 64 * MiB);
      expect(after.arrayBuffers).toBeLessThan(32 * MiB);
      // mapped on their own (the pool's mmap threshold), the buffers' pages are unmapped when freed
      expect(after.rss).toBeLessThan(kept.rss - 64 * MiB);
      // with the documents (the end of an export no other long render shares): the idle clear,
      // which drops them too
      const again = await renderedHolding(t, ref, 2);
      t.releaseBuffers({ documents: true });
      const cleared = await heldUntil(t, (m) => m.arrayBuffers < 32 * MiB && m.rss < again.rss - 64 * MiB);
      expect(cleared.arrayBuffers).toBeLessThan(32 * MiB);
      expect(cleared.rss).toBeLessThan(again.rss - 64 * MiB);
    } finally {
      lease.release();
    }
  });

  it('gives the render processes’ working buffers back once the frames of an export are rendered', async () => {
    const { doc } = exportScene({ shots: 2, frames: 3 });
    const exports = new VideoExports(
      fakeContext({ exportDir, ffmpegPath: defaultFfmpegPath(), renderer, projects: { p1: doc } }),
    );
    try {
      const q = await exports.start(
        'p1',
        videoExportParamsSchema.parse({
          width: 1280,
          height: 720,
          quality: 'standard',
          passes: ['beauty', 'depth'],
          outputs: { clips: false, posters: false, contact_sheet: false },
        }),
      );
      const job = await finished(exports, q.id);
      expect(job.error).toBeNull();
      expect(job.status).toBe('done');
      // this machine has the memory for both render processes
      expect(job.render).toMatchObject({ processes: 2, render_workers: 2 });
      expect(job.render!.process_mb).toBeGreaterThan(200);
      expect(job.render!.available_mb).toBeGreaterThan(0);
      expect(job.warnings.some((w) => w.startsWith('memory:'))).toBe(false);
    } finally {
      await exports.close();
    }
    // the processes dropped them (V8 frees array buffers on a background thread after its
    // collection: within a moment)
    let after = await held();
    for (let i = 0; i < 50 && after.some((m) => m.arrayBuffers >= 32 * MiB); i++) {
      await sleep(100);
      after = await held();
    }
    expect(after).toHaveLength(2);
    for (const m of after) expect(m.arrayBuffers).toBeLessThan(32 * MiB);
  });

  it('renders the same export again on as many render processes right after it', async () => {
    // a pool of its own, cold at the first export
    const own = new Renderer(new RenderPool({ threads: 2 }));
    const { doc } = exportScene({ shots: 2, frames: 3 });
    const params = videoExportParamsSchema.parse({
      width: 320,
      height: 180,
      quality: 'draft',
      passes: ['beauty'],
      outputs: { clips: false, posters: false, contact_sheet: false },
    });
    const n = exportNeedsOf(doc, planExport(doc, params), params, 'h264', 2);
    // a machine whose only changing use is these render processes: just room for two cold ones
    const machine = n.ffmpeg + n.server + 2 * RENDER_PROCESS_BASE_BYTES + 2 * n.process.total + 32 * MiB;
    const pids: number[] = [];
    const rss = (pid: number): number => {
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? Number(m[1]) * 1024 : 0;
    };
    const memory: MemoryReader = () => ({
      available: machine - pids.reduce((sum, pid) => sum + rss(pid), 0),
      source: 'meminfo',
    });
    const exports = new VideoExports(
      fakeContext({
        exportDir: path.join(exportDir, 'again'),
        ffmpegPath: defaultFfmpegPath(),
        renderer: own,
        projects: { p1: doc },
      }),
      { memory },
    );
    try {
      const jobs: ExportJob[] = [];
      for (let i = 0; i < 2; i++) {
        const q = await exports.start('p1', params);
        jobs.push(await finished(exports, q.id));
        if (!pids.length) {
          // the render processes the machine reading counts from now on
          const lease = await own.pool.lease(Infinity);
          pids.push(...lease.threads.map((t) => (t as ProcessThread).pid!));
          lease.release();
        }
      }
      for (const job of jobs) {
        expect(job.status).toBe('done');
        expect(job.warnings.some((w) => w.startsWith('memory:'))).toBe(false);
      }
      expect(jobs.map((j) => j.render!.processes)).toEqual([2, 2]);
      // the second saw both processes running (less available) and reused what they hold
      expect(jobs[1].render!.available_mb).toBeLessThan(jobs[0].render!.available_mb);
    } finally {
      await exports.close();
      await own.close();
    }
  });

  it('refuses with OUT_OF_MEMORY before anything starts when not even one render process fits', async () => {
    const { doc } = exportScene({ shots: 1, frames: 4 });
    const dir = path.join(exportDir, 'refused');
    const exports = new VideoExports(
      fakeContext({ exportDir: dir, ffmpegPath: defaultFfmpegPath(), renderer, projects: { p1: doc } }),
      { memory: () => ({ available: 256 * MiB, source: 'cgroup' }) },
    );
    try {
      const err = await exports
        .start(
          'p1',
          videoExportParamsSchema.parse({ width: 1920, height: 1080, passes: ['beauty', 'depth', 'mask'] }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('OUT_OF_MEMORY');
      expect((err as ToolError).message).toMatch(
        /^Not enough memory for this video export: it needs about \d+ MB \(a render process \d+ MB at 1920×1080/,
      );
      expect((err as ToolError).message).toContain('the machine has 256 MB available');
      // no job and nothing written
      expect(await exports.list('p1')).toEqual([]);
      expect(await readdir(dir).catch(() => [])).toEqual([]);
    } finally {
      await exports.close();
    }
  });
});
