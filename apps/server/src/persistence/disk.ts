import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  PreconditionFailedError,
  joinPath,
  type FileEntry,
  type FileStore,
  type WriteOptions,
} from '@3d-editor/core';

/** ETag derived from size and modification time: `"<size>-<mtimeMs>"`. */
export function etagFor(st: Pick<Stats, 'size' | 'mtimeMs'>): string {
  return `"${st.size}-${st.mtimeMs}"`;
}

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const TEMP_RE = /^\..+\.[0-9a-f]{12}\.tmp$/;

/**
 * FileStore on the local file system (server persistence mode `disk`).
 *
 * - Writes are atomic: data goes to a temporary file in the same directory which is then
 *   renamed over the target, so readers never observe partial files.
 * - Conditional writes (If-Match / If-None-Match) are checked under a per-path lock, which
 *   makes them reliable within this process (the server is the only writer of its data dir).
 * - Every write produces a new ETag: each version of a file gets a later mtime than the one it
 *   replaces (nudged by 1 ms when the clock did not advance), set before it is renamed into place.
 * - A read reports the ETag of the file it read: content and ETag come from one open file, which
 *   no write changes (writes replace the file).
 */
export class DiskFileStore implements FileStore {
  readonly atomicConditionalWrites = true;
  readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Maps a store path ('/a/b.txt') to an absolute file system path inside the root. */
  resolve(p: string): string {
    if (p.includes('\0')) throw new Error('invalid path');
    const parts = joinPath(p).split('/').filter(Boolean);
    for (const part of parts)
      if (part === '.' || part === '..') throw new Error(`invalid path segment in '${p}'`);
    return path.join(this.root, ...parts);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }

  private async statOrNull(file: string): Promise<Stats | null> {
    try {
      const st = await fs.stat(file);
      return st.isFile() ? st : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dir: string): Promise<FileEntry[]> {
    const abs = this.resolve(dir);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const out: FileEntry[] = [];
    for (const e of entries) {
      if (TEMP_RE.test(e.name)) continue;
      if (e.isDirectory()) {
        out.push({ name: e.name, isDir: true });
      } else if (e.isFile()) {
        const st = await this.statOrNull(path.join(abs, e.name));
        if (!st) continue;
        out.push({
          name: e.name,
          isDir: false,
          size: st.size,
          etag: etagFor(st),
          lastModified: st.mtime.toUTCString(),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(p: string): Promise<{ data: Uint8Array; etag?: string } | null> {
    const file = this.resolve(p);
    let fh: FileHandle;
    try {
      fh = await fs.open(file, 'r');
    } catch (err) {
      if (isNotFound(err) || (err as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw err;
    }
    try {
      // stat and content of the same open file: a write renamed over the path meanwhile replaces
      // the directory entry, not this file, so the ETag is the one of the content read
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const data = await fh.readFile();
      return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), etag: etagFor(st) };
    } finally {
      await fh.close();
    }
  }

  async etag(p: string): Promise<string | null> {
    const st = await this.statOrNull(this.resolve(p));
    return st ? etagFor(st) : null;
  }

  async write(p: string, data: Uint8Array, opts: WriteOptions = {}): Promise<{ etag?: string }> {
    const file = this.resolve(p);
    return this.withLock(file, async () => {
      const cur = await this.statOrNull(file);
      if (opts.ifNoneMatch === '*' && cur) throw new PreconditionFailedError(p);
      if (opts.ifMatch && (!cur || etagFor(cur) !== opts.ifMatch)) throw new PreconditionFailedError(p);
      const dir = path.dirname(file);
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
      let st: Stats;
      try {
        const fh = await fs.open(tmp, 'w');
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
        st = await fs.stat(tmp);
        // The clock did not advance (or went back): a later mtime keeps every version's ETag new,
        // also for a version of the same size as one before the previous one. Set before the
        // rename, so that the file never shows up with another version's ETag. In seconds, not a
        // Date (whole milliseconds, which the conversion to the file's time can round down to the
        // previous value); 1 s more on file systems with coarser times.
        for (const step of [1, 1000]) {
          if (!cur || st.mtimeMs > cur.mtimeMs) break;
          await fs.utimes(tmp, st.atime, (cur.mtimeMs + step) / 1000);
          st = await fs.stat(tmp);
        }
        await fs.rename(tmp, file);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      return { etag: etagFor(st) };
    });
  }

  async remove(p: string): Promise<void> {
    const target = this.resolve(p);
    if (target === this.root) throw new Error('refusing to remove the store root');
    await fs.rm(target, { recursive: true, force: true });
  }

  async mkdirp(dir: string): Promise<void> {
    await fs.mkdir(this.resolve(dir), { recursive: true });
  }

  /** Verifies that the root directory exists (creating it) and is writable. */
  async check(): Promise<{ ok: boolean; message?: string }> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.access(this.root, fsConstants.W_OK);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
