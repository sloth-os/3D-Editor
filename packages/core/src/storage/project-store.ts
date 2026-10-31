import * as Y from 'yjs';
import type { FileStore } from './filestore';
import { PreconditionFailedError, joinPath } from './filestore';
import { isValidProjectId } from '../util/id';

/*
 * Project layout shared by WebDAV storage (browser), the server's disk/WebDAV persistence and
 * exported archives:
 *
 *   <base>/projects/<projectId>/project.json   ProjectInfo (name, timestamps, stats)
 *   <base>/projects/<projectId>/document.ybin  Yjs document state (Y.encodeStateAsUpdate)
 *
 * Documents are CRDTs, so saving is a merge: read remote → merge into local → write merged
 * state with If-Match. Concurrent writers never lose each other's edits.
 */

export interface ProjectInfo {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  schema_version: number;
  /** Small PNG/JPEG data URL preview (optional). */
  thumbnail?: string;
  stats?: { objects: number; vertices: number; faces: number };
}

export interface SyncResult {
  /** Remote changes were merged into the local document. */
  pulled: boolean;
  /** The merged state was written to the store. */
  pushed: boolean;
  etag?: string;
}

/** Returns true if applying `update` to a doc holding `base` would change anything. */
export function updateAddsToState(base: Uint8Array | null, update: Uint8Array): boolean {
  const tmp = new Y.Doc();
  try {
    if (base) Y.applyUpdate(tmp, base);
    let changed = false;
    tmp.on('update', () => {
      changed = true;
    });
    Y.applyUpdate(tmp, update);
    return changed;
  } finally {
    tmp.destroy();
  }
}

export class ProjectFileStore {
  constructor(
    readonly fs: FileStore,
    readonly basePath = '/',
  ) {}

  projectsDir(): string {
    return joinPath(this.basePath, 'projects');
  }
  projectDir(id: string): string {
    if (!isValidProjectId(id)) throw new Error(`invalid project id '${id}'`);
    return joinPath(this.projectsDir(), id);
  }
  docPath(id: string): string {
    return joinPath(this.projectDir(id), 'document.ybin');
  }
  infoPath(id: string): string {
    return joinPath(this.projectDir(id), 'project.json');
  }

  async listProjects(): Promise<ProjectInfo[]> {
    let entries;
    try {
      entries = await this.fs.list(this.projectsDir());
    } catch {
      return [];
    }
    const ids = entries.filter((e) => e.isDir && isValidProjectId(e.name)).map((e) => e.name);
    const infos = await Promise.all(ids.map((id) => this.loadInfo(id).catch(() => null)));
    return infos
      .filter((x): x is ProjectInfo => !!x)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async loadInfo(id: string): Promise<ProjectInfo | null> {
    const r = await this.fs.read(this.infoPath(id));
    if (!r) return null;
    const info = JSON.parse(new TextDecoder().decode(r.data)) as ProjectInfo;
    return { ...info, id };
  }

  async saveInfo(info: ProjectInfo): Promise<void> {
    await this.fs.mkdirp(this.projectDir(info.id));
    await this.fs.write(this.infoPath(info.id), new TextEncoder().encode(JSON.stringify(info, null, 2)), {
      contentType: 'application/json',
    });
  }

  async loadDocument(id: string): Promise<{ update: Uint8Array; etag?: string } | null> {
    const r = await this.fs.read(this.docPath(id));
    return r ? { update: r.data, etag: r.etag } : null;
  }

  async deleteProject(id: string): Promise<void> {
    await this.fs.remove(this.projectDir(id));
  }

  /**
   * Merge-synchronizes a local Y.Doc with the stored document:
   *  1. read the stored state; skip everything if its ETag equals `lastEtag` and the local doc
   *     has no changes the store lacks
   *  2. merge the stored state into the local doc (origin = `origin`)
   *  3. if the local doc holds anything the store lacks, write the full merged state using
   *     If-Match (retrying on concurrent modification)
   */
  async syncDocument(
    id: string,
    ydoc: Y.Doc,
    opts: { lastEtag?: string; origin?: unknown; info?: () => ProjectInfo; maxAttempts?: number } = {},
  ): Promise<SyncResult> {
    let pulled = false;
    const attempts = opts.maxAttempts ?? 5;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remote = await this.loadDocument(id);
      if (remote && remote.etag && opts.lastEtag && remote.etag === opts.lastEtag) {
        const local = Y.encodeStateAsUpdate(ydoc);
        if (!updateAddsToState(remote.update, local)) return { pulled, pushed: false, etag: remote.etag };
      }
      if (remote) {
        let changed = false;
        const onUpdate = () => {
          changed = true;
        };
        ydoc.on('update', onUpdate);
        Y.applyUpdate(ydoc, remote.update, opts.origin ?? 'storage');
        ydoc.off('update', onUpdate);
        pulled = pulled || changed;
      }
      const local = Y.encodeStateAsUpdate(ydoc);
      if (remote && !updateAddsToState(remote.update, local))
        return { pulled, pushed: false, etag: remote.etag };
      try {
        await this.fs.mkdirp(this.projectDir(id));
        const res = await this.fs.write(this.docPath(id), local, {
          ...(remote?.etag ? { ifMatch: remote.etag } : remote ? {} : { ifNoneMatch: '*' as const }),
          contentType: 'application/octet-stream',
        });
        if (opts.info) await this.saveInfo(opts.info());
        return { pulled, pushed: true, etag: res.etag };
      } catch (err) {
        if (err instanceof PreconditionFailedError) continue;
        throw err;
      }
    }
    throw new Error(`could not save project ${id}: too many concurrent modifications`);
  }
}
