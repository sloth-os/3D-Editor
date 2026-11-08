import * as Y from 'yjs';
import type { FileStore, ReadOptions, WriteOptions } from './filestore';
import { MissingFolderError, PreconditionFailedError, joinPath } from './filestore';
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
  /** A document was written where none was stored (a new project, or one deleted elsewhere). */
  created?: boolean;
  /**
   * The stored state the local document now holds (all of it; the local document may hold more):
   * what was read, or what this call wrote (on WebDAV: and found stored). With `missing`: the last
   * state this call read or wrote before the document was deleted (unset when it read and wrote
   * none).
   */
  stored?: Uint8Array;
  /**
   * No document is stored and none was written: `create` was false, or another writer deleted
   * the project right after storage held all of the local document (this call's write, or a state
   * it read that already held it).
   */
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

  /**
   * The stored projects whose project.json can be read, most recently updated first. Throws when
   * storage cannot list the projects folder (a folder that does not exist lists no projects): an
   * empty list would tell callers that every project is gone.
   */
  async listProjects(): Promise<ProjectInfo[]> {
    const entries = await this.fs.list(this.projectsDir());
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

  /** Writes project.json into the project's folder. */
  private async writeInfo(info: ProjectInfo, opts: Pick<WriteOptions, 'createFolders'> = {}): Promise<void> {
    await this.fs.write(this.infoPath(info.id), new TextEncoder().encode(JSON.stringify(info, null, 2)), {
      contentType: 'application/json',
      ...opts,
    });
  }

  /** Reads the stored document; `{ etag: false }` when the caller does not use its ETag. */
  async loadDocument(id: string, opts?: ReadOptions): Promise<{ update: Uint8Array; etag?: string } | null> {
    const r = await this.fs.read(this.docPath(id), opts);
    return r ? { update: r.data, etag: r.etag } : null;
  }

  /**
   * Whether the document is stored, without downloading it where the store can tell from its ETag
   * (WebDAV: HEAD or PROPFIND; a GET when PROPFIND reports no ETag, as nginx's does).
   */
  async hasDocument(id: string): Promise<boolean> {
    const etag = this.fs.etag ? await this.fs.etag(this.docPath(id)) : undefined;
    if (etag !== undefined) return etag !== null;
    return !!(await this.fs.read(this.docPath(id), { etag: false }));
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
   * Deleted projects: when no document is stored (it was never saved, or another writer deleted
   * the project), `create: false` writes nothing and reports `missing`: a writer without unsaved
   * changes must not bring back a project deleted elsewhere; with `create` (the default) it writes
   * the project again (`created`). Once storage held all of the local document (this call's write,
   * or a stored state that already held it), the call has no changes left that storage lacks: a
   * deletion found after that (its read-back finds no document, or project.json finds no folder)
   * makes it write neither the document nor project.json again, whatever `create` says, and report
   * `missing` (writes never create a folder that is gone). A deletion found after another write
   * replaced this call's write without all of its changes came before a write it still had to
   * make: `create` decides, as for a deletion before its first write.
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
    let created = false;
    let writes = 0;
    /** What this call wrote last, until a read shows it is still the stored state. */
    let written: Uint8Array | null = null;
    /** The last state this call read or wrote (SyncResult.stored when the document is gone). */
    let last: Uint8Array | undefined;
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
    const missing = (): SyncResult => ({ pulled, pushed, created, stored: last, missing: true });
    const done = async (etag: string | undefined, stored: Uint8Array): Promise<SyncResult> => {
      if (pushed && opts.info) {
        try {
          // into the folder of the document just written: no MKCOL requests, and no folder made
          // again when another writer deleted the project since
          await this.writeInfo(opts.info(), { createFolders: false });
        } catch (err) {
          if (err instanceof MissingFolderError) return missing();
          // servers that answer a write into a missing folder otherwise (nginx: 500)
          if (!(await this.hasDocument(id).catch(() => true))) return missing();
          throw err;
        }
      }
      return { pulled, pushed, created, etag, stored };
    };
    for (;;) {
      if (written) {
        // reading back its own write (comparing bytes needs no ETag): done while that is still the
        // stored state; else another write replaced it, which is merged, and when it lacks local
        // changes they are written again after a read that gives the ETag to write with. No
        // document: another writer deleted the project after this write.
        const back = await this.loadDocument(id, { etag: false });
        if (!back) return missing();
        last = back.update;
        if (sameBytes(back.update, written)) return done(back.etag, back.update);
        written = null;
        merge(back.update);
        if (!updateAddsToState(back.update, Y.encodeStateAsUpdate(ydoc))) return done(back.etag, back.update);
        continue;
      }
      const remote = await this.loadDocument(id);
      // never saved, or deleted by another writer before a write this call still has to make (a
      // first write, or one again after a write that lacked its changes replaced its own)
      if (!remote && opts.create === false) return missing();
      if (remote) last = remote.update;
      if (remote?.etag && opts.lastEtag && remote.etag === opts.lastEtag) {
        const local = Y.encodeStateAsUpdate(ydoc);
        if (!updateAddsToState(remote.update, local)) return done(remote.etag, remote.update);
      }
      if (remote) merge(remote.update);
      const local = Y.encodeStateAsUpdate(ydoc);
      if (remote && !updateAddsToState(remote.update, local)) return done(remote.etag, remote.update);
      if (writes >= maxWrites)
        throw new Error(`could not save project ${id}: too many concurrent modifications`);
      writes++;
      // a new document: its folder first, so that no request comes between the check and the write
      if (!remote) await this.fs.mkdirp(this.projectDir(id));
      const expected = remote ? remote.etag : null;
      if (readBack && this.fs.etag && expected !== undefined) {
        // a server that ignores If-Match would let this write replace one that came after the read
        const current = await this.fs.etag(path);
        if (current !== undefined && current !== expected) continue;
        // a new document, and the check cannot tell whether one exists now (nginx's PROPFIND
        // reports no ETag; or the request failed): a GET tells whether another writer created it
        if (current === undefined && expected === null && (await this.fs.read(path, { etag: false })))
          continue;
      }
      let etag: string | undefined;
      try {
        ({ etag } = await this.fs.write(path, local, {
          ...(remote?.etag ? { ifMatch: remote.etag } : remote ? {} : { ifNoneMatch: '*' as const }),
          contentType: 'application/octet-stream',
          // a folder that is gone was deleted with the project after the read: read again
          createFolders: false,
        }));
      } catch (err) {
        if (err instanceof PreconditionFailedError || err instanceof MissingFolderError) continue;
        // servers that answer a write into a folder deleted since the read otherwise (nginx: 500)
        if (remote && !(await this.hasDocument(id).catch(() => true))) continue;
        throw err;
      }
      pushed = true;
      created = created || !remote;
      last = local;
      if (!readBack) return done(etag, local);
      // another write can still have replaced this one (servers that ignore If-Match, or check it
      // before the upload ends): unchanged ETag, or else the same bytes read back, show it did not
      if (etag && this.fs.etag && (await this.fs.etag(path)) === etag) return done(etag, local);
      written = local;
    }
  }
}
