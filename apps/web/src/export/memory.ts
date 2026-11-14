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
 * (at most one per core and MAX_EXPORT_WORKERS) and refuses at once, with the figures, when not even
 * one fits:
 * - each render worker: its base, the snapshot's scene evaluated in its JavaScript heap, the
 *   renderer's working buffers at the export's size and passes, the frame in flight (core
 *   `exportRenderEstimate`, as the server's render processes are estimated) and some slack;
 * - the page: one video encoder per stream, the frames rendered ahead of encoding, and the outputs
 *   it keeps in memory: each shot's clips until they are finished, and, where the browser cannot
 *   write files (no Origin Private File System), every file of the export.
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
}

/** The memory of the page during an export (bytes; outside its JavaScript heap). */
export function pageNeeds(o: PageNeedsInput): number {
  const pixels = o.width * o.height;
  const bitrate =
    videoBitrate(o.quality, o.width, o.height, o.fps) * (o.codec === 'vp9' ? VP9_SIZE_FACTOR : 1);
  const bytesPerFrame = bitrate / 8 / o.fps;
  const encoders = o.videoStreams * (ENCODER_BYTES.base + ENCODER_BYTES.perPixel * pixels);
  const ahead = Math.min(
    MAX_BYTES_AHEAD,
    2 * Math.max(1, o.workers) * frameReplyBytes(o.width, o.height, o.videoStreams, o.lossless),
  );
  // clips are kept in memory until their shot is finished; on disk they are written then
  let videos = o.outputs.clips ? o.videoStreams * bytesPerFrame * o.longestShot : 0;
  let files = 0;
  if (!o.onDisk) {
    videos =
      o.videoStreams * bytesPerFrame * o.frames * ((o.outputs.sequence ? 1 : 0) + (o.outputs.clips ? 1 : 0));
    files =
      o.lossless * o.frames * pixels * LOSSLESS_PNG_BYTES_PER_PIXEL +
      o.shots * pixels * ((o.outputs.posters ? 4 : 0) + (o.outputs.stills ? 3 : 0));
  }
  return Math.ceil(encoders + ahead + videos + files);
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
  page: number;
  maxWorkers: number;
  memory: TabMemory;
  /** Whether the files go to disk (the refusal says what to lower). */
  onDisk: boolean;
}): ExportWorkerPlan {
  const { memory: mem } = o;
  const max = Math.max(1, Math.floor(o.maxWorkers));
  const heapRoom = usableHeap(mem.heapLimit) - mem.heapUsed - mem.held.heap;
  const fits = (n: number) =>
    o.page + n * o.worker.total + mem.held.total <= mem.budget && n * o.worker.heap <= heapRoom;
  let workers = 0;
  while (workers < max && fits(workers + 1)) workers++;
  if (workers > 0) return { workers, limited: workers < max, refusal: null };
  const need = o.page + o.worker.total;
  let reason: string;
  if (need + mem.held.total > mem.budget) {
    const f = refusalFigures(need, mem.budget, mem.held.total, 1);
    const device = mem.deviceGB
      ? `the device memory the browser reports, ${mem.deviceGB} GB`
      : `the device memory, taken as ${DEFAULT_DEVICE_GB} GB where the browser does not report it`;
    reason =
      `it needs about ${f.need} GB of memory with one render worker, more than the ` +
      `${f.room ?? f.total} GB a render may use in this tab (half ${device}, at most ${gb(MAX_RENDER_BUDGET)} GB` +
      (mem.held.total > 0 ? `, less ${f.used} GB other renders running in it hold)` : ')');
  } else {
    const f = refusalFigures(o.worker.heap, usableHeap(mem.heapLimit), mem.heapUsed + mem.held.heap, 2);
    reason =
      `its render worker needs about ${f.need} GB of JavaScript heap for the scene, ` +
      (f.room === null
        ? 'and the tab has none left for it'
        : `more than the ${f.room} GB the tab has left for it`) +
      ` (a render may fill ${f.total} GB of its heap, and the page is estimated to use ${f.used} GB)`;
  }
  const lower = o.onDisk
    ? 'Lower the resolution or the passes, or the triangles of the scene'
    : 'This browser cannot write the files to disk, so they are kept in memory: export fewer frames, or lower the resolution or the passes';
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
