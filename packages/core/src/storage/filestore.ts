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
}

export interface FileStore {
  list(dir: string): Promise<FileEntry[]>;
  read(path: string): Promise<{ data: Uint8Array; etag?: string } | null>;
  write(path: string, data: Uint8Array, opts?: WriteOptions): Promise<{ etag?: string }>;
  remove(path: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
}

/** Thrown when a conditional write fails (HTTP 412). */
export class PreconditionFailedError extends Error {
  constructor(path: string) {
    super(`Precondition failed for ${path}`);
    this.name = 'PreconditionFailedError';
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

  async write(path: string, data: Uint8Array, opts: WriteOptions = {}) {
    const p = this.norm(path);
    const cur = this.files.get(p);
    if (opts.ifNoneMatch === '*' && cur) throw new PreconditionFailedError(p);
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw new PreconditionFailedError(p);
    const etag = `"m${++this.counter}"`;
    this.files.set(p, { data: data.slice(), etag, mtime: new Date().toUTCString() });
    return { etag };
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
