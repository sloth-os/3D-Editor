import { readFileSync } from 'node:fs';
import os from 'node:os';
import { estimateRenderBufferBytes, type SceneDoc, type ScreenLine } from '@3d-editor/core';
import { deskAovs } from '../render/desk';
import { estimateRenderMemory } from '../render/memory';
import type { PassName } from '../render/protocol';
import { x264Threads } from './ffmpeg';
import type { QualityPreset, VideoExportParams } from './params';
import { resultBytes, type StreamSpec } from './passes';

/*
 * Memory of a video export (SPEC §9). Before its first frame, an export estimates what one of its
 * render processes will hold (the snapshot's evaluated scene, the renderer's working buffers at the
 * export's size, samples and passes, the frame in flight), what its ffmpeg encoders and the server
 * will take, and compares that with the memory the machine has available (MemAvailable, or the
 * cgroup's limit less its working set when that is less: a container). It then renders on as many
 * render processes as fit, at least one and at most RENDER_WORKERS; when not even one fits, it
 * fails at once with code OUT_OF_MEMORY instead of being ended by the system's out-of-memory killer
 * part way through. The decision is made once, when the export starts (and checked when it is
 * asked for: `VideoExports.start`).
 *
 * Render processes that already run hold memory the machine's reading no longer counts as
 * available: their base, and what earlier renders left them (heap the allocator keeps, released
 * buffers V8 has not given back). An export reuses that memory instead of taking it anew, so each
 * running process it leases needs only what it does not hold yet (`reusableBytes`); counting the
 * whole estimate again for it refused the second of two identical exports. The pool starts only
 * the processes an export leases (render/pool.ts), so each one it starts takes its base
 * (RENDER_PROCESS_BASE_BYTES) on top of the estimate, and processes it does not lease take nothing.
 */

const MiB = 1024 * 1024;

/** Resident memory of a render process before it renders anything: 109 MiB measured (production bundle), rounded up. */
export const RENDER_PROCESS_BASE_BYTES = 128 * MiB;

/** What the server's own process may grow by during an export besides the frames it holds (requests, rooms). */
export const SERVER_GROWTH_BYTES = 256 * MiB;

/**
 * What a render process holds besides the scene, the renderer's buffers and the frame in flight:
 * result arrays of earlier frames not collected yet (V8 lets about 64 MB of them pile up before it
 * collects), the snapshot document, evaluation caches, the shot measurements' small renders and
 * the allocator's free memory. Exporting the desk bench scene at 1280×720 (beauty, depth, pose), a
 * render process grew by up to 268 MB over its base: 136 MB of buffers (as
 * `estimateRenderBufferBytes` says) and 132 MB of the rest.
 */
export const RENDER_PROCESS_SLACK_BYTES = 128 * MiB;

/**
 * Peak resident memory of one ffmpeg encoder of an export (encoderArgs), a fixed part and a part
 * per pixel of the video: measured from 1280×720 to 3840×2160 with 6 encoder threads (libx264's
 * default on 4 cores), rounded up by about 15 %.
 */
const ENCODER_BYTES: Record<
  'h264' | 'vp9' | 'lossless',
  Record<VideoExportParams['quality'], [number, number]>
> = {
  // libx264 (preset veryfast / medium / slow): mostly its lookahead
  h264: { draft: [64 * MiB, 150], standard: [80 * MiB, 270], high: [112 * MiB, 290] },
  // libvpx-vp9 (row-mt; measured at standard, taken for the other speeds too)
  vp9: { draft: [112 * MiB, 160], standard: [112 * MiB, 160], high: [112 * MiB, 160] },
  // libx264rgb, preset veryfast, qp 0 (data passes), whatever the quality
  lossless: { draft: [64 * MiB, 240], standard: [64 * MiB, 240], high: [64 * MiB, 240] },
};

/**
 * libx264 encoder threads the measurements above ran with; each further one holds about 11 bytes
 * per pixel more (peak RSS at 1280×720 with 6, 12 and 22 threads: 257, 319 and 420 MB).
 */
const MEASURED_X264_THREADS = 6;
const X264_BYTES_PER_PIXEL_PER_THREAD = 12;

/** The poster ffmpeg (one frame to PNG and JPEG): 66 MiB at 1280×720, 88 MiB at 1920×1080, 204 MiB at 3840×2160 measured. */
const POSTER_BYTES: [number, number] = [56 * MiB, 20];

/** Memory available to the export and where it was read. */
export interface MachineMemory {
  /** Bytes the machine can give new allocations without swapping. */
  available: number;
  /**
   * meminfo: /proc/meminfo MemAvailable; cgroup: the memory limit of the server's control group
   * less its working set (usage less inactive file cache), when that is less (a container);
   * freemem: os.freemem() (no /proc/meminfo).
   */
  source: 'meminfo' | 'cgroup' | 'freemem';
}

/** Reads the memory available to an export (injectable for tests). */
export type MemoryReader = () => MachineMemory;

/** What `readMachineMemory` reads (injectable for tests). */
export interface MemoryReadDeps {
  /** A file's text, null when it cannot be read. */
  readFile(path: string): string | null;
  freemem(): number;
}

const systemDeps: MemoryReadDeps = {
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  freemem: () => os.freemem(),
};

/** MemAvailable of /proc/meminfo text in bytes (null when missing). */
export function parseMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

/** Limits from this value on mean "no limit" (cgroup v1 reports about 2^63 then). */
const NO_CGROUP_LIMIT = 2 ** 60;

/** The value of `key` in a memory.stat text (null when missing). */
function statField(stat: string, key: string): number | null {
  const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(stat);
  return m ? Number(m[1]) : null;
}

/**
 * The memory the server's control group can still take (bytes): its limit less its working set
 * (usage less the inactive file cache, which the kernel reclaims first), or null without a limit.
 * cgroup v2 (`0::/path`: memory.max, memory.current) and v1 (`N:memory:/path`:
 * memory.limit_in_bytes, memory.usage_in_bytes); a path missing from the mounted hierarchy (a
 * container without its own cgroup namespace) falls back to the hierarchy's root.
 */
export function cgroupHeadroom(read: MemoryReadDeps['readFile']): number | null {
  const self = read('/proc/self/cgroup');
  if (!self) return null;
  const dirs: { dir: string; v2: boolean }[] = [];
  for (const line of self.split('\n')) {
    const m = /^\d+:([^:]*):(\/.*)$/.exec(line.trim());
    if (!m) continue;
    const rel = m[2] === '/' ? '' : m[2];
    if (m[1] === '')
      dirs.push({ dir: `/sys/fs/cgroup${rel}`, v2: true }, { dir: '/sys/fs/cgroup', v2: true });
    else if (m[1].split(',').includes('memory'))
      dirs.push(
        { dir: `/sys/fs/cgroup/memory${rel}`, v2: false },
        { dir: '/sys/fs/cgroup/memory', v2: false },
      );
  }
  for (const { dir, v2 } of dirs) {
    const limitText = read(`${dir}/${v2 ? 'memory.max' : 'memory.limit_in_bytes'}`);
    if (limitText === null) continue;
    const limit = Number(limitText.trim());
    // 'max' (v2) or a huge number (v1): no limit here
    if (!(limit > 0 && limit < NO_CGROUP_LIMIT)) return null;
    const usage = Number(read(`${dir}/${v2 ? 'memory.current' : 'memory.usage_in_bytes'}`)?.trim());
    if (!Number.isFinite(usage) || usage < 0) return null;
    const stat = read(`${dir}/memory.stat`) ?? '';
    const inactive =
      (v2 ? null : statField(stat, 'total_inactive_file')) ?? statField(stat, 'inactive_file') ?? 0;
    return Math.max(0, limit - Math.max(0, usage - inactive));
  }
  return null;
}

/**
 * The memory available to an export: MemAvailable of /proc/meminfo (else os.freemem()), or the
 * server's control group's headroom when that is less (see `cgroupHeadroom`).
 */
export function readMachineMemory(deps: MemoryReadDeps = systemDeps): MachineMemory {
  const info = deps.readFile('/proc/meminfo');
  const fromInfo = info === null ? null : parseMemAvailable(info);
  const machine: MachineMemory =
    fromInfo === null
      ? { available: Math.max(0, deps.freemem()), source: 'freemem' }
      : { available: fromInfo, source: 'meminfo' };
  const headroom = cgroupHeadroom(deps.readFile);
  return headroom !== null && headroom < machine.available
    ? { available: headroom, source: 'cgroup' }
    : machine;
}

/** A string stand-in for `estimateRenderBufferBytes` (it reads only whether there are lines). */
const SOME_LINE: ScreenLine[] = [{ a: [0, 0, 0], b: [0, 0, 0], width_px: 2, color: [1, 1, 1] }];

/** The parts of the estimated memory of one render process of an export (bytes). */
export interface RenderProcessEstimate {
  /** The snapshot's scene in the JavaScript heap (render/memory.ts `estimateRenderMemory`). */
  scene: number;
  /** The renderer's working buffers and returned image (core `estimateRenderBufferBytes`). */
  buffers: number;
  /** The passes of the frame in flight, converted and copied for the server. */
  frame: number;
  /** All of it with RENDER_PROCESS_SLACK_BYTES (not counting the process's own RENDER_PROCESS_BASE_BYTES). */
  total: number;
}

/**
 * What one render process of an export takes on top of its base: the scene, the renderer's
 * working buffers (none when no pass needs rasterizing), the frame in flight and
 * RENDER_PROCESS_SLACK_BYTES. On the desk bench scene (two people, a dog, props; 17,700 triangles)
 * the render processes peaked at 385 and 432 MB exporting 1280×720 standard with beauty, depth and
 * pose, and at 571 and 577 MB at 1920×1080 with all six passes (development processes, 164 MiB
 * base): base + total says 447 and 675 MB there.
 */
export function renderProcessBytes(
  snapshot: SceneDoc,
  o: {
    width: number;
    height: number;
    passes: readonly PassName[];
    look: VideoExportParams['look'];
    preset: QualityPreset;
    strings: boolean;
    resultBytes: number;
  },
): RenderProcessEstimate {
  const set = new Set(o.passes);
  const beauty = set.has('beauty');
  const aovs = deskAovs(set, o.strings);
  // as renderDeskFrame: no rasterizing without the beauty image or a per-pixel pass
  const buffers =
    beauty || aovs.length
      ? estimateRenderBufferBytes(
          {
            width: o.width,
            height: o.height,
            samples: o.preset.samples,
            look: o.look,
            shadows: beauty && o.preset.shadows,
            ao: beauty && o.preset.ao,
            aovs,
            lines: beauty && o.strings ? SOME_LINE : undefined,
          },
          snapshot,
        )
      : 0;
  const scene = estimateRenderMemory(snapshot).bytes;
  const frame = 2 * o.resultBytes;
  return { scene, buffers, frame, total: scene + buffers + frame + RENDER_PROCESS_SLACK_BYTES };
}

/**
 * What the server's own process may grow by while an export renders: the rendered frames it holds
 * (at most 2 per render process ahead of the one being written, and MAX_BYTES_AHEAD) and
 * SERVER_GROWTH_BYTES for everything else.
 */
export function serverBytes(capacity: number, resultBytes: number, maxBytesAhead: number): number {
  return SERVER_GROWTH_BYTES + Math.min(maxBytesAhead, (2 * capacity + 2) * resultBytes);
}

/**
 * Peak memory of the ffmpeg processes of an export: an encoder per stream and a poster at a time.
 * `threads`: the x264 encoders' threads, which the export passes them (ffmpeg.ts `x264Threads`).
 */
export function ffmpegBytes(
  streams: readonly Pick<StreamSpec, 'codec'>[],
  quality: VideoExportParams['quality'],
  width: number,
  height: number,
  threads = x264Threads(height),
): number {
  const px = width * height;
  const extraThreads = Math.max(0, threads - MEASURED_X264_THREADS);
  let bytes = POSTER_BYTES[0] + POSTER_BYTES[1] * px;
  for (const s of streams) {
    const [fixed, perPixel] = ENCODER_BYTES[s.codec][quality];
    bytes += fixed + perPixel * px;
    if (s.codec !== 'vp9') bytes += extraThreads * X264_BYTES_PER_PIXEL_PER_THREAD * px;
  }
  return bytes;
}

/** What an export may render on (see `planRenderProcesses`). */
export interface RenderProcessPlan {
  /** Render processes to lease: 0 when not even one fits, else 1 … capacity. */
  processes: number;
  /** Memory kept for ffmpeg, the server and the other render processes to start (`otherStarting`). */
  reserved: number;
  /** What the leased running processes hold already and reuse (bytes, counted off what they need). */
  reused: number;
  /** Leased processes the pool starts for the export (each takes RENDER_PROCESS_BASE_BYTES first). */
  started: number;
}

/**
 * How many render processes fit: the available memory less what ffmpeg and the server take (and
 * the base of `otherStarting` processes the export may start besides, the interactive one), against
 * what each process the export leases adds, in the order the pool leases them (the running ones
 * first, the longest running first; the pool starts the others, and only those, for the lease). A
 * running process adds only what it does not hold yet: `reuse[i]`, what the i-th running one holds
 * of `processBytes` already; a process the pool starts takes its base (RENDER_PROCESS_BASE_BYTES)
 * and all of `processBytes`. Running processes the export does not lease keep what they hold.
 */
export function planRenderProcesses(o: {
  available: number;
  capacity: number;
  /** What each running process holds already of `processBytes`, in the order the pool leases them. */
  reuse?: readonly number[];
  /** Other render processes the export may start (each takes RENDER_PROCESS_BASE_BYTES). */
  otherStarting?: number;
  processBytes: number;
  ffmpegBytes: number;
  serverBytes: number;
}): RenderProcessPlan {
  const reserved =
    o.ffmpegBytes + o.serverBytes + Math.max(0, o.otherStarting ?? 0) * RENDER_PROCESS_BASE_BYTES;
  const free = o.available - reserved;
  const running = o.reuse?.length ?? 0;
  let need = 0;
  let reused = 0;
  let processes = 0;
  let started = 0;
  for (let i = 0; i < o.capacity; i++) {
    const runs = i < running;
    const r = runs ? o.reuse![i] : 0;
    const held = r > 0 ? Math.min(o.processBytes, r) : 0;
    const cost = o.processBytes - held + (runs ? 0 : RENDER_PROCESS_BASE_BYTES);
    if (need + cost > free) break;
    need += cost;
    reused += held;
    processes++;
    if (!runs) started++;
  }
  return { processes, reserved, reused, started };
}

/**
 * What a running render process with resident memory `rss` already holds of what one render process
 * of an export needs (`process`): its resident memory above its base, up to the estimate less the
 * export's scene. The scene is new to every process (each export renders its own snapshot of the
 * project); the rest, the renderer's buffers, the frame in flight and the allowance, comes out of
 * memory the process keeps from earlier renders (the allocator's heap, V8's pages) before it takes
 * more from the machine.
 */
export function reusableBytes(rss: number, process: RenderProcessEstimate): number {
  if (!Number.isFinite(rss)) return Math.max(0, process.total - process.scene);
  return Math.max(0, Math.min(process.total - process.scene, rss - RENDER_PROCESS_BASE_BYTES));
}

/** Bytes as whole megabytes (MiB) for messages and job status. */
export const toMB = (bytes: number): number => Math.round(bytes / MiB);

/** How an export renders (job status `render`; set when it starts rendering, or refuses to). */
export interface ExportRenderInfo {
  /** Render processes it renders on: RENDER_WORKERS, fewer when memory is short (0: not even one fitted). */
  processes: number;
  /** RENDER_WORKERS: the render processes of long renders. */
  render_workers: number;
  /** Estimated memory of each of its render processes (MB, the process's own base included). */
  process_mb: number;
  /** Estimated memory of its ffmpeg encoders (MB). */
  ffmpeg_mb: number;
  /** Memory available when it started (MB) and where that was read (see `MachineMemory`). */
  available_mb: number;
  memory_source: MachineMemory['source'];
}

/** What an export needs, whatever the machine has (see `exportMemory`). */
export interface ExportNeeds {
  /** RENDER_WORKERS (at least 1). */
  capacity: number;
  /** One render process (on top of its base). */
  process: RenderProcessEstimate;
  ffmpeg: number;
  server: number;
  /** The number of ffmpeg encoders. */
  encoders: number;
}

/** Estimates what an export needs: one render process, its ffmpeg encoders and the server. */
export function exportNeeds(o: {
  snapshot: SceneDoc;
  width: number;
  height: number;
  passes: readonly PassName[];
  look: VideoExportParams['look'];
  preset: QualityPreset;
  /** Whether the snapshot has strings (desk_role 'string'), drawn as lines. */
  strings: boolean;
  streams: readonly Pick<StreamSpec, 'codec'>[];
  quality: VideoExportParams['quality'];
  /** RENDER_WORKERS. */
  capacity: number;
  /** The most bytes of rendered frames the server holds (exporter MAX_BYTES_AHEAD). */
  maxBytesAhead: number;
}): ExportNeeds {
  const result = resultBytes(o.passes, o.width, o.height);
  const capacity = Math.max(1, o.capacity);
  return {
    capacity,
    process: renderProcessBytes(o.snapshot, { ...o, resultBytes: result }),
    ffmpeg: ffmpegBytes(o.streams, o.quality, o.width, o.height),
    server: serverBytes(capacity, result, o.maxBytesAhead),
    encoders: o.streams.length,
  };
}

/** The memory decision of an export (see the module comment). */
export interface ExportMemory extends ExportNeeds {
  /** Render processes to lease (0: not even one fits). */
  processes: number;
  /**
   * Base memory of the render processes the export starts: the ones it leases that do not run yet
   * (when not even one fits: of the first one it would lease), and the interactive one the contact
   * sheet may start.
   */
  starting: number;
  /** What each running render process holds already of `process`, in the order the pool leases them. */
  reuse: number[];
  machine: MachineMemory;
}

/**
 * Decides how many render processes an export renders on (see the module comment), with the
 * machine's memory now and the pool's state: the resident memory (RSS) of the running render
 * processes of long renders in the order the pool leases them (`warm`; Infinity: holds all it
 * needs but the scene; the processes after them are started for the export, each with its base),
 * and whether to keep an interactive render process's base for the contact sheet (`interactive`).
 */
export function exportMemory(
  needs: ExportNeeds,
  o: { warm?: readonly number[]; interactive?: boolean; machine: MachineMemory },
): ExportMemory {
  const reuse = (o.warm ?? []).slice(0, needs.capacity).map((rss) => reusableBytes(rss, needs.process));
  const interactive = o.interactive ? 1 : 0;
  const plan = planRenderProcesses({
    available: o.machine.available,
    capacity: needs.capacity,
    reuse,
    otherStarting: interactive,
    processBytes: needs.process.total,
    ffmpegBytes: needs.ffmpeg,
    serverBytes: needs.server,
  });
  // not even one: what the first process the export would lease needs (its base, when not running)
  const started = plan.processes > 0 ? plan.started : reuse.length ? 0 : 1;
  return {
    ...needs,
    processes: plan.processes,
    starting: (started + interactive) * RENDER_PROCESS_BASE_BYTES,
    reuse,
    machine: o.machine,
  };
}

/** The job status `render` of an export's memory decision. */
export function renderInfo(m: ExportMemory): ExportRenderInfo {
  return {
    processes: m.processes,
    render_workers: m.capacity,
    process_mb: toMB(m.process.total + RENDER_PROCESS_BASE_BYTES),
    ffmpeg_mb: toMB(m.ffmpeg),
    available_mb: toMB(m.machine.available),
    memory_source: m.machine.source,
  };
}

const ADVICE = "export a smaller size (width and height), fewer passes or quality 'draft'";

/**
 * The OUT_OF_MEMORY error of an export not even one render process fits for. It renders on one
 * render process at least, and the pool starts no other for it: fewer render processes
 * (RENDER_WORKERS) would not help, so the message does not suggest them.
 */
export function outOfMemoryMessage(m: ExportMemory, width: number, height: number): string {
  const held = m.reuse[0] ?? 0;
  const need = m.process.total - held + m.ffmpeg + m.server + m.starting;
  return (
    `Not enough memory for this video export: it needs about ${toMB(need)} MB (a render process ` +
    `${toMB(m.process.total)} MB at ${width}×${height}: render buffers ${toMB(m.process.buffers)} MB, ` +
    `scene ${toMB(m.process.scene)} MB${held > 0 ? `, ${toMB(held)} MB of it held by a running one already` : ''}; ` +
    `ffmpeg's ${m.encoders} ${m.encoders === 1 ? 'encoder' : 'encoders'} ` +
    `${toMB(m.ffmpeg)} MB; the server and starting render processes ${toMB(m.server + m.starting)} MB), ` +
    `and the machine has ${toMB(m.machine.available)} MB available: ${ADVICE}, or free memory ` +
    'on the server.'
  );
}

/** The warning of an export that renders on fewer render processes than RENDER_WORKERS. */
export function fewerProcessesWarning(m: ExportMemory): string {
  return (
    `memory: the ${toMB(m.machine.available)} MB available hold ${m.processes} of the ${m.capacity} ` +
    `render processes (RENDER_WORKERS) at about ${toMB(m.process.total + RENDER_PROCESS_BASE_BYTES)} MB ` +
    `each next to ffmpeg (${toMB(m.ffmpeg)} MB), so the export renders on ${m.processes} and takes ` +
    `longer; to render on all of them, ${ADVICE}`
  );
}
