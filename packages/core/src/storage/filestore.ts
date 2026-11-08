/** Minimal file abstraction implemented by WebDAV, the server's local disk and in-memory stores. */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size?: number;
  etag?: string;
  lastModified?: string;
}

export interface WriteOptions {
  /** Only write if the current ETag matches (optimistic concurrency). */
  ifMatch?: string;
  /** Only write if the file does not exist ('*'). */
  ifNoneMatch?: '*';
  contentType?: string;
  /**
   * False: a write into a folder that does not exist fails with {@link MissingFolderError} instead
   * of creating the folder (the folder of a file just written is gone only when another writer
   * deleted it). Default true.
   */
  createFolders?: boolean;
}

export interface ReadOptions {
  /**
   * False when the caller does not use the ETag: the store may then leave it out instead of
   * sending the requests it takes to learn it (WebDAV servers that send none with GET).
   */
  etag?: boolean;
}

/**
 * ETags are only ever reported for the content they belong to: callers use them to skip content
 * they already merged and for If-Match, so an ETag paired with other content (say, the ETag of a
 * write that came between reading a file and asking for its ETag) would make them skip that write
 * or replace it.
 */
export interface FileStore {
  list(dir: string): Promise<FileEntry[]>;
  /** Reads a file. `etag` is the ETag of exactly `data`, or unset when the store cannot tell. */
  read(path: string, opts?: ReadOptions): Promise<{ data: Uint8Array; etag?: string } | null>;
  /** Writes a file. `etag` is the ETag of exactly `data`, or unset when the store cannot tell. */
  write(path: string, data: Uint8Array, opts?: WriteOptions): Promise<{ etag?: string }>;
  remove(path: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  /**
   * The current ETag of a file without reading it, in the form `read` reports it: null when the
   * file does not exist, undefined when the store cannot tell.
   */
  etag?(path: string): Promise<string | null | undefined>;
  /**
   * True when the store checks a conditional write (If-Match, If-None-Match) and applies it as one
   * step, so that a write accepted with `ifMatch` never replaces a write it was not based on. The
   * WebDAV client leaves it unset: some servers ignore If-Match, others check it before the upload
   * of the new content ends (see docs/storage-and-sync.md), so its writers read their writes back.
   */
  readonly atomicConditionalWrites?: boolean;
}

/** Thrown when a conditional write fails (HTTP 412). */
export class PreconditionFailedError extends Error {
  constructor(path: string) {
    super(`Precondition failed for ${path}`);
    this.name = 'PreconditionFailedError';
  }
}

/** Thrown by a write with `createFolders: false` into a folder that does not exist (HTTP 409). */
export class MissingFolderError extends Error {
  constructor(path: string) {
    super(`The folder of ${path} does not exist`);
    this.name = 'MissingFolderError';
  }
}

export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** In-memory FileStore (tests and ephemeral servers). */
export class MemoryFileStore implements FileStore {
  readonly atomicConditionalWrites = true;
  private files = new Map<string, { data: Uint8Array; etag: string; mtime: string }>();
  private dirs = new Set<string>(['/']);
  private counter = 0;

  private norm(p: string): string {
    const n = joinPath(p);
    return n.length > 1 ? n.replace(/\/$/, '') : n;
  }

  async list(dir: string): Promise<FileEntry[]> {
    const d = this.norm(dir);
    const prefix = d === '/' ? '/' : `${d}/`;
    const out = new Map<string, FileEntry>();
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [first, ...more] = rest.split('/');
      if (more.length) out.set(first, { name: first, isDir: true });
      else
        out.set(first, {
          name: first,
          isDir: false,
          size: f.data.length,
          etag: f.etag,
          lastModified: f.mtime,
        });
    }
    for (const sub of this.dirs) {
      if (!sub.startsWith(prefix) || sub === d) continue;
      const first = sub.slice(prefix.length).split('/')[0];
      if (first && !out.has(first)) out.set(first, { name: first, isDir: true });
    }
    return [...out.values()];
  }

  async read(path: string) {
    const f = this.files.get(this.norm(path));
    return f ? { data: f.data.slice(), etag: f.etag } : null;
  }

  async etag(path: string) {
    return this.files.get(this.norm(path))?.etag ?? null;
  }

  async write(path: string, data: Uint8Array, opts: WriteOptions = {}) {
    const p = this.norm(path);
    const cur = this.files.get(p);
    if (opts.ifNoneMatch === '*' && cur) throw new PreconditionFailedError(p);
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw new PreconditionFailedError(p);
    if (opts.createFolders === false && !this.folderExists(p.slice(0, p.lastIndexOf('/')) || '/'))
      throw new MissingFolderError(p);
    const etag = `"m${++this.counter}"`;
    this.files.set(p, { data: data.slice(), etag, mtime: new Date().toUTCString() });
    return { etag };
  }

  /** A folder exists when it was created (mkdirp) or holds a file (writes create their folders). */
  private folderExists(dir: string): boolean {
    if (dir === '/' || this.dirs.has(dir)) return true;
    for (const p of this.files.keys()) if (p.startsWith(`${dir}/`)) return true;
    return false;
  }

  async remove(path: string) {
    const p = this.norm(path);
    this.files.delete(p);
    for (const k of [...this.files.keys()]) if (k.startsWith(`${p}/`)) this.files.delete(k);
    for (const k of [...this.dirs]) if (k === p || k.startsWith(`${p}/`)) this.dirs.delete(k);
  }

  async mkdirp(dir: string) {
    const parts = this.norm(dir).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      this.dirs.add(cur);
    }
  }
}
