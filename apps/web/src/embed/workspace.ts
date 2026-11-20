import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  briefChanges,
  briefRecord,
  docHasUnitInstances,
  getShots,
  pinKey,
  pinsWanted,
  type BriefChanges,
  type DeskCheckResult,
  type SceneBrief,
  type ShotResultMeta,
  type StageUnitRow,
  type UnitSource,
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
  type StateUnit,
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
import { StagingClient, StagingError, type Staged } from './staging';
import type { UnitExtract, UnitTarget } from './staging-engine';
import {
  defaultSaveTarget,
  intakeCopy,
  intakeSource,
  keepWanted,
  libraryRows,
  saveTargets,
  stateUnits,
  withoutFiles,
  type LibraryRow,
  type SaveTarget,
  type UnitIntake,
} from './units';

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
 *   never written (not asked again of a database that did not answer: one timeout at most), and
 *   the person is told (OpenOutcome.notice): opening never hangs on it.
 * - One desk per host and scene in this browser: the desk holds a Web Lock named after the project
 *   while the scene is open, and a second desk (another tab or frame) waits for it with a notice,
 *   so it never throws away the database under the first one. A Close at any moment of an open ends
 *   it: while the state unpacks, while it asks for the lock or waits for it, or while storage opens,
 *   before anything of the local copy changes; while it clears a copy it replaces, or while it
 *   stages (the staging worker is stopped, its result dropped), before anything new is written
 *   into the copy.
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
 *   Update shots the full checks (blocking lines, layouts) run in the background, behind the
 *   person's requests to the worker while they wait.
 * - Library units (docs/embedding.md "Library units"), only when the host turned them on for the
 *   open: the files that count for the brief's pins (units.ts readOpenUnits) go to the staging and
 *   to Update shots (copies, handed over to the worker); after the open and after each Update shots
 *   only those an Update shots could still place are kept (core pinsWanted, within one staging's
 *   budget), none after the scene closes. A worker that fails with the files (it stops, runs out of
 *   memory) gets the staging or the update again without them: their pins wait (`unavailable`). The brief's changes are read with their headers (nothing
 *   decoded on the page). A state of a document holding instances of units is container version 2.
 *   Save to library makes the unit in the worker (read only); the version the host saved and linked
 *   is adopted with the storage origin (not an undo step: it records what the host did), and Make
 *   local is one undo step.
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

/** Throws the open's cancellation (an AbortError) once Close cancelled it. */
function stopIfCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The open was cancelled.', 'AbortError');
}

/** How long the scene's database may take to open (or clear) before the desk keeps it in memory. */
export const STORAGE_TIMEOUT_MS = 10_000;

/** Storage that did not answer within the storage timeout (asked again, it would not answer either). */
class StorageTimeout extends Error {
  constructor(ms: number) {
    super(`it did not answer within ${Math.max(1, Math.round(ms / 1000))} s`);
    this.name = 'StorageTimeout';
  }
}

/** The scene's Web Lock is named this followed by its local id (deskProjectId). */
export const SCENE_LOCK_PREFIX = '3d-editor-desk:';

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
  /**
   * The brief's library pins as the staging left them (core's report.units: per pinned slot, its
   * unit or the words and why); null when nothing was staged or units are off for the open.
   */
  units?: StageUnitRow[] | null;
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
  /** The open in progress, from its start (cancelOpen and close abort it: Close while it opens). */
  private opening: AbortController | null = null;
  /** The library units held for the brief's pins (null: units are off for the open). */
  private units: UnitIntake | null = null;
  /** The page's source of `units` (headers only), made once per change of them. */
  private unitSourceCache: UnitSource | null = null;
  /** The brief's pins as the last staging or Update shots left them (report.units). */
  private lastUnitRows: StageUnitRow[] | null = null;
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
        reject(new StorageTimeout(ms));
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

  /**
   * Opens the scene's session: in IndexedDB where it works, else in memory. A database that did not
   * answer is not asked again for the local copy: the open waits one storage timeout at most.
   */
  private async openStored(id: string): Promise<Stored> {
    if (!(await this.storage())) return { session: await this.openSession(id, false), persistent: false };
    try {
      return { session: await this.openPersistent(id), persistent: true };
    } catch (err) {
      return this.inMemory(id, err, !(err instanceof StorageTimeout));
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
   * waits, saying so, while another desk holds it. Resolves with what lets go of it. The open's
   * `signal` ends it at any moment (AbortError): checked before each request and passed to the one
   * that waits (Web Locks refuse a signal on a request that does not wait, NotSupportedError, so
   * that one is checked as soon as it answers, and a lock it got is let go).
   */
  private async lockScene(id: string, signal: AbortSignal): Promise<() => void> {
    const locks = this.locks;
    if (!locks) return () => {};
    const name = `${SCENE_LOCK_PREFIX}${id}`;
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
    stopIfCancelled(signal);
    // null: locks that do not work here (an opaque origin): as without them
    const got = await take({ ifAvailable: true }).catch(() => null);
    if (signal.aborted) {
      if (got) release();
      stopIfCancelled(signal);
    }
    if (got === null) return () => {};
    if (got) return release;
    this.onWork({ label: OTHER_DESK_WAIT, startedAt: Date.now() });
    try {
      await take({ signal });
      return release;
    } finally {
      this.onWork(null);
    }
  }

  private stagedHere(s: ProjectSession, sceneId: string): boolean {
    return briefRecord(s.doc)?.sceneId === sceneId;
  }

  /**
   * Stages `brief` into session `s` (empty). The open's `signal` stops it at any moment: the worker's
   * staging is stopped, and a staging that came back is not applied (the local copy gets none of it).
   */
  private async stage(
    s: ProjectSession,
    brief: SceneBrief,
    signal: AbortSignal,
  ): Promise<{ ms: number; units: StageUnitRow[] | null }> {
    this.onWork({
      label: `Staging ${brief.shots.length} shot${brief.shots.length === 1 ? '' : 's'}…`,
      startedAt: Date.now(),
    });
    try {
      const update = Y.encodeStateAsUpdate(s.doc.ydoc);
      const lineage = newLineage();
      // the worker gets copies of the units: the page keeps those an Update shots may still need
      const run = () =>
        this.staging.stage(
          update,
          brief,
          lineage,
          GENERATOR,
          signal,
          this.units ? intakeCopy(this.units) : undefined,
        );
      let r: Staged;
      try {
        r = await run();
      } catch (err) {
        // the worker failed with the units' files (it stopped, ran out of memory): staged again
        // without them, their slots wait for another open (pending unavailable)
        if (!this.giveUpFiles(err, signal)) throw err;
        r = await run();
      }
      stopIfCancelled(signal);
      Y.applyUpdate(s.doc.ydoc, r.diff, s.storageOrigin);
      // nobody edits the scene before it opens: the checks are of the document as it is now
      this.keepCheck(s, r.check, s.revision.peek());
      return { ms: r.ms, units: this.units ? (r.summary.units ?? []) : null };
    } finally {
      this.onWork(null);
    }
  }

  /**
   * After a staging or an update failed: when it had units' files and the worker failed (not a
   * cancel), lets go of the files, their pins pending `unavailable` (units.ts withoutFiles), so that
   * the caller runs it again without them; false when it should fail as it is.
   */
  private giveUpFiles(err: unknown, signal?: AbortSignal): boolean {
    if (!this.units?.units.length || signal?.aborted) return false;
    if (!(err instanceof StagingError) || err.code === 'CANCELLED') return false;
    this.units = withoutFiles(this.units, err.message);
    this.unitSourceCache = null;
    return true;
  }

  /** The source of the units held (null: units are off). */
  private unitSource(): UnitSource | null {
    if (!this.units) return null;
    this.unitSourceCache ??= intakeSource(this.units);
    return this.unitSourceCache;
  }

  /** briefChanges' and the staging's options: the units held, when units are on. */
  private unitOptions(): { units?: UnitSource } {
    const source = this.unitSource();
    return source ? { units: source } : {};
  }

  /**
   * Keeps of the units held only those an Update shots of `doc` could still place (core
   * pinsWanted), within one staging's budget: the files of slots that hold their version, were
   * refused or made local are let go.
   */
  private keepWantedUnits(s: ProjectSession, brief: SceneBrief): void {
    if (!this.units) return;
    try {
      this.units = keepWanted(this.units, pinsWanted(s.doc, brief));
    } catch {
      // a brief core does not take (the protocol checked it): the units stay as they are
    }
    this.unitSourceCache = null;
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
    this.units = null;
    this.unitSourceCache = null;
    this.lastUnitRows = null;
    if (s && sessionSignal.peek() === s) sessionSignal.value = null;
    void s?.close(false);
    this.release?.();
    this.release = null;
  }

  /**
   * Opens the scene of `brief` for `hostOrigin` (see the module comment). cancelOpen (a Close) ends
   * it with an AbortError at any moment: until the local copy is read (while the state unpacks,
   * while it asks for the scene's lock or waits for another desk, and while storage opens) nothing
   * of the copy is changed; later (while a copy it replaces is cleared, while it stages) nothing new
   * is written into the copy, and a staging under way is stopped.
   */
  async open(o: {
    hostOrigin: string;
    brief: SceneBrief;
    state: GivenState | null;
    /** The library units of the open (units.ts readOpenUnits); null or absent: units are off. */
    units?: UnitIntake | null;
  }): Promise<OpenOutcome> {
    const cancel = new AbortController();
    this.opening?.abort();
    this.opening = cancel;
    try {
      return await this.openScene(o, cancel.signal);
    } finally {
      if (this.opening === cancel) this.opening = null;
    }
  }

  private async openScene(
    o: { hostOrigin: string; brief: SceneBrief; state: GivenState | null; units?: UnitIntake | null },
    signal: AbortSignal,
  ): Promise<OpenOutcome> {
    const { brief } = o;
    this.letGo();
    this.brief = brief;
    this.units = o.units ?? null;
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
    stopIfCancelled(signal);
    // one desk per host and scene in this browser: another one waits until this one lets go
    const release = await this.lockScene(id, signal);
    this.notice = null;
    let s: ProjectSession | null = null;
    try {
      stopIfCancelled(signal);
      this.onWork({ label: 'Opening the scene…', startedAt: Date.now() });
      let stored: Stored;
      try {
        stored = await this.openStored(id);
      } finally {
        this.onWork(null);
      }
      s = stored.session;
      // the last moment a Close ends the open with nothing of the local copy changed
      stopIfCancelled(signal);
      const plan = restorePlan(decoded && { lineage: decoded.lineage }, {
        staged: this.stagedHere(s, brief.id),
        lineage: readLineage(s.doc),
      });
      if (plan === 'replace' || (plan === 'stage' && s.doc.ydoc.store.clients.size > 0)) {
        const old = stored;
        s = null;
        stored = await this.resetStored(old, id);
        s = stored.session;
        // a Close while the old copy was cleared: nothing new is written into the copy
        stopIfCancelled(signal);
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
      let unitRows: StageUnitRow[] | null = null;
      if (plan === 'stage') {
        const staged = await this.stage(s, brief, signal);
        stageMs = staged.ms;
        unitRows = staged.units;
      }
      s.undo.clear();
      this.session = s;
      this.release = release;
      this.kept = kept && { session: s, ...kept };
      this.lastUnitRows = unitRows;
      // the units an Update shots may still place stay; the others are let go
      this.keepWantedUnits(s, brief);
      sessionSignal.value = s;
      const source: OpenSource = plan === 'stage' ? 'brief' : plan === 'local' ? 'local' : 'state';
      const changes = source === 'brief' ? null : briefChanges(s.doc, brief, this.unitOptions());
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
        units: unitRows,
      };
    } catch (err) {
      await s?.close(false).catch(() => undefined);
      release();
      this.units = null;
      this.unitSourceCache = null;
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
        // behind the person's requests (an export's results, Update shots) while it waits
        const r = await this.staging.check(update, { background: true });
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
   * same, else written anew (container version 2 when it holds instances of library units). Its
   * `units`: the rows of state.units of the same document (the controller sends them only after an
   * open with units). Throws StateTooLarge over 64 MiB (or a document over 256 MiB).
   */
  async encodeState(): Promise<{ state: DeskState; shots: number; units: StateUnit[] }> {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) throw new Error('no scene is open');
    const snapshot = Y.snapshot(s.doc.ydoc);
    const kept = this.kept;
    // read with the snapshot: the rows are of the document the bytes hold
    const units = stateUnits(s.doc);
    // each state gets its own buffer: the controller hands it over (transfers it)
    if (kept && kept.session === s && Y.equalSnapshots(kept.snapshot, snapshot))
      return {
        state: { format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, data: kept.bytes.slice().buffer },
        shots: kept.shots,
        units,
      };
    const shots = getShots(s.doc).length;
    const state = await encodeDeskState(
      Y.encodeStateAsUpdate(s.doc.ydoc),
      { sceneId: brief.id, lineage: readLineage(s.doc) ?? 'none', shots, deskVersion: DESK_VERSION },
      { units: docHasUnitInstances(s.doc) },
    );
    if (this.session === s)
      this.kept = { session: s, snapshot, bytes: new Uint8Array(state.data.slice(0)), shots };
    return { state, shots, units };
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

  /**
   * How the brief differs from what the scene was staged from (null: it agrees); with units on, the
   * library pins an Update shots would place with the units held (their headers only).
   */
  changes(): BriefChanges | null {
    const s = this.session;
    const brief = this.brief;
    return s && brief ? briefChanges(s.doc, brief, this.unitOptions()) : null;
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
      const update = Y.encodeStateAsUpdate(s.doc.ydoc);
      const run = () => this.staging.update(update, brief, this.units ? intakeCopy(this.units) : undefined);
      let r: Staged;
      try {
        r = await run();
      } catch (err) {
        // as in stage: the units' files given up, their slots keep what they hold
        if (!this.giveUpFiles(err)) throw err;
        r = await run();
      }
      // the worker's checks are of the document it got plus its change: current only when nothing
      // else changed the scene meanwhile (else shown as out of date until the next check)
      const edited = s.revision.peek() !== asked;
      s.undo.stopCapturing();
      Y.applyUpdate(s.doc.ydoc, r.diff, s.doc.origin);
      s.undo.stopCapturing();
      this.keepCheck(s, r.check, edited ? asked : s.revision.peek());
      if (this.units) {
        this.lastUnitRows = r.summary.units ?? [];
        // a unit the update placed is in the scene now: its file is let go
        this.keepWantedUnits(s, brief);
      }
      // the full checks (blocking lines, layouts) of the updated scene, in the background
      void this.refreshCheck();
      return briefChanges(s.doc, brief, this.unitOptions());
    } finally {
      this.onWork(null);
    }
  }

  /** The brief's library pins as the last staging or Update shots left them (null: none, or units are off). */
  unitRows(): StageUnitRow[] | null {
    return this.lastUnitRows;
  }

  /** The units held for an Update shots (their pins, `ref@version`), for tests and the Library tab. */
  heldUnits(): string[] {
    return this.units ? this.units.units.map(pinKey) : [];
  }

  /** The document's revision now (it changes with every edit). */
  revision(): number {
    return this.session?.revision.peek() ?? -1;
  }

  /** Sets the brief the scene follows (a publish the host linked moved one of its pins). */
  setBrief(brief: SceneBrief): void {
    this.brief = brief;
  }

  /** The Library tab's rows of the scene (units.ts libraryRows); [] without a scene. */
  libraryRows(): LibraryRow[] {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) return [];
    const source = this.unitSource();
    return libraryRows(s.doc, brief, (pin) => !!source?.header(pin));
  }

  /** What Save to library can save of the scene (units.ts saveTargets); [] without a scene. */
  saveTargets(): SaveTarget[] {
    const s = this.session;
    const brief = this.brief;
    return s && brief ? saveTargets(s.doc, brief) : [];
  }

  /** The target the Save dialog starts with for the selected object (units.ts defaultSaveTarget). */
  defaultSaveTarget(selected: string | null): SaveTarget | null {
    const s = this.session;
    const targets = this.saveTargets();
    return s && targets.length ? defaultSaveTarget(s.doc, targets, selected) : null;
  }

  /** A unit of the scene for Save to library, with its thumbnail: read only, made in the worker. */
  async extractUnit(what: UnitTarget, name: string): Promise<UnitExtract> {
    const s = this.session;
    if (!s) throw new Error('no scene is open');
    return this.staging.extractUnit(Y.encodeStateAsUpdate(s.doc.ydoc), what, name, DESK_VERSION);
  }

  /**
   * Makes the scene's objects published as `pin` an instance of it (core adoptPublished, in the
   * worker), with the record's pin of the unit's slot when `linked`. Applied with the storage origin:
   * not an undo step (it records what the host did). Throws when no scene is open or the scene's
   * published objects are gone.
   */
  async adoptUnit(
    unit: Pick<UnitExtract, 'link' | 'from' | 'header'>,
    pin: { ref: string; version: number; sha256: string },
    linked: boolean,
  ): Promise<{ root: string; recorded: boolean; warnings: string[] }> {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) throw new Error('no scene is open');
    const r = await this.staging.adoptUnit(Y.encodeStateAsUpdate(s.doc.ydoc), brief, {
      slot: unit.from,
      link: unit.link,
      pin,
      linked,
      header: unit.header,
    });
    // the scene was let go meanwhile: nothing is applied
    if (this.session !== s) throw new Error('the scene was closed');
    Y.applyUpdate(s.doc.ydoc, r.diff, s.storageOrigin);
    return { root: r.root, recorded: r.recorded, warnings: r.warnings };
  }

  /**
   * Make local: instance `root` keeps its objects as plain ones of the scene (core makeLocal, in the
   * worker), as one undo step. Throws when no scene is open, or the instance is gone.
   */
  async makeLocal(root: string): Promise<{ root: string; parts: number }> {
    const s = this.session;
    if (!s) throw new Error('no scene is open');
    const r = await this.staging.makeLocal(Y.encodeStateAsUpdate(s.doc.ydoc), root);
    // deleted while the worker ran, or the scene let go: nothing is applied
    if (this.session !== s || !s.doc.getObject(root))
      throw new Error('the library unit is no longer in the scene');
    s.undo.stopCapturing();
    Y.applyUpdate(s.doc.ydoc, r.diff, s.doc.origin);
    s.undo.stopCapturing();
    return { root: r.root, parts: r.parts };
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

  /**
   * Ends the open in progress (it rejects with an AbortError: see open), a wait for another desk's
   * lock too; an open scene stays.
   */
  cancelOpen(): void {
    this.opening?.abort();
  }

  /** Lets go of the scene and its lock (an open in progress ends, a wait for another desk too). */
  close(): void {
    this.opening?.abort();
    this.letGo();
    this.staging.dispose();
  }
}
