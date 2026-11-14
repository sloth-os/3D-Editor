import { AsyncLocalStorage } from 'node:async_hooks';
import * as Y from 'yjs';
import {
  colorForName,
  createEditorState,
  isValidProjectId,
  type EditorState,
  type OperatorContext,
  type OperatorError,
  type OperatorRegistry,
  type PresenceState,
  type ReportLevel,
  type RunResult,
} from '@3d-editor/core';
import { settlesBefore, type Room } from '../sync/room';
import type { NamedProject, RoomManager, StoredNames } from '../sync/room-manager';
import type { Log } from '../observability/log';
import { randomClientId } from '../sync/awareness';
import { toolOnlyOperator } from './operator-groups';
import { AgentHistory, type HistoryLimits } from './history';
import { listForName } from './project-storage';

/**
 * Kind of a failure, as the core operator registry reports operator failures (OperatorError):
 * INVALID_PARAMS, POLL_FAILED, NOT_FOUND or FAILED. run_operator, batch and edit_mesh return it
 * as `code` with every failure.
 */
export type ErrorCode = OperatorError['code'];

/**
 * Kinds of failure of the server's services, which no operator reports (so they are codes of
 * {@link ToolError} only, never of core OperatorError): a service that is not available
 * (UNAVAILABLE: not implemented yet, not configured, or the server renders on its main thread),
 * video export without ffmpeg (FFMPEG_UNAVAILABLE), a model store provider that needs an API key
 * the server does not have (NEEDS_KEY), a model whose licence or provider does not allow
 * downloading it (NOT_DOWNLOADABLE), a full export queue (QUEUE_FULL) and an outside service (a
 * model provider, rideo) that failed or did not answer (UPSTREAM).
 */
export type ServiceErrorCode =
  'UNAVAILABLE' | 'FFMPEG_UNAVAILABLE' | 'NEEDS_KEY' | 'NOT_DOWNLOADABLE' | 'QUEUE_FULL' | 'UPSTREAM';

/** The code of a {@link ToolError}: an operator failure's kind or a service's. */
export type ToolErrorCode = ErrorCode | ServiceErrorCode;

/** Every {@link ServiceErrorCode}. */
export const SERVICE_ERROR_CODES: readonly ServiceErrorCode[] = [
  'UNAVAILABLE',
  'FFMPEG_UNAVAILABLE',
  'NEEDS_KEY',
  'NOT_DOWNLOADABLE',
  'QUEUE_FULL',
  'UPSTREAM',
];

export function isServiceErrorCode(code: unknown): code is ServiceErrorCode {
  return SERVICE_ERROR_CODES.includes(code as ServiceErrorCode);
}

/**
 * The JSON a tool's failure carries on the line after its message: `{code}` for OUT_OF_MEMORY and
 * the service codes, which agents branch on (retry later, configure a key, lower a size); the
 * message of every other failure stays a line of its own.
 */
export function codedErrorDetails(code: ToolErrorCode | undefined): { code: ToolErrorCode } | undefined {
  return code === 'OUT_OF_MEMORY' || isServiceErrorCode(code) ? { code } : undefined;
}

/**
 * Errors with a message meant for the agent (returned as `isError` tool results). `code` is the
 * kind of failure where the thrower knows it (a selection that cannot be applied: POLL_FAILED;
 * unknown things: {@link NotFoundError}; a service's: {@link ServiceErrorCode}).
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code?: ToolErrorCode,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Something the agent named does not exist (a project, an object): code NOT_FOUND. */
export class NotFoundError extends ToolError {
  constructor(message: string) {
    super(message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export interface AgentDeps {
  rooms: RoomManager;
  registry: OperatorRegistry;
  log: Log;
  /** Limits of the undo history of each agent and project (see {@link AgentHistory}). */
  history?: Partial<HistoryLimits>;
}

/**
 * Why a lookup of a project by name (AgentSession.findProject) compared its name with only some of
 * the projects: listing the projects in storage failed ('failed'), reading the project.json of some
 * of them failed ('partial'), or storage did not answer in time ('late'); or why it compared the
 * projects in storage as an earlier listing found them: storage took longer than requests wait for
 * it the last time it listed them ('slow').
 */
type Unlisted = 'failed' | 'partial' | 'late' | 'slow';

/** What a lookup by name that could not compare every project compared, as its notes say it. */
function compared(why: Unlisted, waitMs: number, ageMs = 0): string {
  if (why === 'partial')
    return "reading the project.json of some projects in storage failed (the server logged 'listing projects failed'), so those projects were not compared";
  if (why === 'slow')
    return `storage took longer than ${waitMs / 1000} s to list its projects, so the projects in storage were compared as it listed them ${ageMs < 1000 ? 'less than 1' : Math.round(ageMs / 1000)} s ago`;
  const reason =
    why === 'failed'
      ? "listing the projects in storage failed (the server logged 'listing projects failed')"
      : `storage did not answer within ${waitMs / 1000} s`;
  return `${reason}, so only the projects this server has loaded were compared`;
}

/**
 * The projects named `name` among `projects`: those with that exact name, else those whose name
 * matches it ignoring letter case.
 */
function matching<P extends { name: string }>(projects: P[], name: string): P[] {
  const exact = projects.filter((p) => p.name === name);
  return exact.length > 0 ? exact : projects.filter((p) => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * The id of the project named `name` among `projects` (an exact match first, else one ignoring
 * letter case); null when none is; a {@link ToolError} when several are (which says so when the
 * lookup could not compare every project, `unlisted`).
 */
function projectNamed(
  projects: { id: string; name: string }[],
  name: string,
  unlisted?: { why: Unlisted; waitMs: number; ageMs?: number },
): string | null {
  const matches = matching(projects, name);
  if (matches.length > 1) {
    const which = unlisted ? compared(unlisted.why, unlisted.waitMs, unlisted.ageMs) : '';
    throw new ToolError(
      `Several projects are named '${name}': ${matches.map((m) => m.id).join(', ')}. Pass the project id instead.` +
        (which ? ` ${which[0].toUpperCase()}${which.slice(1)}.` : ''),
    );
  }
  return matches[0]?.id ?? null;
}

/**
 * The note of a project found by a name that was not compared with every project (see
 * AgentSession.findProject): another project may have the name too.
 */
function foundWithout(name: string, id: string, why: Unlisted, waitMs: number, ageMs = 0): string {
  const others =
    why === 'partial'
      ? 'one of those'
      : why === 'slow'
        ? 'a project stored or renamed since then'
        : 'a project that is only in storage';
  return `Project '${name}' was found by name, but ${compared(why, waitMs, ageMs)}: ${others} may have this name too. Pass the id ${id} to name this project without a lookup.`;
}

/** The notes of the tool call running in this context (see {@link collectProjectNotes}). */
const projectNotes = new AsyncLocalStorage<Set<string>>();

/**
 * Runs a tool call and returns its value with the notes of the projects it found by a name that was
 * not compared with every project (AgentSession.resolveProjectId: listing storage failed, or storage
 * did not answer in time; an error says the same when no project was found). A tool's result carries
 * them, so that the agent knows that another project may have that name.
 */
export async function collectProjectNotes<T>(call: () => Promise<T>): Promise<{ value: T; notes: string[] }> {
  const notes = new Set<string>();
  const value = await projectNotes.run(notes, call);
  return { value, notes: [...notes] };
}

/** Characters allowed in agent ids (`x-mcp-agent-id` header / `agent` query parameter). */
const AGENT_ID_RE = /^[\w.:@/+-]{1,128}$/;

/** A valid agent id, or null (undefined/empty), or throws a ToolError for malformed ids. */
export function parseAgentId(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string' || !v.trim()) return null;
  const id = v.trim();
  if (!AGENT_ID_RE.test(id))
    throw new ToolError(
      'agent id must be 1-128 characters: letters, digits and . _ : @ / + - (x-mcp-agent-id header or ?agent= query parameter)',
    );
  return id;
}

/** What an agent keeps per project: its editor state and its undo history. */
interface ProjectMemory {
  room: Room;
  state: EditorState;
  history: AgentHistory;
}

/**
 * Who makes an agent's changes: the transaction origin, and per project the undo history and the
 * editor state (selection, mode, frame). An MCP session without an agent id has an identity of
 * its own, gone with the session. Sessions that send the same agent id (`x-mcp-agent-id` header
 * or `?agent=` on the endpoint URL; scripts/mcp.mjs does) share one identity that outlives them:
 * one-shot CLI calls (one session each) can then undo / redo each other's changes and keep the
 * selection, like one long session.
 */
export class AgentIdentity {
  /** Transaction origin of every change made under this identity. */
  readonly origin: { type: 'mcp'; session: string; agent?: string };
  private readonly memories = new Map<string, ProjectMemory>();
  /** Live MCP sessions using this identity. */
  sessions = 0;
  lastUsed = Date.now();

  /** `agentId` null: an anonymous identity of one session (`key` is the session id). */
  constructor(
    readonly key: string,
    readonly agentId: string | null,
    private readonly historyLimits: Partial<HistoryLimits> = {},
  ) {
    this.origin = agentId ? { type: 'mcp', session: key, agent: agentId } : { type: 'mcp', session: key };
  }

  /** The editor state and undo history in a project (new ones when the project was reloaded). */
  memory(room: Room): ProjectMemory {
    this.lastUsed = Date.now();
    let m = this.memories.get(room.id);
    if (m && (m.room !== room || room.destroyed)) {
      // the project was unloaded (or deleted) since: its old document is gone, so is the history
      m.history.destroy();
      m = undefined;
    }
    if (!m) {
      m = {
        room,
        state: createEditorState(),
        history: new AgentHistory(room.scene.ydoc, room.scene.sharedTypes(), this.origin, this.historyLimits),
      };
      this.memories.set(room.id, m);
    }
    return m;
  }

  /** The undo history in a project, if this identity has one (tests and diagnostics). */
  historyOf(projectId: string): AgentHistory | undefined {
    return this.memories.get(projectId)?.history;
  }

  /**
   * Ends the history and editor state in a project (deleted). What the history kept for undo is
   * garbage collected (see {@link AgentHistory.destroy}).
   */
  forget(projectId: string): void {
    this.memories.get(projectId)?.history.destroy();
    this.memories.delete(projectId);
  }

  /** Lets go of a closed room (project deleted or unloaded): its history and editor state. */
  release(room: Room): void {
    const m = this.memories.get(room.id);
    if (m?.room !== room) return;
    m.history.destroy();
    this.memories.delete(room.id);
  }

  /** Drops memories of projects that were unloaded (their documents are gone). */
  prune(): void {
    for (const [id, m] of this.memories)
      if (m.room.destroyed) {
        m.history.destroy();
        this.memories.delete(id);
      }
  }

  /** Ends every history (the session or agent id expired): their kept data is collected. */
  dispose(): void {
    for (const m of this.memories.values()) m.history.destroy();
    this.memories.clear();
  }
}

/**
 * The agent's view of one project in one MCP session: the identity's editor state (selection,
 * mode, frame) and Y.UndoManager (tracking only the agent's changes), and the session's presence
 * in the room's awareness.
 */
export class AgentProject {
  readonly state: EditorState;
  /** The agent's bounded undo history in this project. */
  readonly history: AgentHistory;
  readonly undo: Y.UndoManager;
  readonly presenceId = randomClientId();
  private lastPresence = '';
  private disposed = false;

  constructor(
    readonly room: Room,
    private readonly session: AgentSession,
    private readonly deps: AgentDeps,
  ) {
    const memory = session.identity.memory(room);
    this.state = memory.state;
    this.history = memory.history;
    this.undo = memory.history.undo;
    room.holders.add(session.id);
    this.publishPresence();
  }

  get id(): string {
    return this.room.id;
  }

  get scene() {
    return this.room.scene;
  }

  get alive(): boolean {
    return !this.disposed && !this.room.destroyed;
  }

  context(reports: { level: ReportLevel; message: string }[] = []): OperatorContext {
    return {
      doc: this.room.scene,
      state: this.state,
      origin: this.session.origin,
      source: 'mcp',
      report: (level, message) => {
        reports.push({ level, message });
      },
    };
  }

  /**
   * Runs an operator with the agent's state (one undo step unless inside {@link step}). Operators
   * replaced by MCP tools (renders, see `toolOnlyOperator`) fail without running.
   */
  run<T = unknown>(operator: string, params?: unknown): RunResult<T> {
    const refused = toolOnlyOperator(operator);
    if (refused) return { ok: false, error: refused, reports: [], durationMs: 0, params };
    this.room.touch();
    const res = this.deps.registry.run<T>(this.context(), operator, params);
    // inside a step (batch, edit_mesh …): free what the step created and deleted again so far
    this.history.compactStep();
    this.publishPresence();
    return res;
  }

  /** Like {@link run} but throws a {@link ToolError} when the operator fails. */
  runOrThrow<T = unknown>(operator: string, params?: unknown): RunResult<T> {
    const res = this.run<T>(operator, params);
    if (!res.ok) throw new ToolError(`${operator} failed: ${res.error ?? 'unknown error'}`);
    return res;
  }

  /** Groups every document change made by `fn` into a single undo step. */
  step<T>(fn: () => T): T {
    const prev = this.undo.captureTimeout;
    this.undo.stopCapturing();
    this.undo.captureTimeout = Number.POSITIVE_INFINITY;
    try {
      return fn();
    } finally {
      this.undo.captureTimeout = prev;
      this.undo.stopCapturing();
    }
  }

  /** Applies direct document edits as the agent (tracked by its undo manager). */
  transact<T>(fn: () => T): T {
    this.room.touch();
    return this.room.scene.transact(fn, this.session.origin);
  }

  presenceState(): PresenceState {
    const name = this.session.displayName;
    // objects that no longer exist (undone, deleted by someone else) are not shown as selected
    const exists = (id: string) => !!this.room.scene.getObject(id);
    return {
      user: { name, color: colorForName(name), kind: 'agent' },
      device: 'mcp',
      mode: this.state.mode,
      selection: this.state.selectedIds.filter(exists),
      active: this.state.activeId && exists(this.state.activeId) ? this.state.activeId : null,
      frame: this.state.frame,
    };
  }

  /**
   * Drops objects that no longer exist from the selection and the active object (after undo or
   * redo removed them), leaving Edit Mode when the edited object is gone, and publishes the
   * presence again.
   */
  syncSelection(): void {
    const s = this.state;
    const exists = (id: string) => !!this.room.scene.getObject(id);
    s.selectedIds = s.selectedIds.filter(exists);
    if (s.activeId && !exists(s.activeId)) {
      s.activeId = null;
      if (s.mode === 'EDIT') s.mode = 'OBJECT';
    }
    this.publishPresence();
  }

  /** Publishes the agent's presence (only when it changed; not while the session is away). */
  publishPresence(force = false): void {
    if (!this.alive || this.session.away) return;
    const state = this.presenceState();
    const key = JSON.stringify(state);
    if (!force && key === this.lastPresence) return;
    this.lastPresence = key;
    this.room.setAgentPresence(this.presenceId, state);
  }

  /** Removes the presence (the session went quiet); the next publish shows it again. */
  hidePresence(): void {
    if (!this.alive || !this.lastPresence) return;
    this.lastPresence = '';
    this.room.setAgentPresence(this.presenceId, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // the undo history and editor state belong to the identity (they may outlive the session)
    this.room.holders.delete(this.session.id);
    if (!this.room.destroyed) {
      this.room.setAgentPresence(this.presenceId, null);
      this.room.touch();
    }
  }
}

/**
 * Per-MCP-session state: one {@link AgentProject} per project the agent touched, on top of the
 * agent's {@link AgentIdentity} (its own, or one shared by sessions with the same agent id).
 */
export class AgentSession {
  clientName = 'MCP client';
  readonly identity: AgentIdentity;
  /** The session sent no request for a while: its presence is hidden until the next one. */
  away = false;
  private readonly projects = new Map<string, AgentProject>();
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly deps: AgentDeps,
    identity?: AgentIdentity,
  ) {
    this.identity = identity ?? new AgentIdentity(id, null, deps.history);
    this.identity.sessions++;
  }

  /** Transaction origin of every change made by this agent (the identity's). */
  get origin(): AgentIdentity['origin'] {
    return this.identity.origin;
  }

  /** The agent id sessions share (null: this session has its own history). */
  get agentId(): string | null {
    return this.identity.agentId;
  }

  get displayName(): string {
    return `AI agent (${this.clientName})`;
  }

  /** Hides the presence of a quiet session (`away`) or shows it again. */
  setAway(away: boolean): void {
    if (this.away === away || this.disposed) return;
    this.away = away;
    for (const p of this.held()) {
      if (away) p.hidePresence();
      else p.publishPresence(true);
    }
  }

  setClientName(name: string | undefined): void {
    const clean = (name ?? '').trim().slice(0, 60);
    if (!clean || clean === this.clientName) return;
    this.clientName = clean;
    for (const p of this.projects.values()) p.publishPresence(true);
  }

  /**
   * Resolves a project reference to a project id (see {@link findProject}), and adds the note of a
   * project found by a name that was not compared with every project to the notes of the tool call
   * (see {@link collectProjectNotes}).
   */
  async resolveProjectId(ref: string): Promise<string> {
    const { id, note } = await this.findProject(ref);
    if (note) projectNotes.getStore()?.add(note);
    return id;
  }

  /**
   * Resolves a project reference: an id, or a name, as docs/mcp.md says: an exact match first, else
   * one ignoring letter case, among the projects this server has loaded and those in storage
   * together (the projects list_projects lists); several projects with the name are an error that
   * lists their ids. An id comes first (RoomManager.exists). A name is compared with a listing of
   * storage made for it (listForName, RoomManager.listNames: one listing of the projects folder, and
   * the project.json of the stored projects that are new or changed since a lookup last read them;
   * every project.json used to be read at every lookup). A request waits for storage {@link
   * RoomManager.readWaitMs} (5 s) in all, for the id and the listing (and not for the listing while
   * a read of a loaded project of that name that a request stopped waiting for goes on,
   * Room.storageLate). When the listing has not answered by then, a name that a loaded project has
   * finds that project (`note` says that the projects in storage were not compared; while the
   * listing goes on, the project counts as one whose read a request stopped waiting for, so that
   * get_project does not wait for storage again), and a name that none has waits for the listing
   * (storage that does not answer takes 30 s per request on WebDAV). When the last listing took
   * longer than that wait (storage that lists slowly), a name that one project has in the last
   * listing that listed storage (within the last 60 s) finds that project at once (`note` says how
   * old that listing is), and other names wait for the listing that goes on. When listing storage
   * fails, the projects this server has loaded are those compared, and when reading some
   * project.json files fails, the others; a project found then has a `note`, and a name that
   * nothing matches gets an error that says why, instead of 'There are no projects yet'. Names of
   * the projects this server had loaded used to be compared before storage was listed, so a project
   * that was only in storage with the same name (made by a browser) was ignored, and a loaded
   * project matched ignoring letter case won over one in storage with the exact name. Without
   * storage, the projects this server has loaded are all the projects, and no listing is waited for.
   */
  async findProject(ref: string): Promise<{ id: string; note?: string }> {
    const r = ref.trim();
    if (!r) throw new ToolError('project is required (id or name; see list_projects)');
    const { rooms } = this.deps;
    const waitMs = rooms.readWaitMs;
    const deadline = Date.now() + waitMs;
    if (isValidProjectId(r) && (await rooms.exists(r))) return { id: r };
    const late = rooms.loadedNamed(r).some((room) => room.storageLate);
    const { answered, finished, earlier } = await listForName(rooms, late ? 0 : deadline);
    if (earlier) {
      // storage lists slowly: a name that one project has in the last listing finds it at once
      const [match, ...others] = matching(rooms.namesOf(earlier.names), r);
      if (match && others.length === 0)
        return { id: match.id, note: foundWithout(r, match.id, 'slow', waitMs, earlier.ageMs) };
      // a name that no loaded project has waits for the new listing (only storage can find that
      // project); one that a loaded project has waits for it until the deadline (5 s in all, none
      // while a read of that project that a request stopped waiting for goes on), then the last
      // listing answers (several projects with the name are an error that says so)
      if (rooms.loadedNamed(r).length === 0) return this.named(r, await finished, waitMs);
      const since = Date.now();
      if (await settlesBefore(finished, late ? 0 : deadline)) return this.named(r, await finished, waitMs);
      return this.named(r, earlier.names, waitMs, earlier.ageMs + Date.now() - since);
    }
    if (!answered) {
      // storage did not answer in time: the names of the loaded projects decide, when one has it
      const loaded = rooms.loadedNamed(r).map((room) => ({ id: room.id, name: room.scene.name }));
      const id = projectNamed(loaded, r, { why: 'late', waitMs });
      if (id) {
        // the request has waited for storage: while the listing goes on, the request does not wait
        // for that project's reads again (get_project's check of storage, Room.storageLate)
        rooms.get(id)?.readIsLate(finished);
        return { id, note: foundWithout(r, id, 'late', waitMs) };
      }
    }
    return this.named(r, answered ?? (await finished), waitMs);
  }

  /**
   * {@link findProject} by name among the projects of a listing (RoomManager.namesOf); `slowAgeMs`:
   * the listing is the last one that listed storage, made that long ago, while storage lists slowly.
   */
  private named(
    r: string,
    listed: StoredNames,
    waitMs: number,
    slowAgeMs?: number,
  ): { id: string; note?: string } {
    const { failed, partial } = listed;
    const all: NamedProject[] = this.deps.rooms.namesOf(listed);
    const why: Unlisted | null =
      slowAgeMs !== undefined ? 'slow' : failed ? (partial ? 'partial' : 'failed') : null;
    const id = projectNamed(all, r, why ? { why, waitMs, ageMs: slowAgeMs } : undefined);
    if (id) return why ? { id, note: foundWithout(r, id, why, waitMs, slowAgeMs) } : { id };
    const known = all
      .slice(0, 20)
      .map((p) => `'${p.name}' (${p.id})`)
      .join(', ');
    const knownProjects = known ? ` Known projects: ${known}.` : '';
    if (why === 'slow') {
      const which = compared('slow', waitMs, slowAgeMs);
      throw new ToolError(
        `Project '${r}' not found.${knownProjects} ${which[0].toUpperCase()}${which.slice(1)}: a project stored or renamed since then is not found by name now. Pass its id, or call list_projects, which waits for storage to list its projects.`,
      );
    }
    if (failed) {
      const missing = partial
        ? "Reading the project.json of some projects in storage failed (the server logged 'listing projects failed'), so a project among those"
        : "Listing the projects in storage failed (the server logged 'listing projects failed'), so a project that is only in storage";
      throw new ToolError(
        `Project '${r}' not found.${knownProjects} ${missing} is not found by name now: try again once list_projects no longer has storage_listing_failed: true.`,
      );
    }
    throw new NotFoundError(
      `Project '${r}' not found.${knownProjects || ' There are no projects yet.'} Use list_projects or create_project.`,
    );
  }

  /** The agent's handle on a project (loading it if needed). */
  async project(ref: string): Promise<AgentProject> {
    if (this.disposed) throw new ToolError('MCP session closed');
    const cached = this.projects.get(ref);
    if (cached?.alive) return cached;
    const id = await this.resolveProjectId(ref);
    const existing = this.projects.get(id);
    if (existing?.alive) return existing;
    existing?.dispose();
    const room = await this.deps.rooms.open(id);
    if (!room) throw new NotFoundError(`Project '${ref}' not found. Use list_projects or create_project.`);
    const p = new AgentProject(room, this, this.deps);
    this.projects.set(id, p);
    return p;
  }

  /** Projects this agent currently holds. */
  held(): AgentProject[] {
    return [...this.projects.values()].filter((p) => p.alive);
  }

  /**
   * Lets go of a room that was closed (its project deleted by anyone, or unloaded): the handle,
   * and the identity's history and editor state there, so the old document can be freed.
   */
  release(room: Room): void {
    const p = this.projects.get(room.id);
    if (p?.room === room) {
      p.dispose();
      this.projects.delete(room.id);
    }
    this.identity.release(room);
  }

  /** Lets go of a project (deleted): its presence, undo history and editor state. */
  forget(projectId: string): void {
    this.projects.get(projectId)?.dispose();
    this.projects.delete(projectId);
    this.identity.forget(projectId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.projects.values()) p.dispose();
    this.projects.clear();
    this.identity.sessions--;
    this.identity.lastUsed = Date.now();
    // an anonymous identity ends with its session; shared ones are kept by the hub
    if (!this.identity.agentId) this.identity.dispose();
  }
}
