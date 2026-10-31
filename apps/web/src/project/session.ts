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
import { WebDAVSync, resolveWebDAV } from '../storage/webdav';
import { localIndex, projectDbName } from './local-index';
import { prefs } from '../app/prefs';
import { serverConfig } from '../app/store';
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

  private constructor(readonly id: string) {
    this.doc = new SceneDoc(new Y.Doc(), { type: 'local' });
    this.awareness = new Awareness(this.doc.ydoc);
    this.undo = new Y.UndoManager(this.doc.sharedTypes(), { trackedOrigins: new Set([this.doc.origin]), captureTimeout: 0 });
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

  static async open(id: string, opts: { initial?: SceneDoc; name?: string } = {}): Promise<ProjectSession> {
    const span = telemetry.startSpan('project.open', { 'project.new': !!opts.initial });
    const s = new ProjectSession(id);
    try {
      s.idb = new IndexeddbPersistence(projectDbName(id), s.doc.ydoc);
      await s.idb.whenSynced;
      if (opts.initial) Y.applyUpdate(s.doc.ydoc, opts.initial.encodeState(), s.storageOrigin);
      s.setupPresence();
      const cfg = serverConfig.value;
      if (cfg?.features.sync && prefs.value.sync.enabled) {
        s.provider = new SyncProvider(id, s.doc.ydoc, s.awareness, () => wsUrl(`/sync/${id}`));
      } else {
        s.provider = new SyncProvider(id, s.doc.ydoc, s.awareness, null);
      }
      const target = resolveWebDAV();
      if (target) {
        s.webdav = new WebDAVSync(target, id, s.doc, () => s.projectInfo(), s.storageOrigin);
        // Do not block opening on the network; merge in the background.
        void s.webdav.syncNow();
      }
      // If nothing exists locally yet (opening a remote project on a fresh device), wait briefly for
      // the server/WebDAV so the UI does not flash an empty scene.
      if (!opts.initial && s.doc.listObjects().length === 0 && s.doc.getMeta().created_at === '') {
        await s.waitForRemote(4000);
      }
      if (opts.name && !s.doc.getMeta().created_at) s.doc.setName(opts.name);
      await localIndex.put({ ...s.projectInfo(), last_opened: new Date().toISOString() });
      span.setAttribute('scene.objects', s.doc.objectIds().length).setOk();
      return s;
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      s.close(false);
      throw err;
    } finally {
      span.end();
    }
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
      this.disposers.push(() => stopSynced?.());
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
      void localIndex.put({ ...this.projectInfo(), last_opened: new Date().toISOString() }).catch(() => undefined);
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
    for (const s of [this.state.$selectedIds, this.state.$activeId, this.state.$mode, this.state.$frame, this.state.$cursorLocation])
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

  private refreshPeers(): void {
    const out: PeerInfo[] = [];
    for (const [clientId, st] of this.awareness.getStates()) {
      if (clientId === this.doc.ydoc.clientID) continue;
      const state = st as PresenceState;
      if (state?.user) out.push({ clientId, state });
    }
    this.peers.value = out;
  }

  /** Approximate scene complexity for status bar / telemetry. */
  sceneStats(): { objects: number; vertices: number; faces: number; triangles: number } {
    let vertices = 0;
    let faces = 0;
    let triangles = 0;
    const ev = this.evaluator.evaluate(this.state.frame, { editObjectId: this.state.mode === 'EDIT' ? this.state.activeId : null });
    for (const o of ev.objects) {
      if (!o.mesh || !o.visible) continue;
      const s = meshStats(o.mesh);
      vertices += s.vertices;
      faces += s.faces;
      triangles += s.triangles;
    }
    return { objects: ev.objects.length, vertices, faces, triangles };
  }

  async flush(): Promise<void> {
    await this.webdav?.syncNow();
  }

  close(flush = true): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    void this.webdav?.stop(flush);
    this.provider?.destroy();
    void this.idb?.destroy();
    this.undo.destroy();
    this.doc.destroy();
  }

  /** Removes all locally stored data of this project (IndexedDB). */
  static async deleteLocal(id: string): Promise<void> {
    const p = new IndexeddbPersistence(projectDbName(id), new Y.Doc());
    await p.whenSynced;
    await p.clearData();
    await localIndex.remove(id);
  }
}
