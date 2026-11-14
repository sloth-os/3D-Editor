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
import { ProjectSession } from '../project/session';
import { lastCheck } from '../ui/director/state';
import { briefShotFrames, type DeskState, type GivenState, type OpenSource } from './protocol';
import {
  StateUnreadable,
  decodeDeskState,
  encodeDeskState,
  newLineage,
  readLineage,
  restorePlan,
  type RestorePlan,
} from './state';
import { StagingClient } from './staging';

/*
 * The desk's scene (docs/embedding.md, "What the desk does"): the project of one host scene in this
 * browser, opened from the host's state, the local copy or the brief, and the work done on it off
 * the main thread (staging, updates, results).
 *
 * - The project lives in the browser's IndexedDB under a local id derived from the host's origin and
 *   the scene id (deskProjectId), so each host and scene has its own; where the browser blocks
 *   storage it lives in memory only (the host's state is the authoritative copy anyway).
 * - Opening follows the merge rule (state.ts restorePlan): a host state from the same staging as the
 *   local copy is merged into it, any other readable state replaces it; without a state the local
 *   copy is used, else the brief is staged (in the staging worker). A state that does not read is
 *   not applied: the desk goes on as without one and says so (state_unreadable).
 * - The staging is applied to the session's document in one transaction that undo does not track
 *   (it is where the scene starts); an update from a later brief is one undo step.
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

const GENERATOR = `3d-editor-desk ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}`;

export class DeskWorkspace {
  session: ProjectSession | null = null;
  private brief: SceneBrief | null = null;
  private persistent: boolean | null = null;

  constructor(
    readonly staging: StagingClient = new StagingClient(),
    private readonly onWork: (w: WorkProgress | null) => void = () => {},
  ) {}

  private async storage(): Promise<boolean> {
    this.persistent ??= await indexedDbUsable();
    return this.persistent;
  }

  private async openSession(id: string, persist: boolean): Promise<ProjectSession> {
    const s = await ProjectSession.open(id, { persist });
    s.undo.clear();
    return s;
  }

  /** Throws away the local copy of project `id` and opens it empty. */
  private async resetSession(s: ProjectSession, id: string, persist: boolean): Promise<ProjectSession> {
    await s.close(false);
    if (persist) await ProjectSession.deleteLocal(id).catch(() => undefined);
    return this.openSession(id, persist);
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
      this.keepCheck(s, r.check);
      return r.ms;
    } finally {
      this.onWork(null);
    }
  }

  /** Shows the checks in the shot list (as a Check would), for the document as it is now. */
  private keepCheck(s: ProjectSession, check: DeskCheckResult): void {
    lastCheck.value = { session: s, revision: s.revision.peek(), result: check };
  }

  /** Opens the scene of `brief` for `hostOrigin` (see the module comment). */
  async open(o: { hostOrigin: string; brief: SceneBrief; state: GivenState | null }): Promise<OpenOutcome> {
    const { brief } = o;
    this.brief = brief;
    const persist = await this.storage();
    const id = deskProjectId(o.hostOrigin, brief.id);
    let unreadable: string | null = null;
    let decoded: Awaited<ReturnType<typeof decodeDeskState>> | null = null;
    if (o.state) {
      try {
        decoded = await decodeDeskState(o.state, brief.id);
      } catch (err) {
        unreadable =
          err instanceof StateUnreadable ? err.message : `the desk state does not read (${String(err)})`;
      }
    }
    this.onWork({ label: 'Opening the scene…', startedAt: Date.now() });
    let s: ProjectSession;
    try {
      s = await this.openSession(id, persist);
    } finally {
      this.onWork(null);
    }
    try {
      let plan = restorePlan(decoded && { lineage: decoded.header.lineage }, {
        staged: this.stagedHere(s, brief.id),
        lineage: readLineage(s.doc),
      });
      if (plan === 'replace' || (plan === 'stage' && s.doc.ydoc.store.clients.size > 0))
        s = await this.resetSession(s, id, persist);
      if ((plan === 'merge' || plan === 'replace') && decoded) {
        Y.applyUpdate(s.doc.ydoc, decoded.update, s.storageOrigin);
        if (!this.stagedHere(s, brief.id)) {
          // a state that says it is this scene's but holds no staging of it: as unreadable
          unreadable = 'the desk state holds no staging of this scene';
          s = await this.resetSession(s, id, persist);
          plan = 'stage';
        }
      }
      let stageMs: number | null = null;
      if (plan === 'stage') stageMs = await this.stage(s, brief);
      s.undo.clear();
      this.session = s;
      sessionSignal.value = s;
      const source: OpenSource = plan === 'stage' ? 'brief' : plan === 'local' ? 'local' : 'state';
      const changes = source === 'brief' ? null : briefChanges(s.doc, brief);
      if (source !== 'brief') void this.refreshCheck();
      return { source, changes, unreadable, plan, stageMs, persistent: persist };
    } catch (err) {
      await s.close(false).catch(() => undefined);
      throw err;
    }
  }

  /** Runs the checks of the scene as it is now in the worker and shows them in the shot list. */
  async refreshCheck(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      const r = await this.staging.check(Y.encodeStateAsUpdate(s.doc.ydoc));
      if (this.session === s) this.keepCheck(s, r.check);
    } catch {
      // the shot list's Check button runs them again
    }
  }

  /** A snapshot of the scene (what an export renders). */
  snapshot(): Uint8Array {
    if (!this.session) throw new Error('no scene is open');
    return Y.encodeStateAsUpdate(this.session.doc.ydoc);
  }

  /** The scene's desk state; throws StateTooLarge over 64 MiB. */
  async encodeState(): Promise<{ state: DeskState; shots: number }> {
    const s = this.session;
    const brief = this.brief;
    if (!s || !brief) throw new Error('no scene is open');
    const shots = getShots(s.doc).length;
    const state = await encodeDeskState(Y.encodeStateAsUpdate(s.doc.ydoc), {
      sceneId: brief.id,
      lineage: readLineage(s.doc) ?? 'none',
      shots,
      savedAt: new Date().toISOString(),
      deskVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
    });
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
      const r = await this.staging.update(Y.encodeStateAsUpdate(s.doc.ydoc), brief);
      s.undo.stopCapturing();
      Y.applyUpdate(s.doc.ydoc, r.diff, s.doc.origin);
      s.undo.stopCapturing();
      this.keepCheck(s, r.check);
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

  close(): void {
    const s = this.session;
    this.session = null;
    if (sessionSignal.peek() === s) sessionSignal.value = null;
    void s?.close(false);
    this.staging.dispose();
  }
}
