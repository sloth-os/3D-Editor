import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { signal, computed } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  meshStats,
  selectionFromJSON,
  selectionToJSON,
  type PresenceState,
  type ProjectInfo,
  type SelectionJSON,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../editor/state';
import { SyncProvider } from '../sync/provider';
import { WebDAVSync, resolveWebDAV, type SaveReport } from '../storage/webdav';
import { localIndex, projectDbName } from './local-index';
import { prefs } from '../app/prefs';
import { serverConfig, toast } from '../app/store';
import { wsUrl } from '../app/server-config';
import { telemetry } from '../telemetry/telemetry';

export interface PeerInfo {
  clientId: number;
  state: PresenceState;
}

/**
 * Everything belonging to one open project: the CRDT document, persistence (IndexedDB always,
 * WebDAV when configured), real-time sync, presence, undo history and per-user editor state.
 */
export class ProjectSession {
  readonly doc: SceneDoc;
  readonly awareness: Awareness;
  readonly state = new EditorStateSignals();
  readonly view = new ViewState();
  readonly undo: Y.UndoManager;
  readonly evaluator: SceneEvaluator;
  /** Bumped on every document change (subscribe in components via `.value`). */
  readonly revision = signal(0);
  readonly undoRevision = signal(0);
  readonly peers = signal<PeerInfo[]>([]);
  readonly title = computed(() => {
    void this.revision.value;
    return this.doc.name;
  });
  provider: SyncProvider | null = null;
  webdav: WebDAVSync | null = null;
  private idb: IndexeddbPersistence | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: (() => void)[] = [];
  /** Origin used for WebDAV merges (not tracked by undo, not re-pushed). */
  readonly storageOrigin = { type: 'storage' };
  thumbnailProvider: (() => string | null) | null = null;
  /** Operator currently executing (recorded on undo steps for telemetry). */
  currentOperator: string | null = null;
  /** The person was told that the server deleted the project (see tellWhenDeletedOnServer). */
  private deletionTold = false;

  private constructor(readonly id: string) {
    this.doc = new SceneDoc(new Y.Doc(), { type: 'local' });
    this.awareness = new Awareness(this.doc.ydoc);
    this.undo = new Y.UndoManager(this.doc.sharedTypes(), {
      trackedOrigins: new Set([this.doc.origin]),
      captureTimeout: 0,
    });
    this.evaluator = new SceneEvaluator(this.doc);
    this.disposers.push(
      this.doc.onChange((c) => {
        this.revision.value++;
        if (c.removed.get('objects')?.size) {
          const removed = c.removed.get('objects')!;
          if (this.state.selectedIds.some((id) => removed.has(id)))
            this.state.selectedIds = this.state.selectedIds.filter((id) => !removed.has(id));
          if (this.state.activeId && removed.has(this.state.activeId)) {
            this.state.activeId = null;
            if (this.state.mode !== 'OBJECT') this.state.mode = 'OBJECT';
          }
        }
        this.scheduleIndexUpdate();
      }),
    );
    // Edit-mode selection travels with undo steps.
    this.undo.on('stack-item-added', (e: { stackItem: { meta: Map<string, unknown> } }) => {
      e.stackItem.meta.set('mode', this.state.mode);
      e.stackItem.meta.set('operator', this.currentOperator ?? 'unknown');
      e.stackItem.meta.set('selection', selectionToJSON(this.state.meshSelection));
      this.undoRevision.value++;
    });
    this.undo.on('stack-item-popped', (e: { stackItem: { meta: Map<string, unknown> } }) => {
      const sel = e.stackItem.meta.get('selection') as SelectionJSON | undefined;
      if (sel && this.state.mode === 'EDIT') this.state.meshSelection = selectionFromJSON(sel);
      this.undoRevision.value++;
    });
    this.awareness.on('change', () => this.refreshPeers());
  }

  /**
   * How long opening a project that has nothing locally waits for the attached sync server or
   * WebDAV to deliver it (or for the server's first sync), at most.
   */
  static remoteWaitMs = 4000;

  static async open(id: string, opts: { initial?: SceneDoc; name?: string } = {}): Promise<ProjectSession> {
    const span = telemetry.startSpan('project.open', { 'project.new': !!opts.initial });
    const s = new ProjectSession(id);
    try {
      s.idb = new IndexeddbPersistence(projectDbName(id), s.doc.ydoc);
      await s.idb.whenSynced;
      if (opts.initial) Y.applyUpdate(s.doc.ydoc, opts.initial.encodeState(), s.storageOrigin);
      s.setupPresence();
      s.provider = new SyncProvider(id, s.doc.ydoc, s.awareness, null);
      s.tellWhenDeletedOnServer(s.provider);
      s.attachRemotes();
      // If nothing exists locally yet (opening a remote project on a fresh device), wait briefly for
      // the server/WebDAV so the UI does not flash an empty scene. Only when one is attached: without
      // one nothing can arrive (other tabs of this browser share the IndexedDB copy), and a server
      // or WebDAV attached later (attachRemotes) fills the open scene when it syncs.
      const remote = s.provider.enabled || !!s.webdav;
      if (remote && !opts.initial && s.doc.listObjects().length === 0 && s.doc.getMeta().created_at === '') {
        await s.waitForRemote(ProjectSession.remoteWaitMs);
      }
      if (opts.name && !s.doc.getMeta().created_at) s.doc.setName(opts.name);
      await localIndex.put({ ...s.projectInfo(), last_opened: new Date().toISOString() });
      span.setAttribute('scene.objects', s.doc.objectIds().length).setOk();
      return s;
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      void s.close(false);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Connects real-time sync and WebDAV storage when they are (or become) available. Called on
   * open and again whenever the server becomes reachable (e.g. the app started offline).
   */
  attachRemotes(): void {
    const cfg = serverConfig.value;
    if (this.provider && !this.provider.enabled && cfg?.features.sync && prefs.value.sync.enabled) {
      this.provider.enable(() => wsUrl(`/sync/${this.id}`));
    }
    if (!this.webdav) {
      const target = resolveWebDAV();
      if (target) {
        const webdav = new WebDAVSync(
          target,
          this.id,
          this.doc,
          () => this.projectInfo(),
          this.storageOrigin,
        );
        this.webdav = webdav;
        if (target.viaServer) this.followServerStorage(webdav);
        // Do not block opening on the network; merge in the background.
        void webdav.syncNow();
      }
    }
  }

  /**
   * Tells the person when the server closes the project's sync connection because it deleted the
   * project (the provider then stops connecting by itself), once per deletion: a connection the
   * server closes the same way again (after Save) says nothing more until a room of the server has
   * taken a connection again (a reload, which opens a new session, says it once again). With WebDAV
   * through the server, a deletion its sync told of first is the same one.
   */
  private tellWhenDeletedOnServer(provider: SyncProvider): void {
    this.disposers.push(
      provider.joined.subscribe((joined) => {
        if (joined) this.deletionTold = false;
      }),
      provider.status.subscribe((st) => {
        if (st !== 'deleted' || this.deletionTold) return;
        this.deletionTold = true;
        const viaServer = !!this.webdav?.target.viaServer;
        if (viaServer && this.webdav?.status.value === 'deleted') return;
        toast(
          viaServer
            ? `"${this.doc.name}" was deleted on the server. This browser keeps its copy and stores it on the server again when you change it or save (Ctrl+S).`
            : `"${this.doc.name}" was deleted on the server. This browser keeps its copy and no longer syncs it with the server.`,
          'warning',
          10_000,
        );
      }),
    );
  }

  /**
   * WebDAV through the editor server is the server's storage: a deletion its sync finds after the
   * server said it deleted the project is that deletion (WebDAVSync says nothing more of it), and
   * once a sync finds the project stored there again (this browser stored it again, or another
   * writer did), the server opens it again: the provider connects again.
   */
  private followServerStorage(webdav: WebDAVSync): void {
    webdav.deletedOnServer = () => this.provider?.status.value === 'deleted';
    let restored = webdav.restored.value;
    this.disposers.push(
      webdav.restored.subscribe((n) => {
        if (n === restored) return;
        restored = n;
        if (this.provider?.status.value === 'deleted') this.provider.reconnect();
      }),
    );
  }

  private waitForRemote(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        off();
        resolve();
      };
      const t = setTimeout(done, ms);
      const off = this.doc.onChange((c) => {
        if (!c.local || c.origin === this.storageOrigin) done();
      });
      const stopSynced = this.provider?.synced.subscribe((v) => {
        if (v) done();
      });
      // the server deleted the project: nothing comes from it
      const stopDeleted = this.provider?.status.subscribe((st) => {
        if (st === 'deleted') done();
      });
      this.disposers.push(
        () => stopSynced?.(),
        () => stopDeleted?.(),
      );
    });
  }

  projectInfo(): ProjectInfo {
    const meta = this.doc.getMeta();
    let vertices = 0;
    let faces = 0;
    for (const b of this.doc.listMeshBlocks()) {
      const c = this.doc.meshCounts(b.id);
      if (c) {
        vertices += c.vertices;
        faces += c.faces;
      }
    }
    let thumbnail: string | undefined;
    try {
      thumbnail = this.thumbnailProvider?.() ?? undefined;
    } catch {
      thumbnail = undefined;
    }
    return {
      id: this.id,
      name: meta.name,
      created_at: meta.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      schema_version: meta.schema_version,
      thumbnail,
      stats: { objects: this.doc.objectIds().length, vertices, faces },
    };
  }

  private scheduleIndexUpdate(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void localIndex
        .put({ ...this.projectInfo(), last_opened: new Date().toISOString() })
        .catch(() => undefined);
    }, 3000);
  }

  // ----------------------------------------------------------------- presence

  private setupPresence(): void {
    const p = prefs.value;
    this.awareness.setLocalState({
      user: { name: p.userName, color: p.userColor, kind: 'human' },
      device: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop',
      mode: this.state.mode,
      selection: [],
      active: null,
      frame: this.state.frame,
      capabilities: ['render', 'ui'],
    } satisfies PresenceState);
    const push = () => this.schedulePresence();
    for (const s of [
      this.state.$selectedIds,
      this.state.$activeId,
      this.state.$mode,
      this.state.$frame,
      this.state.$cursorLocation,
    ])
      this.disposers.push(s.subscribe(push));
  }

  schedulePresence(view?: PresenceState['view']): void {
    if (view) this.pendingView = view;
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const cur = (this.awareness.getLocalState() ?? {}) as PresenceState;
      const p = prefs.value;
      this.awareness.setLocalState({
        ...cur,
        user: { name: p.userName, color: p.userColor, kind: 'human' },
        mode: this.state.mode,
        selection: this.state.selectedIds,
        active: this.state.activeId,
        frame: this.state.frame,
        cursor3d: this.state.cursorLocation,
        ...(this.pendingView ? { view: this.pendingView } : {}),
      });
      this.pendingView = undefined;
    }, 120);
  }
  private pendingView: PresenceState['view'] | undefined;

  /**
   * Publishes the other clients' presences when they changed. Awareness also reports changes of this
   * client's own presence (sent with every frame change, selection and view move): those leave
   * `peers` as it is, so what depends on it (the viewport's peer boxes) is not redrawn for nothing.
   */
  private refreshPeers(): void {
    const out: PeerInfo[] = [];
    for (const [clientId, st] of this.awareness.getStates()) {
      if (clientId === this.doc.ydoc.clientID) continue;
      const state = st as PresenceState;
      if (state?.user) out.push({ clientId, state });
    }
    const prev = this.peers.value;
    if (
      prev.length === out.length &&
      prev.every((p, i) => p.clientId === out[i].clientId && p.state === out[i].state)
    )
      return;
    this.peers.value = out;
  }

  /** Approximate scene complexity for status bar / telemetry. */
  sceneStats(): { objects: number; vertices: number; faces: number; triangles: number } {
    let vertices = 0;
    let faces = 0;
    let triangles = 0;
    const ev = this.evaluator.evaluate(this.state.frame, {
      editObjectId: this.state.mode === 'EDIT' ? this.state.activeId : null,
    });
    for (const o of ev.objects) {
      if (!o.mesh || !o.visible) continue;
      const s = meshStats(o.mesh);
      vertices += s.vertices;
      faces += s.faces;
      triangles += s.triangles;
    }
    return { objects: ev.objects.length, vertices, faces, triangles };
  }

  /**
   * Saves now (Save, Ctrl+S): to WebDAV, also a project another device deleted from WebDAV (the
   * browser's IndexedDB copy saves continuously), and connects to the server again when the server
   * had deleted the project (see SyncProvider.reconnect). Resolves with what to tell the person.
   */
  async flush(): Promise<SaveReport> {
    const report: SaveReport = this.webdav
      ? await this.webdav.save()
      : { message: 'Saved in this browser', level: 'info' };
    this.provider?.reconnect();
    return report;
  }

  /**
   * Closes the project; `flush`: sync it to WebDAV a last time first. Resolves once WebDAV syncing
   * has stopped (a sync that was running has finished).
   */
  close(flush = true): Promise<void> {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    const stopped = this.webdav?.stop(flush) ?? Promise.resolve();
    this.provider?.destroy();
    void this.idb?.destroy();
    this.undo.destroy();
    this.doc.destroy();
    return stopped;
  }

  /** Removes all locally stored data of this project (IndexedDB). */
  static async deleteLocal(id: string): Promise<void> {
    const p = new IndexeddbPersistence(projectDbName(id), new Y.Doc());
    await p.whenSynced;
    await p.clearData();
    await localIndex.remove(id);
  }
}
