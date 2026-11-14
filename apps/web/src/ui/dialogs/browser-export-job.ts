import { signal } from '@preact/signals';
import * as Y from 'yjs';
import {
  BrowserExportError,
  releaseBrowserExport,
  startBrowserExport,
  type BrowserExportFile,
  type BrowserExportProgress,
  type BrowserExportResult,
} from '../../export';
import type { VideoExportParams } from '../../io/store-client';
import type { ProjectSession } from '../../project/session';

/*
 * The video export this page runs on this device (the Export Video window starts it): one at a time,
 * followed by the window while it is open and going on when it is closed, its files kept until the
 * next export starts (or the page closes). Its files are offered as object URLs of their Blobs
 * (files the export kept on disk are read from there when downloaded).
 */

export type BrowserJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BrowserJob {
  /** The project it exports. */
  project: string;
  label: string | null;
  status: BrowserJobStatus;
  progress: BrowserExportProgress | null;
  /** Frames rendered per second so far (0 before the first). */
  fps: number;
  startedAt: number;
  finishedAt: number | null;
  result: BrowserExportResult | null;
  /** Object URLs of the result's files by name (made once it is done). */
  urls: Record<string, string>;
  error: string | null;
}

export const browserJob = signal<BrowserJob | null>(null);

let controller: AbortController | null = null;

/** Lets the previous export's files and URLs go (a new export starts, or the page wants them gone). */
async function releasePrevious(): Promise<void> {
  const prev = browserJob.value;
  if (!prev) return;
  for (const url of Object.values(prev.urls)) URL.revokeObjectURL(url);
  if (prev.result) await releaseBrowserExport(prev.result).catch(() => undefined);
}

const update = (patch: Partial<BrowserJob>) => {
  const j = browserJob.value;
  if (j) browserJob.value = { ...j, ...patch };
};

/** Object URLs of a result's files. */
async function fileUrls(files: readonly BrowserExportFile[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.name] = URL.createObjectURL(await f.blob());
  return out;
}

/**
 * Exports the project on this device with these parameters (its state now is the snapshot); the
 * previous export's files are released first.
 */
export async function startBrowserJob(
  session: ProjectSession,
  params: VideoExportParams,
  label: string | null,
): Promise<void> {
  if (browserJob.value?.status === 'running')
    throw new Error('An export is running on this device: cancel it first.');
  await releasePrevious();
  const ctrl = new AbortController();
  controller = ctrl;
  const update0 = Y.encodeStateAsUpdate(session.doc.ydoc);
  const startedAt = Date.now();
  let renderStart = 0;
  browserJob.value = {
    project: session.id,
    label,
    status: 'running',
    progress: null,
    fps: 0,
    startedAt,
    finishedAt: null,
    result: null,
    urls: {},
    error: null,
  };
  try {
    const result = await startBrowserExport(
      { update: update0, params, stills: false, project: { id: session.id, name: session.title.value } },
      {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (controller !== ctrl) return;
          let fps = browserJob.value?.fps ?? 0;
          if (p.phase === 'render') {
            const now = performance.now();
            if (!renderStart) renderStart = now;
            const s = (now - renderStart) / 1000;
            if (s > 0.5) fps = p.done / s;
          }
          update({ progress: p, fps });
        },
      },
    );
    if (controller !== ctrl) {
      await releaseBrowserExport(result);
      return;
    }
    update({ status: 'done', result, urls: await fileUrls(result.files), finishedAt: Date.now() });
  } catch (err) {
    if (controller !== ctrl) return;
    const cancelledNow = err instanceof BrowserExportError && err.code === 'CANCELLED';
    update({
      status: cancelledNow ? 'cancelled' : 'failed',
      error: cancelledNow ? null : err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    });
  } finally {
    if (controller === ctrl) controller = null;
  }
}

/** Cancels the export running on this device (its partial files are deleted). */
export function cancelBrowserJob(): void {
  controller?.abort();
}

/** Forgets the finished export shown (its files are released). */
export async function clearBrowserJob(): Promise<void> {
  if (browserJob.value?.status === 'running') return;
  await releasePrevious();
  browserJob.value = null;
}
