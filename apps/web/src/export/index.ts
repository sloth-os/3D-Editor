import { runBrowserExport, type EngineOptions } from './engine';
import type { ExportStore } from './store';
import type {
  BrowserExportFile,
  BrowserExportHooks,
  BrowserExportRequest,
  BrowserExportResult,
} from './types';
import { crc32Update, zipBlob } from './zip';

/*
 * The browser video export: the director's desk export (core's plan, frames, passes and manifest,
 * as the server's ffmpeg export makes them) rendered in Web Workers and encoded with WebCodecs on
 * this device, without the editor server. docs/video-export.md says what it writes and how it
 * differs from the server's export.
 */

export { browserExportSupport, BrowserExportError, type BrowserExportErrorCode } from './support';
export type {
  BrowserExportFile,
  BrowserExportFileKind,
  BrowserExportHooks,
  BrowserExportProgress,
  BrowserExportRequest,
  BrowserExportResult,
} from './types';

/** The stores of the results this page holds (released with releaseBrowserExport). */
const live = new Map<string, ExportStore>();
/** The CRC-32 of each file of a result (computed while it was written; the zip needs it). */
const crcs = new WeakMap<BrowserExportFile, number>();

/** Engine options of the exports this page starts (tests and the debug hook replace them). */
let engineOptions: EngineOptions = {};

/** How the last export of this page ran (debugging and measurements). */
export interface BrowserExportStats {
  id: string;
  /** Render workers it used. */
  workers: number;
  /** Frames written per second while its frames were rendered and encoded. */
  renderFps: number;
  /** Seconds from start to finish. */
  seconds: number;
}

let lastStats: BrowserExportStats | null = null;

/** How the last export of this page ran (null before the first one finished). */
export function lastBrowserExportStats(): BrowserExportStats | null {
  return lastStats;
}

/** Replaces the engine options of the next exports (unit tests, debugging); returns the previous ones. */
export function setBrowserExportOptions(opts: EngineOptions): EngineOptions {
  const prev = engineOptions;
  engineOptions = opts;
  return prev;
}

/**
 * Exports video on this device: the snapshot `req.update` rendered by render workers, encoded with
 * WebCodecs, and written as files (the Origin Private File System where the browser has it, else
 * memory). Rejects with a BrowserExportError (its `code` says why) after deleting what it wrote.
 * The files stay until `releaseBrowserExport` (or until the page closes and a later export cleans
 * up).
 */
export async function startBrowserExport(
  req: BrowserExportRequest,
  hooks: BrowserExportHooks = {},
): Promise<BrowserExportResult> {
  const r = await runBrowserExport(req, hooks, engineOptions);
  live.set(r.id, r.store);
  lastStats = { id: r.id, ...r.stats };
  const files = r.files.map((f): BrowserExportFile => {
    const file: BrowserExportFile = {
      name: f.name,
      kind: f.kind,
      pass: f.pass,
      shot: f.shot,
      mime: f.mime,
      size: f.size,
      sha256: f.sha256,
      frames: f.frames,
      duration_s: f.duration_s,
      blob: f.blob,
    };
    crcs.set(file, f.crc32);
    return file;
  });
  return { id: r.id, files, manifest: r.manifest, shots: r.shots, warnings: r.warnings };
}

/** The CRC-32 of a Blob, read in chunks. */
async function blobCrc32(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32Update(crc, value);
  }
}

/**
 * Every file of an export as one ZIP archive (stored, not compressed: the videos and PNGs are
 * compressed already), made of the files' Blobs without copying them.
 */
export async function zipExport(result: BrowserExportResult): Promise<Blob> {
  const entries = [];
  for (const f of result.files) {
    const blob = await f.blob();
    entries.push({ name: f.name, blob, size: blob.size, crc32: crcs.get(f) ?? (await blobCrc32(blob)) });
  }
  return zipBlob(entries);
}

/** Deletes the files of an export this page made (its downloads stop working). */
export async function releaseBrowserExport(result: BrowserExportResult | string): Promise<void> {
  const id = typeof result === 'string' ? result : result.id;
  const store = live.get(id);
  live.delete(id);
  await store?.dispose();
}
