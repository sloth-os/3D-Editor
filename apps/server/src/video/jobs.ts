import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Log } from '../observability/log';
import type { ExportJob, ExportStatus } from './index';

/*
 * The video export jobs on disk: `<EXPORT_DIR>/<project>/<job>/job.json` (written atomically: a
 * temporary file renamed over it) next to the job's files and, while it waits or runs, the
 * snapshot of the project it exports (`snapshot.ybin`). At startup the jobs are read back: one that
 * was running cannot go on (its render state is gone) and becomes failed 'server restarted'; a
 * queued one waits again with its snapshot. Finished jobs are deleted after EXPORT_TTL_HOURS, and
 * the oldest finished ones first when all exports together take more than EXPORT_MAX_MB.
 */

export const JOB_FILE = 'job.json';
export const SNAPSHOT_FILE = 'snapshot.ybin';

/** The statuses of a job that will not change any more. */
export function finished(status: ExportStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** Ids safe as folder names (project ids, job ids). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function safeName(name: string): boolean {
  return SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

/** Bytes of a directory's files (recursively; 0 when it does not exist). */
export async function diskUsage(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await diskUsage(p);
    else
      try {
        total += (await stat(p)).size;
      } catch {
        // deleted meanwhile
      }
  }
  return total;
}

/** What the cleanup policy knows of a job. */
export interface CleanupCandidate {
  id: string;
  status: ExportStatus;
  /** ISO time (null while not finished). */
  finished_at: string | null;
  bytes: number;
}

/**
 * The jobs to delete: finished ones older than `ttlMs`, then, while all exports take more than
 * `maxBytes`, the oldest finished ones. Queued and running jobs are never chosen.
 */
export function cleanupSelection(
  jobs: readonly CleanupCandidate[],
  o: { now: number; ttlMs: number; maxBytes: number; totalBytes: number },
): string[] {
  const done = jobs
    .filter((j) => finished(j.status))
    .map((j) => ({ ...j, t: j.finished_at ? Date.parse(j.finished_at) : 0 }))
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const out: string[] = [];
  let total = o.totalBytes;
  for (const j of done) {
    if (o.now - j.t > o.ttlMs) {
      out.push(j.id);
      total -= j.bytes;
    }
  }
  for (const j of done) {
    if (total <= o.maxBytes) break;
    if (out.includes(j.id)) continue;
    out.push(j.id);
    total -= j.bytes;
  }
  return out;
}

/** The saves of one job: the write in progress and the save waiting for it (if any). */
interface SaveQueue {
  /** Settles when the last write asked for so far has ended (never rejects). */
  tail: Promise<void>;
  /** A save that waits for the write in progress: later saves of the job join it. */
  waiting: { job: ExportJob; done: Promise<void> } | null;
}

/** Temporary file names of one process, each write its own. */
let tmpCounter = 0;

/** Reads, writes and deletes the jobs of one export directory. */
export class JobStore {
  /** The saves of each job (by directory) in progress. */
  private readonly saves = new Map<string, SaveQueue>();

  constructor(
    readonly root: string,
    private readonly log: Log,
  ) {}

  /** The directory of a job. */
  dirOf(job: Pick<ExportJob, 'project' | 'id'>): string {
    return path.join(this.root, job.project, job.id);
  }

  /**
   * Writes job.json atomically (a temporary file renamed over it). The saves of a job run one at a
   * time in the order asked: one asked for while another writes waits for it, and the saves asked
   * for meanwhile join it (it writes the latest of them), so job.json always holds a whole job, the
   * last one asked for once they are done. Resolves once a write with this state (or a later one)
   * ended.
   */
  save(job: ExportJob): Promise<void> {
    const dir = this.dirOf(job);
    let queue = this.saves.get(dir);
    if (queue?.waiting) {
      queue.waiting.job = job;
      return queue.waiting.done;
    }
    if (!queue) this.saves.set(dir, (queue = { tail: Promise.resolve(), waiting: null }));
    const q = queue;
    const waiting: NonNullable<SaveQueue['waiting']> = { job, done: Promise.resolve() };
    q.waiting = waiting;
    waiting.done = q.tail.then(() => {
      // from now on later saves wait for this write
      if (q.waiting === waiting) q.waiting = null;
      return this.write(dir, waiting.job);
    });
    const tail = waiting.done.then(
      () => undefined,
      () => undefined,
    );
    q.tail = tail;
    void tail.then(() => {
      if (this.saves.get(dir) === q && q.tail === tail) this.saves.delete(dir);
    });
    return waiting.done;
  }

  private async write(dir: string, job: ExportJob): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${JOB_FILE}.${process.pid}.${++tmpCounter}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(job, null, 2));
      await rename(tmp, path.join(dir, JOB_FILE));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Deletes a job's directory (after its saves in progress, which would write it back). */
  async remove(job: Pick<ExportJob, 'project' | 'id'>): Promise<void> {
    const dir = this.dirOf(job);
    await this.saves.get(dir)?.tail;
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Reads every job.json under the root (unreadable or foreign ones are skipped and logged).
   */
  async loadAll(): Promise<ExportJob[]> {
    await mkdir(this.root, { recursive: true });
    const out: ExportJob[] = [];
    for (const project of await readdir(this.root).catch(() => [] as string[])) {
      if (!safeName(project)) continue;
      const pdir = path.join(this.root, project);
      let ids: string[];
      try {
        if (!(await stat(pdir)).isDirectory()) continue;
        ids = await readdir(pdir);
      } catch {
        continue;
      }
      for (const id of ids) {
        if (!safeName(id)) continue;
        try {
          const raw = JSON.parse(await readFile(path.join(pdir, id, JOB_FILE), 'utf8')) as ExportJob;
          if (raw && raw.id === id && raw.project === project && typeof raw.status === 'string')
            out.push(raw);
        } catch (err) {
          this.log.warn({ job: id, project, err: String(err) }, 'video export job not readable: skipped');
        }
      }
    }
    return out;
  }
}
