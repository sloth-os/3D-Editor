import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  isJSONRPCRequest,
  type JSONRPCNotification,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from '../config';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import { errorMessage } from '../observability/tracing';
import type { RoomManager } from '../sync/room-manager';
import type { ServerServices } from '../services';
import { AgentIdentity, AgentSession, ToolError, parseAgentId } from './agent';
import { MCP_INSTRUCTIONS } from './instructions';
import { registerResources, registerTools, type ToolContext } from './tools';
import { resolveHistoryLimits, type HistoryLimits } from './history';

export const MCP_PATH = '/mcp';
/** Large enough for base64 encoded 50 MB model imports. */
const MCP_BODY_LIMIT = 100 * 1024 * 1024;

interface McpSession {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agent: AgentSession;
  lastActive: number;
  /** Open HTTP requests/streams (sessions with open streams are never idle). */
  open: number;
  closed: boolean;
}

export interface McpHubOptions {
  rooms: RoomManager;
  /**
   * The server's services (services.ts): the operator registry, the renderer (the process-wide one
   * unless the app was given another), the render store, video exports and the model store.
   */
  services: ServerServices;
  config: ServerConfig;
  metrics: ServerMetrics;
  log: Log;
  /** Sessions without activity are closed after this time (default 30 min). */
  idleTimeoutMs?: number;
  /**
   * The presence (avatar) of a session without requests is hidden after this time and shown
   * again with its next request (default 5 min): clients that never close their session (killed
   * agents, one-shot calls without DELETE) do not leave "AI agent" ghosts in projects.
   */
  presenceIdleMs?: number;
  /**
   * Undo histories and editor states of agent ids (x-mcp-agent-id) are kept this long after their
   * last session closed (default 6 hours).
   */
  identityTtlMs?: number;
  /** Most agent identities kept (least recently used ones are dropped first; default 200). */
  maxIdentities?: number;
  /** Limits of each agent's undo history per project (default: 100 steps, 64 MB). */
  history?: Partial<HistoryLimits>;
  maxSessions?: number;
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** Header and query parameter naming an agent id (see {@link AgentIdentity}). */
export const AGENT_ID_HEADER = 'x-mcp-agent-id';
export const AGENT_ID_QUERY = 'agent';

/** The agent id of an initialize request (header, else `?agent=` query parameter), or null. */
function agentIdOf(request: FastifyRequest): string | null {
  const header = parseAgentId(request.headers[AGENT_ID_HEADER]);
  if (header) return header;
  const query = request.query as Record<string, unknown> | undefined;
  return parseAgentId(query?.[AGENT_ID_QUERY]);
}

/** Ids of the JSON-RPC requests in a POST body (a message or a batch), except `initialize`. */
function requestIds(body: unknown): RequestId[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter((m) => isJSONRPCRequest(m) && m.method !== 'initialize').map((m) => m.id);
}

/**
 * MCP endpoint (Streamable HTTP, stateful sessions). Each session gets its own McpServer
 * instance bound to an {@link AgentSession} (editor state, undo history and presence).
 */
export class McpHub {
  private readonly sessions = new Map<string, McpSession>();
  /** Identities of agent ids, kept between their sessions (undo histories, editor states). */
  private readonly identities = new Map<string, AgentIdentity>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly unsubscribeRooms: () => void;
  private readonly idleTimeoutMs: number;
  private readonly presenceIdleMs: number;
  private readonly identityTtlMs: number;
  private closing = false;

  constructor(private readonly opts: McpHubOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.presenceIdleMs = Math.min(opts.presenceIdleMs ?? 5 * 60 * 1000, this.idleTimeoutMs);
    this.identityTtlMs = opts.identityTtlMs ?? 6 * 60 * 60 * 1000;
    this.sweeper = setInterval(
      () => this.sweep(),
      Math.max(1000, Math.min(60_000, Math.floor(this.presenceIdleMs / 2))),
    );
    this.sweeper.unref?.();
    // a deleted or unloaded project: every session and agent id lets go of its document at once
    this.unsubscribeRooms = opts.rooms.onRoomClosed((room) => {
      for (const s of this.sessions.values()) s.agent.release(room);
      for (const id of this.identities.values()) id.release(room);
    });
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Agent identities kept (live or between sessions). */
  get identityCount(): number {
    return this.identities.size;
  }

  /** The shared identity of an agent id (created on first use; least recently used ones evicted). */
  private identity(agentId: string): AgentIdentity {
    let id = this.identities.get(agentId);
    if (!id) {
      id = new AgentIdentity(`agent:${agentId}`, agentId, this.opts.history);
      this.identities.set(agentId, id);
      const max = Math.max(1, this.opts.maxIdentities ?? 200);
      if (this.identities.size > max) {
        const idle = [...this.identities.values()]
          .filter((x) => x.sessions <= 0 && x !== id)
          .sort((a, b) => a.lastUsed - b.lastUsed);
        for (const x of idle.slice(0, this.identities.size - max)) {
          this.identities.delete(x.agentId!);
          x.dispose();
        }
      }
    }
    id.lastUsed = Date.now();
    return id;
  }

  /** Builds the MCP server of one session. */
  createServer(agent: AgentSession): McpServer {
    const { rooms, services, config, metrics, log } = this.opts;
    const server = new McpServer(
      { name: '3d-editor', title: '3D Editor', version: config.version },
      { instructions: MCP_INSTRUCTIONS },
    );
    const ctx: ToolContext = {
      agent,
      rooms,
      registry: services.registry,
      config,
      metrics,
      log,
      renderer: services.renderer,
      renderStore: services.renderStore,
      exports: services.exports,
      store: services.store,
      historyLimits: resolveHistoryLimits(this.opts.history),
    };
    registerTools(server, ctx);
    registerResources(server, ctx);
    server.server.oninitialized = () => {
      const info = server.server.getClientVersion();
      agent.setClientName(info?.title ?? info?.name);
      log.info(
        {
          session: agent.id,
          client: info?.name,
          clientVersion: info?.version,
          ...(agent.agentId ? { agent: agent.agentId } : {}),
        },
        'MCP session initialized',
      );
    };
    return server;
  }

  private track(session: McpSession, reply: FastifyReply): void {
    session.open++;
    session.lastActive = Date.now();
    session.agent.identity.lastUsed = session.lastActive;
    // a request shows the presence of a session that went quiet again (not the one ending it)
    if (reply.request.method !== 'DELETE') session.agent.setAway(false);
    reply.raw.once('close', () => {
      session.open--;
      session.lastActive = Date.now();
    });
  }

  private async dispose(session: McpSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    this.opts.metrics.mcpSessions.set(this.sessions.size);
    session.agent.dispose();
    await session.server.close().catch(() => undefined);
    this.opts.log.info({ session: session.id }, 'MCP session closed');
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.open > 0) continue;
      const idle = now - s.lastActive;
      if (idle > this.idleTimeoutMs) {
        this.opts.log.info({ session: s.id }, 'closing idle MCP session');
        void s.transport.close().catch(() => undefined);
        void this.dispose(s);
      } else if (idle > this.presenceIdleMs) s.agent.setAway(true);
    }
    for (const [key, id] of this.identities) {
      if (id.sessions > 0) continue;
      if (now - id.lastUsed > this.identityTtlMs) {
        this.identities.delete(key);
        id.dispose();
      } else id.prune();
    }
  }

  /**
   * Cancels a request of a session as if the client had sent `notifications/cancelled`: its
   * handler's abort signal fires (renders stop) and no response is sent.
   */
  private cancel(session: McpSession, requestId: RequestId, reason: string): void {
    const notification: JSONRPCNotification = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId, reason },
    };
    try {
      session.transport.onmessage?.(notification);
    } catch (err) {
      this.opts.log.debug(
        { err: errorMessage(err), session: session.id },
        'cancelling an MCP request failed',
      );
    }
  }

  private async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    session: McpSession,
    body?: unknown,
  ): Promise<void> {
    this.track(session, reply);
    // A POST's responses go out on its own response stream; without an event store (no stream
    // resumption) they can never be delivered once the client is gone (agent killed, connection
    // dropped). Cancel those requests then, so a render does not hold render processes until its
    // time limit for nobody.
    const ids = requestIds(body);
    if (ids.length)
      reply.raw.once('close', () => {
        if (reply.raw.writableFinished || session.closed) return;
        for (const id of ids) this.cancel(session, id, 'the client disconnected');
      });
    reply.hijack();
    try {
      await session.transport.handleRequest(request.raw, reply.raw, body);
    } catch (err) {
      this.opts.log.warn({ err: errorMessage(err), session: session.id }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal server error')));
      }
    }
  }

  private sessionFor(request: FastifyRequest): { id?: string; session?: McpSession } {
    const header = request.headers['mcp-session-id'];
    const id = Array.isArray(header) ? header[0] : header;
    return { id, session: id ? this.sessions.get(id) : undefined };
  }

  register(app: FastifyInstance): void {
    app.post(MCP_PATH, { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
      if (this.closing) return reply.code(503).send(rpcError(-32000, 'server is shutting down'));
      const { id, session } = this.sessionFor(request);
      if (id) {
        if (!session) return reply.code(404).send(rpcError(-32001, 'Session not found'));
        await this.handle(request, reply, session, request.body);
        return reply;
      }
      if (!isInitializeRequest(request.body)) {
        return reply.code(400).send(rpcError(-32000, 'Bad Request: No valid session ID provided'));
      }
      if (this.sessions.size >= (this.opts.maxSessions ?? 1000)) {
        return reply.code(503).send(rpcError(-32000, 'Too many open MCP sessions'));
      }
      let agentId: string | null;
      try {
        agentId = agentIdOf(request);
      } catch (err) {
        return reply.code(400).send(rpcError(-32602, err instanceof ToolError ? err.message : String(err)));
      }
      const sessionId = randomUUID();
      const agent = new AgentSession(
        sessionId,
        {
          rooms: this.opts.rooms,
          registry: this.opts.services.registry,
          log: this.opts.log,
          history: this.opts.history,
        },
        agentId ? this.identity(agentId) : undefined,
      );
      const server = this.createServer(agent);
      const entry: McpSession = {
        id: sessionId,
        transport: undefined as unknown as StreamableHTTPServerTransport,
        server,
        agent,
        lastActive: Date.now(),
        open: 0,
        closed: false,
      };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (sid) => {
          this.sessions.set(sid, entry);
          this.opts.metrics.mcpSessions.set(this.sessions.size);
        },
      });
      entry.transport = transport;
      transport.onclose = () => void this.dispose(entry);
      await server.connect(transport);
      await this.handle(request, reply, entry, request.body);
      if (!this.sessions.has(sessionId)) {
        // initialization failed: release everything
        agent.dispose();
        await server.close().catch(() => undefined);
      }
      return reply;
    });

    const streamOrDelete = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, session } = this.sessionFor(request);
      if (!id) return reply.code(400).send(rpcError(-32000, 'Missing Mcp-Session-Id header'));
      if (!session) return reply.code(404).send(rpcError(-32001, 'Session not found'));
      await this.handle(request, reply, session);
      return reply;
    };
    app.get(MCP_PATH, streamOrDelete);
    app.delete(MCP_PATH, streamOrDelete);
  }

  /** Closes every session (server shutdown). */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweeper);
    this.unsubscribeRooms();
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.transport.close()));
    await Promise.allSettled(sessions.map((s) => this.dispose(s)));
    for (const id of this.identities.values()) id.dispose();
    this.identities.clear();
  }
}
