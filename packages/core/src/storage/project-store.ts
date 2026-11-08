import * as Y from 'yjs';
import type { FileStore, ReadOptions } from './filestore';
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
 * state with If-Match. Concurrent writers never lose each other's edits on stores that check
 * If-Match as one step with the write (memory, disk); on WebDAV a writer also reads its write back
 * (see syncDocument and docs/storage-and-sync.md for what that guarantees per server).
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
  /** The ETag of the stored state the local document now holds, when the store reported it. */
  etag?: string;
  /** No document was stored and `create` was false: nothing was written. */
  missing?: boolean;
}

/** Whether two byte arrays hold the same bytes (four bytes at a time where both are aligned). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const words = a.length >> 2;
    const wa = new Uint32Array(a.buffer, a.byteOffset, words);
    const wb = new Uint32Array(b.buffer, b.byteOffset, words);
    for (; i < words; i++) if (wa[i] !== wb[i]) return false;
    i = words << 2;
  }
  for (; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
    // nothing uses the ETag of project.json (on WebDAV: one GET, no PROPFIND requests)
    const r = await this.fs.read(this.infoPath(id), { etag: false });
    if (!r) return null;
    const info = JSON.parse(new TextDecoder().decode(r.data)) as ProjectInfo;
    return { ...info, id };
  }

  async saveInfo(info: ProjectInfo): Promise<void> {
    await this.fs.mkdirp(this.projectDir(info.id));
    await this.writeInfo(info);
  }

  /** Writes project.json into the project's folder, which exists (else WebDAV creates it on 409). */
  private async writeInfo(info: ProjectInfo): Promise<void> {
    await this.fs.write(this.infoPath(info.id), new TextEncoder().encode(JSON.stringify(info, null, 2)), {
      contentType: 'application/json',
    });
  }

  /** Reads the stored document; `{ etag: false }` when the caller does not use its ETag. */
  async loadDocument(id: string, opts?: ReadOptions): Promise<{ update: Uint8Array; etag?: string } | null> {
    const r = await this.fs.read(this.docPath(id), opts);
    return r ? { update: r.data, etag: r.etag } : null;
  }

  async deleteProject(id: string): Promise<void> {
    await this.fs.remove(this.projectDir(id));
  }

  /**
   * Merge-synchronizes a local Y.Doc with the stored document:
   *  1. read the stored state with its ETag (when the store knows the ETag of that content); skip
   *     everything if the ETag equals `lastEtag` and the local doc has no changes the store lacks
   *  2. merge the stored state into the local doc (origin = `origin`)
   *  3. if the local doc holds anything the store lacks, write the full merged state with If-Match
   *     the ETag read (If-None-Match: * for a new document, after creating its folder; no condition
   *     when the ETag is not known), and start over when another write came first (HTTP 412)
   *  4. on stores whose conditional writes are not one atomic step (WebDAV, see
   *     {@link FileStore.atomicConditionalWrites}): right before writing (no other request comes
   *     between), check that the stored ETag is still the one read (servers that ignore If-Match);
   *     after writing, read the document back (or just its ETag, when the write reported one), and
   *     when another write replaced it, merge that one and write again if it lacks local changes
   *
   * `lastEtag` is an ETag this method returned earlier for the same document. It skips merging
   * only on stores whose ETags change with every write: ETags made from the modification time can
   * repeat for another write's content (nginx: one of the same size within the same second; the
   * tests' webdav-server: one within the same millisecond). The editor's own callers do not pass
   * it.
   *
   * `create: false` writes nothing when no document is stored (it was never saved, or another
   * writer deleted the project) and reports `missing`: a refresh of a document without unsaved
   * changes must not bring back a project deleted elsewhere.
   */
  async syncDocument(
    id: string,
    ydoc: Y.Doc,
    opts: {
      lastEtag?: string;
      origin?: unknown;
      info?: () => ProjectInfo;
      maxAttempts?: number;
      create?: boolean;
    } = {},
  ): Promise<SyncResult> {
    const path = this.docPath(id);
    const readBack = !this.fs.atomicConditionalWrites;
    const maxWrites = opts.maxAttempts ?? 5;
    let pulled = false;
    let pushed = false;
    let writes = 0;
    /** What this call wrote last, until a read shows it is still the stored state. */
    let written: Uint8Array | null = null;
    const merge = (update: Uint8Array): void => {
      let changed = false;
      const onUpdate = () => {
        changed = true;
      };
      ydoc.on('update', onUpdate);
      Y.applyUpdate(ydoc, update, opts.origin ?? 'storage');
      ydoc.off('update', onUpdate);
      pulled = pulled || changed;
    };
    const done = async (etag: string | undefined): Promise<SyncResult> => {
      // the document was just written into the project's folder: no MKCOL requests for the info
      if (pushed && opts.info) await this.writeInfo(opts.info());
      return { pulled, pushed, etag };
    };
    for (;;) {
      if (written) {
        // reading back its own write (comparing bytes needs no ETag): done while that is still the
        // stored state; else another write replaced it, which is merged, and when it lacks local
        // changes they are written again after a read that gives the ETag to write with
        const back = await this.loadDocument(id, { etag: false });
        if (back && sameBytes(back.update, written)) return done(back.etag);
        written = null;
        if (back) {
          merge(back.update);
          if (!updateAddsToState(back.update, Y.encodeStateAsUpdate(ydoc))) return done(back.etag);
        }
        continue;
      }
      const remote = await this.loadDocument(id);
      // never saved, or another writer deleted the project (also after this call's own write)
      if (!remote && opts.create === false) return { pulled, pushed, missing: true };
      if (remote?.etag && opts.lastEtag && remote.etag === opts.lastEtag) {
        const local = Y.encodeStateAsUpdate(ydoc);
        if (!updateAddsToState(remote.update, local)) return done(remote.etag);
      }
      if (remote) merge(remote.update);
      const local = Y.encodeStateAsUpdate(ydoc);
      if (remote && !updateAddsToState(remote.update, local)) return done(remote.etag);
      if (writes >= maxWrites)
        throw new Error(`could not save project ${id}: too many concurrent modifications`);
      writes++;
      // a new document: its folder first, so that no request comes between the check and the write
      // (an existing document's folder exists; WebDAVClient.write creates a missing one on 409)
      if (!remote) await this.fs.mkdirp(this.projectDir(id));
      const expected = remote ? remote.etag : null;
      if (readBack && this.fs.etag && expected !== undefined) {
        // a server that ignores If-Match would let this write replace one that came after the read
        const current = await this.fs.etag(path);
        if (current !== undefined && current !== expected) continue;
        // a new document that exists now, on a server whose PROPFIND reports no ETag (nginx): only
        // a GET tells whether another writer created it after the read
        if (current === undefined && expected === null && (await this.fs.read(path, { etag: false })))
          continue;
      }
      let etag: string | undefined;
      try {
        ({ etag } = await this.fs.write(path, local, {
          ...(remote?.etag ? { ifMatch: remote.etag } : remote ? {} : { ifNoneMatch: '*' as const }),
          contentType: 'application/octet-stream',
        }));
      } catch (err) {
        if (err instanceof PreconditionFailedError) continue;
        throw err;
      }
      pushed = true;
      if (!readBack) return done(etag);
      // another write can still have replaced this one (servers that ignore If-Match, or check it
      // before the upload ends): unchanged ETag, or else the same bytes read back, show it did not
      if (etag && this.fs.etag && (await this.fs.etag(path)) === etag) return done(etag);
      written = local;
    }
  }
}
