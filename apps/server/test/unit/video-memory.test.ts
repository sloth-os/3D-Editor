import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneDoc, estimateRenderBufferBytes } from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import type { Renderer } from '../../src/render';
import type { RenderLease, RenderRequest, RenderThread } from '../../src/render/pool';
import { clearFfmpegChecks, x264Threads } from '../../src/video/ffmpeg';
import { MAX_BYTES_AHEAD, decideMemory, exportNeedsOf } from '../../src/video/exporter';
import { VideoExports, type ExportJob } from '../../src/video';
import {
  RENDER_PROCESS_BASE_BYTES,
  RENDER_PROCESS_SLACK_BYTES,
  SERVER_GROWTH_BYTES,
  cgroupHeadroom,
  exportMemory,
  exportNeeds,
  ffmpegBytes,
  fewerProcessesWarning,
  outOfMemoryMessage,
  parseMemAvailable,
  planRenderProcesses,
  readMachineMemory,
  renderInfo,
  renderProcessBytes,
  reusableBytes,
  serverBytes,
  type ExportNeeds,
  type MachineMemory,
  type MemoryReader,
} from '../../src/video/memory';
import { planExport } from '../../src/video/plan';
import { qualityPreset, videoExportParamsSchema } from '../../src/video/params';
import { resultBytes, streamsFor } from '../../src/video/passes';
import { makeFakeFfmpeg, type FakeFfmpeg } from '../helpers/video-fake-ffmpeg';
import {
  exportScene,
  fakeContext,
  makeFakeRenderer,
  type FakeRenderer,
} from '../helpers/video-fake-renderer';

/*
 * Memory of video exports (video/memory.ts): the machine's available memory (MemAvailable, the
 * cgroup's headroom, os.freemem()), the estimates of a render process, of ffmpeg and of the server,
 * how many render processes fit, and what an export does with it — renders on that many (job status
 * `render`, a warning below RENDER_WORKERS), or fails with OUT_OF_MEMORY before anything starts
 * (refused when asked for, when no export runs). Render processes that already run hold memory
 * that an export reuses: they are asked (`memory`) and need only the rest, so two identical exports
 * in a row render on as many processes. Also: the render processes an export used drop their
 * working buffers (and its documents) when it ends, and every frame of a shot gets the shot's
 * ambient occlusion reach.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A file reader over a map of paths (null: unreadable). */
const files =
  (map: Record<string, string>) =>
  (p: string): string | null =>
    map[p] ?? null;

const MEMINFO =
  'MemTotal:       16472076 kB\nMemFree:        11856180 kB\nMemAvailable:   13522060 kB\nBuffers: 1 kB\n';

describe('available memory', () => {
  it('reads MemAvailable from /proc/meminfo', () => {
    expect(parseMemAvailable(MEMINFO)).toBe(13522060 * 1024);
    expect(parseMemAvailable('MemTotal: 1 kB\nMemFree: 2 kB\n')).toBeNull();
    expect(readMachineMemory({ readFile: files({ '/proc/meminfo': MEMINFO }), freemem: () => 1 })).toEqual({
      available: 13522060 * 1024,
      source: 'meminfo',
    });
  });

  it('falls back to os.freemem() without /proc/meminfo or MemAvailable', () => {
    expect(readMachineMemory({ readFile: files({}), freemem: () => 3 * GiB })).toEqual({
      available: 3 * GiB,
      source: 'freemem',
    });
    expect(
      readMachineMemory({ readFile: files({ '/proc/meminfo': 'MemFree: 9 kB\n' }), freemem: () => 2 * GiB }),
    ).toEqual({ available: 2 * GiB, source: 'freemem' });
  });

  it('takes a control group limit below MemAvailable: limit less usage plus inactive file cache', () => {
    // cgroup v2 (a container: its own namespace shows "/")
    const v2 = {
      '/proc/meminfo': MEMINFO,
      '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/memory.max': `${4 * GiB}\n`,
      '/sys/fs/cgroup/memory.current': `${3 * GiB}\n`,
      '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${GiB}\nactive_file 5\n`,
    };
    expect(readMachineMemory({ readFile: files(v2), freemem: () => 0 })).toEqual({
      available: 2 * GiB,
      source: 'cgroup',
    });
    // no limit ('max'): MemAvailable
    expect(cgroupHeadroom(files({ ...v2, '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeNull();
    // a limit above MemAvailable changes nothing
    expect(
      readMachineMemory({
        readFile: files({ ...v2, '/sys/fs/cgroup/memory.max': `${64 * GiB}\n` }),
        freemem: () => 0,
      }).source,
    ).toBe('meminfo');
    // working set never below 0, headroom never below 0
    expect(cgroupHeadroom(files({ ...v2, '/sys/fs/cgroup/memory.current': `${5 * GiB}\n` }))).toBe(0);
  });

  it('reads cgroup v1 at the process path, else at the hierarchy root', () => {
    const own = '/sys/fs/cgroup/memory/docker/abc';
    const v1 = {
      '/proc/self/cgroup': '12:pids:/docker/abc\n4:cpu,memory:/docker/abc\n0::/\n',
      [`${own}/memory.limit_in_bytes`]: `${2 * GiB}`,
      [`${own}/memory.usage_in_bytes`]: `${GiB}`,
      [`${own}/memory.stat`]: `cache 1\ninactive_file 7\ntotal_inactive_file ${256 * MiB}\n`,
    };
    // the hierarchical total_inactive_file counts
    expect(cgroupHeadroom(files(v1))).toBe(2 * GiB - (GiB - 256 * MiB));
    // the path is not in the mounted hierarchy (no cgroup namespace): its root
    const root = Object.fromEntries(
      Object.entries(v1).map(([k, v]) => [k.replace('/docker/abc/', '/'), v]),
    ) as Record<string, string>;
    expect(cgroupHeadroom(files(root))).toBe(2 * GiB - (GiB - 256 * MiB));
    // v1 reports no limit as about 2^63
    expect(
      cgroupHeadroom(files({ ...v1, [`${own}/memory.limit_in_bytes`]: '9223372036854771712' })),
    ).toBeNull();
    // nothing readable: no cap
    expect(cgroupHeadroom(files({}))).toBeNull();
    expect(cgroupHeadroom(files({ '/proc/self/cgroup': '1:cpu:/x\n' }))).toBeNull();
  });

  it('reads this machine (smoke)', () => {
    const m = readMachineMemory();
    expect(m.available).toBeGreaterThan(0);
    expect(['meminfo', 'cgroup', 'freemem']).toContain(m.source);
  });
});

describe('export memory estimates', () => {
  const preset = qualityPreset('standard', 1280, 720);
  const doc = SceneDoc.create();

  it('counts the renderer buffers of the passes asked for, the frame in flight and the slack', () => {
    const passes = ['beauty', 'depth', 'pose'] as const;
    const rb = resultBytes([...passes], 1280, 720);
    const e = renderProcessBytes(doc, {
      width: 1280,
      height: 720,
      passes: [...passes],
      look: 'material',
      preset,
      strings: false,
      resultBytes: rb,
    });
    expect(e.buffers).toBe(
      estimateRenderBufferBytes(
        {
          width: 1280,
          height: 720,
          samples: 2,
          look: 'material',
          shadows: true,
          ao: true,
          aovs: ['depth'],
          lines: undefined,
        },
        doc,
      ),
    );
    expect(e.frame).toBe(2 * rb);
    expect(e.total).toBe(e.scene + e.buffers + e.frame + RENDER_PROCESS_SLACK_BYTES);
    // a 1280×720 frame at 2 × 2 samples with shadows and occlusion: over 100 MB of buffers
    expect(e.buffers).toBeGreaterThan(100 * MiB);
    // without the beauty image: no shadows nor occlusion buffers (the passes are rendered unlit)
    const passesOnly = renderProcessBytes(doc, {
      width: 1280,
      height: 720,
      passes: ['depth'],
      look: 'material',
      preset,
      strings: false,
      resultBytes: rb,
    });
    expect(passesOnly.buffers).toBeLessThan(e.buffers);
    // a pose pass without strings is not rasterized at all
    expect(
      renderProcessBytes(doc, {
        width: 1280,
        height: 720,
        passes: ['pose'],
        look: 'material',
        preset,
        strings: false,
        resultBytes: rb,
      }).buffers,
    ).toBe(0);
    // strings in the beauty image add the line buffers
    const strings = renderProcessBytes(doc, {
      width: 1280,
      height: 720,
      passes: [...passes],
      look: 'material',
      preset,
      strings: true,
      resultBytes: rb,
    });
    expect(strings.buffers).toBeGreaterThanOrEqual(e.buffers);
  });

  it('estimates ffmpeg per encoder, by codec, quality, size and x264 threads', () => {
    const streams = streamsFor(['beauty', 'mask'], 'h264');
    expect(streams.map((s) => s.codec)).toEqual(['h264', 'h264', 'lossless']);
    const at = (w: number, h: number, q: 'draft' | 'standard' | 'high', threads = 6) =>
      ffmpegBytes(streams, q, w, h, threads);
    expect(at(1920, 1080, 'standard')).toBeGreaterThan(at(1280, 720, 'standard'));
    expect(at(1280, 720, 'draft')).toBeLessThan(at(1280, 720, 'standard'));
    expect(at(1280, 720, 'high')).toBeGreaterThan(at(1280, 720, 'standard'));
    // a 1080p standard H.264 encoder: about 535 MiB measured, estimated a little above
    const one =
      ffmpegBytes([{ codec: 'h264' }], 'standard', 1920, 1080, 6) -
      ffmpegBytes([], 'standard', 1920, 1080, 6);
    expect(one / MiB).toBeGreaterThan(535);
    expect(one / MiB).toBeLessThan(700);
    // more x264 threads hold more frames; VP9 is not counted per x264 thread
    expect(at(1280, 720, 'standard', 24)).toBeGreaterThan(at(1280, 720, 'standard', 6));
    const vp9 = streamsFor(['beauty'], 'vp9');
    expect(ffmpegBytes(vp9, 'standard', 1280, 720, 24)).toBe(ffmpegBytes(vp9, 'standard', 1280, 720, 6));
    // fewer threads than measured are not counted lower
    expect(at(1280, 720, 'standard', 2)).toBe(at(1280, 720, 'standard', 6));
  });

  it("counts x264's own thread count: 1.5 per core, at most one per two macroblock rows", () => {
    // as x264 chose them on a 4-core machine: 1 at 32 px high, 3 at 96 px, else 6
    expect(x264Threads(32, 4)).toBe(1);
    expect(x264Threads(96, 4)).toBe(3);
    expect(x264Threads(288, 4)).toBe(6);
    expect(x264Threads(720, 4)).toBe(6);
    expect(x264Threads(720, 1)).toBe(2);
    // many cores: capped by the height (22 at 720p, 34 at 1080p), not 1.5 per core
    expect(x264Threads(720, 64)).toBe(22);
    expect(x264Threads(1080, 64)).toBe(34);
    expect(x264Threads(2160, 64)).toBe(67);
    // what ffmpeg then needs: 3 streams at 1280×720 on 64 cores, about 1.5 GB (not 3.9 GB)
    const streams = streamsFor(['beauty', 'depth', 'pose'], 'h264');
    const capped = ffmpegBytes(streams, 'standard', 1280, 720, x264Threads(720, 64));
    expect(capped).toBe(ffmpegBytes(streams, 'standard', 1280, 720, 22));
    expect(capped / MiB).toBeLessThan(1600);
    expect(ffmpegBytes(streams, 'standard', 1280, 720, 96) / MiB).toBeGreaterThan(3800);
    // by default the export's own count for its height
    expect(ffmpegBytes(streams, 'standard', 1280, 720)).toBe(
      ffmpegBytes(streams, 'standard', 1280, 720, x264Threads(720)),
    );
  });

  it('keeps the server its growth and the frames it holds (at most MAX_BYTES_AHEAD)', () => {
    expect(serverBytes(2, MiB, 256 * MiB)).toBe(SERVER_GROWTH_BYTES + 6 * MiB);
    expect(serverBytes(8, 64 * MiB, 256 * MiB)).toBe(SERVER_GROWTH_BYTES + 256 * MiB);
  });

  it('fits as many render processes as the memory left holds, at most RENDER_WORKERS', () => {
    const base = {
      capacity: 4,
      processBytes: 500 * MiB,
      ffmpegBytes: GiB,
      serverBytes: 512 * MiB,
    };
    const B = RENDER_PROCESS_BASE_BYTES;
    // a process the pool starts for the export: its base and the estimate
    const P = 500 * MiB + B;
    // plenty: every one, each started for the export
    expect(planRenderProcesses({ ...base, available: 64 * GiB })).toEqual({
      processes: 4,
      reserved: 1536 * MiB,
      reused: 0,
      started: 4,
    });
    // 3 started processes' worth left after the reserve
    expect(planRenderProcesses({ ...base, available: 1536 * MiB + 3 * P }).processes).toBe(3);
    expect(planRenderProcesses({ ...base, available: 1536 * MiB + 2 * P - 1 }).processes).toBe(1);
    // not even one: a started process needs its base too
    expect(planRenderProcesses({ ...base, available: 1536 * MiB + P - 1 }).processes).toBe(0);
    expect(planRenderProcesses({ ...base, available: 1536 * MiB + P })).toMatchObject({
      processes: 1,
      started: 1,
    });
    expect(planRenderProcesses({ ...base, available: 0 }).processes).toBe(0);
    // the processes it does not lease take nothing: the pool starts only what a lease takes (it
    // used to start all RENDER_WORKERS, whose bases left room for one process here, not two)
    expect(planRenderProcesses({ ...base, available: 1536 * MiB + 2 * P })).toMatchObject({
      processes: 2,
      reserved: 1536 * MiB,
    });
    // another process the export may start (the contact sheet's interactive one) keeps its base
    const other = planRenderProcesses({ ...base, otherStarting: 1, available: 1536 * MiB + 2 * P });
    expect(other.reserved).toBe(1536 * MiB + B);
    expect(other.processes).toBe(1);
    // RENDER_WORKERS 1, 2
    expect(planRenderProcesses({ ...base, capacity: 1, available: 64 * GiB }).processes).toBe(1);
    expect(planRenderProcesses({ ...base, capacity: 2, available: 64 * GiB }).processes).toBe(2);
  });

  it('lets running render processes reuse what they hold, in the order the pool leases them', () => {
    const base = {
      capacity: 4,
      processBytes: 500 * MiB,
      ffmpegBytes: GiB,
      serverBytes: 512 * MiB,
    };
    const B = RENDER_PROCESS_BASE_BYTES;
    // two running processes holding 400 MB each need 100 MB each and no base
    const warm = planRenderProcesses({
      ...base,
      available: 1536 * MiB + 200 * MiB,
      reuse: [400 * MiB, 400 * MiB],
    });
    expect(warm).toEqual({ processes: 2, reserved: 1536 * MiB, reused: 800 * MiB, started: 0 });
    // a third one is started for the export: its base and all 500 MB
    const third = { ...base, reuse: [400 * MiB, 400 * MiB] };
    expect(
      planRenderProcesses({ ...third, available: 1536 * MiB + 200 * MiB + 500 * MiB + B - 1 }).processes,
    ).toBe(2);
    expect(planRenderProcesses({ ...third, available: 1536 * MiB + 200 * MiB + 500 * MiB + B })).toEqual({
      processes: 3,
      reserved: 1536 * MiB,
      reused: 800 * MiB,
      started: 1,
    });
    // running processes that hold nothing need the estimate, not their base again
    expect(
      planRenderProcesses({ ...base, available: 1536 * MiB + 1000 * MiB, reuse: [0, 0] }).processes,
    ).toBe(2);
    expect(planRenderProcesses({ ...base, available: 1536 * MiB + 1000 * MiB }).processes).toBe(1);
    // what a process holds counts up to what it needs, never as memory for another
    expect(planRenderProcesses({ ...base, available: 1536 * MiB, reuse: [4 * GiB] })).toEqual({
      processes: 1,
      reserved: 1536 * MiB,
      reused: 500 * MiB,
      started: 0,
    });
    // the pool leases its processes in order: a running one that holds nothing first takes its whole estimate
    expect(
      planRenderProcesses({ ...base, available: 1536 * MiB + 500 * MiB, reuse: [0, 500 * MiB, 500 * MiB] })
        .processes,
    ).toBe(3);
    expect(
      planRenderProcesses({ ...base, available: 1536 * MiB + 400 * MiB, reuse: [0, 500 * MiB, 500 * MiB] })
        .processes,
    ).toBe(0);
    // an unreadable amount counts as nothing held
    expect(
      planRenderProcesses({ ...base, available: 1536 * MiB + 500 * MiB, reuse: [Number.NaN] }).processes,
    ).toBe(1);
  });

  it('counts what a running process holds above its base, up to what an export needs but its scene', () => {
    const e = { scene: 30 * MiB, buffers: 100 * MiB, frame: 10 * MiB, total: 268 * MiB };
    expect(reusableBytes(0, e)).toBe(0);
    expect(reusableBytes(RENDER_PROCESS_BASE_BYTES - MiB, e)).toBe(0);
    expect(reusableBytes(RENDER_PROCESS_BASE_BYTES + 100 * MiB, e)).toBe(100 * MiB);
    // the snapshot of the export is new to every process
    expect(reusableBytes(RENDER_PROCESS_BASE_BYTES + 900 * MiB, e)).toBe(238 * MiB);
    expect(reusableBytes(Infinity, e)).toBe(238 * MiB);
    expect(reusableBytes(Number.NaN, e)).toBe(238 * MiB);
  });

  it('decides with the processes it starts, the running ones and the contact sheet', () => {
    const passes = ['beauty', 'depth'] as const;
    const needs = exportNeeds({
      snapshot: doc,
      width: 1280,
      height: 720,
      passes: [...passes],
      look: 'material',
      preset,
      strings: false,
      streams: streamsFor([...passes], 'h264'),
      quality: 'standard',
      capacity: 2,
      maxBytesAhead: MAX_BYTES_AHEAD,
    });
    const T = needs.process.total;
    const R = needs.ffmpeg + needs.server;
    const B = RENDER_PROCESS_BASE_BYTES;
    const machine = (available: number): MachineMemory => ({ available, source: 'meminfo' });
    // a cold pool: both processes started with their bases, one more for the interactive process
    // the contact sheet may start
    const cold = exportMemory(needs, { interactive: true, machine: machine(R + 3 * B + 2 * T) });
    expect(cold).toMatchObject({ processes: 2, starting: 3 * B, reuse: [] });
    expect(exportMemory(needs, { machine: machine(R + 2 * B + 2 * T - 1) }).processes).toBe(1);
    // memory for one: only its base is started (not RENDER_WORKERS bases)
    expect(exportMemory(needs, { machine: machine(R + B + T) })).toMatchObject({ processes: 1, starting: B });
    // running processes: no base to start, what they hold above theirs is reused
    const held = 100 * MiB;
    const warm = exportMemory(needs, {
      warm: [B + held, B + held],
      machine: machine(R + 2 * (T - held)),
    });
    expect(warm).toMatchObject({ processes: 2, starting: 0, reuse: [held, held] });
    // the same memory for a cold pool: each process needs its base and all of the estimate
    expect(exportMemory(needs, { machine: machine(R + B + T + (T - held)) }).processes).toBe(1);
    // one running, one started for the export
    expect(exportMemory(needs, { warm: [B + held], machine: machine(R + (T - held) + B + T) })).toMatchObject(
      { processes: 2, starting: B, reuse: [held] },
    );
    // more running processes than RENDER_WORKERS: only RENDER_WORKERS are leased
    expect(
      exportMemory(needs, { warm: [Infinity, Infinity, Infinity], machine: machine(64 * GiB) }).reuse,
    ).toHaveLength(2);
  });

  it('says what an export needs and what to change when it does not fit', () => {
    const passes = ['beauty', 'depth', 'mask'] as const;
    const machine: MachineMemory = { available: 300 * MiB, source: 'meminfo' };
    const needs = exportNeeds({
      snapshot: doc,
      width: 1920,
      height: 1080,
      passes: [...passes],
      look: 'material',
      preset: qualityPreset('standard', 1920, 1080),
      strings: false,
      streams: streamsFor([...passes], 'h264'),
      quality: 'standard',
      capacity: 2,
      maxBytesAhead: MAX_BYTES_AHEAD,
    });
    const B = RENDER_PROCESS_BASE_BYTES;
    const m = exportMemory(needs, { machine });
    expect(m.processes).toBe(0);
    expect(m.encoders).toBe(4);
    // what the first process it would lease needs: started for it, with its base
    expect(m.starting).toBe(B);
    const msg = outOfMemoryMessage(m, 1920, 1080);
    const mb = (b: number) => Math.round(b / MiB);
    expect(msg).toContain(
      `it needs about ${mb(m.process.total + m.ffmpeg + m.server + B)} MB (a render process ${mb(m.process.total)} MB at 1920×1080`,
    );
    expect(msg).toContain(`ffmpeg's 4 encoders ${mb(m.ffmpeg)} MB`);
    expect(msg).toContain(`the server and starting render processes ${mb(m.server + B)} MB`);
    expect(msg).toContain('the machine has 300 MB available');
    expect(msg).toContain("export a smaller size (width and height), fewer passes or quality 'draft'");
    // the pool starts only the processes an export leases: fewer RENDER_WORKERS would not help
    expect(msg).not.toContain('RENDER_WORKERS');
    expect(msg).not.toContain('held by a running one');
    // the interactive process the contact sheet may start keeps its base too
    expect(exportMemory(needs, { interactive: true, machine }).starting).toBe(2 * B);
    // a running process holding part of it: the need is what it does not hold, and no base
    const warm = exportMemory(needs, { warm: [B + 64 * MiB], machine });
    expect(warm.starting).toBe(0);
    expect(outOfMemoryMessage(warm, 1920, 1080)).toContain(
      `it needs about ${mb(warm.process.total - 64 * MiB + warm.ffmpeg + warm.server)} MB`,
    );
    expect(outOfMemoryMessage(warm, 1920, 1080)).toContain('64 MB of it held by a running one already');
    expect(renderInfo(m)).toEqual({
      processes: 0,
      render_workers: 2,
      process_mb: mb(m.process.total + RENDER_PROCESS_BASE_BYTES),
      ffmpeg_mb: mb(m.ffmpeg),
      available_mb: 300,
      memory_source: 'meminfo',
    });
    const fewer = fewerProcessesWarning({ ...m, processes: 1, capacity: 4 });
    expect(fewer).toMatch(
      /^memory: the 300 MB available hold 1 of the 4 render processes \(RENDER_WORKERS\)/,
    );
    expect(fewer).toContain('renders on 1 and takes longer');
  });
});

// ---------------------------------------------------------------- exports with fakes

let ffmpeg: FakeFfmpeg;

beforeAll(async () => {
  ffmpeg = await makeFakeFfmpeg();
});

afterEach(() => {
  clearFfmpegChecks();
});

const params = (p: Record<string, unknown> = {}) =>
  videoExportParamsSchema.parse({ width: 32, height: 18, ...p });

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settled = (j: ExportJob) => ['done', 'failed', 'cancelled'].includes(j.status);

/** What the instrumented fake renderer saw: lease sizes, buffer releases, events in order. */
interface Seen {
  leases: number[];
  /** Thread id → releaseBuffers calls. */
  released: Map<number, number>;
  /** Whether each releaseBuffers call dropped the documents too. */
  documents: boolean[];
  /** 'image:<thread>' and 'release:<thread>' in the order they happened. */
  events: string[];
  /** The ambient occlusion reach of each frame's desk options. */
  aoRadius: (number | undefined)[];
}

/**
 * The fake renderer's threads with a releaseBuffers spy and the shot measurement answering an
 * ambient occlusion reach (0.123 m); records every long lease's size.
 */
function instrument(fake: FakeRenderer): Seen {
  const seen: Seen = { leases: [], released: new Map(), documents: [], events: [], aoRadius: [] };
  const pool = fake.renderer.pool as unknown as {
    lease(max?: number, signal?: AbortSignal, o?: { interactive?: boolean }): Promise<RenderLease>;
  };
  const lease = pool.lease.bind(pool);
  const done = new WeakSet<object>();
  pool.lease = async (max = Infinity, signal, o = {}) => {
    const l = await lease(max, signal, o);
    if (!o.interactive) seen.leases.push(max);
    for (const t of l.threads) {
      if (done.has(t)) continue;
      done.add(t);
      const call = t.call.bind(t);
      Object.assign(t as RenderThread, {
        releaseBuffers(r: { documents?: boolean } = {}) {
          seen.released.set(t.id, (seen.released.get(t.id) ?? 0) + 1);
          seen.documents.push(!!r.documents);
          seen.events.push(`release:${t.id}`);
        },
        async call(req: RenderRequest) {
          if (req.type === 'image') {
            seen.events.push(`image:${t.id}`);
            seen.aoRadius.push(req.options.desk?.aoRadius);
          }
          const res = await call(req);
          return req.type === 'desk-shot' ? { ...(res as object), aoRadius: 0.123 } : res;
        },
      });
    }
    return l;
  };
  return seen;
}

const plenty: MemoryReader = () => ({ available: 1024 * GiB, source: 'meminfo' });
const B = RENDER_PROCESS_BASE_BYTES;

async function service(
  o: { threads?: number; memory?: MemoryReader; frames?: number; renderer?: FakeRenderer } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-memory-'));
  const { doc } = exportScene({ shots: 2, frames: o.frames ?? 6 });
  const renderer = o.renderer ?? makeFakeRenderer({ threads: o.threads ?? 2 });
  const seen = instrument(renderer);
  const ctx = fakeContext({
    exportDir: dir,
    ffmpegPath: ffmpeg.path,
    renderer: renderer.renderer,
    projects: { p1: doc },
  });
  const exports = new VideoExports(ctx, { memory: o.memory ?? plenty });
  return { exports, renderer, seen, doc, dir };
}

/** What an export of `doc` with `p` needs, as the exporter computes it. */
function needsOf(doc: SceneDoc, p: ReturnType<typeof params>, capacity: number): ExportNeeds {
  return exportNeedsOf(doc, planExport(doc, p), p, p.codec, capacity);
}

/** The ffmpeg encoders and the server: kept before any render process. */
const kept = (n: ExportNeeds) => n.ffmpeg + n.server;

/** `start` refused with OUT_OF_MEMORY (its message). */
async function refused(start: Promise<unknown>): Promise<string> {
  const err = await start.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolError);
  expect((err as ToolError).code).toBe('OUT_OF_MEMORY');
  return (err as ToolError).message;
}

describe('exports and the machine memory', { timeout: 30_000 }, () => {
  it('renders on every render process when memory is plenty; the job tells how', async () => {
    const { exports, seen, renderer } = await service({ threads: 4 });
    const q = await exports.start('p1', params({ passes: ['beauty', 'depth'] }));
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    expect(job.render).toMatchObject({ processes: 4, render_workers: 4, memory_source: 'meminfo' });
    expect(job.render!.process_mb).toBeGreaterThanOrEqual(
      Math.round((RENDER_PROCESS_BASE_BYTES + RENDER_PROCESS_SLACK_BYTES) / MiB),
    );
    expect(job.render!.ffmpeg_mb).toBeGreaterThan(0);
    expect(job.warnings.some((w) => w.startsWith('memory:'))).toBe(false);
    expect(seen.leases.length).toBeGreaterThan(0);
    expect(seen.leases.every((n) => n === 4)).toBe(true);
    // nothing ran before it: no render process was asked what it holds
    expect(renderer.stats.memoryCalls).toEqual([]);
    await exports.close();
  });

  it('renders on fewer render processes when memory is short, and says so', async () => {
    const p = params({ passes: ['beauty', 'depth'] });
    const n = needsOf(exportScene({ shots: 2, frames: 6 }).doc, p, 4);
    // the base of the interactive one (contact sheet) first, then two and a half render processes
    // started with their bases
    const memory: MemoryReader = () => ({
      available: kept(n) + B + 2 * (B + n.process.total) + 0.5 * n.process.total,
      source: 'cgroup',
    });
    const { exports, seen, renderer } = await service({ threads: 4, memory });
    const q = await exports.start('p1', p);
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    expect(job.render).toMatchObject({ processes: 2, render_workers: 4, memory_source: 'cgroup' });
    expect(job.warnings.find((w) => w.startsWith('memory:'))).toMatch(
      /hold 2 of the 4 render processes \(RENDER_WORKERS\).*renders on 2 and takes longer/,
    );
    // every lease asked for 2 threads, and only 2 threads rendered
    expect(seen.leases.every((k) => k === 2)).toBe(true);
    const threads = new Set(seen.events.filter((e) => e.startsWith('image:')).map((e) => e.split(':')[1]));
    expect(threads.size).toBe(2);
    expect(renderer.stats.images).toHaveLength(12);
    // and the pool started those 2 only
    expect(renderer.renderer.pool.running).toBe(2);
    await exports.close();
  });

  it('refuses with OUT_OF_MEMORY when asked for, when not even one render process fits', async () => {
    const { exports, seen, renderer, dir } = await service({
      threads: 2,
      memory: () => ({ available: 200 * MiB, source: 'meminfo' }),
    });
    const before = (await ffmpeg.calls()).filter((a) => a.includes('pipe:0')).length;
    const msg = await refused(exports.start('p1', params({ passes: ['beauty', 'depth', 'mask'] })));
    expect(msg).toMatch(/^Not enough memory for this video export: it needs about \d+ MB/);
    expect(msg).toContain("export a smaller size (width and height), fewer passes or quality 'draft'");
    expect(msg).toContain('the machine has 200 MB available');
    // no job, nothing leased, rendered or encoded, nothing written
    expect(await exports.list('p1')).toEqual([]);
    expect(seen.leases).toEqual([]);
    expect(renderer.stats.images).toHaveLength(0);
    expect((await ffmpeg.calls()).filter((a) => a.includes('pipe:0')).length).toBe(before);
    expect(await readdir(dir)).toEqual([]);
    await exports.close();
  });

  it('fails with OUT_OF_MEMORY before rendering or starting ffmpeg when memory went when it runs', async () => {
    let reads = 0;
    const { exports, seen, renderer, dir } = await service({
      threads: 2,
      // enough when it is asked for, 200 MB when it runs
      memory: () => ({ available: reads++ === 0 ? 64 * GiB : 200 * MiB, source: 'meminfo' }),
    });
    const before = (await ffmpeg.calls()).filter((a) => a.includes('pipe:0')).length;
    const q = await exports.start('p1', params({ passes: ['beauty', 'depth', 'mask'] }));
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('OUT_OF_MEMORY');
    expect(job.error).toMatch(/^Not enough memory for this video export: it needs about \d+ MB/);
    expect(job.render).toMatchObject({ processes: 0, render_workers: 2, available_mb: 200 });
    expect(seen.leases).toEqual([]);
    expect(renderer.stats.images).toHaveLength(0);
    expect((await ffmpeg.calls()).filter((a) => a.includes('pipe:0')).length).toBe(before);
    expect(await readdir(path.join(dir, 'p1', job.id))).toEqual(['job.json']);
    await exports.close();
  });

  it('takes an export while another runs, and decides when it starts', async () => {
    let short = false;
    const { exports, renderer } = await service({
      threads: 2,
      frames: 30,
      memory: () => ({ available: short ? 200 * MiB : 64 * GiB, source: 'meminfo' }),
    });
    renderer.delayMs = 15;
    const first = await exports.start('p1', params());
    await until(
      () => exports.status(first.id),
      (j) => j.status === 'running' && j.progress.frames_done > 0,
    );
    // what the running export takes now comes back when it ends: not refused now
    short = true;
    const second = await exports.start('p1', params());
    expect(second.status).toBe('queued');
    const a = await until(() => exports.status(first.id, { waitS: 5 }), settled);
    expect(a.status).toBe('done');
    const b = await until(() => exports.status(second.id, { waitS: 5 }), settled);
    expect(b.status).toBe('failed');
    expect(b.error_code).toBe('OUT_OF_MEMORY');
    await exports.close();
  });

  it('keeps the base of the interactive render process the contact sheet may start', async () => {
    const run = async (contact_sheet: boolean) => {
      const p = params({ passes: ['beauty'], outputs: { contact_sheet } });
      const n = needsOf(exportScene({ shots: 2, frames: 6 }).doc, p, 2);
      // the interactive process's base, and two render processes started with theirs but for 1 MiB
      const { exports } = await service({
        threads: 2,
        memory: () => ({ available: kept(n) + B + 2 * (B + n.process.total) - MiB, source: 'meminfo' }),
      });
      const q = await exports.start('p1', p);
      const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
      await exports.close();
      expect(job.status).toBe('done');
      return job.render!.processes;
    };
    expect(await run(true)).toBe(1);
    expect(await run(false)).toBe(2);
  });

  it('estimates the duration with the render processes the memory holds', async () => {
    const p = params({ width: 1920, height: 1080, passes: ['beauty'], outputs: { contact_sheet: false } });
    const n = needsOf(exportScene({ shots: 2, frames: 6 }).doc, p, 4);
    const eta = async (memory: MemoryReader) => {
      const { exports } = await service({ threads: 4, memory });
      const q = await exports.start('p1', p);
      await exports.cancel(q.id);
      await exports.close();
      return q.progress.eta_s!;
    };
    const one = await eta(() => ({
      available: kept(n) + B + 1.5 * n.process.total,
      source: 'meminfo',
    }));
    const four = await eta(plenty);
    // 12 frames of 1920×1080 on one render process, against four: about four times as long
    expect(four).toBeGreaterThan(2);
    expect(one - 2).toBeGreaterThanOrEqual(4 * (four - 2) - 2);
  });
});

describe('render processes that already run', { timeout: 30_000 }, () => {
  it('renders two identical exports in a row on as many processes (what they hold is reused)', async () => {
    const p = params({ passes: ['beauty', 'depth'] });
    const fake = makeFakeRenderer({ threads: 2 });
    const n = needsOf(exportScene({ shots: 2, frames: 6 }).doc, p, 2);
    // after an export a process keeps most of what it needed (glibc's heap, V8's pages)
    const held = n.process.total - n.process.scene - 16 * MiB;
    fake.rss = (id) => B + (fake.stats.imagesByThread.get(id) ? held : 0);
    // a machine whose only changing use is the render processes: just room for two cold ones
    const machine = kept(n) + 3 * B + 2 * n.process.total + 8 * MiB;
    const memory: MemoryReader = () => ({
      available: machine - fake.started().reduce((sum, t) => sum + fake.rss(t.id), 0),
      source: 'meminfo',
    });
    const { exports } = await service({ renderer: fake, memory });
    const processes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await exports.start('p1', p);
      const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
      expect(job.status).toBe('done');
      expect(job.warnings.some((w) => w.startsWith('memory:'))).toBe(false);
      processes.push(job.render!.processes);
    }
    expect(processes).toEqual([2, 2, 2]);
    // the first ran on a cold pool; the others asked both processes what they hold
    expect(fake.stats.memoryCalls).toHaveLength(4);
    await exports.close();
  });

  it('does not keep the base of render processes that run already', async () => {
    const p = params({ passes: ['beauty', 'depth'] });
    const n = needsOf(exportScene({ shots: 2, frames: 6 }).doc, p, 4);
    let limited = false;
    // running processes at their base (128 MiB, nothing held): the machine counts them already
    const { exports, renderer } = await service({
      threads: 4,
      memory: () =>
        limited
          ? { available: kept(n) + B + 2.5 * n.process.total, source: 'meminfo' }
          : { available: 64 * GiB, source: 'meminfo' },
    });
    const warmUp = await exports.start('p1', p);
    expect((await until(() => exports.status(warmUp.id, { waitS: 5 }), settled)).render!.processes).toBe(4);
    expect(renderer.renderer.pool.running).toBe(4);
    limited = true;
    const q = await exports.start('p1', p);
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    // the bases of the 4 running ones are not kept again (the interactive one's is: it does not run)
    expect(job.render!.processes).toBe(2);
    await exports.close();
  });
});

describe('the memory decision with running render processes', () => {
  const doc = exportScene({ shots: 1, frames: 4 }).doc;
  const p = params({ width: 1280, height: 720, passes: ['beauty', 'depth'] });
  const n = needsOf(doc, p, 2);
  const T = n.process.total;
  const machine = (available: number): MachineMemory => ({ available, source: 'meminfo' });

  /**
   * A pool of 2 running render processes of long renders, each `rss`, `busy` ones with work of
   * another render (`interactive`: the process kept for interactive renders runs too).
   */
  function pool(o: {
    rss: number;
    others?: number;
    busy?: number[];
    running?: number;
    interactive?: boolean;
  }) {
    const calls: number[] = [];
    let leases = 0;
    const threads = [1, 2].map((id) => ({
      id,
      kind: 'process' as const,
      alive: true,
      pending: o.busy?.includes(id) ? 1 : 0,
      release() {},
      async call(req: RenderRequest) {
        expect(req.type).toBe('memory');
        calls.push(id);
        return { rss: o.rss, heapUsed: 0, external: 0, arrayBuffers: 0 };
      },
    }));
    const running = o.running ?? 2;
    const fakePool = {
      mode: 'processes',
      capacity: 2,
      running: running + (o.interactive ? 1 : 0),
      runningLong: running,
      runningInteractive: !!o.interactive,
      activeLongRenders: 1 + (o.others ?? 0),
      async lease(max: number) {
        leases++;
        // the running processes only: asking them must not start another
        expect(max).toBe(running);
        return { threads: threads.slice(0, max), release() {} };
      },
    } as unknown as Renderer['pool'];
    return { pool: fakePool, calls, leases: () => leases };
  }
  const signal = new AbortController().signal;
  // room for the two processes, each less 100 MB they hold already (and the interactive base)
  const tight = kept(n) + B + 2 * (T - 100 * MiB);
  const read = (available: number) => () => ({ available, source: 'meminfo' as const });

  it('asks the running processes what they hold, and counts it', async () => {
    const f = pool({ rss: B + 100 * MiB });
    const m = await decideMemory(f.pool, n, { read: read(tight), contactSheet: true, signal });
    expect(f.calls).toEqual([1, 2]);
    expect(f.leases()).toBe(1);
    expect(m).toMatchObject({ processes: 2, reuse: [100 * MiB, 100 * MiB], starting: B });
  });

  it('counts nothing of processes another render uses now', async () => {
    const shared = pool({ rss: B + 100 * MiB, others: 1 });
    const m = await decideMemory(shared.pool, n, { read: read(tight), contactSheet: true, signal });
    expect(shared.calls).toEqual([]);
    expect(m).toMatchObject({ processes: 1, reuse: [0, 0] });
    expect(T).toBeGreaterThan(200 * MiB);
    const busy = pool({ rss: B + 100 * MiB, busy: [1] });
    const b = await decideMemory(busy.pool, n, { read: read(tight), contactSheet: true, signal });
    expect(busy.calls).toEqual([2]);
    expect(b.reuse).toEqual([0, 100 * MiB]);
  });

  it('asks nothing when the cold plan fits every one, nothing runs, or nothing could help', async () => {
    const fits = pool({ rss: B + 100 * MiB });
    expect(
      (await decideMemory(fits.pool, n, { read: read(64 * GiB), contactSheet: true, signal })).processes,
    ).toBe(2);
    // nothing runs: the plan of a cold pool (both bases and the interactive one kept)
    const idle = pool({ rss: B + 100 * MiB, running: 0 });
    const cold = exportMemory(n, { interactive: true, machine: machine(tight + 3 * B) });
    expect(cold.processes).toBe(1);
    expect(
      (await decideMemory(idle.pool, n, { read: read(tight + 3 * B), contactSheet: true, signal })).processes,
    ).toBe(1);
    // ffmpeg and the server alone do not fit: no process could
    const none = pool({ rss: B + 100 * MiB });
    expect(
      (await decideMemory(none.pool, n, { read: read(kept(n) - MiB), contactSheet: true, signal })).processes,
    ).toBe(0);
    expect([...fits.calls, ...idle.calls, ...none.calls]).toEqual([]);
    expect(fits.leases() + idle.leases() + none.leases()).toBe(0);
  });

  it('asks only the running processes: none is started to be asked', async () => {
    // RENDER_WORKERS 4, two of them running: the probe leases those two (the pool would start the
    // others for a lease of four), and the export starts the others only when they fit
    const n4 = needsOf(doc, p, 4);
    const f = pool({ rss: B + 100 * MiB });
    // room for the two running ones less what they hold, not for a third started one
    const room = kept(n4) + B + 2 * (n4.process.total - 100 * MiB) + n4.process.total;
    const m = await decideMemory(f.pool, n4, { read: read(room), contactSheet: true, signal });
    expect(f.leases()).toBe(1);
    expect(f.calls).toEqual([1, 2]);
    expect(m).toMatchObject({ processes: 2, reuse: [100 * MiB, 100 * MiB], starting: B });
  });

  it('keeps the interactive base only while the interactive process does not run', async () => {
    const without = pool({ rss: B + 100 * MiB, interactive: true });
    const m = await decideMemory(without.pool, n, {
      read: read(tight - B),
      contactSheet: true,
      signal,
    });
    expect(m).toMatchObject({ processes: 2, starting: 0 });
  });
});

describe('render buffers and occlusion reach of exports', { timeout: 30_000 }, () => {
  it('releases the working buffers of every render process it used once its frames are rendered', async () => {
    const { exports, seen } = await service({ threads: 2 });
    const q = await exports.start('p1', params());
    const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
    expect(job.status).toBe('done');
    expect([...seen.released.values()]).toEqual([1, 1]);
    // with the documents: its snapshot is of no use after it (no other long render runs)
    expect(seen.documents).toEqual([true, true]);
    // after the last frame
    const lastImage = seen.events.map((e) => e.startsWith('image:')).lastIndexOf(true);
    const firstRelease = seen.events.findIndex((e) => e.startsWith('release:'));
    expect(firstRelease).toBeGreaterThan(lastImage);
    // each frame with the shot's occlusion reach (the fake shot measurement says 0.123 m)
    expect(seen.aoRadius).toHaveLength(12);
    expect(seen.aoRadius.every((r) => r === 0.123)).toBe(true);
    await exports.close();
  });

  it('keeps the documents of render processes another long render uses when it ends', async () => {
    const { exports, seen, renderer } = await service({ threads: 2 });
    // a long render (a path traced image, an animation) holds the processes too
    const other = await renderer.renderer.pool.lease(2);
    try {
      const q = await exports.start('p1', params());
      const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
      expect(job.status).toBe('done');
      expect([...seen.released.values()]).toEqual([1, 1]);
      expect(seen.documents).toEqual([false, false]);
    } finally {
      other.release();
    }
    await exports.close();
  });

  it('releases them when the export fails or is cancelled, but not on a dead process', async () => {
    {
      const { exports, seen, renderer } = await service({ threads: 2 });
      renderer.failFrame = { frame: 4, error: new Error('frame 4 broke') };
      const q = await exports.start('p1', params());
      const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
      expect(job.status).toBe('failed');
      expect(job.error_code).toBeUndefined();
      expect([...seen.released.values()]).toEqual([1, 1]);
      await exports.close();
    }
    {
      const { exports, seen, renderer } = await service({ threads: 2, frames: 40 });
      renderer.delayMs = 20;
      const q = await exports.start('p1', params());
      await until(
        () => exports.status(q.id),
        (j) => j.progress.frames_done >= 2,
      );
      await exports.cancel(q.id);
      const job = await until(() => exports.status(q.id), settled);
      expect(job.status).toBe('cancelled');
      expect([...seen.released.values()]).toEqual([1, 1]);
      await exports.close();
    }
    {
      // the first thread's process dies on frame 3: it is replaced; only live ones release
      const { exports, seen, renderer } = await service({ threads: 2 });
      let killed = -1;
      renderer.kill = (req, thread) => {
        if (killed < 0 && req.type === 'image' && req.options.frame === 3) {
          killed = thread;
          return true;
        }
        return false;
      };
      const q = await exports.start('p1', params());
      const job = await until(() => exports.status(q.id, { waitS: 5 }), settled);
      expect(job.status).toBe('done');
      expect(killed).toBeGreaterThan(0);
      expect(seen.released.has(killed)).toBe(false);
      expect(seen.released.size).toBeGreaterThanOrEqual(2);
      expect([...seen.released.values()].every((n) => n === 1)).toBe(true);
      await exports.close();
    }
  });
});
