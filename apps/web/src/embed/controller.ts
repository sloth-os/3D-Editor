import { signal } from '@preact/signals';
import type { BriefChanges, SceneBrief, ShotResultMeta } from '@3d-editor/core';
import {
  DeskExportError,
  exportSizeProblem,
  runDeskExport,
  type DeskExportOutcome,
  type DeskExportProgress,
  type DeskExportRequest,
} from './export';
import {
  MODES,
  uniqueModes,
  type DeskMessage,
  type DeskState,
  type ErrorCode,
  type ExportMessage,
  type GivenState,
  type HostMessage,
  type Mode,
  type OpenMessage,
  type OpenSource,
  type Phase,
  type ProgressMessage,
  type ProtocolBriefChanges,
  type ResultAckMessage,
} from './protocol';
import { StateTooLarge } from './state';
import type { LengthMismatch, OpenOutcome } from './workspace';

/*
 * The desk's side of the protocol once connected (docs/embedding.md): what it answers and when.
 *
 * - `ready` right after the connect (within 2 s): its version and whether this browser can export
 *   (checked for 1280 × 720 at 24 fps, since ready comes before the brief; each export checks again
 *   at the brief's real size). The bridge holds what the host sends before it until ready is out.
 * - `open` once: the scene from the host's state, the local copy or the brief, then `opened` (its
 *   `changes` the contract's lists only, null when they are all empty; the banner also shows the
 *   desk's own notes) and a first `state` (none after a state it could not read: the host's copy
 *   stays until an edit, Done or save). A second open is answered with busy. An open that fails (a
 *   brief the desk cannot stage) is answered with invalid_scene and does not count: the host may
 *   send another. Close at any moment of an open cancels it: nothing more is sent, no scene is
 *   open (also while the cancelled open still lets go of its scene), and the host may send another.
 * - `state` after `opened`, after edits (2 s after the last change, at most one every 5 s; edits
 *   are followed from `opened` on, those made while the first state is written too), when the
 *   person presses Done, and in answer to `save` (with its id; not_open when no scene is open).
 *   Never after close on its own: edits made then wait until the person goes back to the desk.
 * - `export` (and the person's Send, id `desk-<n>`, of the mode the desk's Follow menu shows): the
 *   brief's shots (those named, else all) in the open's brief order, also after the host reordered
 *   them since staging; progress at most one message per 100 ms (the last of each phase always,
 *   early), however late the page runs its timers, then `result` (its files transferred), and an
 *   `export_failed` error per shot left out (one that failed, or one the brief has that is not
 *   staged); bad_message for ids that are no shots of the brief; export_unavailable at once for a
 *   brief over the export's size; busy while another export or an update runs, not_open before the
 *   scene is open.
 * - `cancel` of the running export ends it with error cancelled; a cancel of another id is ignored.
 * - `result-ack` is shown to the person.
 * - Done: a final state, then close {reason: 'done'}; Close: close {reason: 'cancel'} (with a state
 *   first when edits are not sent yet: the host keeps the newest state it has).
 */

/** What the controller needs of the scene (DeskWorkspace; tests give a fake one). */
export interface SceneWorkspace {
  open(o: { hostOrigin: string; brief: SceneBrief; state: GivenState | null }): Promise<OpenOutcome>;
  encodeState(): Promise<{ state: DeskState; shots: number }>;
  onEdit(cb: () => void): () => void;
  snapshot(): Uint8Array;
  stagedShots(): string[];
  lengthMismatches(): LengthMismatch[];
  changes(): BriefChanges | null;
  updateFromBrief(): Promise<BriefChanges | null>;
  results(update: Uint8Array, shots?: string[]): Promise<ShotResultMeta[]>;
  readonly projectId: string | null;
  /** Lets go of the scene (an open cancelled by Close); a later open opens it again. */
  close?(): void;
  /** Stops an open that waits for another desk to let go of the scene (Close while it opens). */
  cancelOpen?(): void;
}

export interface ControllerDeps {
  /** Sends a message to the host (false when nothing is connected). */
  send(message: DeskMessage, transfer?: Transferable[]): boolean;
  workspace: SceneWorkspace;
  /** Whether this browser can export at a size and rate (export/index.ts browserExportSupport). */
  exportSupport(o: {
    width: number;
    height: number;
    fps: number;
  }): Promise<{ available: boolean; reason: string | null }>;
  /** Runs an export (export.ts runDeskExport by default). */
  runExport?: typeof runDeskExport;
  deskVersion: string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  timers?: {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** The options of an open, with the contract's defaults. */
export interface DeskOptions {
  hostName: string;
  modes: Mode[];
  defaultMode: Mode;
  readOnly: boolean;
}

/**
 * The options of an open with the contract's defaults: `modes` in the host's order, each once (none:
 * ["camera"]); `defaultMode` the host's when it is one of them, else the first of them.
 */
export function resolveOptions(o: OpenMessage['options'] | undefined): DeskOptions {
  const modes = o?.modes?.length ? uniqueModes(o.modes) : (['camera'] as Mode[]);
  const defaultMode = o?.defaultMode && modes.includes(o.defaultMode) ? o.defaultMode : modes[0];
  return { hostName: o?.hostName?.trim() || 'the host', modes, defaultMode, readOnly: o?.readOnly === true };
}

/**
 * The brief's changes as `opened` sends them: the contract's lists only (core's briefChanges adds
 * the desk's own `other` notes, which only its banner shows), and null when none of them has an
 * entry.
 */
export function contractChanges(c: BriefChanges | null): ProtocolBriefChanges | null {
  if (!c) return null;
  const out: ProtocolBriefChanges = {
    added: [...c.added],
    removed: [...c.removed],
    retimed: [...c.retimed],
    recast: [...c.recast],
    cast: { added: [...c.cast.added], removed: [...c.cast.removed] },
  };
  const empty =
    !out.added.length &&
    !out.removed.length &&
    !out.retimed.length &&
    !out.recast.length &&
    !out.cast.added.length &&
    !out.cast.removed.length;
  return empty ? null : out;
}

/** The size the ready message's export check is made for (ready comes before the brief). */
export const READY_CHECK = { width: 1280, height: 720, fps: 24 } as const;
/** How long ready waits at most for the browser's encoder check (ready goes within 2 s). */
export const READY_CHECK_MS = 1500;
/** States after edits: this long after the last change … */
export const STATE_QUIET_MS = 2000;
/** … and at most one per this many milliseconds. */
export const STATE_MIN_INTERVAL_MS = 5000;
/** Progress messages: at most one per this many milliseconds (about ten a second). */
export const PROGRESS_INTERVAL_MS = 100;
/** The brief's changes are compared again this long after the last edit (an undone Update shots). */
export const CHANGES_QUIET_MS = 300;
/** Done and Close wait this long at most for a cancelled export to end (its cancelled goes first). */
export const EXPORT_STOP_WAIT_MS = 2000;

export type DeskStatus = 'waiting' | 'connected' | 'opening' | 'open' | 'closed';

/** One export the controller runs (the host's, or the person's Send). */
interface ExportJob {
  id: string;
  by: 'desk' | 'host';
  /** The brief's shots asked for (none: every shot of the brief). */
  asked?: readonly string[];
  modes: Mode[];
  still: boolean;
}

export interface ExportRun {
  id: string;
  /** 'desk': the person's Send; 'host': the host's export. */
  by: 'desk' | 'host';
  phase: Phase;
  done: number;
  total: number;
  shotId?: string;
  startedAt: number;
}

export interface AckNotice {
  id: string;
  ok: boolean;
  message: string;
  refused: { shotId: string; error: string }[];
  at: number;
}

export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
  at: number;
}

const realTimers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class DeskController {
  readonly status = signal<DeskStatus>('waiting');
  readonly options = signal<DeskOptions>(resolveOptions(undefined));
  readonly brief = signal<SceneBrief | null>(null);
  readonly source = signal<OpenSource | null>(null);
  readonly changes = signal<BriefChanges | null>(null);
  readonly exportRun = signal<ExportRun | null>(null);
  readonly updating = signal(false);
  readonly ack = signal<AckNotice | null>(null);
  readonly notice = signal<Notice | null>(null);
  /** When the last state went to the host (ms), and whether edits since are not sent yet. */
  readonly lastStateAt = signal<number | null>(null);
  readonly dirty = signal(false);
  /** The reference the person's Send renders (Follow): one of the host's modes, preselected from the options. */
  readonly mode = signal<Mode>('camera');
  readonly opened = signal<OpenOutcome | null>(null);

  private hostOrigin: string | null = null;
  private deskSeq = 0;
  private abort: AbortController | null = null;
  private stopEdits: (() => void) | null = null;
  private stateTimer: unknown = null;
  private changesTimer: unknown = null;
  private lastChangeAt = 0;
  private lastSentAt = 0;
  /** The state being written (a Done or Close waits for it, so it goes before close). */
  private stateInFlight: Promise<boolean> | null = null;
  /** Close was pressed while the scene opened: the open is cancelled. */
  private openCancelled = false;
  /** The open in progress (settles, never rejects). */
  private opening: Promise<void> | null = null;
  /** An open cancelled by Close that has not let go of its scene yet: a later open waits for it. */
  private cancelledOpen: Promise<void> | null = null;
  /** The running export (settles, never rejects). */
  private exporting: Promise<void> | null = null;
  /** Done or Close is sending its last state. */
  private closing = false;
  private progressTimer: unknown = null;
  private pendingProgress: ProgressMessage | null = null;
  private lastProgressAt = 0;
  private readonly timers: NonNullable<ControllerDeps['timers']>;
  private readonly log: NonNullable<ControllerDeps['log']>;

  constructor(private readonly deps: ControllerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.log =
      deps.log ?? ((level, message) => (level === 'info' ? console.info : console.warn)(`[desk] ${message}`));
  }

  private error(code: ErrorCode, message: string, id?: string): void {
    this.deps.send({ type: 'error', ...(id ? { id } : {}), code, message });
  }

  private tell(level: Notice['level'], message: string): void {
    this.notice.value = { level, message, at: this.timers.now() };
  }

  /** Why a request that needs the open scene is refused (not_open). */
  private notOpen(id?: string): void {
    const closed = this.status.peek() === 'closed' && !!this.brief.peek();
    this.error(
      'not_open',
      closed
        ? 'The desk was closed (Done or Close): it takes requests again once the person goes back to the desk.'
        : 'No scene is open yet: send open first.',
      id,
    );
  }

  // ---------------------------------------------------------------- connection

  /** The host connected: answers ready within 2 s. */
  async connected(hostOrigin: string): Promise<void> {
    this.hostOrigin = hostOrigin;
    this.status.value = 'connected';
    const check = await Promise.race([
      this.deps.exportSupport(READY_CHECK).catch((e: unknown) => ({
        available: false,
        reason: `The browser's encoder check failed: ${e instanceof Error ? e.message : String(e)}`,
      })),
      new Promise<null>((r) => this.timers.setTimeout(() => r(null), READY_CHECK_MS)),
    ]);
    // an encoder check slower than READY_CHECK_MS: what the page has decides, and every export
    // checks again at its real size
    const g = globalThis as { VideoEncoder?: unknown; Worker?: unknown; isSecureContext?: boolean };
    const export_ = check ?? {
      available:
        typeof g.VideoEncoder === 'function' && typeof g.Worker === 'function' && g.isSecureContext !== false,
      reason: null,
    };
    this.deps.send({
      type: 'ready',
      deskVersion: this.deps.deskVersion,
      protocol: 1,
      capabilities: {
        export: {
          available: export_.available,
          reason: export_.available ? null : (export_.reason ?? 'This browser cannot encode H.264 video.'),
          container: 'mp4',
          videoCodec: 'avc1',
          modes: [...MODES],
        },
        offline: true,
      },
    });
  }

  /** A valid message from the host. */
  message(m: HostMessage): void {
    switch (m.type) {
      case 'open':
        void this.open(m);
        return;
      case 'export':
        void this.hostExport(m);
        return;
      case 'cancel':
        if (this.exportRun.peek()?.id === m.id) this.cancelExport();
        else this.log('info', `ignored a cancel of '${m.id}': no such export runs`);
        return;
      case 'save': {
        // after Done or Close the scene is still here (and answered); before open, or after a Close
        // that cancelled the open, there is none
        const st = this.status.peek();
        if (!this.brief.peek() || (st !== 'open' && st !== 'closed')) return this.notOpen(m.id);
        void this.sendState(m.id);
        return;
      }
      case 'result-ack':
        this.showAck(m);
        return;
    }
  }

  // ---------------------------------------------------------------- open

  private async open(m: OpenMessage): Promise<void> {
    // an open that Close cancelled lets go of its scene first; this one follows
    while (this.cancelledOpen) {
      const pending = this.cancelledOpen;
      await pending;
      if (this.cancelledOpen === pending) this.cancelledOpen = null;
    }
    const st = this.status.peek();
    // a Close before any scene opened (or one that cancelled an open) leaves room for one
    const free = st === 'connected' || st === 'waiting' || (st === 'closed' && !this.brief.peek());
    if (!free) {
      this.error(
        'busy',
        st === 'opening'
          ? 'The desk is opening a scene already: one open per connection.'
          : 'The desk has a scene open already: one open per connection.',
      );
      return;
    }
    const task = this.openScene(m);
    // what a later open waits for when Close cancels this one (settles once the scene is let go)
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.opening = settled;
    await task;
    if (this.opening === settled) this.opening = null;
  }

  private async openScene(m: OpenMessage): Promise<void> {
    this.openCancelled = false;
    this.status.value = 'opening';
    const options = resolveOptions(m.options);
    this.options.value = options;
    this.mode.value = options.defaultMode;
    this.brief.value = m.scene;
    let r: OpenOutcome;
    try {
      r = await this.deps.workspace.open({
        hostOrigin: this.hostOrigin ?? 'null',
        brief: m.scene,
        state: m.state,
      });
    } catch (err) {
      this.brief.value = null;
      // closed while it opened: the host was told already, nothing more goes to it
      if (this.openCancelled) {
        this.openCancelled = false;
        return;
      }
      this.status.value = 'connected';
      const message = err instanceof Error ? err.message : String(err);
      this.tell('error', `The scene could not be staged: ${message}`);
      this.error('invalid_scene', `The scene could not be staged: ${message}`);
      return;
    }
    if (this.openCancelled) {
      // Close while the scene opened cancels the open: no opened, no state; the scene is let go and
      // a later open is taken
      this.openCancelled = false;
      this.brief.value = null;
      this.deps.workspace.close?.();
      return;
    }
    this.opened.value = r;
    this.source.value = r.source;
    this.changes.value = r.changes;
    this.status.value = 'open';
    const notices: string[] = [];
    if (r.unreadable) {
      const text =
        r.source === 'local'
          ? `The stored desk state was not applied (${r.unreadable}); the desk opened its own copy of the scene.`
          : `The stored desk state was not applied (${r.unreadable}); the scene was staged from the brief.`;
      notices.push(text);
      this.error('state_unreadable', text);
    }
    // a brief larger than the export renders: said now, not at the first Send
    const size = exportSizeProblem(m.scene.width, m.scene.height);
    if (size) notices.push(size);
    // storage that failed: the scene is kept in memory only (workspace.ts)
    if (r.notice) notices.push(r.notice);
    if (notices.length) this.tell('warning', notices.join(' '));
    // the contract's lists only (the banner shows the desk's own notes too)
    this.deps.send({
      type: 'opened',
      sceneId: m.scene.id,
      source: r.source,
      changes: contractChanges(r.changes),
    });
    // edits from now on, those made while the first state is written too (the scene is open)
    this.stopEdits = this.deps.workspace.onEdit(() => this.edited());
    // after a state it could not read, opening sends none on its own: the host keeps its copy
    // until an edit, Done or save (docs/embedding.md, Readings)
    if (!r.unreadable) await this.sendState();
  }

  // ---------------------------------------------------------------- state

  private edited(): void {
    this.dirty.value = true;
    this.lastChangeAt = this.timers.now();
    this.scheduleChanges();
    // after Done or Close nothing goes to the host on its own: the edit waits for Back to the desk
    if (this.status.peek() === 'closed') return;
    this.scheduleState();
  }

  /** Compares the brief with the scene again once the edits pause (an undone Update shots). */
  private scheduleChanges(): void {
    if (this.changesTimer !== null) this.timers.clearTimeout(this.changesTimer);
    this.changesTimer = this.timers.setTimeout(() => {
      this.changesTimer = null;
      this.refreshChanges();
    }, CHANGES_QUIET_MS);
  }

  /** The brief's changes as the scene has them now (kept as they are when nothing differs). */
  private refreshChanges(): void {
    if (!this.brief.peek()) return;
    let now: BriefChanges | null;
    try {
      now = this.deps.workspace.changes();
    } catch {
      return;
    }
    if (JSON.stringify(now) !== JSON.stringify(this.changes.peek())) this.changes.value = now;
  }

  private scheduleState(): void {
    if (this.stateTimer !== null) return;
    const now = this.timers.now();
    const at = Math.max(this.lastChangeAt + STATE_QUIET_MS, this.lastSentAt + STATE_MIN_INTERVAL_MS);
    this.stateTimer = this.timers.setTimeout(
      () => {
        this.stateTimer = null;
        const t = this.timers.now();
        if (t - this.lastChangeAt < STATE_QUIET_MS || t - this.lastSentAt < STATE_MIN_INTERVAL_MS) {
          this.scheduleState();
          return;
        }
        void this.sendState();
      },
      Math.max(0, at - now),
    );
  }

  /** Sends the scene's state (in answer to save `id` when given). */
  sendState(id?: string): Promise<boolean> {
    const p = this.writeState(id);
    this.stateInFlight = p;
    const settled = () => {
      if (this.stateInFlight === p) this.stateInFlight = null;
    };
    p.then(settled, settled);
    return p;
  }

  private async writeState(id?: string): Promise<boolean> {
    const brief = this.brief.peek();
    if (!brief) {
      if (id) this.notOpen(id);
      return false;
    }
    this.dirty.value = false;
    let encoded: { state: DeskState; shots: number };
    try {
      encoded = await this.deps.workspace.encodeState();
    } catch (err) {
      this.dirty.value = true;
      const message =
        err instanceof StateTooLarge
          ? `${err.message}: the host cannot store this scene; the desk keeps it in this browser.`
          : `The desk state could not be written: ${err instanceof Error ? err.message : String(err)}`;
      this.tell('error', message);
      // out_of_memory: the closest code the contract has for a state too large to hand over;
      // export_failed for any other failure to write it (docs/embedding.md, Readings)
      this.error(err instanceof StateTooLarge ? 'out_of_memory' : 'export_failed', message, id);
      return false;
    }
    // a state of edits written while Done or Close sent the last one waits for Back to the desk
    if (!id && this.status.peek() === 'closed') {
      this.dirty.value = true;
      return false;
    }
    this.lastSentAt = this.timers.now();
    this.lastStateAt.value = this.lastSentAt;
    this.deps.send(
      { type: 'state', ...(id ? { id } : {}), sceneId: brief.id, state: encoded.state, shots: encoded.shots },
      [encoded.state.data],
    );
    return true;
  }

  // ---------------------------------------------------------------- update from the brief

  /** Updates the shots to the brief (Update shots): one undo step. */
  async updateShots(): Promise<void> {
    if (this.status.peek() !== 'open' || this.updating.peek() || this.exportRun.peek()) return;
    if (this.options.peek().readOnly) return;
    this.updating.value = true;
    try {
      this.changes.value = await this.deps.workspace.updateFromBrief();
      this.tell('info', 'The shots were updated to the brief (Ctrl+Z undoes it).');
    } catch (err) {
      this.tell(
        'error',
        `The shots could not be updated: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.updating.value = false;
    }
  }

  // ---------------------------------------------------------------- export

  private async hostExport(m: ExportMessage): Promise<void> {
    if (this.status.peek() !== 'open') return this.notOpen(m.id);
    if (this.exportRun.peek() || this.updating.peek())
      return this.error(
        'busy',
        this.exportRun.peek()
          ? 'The desk is exporting already: one export at a time.'
          : 'The desk is updating its shots.',
        m.id,
      );
    // an empty list names no shot: every shot of the brief, as when it names none
    const asked = m.shots?.length ? m.shots : undefined;
    const unknown = this.exportShots(asked).unknown;
    if (unknown.length)
      return this.error('bad_message', `Not shots of this scene's brief: ${unknown.join(', ')}.`, m.id);
    await this.runExport({
      id: m.id,
      by: 'host',
      asked,
      // the host's own modes (each once), else the open's
      modes: m.modes?.length ? uniqueModes(m.modes) : this.options.peek().modes,
      still: m.still ?? true,
    });
  }

  /**
   * The shots of an export: the brief's shots (those `asked`, else all of them) in brief order,
   * whatever order the host asked them in. `shots` are the staged ones; `notStaged` the brief's
   * shots the staging does not have yet (added to the brief since: Update shots stages them),
   * which the export leaves out and names in errors; `unknown` asked ids that are no shots of the
   * brief (the request is refused).
   */
  private exportShots(asked?: readonly string[]): {
    shots: string[];
    notStaged: string[];
    unknown: string[];
  } {
    const briefIds = (this.brief.peek()?.shots ?? []).map((s) => s.id);
    const staged = new Set(this.deps.workspace.stagedShots());
    const wanted = asked ? new Set(asked) : null;
    const inBrief = wanted ? briefIds.filter((id) => wanted.has(id)) : briefIds;
    return {
      shots: inBrief.filter((id) => staged.has(id)),
      notStaged: inBrief.filter((id) => !staged.has(id)),
      unknown: asked ? [...new Set(asked)].filter((id) => !briefIds.includes(id)) : [],
    };
  }

  /**
   * The person's Send: every shot of the brief, in the mode of the desk's Follow menu (one of the
   * host's modes; preselected from options.defaultMode), with stills.
   */
  async sendToHost(): Promise<string | null> {
    if (this.status.peek() !== 'open' || this.exportRun.peek() || this.updating.peek()) return null;
    const options = this.options.peek();
    const mode = options.modes.includes(this.mode.peek()) ? this.mode.peek() : options.defaultMode;
    const id = `desk-${++this.deskSeq}`;
    await this.runExport({ id, by: 'desk', modes: [mode], still: true });
    return id;
  }

  /** Cancels the running export (the person's Cancel or the host's cancel). */
  cancelExport(): void {
    this.abort?.abort();
  }

  private progress(p: { id: string; phase: Phase; done: number; total: number; shotId?: string }): void {
    const run = this.exportRun.peek();
    if (run && run.id === p.id) this.exportRun.value = { ...run, ...p };
    const msg: ProgressMessage = { type: 'progress', ...p };
    // the last message of a phase always goes: the one waiting goes first when another phase starts
    if (this.pendingProgress && this.pendingProgress.phase !== msg.phase)
      this.flushProgress(this.pendingProgress);
    const now = this.timers.now();
    // at most one message per PROGRESS_INTERVAL_MS otherwise; the latest one waiting goes when the
    // interval ends, or before the result
    if (this.lastProgressAt === 0 || now - this.lastProgressAt >= PROGRESS_INTERVAL_MS) {
      // it replaces the one waiting, and the timer of that one goes with it
      this.clearProgressTimer();
      this.flushProgress(msg);
      return;
    }
    this.pendingProgress = msg;
    this.scheduleProgress();
  }

  /**
   * Sends the message waiting once PROGRESS_INTERVAL_MS have passed since the last one. The timer
   * checks again when it runs: it may run late (a busy page runs due timers after the events
   * queued before them), or after a phase's last message went early.
   */
  private scheduleProgress(): void {
    if (this.progressTimer !== null) return;
    const wait = PROGRESS_INTERVAL_MS - (this.timers.now() - this.lastProgressAt);
    this.progressTimer = this.timers.setTimeout(
      () => {
        this.progressTimer = null;
        if (!this.pendingProgress) return;
        if (this.timers.now() - this.lastProgressAt < PROGRESS_INTERVAL_MS) return this.scheduleProgress();
        this.flushProgress(this.pendingProgress);
      },
      Math.max(0, wait),
    );
  }

  private clearProgressTimer(): void {
    if (this.progressTimer !== null) this.timers.clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }

  private flushProgress(msg: ProgressMessage): void {
    this.pendingProgress = null;
    this.lastProgressAt = this.timers.now();
    // after close the export only ends (cancelled): no more progress goes to the host
    if (this.status.peek() === 'closed') return;
    this.deps.send(msg);
  }

  private stopProgress(): void {
    this.clearProgressTimer();
    this.pendingProgress = null;
    this.lastProgressAt = 0;
  }

  private runExport(o: ExportJob): Promise<void> {
    const task = this.exportJob(o);
    this.exporting = task;
    const settled = () => {
      if (this.exporting === task) this.exporting = null;
    };
    task.then(settled, settled);
    return task;
  }

  private async exportJob(o: ExportJob): Promise<void> {
    const brief = this.brief.peek()!;
    const options = this.options.peek();
    // a brief larger than the export renders is answered at once
    const size = exportSizeProblem(brief.width, brief.height);
    if (size) {
      if (o.by === 'desk') this.tell('warning', size);
      this.error('export_unavailable', size, o.id);
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.ack.value = null;
    this.exportRun.value = {
      id: o.id,
      by: o.by,
      phase: 'prepare',
      done: 0,
      total: 1,
      startedAt: this.timers.now(),
    };
    const fail = (code: ErrorCode, message: string) => {
      this.tell(code === 'cancelled' ? 'info' : 'error', message);
      this.error(code, message, o.id);
    };
    let notStaged: string[] = [];
    let outcome: DeskExportOutcome | null = null;
    try {
      const support = await this.deps.exportSupport({
        width: brief.width,
        height: brief.height,
        fps: brief.fps,
      });
      if (!support.available)
        return fail('export_unavailable', support.reason ?? 'This browser cannot encode the clips.');
      this.progress({ id: o.id, phase: 'prepare', done: 0, total: 1 });
      // the snapshot, the shots it stages and the brief's changes, read together (nothing changes
      // between them): a shot deleted meanwhile is left out like one not staged yet
      const update = this.deps.workspace.snapshot();
      const { shots, notStaged: missing } = this.exportShots(o.asked);
      const retimed = this.deps.workspace.changes()?.retimed ?? [];
      // the brief's shots the staging does not have: left out, each named like a shot that failed
      notStaged = missing.map(
        (id) =>
          `${id}: the shot is in the brief but not staged in the desk (${
            options.readOnly ? 'the scene is read-only here' : 'Update shots stages it'
          }).`,
      );
      if (!shots.length)
        return fail('export_failed', notStaged.join(' ') || 'The scene has no staged shots to export.');
      // in the open's brief order (the contract's): the worker reports the order the scene was
      // staged in, another one once the host reordered its shots, before and after Update shots
      const rank = new Map(shots.map((id, i) => [id, i]));
      const results = (await this.deps.workspace.results(update, shots)).sort(
        (a, b) => (rank.get(a.shotId) ?? shots.length) - (rank.get(b.shotId) ?? shots.length),
      );
      if (abort.signal.aborted) return fail('cancelled', 'The export was cancelled.');
      if (!results.length) return fail('export_failed', 'The scene has no staged shots to export.');
      const req: DeskExportRequest = {
        update,
        brief,
        shots: results,
        modes: o.modes,
        still: o.still,
        hostName: options.hostName,
        project: { id: this.deps.workspace.projectId ?? brief.id, name: brief.name },
        retimed,
        readOnly: options.readOnly,
      };
      outcome = await (this.deps.runExport ?? runDeskExport)(req, {
        signal: abort.signal,
        onProgress: (p: DeskExportProgress) => this.progress({ id: o.id, ...p }),
      });
      if (abort.signal.aborted) return fail('cancelled', 'The export was cancelled.');
      // the last progress waiting (encode N/N, finish) goes before the result
      if (this.pendingProgress) this.flushProgress(this.pendingProgress);
      this.stopProgress();
      const message: DeskMessage = {
        type: 'result',
        id: o.id,
        sceneId: brief.id,
        fps: brief.fps,
        width: brief.width,
        height: brief.height,
        shots: outcome.shots,
        files: outcome.files,
      };
      const count = outcome.shots.length;
      this.deps.send(
        message,
        outcome.files.map((f) => f.data),
      );
      // the shots left out, each named in an export_failed error after the result (the cause in its
      // message; the result never waits for them)
      for (const f of outcome.failures) this.error('export_failed', f.message, o.id);
      for (const m of notStaged) this.error('export_failed', m, o.id);
      const left = [...outcome.failures.map((f) => f.message), ...notStaged];
      if (left.length)
        this.tell(
          'warning',
          `Sent ${count} shot${count === 1 ? '' : 's'}; ${left.length} left out: ${left.join(' ')}`,
        );
      else this.tell('info', `Sent ${count} shot${count === 1 ? '' : 's'} to ${options.hostName}.`);
    } catch (err) {
      this.stopProgress();
      if (err instanceof DeskExportError)
        fail(err.code, err.code === 'cancelled' ? err.message : [err.message, ...notStaged].join(' '));
      else if (abort.signal.aborted) fail('cancelled', 'The export was cancelled.');
      else fail('export_failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.stopProgress();
      if (this.abort === abort) this.abort = null;
      this.exportRun.value = null;
      // the export's files (Origin Private File System) go once the result is sent
      if (outcome) await outcome.release().catch(() => undefined);
    }
  }

  private showAck(m: ResultAckMessage): void {
    const refused = (m.shots ?? [])
      .filter((s) => !s.ok)
      .map((s) => ({ shotId: s.shotId, error: s.error ?? 'refused' }));
    this.ack.value = {
      id: m.id,
      ok: m.ok,
      message:
        m.message ??
        (m.ok
          ? `${this.options.peek().hostName} took the result.`
          : `${this.options.peek().hostName} refused the result.`),
      refused,
      at: this.timers.now(),
    };
  }

  // ---------------------------------------------------------------- done and close

  /** Done: a final state, then close {reason: 'done'}. */
  async done(): Promise<void> {
    if (this.status.peek() !== 'open' || this.closing) return;
    this.closing = true;
    await this.stopExport();
    // a state being written goes first, then the last one
    if (this.stateInFlight) await this.stateInFlight.catch(() => false);
    await this.sendState();
    this.finish('done');
  }

  /**
   * Close: close {reason: 'cancel'} (a state first when edits are not sent yet). Pressed while the
   * scene opens, it cancels the open: close goes now, and nothing after it.
   */
  async close(): Promise<void> {
    const st = this.status.peek();
    if (st === 'closed' || this.closing) return;
    if (st === 'opening') {
      this.openCancelled = true;
      this.cancelledOpen = this.opening;
      // no scene opened: from now on, also while the cancelled open still lets go of its scene, a
      // save or an export is answered not_open, and Back to the desk waits for an open
      this.brief.value = null;
      // the open stops where it is: a wait for another desk of this browser, or its staging
      this.deps.workspace.cancelOpen?.();
      this.finish('cancel');
      return;
    }
    this.closing = true;
    await this.stopExport();
    if (st === 'open') {
      if (this.stateInFlight) await this.stateInFlight.catch(() => false);
      if (this.dirty.peek()) await this.sendState();
    }
    this.finish('cancel');
  }

  /** Cancels the running export and waits (at most EXPORT_STOP_WAIT_MS) for its cancelled to go. */
  private async stopExport(): Promise<void> {
    const running = this.exporting;
    if (!running || !this.exportRun.peek()) return;
    this.cancelExport();
    let timer: unknown = null;
    await Promise.race([
      running,
      new Promise<void>((r) => (timer = this.timers.setTimeout(r, EXPORT_STOP_WAIT_MS))),
    ]);
    this.timers.clearTimeout(timer);
  }

  private finish(reason: 'done' | 'cancel'): void {
    this.closing = false;
    if (this.stateTimer !== null) this.timers.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.deps.send({ type: 'close', reason });
    this.status.value = 'closed';
  }

  /**
   * Back to the desk after Done or Close (the host keeps the frame open): nothing is sent now;
   * edits made while it was closed go as a state as usual. With no scene opened, the desk waits for
   * one again.
   */
  reopen(): void {
    if (this.status.peek() !== 'closed') return;
    if (!this.brief.peek()) {
      this.status.value = 'connected';
      return;
    }
    this.status.value = 'open';
    if (this.dirty.peek()) this.scheduleState();
  }

  dispose(): void {
    this.stopEdits?.();
    this.stopEdits = null;
    if (this.stateTimer !== null) this.timers.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (this.changesTimer !== null) this.timers.clearTimeout(this.changesTimer);
    this.changesTimer = null;
    this.stopProgress();
    this.abort?.abort();
  }
}
