import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebSocket } from 'ws';
import {
  MSG_AWARENESS,
  MSG_CONTROL,
  MSG_QUERY_AWARENESS,
  MSG_RPC,
  MSG_SYNC,
  PROTOCOL_VERSION,
  SceneDoc,
  encodeFrame,
  encodeJsonFrame,
  newId,
  readFrameType,
  readJsonPayload,
  type ControlMessage,
  type PresenceState,
  type ProjectFileStore,
  type ProjectInfo,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from '@3d-editor/core';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import { currentTraceparent, errorMessage, withSpan, withSpanSync } from '../observability/tracing';
import { encodeAwarenessEntries } from './awareness';
import { isSceneEmpty, projectInfoFromScene, sceneStats, type SceneStats } from './project-info';

/** Transaction origin of changes merged from storage (not re-persisted, still broadcast). */
export const STORAGE_ORIGIN = Symbol('storage');
/** Awareness origin of presence entries published by the server for MCP agents. */
export const AGENT_PRESENCE_ORIGIN = Symbol('agent-presence');

const MESSAGE_TYPES: Record<number, string> = {
  [MSG_SYNC]: 'sync',
  [MSG_AWARENESS]: 'awareness',
  [MSG_QUERY_AWARENESS]: 'query_awareness',
  [MSG_RPC]: 'rpc',
  [MSG_CONTROL]: 'control',
};

/** Connections whose send buffer grows beyond this are considered stuck and closed. */
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
const AGENT_PRESENCE_RENEW_MS = 15_000;

export type RpcErrorCode = 'NO_CLIENT' | 'TIMEOUT' | 'CLOSED' | 'REMOTE' | 'SEND_FAILED';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: RpcErrorCode,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface ConnectionInfo {
  id: string;
  app?: string;
  version?: string;
  name?: string;
  capabilities: string[];
  connectedAt: string;
  lastActivity: string;
  awarenessClients: number[];
  remoteAddress?: string;
}

/** One WebSocket client of a room. */
export class SyncConnection {
  readonly id = newId(12);
  readonly connectedAt = Date.now();
  lastActivity = Date.now();
  capabilities = new Set<string>();
  clientInfo: { app?: string; version?: string; name?: string } = {};
  /** Awareness client ids published through this connection (removed when it closes). */
  readonly awarenessIds = new Set<number>();
  alive = true;

  constructor(
    readonly ws: WebSocket,
    readonly remoteAddress?: string,
  ) {}

  info(): ConnectionInfo {
    return {
      id: this.id,
      ...this.clientInfo,
      capabilities: [...this.capabilities],
      connectedAt: new Date(this.connectedAt).toISOString(),
      lastActivity: new Date(this.lastActivity).toISOString(),
      awarenessClients: [...this.awarenessIds],
      remoteAddress: this.remoteAddress,
    };
  }
}

export interface RoomDeps {
  store: ProjectFileStore | null;
  metrics: ServerMetrics;
  log: Log;
  debounceMs: number;
  serverVersion: string;
}

export interface RpcOptions {
  /** Only connections advertising this capability (via `client-info`) are considered. */
  capability: string;
  timeoutMs?: number;
  /** Target a specific connection (id, client name or awareness user name). */
  target?: string;
}

export interface PresenceEntry {
  clientId: number;
  kind: 'human' | 'agent';
  connectionId: string | null;
  state: Partial<PresenceState> & Record<string, unknown>;
}

export interface ProjectListing extends ProjectInfo {
  /** Open WebSocket connections. */
  peers: number;
  /** Loaded in memory. */
  live: boolean;
}

interface PendingRpc {
  conn: SyncConnection;
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A project loaded in memory: the shared Y.Doc, awareness and the WebSocket connections
 * editing it. Changes are broadcast to every other connection and persisted (debounced) as a
 * CRDT merge with the stored document.
 */
export class Room {
  readonly doc: Y.Doc;
  readonly scene: SceneDoc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Set<SyncConnection>();
  /** MCP sessions currently using the room (prevents eviction). */
  readonly holders = new Set<string>();
  lastActive = Date.now();
  lastModified = Date.now();
  destroyed = false;
  /** Whether the project exists in the persistence backend. */
  persisted: boolean;
  /** Last known `project.json` content. */
  info: ProjectInfo | null;
  private lastEtag: string | undefined;
  private dirty = false;
  private firstDirtyAt = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private saveFailures = 0;
  private readonly pendingRpc = new Map<string, PendingRpc>();
  private readonly agents = new Map<number, { state: PresenceState; clock: number }>();
  private agentTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly id: string,
    doc: Y.Doc,
    private readonly deps: RoomDeps,
    init: { info?: ProjectInfo | null; etag?: string; persisted?: boolean } = {},
  ) {
    this.doc = doc;
    this.scene = new SceneDoc(doc, { type: 'server', room: id });
    this.awareness = new awarenessProtocol.Awareness(doc);
    // The server itself is not a participant.
    this.awareness.setLocalState(null);
    this.info = init.info ?? null;
    this.lastEtag = init.etag;
    this.persisted = !!init.persisted;
    doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  // ---------------------------------------------------------------- state

  touch(): void {
    this.lastActive = Date.now();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get peers(): number {
    return this.conns.size;
  }

  isIdle(now: number, ttlMs: number): boolean {
    return this.conns.size === 0 && this.holders.size === 0 && now - this.lastActive >= ttlMs;
  }

  isEmpty(): boolean {
    return isSceneEmpty(this.scene);
  }

  stats(): SceneStats {
    return sceneStats(this.scene);
  }

  listing(): ProjectListing {
    const info = projectInfoFromScene(this.id, this.scene, this.info, new Date(this.lastModified));
    return { ...info, peers: this.conns.size, live: true };
  }

  // ---------------------------------------------------------------- document events

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.deps.metrics.syncUpdateBytes.observe(update.byteLength);
    const frame = encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update));
    for (const c of this.conns) if (c !== origin) this.send(c, frame, 'sync');
    this.touch();
    if (origin !== STORAGE_ORIGIN) {
      this.lastModified = Date.now();
      this.markDirty();
    }
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = [...added, ...updated, ...removed];
    if (origin instanceof SyncConnection) {
      for (const id of added) origin.awarenessIds.add(id);
      for (const id of updated) origin.awarenessIds.add(id);
      for (const id of removed) origin.awarenessIds.delete(id);
    }
    if (changed.length === 0 || this.conns.size === 0) return;
    const frame = encodeFrame(MSG_AWARENESS, (enc) =>
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)),
    );
    for (const c of this.conns) if (c !== origin) this.send(c, frame, 'awareness');
  };

  // ---------------------------------------------------------------- persistence

  /** Schedules a debounced save (bounded by a maximum delay under continuous editing). */
  markDirty(): void {
    if (!this.deps.store || this.destroyed) return;
    this.dirty = true;
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    const debounce = this.deps.debounceMs;
    const maxWait = Math.max(debounce * 10, 5000);
    const due = Math.max(0, Math.min(debounce, this.firstDirtyAt + maxWait - now));
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, due);
    this.saveTimer.unref?.();
  }

  /** Persists pending changes now. Never rejects (failures are logged and retried). */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const run = this.saveChain.then(() => this.save(false));
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Merges changes made to the stored document by others (other servers sharing the storage,
   * devices saving to WebDAV directly) into the room, and saves pending local changes.
   */
  refresh(): Promise<void> {
    if (!this.deps.store || this.destroyed) return Promise.resolve();
    const run = this.saveChain.then(() => this.save(true));
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  private async save(refresh: boolean): Promise<void> {
    const store = this.deps.store;
    if (!store || this.destroyed || (!this.dirty && !refresh)) return;
    const wasDirty = this.dirty;
    this.dirty = false;
    this.firstDirtyAt = 0;
    const op = wasDirty ? 'save' : 'refresh';
    const { metrics, log } = this.deps;
    const end = metrics.persistenceDuration.startTimer({ op });
    try {
      await withSpan(`persistence.${op}`, { 'project.id': this.id }, async (span) => {
        const prevInfo = await store.loadInfo(this.id).catch(() => null);
        const res = await store.syncDocument(this.id, this.doc, {
          lastEtag: this.lastEtag,
          origin: STORAGE_ORIGIN,
          info: () => (this.info = projectInfoFromScene(this.id, this.scene, prevInfo ?? this.info)),
        });
        if (res.etag) this.lastEtag = res.etag;
        span.setAttributes({ 'persistence.pulled': res.pulled, 'persistence.pushed': res.pushed });
      });
      this.persisted = true;
      this.saveFailures = 0;
      metrics.persistenceOps.inc({ op, status: 'ok' });
    } catch (err) {
      metrics.persistenceOps.inc({ op, status: 'error' });
      if (!wasDirty) {
        log.debug({ err: errorMessage(err), project: this.id }, 'refreshing project from storage failed');
        return;
      }
      this.saveFailures++;
      log.warn(
        { err: errorMessage(err), project: this.id, failures: this.saveFailures },
        'saving project failed, will retry',
      );
      if (!this.destroyed) {
        this.dirty = true;
        const delay = Math.min(
          60_000,
          Math.max(1000, this.deps.debounceMs) * 2 ** Math.min(this.saveFailures, 6),
        );
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.flush();
        }, delay);
        this.saveTimer.unref?.();
      } else this.dirty = true;
    } finally {
      end();
    }
  }

  // ---------------------------------------------------------------- connections

  addConnection(ws: WebSocket, remoteAddress?: string): SyncConnection {
    const conn = new SyncConnection(ws, remoteAddress);
    this.conns.add(conn);
    this.touch();
    this.deps.metrics.syncConnections.inc();
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      this.handleMessage(conn, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => this.removeConnection(conn));
    ws.on('error', (err) =>
      this.deps.log.debug({ err: err.message, project: this.id, conn: conn.id }, 'websocket error'),
    );

    this.sendControl(conn, {
      kind: 'hello',
      connectionId: conn.id,
      room: this.id,
      serverVersion: this.deps.serverVersion,
      protocol: PROTOCOL_VERSION,
      peers: this.conns.size,
    });
    this.send(
      conn,
      encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, this.doc)),
      'sync',
    );
    const states = [...this.awareness.getStates().keys()];
    if (states.length > 0) {
      this.send(
        conn,
        encodeFrame(MSG_AWARENESS, (enc) =>
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states)),
        ),
        'awareness',
      );
    }
    this.broadcastPeers(conn);
    this.deps.log.debug({ project: this.id, conn: conn.id, peers: this.conns.size }, 'sync client connected');
    return conn;
  }

  private removeConnection(conn: SyncConnection): void {
    if (!this.conns.delete(conn)) return;
    this.deps.metrics.syncConnections.dec();
    this.touch();
    for (const [id, p] of this.pendingRpc) {
      if (p.conn !== conn) continue;
      clearTimeout(p.timer);
      this.pendingRpc.delete(id);
      this.deps.metrics.syncRpc.inc({ method: p.method, status: 'closed' });
      p.reject(new RpcError(`client disconnected before answering '${p.method}'`, 'CLOSED'));
    }
    if (!this.destroyed) {
      if (conn.awarenessIds.size > 0)
        awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
      this.broadcastPeers();
    }
    this.deps.log.debug(
      { project: this.id, conn: conn.id, peers: this.conns.size },
      'sync client disconnected',
    );
  }

  private broadcastPeers(except?: SyncConnection): void {
    for (const c of this.conns)
      if (c !== except) this.sendControl(c, { kind: 'peers', count: this.conns.size });
  }

  /** Sends a frame; returns false when the socket is not writable. */
  send(conn: SyncConnection, frame: Uint8Array, type: string): boolean {
    const ws = conn.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.deps.log.warn({ project: this.id, conn: conn.id }, 'closing slow sync client');
      ws.close(1013, 'client too slow');
      return false;
    }
    ws.send(frame, { binary: true }, (err) => {
      if (err) this.deps.log.debug({ err: err.message, conn: conn.id }, 'websocket send failed');
    });
    this.deps.metrics.syncMessages.inc({ type, direction: 'out' });
    return true;
  }

  sendControl(conn: SyncConnection, msg: ControlMessage): boolean {
    return this.send(conn, encodeJsonFrame(MSG_CONTROL, msg), 'control');
  }

  // ---------------------------------------------------------------- incoming messages

  handleMessage(conn: SyncConnection, data: Uint8Array): void {
    conn.lastActivity = Date.now();
    this.touch();
    let type: number;
    let decoder: decoding.Decoder;
    try {
      ({ type, decoder } = readFrameType(data));
    } catch {
      this.deps.metrics.syncMessages.inc({ type: 'unknown', direction: 'in' });
      return;
    }
    const typeName = MESSAGE_TYPES[type] ?? 'unknown';
    this.deps.metrics.syncMessages.inc({ type: typeName, direction: 'in' });
    try {
      switch (type) {
        case MSG_SYNC:
          withSpanSync(
            'sync.message',
            { 'sync.room': this.id, 'sync.type': typeName, 'sync.bytes': data.byteLength },
            () => {
              const enc = encoding.createEncoder();
              encoding.writeVarUint(enc, MSG_SYNC);
              syncProtocol.readSyncMessage(decoder, enc, this.doc, conn);
              if (encoding.length(enc) > 1) this.send(conn, encoding.toUint8Array(enc), 'sync');
            },
          );
          break;
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), conn);
          break;
        case MSG_QUERY_AWARENESS: {
          const states = [...this.awareness.getStates().keys()];
          this.send(
            conn,
            encodeFrame(MSG_AWARENESS, (enc) =>
              encoding.writeVarUint8Array(
                enc,
                awarenessProtocol.encodeAwarenessUpdate(this.awareness, states),
              ),
            ),
            'awareness',
          );
          break;
        }
        case MSG_RPC:
          this.handleRpc(conn, readJsonPayload<RpcMessage>(decoder));
          break;
        case MSG_CONTROL:
          this.handleControl(conn, readJsonPayload<ControlMessage>(decoder));
          break;
        default:
          this.sendControl(conn, {
            kind: 'error',
            message: `unknown message type ${type}`,
            code: 'UNKNOWN_MESSAGE',
          });
      }
    } catch (err) {
      this.deps.log.debug(
        { err: errorMessage(err), project: this.id, conn: conn.id, type: typeName },
        'bad sync message',
      );
      this.sendControl(conn, {
        kind: 'error',
        message: `could not process ${typeName} message: ${errorMessage(err)}`,
        code: 'BAD_MESSAGE',
      });
    }
  }

  private handleControl(conn: SyncConnection, msg: ControlMessage): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.kind) {
      case 'client-info': {
        const caps = Array.isArray(msg.capabilities) ? msg.capabilities : [];
        conn.capabilities = new Set(
          caps.filter((c): c is string => typeof c === 'string' && c.length <= 64).slice(0, 32),
        );
        conn.clientInfo = {
          app: typeof msg.app === 'string' ? msg.app.slice(0, 64) : undefined,
          version: typeof msg.version === 'string' ? msg.version.slice(0, 64) : undefined,
          name: typeof msg.name === 'string' ? msg.name.slice(0, 128) : undefined,
        };
        break;
      }
      case 'ping':
        this.sendControl(conn, { kind: 'pong', t: msg.t });
        break;
      default:
        break;
    }
  }

  private handleRpc(conn: SyncConnection, msg: RpcMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'res') {
      const res = msg as RpcResponse;
      const p = this.pendingRpc.get(res.id);
      if (!p || p.conn !== conn) return;
      clearTimeout(p.timer);
      this.pendingRpc.delete(res.id);
      if (res.error) {
        this.deps.metrics.syncRpc.inc({ method: p.method, status: 'error' });
        p.reject(new RpcError(res.error.message || 'remote error', 'REMOTE'));
      } else {
        this.deps.metrics.syncRpc.inc({ method: p.method, status: 'ok' });
        p.resolve(res.result);
      }
    } else if (msg.kind === 'req') {
      const req = msg as RpcRequest;
      this.send(
        conn,
        encodeJsonFrame(MSG_RPC, {
          kind: 'res',
          id: req.id,
          error: { message: `unknown method '${req.method}'`, code: 'METHOD_NOT_FOUND' },
        }),
        'rpc',
      );
    }
  }

  // ---------------------------------------------------------------- RPC to editors

  /** Connections advertising a capability, most recently active first. */
  rpcCandidates(capability: string): SyncConnection[] {
    return [...this.conns]
      .filter((c) => c.capabilities.has(capability) && c.ws.readyState === WebSocket.OPEN)
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /** Picks the connection an RPC is sent to (see {@link RpcOptions.target}). */
  pickRpcTarget(capability: string, target?: string): SyncConnection | null {
    const candidates = this.rpcCandidates(capability);
    if (!target) return candidates[0] ?? null;
    const t = target.trim().toLowerCase();
    return (
      candidates.find((c) => c.id.toLowerCase() === t) ??
      candidates.find((c) => (c.clientInfo.name ?? '').toLowerCase() === t) ??
      candidates.find((c) =>
        [...c.awarenessIds].some((id) => {
          const user = (this.awareness.getStates().get(id) as Partial<PresenceState> | undefined)?.user;
          return typeof user?.name === 'string' && user.name.toLowerCase() === t;
        }),
      ) ??
      null
    );
  }

  /**
   * Sends an RPC request to the most recently active connection advertising
   * `opts.capability` and resolves with its result.
   */
  rpc(method: string, params: unknown, opts: RpcOptions): Promise<unknown> {
    const conn = this.pickRpcTarget(opts.capability, opts.target);
    if (!conn) {
      this.deps.metrics.syncRpc.inc({ method, status: 'no_client' });
      return Promise.reject(
        new RpcError(
          opts.target
            ? `no connected editor '${opts.target}' with capability '${opts.capability}'`
            : `no connected editor with capability '${opts.capability}'`,
          'NO_CLIENT',
        ),
      );
    }
    return this.rpcTo(conn, method, params, opts.timeoutMs);
  }

  rpcTo(conn: SyncConnection, method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    return withSpan(
      'sync.rpc',
      { 'rpc.method': method, 'sync.room': this.id, 'sync.connection': conn.id },
      () => {
        return new Promise<unknown>((resolve, reject) => {
          const id = newId(16);
          const timer = setTimeout(() => {
            this.pendingRpc.delete(id);
            this.deps.metrics.syncRpc.inc({ method, status: 'timeout' });
            reject(new RpcError(`editor did not answer '${method}' within ${timeoutMs} ms`, 'TIMEOUT'));
          }, timeoutMs);
          this.pendingRpc.set(id, { conn, method, resolve, reject, timer });
          const req: RpcRequest = { kind: 'req', id, method, params, traceparent: currentTraceparent() };
          if (!this.send(conn, encodeJsonFrame(MSG_RPC, req), 'rpc')) {
            clearTimeout(timer);
            this.pendingRpc.delete(id);
            this.deps.metrics.syncRpc.inc({ method, status: 'send_failed' });
            reject(new RpcError('could not send the request to the editor', 'SEND_FAILED'));
          }
        });
      },
    );
  }

  // ---------------------------------------------------------------- presence

  /** Publishes (or removes, with null) the presence of a server-side client such as an MCP agent. */
  setAgentPresence(clientId: number, state: PresenceState | null): void {
    if (this.destroyed) return;
    const cur = this.agents.get(clientId);
    const clock = Math.max(cur?.clock ?? 0, this.awareness.meta.get(clientId)?.clock ?? 0) + 1;
    if (state) this.agents.set(clientId, { state, clock });
    else this.agents.delete(clientId);
    awarenessProtocol.applyAwarenessUpdate(
      this.awareness,
      encodeAwarenessEntries([
        { clientId, clock, state: state as unknown as Record<string, unknown> | null },
      ]),
      AGENT_PRESENCE_ORIGIN,
    );
    if (this.agents.size > 0 && !this.agentTimer) {
      this.agentTimer = setInterval(() => this.renewAgents(), AGENT_PRESENCE_RENEW_MS);
      this.agentTimer.unref?.();
    } else if (this.agents.size === 0 && this.agentTimer) {
      clearInterval(this.agentTimer);
      this.agentTimer = null;
    }
  }

  private renewAgents(): void {
    const entries = [...this.agents.entries()].map(([clientId, a]) => {
      a.clock++;
      return { clientId, clock: a.clock, state: a.state as unknown as Record<string, unknown> };
    });
    if (entries.length)
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        encodeAwarenessEntries(entries),
        AGENT_PRESENCE_ORIGIN,
      );
  }

  /** Everyone present in the room (editors and agents), from awareness. */
  presence(): PresenceEntry[] {
    const owner = new Map<number, SyncConnection>();
    for (const c of this.conns) for (const id of c.awarenessIds) owner.set(id, c);
    const out: PresenceEntry[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const s = state as PresenceEntry['state'];
      const kind = s.user?.kind === 'agent' || this.agents.has(clientId) ? 'agent' : 'human';
      out.push({ clientId, kind, connectionId: owner.get(clientId)?.id ?? null, state: s });
    }
    return out;
  }

  // ---------------------------------------------------------------- shutdown

  /**
   * Closes the room: optionally persists, disconnects every client with `code`, rejects
   * pending RPCs and releases the document.
   */
  async close(opts: { flush?: boolean; code?: number; reason?: string } = {}): Promise<void> {
    if (this.destroyed) return;
    if (opts.flush !== false) await this.flush();
    else {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveChain;
    }
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.agentTimer) clearInterval(this.agentTimer);
    this.agentTimer = null;
    const conns = [...this.conns];
    for (const c of conns) this.removeConnection(c);
    for (const c of conns) {
      try {
        c.ws.close(opts.code ?? 1001, opts.reason ?? 'room closed');
      } catch {
        c.ws.terminate();
      }
      const t = setTimeout(() => c.ws.terminate(), 2000);
      t.unref?.();
      c.ws.once('close', () => clearTimeout(t));
    }
    for (const [, p] of this.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new RpcError('room closed', 'CLOSED'));
    }
    this.pendingRpc.clear();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.scene.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
