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
  type ProjectFileStore,
  type ProjectInfo,
  type ProjectMeta,
  type SelectionJSON,
  type WriteOptions,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../editor/state';
import { SyncProvider } from '../sync/provider';
import { WebDAVSync, resolveWebDAV, type SaveReport, type WebDAVTarget } from '../storage/webdav';
import { localIndex, projectDbName } from './local-index';
import { prefs } from '../app/prefs';
import { serverConfig, toast } from '../app/store';
import { apiUrl, authHeaders, wsUrl } from '../app/server-config';
import { telemetry } from '../telemetry/telemetry';

/**
 * What this browser does with a project the server deleted (SyncProvider status `deleted`), as the
 * toast says it once (ProjectSession.tellWhenDeletedOnServer) and the status bar's tooltip while it
 * lasts. `viaServer`: WebDAV through the server, which is the server's storage: a change or Save
 * stores the project there again, and the server opens it again (ProjectSession.followServerStorage).
 */
export function deletedOnServerNote(viaServer: boolean): string {
  return viaServer
    ? 'This browser keeps its copy and stores it on the server again when you change it or save (Ctrl+S).'
    : 'This browser keeps its copy and no longer syncs it with the server.';
}

/**
 * What this browser does with a project whose changes the server did not take for memory
 * (SyncProvider status `refused`), after the server's reason (SyncProvider.refusal), as the toast
 * says it once (ProjectSession.tellWhenDeletedOnServer) and the status bar's tooltip while it lasts.
 * `viaServer`: WebDAV through the server, which is the server's storage: it gets nothing of the
 * project either until the server took its changes (ProjectSession.guardServerStorage).
 */
export function refusedOnServerNote(viaServer: boolean): string {
  return viaServer
    ? 'This browser keeps the project with your changes (in this browser and in its other tabs) and no longer ' +
        'syncs it with the server, nor saves it to WebDAV through the server; Save (Ctrl+S) or a reload sends ' +
        'it to the server again.'
    : 'This browser keeps the project with your changes (in this browser, in its other tabs and in WebDAV when ' +
        'it saves there) and no longer syncs it with the server; Save (Ctrl+S) or a reload sends it to the ' +
        'server again.';
}

/**
 * What this browser does with a stored project the server cannot load for memory (SyncProvider
 * status `refused`, SyncRefusal.load), after the server's reason, which names the project.
 */
export const LOAD_REFUSED_NOTE =
  'This browser shows what it holds of the project (in this browser, or from WebDAV) and does not sync it ' +
  'with the server; Save (Ctrl+S) or a reload asks the server to open it again.';

/**
 * How long a write of WebDAV through the server waits at most for the server to answer that it
 * holds what the write stores (ProjectSession.guardServerStorage), ms.
 */
export const SERVER_HOLDS_WAIT_MS = 20_000;

/**
 * Projects whose changes the editor server did not take for memory, until it answered that it holds
 * this browser's state again: their writes to WebDAV through that server wait for that answer, also
 * in other tabs and after a reload (localStorage, which all tabs share; nothing is kept where it is
 * blocked).
 */
export const refusedOnServer = {
  key: (projectId: string) => `3d-editor:refused-on-server:${projectId}`,
  has(projectId: string): boolean {
    try {
      return localStorage.getItem(this.key(projectId)) !== null;
    } catch {
      return false;
    }
  },
  set(projectId: string, refused: boolean): void {
    try {
      if (refused) localStorage.setItem(this.key(projectId), new Date().toISOString());
      else localStorage.removeItem(this.key(projectId));
    } catch {
      /* storage blocked */
    }
  },
};

/**
 * Why a write of WebDAV through the server did not happen (see ProjectSession.serverTakes), in the
 * words WebDAV's status and Save say it: "Not saved to WebDAV (…). The project is saved in this
 * browser."
 */
const NOT_TAKEN =
  "the server did not take this project's changes, so WebDAV through it gets them only once it does";
const NOT_CONFIRMED = `the server did not answer within ${SERVER_HOLDS_WAIT_MS / 1000} s that it took this project's changes`;

/**
 * The toast of a refusal for memory (SyncProvider status `refused`): the project's title and the
 * server's reason for changes it did not take; the reason alone, which names the project, for a
 * stored project it cannot load (the browser may hold nothing of it, and no name).
 */
export function refusedToast(
  title: string,
  refusal: { message: string; load: boolean } | null,
  viaServer: boolean,
): string {
  if (refusal?.load) return `The server did not open this project: ${refusal.message}. ${LOAD_REFUSED_NOTE}`;
  const why = refusal ? `: ${refusal.message}.` : '.';
  return `"${title}" is not synced with the server${why} ${refusedOnServerNote(viaServer)}`;
}

export interface PeerInfo {
  clientId: number;
  state: PresenceState;
}

/** How long after a change of the document its entry in the local project list is written (ms). */
export const INDEX_UPDATE_MS = 3000;
/** How often the entry asks the viewport again for a thumbnail of the latest changes (ms). */
export const THUMBNAIL_RETRY_MS = 500;
/** How long after a change the entry waits at most for that thumbnail (ms); then it keeps the last one. */
export const THUMBNAIL_WAIT_MS = 30_000;

/**
 * The scene of a session: while its document has no name, its name is the stored one
 * (`storedName`, ProjectSession.storedName), wherever the editor reads it (the title, the Scene
 * tab's Project name, the names of files it renders and exports, its messages, projectInfo). Like
 * the server's rooms (Room.scene), it writes no name into the document for it: a new name item
 * would be a concurrent write of the name, which a rename made elsewhere in a copy of the full
 * document could lose to when the two merge (concurrent sets of one Y.Map key are resolved by client
 * id). Reading the name in a component or a computed signal subscribes to the stored name.
 */
class SessionScene extends SceneDoc {
  constructor(
    ydoc: Y.Doc,
    origin: object,
    private readonly storedName: () => string | null,
  ) {
    super(ydoc, origin);
  }

  override getMeta(): ProjectMeta {
    const meta = super.getMeta();
    if (this.map('meta').has('name')) return meta;
    const stored = this.storedName();
    return stored ? { ...meta, name: stored } : meta;
  }
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
  /**
   * The project's name in storage (its project.json, as the server or WebDAV has it) while its
   * document has no name: a project stored as a project.json without a document has an empty
   * document without a name until someone gives it one (the server writes no name into it, and nor
   * does this browser: a rename in a copy of the full document could lose to that write when they
   * merge). It is the document's name meanwhile (see SessionScene), and saves keep it in
   * project.json (projectInfo).
   */
  readonly storedName = signal<string | null>(null);
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
  /** The person was told that the server did not take the changes for memory (same). */
  private refusalTold = false;

  private constructor(readonly id: string) {
    this.doc = new SessionScene(new Y.Doc(), { type: 'local' }, () => this.storedName.value);
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
      // the thumbnail the local project list has, kept until the viewport gives one
      s.lastThumbnail = (await localIndex.get(id).catch(() => undefined))?.thumbnail;
      if (opts.initial) Y.applyUpdate(s.doc.ydoc, opts.initial.encodeState(), s.storageOrigin);
      s.setupPresence();
      s.provider = new SyncProvider(id, s.doc.ydoc, s.awareness, null);
      s.tellWhenDeletedOnServer(s.provider);
      s.askServerForStoredName(s.provider);
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
          target.viaServer ? this.guardServerStorage(target) : target,
          this.id,
          this.doc,
          () => this.projectInfo(),
          this.storageOrigin,
        );
        this.webdav = webdav;
        this.disposers.push(
          webdav.storedName.subscribe((name) => {
            if (name !== null) this.useStoredName(name);
          }),
        );
        if (target.viaServer) this.followServerStorage(webdav);
        // Do not block opening on the network; merge in the background.
        void webdav.syncNow();
      }
    }
  }

  /**
   * WebDAV through the editor server writes into the server's storage, whose project its rooms read
   * and other editors sync with: a document the server's sync did not take for memory must not get
   * there (another browser's WebDAV sync would bring it to the server again, which would refuse that
   * browser too, and the room would not merge it). So a write of the project's document waits until
   * the server answered that it holds what the write stores ({@link serverTakes}).
   */
  private guardServerStorage(target: WebDAVTarget): WebDAVTarget {
    const { store } = target;
    const docPath = store.docPath(this.id);
    const fs = new Proxy(store.fs, {
      get: (fsTarget, prop) => {
        if (prop === 'write')
          return async (path: string, data: Uint8Array, opts?: WriteOptions) => {
            if (path === docPath) await this.serverTakes(data);
            return fsTarget.write(path, data, opts);
          };
        const value: unknown = Reflect.get(fsTarget, prop, fsTarget);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(fsTarget) : value;
      },
    });
    return { ...target, store: Object.create(store, { fs: { value: fs } }) as ProjectFileStore };
  }

  /**
   * Resolves when WebDAV through the server may store `data` (a state of the project's document),
   * throws why not. While the sync connection is open: once the server answered that it holds all
   * of it (SyncProvider.serverHolds, at most {@link SERVER_HOLDS_WAIT_MS}). Never while the server
   * does not take this browser's changes (status `refused`), and after such a refusal (also in a
   * page loaded again: refusedOnServer) only once it answered so. As before without live sync, while
   * the connection is not open in a browser the server never refused, and for a project the server
   * deleted or cannot load.
   */
  private async serverTakes(data: Uint8Array): Promise<void> {
    const provider = this.provider;
    if (!provider?.enabled) return;
    const changesRefused = () => provider.status.value === 'refused' && !provider.refusal.value?.load;
    if (changesRefused()) throw new Error(NOT_TAKEN);
    const st = provider.status.value;
    const waits = st === 'connecting' || st === 'offline' ? refusedOnServer.has(this.id) : st === 'connected';
    if (!waits) return;
    if (await provider.serverHolds(Y.encodeStateVectorFromUpdate(data), SERVER_HOLDS_WAIT_MS)) {
      refusedOnServer.set(this.id, false);
      return;
    }
    throw new Error(changesRefused() ? NOT_TAKEN : NOT_CONFIRMED);
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
        if (joined) {
          this.deletionTold = false;
          this.refusalTold = false;
          // a room takes this browser's state again: once it holds all of it, WebDAV through the
          // server writes as it did before the refusal
          if (refusedOnServer.has(this.id))
            void provider
              .serverHolds(Y.encodeStateVector(this.doc.ydoc), SERVER_HOLDS_WAIT_MS)
              .then((holds) => holds && refusedOnServer.set(this.id, false));
        }
      }),
      // the server did not take this browser's changes (or cannot load the project) for memory
      provider.status.subscribe((st) => {
        if (st !== 'refused') return;
        const refusal = provider.refusal.value;
        if (!refusal?.load) refusedOnServer.set(this.id, true);
        if (this.refusalTold) return;
        this.refusalTold = true;
        toast(refusedToast(this.title.value, refusal, !!this.webdav?.target.viaServer), 'warning', 20_000);
      }),
      provider.status.subscribe((st) => {
        if (st !== 'deleted' || this.deletionTold) return;
        this.deletionTold = true;
        const viaServer = !!this.webdav?.target.viaServer;
        if (viaServer && this.webdav?.status.value === 'deleted') return;
        toast(
          `"${this.title.value}" was deleted on the server. ${deletedOnServerNote(viaServer)}`,
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

  /** Whether the document has a name of its own (see {@link storedName}). */
  private named(): boolean {
    return this.doc.map('meta').has('name');
  }

  /**
   * Asks the server for the stored name of a project whose document has none (see
   * {@link storedName}) once the first sync with it is complete: GET /api/projects/<id> lists it
   * under the name in its project.json.
   */
  private askServerForStoredName(provider: SyncProvider): void {
    this.disposers.push(
      provider.synced.subscribe((synced) => {
        if (synced && !this.named() && this.storedName.value === null) void this.fetchStoredName();
      }),
    );
  }

  private async fetchStoredName(): Promise<void> {
    try {
      const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(this.id)}`), {
        headers: authHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return;
      const { name } = (await res.json()) as { name?: unknown };
      if (typeof name === 'string') this.useStoredName(name);
    } catch {
      /* the server is not reachable: the title stays the document's */
    }
  }

  /** Takes the stored name while the document has none (and the local project list with it). */
  private useStoredName(name: string): void {
    if (this.named() || this.storedName.value === name) return;
    this.storedName.value = name;
    this.scheduleIndexUpdate();
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
      // the server deleted the project, or refused it for memory: nothing comes from it
      const stopDeleted = this.provider?.status.subscribe((st) => {
        if (st === 'deleted' || st === 'refused') done();
      });
      this.disposers.push(
        () => stopSynced?.(),
        () => stopDeleted?.(),
      );
    });
  }

  /** The project's info, with a thumbnail of the viewport as it shows the project now when it can give one. */
  projectInfo(): ProjectInfo {
    this.takeThumbnail();
    return this.info();
  }

  /** The project's info, with the last thumbnail the viewport gave ({@link takeThumbnail}). */
  private info(): ProjectInfo {
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
    return {
      id: this.id,
      name: meta.name,
      created_at: meta.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      schema_version: meta.schema_version,
      thumbnail: this.lastThumbnail,
      stats: { objects: this.doc.objectIds().length, vertices, faces },
    };
  }

  /**
   * The last thumbnail the viewport gave (see {@link takeThumbnail}); at first the one the local
   * project list has (the viewport gives none before it drew a frame, and a hidden page draws none).
   */
  private lastThumbnail: string | undefined;

  /**
   * A thumbnail of the viewport as it shows the project now (`thumbnailProvider`,
   * ViewportEngine.thumbnail: the frame the viewport drew, scaled down), kept as the project's
   * thumbnail; null while the viewport has not drawn the latest changes, or has no viewport.
   */
  private takeThumbnail(): string | null {
    try {
      const t = this.thumbnailProvider?.() ?? null;
      if (t) this.lastThumbnail = t;
      return t;
    } catch {
      return null;
    }
  }

  /**
   * Writes the project's entry in the local index {@link INDEX_UPDATE_MS} after a change, with a
   * thumbnail of the viewport: while the viewport has not drawn the latest changes (the GPU can take
   * a second or more for a frame of a heavy scene), every {@link THUMBNAIL_RETRY_MS}, at most until
   * {@link THUMBNAIL_WAIT_MS} after the change, then with the thumbnail it gave last; with that one at
   * once while the page is hidden (it draws no frames then).
   */
  private scheduleIndexUpdate(): void {
    if (this.indexTimer) return;
    const since = Date.now();
    const update = () => {
      this.indexTimer = null;
      const fresh = this.takeThumbnail();
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (fresh === null && this.thumbnailProvider && !hidden && Date.now() - since < THUMBNAIL_WAIT_MS) {
        this.indexTimer = setTimeout(update, THUMBNAIL_RETRY_MS);
        return;
      }
      void localIndex.put({ ...this.info(), last_opened: new Date().toISOString() }).catch(() => undefined);
    };
    this.indexTimer = setTimeout(update, INDEX_UPDATE_MS);
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
   * had deleted the project or had not taken its changes for memory (see SyncProvider.reconnect).
   * Resolves with what to tell the person.
   */
  async flush(): Promise<SaveReport> {
    // after a refusal for memory, the server takes the project again first (WebDAV through it waits
    // for that); after a deletion, the save stores it again first (the server then opens it again)
    if (this.provider?.status.value === 'refused') this.provider.reconnect();
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
