import type { ExportQuality, ExportRenderEstimate } from '@3d-editor/core';
import {
  DEFAULT_DEVICE_GB,
  MAX_RENDER_BUDGET,
  WORKER_BASE_BYTES,
  refusalFigures,
  usableHeap,
  type TabMemory,
} from '../render/memory';
import { videoBitrate } from './codec';
import { i420Size } from './yuv';

/*
 * Memory of a browser export, decided before its frames are rendered (the tab's model:
 * render/memory.ts). The page and its render workers share one renderer process, and running out of
 * memory ends the whole tab, so the export starts as many render workers as the tab's memory holds
 * next to what the tab already holds (the path traced renders and other exports running in it:
 * TabMemory.held), at most one per core, MAX_EXPORT_WORKERS and as many as can render at once (the
 * frames rendered ahead are capped at MAX_BYTES_AHEAD: framesInFlight), and refuses at once, with the
 * figures, when not even one fits:
 * - each render worker: its base, the snapshot's scene evaluated in its JavaScript heap, the
 *   renderer's working buffers at the export's size and passes, the frame in flight (core
 *   `exportRenderEstimate`, as the server's render processes are estimated) and some slack; the
 *   first worker also the rigid body simulation it runs for all of them, every frame of which it
 *   keeps to the export's end (core `documentSimulationBytes`);
 * - the page: one video encoder per stream, the frames rendered ahead of encoding, a segment's rigid
 *   body matrices, and the videos it keeps in memory as many times as they are held at once: each
 *   shot's clips until they are finished, and when one is finished, its copies (FINISH_COPIES) and,
 *   where the browser cannot write files (no Origin Private File System), the store's own copy;
 *   without a disk every file of the export, a sequence being finished with its copies.
 * The JavaScript heaps (the page's and every worker's scene) must also fit the share of the tab's
 * heap limit a render may fill.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * What a render worker holds besides its base, the scene, the buffers and the frame in flight:
 * result arrays not collected yet, the snapshot document, evaluation caches, the shot measurements'
 * small renders. The server's render processes, which run the same code, grew by 132 MB of these
 * besides their buffers exporting the desk bench scene at 1280×720 (RENDER_PROCESS_SLACK_BYTES).
 */
export const WORKER_SLACK_BYTES = 128 * MB;

/**
 * A WebCodecs video encoder of the page (an estimate, not a measurement): a fixed part, and per
 * pixel its reference and lookahead frames and the frames queued in it (MAX_ENCODE_QUEUE).
 */
export const ENCODER_BYTES = { base: 16 * MB, perPixel: 24 } as const;

/** Bytes of frames rendered ahead of encoding at most (renderInOrder's cap; one frame always runs). */
export const MAX_BYTES_AHEAD = 128 * MB;

/**
 * Frames that can be rendering or waiting to be written at once, `itemBytes` each (renderInOrder
 * starts another only while they all fit MAX_BYTES_AHEAD; one always runs): an export starts no
 * more render workers than this, since the others would never render at the same time.
 */
export function framesInFlight(itemBytes: number, maxBytes = MAX_BYTES_AHEAD): number {
  return Math.max(1, Math.floor(maxBytes / Math.max(1, itemBytes)));
}

/**
 * Copies of a video the page holds at once while it finishes it in memory (mediabunny's
 * BufferTarget): an MP4 (fast start "in-memory" keeps its samples until the end) its samples, the
 * file written from them and that file trimmed to its length; a WebM (written as it goes) the file
 * written and its trimmed copy. Where the files stay in memory, the store adds its own (a Blob).
 */
export const FINISH_COPIES = { mp4: 3, webm: 2 } as const;

/** Bytes per pixel of a PNG frame of a mask or edges pass at most (palette indices, mostly flat). */
export const LOSSLESS_PNG_BYTES_PER_PIXEL = 0.5;

/** VP9 in quantizer mode has no bit rate: its files are counted at this multiple of H.264's. */
const VP9_SIZE_FACTOR = 1.5;

/** What one render worker of an export holds (bytes): in all, and in its JavaScript heap. */
export function workerNeeds(e: ExportRenderEstimate): { total: number; heap: number } {
  return {
    total: WORKER_BASE_BYTES + e.scene + e.buffers + e.frame + WORKER_SLACK_BYTES,
    heap: WORKER_BASE_BYTES + e.scene,
  };
}

/** Bytes of one frame as a render worker hands it to the page: I420 per video stream, PNG per lossless pass. */
export function frameReplyBytes(
  width: number,
  height: number,
  videoStreams: number,
  lossless: number,
): number {
  return (
    videoStreams * i420Size(width, height) +
    Math.ceil(lossless * width * height * LOSSLESS_PNG_BYTES_PER_PIXEL) +
    64 * 1024
  );
}

export interface PageNeedsInput {
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  codec: 'h264' | 'vp9';
  /** Video streams encoded (0 when neither the sequence nor clips are written). */
  videoStreams: number;
  /** Lossless passes written as PNG frames (mask, edges). */
  lossless: number;
  /** Output frames of the export, and of its longest shot. */
  frames: number;
  longestShot: number;
  shots: number;
  outputs: { sequence: boolean; clips: boolean; posters: boolean; stills: boolean };
  /** Whether the files go to disk (else every file stays in memory). */
  onDisk: boolean;
  /** Render workers (frames rendered ahead: twice as many). */
  workers: number;
  /** Bytes of the rigid body matrices of one segment the page hands the workers (0 without a simulation). */
  physics?: number;
}

/** The memory of the page during an export (bytes; outside its JavaScript heap). */
export function pageNeeds(o: PageNeedsInput): number {
  const pixels = o.width * o.height;
  const bitrate =
    videoBitrate(o.quality, o.width, o.height, o.fps) * (o.codec === 'vp9' ? VP9_SIZE_FACTOR : 1);
  const bytesPerFrame = bitrate / 8 / o.fps;
  const encoders = o.videoStreams * (ENCODER_BYTES.base + ENCODER_BYTES.perPixel * pixels);
  const item = frameReplyBytes(o.width, o.height, o.videoStreams, o.lossless);
  // frames ahead of encoding: two per worker within the cap, and always the one rendering
  const ahead = Math.max(item, Math.min(MAX_BYTES_AHEAD, 2 * Math.max(1, o.workers) * item));
  const copies = o.codec === 'vp9' ? FINISH_COPIES.webm : FINISH_COPIES.mp4;
  const kept = o.onDisk ? 0 : 1;
  const clip = bytesPerFrame * o.longestShot;
  const sequence = bytesPerFrame * o.frames;
  // each stream's clip until its shot is finished, every stream finishing its clip at once
  let videos = o.outputs.clips ? o.videoStreams * clip * (copies + kept) : 0;
  let files = 0;
  if (!o.onDisk) {
    // every file stays: the finished clips (every frame of each stream), the sequences while they
    // are written, and the one being finished (one stream after the other) with its copies
    if (o.outputs.clips) videos += o.videoStreams * sequence;
    if (o.outputs.sequence) videos += o.videoStreams * sequence + copies * sequence;
    // the frame archives, the one being finished twice (its chunks and its Blob), the posters, the stills
    const archive = o.frames * pixels * LOSSLESS_PNG_BYTES_PER_PIXEL;
    files =
      (o.lossless + (o.lossless ? 1 : 0)) * archive +
      o.shots * pixels * ((o.outputs.posters ? 4 : 0) + (o.outputs.stills ? 3 : 0));
  }
  return Math.ceil(encoders + ahead + (o.physics ?? 0) + videos + files);
}

/** How many render workers an export uses, or why it cannot start. */
export interface ExportWorkerPlan {
  /** Render workers (0 when the export cannot start). */
  workers: number;
  /** True when memory allows fewer workers than the device's cores. */
  limited: boolean;
  /** Why the export cannot start (workers 0); null otherwise. */
  refusal: string | null;
}

const gb = (b: number) => (b / GB).toFixed(1);

/**
 * The render workers an export of these needs may use, at most `maxWorkers`: the most that fit the
 * tab's memory budget and its heap, or a refusal when not even one does.
 */
export function planExportWorkers(o: {
  worker: { total: number; heap: number };
  /** What the first worker holds besides (the rigid body simulation it runs for every worker). */
  first?: { total: number; heap: number };
  page: number;
  maxWorkers: number;
  memory: TabMemory;
  /** Whether the files go to disk (the refusal says what to lower). */
  onDisk: boolean;
}): ExportWorkerPlan {
  const { memory: mem } = o;
  const first = o.first ?? { total: 0, heap: 0 };
  const max = Math.max(1, Math.floor(o.maxWorkers));
  const heapRoom = usableHeap(mem.heapLimit) - mem.heapUsed - mem.held.heap;
  const fits = (n: number) =>
    o.page + n * o.worker.total + first.total + mem.held.total <= mem.budget &&
    n * o.worker.heap + first.heap <= heapRoom;
  let workers = 0;
  while (workers < max && fits(workers + 1)) workers++;
  if (workers > 0) return { workers, limited: workers < max, refusal: null };
  const need = o.page + o.worker.total + first.total;
  let reason: string;
  if (need + mem.held.total > mem.budget) {
    const f = refusalFigures(need, mem.budget, mem.held.total, 1);
    const device = mem.deviceGB
      ? `the device memory the browser reports, ${mem.deviceGB} GB`
      : `the device memory, taken as ${DEFAULT_DEVICE_GB} GB where the browser does not report it`;
    reason =
      `it needs about ${f.need} GB of memory with one render worker` +
      (first.total >= 64 * MB ? ` (${gb(first.total)} GB of it the rigid body simulation's frames)` : '') +
      `, more than the ${f.room ?? f.total} GB a render may use in this tab (half ${device}, at most ${gb(MAX_RENDER_BUDGET)} GB` +
      (mem.held.total > 0 ? `, less ${f.used} GB the other renders and exports running in it hold)` : ')');
  } else {
    const f = refusalFigures(
      o.worker.heap + first.heap,
      usableHeap(mem.heapLimit),
      mem.heapUsed + mem.held.heap,
      2,
    );
    reason =
      `its render worker needs about ${f.need} GB of JavaScript heap for the scene, ` +
      (f.room === null
        ? 'and the tab has none left for it'
        : `more than the ${f.room} GB the tab has left for it`) +
      ` (a render may fill ${f.total} GB of its heap, and the page` +
      (mem.held.heap > 0 ? ' and the other renders and exports running in it are' : ' is') +
      ` estimated to use ${f.used} GB)`;
  }
  // what the other renders and exports of the tab hold is free again once they end
  const wait =
    mem.held.total > 0 || mem.held.heap > 0
      ? 'wait for the other renders and exports running in this tab to end, or '
      : '';
  const advice = o.onDisk
    ? `${wait}lower the resolution or the passes, or the triangles of the scene`
    : `${wait}export fewer frames, or lower the resolution or the passes`;
  const lower = o.onDisk
    ? advice[0].toUpperCase() + advice.slice(1)
    : `This browser cannot write the files to disk, so they are kept in memory: ${advice}`;
  return {
    workers: 0,
    limited: true,
    refusal: `The export was not started: ${reason}, and running out of memory would end the tab. ${lower}, or export on the server where one is available.`,
  };
}

/** The warning of an export the tab's memory holds fewer render workers for than the device has cores. */
export function fewerWorkersWarning(workers: number, cores: number): string {
  return `This tab's memory holds ${workers} of the ${cores} render workers this device could use: the export renders on ${workers}, more slowly`;
}
