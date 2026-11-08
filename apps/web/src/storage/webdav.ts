import { signal } from '@preact/signals';
import {
  ProjectFileStore,
  WebDAVClient,
  type ProjectInfo,
  type SceneDoc,
  type SyncResult,
} from '@3d-editor/core';
import { prefs } from '../app/prefs';
import { serverConfig } from '../app/store';
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

export type WebDAVStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

/**
 * Keeps one open project merged with its WebDAV copy: initial pull, debounced pushes after local
 * edits, periodic polling for changes made by other devices, and a final flush on page hide.
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

  async syncNow(): Promise<SyncResult | null> {
    if (this.stopped) return null;
    if (!navigator.onLine) {
      this.status.value = 'offline';
      return null;
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const span = telemetry.startSpan('storage.webdav.sync', {
        'storage.via_server': this.target.viaServer,
      });
      this.status.value = 'syncing';
      try {
        // Every sync merges the stored content it reads (no `lastEtag`): the ETags of WebDAV
        // servers that make them from the modification time can repeat for another write (nginx:
        // one of the same size within the same second), and skipping a write with the ETag of the
        // last sync would leave this device without it. The skip would only save re-applying the
        // document (3.6 ms for 0.48 MB), as the GET and the comparison happen either way.
        const res = await this.target.store.syncDocument(this.projectId, this.doc.ydoc, {
          origin: this.origin,
          info: this.info,
        });
        this.status.value = 'synced';
        this.error.value = null;
        this.lastSyncAt.value = Date.now();
        span.setAttribute('storage.pulled', res.pulled).setAttribute('storage.pushed', res.pushed).setOk();
        telemetry.histogram('editor.storage.save_ms', span.end());
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

  async stop(flush = true): Promise<void> {
    if (flush) await this.syncNow().catch(() => null);
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.doc.ydoc.off('update', this.onUpdate);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
  }
}
