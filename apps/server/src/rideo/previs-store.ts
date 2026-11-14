import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Log } from '../observability/log';
import type { PrevisJob } from './index';

/*
 * The previs jobs on disk (POST /api/rideo/previs): one `<DATA_DIR>/rideo-previs/<job>.json` each,
 * rewritten whenever the job changes (atomically: a temporary file renamed over it, the writes of a
 * job one at a time in the order asked), so that GET /api/rideo/previs/:job still answers after the
 * server restarted. A job that was running when the server stopped cannot go on (its import, export
 * and push ran in the old process): the bridge reads it back as failed (rideo/index.ts).
 */

/** The folder of the previs jobs under DATA_DIR. */
export const PREVIS_DIR = 'rideo-previs';

/** Ids safe as file names (previs job ids are core newId()s). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Temporary file names of one process, each write its own. */
let tmpCounter = 0;

/** Reads, writes and deletes the previs jobs of one folder. */
export class PrevisStore {
  /** The last write or deletion asked for of each job (settles when it has ended; never rejects). */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    readonly dir: string,
    private readonly log?: Log,
  ) {}

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * Saves the job as it is now (a copy is taken at once). Resolves once that write has ended; a
   * write that fails is logged, never thrown: the job goes on in memory.
   */
  save(job: PrevisJob): Promise<void> {
    if (!SAFE_ID.test(job.id)) return Promise.resolve();
    const data = JSON.stringify(job, null, 2);
    return this.queue(job.id, 'not saved', () => this.write(job.id, data));
  }

  /** Runs `op` after the job's earlier writes; a failure is logged (`what`), never thrown. */
  private queue(id: string, what: string, op: () => Promise<void>): Promise<void> {
    const prev = this.writes.get(id) ?? Promise.resolve();
    const settled = prev.then(op).catch((err: unknown) => {
      this.log?.warn({ job: id, err: String(err) }, `rideo previs job ${what}`);
    });
    this.writes.set(id, settled);
    void settled.then(() => {
      if (this.writes.get(id) === settled) this.writes.delete(id);
    });
    return settled;
  }

  private async write(id: string, data: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.${id}.${process.pid}.${++tmpCounter}.tmp`);
    try {
      await writeFile(tmp, data);
      await rename(tmp, this.fileOf(id));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Deletes a job's file (after its writes in progress, which would write it back). */
  remove(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return Promise.resolve();
    return this.queue(id, 'not deleted', () => rm(this.fileOf(id), { force: true }));
  }

  /** Waits for every write and deletion asked for so far. */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
  }

  /**
   * Reads every job of the folder (none when it does not exist); unreadable or foreign files are
   * skipped and logged, temporary files of an interrupted write deleted.
   */
  async loadAll(): Promise<PrevisJob[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: PrevisJob[] = [];
    for (const name of names) {
      if (name.startsWith('.') && name.endsWith('.tmp')) {
        await rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id)) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as PrevisJob;
        if (
          raw &&
          raw.id === id &&
          typeof raw.status === 'string' &&
          typeof raw.created_at === 'string' &&
          Array.isArray(raw.warnings)
        )
          out.push(raw);
        else this.log?.warn({ job: id }, 'rideo previs job not readable: skipped');
      } catch (err) {
        this.log?.warn({ job: id, err: String(err) }, 'rideo previs job not readable: skipped');
      }
    }
    return out;
  }
}
