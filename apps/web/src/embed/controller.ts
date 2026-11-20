import { computed, signal } from '@preact/signals';
import {
  briefWithoutPins,
  type BriefChanges,
  type BriefUnitPin,
  type SceneBrief,
  type ShotResultMeta,
  type StageUnitRow,
  type UnitHeader,
  type UnitKind,
  type UnitPublishMeta,
  type UnitSlot,
} from '@3d-editor/core';
import {
  DeskExportError,
  exportSizeProblem,
  runDeskExport,
  type DeskExportOutcome,
  type DeskExportProgress,
  type DeskExportRequest,
} from './export';
import {
  MAX_UNIT_BYTES,
  MODES,
  UNIT_DATA_FORMAT,
  UNIT_DATA_VERSION,
  UNIT_KINDS,
  acceptUnits,
  deskMessageProblems,
  publishAckTimeoutMs,
  uniqueModes,
  type DeskMessage,
  type DeskState,
  type ErrorCode,
  type ExportMessage,
  type GivenState,
  type HostMessage,
  type HostMessageType,
  type Mode,
  type OpenMessage,
  type OpenSource,
  type Phase,
  type ProgressMessage,
  type ProtocolBriefChanges,
  type ResultAckMessage,
  type StateUnit,
  type UnitAckMessage,
  type UnitPublishMessage,
  type UnitsOption,
} from './protocol';
import type { UnitExtract, UnitTarget } from './staging-engine';
import { StateTooLarge } from './state';
import {
  protocolFrom,
  readOpenUnits,
  unitNotice,
  type LibraryRow,
  type SaveTarget,
  type UnitIntake,
} from './units';
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
 *
 * Library units (docs/embedding.md "Library units"): ready always says what the desk does with them
 * (capabilities.units). The host turns them on for one open with options.units (acceptUnits; absent
 * or unreadable: off, logged when it was given or the brief has pins or open.units came, an
 * unreadable one with the shape the desk reads). With units off nothing of them happens: the
 * brief's pins are stripped before staging (briefWithoutPins), `open.units` is not read, no state
 * carries `units` and no unit-publish goes: the host sees today's traffic. With units on the open's
 * files are checked (units.ts readOpenUnits) and staged, every state carries `units` (the record's
 * pins, per slot), the Library tab's rows follow the scene (libraryRows), and with `publish` the
 * person can save the set, an actor's figure or a prop to the host's library (publish):
 * unit-publish, then the wait for its unit-ack (120 s plus 10 s per MiB; an invalid ack ends it at
 * once), then, when the host linked it and the open is editable, the scene adopts the version (not
 * an undo step, and Ctrl+Z does not go back past it) and follows the pin the host moved. The
 * adoption waits for an Update shots running (each is a write of the scene, one at a time:
 * workspace.ts queueWrite), and no Update shots starts while the scene links.
 */

/** What the controller needs of the scene (DeskWorkspace; tests give a fake one). */
export interface SceneWorkspace {
  open(o: {
    hostOrigin: string;
    brief: SceneBrief;
    state: GivenState | null;
    /** The open's library units (only when units are on for it). */
    units?: UnitIntake | null;
  }): Promise<OpenOutcome>;
  /** The state, and the rows of state.units of the same document (sent after an open with units only). */
  encodeState(): Promise<{ state: DeskState; shots: number; units?: StateUnit[] }>;
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
  // ---- library units (DeskWorkspace has them all; a workspace without them has no units work)
  /** The brief's pins as the last staging or Update shots left them (core's report.units). */
  unitRows?(): StageUnitRow[] | null;
  /** The Library tab's rows (units.ts libraryRows). */
  libraryRows?(): LibraryRow[];
  /** What Save to library can save (units.ts saveTargets). */
  saveTargets?(): SaveTarget[];
  /** The target the Save dialog starts with for the selected object (units.ts defaultSaveTarget). */
  defaultSaveTarget?(selected: string | null): SaveTarget | null;
  /** A unit of the scene with its thumbnail (read only). */
  extractUnit?(what: UnitTarget, name: string): Promise<UnitExtract>;
  /**
   * Links the scene to the version the host saved (not an undo step; Ctrl+Z does not go back past
   * it), after the scene's writes queued before it; `follow` becomes the brief the scene follows in
   * the same turn when the record pins the version.
   */
  adoptUnit?(
    unit: Pick<UnitExtract, 'link' | 'from' | 'header'>,
    pin: BriefUnitPin,
    linked: boolean,
    follow?: SceneBrief | null,
  ): Promise<{ root: string; recorded: boolean; warnings: string[] }>;
  /** Make local (one undo step). */
  makeLocal?(root: string): Promise<{ root: string; parts: number }>;
  /** Sets the brief the scene follows. */
  setBrief?(brief: SceneBrief): void;
  /** The document's revision (an extraction is of one revision). */
  revision?(): number;
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
  /** The SHA-256 the open's unit files are checked with (units.ts sha256Hex by default). */
  sha256?: (bytes: Uint8Array) => Promise<string>;
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

/** What the desk says of a library unit saved to the host's library (publish). */
export type PublishResult =
  | {
      ok: true;
      /** The host's item and the version it saved. */
      ref: string;
      version: number;
      /** The host linked it to the scene's slot (it pins it from now on). */
      linked: boolean;
      /** The scene became an instance of the version (linked, the open editable and still open). */
      adopted: boolean;
      /** The host's message, or why a linked unit was not adopted. */
      message?: string;
    }
  | {
      ok: false;
      /**
       * The host's refusal code (PUBLISH_REFUSALS, read leniently), or the desk's own: 'timeout' (no
       * answer in time), 'bad_reply' (an invalid unit-ack), 'closed' (the desk closed first),
       * 'unavailable' (units or publishing are off, no host), 'not_open', 'busy' (another save runs),
       * 'invalid' (a name or description the protocol does not take), 'failed' (the unit could not
       * be made or sent).
       */
      code: string;
      message: string;
    };

/** A Save to library in progress. */
export interface PublishProgress {
  kind: UnitKind | null;
  name: string;
  /** Making the unit and its thumbnail, waiting for the host's answer, linking the scene. */
  phase: 'extracting' | 'waiting' | 'linking';
  startedAt: number;
  /** The unit-publish's id once sent. */
  id: string | null;
}

/** The last Save to library and what came of it. */
export interface PublishOutcome {
  result: PublishResult;
  kind: UnitKind | null;
  name: string;
  at: number;
}

/** What the Save to library dialog shows before saving (previewUnit). */
export interface UnitPreview {
  kind: UnitKind;
  name: string;
  /** The library version it would be a new version of (the instance it is), else null. */
  basedOn: { ref: string; version: number } | null;
  /** The brief slot it comes from, in the protocol's shape (null: none). */
  from: { castId: string | null; elementId: string | null; set: boolean } | null;
  counts: UnitHeader['counts'];
  /** The protocol meta: size, objects, triangles, the figure's kind and height, credits. */
  meta: UnitPublishMeta;
  /** Bytes of the unit file. */
  bytes: number;
  /** Its thumbnail (a PNG of at most 64 KiB, a copy the dialog may keep), else null. */
  thumbnail: Uint8Array | null;
  warnings: string[];
}

/** The options.units this desk reads (protocol.ts UnitsOptionSchema), as the log names it. */
const UNITS_OPTION_SHAPE = '{version: 1, publish: boolean}';

/** The library pins a brief carries (its set's, its cast members' and its elements'). */
const pinCount = (b: SceneBrief): number =>
  (b.set?.unit ? 1 : 0) +
  (b.cast ?? []).filter((c) => c.unit).length +
  (b.elements ?? []).filter((e) => e.unit).length;

/** What a unit-publish waits for. */
type AckOutcome =
  | { kind: 'ack'; message: UnitAckMessage }
  | { kind: 'invalid'; problems: string }
  | { kind: 'timeout' }
  | { kind: 'closed' };

/** An ArrayBuffer holding exactly `bytes` (the view's own buffer when it is all of it). */
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);

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
  /** The library units of this open (null: off, as for a host without them). */
  readonly units = signal<UnitsOption | null>(null);
  /** Whether Save to library is offered: units on with `publish`, the scene open. */
  readonly canPublish = computed(() => this.units.value?.publish === true && this.status.value === 'open');
  /** The Library tab's rows (after the open, edits, Update shots, a link and Make local; [] with units off). */
  readonly libraryRows = signal<LibraryRow[]>([]);
  /** A Save to library in progress (null: none). */
  readonly publishing = signal<PublishProgress | null>(null);
  /** The last Save to library's outcome. */
  readonly lastPublish = signal<PublishOutcome | null>(null);

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
  /** The running Update shots (settles, never rejects): a linked save waits for it before linking. */
  private updateRun: Promise<void> | null = null;
  /** Done or Close is sending its last state. */
  private closing = false;
  private progressTimer: unknown = null;
  private pendingProgress: ProgressMessage | null = null;
  private lastProgressAt = 0;
  /** Save to library's ids ('pub-<n>'). */
  private pubSeq = 0;
  /** The unit-publish messages waiting for their unit-ack, by id. */
  private readonly acks = new Map<string, (r: AckOutcome) => void>();
  /** The last extraction the Save dialog previewed (reused by publish while the scene is unchanged). */
  private preview: { key: string; revision: number; unit: UnitExtract } | null = null;
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
        // library units: a desk with them always says so; nothing else of them goes unless the
        // host's open turns them on (options.units)
        units: { versions: [1], kinds: [...UNIT_KINDS], maxBytes: MAX_UNIT_BYTES, publish: true },
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
      case 'unit-ack':
        this.unitAck(m);
        return;
    }
  }

  /**
   * An invalid reply of the host to one of the desk's requests, with that request's id (the bridge
   * has answered it bad_message): a unit-publish waiting for it fails at once.
   */
  invalidReply(type: HostMessageType, id: string, problems: string): void {
    if (type !== 'unit-ack') return;
    const waiter = this.acks.get(id);
    if (waiter) waiter({ kind: 'invalid', problems });
  }

  private unitAck(m: UnitAckMessage): void {
    const waiter = this.acks.get(m.id);
    // a late answer (after the wait) or one of no publish of this desk is not applied
    if (!waiter) return this.log('info', `ignored a unit-ack of '${m.id}': no unit waits for it`);
    waiter({ kind: 'ack', message: m });
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
    // library units for this open: on only when the host's options.units reads; off, the brief's
    // pins are stripped (staged as though the host never sent them) and open.units is not read
    const units = acceptUnits(m.options?.units);
    this.units.value = units;
    this.libraryRows.value = [];
    this.preview = null;
    const pinned = pinCount(m.scene);
    // a brief without pins stays the very brief the host sent (units on or off)
    const brief = units || !pinned ? m.scene : briefWithoutPins(m.scene);
    // logged when the host sent an options.units this desk does not read, or left it out with pins
    // or open.units (a host from before units with neither: nothing to say)
    const given = m.options?.units !== undefined;
    if (!units && (given || pinned || m.units !== undefined))
      this.log(
        'info',
        `library units are off for this open (${given ? `an options.units this desk does not read: it reads ${UNITS_OPTION_SHAPE}` : 'no options.units'}): ${pinned} pin(s) staged from the words, open.units not read`,
      );
    this.brief.value = brief;
    let intake: UnitIntake | null = null;
    if (units) {
      intake = await readOpenUnits(m.units, brief, this.deps.sha256 ? { hash: this.deps.sha256 } : {});
      for (const i of intake.ignored) this.log('warn', `open.units[${i.index}] left out: ${i.reason}`);
      // Close while the files were checked: the open is cancelled before anything is opened
      if (this.openCancelled) {
        this.openCancelled = false;
        this.brief.value = null;
        return;
      }
    }
    let r: OpenOutcome;
    try {
      r = await this.deps.workspace.open({
        hostOrigin: this.hostOrigin ?? 'null',
        brief,
        state: m.state,
        ...(units ? { units: intake } : {}),
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
    // library units the staging did not use (not sent, refused …): staged from the words
    const missed = units && r.units ? unitNotice(r.units, brief) : null;
    if (missed) notices.push(missed);
    if (notices.length) this.tell('warning', notices.join(' '));
    this.refreshLibrary();
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
      this.refreshLibrary();
    }, CHANGES_QUIET_MS);
  }

  /** The Library tab's rows as the scene has them now ([] with units off). */
  private refreshLibrary(): void {
    if (!this.units.peek() || !this.brief.peek()) {
      if (this.libraryRows.peek().length) this.libraryRows.value = [];
      return;
    }
    let rows: LibraryRow[];
    try {
      rows = this.deps.workspace.libraryRows?.() ?? [];
    } catch {
      return;
    }
    if (JSON.stringify(rows) !== JSON.stringify(this.libraryRows.peek())) this.libraryRows.value = rows;
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
    let encoded: { state: DeskState; shots: number; units?: StateUnit[] };
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
      {
        type: 'state',
        ...(id ? { id } : {}),
        sceneId: brief.id,
        state: encoded.state,
        shots: encoded.shots,
        // after an open with units only: what the scene holds of each pinned slot
        ...(this.units.peek() ? { units: encoded.units ?? [] } : {}),
      },
      [encoded.state.data],
    );
    return true;
  }

  // ---------------------------------------------------------------- update from the brief

  /**
   * Updates the shots to the brief (Update shots): one undo step. Not while a saved unit is being
   * linked (the banner's button is off then): the update would have to wait for it anyway.
   */
  updateShots(): Promise<void> {
    if (this.status.peek() !== 'open' || this.updating.peek() || this.exportRun.peek())
      return Promise.resolve();
    if (this.options.peek().readOnly || this.publishing.peek()?.phase === 'linking') return Promise.resolve();
    const run = this.runUpdateShots();
    this.updateRun = run;
    const settled = () => {
      if (this.updateRun === run) this.updateRun = null;
    };
    run.then(settled, settled);
    return run;
  }

  private async runUpdateShots(): Promise<void> {
    this.updating.value = true;
    try {
      this.changes.value = await this.deps.workspace.updateFromBrief();
      const brief = this.brief.peek();
      const rows = this.units.peek() ? (this.deps.workspace.unitRows?.() ?? null) : null;
      const missed = rows && brief ? unitNotice(rows, brief) : null;
      if (missed) this.tell('warning', `The shots were updated to the brief (Ctrl+Z undoes it). ${missed}`);
      else this.tell('info', 'The shots were updated to the brief (Ctrl+Z undoes it).');
    } catch (err) {
      this.tell(
        'error',
        `The shots could not be updated: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.updating.value = false;
      this.refreshLibrary();
    }
  }

  // ---------------------------------------------------------------- library units

  /** What Save to library can save of the scene: the set, each actor, each prop ([] without a scene). */
  saveTargets(): SaveTarget[] {
    if (!this.brief.peek()) return [];
    try {
      return this.deps.workspace.saveTargets?.() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The target the Save dialog starts with: the one the object `selected` belongs to (the editor's
   * active object), else the set; null without a scene.
   */
  defaultSaveTarget(selected: string | null): SaveTarget | null {
    if (!this.brief.peek()) return null;
    try {
      return this.deps.workspace.defaultSaveTarget?.(selected) ?? this.saveTargets()[0] ?? null;
    } catch {
      return null;
    }
  }

  /** The key of an extraction: what and its name. */
  private static extractKey(what: UnitTarget, name: string): string {
    return `${'set' in what ? 'set' : `root:${what.root}`}\n${name}`;
  }

  /**
   * Makes the unit `what` named `name` (the extraction the dialog previewed, while the scene has not
   * changed since; it is used once, as publishing hands its buffers over).
   */
  private async extract(what: UnitTarget, name: string, keep: boolean): Promise<UnitExtract> {
    const ws = this.deps.workspace;
    if (!ws.extractUnit) throw new Error('this desk cannot make library units');
    const key = DeskController.extractKey(what, name);
    const revision = ws.revision?.() ?? -1;
    const cached = this.preview;
    if (cached && cached.key === key && cached.revision === revision && revision >= 0) {
      if (!keep) this.preview = null;
      return cached.unit;
    }
    const unit = await ws.extractUnit(what, name);
    this.preview = keep ? { key, revision, unit } : null;
    return unit;
  }

  /**
   * What the Save to library dialog shows for `what` named `name` before saving: the unit's kind,
   * the version it would be a new version of, the slot it comes from, its counts, meta, size,
   * thumbnail and warnings. Read only; rejects when the unit cannot be made (its reason).
   */
  async previewUnit(what: UnitTarget, name: string): Promise<UnitPreview> {
    const unit = await this.extract(what, name.trim(), true);
    return {
      kind: unit.header.kind,
      name: unit.header.name,
      basedOn: unit.basedOn,
      from: protocolFrom(unit.from),
      counts: unit.header.counts,
      meta: unit.meta,
      bytes: unit.data.byteLength,
      thumbnail: unit.thumbnail ? unit.thumbnail.slice() : null,
      warnings: [...unit.warnings],
    };
  }

  /** Waits for the unit-ack of `id` for at most `ms`. */
  private waitForAck(id: string, ms: number): { done: Promise<AckOutcome>; cancel(): void } {
    let resolve!: (r: AckOutcome) => void;
    const done = new Promise<AckOutcome>((r) => (resolve = r));
    const timer = this.timers.setTimeout(() => settle({ kind: 'timeout' }), ms);
    const settle = (r: AckOutcome) => {
      if (!this.acks.has(id)) return;
      this.acks.delete(id);
      this.timers.clearTimeout(timer);
      resolve(r);
    };
    this.acks.set(id, settle);
    return { done, cancel: () => settle({ kind: 'closed' }) };
  }

  /** The brief with `pin` on `slot` (the host moved it: a linked publish); null when the slot is not the brief's. */
  private static briefWithPin(brief: SceneBrief, slot: UnitSlot, pin: BriefUnitPin): SceneBrief | null {
    const next = structuredClone(brief);
    const unit = { ref: pin.ref, version: pin.version, sha256: pin.sha256 };
    if ('set' in slot) next.set = { ...next.set, unit };
    else if ('castId' in slot) {
      const c = next.cast.find((x) => x.id === slot.castId);
      if (!c) return null;
      c.unit = unit;
    } else {
      const e = next.elements.find((x) => x.id === slot.elementId && x.kind !== 'location');
      if (!e) return null;
      e.unit = unit;
    }
    return next;
  }

  /**
   * Save to library: makes the unit of `what` (the set, an actor's figure or a prop) named `name`,
   * sends it to the host (unit-publish, its file and thumbnail transferred; as a new version of the
   * instance it is with `asNewVersion`) and waits for the host's unit-ack: 120 s plus 10 s per MiB of
   * the file (an invalid ack ends the wait at once; a later one is not applied). When the host saved
   * and linked it and the open is editable and still open, the scene becomes an instance of the
   * version (not an undo step) and the brief follows the pin the host moved. Only with units on and
   * `publish`; a read-only open publishes but never links. Resolves with what came of it (also kept
   * in lastPublish); never rejects.
   */
  async publish(p: {
    what: UnitTarget;
    name: string;
    description?: string;
    asNewVersion?: boolean;
  }): Promise<PublishResult> {
    const name = p.name.trim();
    const host = this.options.peek().hostName;
    let kind: UnitKind | null = null;
    const finish = (result: PublishResult): PublishResult => {
      this.lastPublish.value = { result, kind, name, at: this.timers.now() };
      return result;
    };
    const fail = (code: string, message: string) => finish({ ok: false, code, message });
    const units = this.units.peek();
    if (!units) return fail('unavailable', `${host} did not turn on library units for this scene.`);
    if (!units.publish) return fail('unavailable', `${host} does not take units saved to its library here.`);
    if (this.status.peek() !== 'open') return fail('not_open', 'No scene is open.');
    if (this.publishing.peek()) return fail('busy', 'Another unit is being saved to the library.');
    if (!name || name.length > 120) return fail('invalid', 'A unit needs a name of 1 to 120 characters.');
    if (p.description !== undefined && p.description.length > 2000)
      return fail('invalid', 'A unit’s description is at most 2000 characters.');
    this.publishing.value = { kind: null, name, phase: 'extracting', startedAt: this.timers.now(), id: null };
    try {
      let unit: UnitExtract;
      try {
        unit = await this.extract(p.what, name, false);
      } catch (err) {
        return fail(
          'failed',
          `The unit could not be made: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      kind = unit.header.kind;
      const id = `pub-${++this.pubSeq}`;
      const from = protocolFrom(unit.from);
      const description = p.description?.trim();
      const message: UnitPublishMessage = {
        type: 'unit-publish',
        id,
        kind,
        name: unit.header.name,
        ...(description ? { description } : {}),
        ...(p.asNewVersion && unit.basedOn ? { newVersionOf: { ...unit.basedOn } } : {}),
        ...(from ? { from } : {}),
        unit: { format: UNIT_DATA_FORMAT, version: UNIT_DATA_VERSION, data: exactBuffer(unit.data) },
        sha256: unit.sha256,
        thumbnail: unit.thumbnail ? { mime: 'image/png', data: exactBuffer(unit.thumbnail) } : null,
        meta: unit.meta,
      };
      const problem = deskMessageProblems(message);
      if (problem) return fail('invalid', `The unit could not be sent: ${problem}`);
      const wait = this.waitForAck(id, publishAckTimeoutMs(message.unit.data.byteLength));
      const transfer: Transferable[] = [
        message.unit.data,
        ...(message.thumbnail ? [message.thumbnail.data] : []),
      ];
      if (!this.deps.send(message, transfer)) {
        wait.cancel();
        return fail('unavailable', 'No host is connected.');
      }
      this.publishing.value = { ...this.publishing.peek()!, kind, phase: 'waiting', id };
      const answer = await wait.done;
      if (answer.kind === 'timeout')
        return fail('timeout', `${host} did not say whether it saved '${unit.header.name}'.`);
      if (answer.kind === 'closed') return fail('closed', 'The desk closed before the host answered.');
      if (answer.kind === 'invalid')
        return fail('bad_reply', `${host}'s answer was not valid: ${answer.problems}`);
      const ack = answer.message;
      if (!ack.ok)
        return fail(ack.code ?? 'failed', ack.message ?? `${host} did not save '${unit.header.name}'.`);
      const pin = { ref: ack.ref!, version: ack.version!, sha256: unit.sha256 };
      const linked = ack.linked === true;
      let adopted = false;
      let note = ack.message;
      const ws = this.deps.workspace;
      if (linked) {
        // an Update shots running ends first (no other starts while the scene links): the adoption
        // is of the scene it leaves, and the open may have closed meanwhile
        if (!this.options.peek().readOnly && this.status.peek() === 'open' && ws.adoptUnit) {
          this.publishing.value = { ...this.publishing.peek()!, phase: 'linking' };
          await this.updateRun;
        }
        if (this.options.peek().readOnly) note = 'The scene is read-only here: it stays as it is.';
        else if (this.status.peek() !== 'open' || !ws.adoptUnit)
          note = 'The desk was closed: the next open brings the link.';
        else {
          try {
            // the host pins the version from now on (its next brief says so): the scene follows,
            // in the adoption's turn, so that no write queued after it reads the brief without it
            const brief = this.brief.peek();
            const follow = brief && unit.from ? DeskController.briefWithPin(brief, unit.from, pin) : null;
            const r = await ws.adoptUnit(unit, pin, true, follow);
            adopted = true;
            if (r.recorded && follow) {
              this.brief.value = follow;
              ws.setBrief?.(follow);
            }
          } catch (err) {
            note = `${host} saved and linked it, but the scene could not be linked to it here: ${err instanceof Error ? err.message : String(err)}`;
          }
          this.refreshChanges();
          this.refreshLibrary();
        }
      }
      return finish({
        ok: true,
        ref: pin.ref,
        version: pin.version,
        linked,
        adopted,
        ...(note ? { message: note } : {}),
      });
    } finally {
      this.publishing.value = null;
    }
  }

  /**
   * Make local: the library unit instance `root` keeps its objects as plain ones of the scene (one
   * undo step); its slot stays local (the record keeps its pin; staging never places a unit there
   * again). Refused while read-only or no scene is open.
   */
  async makeLocal(root: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const ws = this.deps.workspace;
    if (this.status.peek() !== 'open') return { ok: false, message: 'No scene is open.' };
    if (this.options.peek().readOnly) return { ok: false, message: 'The scene is read-only here.' };
    if (!ws.makeLocal) return { ok: false, message: 'This desk cannot make library units local.' };
    try {
      await ws.makeLocal(root);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.refreshChanges();
      this.refreshLibrary();
    }
    return { ok: true };
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
    // a Save to library waiting for its ack ends: the desk is gone
    for (const settle of [...this.acks.values()]) settle({ kind: 'closed' });
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
