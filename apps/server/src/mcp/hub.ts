import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { OperatorRegistry } from '@3d-editor/core';
import type { ServerConfig } from '../config';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import { errorMessage } from '../observability/tracing';
import type { RoomManager } from '../sync/room-manager';
import { AgentSession } from './agent';
import { MCP_INSTRUCTIONS } from './instructions';
import { registerResources, registerTools, type ToolContext } from './tools';
import { sharedRenderer, type Renderer } from '../render';
import { sharedRenderStore, type RenderStore } from '../render/store';

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
  registry: OperatorRegistry;
  config: ServerConfig;
  metrics: ServerMetrics;
  log: Log;
  /** Sessions without activity are closed after this time (default 30 min). */
  idleTimeoutMs?: number;
  maxSessions?: number;
  /** Server-side renderer (default: the process-wide one, see `RENDER_WORKERS`). */
  renderer?: Renderer;
  /** Where render_animation keeps stored results (default: the process-wide store). */
  renderStore?: RenderStore;
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * MCP endpoint (Streamable HTTP, stateful sessions). Each session gets its own McpServer
 * instance bound to an {@link AgentSession} (editor state, undo history and presence).
 */
export class McpHub {
  private readonly sessions = new Map<string, McpSession>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly idleTimeoutMs: number;
  private closing = false;

  constructor(private readonly opts: McpHubOptions) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.sweeper = setInterval(
      () => this.sweep(),
      Math.max(1000, Math.min(60_000, Math.floor(this.idleTimeoutMs / 2))),
    );
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Builds the MCP server of one session. */
  createServer(agent: AgentSession): McpServer {
    const { rooms, registry, config, metrics, log } = this.opts;
    const server = new McpServer(
      { name: '3d-editor', title: '3D Editor', version: config.version },
      { instructions: MCP_INSTRUCTIONS },
    );
    const ctx: ToolContext = {
      agent,
      rooms,
      registry,
      config,
      metrics,
      log,
      renderer: this.opts.renderer ?? sharedRenderer({ log }),
      renderStore: this.opts.renderStore ?? sharedRenderStore(),
    };
    registerTools(server, ctx);
    registerResources(server, ctx);
    server.server.oninitialized = () => {
      const info = server.server.getClientVersion();
      agent.setClientName(info?.title ?? info?.name);
      log.info(
        { session: agent.id, client: info?.name, clientVersion: info?.version },
        'MCP session initialized',
      );
    };
    return server;
  }

  private track(session: McpSession, reply: FastifyReply): void {
    session.open++;
    session.lastActive = Date.now();
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
      if (s.open <= 0 && now - s.lastActive > this.idleTimeoutMs) {
        this.opts.log.info({ session: s.id }, 'closing idle MCP session');
        void s.transport.close().catch(() => undefined);
        void this.dispose(s);
      }
    }
  }

  private async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    session: McpSession,
    body?: unknown,
  ): Promise<void> {
    this.track(session, reply);
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
      const sessionId = randomUUID();
      const agent = new AgentSession(sessionId, {
        rooms: this.opts.rooms,
        registry: this.opts.registry,
        log: this.opts.log,
      });
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
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.transport.close()));
    await Promise.allSettled(sessions.map((s) => this.dispose(s)));
  }
}
