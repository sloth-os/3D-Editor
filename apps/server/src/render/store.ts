import { randomUUID } from 'node:crypto';

/*
 * Rendered files kept for download (render_animation `store: true`): bounded in-memory storage
 * served by GET /api/projects/:id/renders/:render/:file. Results expire after `ttlMs` and the
 * oldest ones are dropped when the total size exceeds `maxBytes`.
 */

/** One stored file of a render. */
export interface StoredFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

interface StoredRender {
  id: string;
  projectId: string;
  created: number;
  bytes: number;
  files: Map<string, StoredFile>;
}

/** Limits of a {@link RenderStore}. */
export interface RenderStoreOptions {
  /** Total bytes kept (default 256 MiB). */
  maxBytes?: number;
  /** Time a render is kept (default 1 hour). */
  ttlMs?: number;
}

/** Bounded in-memory storage of rendered files, per project (see the module comment). */
export class RenderStore {
  private readonly renders = new Map<string, StoredRender>();
  private bytes = 0;
  readonly maxBytes: number;
  readonly ttlMs: number;

  constructor(opts: RenderStoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  }

  /** Stores the files of one render; returns its id (null when it is larger than the store). */
  put(projectId: string, files: StoredFile[]): string | null {
    this.expire();
    const bytes = files.reduce((n, f) => n + f.data.byteLength, 0);
    if (bytes > this.maxBytes) return null;
    while (this.bytes + bytes > this.maxBytes && this.renders.size) {
      const oldest = this.renders.keys().next().value!;
      this.drop(oldest);
    }
    const id = randomUUID();
    this.renders.set(id, {
      id,
      projectId,
      created: Date.now(),
      bytes,
      files: new Map(files.map((f) => [f.name, f])),
    });
    this.bytes += bytes;
    return id;
  }

  /** A stored file, or null (unknown, expired or of another project). */
  get(projectId: string, renderId: string, name: string): StoredFile | null {
    this.expire();
    const r = this.renders.get(renderId);
    if (!r || r.projectId !== projectId) return null;
    return r.files.get(name) ?? null;
  }

  /** File names of a stored render (null when unknown). */
  list(projectId: string, renderId: string): { name: string; mime: string; bytes: number }[] | null {
    this.expire();
    const r = this.renders.get(renderId);
    if (!r || r.projectId !== projectId) return null;
    return [...r.files.values()].map((f) => ({ name: f.name, mime: f.mime, bytes: f.data.byteLength }));
  }

  /** Forgets every render of a project (e.g. when it is deleted). */
  forgetProject(projectId: string): void {
    for (const r of [...this.renders.values()]) if (r.projectId === projectId) this.drop(r.id);
  }

  get size(): { renders: number; bytes: number } {
    return { renders: this.renders.size, bytes: this.bytes };
  }

  private drop(id: string): void {
    const r = this.renders.get(id);
    if (!r) return;
    this.renders.delete(id);
    this.bytes -= r.bytes;
  }

  private expire(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const r of [...this.renders.values()]) if (r.created < cutoff) this.drop(r.id);
  }
}

let shared: RenderStore | null = null;

/** The process-wide render store. */
export function sharedRenderStore(): RenderStore {
  shared ??= new RenderStore();
  return shared;
}
