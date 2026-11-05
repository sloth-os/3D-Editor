import * as Y from 'yjs';
import {
  colorForName,
  createEditorState,
  isValidProjectId,
  type EditorState,
  type OperatorContext,
  type OperatorRegistry,
  type PresenceState,
  type ReportLevel,
  type RunResult,
} from '@3d-editor/core';
import type { Room } from '../sync/room';
import type { RoomManager } from '../sync/room-manager';
import type { Log } from '../observability/log';
import { randomClientId } from '../sync/awareness';
import { toolOnlyOperator } from './operator-groups';

/** Errors with a message meant for the agent (returned as `isError` tool results). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface AgentDeps {
  rooms: RoomManager;
  registry: OperatorRegistry;
  log: Log;
}

/**
 * The agent's view of one project: its own editor state (selection, mode, frame), a Y.UndoManager
 * tracking only the agent's changes, and its presence in the room's awareness.
 */
export class AgentProject {
  readonly state: EditorState = createEditorState();
  readonly undo: Y.UndoManager;
  readonly presenceId = randomClientId();
  private lastPresence = '';
  private disposed = false;

  constructor(
    readonly room: Room,
    private readonly session: AgentSession,
    private readonly deps: AgentDeps,
  ) {
    this.undo = new Y.UndoManager(room.scene.sharedTypes(), {
      trackedOrigins: new Set([session.origin]),
      captureTimeout: 0,
    });
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
    return {
      user: { name, color: colorForName(name), kind: 'agent' },
      device: 'mcp',
      mode: this.state.mode,
      selection: [...this.state.selectedIds],
      active: this.state.activeId,
      frame: this.state.frame,
    };
  }

  /** Publishes the agent's presence (only when it changed). */
  publishPresence(force = false): void {
    if (!this.alive) return;
    const state = this.presenceState();
    const key = JSON.stringify(state);
    if (!force && key === this.lastPresence) return;
    this.lastPresence = key;
    this.room.setAgentPresence(this.presenceId, state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.undo.destroy();
    this.room.holders.delete(this.session.id);
    if (!this.room.destroyed) {
      this.room.setAgentPresence(this.presenceId, null);
      this.room.touch();
    }
  }
}

/** Per-MCP-session state: one {@link AgentProject} per project the agent touched. */
export class AgentSession {
  /** Transaction origin of every change made by this agent. */
  readonly origin: { type: 'mcp'; session: string };
  clientName = 'MCP client';
  private readonly projects = new Map<string, AgentProject>();
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly deps: AgentDeps,
  ) {
    this.origin = { type: 'mcp', session: id };
  }

  get displayName(): string {
    return `AI agent (${this.clientName})`;
  }

  setClientName(name: string | undefined): void {
    const clean = (name ?? '').trim().slice(0, 60);
    if (!clean || clean === this.clientName) return;
    this.clientName = clean;
    for (const p of this.projects.values()) p.publishPresence(true);
  }

  /** Resolves a project reference (id or exact name) to a project id. */
  async resolveProjectId(ref: string): Promise<string> {
    const r = ref.trim();
    if (!r) throw new ToolError('project is required (id or name; see list_projects)');
    const { rooms } = this.deps;
    if (isValidProjectId(r) && (await rooms.exists(r))) return r;
    // Fast path: a project this agent is already working on (avoids listing the storage backend).
    const held = this.held().filter((p) => p.scene.name === r);
    if (held.length === 1) return held[0].id;
    const all = await rooms.listProjects();
    let matches = all.filter((p) => p.name === r);
    if (matches.length === 0) matches = all.filter((p) => p.name.toLowerCase() === r.toLowerCase());
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      throw new ToolError(
        `Several projects are named '${r}': ${matches.map((m) => m.id).join(', ')}. Pass the project id instead.`,
      );
    }
    const known = all
      .slice(0, 20)
      .map((p) => `'${p.name}' (${p.id})`)
      .join(', ');
    throw new ToolError(
      `Project '${r}' not found.${known ? ` Known projects: ${known}.` : ' There are no projects yet.'} Use list_projects or create_project.`,
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
    if (!room) throw new ToolError(`Project '${ref}' not found. Use list_projects or create_project.`);
    const p = new AgentProject(room, this, this.deps);
    this.projects.set(id, p);
    return p;
  }

  /** Projects this agent currently holds. */
  held(): AgentProject[] {
    return [...this.projects.values()].filter((p) => p.alive);
  }

  forget(projectId: string): void {
    this.projects.get(projectId)?.dispose();
    this.projects.delete(projectId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.projects.values()) p.dispose();
    this.projects.clear();
  }
}
