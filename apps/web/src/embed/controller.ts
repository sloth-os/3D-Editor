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
  type ResultAckMessage,
} from './protocol';
import { StateTooLarge } from './state';
import type { LengthMismatch, OpenOutcome } from './workspace';

/*
 * The desk's side of the protocol once connected (docs/embedding.md): what it answers and when.
 *
 * - `ready` right after the connect (within 2 s): its version and whether this browser can export
 *   (checked for 1280 × 720 at 24 fps, since ready comes before the brief; each export checks again
 *   at the brief's real size).
 * - `open` once: the scene from the host's state, the local copy or the brief, then `opened` and a
 *   first `state`. A second open is answered with busy. An open that fails (a brief the desk cannot
 *   stage) is answered with invalid_scene and does not count: the host may send another.
 * - `state` after `opened`, after edits (2 s after the last change, at most one every 5 s), when
 *   the person presses Done, and in answer to `save` (with its id).
 * - `export` (and the person's Send, id `desk-<n>`): the brief's shots (those named, else all) in
 *   brief order; progress at most about ten times a second, then `result` (its files
 *   transferred), and an `error` per shot left out (one that failed, or one the brief has that is
 *   not staged yet); bad_message for ids that are no shots of the brief; busy while another export
 *   or an update runs, not_open before the scene is open.
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
}

export interface ControllerDeps {
  /** Sends a message to the host (false when nothing is connected). */
  send(message: DeskMessage, transfer?: Transferable[]): boolean;
  workspace: SceneWorkspace;
  /** Whether this browser can export at a size and rate (export/index.ts browserExportSupport). */
  exportSupport(o: { width: number; height: number; fps: number }): Promise<{ available: boolean; reason: string | null }>;
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

export function resolveOptions(o: OpenMessage['options'] | undefined): DeskOptions {
  const modes = o?.modes?.length ? MODES.filter((m) => o.modes!.includes(m)) : (['camera'] as Mode[]);
  const defaultMode = o?.defaultMode && modes.includes(o.defaultMode) ? o.defaultMode : modes[0];
  return { hostName: o?.hostName?.trim() || 'the host', modes, defaultMode, readOnly: o?.readOnly === true };
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

export type DeskStatus = 'waiting' | 'connected' | 'opening' | 'open' | 'closed';

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
  /** The person's mode (Follow), preselected from the options. */
  readonly mode = signal<Mode>('camera');
  readonly opened = signal<OpenOutcome | null>(null);

  private hostOrigin: string | null = null;
  private deskSeq = 0;
  private abort: AbortController | null = null;
  private stopEdits: (() => void) | null = null;
  private stateTimer: unknown = null;
  private lastChangeAt = 0;
  private lastSentAt = 0;
  private progressTimer: unknown = null;
  private pendingProgress: DeskMessage | null = null;
  private lastProgressAt = 0;
  private readonly timers: NonNullable<ControllerDeps['timers']>;
  private readonly log: NonNullable<ControllerDeps['log']>;

  constructor(private readonly deps: ControllerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.log =
      deps.log ??
      ((level, message) => (level === 'info' ? console.info : console.warn)(`[desk] ${message}`));
  }

  private error(code: ErrorCode, message: string, id?: string): void {
    this.deps.send({ type: 'error', ...(id ? { id } : {}), code, message });
  }

  private tell(level: Notice['level'], message: string): void {
    this.notice.value = { level, message, at: this.timers.now() };
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
      available: typeof g.VideoEncoder === 'function' && typeof g.Worker === 'function' && g.isSecureContext !== false,
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
      case 'save':
        if (this.status.peek() !== 'open' && this.status.peek() !== 'closed')
          return this.error('not_open', 'No scene is open yet: send open first.', m.id);
        void this.sendState(m.id);
        return;
      case 'result-ack':
        this.showAck(m);
        return;
    }
  }

  // ---------------------------------------------------------------- open

  private async open(m: OpenMessage): Promise<void> {
    const st = this.status.peek();
    if (st !== 'connected' && st !== 'waiting') {
      this.error('busy', 'The desk has a scene open already: one open per connection.');
      return;
    }
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
      this.status.value = 'connected';
      this.brief.value = null;
      const message = err instanceof Error ? err.message : String(err);
      this.tell('error', `The scene could not be staged: ${message}`);
      this.error('invalid_scene', `The scene could not be staged: ${message}`);
      return;
    }
    this.opened.value = r;
    this.source.value = r.source;
    this.changes.value = r.changes;
    this.status.value = 'open';
    if (r.unreadable) {
      const text =
        r.source === 'local'
          ? `The stored desk state was not applied (${r.unreadable}); the desk opened its own copy of the scene.`
          : `The stored desk state was not applied (${r.unreadable}); the scene was staged from the brief.`;
      this.tell('warning', text);
      this.error('state_unreadable', text);
    }
    this.deps.send({ type: 'opened', sceneId: m.scene.id, source: r.source, changes: r.changes });
    await this.sendState();
    this.stopEdits = this.deps.workspace.onEdit(() => this.edited());
  }

  // ---------------------------------------------------------------- state

  private edited(): void {
    this.dirty.value = true;
    this.lastChangeAt = this.timers.now();
    this.scheduleState();
  }

  private scheduleState(): void {
    if (this.stateTimer !== null) return;
    const now = this.timers.now();
    const at = Math.max(this.lastChangeAt + STATE_QUIET_MS, this.lastSentAt + STATE_MIN_INTERVAL_MS);
    this.stateTimer = this.timers.setTimeout(() => {
      this.stateTimer = null;
      const t = this.timers.now();
      if (t - this.lastChangeAt < STATE_QUIET_MS || t - this.lastSentAt < STATE_MIN_INTERVAL_MS) {
        this.scheduleState();
        return;
      }
      void this.sendState();
    }, Math.max(0, at - now));
  }

  /** Sends the scene's state (in answer to save `id` when given). */
  async sendState(id?: string): Promise<boolean> {
    const brief = this.brief.peek();
    if (!brief) return false;
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
      // out_of_memory: the closest code the contract has for a state too large to hand over
      this.error(err instanceof StateTooLarge ? 'out_of_memory' : 'export_failed', message, id);
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
      this.tell('error', `The shots could not be updated: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.updating.value = false;
    }
  }

  // ---------------------------------------------------------------- export

  private async hostExport(m: ExportMessage): Promise<void> {
    if (this.status.peek() !== 'open') return this.error('not_open', 'No scene is open yet: send open first.', m.id);
    if (this.exportRun.peek() || this.updating.peek())
      return this.error(
        'busy',
        this.exportRun.peek() ? 'The desk is exporting already: one export at a time.' : 'The desk is updating its shots.',
        m.id,
      );
    const plan = this.exportShots(m.shots);
    if (plan.unknown.length)
      return this.error('bad_message', `Not shots of this scene's brief: ${plan.unknown.join(', ')}.`, m.id);
    const options = this.options.peek();
    await this.runExport({
      id: m.id,
      by: 'host',
      ...plan,
      modes: m.modes?.length ? MODES.filter((x) => m.modes!.includes(x)) : options.modes,
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
  private exportShots(asked?: readonly string[]): { shots: string[]; notStaged: string[]; unknown: string[] } {
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

  /** The person's Send: every mode the host takes, every shot of the brief, with stills. */
  async sendToHost(): Promise<string | null> {
    if (this.status.peek() !== 'open' || this.exportRun.peek() || this.updating.peek()) return null;
    const id = `desk-${++this.deskSeq}`;
    const { shots, notStaged } = this.exportShots();
    await this.runExport({ id, by: 'desk', shots, notStaged, modes: this.options.peek().modes, still: true });
    return id;
  }

  /** Cancels the running export (the person's Cancel or the host's cancel). */
  cancelExport(): void {
    this.abort?.abort();
  }

  private progress(p: { id: string; phase: Phase; done: number; total: number; shotId?: string }): void {
    const run = this.exportRun.peek();
    if (run && run.id === p.id) this.exportRun.value = { ...run, ...p };
    const msg: DeskMessage = { type: 'progress', ...p };
    const now = this.timers.now();
    // at most one message per PROGRESS_INTERVAL_MS; the latest one waiting goes when it ends
    if (this.lastProgressAt === 0 || now - this.lastProgressAt >= PROGRESS_INTERVAL_MS) {
      this.flushProgress(msg);
      return;
    }
    this.pendingProgress = msg;
    if (this.progressTimer === null)
      this.progressTimer = this.timers.setTimeout(
        () => {
          this.progressTimer = null;
          if (this.pendingProgress) this.flushProgress(this.pendingProgress);
        },
        PROGRESS_INTERVAL_MS - (now - this.lastProgressAt),
      );
  }

  private flushProgress(msg: DeskMessage): void {
    this.pendingProgress = null;
    this.lastProgressAt = this.timers.now();
    this.deps.send(msg);
  }

  private stopProgress(): void {
    if (this.progressTimer !== null) this.timers.clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.pendingProgress = null;
    this.lastProgressAt = 0;
  }

  private async runExport(o: {
    id: string;
    by: 'desk' | 'host';
    /** The staged shots to render, in brief order. */
    shots: string[];
    /** The brief's shots asked for that are not staged: left out, each named in an error. */
    notStaged: string[];
    modes: Mode[];
    still: boolean;
  }): Promise<void> {
    const brief = this.brief.peek()!;
    const options = this.options.peek();
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
    // the brief's shots the staging does not have: left out, each named like a shot that failed
    const notStaged = o.notStaged.map(
      (id) => `${id}: the shot is in the brief but not staged in the desk yet (Update shots stages it).`,
    );
    let outcome: DeskExportOutcome | null = null;
    try {
      const size = exportSizeProblem(brief.width, brief.height);
      if (size) return fail('export_unavailable', size);
      const support = await this.deps.exportSupport({ width: brief.width, height: brief.height, fps: brief.fps });
      if (!support.available)
        return fail('export_unavailable', support.reason ?? 'This browser cannot encode the clips.');
      this.progress({ id: o.id, phase: 'prepare', done: 0, total: 1 });
      const update = this.deps.workspace.snapshot();
      if (!o.shots.length)
        return fail('export_failed', notStaged.join(' ') || 'The scene has no staged shots to export.');
      const results = await this.deps.workspace.results(update, o.shots);
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
      };
      outcome = await (this.deps.runExport ?? runDeskExport)(req, {
        signal: abort.signal,
        onProgress: (p: DeskExportProgress) => this.progress({ id: o.id, ...p }),
      });
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
      this.deps.send(message, outcome.files.map((f) => f.data));
      // the shots left out, each named in an error after the result (the result never waits for them)
      for (const f of outcome.failures) this.error(f.code, f.message, o.id);
      for (const m of notStaged) this.error('export_failed', m, o.id);
      const left = [...outcome.failures.map((f) => f.message), ...notStaged];
      if (left.length)
        this.tell('warning', `Sent ${count} shot${count === 1 ? '' : 's'}; ${left.length} left out: ${left.join(' ')}`);
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
    const refused = (m.shots ?? []).filter((s) => !s.ok).map((s) => ({ shotId: s.shotId, error: s.error ?? 'refused' }));
    this.ack.value = {
      id: m.id,
      ok: m.ok,
      message: m.message ?? (m.ok ? `${this.options.peek().hostName} took the result.` : `${this.options.peek().hostName} refused the result.`),
      refused,
      at: this.timers.now(),
    };
  }

  // ---------------------------------------------------------------- done and close

  /** Done: a final state, then close {reason: 'done'}. */
  async done(): Promise<void> {
    if (this.status.peek() !== 'open') return;
    if (this.exportRun.peek()) this.cancelExport();
    await this.sendState();
    this.finish('done');
  }

  /** Close: close {reason: 'cancel'} (a state first when edits are not sent yet). */
  async close(): Promise<void> {
    const st = this.status.peek();
    if (st === 'closed') return;
    if (this.exportRun.peek()) this.cancelExport();
    if (st === 'open' && this.dirty.peek()) await this.sendState();
    this.finish('cancel');
  }

  private finish(reason: 'done' | 'cancel'): void {
    if (this.stateTimer !== null) this.timers.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.deps.send({ type: 'close', reason });
    this.status.value = 'closed';
  }

  /** Back to the desk after Done or Close (the host keeps the frame open): nothing is sent. */
  reopen(): void {
    if (this.status.peek() === 'closed') this.status.value = this.brief.peek() ? 'open' : 'connected';
  }

  dispose(): void {
    this.stopEdits?.();
    this.stopEdits = null;
    if (this.stateTimer !== null) this.timers.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.stopProgress();
    this.abort?.abort();
  }
}
