import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  ProjectFileStore,
  WebDAVClient,
  type ProjectInfo,
  type SceneDoc,
  type SyncResult,
} from '@3d-editor/core';
import { prefs } from '../app/prefs';
import { serverConfig, toast } from '../app/store';
import { authHeaders, serverBase } from '../app/server-config';
import { telemetry } from '../telemetry/telemetry';

export interface WebDAVTarget {
  store: ProjectFileStore;
  /** Human-readable description for the UI. */
  label: string;
  viaServer: boolean;
}

/**
 * Decides where projects are persisted remotely:
 *  - storage mode "browser": nowhere (IndexedDB only)
 *  - "webdav": the WebDAV server configured in preferences (browser talks to it directly; needs CORS)
 *  - "auto": the editor server's WebDAV proxy when the server has WebDAV configured, otherwise the
 *    preference URL when set, otherwise browser only
 */
export function resolveWebDAV(): WebDAVTarget | null {
  const p = prefs.value.storage;
  if (p.mode === 'browser') return null;
  const cfg = serverConfig.value;
  const custom = p.webdav.url.trim();
  if (p.mode === 'auto' && cfg?.webdav) {
    const client = new WebDAVClient({
      url: `${serverBase() || location.origin}${cfg.webdav.url}`,
      headers: authHeaders(),
      timeoutMs: 20_000,
    });
    return {
      store: new ProjectFileStore(client, cfg.webdav.basePath),
      label: 'WebDAV (via editor server)',
      viaServer: true,
    };
  }
  if (custom) {
    const client = new WebDAVClient({
      url: custom,
      username: p.webdav.username || undefined,
      password: p.webdav.password || undefined,
      timeoutMs: 20_000,
    });
    return {
      store: new ProjectFileStore(client, p.webdav.basePath || '/'),
      label: `WebDAV (${new URL(custom, location.href).host})`,
      viaServer: false,
    };
  }
  return null;
}

/**
 * `deleted`: the store has no document of a project this browser synced with it before (another
 * device, or this browser, deleted it), and this tab has no changes made since: it does not write
 * it again.
 */
export type WebDAVStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'deleted';

const SYNCED_PREFIX = '3d-editor:webdav-synced:';
const DELETED_PREFIX = '3d-editor:webdav-deleted:';

/** Identifies a WebDAV store: the URL of its projects folder. */
function storeKey(target: WebDAVTarget): string {
  const fs = target.store.fs;
  return fs instanceof WebDAVClient ? fs.urlFor(target.store.projectsDir()) : target.label;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked */
  }
}

/**
 * What this browser knows of each project in each WebDAV store, kept in localStorage, which every
 * tab of the browser shares across sessions (empty in private windows or when storage is blocked:
 * such a browser treats every project as one it never synced):
 *  - `synced`: the state vector of the stored states its syncs read or wrote (for each client, the
 *    newest clock any of them held), also of a state another writer deleted right after;
 *  - `deleted`: a tab of this browser deleted the project from the store (until a sync finds it
 *    stored again). Deleting a project keeps its `synced` record: the tabs that still have it
 *    open then tell whether they hold changes made since.
 */
export const syncRecords = {
  syncedKey: (target: WebDAVTarget, projectId: string) => `${SYNCED_PREFIX}${projectId}:${storeKey(target)}`,
  deletedKey: (target: WebDAVTarget, projectId: string) =>
    `${DELETED_PREFIX}${projectId}:${storeKey(target)}`,
  synced(target: WebDAVTarget, projectId: string): Uint8Array | null {
    const v = readStorage(this.syncedKey(target, projectId));
    try {
      return v ? Uint8Array.from(atob(v), (c) => c.charCodeAt(0)) : null;
    } catch {
      return null;
    }
  },
  /** Adds a stored state (a Yjs update) to the `synced` record. */
  addSynced(target: WebDAVTarget, projectId: string, stored: Uint8Array): void {
    const vector = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(stored));
    const known = this.synced(target, projectId);
    if (known)
      for (const [client, clock] of Y.decodeStateVector(known))
        if (clock > (vector.get(client) ?? 0)) vector.set(client, clock);
    let bin = '';
    for (const b of Y.encodeStateVector(vector)) bin += String.fromCharCode(b);
    writeStorage(this.syncedKey(target, projectId), btoa(bin));
  },
  deleted(target: WebDAVTarget, projectId: string): boolean {
    return readStorage(this.deletedKey(target, projectId)) !== null;
  },
  setDeleted(target: WebDAVTarget, projectId: string, deleted: boolean): void {
    writeStorage(this.deletedKey(target, projectId), deleted ? new Date().toISOString() : null);
  },
};

/**
 * Whether a document holds an insertion beyond a state vector. Deletions do not advance state
 * vectors; changes that only delete are not counted, which is right where this is used: a project
 * deleted elsewhere is gone together with what they deleted.
 */
function holdsMoreThan(doc: Y.Doc, vector: Uint8Array): boolean {
  const known = Y.decodeStateVector(vector);
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc)))
    if (clock > (known.get(client) ?? 0)) return true;
  return false;
}

/**
 * Keeps one open project merged with its WebDAV copy: initial pull, debounced pushes after local
 * edits, periodic polling for changes made by other devices, and a final flush on page hide.
 *
 * Deleted projects follow the editor server's rule: when the store has no document of a project
 * this browser synced with it before, another device (or a tab of this browser) deleted it, and a
 * sync writes it again only when this tab's copy holds changes made since the browser's last sync
 * with the store (its own edits, or others' it received live) — it keeps that work and says so.
 * Without such changes it writes nothing, shows the status `deleted` and tells the person once; a
 * later change, or Save (Ctrl+S), saves the project again. A project this browser never synced
 * with the store is uploaded, unless a tab of this browser deleted it.
 */
export class WebDAVSync {
  readonly status = signal<WebDAVStatus>('idle');
  readonly lastSyncAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private running: Promise<SyncResult | null> | null = null;
  private again = false;
  private stopped = false;
  /** The person was told that the project was deleted from the store (until it is stored again). */
  private toldDeleted = false;

  constructor(
    readonly target: WebDAVTarget,
    readonly projectId: string,
    readonly doc: SceneDoc,
    private readonly info: () => ProjectInfo,
    private readonly origin: unknown,
  ) {
    doc.ydoc.on('update', this.onUpdate);
    this.poll = setInterval(() => void this.syncNow(), 20_000);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
  }

  private onUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === this.origin) return; // our own merge
    this.schedule();
  };
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') void this.syncNow();
  };
  private onOnline = () => void this.syncNow();

  schedule(delay = 1500): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delay);
  }

  /**
   * Syncs now (or right after the sync that is running). `save`: write the project also when the
   * store lost it and this browser has no changes since its last sync (Save, Ctrl+S).
   */
  async syncNow(opts: { save?: boolean } = {}): Promise<SyncResult | null> {
    if (this.stopped) return null;
    if (!navigator.onLine) {
      this.status.value = 'offline';
      return null;
    }
    if (this.running) {
      if (!opts.save) {
        this.again = true;
        return this.running;
      }
      await this.running;
      return this.syncNow(opts);
    }
    this.running = (async () => {
      const span = telemetry.startSpan('storage.webdav.sync', {
        'storage.via_server': this.target.viaServer,
      });
      this.status.value = 'syncing';
      try {
        const ydoc = this.doc.ydoc;
        const { target, projectId } = this;
        const synced = syncRecords.synced(target, projectId);
        const deletedHere = syncRecords.deleted(target, projectId);
        // a project it never synced with this store is uploaded (unless it holds nothing yet: a
        // project opened from elsewhere before it arrived, or a tab of this browser deleted it);
        // one it synced, whose document is gone, only with changes made since
        const changed = synced ? holdsMoreThan(ydoc, synced) : !deletedHere && ydoc.store.clients.size > 0;
        // Every sync merges the stored content it reads (no `lastEtag`): the ETags of WebDAV
        // servers that make them from the modification time can repeat for another write (nginx:
        // one of the same size within the same second), and skipping a write with the ETag of the
        // last sync would leave this device without it. The skip would only save re-applying the
        // document (3.6 ms for 0.48 MB), as the GET and the comparison happen either way.
        const res = await this.target.store.syncDocument(this.projectId, ydoc, {
          origin: this.origin,
          info: this.info,
          create: changed || !!opts.save,
        });
        span
          .setAttribute('storage.pulled', res.pulled)
          .setAttribute('storage.pushed', res.pushed)
          .setAttribute('storage.missing', !!res.missing)
          .setOk();
        telemetry.histogram('editor.storage.save_ms', span.end());
        this.error.value = null;
        this.lastSyncAt.value = Date.now();
        // also when the document is gone: what this sync wrote or read right before another writer
        // deleted it is no change the store lacked (the next syncs would store it again)
        if (res.stored) syncRecords.addSynced(target, projectId, res.stored);
        if (res.missing) {
          if (!synced && !deletedHere && !res.pushed) {
            this.status.value = 'idle';
            return res;
          }
          if (!this.toldDeleted)
            toast(
              deletedHere
                ? `"${this.doc.name}" was deleted from WebDAV in this browser. This tab keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).`
                : `"${this.doc.name}" was deleted from WebDAV on another device. This browser keeps its copy and stores it on WebDAV again when you change it or save (Ctrl+S).`,
              'warning',
              10_000,
            );
          this.toldDeleted = true;
          this.status.value = 'deleted';
          this.error.value = deletedHere
            ? 'Deleted from WebDAV in this browser'
            : 'Deleted from WebDAV on another device';
          return res;
        }
        this.toldDeleted = false;
        if (deletedHere) syncRecords.setDeleted(target, projectId, false);
        if (res.created && (synced || deletedHere))
          toast(
            deletedHere
              ? `"${this.doc.name}" was deleted from WebDAV in this browser; this tab stored it there again.`
              : `"${this.doc.name}" was deleted from WebDAV on another device; this browser stored it there again.`,
            'warning',
            10_000,
          );
        this.status.value = 'synced';
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.status.value = navigator.onLine ? 'error' : 'offline';
        this.error.value = msg;
        span.setError(msg).end();
        telemetry.log('WARN', `WebDAV sync failed: ${msg}`);
        return null;
      } finally {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.schedule(500);
        }
      }
    })();
    return this.running;
  }

  /**
   * Stops syncing; `flush`: sync a last time first. Resolves once a sync that was running has
   * finished, so that its writes land before what the caller does next (deleting the project: a
   * write after the deletion would store it again).
   */
  async stop(flush = true): Promise<void> {
    if (flush) await this.syncNow().catch(() => null);
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.doc.ydoc.off('update', this.onUpdate);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
    await this.running;
  }
}
