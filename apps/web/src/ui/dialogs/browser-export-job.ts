import { signal } from '@preact/signals';
import * as Y from 'yjs';
import { getShots } from '@3d-editor/core';
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
 * The video export this tab runs on this device (the Export Video window starts it): one at a time
 * in the tab, whichever project it exports. A start is decided before anything is awaited, so a
 * second press of Export, or another project's window, finds the first export running and starts
 * none. The window follows the export while it is open (any project's window shows it while it
 * runs, with its progress and Cancel), and the export goes on when the window is closed. Its files
 * are kept until the next export starts in this tab (or the page closes) and are offered as object
 * URLs of their Blobs (files the export kept on disk are read from there when downloaded).
 */

export type BrowserJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BrowserJob {
  /** The job's number in this page (a window follows the job it showed). */
  id: number;
  /** The project it exports. */
  project: string;
  /** The project's name when the export started (another project's window names it). */
  projectName: string;
  /** The names of the project's shots when the export started, by id. */
  shotNames: Record<string, string>;
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
let nextJob = 1;

/** Lets a finished export's files and URLs go. */
async function releaseJob(job: BrowserJob | null): Promise<void> {
  if (!job) return;
  for (const url of Object.values(job.urls)) URL.revokeObjectURL(url);
  if (job.result) await releaseBrowserExport(job.result).catch(() => undefined);
}

/** Object URLs of a result's files. */
async function fileUrls(files: readonly BrowserExportFile[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (const f of files) out[f.name] = URL.createObjectURL(await f.blob());
  } catch (err) {
    for (const url of Object.values(out)) URL.revokeObjectURL(url);
    throw err;
  }
  return out;
}

/** Why an export cannot start on this device now (null when it can): one runs in this tab. */
export function browserJobBlocked(): string | null {
  const j = browserJob.value;
  return j?.status === 'running'
    ? `An export of ${j.projectName} is running on this device: wait for it, or cancel it first.`
    : null;
}

/**
 * Exports the project on this device with these parameters. The export is registered before
 * anything is awaited (its snapshot is the project as it is now, when Export is pressed), so a
 * second start while it runs is refused; the previous export's files are released next.
 */
export async function startBrowserJob(
  session: ProjectSession,
  params: VideoExportParams,
  label: string | null,
): Promise<void> {
  const blocked = browserJobBlocked();
  if (blocked) throw new Error(blocked);
  const previous = browserJob.value;
  const ctrl = new AbortController();
  controller = ctrl;
  const update0 = Y.encodeStateAsUpdate(session.doc.ydoc);
  const startedAt = Date.now();
  const id = nextJob++;
  let renderStart = 0;
  browserJob.value = {
    id,
    project: session.id,
    projectName: session.title.value,
    shotNames: Object.fromEntries(getShots(session.doc).map((s) => [s.id, s.name])),
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
  /** Changes this job (the job shown is this one until the next starts, which this one blocks). */
  const update = (patch: Partial<BrowserJob>) => {
    const j = browserJob.value;
    if (j?.id === id) browserJob.value = { ...j, ...patch };
  };
  try {
    await releaseJob(previous);
    if (ctrl.signal.aborted) throw new BrowserExportError('The export was cancelled', 'CANCELLED');
    const result = await startBrowserExport(
      { update: update0, params, stills: false, project: { id: session.id, name: session.title.value } },
      {
        signal: ctrl.signal,
        onProgress: (p) => {
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
    let urls: Record<string, string>;
    try {
      urls = await fileUrls(result.files);
    } catch (err) {
      await releaseBrowserExport(result).catch(() => undefined);
      throw err;
    }
    update({ status: 'done', result, urls, finishedAt: Date.now() });
  } catch (err) {
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
  const job = browserJob.value;
  if (job?.status === 'running') return;
  browserJob.value = null;
  await releaseJob(job);
}
