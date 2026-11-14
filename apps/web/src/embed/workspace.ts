import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  briefChanges,
  briefRecord,
  getShots,
  type BriefChanges,
  type DeskCheckResult,
  type SceneBrief,
  type ShotResultMeta,
} from '@3d-editor/core';
import { session as sessionSignal } from '../app/store';
import { projectDbName } from '../project/local-index';
import { ProjectSession } from '../project/session';
import { lastCheck } from '../ui/director/state';
import {
  DESK_STATE_FORMAT,
  DESK_STATE_VERSION,
  briefShotFrames,
  stateBytes,
  type DeskState,
  type GivenState,
  type OpenSource,
} from './protocol';
import {
  StateUnreadable,
  decodeDeskState,
  encodeDeskState,
  newLineage,
  readLineage,
  restorePlan,
  type DecodedState,
  type RestorePlan,
} from './state';
import { StagingClient } from './staging';

/*
 * The desk's scene (docs/embedding.md, "What the desk does"): the project of one host scene in this
 * browser, opened from the host's state, the local copy or the brief, and the work done on it off
 * the main thread (staging, updates, results, checks).
 *
 * - The project lives in the browser's IndexedDB under a local id derived from the host's origin and
 *   the scene id (deskProjectId), so each host and scene has its own; where the browser blocks
 *   storage it lives in memory only (the host's state is the authoritative copy anyway). Storage
 *   that fails after the probe (its database does not open, does not answer within
 *   STORAGE_TIMEOUT_MS, or refuses a write) is left for memory too, with the local copy read but
 *   never written, and the person is told (OpenOutcome.notice): opening never hangs on it.
 * - One desk per host and scene in this browser: the desk holds a Web Lock named after the project
 *   while the scene is open, and a second desk (another tab or frame) waits for it with a notice,
 *   so it never throws away the database under the first one.
 * - Opening follows the merge rule (state.ts restorePlan): a host state from the same staging as the
 *   local copy is merged into it, any other readable state replaces it; without a state the local
 *   copy is used, else the brief is staged (in the staging worker). A state that does not read
 *   (decodeDeskState checks that it holds a staging of the scene before the plan is chosen) is not
 *   applied and never touches the local copy: the desk goes on as without one and says so
 *   (state_unreadable).
 * - The state goes out as the same bytes while the scene does not change: the bytes the scene
 *   opened from (when nothing of the local copy was added to them) or last written are kept with
 *   what the document held then (Y.snapshot), and sent again as they are.
 * - The staging is applied to the session's document in one transaction that undo does not track
 *   (it is where the scene starts); an update from a later brief is one undo step.
 * - Checks shown in the shot list carry the document's revision when they were asked for (an edit
 *   made while the worker checks shows them as out of date); after the scene opens and after
 *   Update shots the full checks (blocking lines, layouts) run in the background.
 */

/** The local project id of a host's scene: a digest of the host's origin and the scene id. */
export function deskProjectId(hostOrigin: string, sceneId: string): string {
  return `desk-${bytesToHex(sha256(new TextEncoder().encode(`${hostOrigin}\n${sceneId}`))).slice(0, 32)}`;
}

/** Whether IndexedDB works here (a blocked context throws or never answers). */
export async function indexedDbUsable(timeoutMs = 3000): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      const req = indexedDB.open('3d-editor-desk-probe', 1);
      req.onsuccess = () => {
        req.result.close();
        done(true);
      };
      req.onerror = () => done(false);
      req.onblocked = () => done(true);
    } catch {
      done(false);
    }
  });
}

/**
 * The document y-indexeddb keeps in database `name`, read without writing (none is made where there
 * is none): null when there is none, it does not read, or it does not answer within `ms`.
 */
export function readStoredCopy(name: string, ms: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Uint8Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch {
      return finish(null);
    }
    // no such database: it is not made (the open fails)
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => finish(null);
    req.onsuccess = () => {
      const db = req.result;
      if (done || !db.objectStoreNames.contains('updates')) {
        db.close();
        return finish(null);
      }
      try {
        const get = db.transaction('updates', 'readonly').objectStore('updates').getAll();
        get.onsuccess = () => {
          db.close();
          const doc = new Y.Doc();
          try {
            Y.transact(doc, () => {
              for (const u of get.result as unknown[]) if (u instanceof Uint8Array) Y.applyUpdate(doc, u);
            });
            finish(doc.store.clients.size ? Y.encodeStateAsUpdate(doc) : null);
          } catch {
            finish(null);
          } finally {
            doc.destroy();
          }
        };
        get.onerror = () => {
          db.close();
          finish(null);
        };
      } catch {
        db.close();
        finish(null);
      }
    };
  });
}

/** The part of the Web Locks API the workspace uses (navigator.locks; tests give their own). */
export interface SceneLocks {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

/** The browser's Web Locks (null where there are none: not a secure context, or an old browser). */
function browserLocks(): SceneLocks | null {
  const n = typeof navigator !== 'undefined' ? (navigator as { locks?: unknown }) : null;
  return n?.locks ? (n.locks as SceneLocks) : null;
}

/** How long the scene's database may take to open (or clear) before the desk keeps it in memory. */
export const STORAGE_TIMEOUT_MS = 10_000;

/** What the desk shows while another desk of this browser has the scene open. */
export const OTHER_DESK_WAIT =
  'This scene is open in another tab or window of this browser. The desk opens it here as soon as it is closed there.';

/** What opening a scene did. */
export interface OpenOutcome {
  source: OpenSource;
  changes: BriefChanges | null;
  /** Why the host's state was not applied (null: there was none, or it was applied). */
  unreadable: string | null;
  plan: RestorePlan;
  /** Milliseconds the staging took in the worker (null: nothing was staged). */
  stageMs: number | null;
  /** Whether the project is kept in IndexedDB (false: memory only). */
  persistent: boolean;
  /** What the person should be told about where the scene is kept (storage that failed). */
  notice?: string | null;
}

/** A brief shot whose length in the desk differs from the brief's. */
export interface LengthMismatch {
  shotId: string;
  name: string;
  deskFrames: number;
  briefFrames: number;
}

/** What the desk is busy with (shown with its progress). */
export interface WorkProgress {
  label: string;
  startedAt: number;
}

/** The scene's session, and whether it is kept in IndexedDB. */
interface Stored {
  session: ProjectSession;
  persistent: boolean;
}

/** State bytes kept to be sent again while the document still holds what `snapshot` says. */
interface Kept {
  session: ProjectSession;
  snapshot: Y.Snapshot;
  bytes: Uint8Array;
  shots: number;
}

const DESK_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const GENERATOR = `3d-editor-desk ${DESK_VERSION}`;

export interface WorkspaceOptions {
  /** The scenes' locks (default navigator.locks; null: none). */
  locks?: SceneLocks | null;
  /** How long storage may take before the desk keeps the scene in memory (STORAGE_TIMEOUT_MS). */
  storageTimeoutMs?: number;
}

export class DeskWorkspace {
  session: ProjectSession | null = null;
  /** The latest check of the scene running in the background (tests wait for it). */
  backgroundCheck: Promise<void> = Promise.resolve();
  private brief: SceneBrief | null = null;
  private persistent: boolean | null = null;
  private kept: Kept | null = null;
  /** What the open tells the person about storage (see OpenOutcome.notice). */
  private notice: string | null = null;
  /** Lets go of the scene's lock. */
  private release: (() => void) | null = null;
  /** A wait for another desk's lock (aborted when this desk closes). */
  private waiting: AbortController | null = null;
  private readonly locks: SceneLocks | null;
  private readonly storageTimeoutMs: number;

  constructor(
    readonly staging: StagingClient = new StagingClient(),
    private readonly onWork: (w: WorkProgress | null) => void = () => {},
    opts: WorkspaceOptions = {},
  ) {
    this.locks = opts.locks === undefined ? browserLocks() : opts.locks;
    this.storageTimeoutMs = opts.storageTimeoutMs ?? STORAGE_TIMEOUT_MS;
  }

  private async storage(): Promise<boolean> {
    this.persistent ??= await indexedDbUsable();
    return this.persistent;
  }

  private async openSession(id: string, persist: boolean): Promise<ProjectSession> {
    const s = await ProjectSession.open(id, { persist });
    s.undo.clear();
    return s;
  }

  /** `p`, or a rejection once it takes longer than the storage timeout (`late` gets what comes after). */
  private bounded<T>(p: Promise<T>, late?: (v: T) => void): Promise<T> {
    const ms = this.storageTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let over = false;
      const timer = setTimeout(() => {
        over = true;
        reject(new Error(`it did not answer within ${Math.max(1, Math.round(ms / 1000))} s`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          if (over) late?.(v);
          else resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (!over) reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** The scene's session in IndexedDB (rejects when its database fails, or does not answer in time). */
  private openPersistent(id: string): Promise<ProjectSession> {
    // y-indexeddb's open never settles when the database does not open: bounded here, and a
    // session that opens after all is let go
    return this.bounded(this.openSession(id, true), (late) => void late.close(false));
  }

  /**
   * Storage failed after the probe: the scene is kept in memory from now on, the person told why,
   * and the local copy read (never written) when `readCopy` and it reads.
   */
  private async inMemory(id: string, err: unknown, readCopy: boolean): Promise<Stored> {
    this.persistent = false;
    const why = err instanceof Error ? err.message || err.name : String(err);
    this.notice = `The desk could not use this browser's storage (${why}), so it keeps this scene in memory only: the host still gets its state, but this browser keeps no copy of it.`;
    const session = await this.openSession(id, false);
    if (readCopy) {
      const copy = await readStoredCopy(projectDbName(id), this.storageTimeoutMs);
      if (copy) Y.applyUpdate(session.doc.ydoc, copy, session.storageOrigin);
    }
    return { session, persistent: false };
  }

  /** Opens the scene's session: in IndexedDB where it works, else in memory. */
  private async openStored(id: string): Promise<Stored> {
    if (!(await this.storage())) return { session: await this.openSession(id, false), persistent: false };
    try {
      return { session: await this.openPersistent(id), persistent: true };
    } catch (err) {
      return this.inMemory(id, err, true);
    }
  }

  /** Throws away the local copy of project `id` and opens it empty. */
  private async resetStored(stored: Stored, id: string): Promise<Stored> {
    await stored.session.close(false);
    if (!stored.persistent) return { session: await this.openSession(id, false), persistent: false };
    try {
      await this.bounded(ProjectSession.deleteLocal(id));
      return { session: await this.openPersistent(id), persistent: true };
    } catch (err) {
      // the old copy stays where it is (unread): the scene starts empty in memory
      return this.inMemory(id, err, false);
    }
  }

  /**
   * Holds the scene's lock while it is open here (one desk per host and scene in this browser):
   * waits, saying so, while another desk holds it. Resolves with what lets go of it.
   */
  private async lockScene(id: string): Promise<() => void> {
    const locks = this.locks;
    if (!locks) return () => {};
    const name = `3d-editor-desk:${id}`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const take = (options: { ifAvailable?: boolean; signal?: AbortSignal }) =>
      new Promise<boolean>((resolve, reject) => {
        locks
          .request(name, options, (lock) => {
            resolve(!!lock);
            return lock ? held : undefined;
          })
          .catch(reject);
      });
    try {
      if (await take({ ifAvailable: true })) return release;
    } catch {
      // locks that do not work here (an opaque origin): as without them
      return () => {};
    }
    const waiting = new AbortController();
    this.waiting = waiting;
    this.onWork({ label: OTHER_DESK_WAIT, startedAt: Date.now() });
    try {
      await take({ signal: waiting.signal });
      return release;
    } finally {
      if (this.waiting === waiting) this.waiting = null;
      this.onWork(null);
    }
  }

  private stagedHere(s: ProjectSession, sceneId: string): boolean {
    return briefRecord(s.doc)?.sceneId === sceneId;
  }

  private async stage(s: ProjectSession, brief: SceneBrief): Promise<number> {
    this.onWork({
      label: `Staging ${brief.shots.length} shot${brief.shots.length === 1 ? '' : 's'}…`,
      startedAt: Date.now(),
    });
    try {
      const r = await this.staging.stage(Y.encodeStateAsUpdate(s.doc.ydoc), brief, newLineage(), GENERATOR);
      Y.applyUpdate(s.doc.ydoc, r.diff, s.storageOrigin);
      // nobody edits the scene before it opens: the checks are of the document as it is now
      this.keepCheck(s, r.check, s.revision.peek());
      return r.ms;
    } finally {
      this.onWork(null);
    }
  }

  /**
   * Shows checks in the shot list (as a Check would), as of revision `revision` of the document
   * (the shot list shows them as out of date once it has another); never over a later check.
   */
  private keepCheck(s: ProjectSession, check: DeskCheckResult, revision: number): void {
    const now = lastCheck.peek();
    if (now?.session === s && now.revision > revision) return;
    lastCheck.value = { session: s, revision, result: check };
  }

  /** Lets go of the open scene (its session and its lock). */
  private letGo(): void {
    const s = this.session;
    this.session = null;
    this.kept = null;
    if (s && sessionSignal.peek() === s) sessionSignal.value = null;
    void s?.close(false);
    this.release?.();
    this.release = null;
  }

  /** Opens the scene of `brief` for `hostOrigin` (see the module comment). */
  async open(o: { hostOrigin: string; brief: SceneBrief; state: GivenState | null }): Promise<OpenOutcome> {
    const { brief } = o;
    this.letGo();
    this.brief = brief;
    const id = deskProjectId(o.hostOrigin, brief.id);
    let unreadable: string | null = null;
    let decoded: DecodedState | null = null;
    if (o.state) {
      try {
        decoded = await decodeDeskState(o.state, brief.id);
      } catch (err) {
        unreadable =
          err instanceof StateUnreadable ? err.message : `the desk state does not read (${String(err)})`;
      }
    }
    // one desk per host and scene in this browser: another one waits until this one lets go
    const release = await this.lockScene(id);
    this.notice = null;
    let s: ProjectSession | null = null;
    try {
      this.onWork({ label: 'Opening the scene…', startedAt: Date.now() });
      let stored: Stored;
      try {
        stored = await this.openStored(id);
      } finally {
        this.onWork(null);
      }
      s = stored.session;
      const plan = restorePlan(decoded && { lineage: decoded.lineage }, {
        staged: this.stagedHere(s, brief.id),
        lineage: readLineage(s.doc),
      });
      if (plan === 'replace' || (plan === 'stage' && s.doc.ydoc.store.clients.size > 0)) {
        const old = stored;
        s = null;
        stored = await this.resetStored(old, id);
        s = stored.session;
      }
      let kept: Omit<Kept, 'session'> | null = null;
      if ((plan === 'merge' || plan === 'replace') && decoded && o.state) {
        Y.applyUpdate(s.doc.ydoc, decoded.update, s.storageOrigin);
        // nothing of the local copy came in: the scene is the host's state, whose very bytes go
        // back while it does not change
        if (Y.equalSnapshots(Y.snapshot(s.doc.ydoc), decoded.snapshot))
          kept = {
            snapshot: decoded.snapshot,
            bytes: stateBytes(o.state).slice(),
            shots: getShots(s.doc).length,
          };
      }
      let stageMs: number | null = null;
      if (plan === 'stage') stageMs = await this.stage(s, brief);
      s.undo.clear();
      this.session = s;
      this.release = release;
      this.kept = kept && { session: s, ...kept };
      sessionSignal.value = s;
      const source: OpenSource = plan === 'stage' ? 'brief' : plan === 'local' ? 'local' : 'state';
      const changes = source === 'brief' ? null : briefChanges(s.doc, brief);
      // the full checks (blocking lines, layouts) of the scene as it opened, in the background
      void this.refreshCheck();
      return {
        source,
        changes,
        unreadable,
        plan,
        stageMs,
        persistent: stored.persistent,
        notice: this.notice,
      };
    } catch (err) {
      await s?.close(false).catch(() => undefined);
      release();
      throw err;
    }
  }

  /** Runs the checks of the scene as it is now in the worker and shows them in the shot list. */
  refreshCheck(): Promise<void> {
    const s = this.session;
    if (!s) return Promise.resolve();
    // stamped with the revision of the document checked: an edit made meanwhile shows them as old
    const revision = s.revision.peek();
    const update = Y.encodeStateAsUpdate(s.doc.ydoc);
    const run = (async () => {
      try {
        const r = await this.staging.check(update);
        if (this.session === s) this.keepCheck(s, r.check, revision);
      } catch {
        // the shot list's Check button runs them again
      }
    })();
    this.backgroundCheck = run;
    return run;
  }

  /** A snapshot of the scene (what an export renders). */
  snapshot(): Uint8Array {
    if (!this.session) throw new Error('no scene is open');
    return Y.encodeStateAsUpdate(this.session.doc.ydoc);
  }

  /**
   * The scene's desk state: the bytes it opened from or last wrote while the document holds the
   * same, else written anew. Throws StateTooLarge over 64 MiB (or a document over 256 MiB).
   */
  async encodeState(): Promise<{ state: DeskState; shots: number }> {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) throw new Error('no scene is open');
    const snapshot = Y.snapshot(s.doc.ydoc);
    const kept = this.kept;
    // each state gets its own buffer: the controller hands it over (transfers it)
    if (kept && kept.session === s && Y.equalSnapshots(kept.snapshot, snapshot))
      return {
        state: { format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, data: kept.bytes.slice().buffer },
        shots: kept.shots,
      };
    const shots = getShots(s.doc).length;
    const state = await encodeDeskState(Y.encodeStateAsUpdate(s.doc.ydoc), {
      sceneId: brief.id,
      lineage: readLineage(s.doc) ?? 'none',
      shots,
      deskVersion: DESK_VERSION,
    });
    if (this.session === s)
      this.kept = { session: s, snapshot, bytes: new Uint8Array(state.data.slice(0)), shots };
    return { state, shots };
  }

  /** Calls `cb` after every change of the scene from now on; returns the unsubscribe. */
  onEdit(cb: () => void): () => void {
    const s = this.session;
    if (!s) return () => {};
    const handler = () => cb();
    s.doc.ydoc.on('update', handler);
    return () => s.doc.ydoc.off('update', handler);
  }

  /** The host's shot ids staged in the scene, in brief order. */
  stagedShots(): string[] {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) return [];
    const staged = new Set(
      getShots(s.doc)
        .filter((x) => x.external?.source === 'host' && x.external.clip === brief.id && x.external.shot)
        .map((x) => x.external!.shot!),
    );
    return brief.shots.map((b) => b.id).filter((id) => staged.has(id));
  }

  /** The brief's shots whose length in the desk differs from the brief's (their clips are refused). */
  lengthMismatches(): LengthMismatch[] {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) return [];
    const desk = new Map(
      getShots(s.doc)
        .filter((x) => x.external?.source === 'host' && x.external.clip === brief.id && x.external.shot)
        .map((x) => [x.external!.shot!, x]),
    );
    const out: LengthMismatch[] = [];
    for (const b of brief.shots) {
      const d = desk.get(b.id);
      if (!d) continue;
      const deskFrames = d.frame_end - d.frame_start + 1;
      const briefFrames = briefShotFrames(b.durationSec, brief.fps);
      if (deskFrames !== briefFrames) out.push({ shotId: b.id, name: d.name, deskFrames, briefFrames });
    }
    return out;
  }

  /** How the brief differs from what the scene was staged from (null: it agrees). */
  changes(): BriefChanges | null {
    const s = this.session;
    const brief = this.brief;
    return s && brief ? briefChanges(s.doc, brief) : null;
  }

  /**
   * Updates the staging to the brief (desk.update_from_brief in the worker), applied as one undo
   * step; the changes left (null when the scene agrees with the brief now).
   */
  async updateFromBrief(): Promise<BriefChanges | null> {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) throw new Error('no scene is open');
    this.onWork({ label: `Updating ${brief.shots.length} shots from the brief…`, startedAt: Date.now() });
    try {
      const asked = s.revision.peek();
      const r = await this.staging.update(Y.encodeStateAsUpdate(s.doc.ydoc), brief);
      // the worker's checks are of the document it got plus its change: current only when nothing
      // else changed the scene meanwhile (else shown as out of date until the next check)
      const edited = s.revision.peek() !== asked;
      s.undo.stopCapturing();
      Y.applyUpdate(s.doc.ydoc, r.diff, s.doc.origin);
      s.undo.stopCapturing();
      this.keepCheck(s, r.check, edited ? asked : s.revision.peek());
      // the full checks (blocking lines, layouts) of the updated scene, in the background
      void this.refreshCheck();
      return briefChanges(s.doc, brief);
    } finally {
      this.onWork(null);
    }
  }

  /** The shot results of a snapshot (host shot ids, brief order), from the worker. */
  async results(update: Uint8Array, shots?: string[]): Promise<ShotResultMeta[]> {
    return (await this.staging.results(update, shots)).results;
  }

  /** The scene's name (the brief's). */
  get sceneName(): string {
    return this.brief?.name ?? '';
  }

  /** The local project id of the open scene. */
  get projectId(): string | null {
    return this.session?.id ?? null;
  }

  /** Lets go of the scene and its lock (a wait for another desk's lock ends). */
  close(): void {
    this.waiting?.abort();
    this.letGo();
    this.staging.dispose();
  }
}
