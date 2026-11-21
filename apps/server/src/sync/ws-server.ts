import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MSG_CONTROL,
  OUT_OF_MEMORY_CLOSE_CODE,
  PROJECT_DELETED_CLOSE_CODE,
  encodeJsonFrame,
  isValidProjectId,
} from '@3d-editor/core';
import type { ServerConfig } from '../config';
import { isAuthorized, pathnameOf, redactUrl } from '../auth';
import type { Log } from '../observability/log';
import type { ServerMetrics } from '../observability/metrics';
import { errorMessage } from '../observability/tracing';
import type { RoomManager } from './room-manager';
import type { Room, SyncConnection } from './room';
import { ProjectMemoryError } from './project-memory';

const SYNC_PATH_RE = /^\/sync\/([^/]+)\/?$/;
/** The route of sync upgrades in the access log and the HTTP metrics (as Fastify names GET /sync/:projectId). */
const SYNC_ROUTE = '/sync/:projectId';
const KEEPALIVE_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** What a handshake's access line says besides its status. */
interface HandshakeEnd {
  /** Why the server answered as it did (the refusal's message; for 101, 'connected' or why it closed at once). */
  reason: string;
  /** The client went away before the answer was written. */
  aborted?: boolean;
  /** The close code of a connection the server accepted and closed at once (a deleted project, say). */
  closeCode?: number;
}

/**
 * One WebSocket upgrade request (handled outside Fastify, so outside its access log): its answer is
 * logged and counted once, as observability/http.ts does for HTTP requests. One 'upgrade completed'
 * line with the method, the redacted url, the route ('/sync/:projectId', else 'unmatched'), the
 * status (101 when the server takes the connection), the reason and the time to the answer: at debug
 * for 101, info for 4xx and warn for 5xx. The handshake counts in http_requests_total and
 * http_request_duration_seconds under that route.
 */
class Handshake {
  private readonly start = process.hrtime.bigint();
  private done = false;
  readonly method: string;
  readonly route: string;

  constructor(
    private readonly req: IncomingMessage,
    private readonly log: Log,
    private readonly metrics: ServerMetrics | undefined,
  ) {
    this.method = req.method ?? 'GET';
    this.route = SYNC_PATH_RE.test(pathnameOf(req.url)) ? SYNC_ROUTE : 'unmatched';
  }

  get ended(): boolean {
    return this.done;
  }

  /** Logs and counts the answer (once: later calls are ignored). */
  end(statusCode: number, e: HandshakeEnd): void {
    if (this.done) return;
    this.done = true;
    const seconds = Number(process.hrtime.bigint() - this.start) / 1e9;
    const { method, route } = this;
    this.metrics?.httpRequests.inc({ method, route, status: String(statusCode) });
    this.metrics?.httpDuration.observe(seconds, { method, route });
    const level = statusCode >= 500 ? 'warn' : statusCode >= 400 ? 'info' : 'debug';
    this.log[level](
      {
        method,
        url: redactUrl(this.req.url ?? '/'),
        route,
        statusCode,
        reason: e.reason,
        ...(e.closeCode !== undefined ? { closeCode: e.closeCode } : {}),
        responseTimeMs: Math.round(seconds * 1e5) / 100,
        aborted: e.aborted ?? false,
      },
      'upgrade completed',
    );
  }
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${message}\n`;
  const headers = {
    Connection: 'close',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  };
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n${head}\r\n\r\n${body}`);
}

export interface SyncServerOptions {
  rooms: RoomManager;
  config: Pick<ServerConfig, 'authToken' | 'mcpToken'>;
  log: Log;
  /** Where each handshake is counted (http_requests_total, http_request_duration_seconds). */
  metrics?: ServerMetrics;
  keepaliveMs?: number;
}

/**
 * Real-time sync endpoint: WebSocket upgrades on `/sync/<projectId>` (handled outside of
 * Fastify's router, in noServer mode). Dead sockets are detected with protocol-level pings.
 */
export class SyncServer {
  readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, SyncConnection>();
  /** The handshake each upgrading socket belongs to (for the handshakes ws itself refuses). */
  private readonly handshakes = new WeakMap<Duplex, Handshake>();
  private readonly keepalive: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(private readonly opts: SyncServerOptions) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    // A handshake ws finds malformed (another method, no Upgrade: websocket, a bad
    // Sec-WebSocket-Key, version or subprotocol list) is answered here as ws answers it, so that it
    // is logged and counted like every other: 405 for another method, else 400.
    this.wss.on('wsClientError', (err: Error, socket: Duplex, req: IncomingMessage) => {
      const handshake = this.handshakes.get(socket) ?? new Handshake(req, opts.log, opts.metrics);
      const version = Number(req.headers['sec-websocket-version']);
      this.reject(
        handshake,
        socket,
        req.method === 'GET' ? 400 : 405,
        err.message,
        version === 13 || version === 8 ? {} : { 'Sec-WebSocket-Version': '13, 8' },
      );
    });
    this.keepalive = setInterval(() => this.ping(), opts.keepaliveMs ?? KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  /** `upgrade` listener for the HTTP server. */
  readonly handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const handshake = new Handshake(req, this.opts.log, this.opts.metrics);
    this.handshakes.set(socket, handshake);
    void this.upgrade(req, socket, head, handshake).catch((err) => {
      this.opts.log.warn({ err: errorMessage(err) }, 'websocket upgrade failed');
      this.reject(handshake, socket, 500, 'internal error');
    });
  };

  /** Refuses a handshake with an HTTP status (its access line, then the answer). */
  private reject(
    handshake: Handshake,
    socket: Duplex,
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    handshake.end(status, { reason: message, aborted: !socket.writable });
    rejectUpgrade(socket, status, message, extraHeaders);
  }

  /**
   * Completes a handshake with ws and calls `accepted` with the connection; `reason` and
   * `closeCode` are for a connection closed at once. A handshake ws refuses was answered (and
   * logged) by the 'wsClientError' listener; one it drops because the client went away, or answers
   * 503 because it is closing, is logged here.
   */
  private accept(
    handshake: Handshake,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    accepted: (ws: WebSocket) => HandshakeEnd,
  ): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => handshake.end(101, accepted(ws)));
    if (handshake.ended) return;
    if (this.closing) handshake.end(503, { reason: 'server is shutting down' });
    else handshake.end(101, { reason: 'the client went away before the answer', aborted: true });
  }

  private async upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    handshake: Handshake,
  ): Promise<void> {
    socket.on('error', () => socket.destroy());
    const reject = (status: number, message: string, headers?: Record<string, string>) =>
      this.reject(handshake, socket, status, message, headers);
    if (this.closing) return reject(503, 'server is shutting down');
    const pathname = pathnameOf(req.url);
    const m = SYNC_PATH_RE.exec(pathname);
    if (!m) return reject(404, 'not found');
    let projectId: string;
    try {
      projectId = decodeURIComponent(m[1]);
    } catch {
      return reject(400, 'invalid project id');
    }
    if (!isValidProjectId(projectId)) return reject(400, 'invalid project id');
    if (!isAuthorized(this.opts.config, pathname, req.headers, req.url)) {
      return reject(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="3d-editor"' });
    }
    // the client may leave while its project loads: the server would have taken the connection
    const gone = () =>
      handshake.end(101, { reason: 'the client went away before the answer', aborted: true });
    // null for a project deleted here within the hour (unless storage holds it again)
    let room: Room | null;
    try {
      room = await this.opts.rooms.open(projectId, { create: true });
    } catch (err) {
      if (!(err instanceof ProjectMemoryError)) throw err;
      if (socket.destroyed) return gone();
      // a stored project the server cannot load (RoomManager.load): the reason, then the close code
      // a room closes a connection with whose changes the project cannot take
      this.accept(handshake, req, socket, head, (ws) => {
        ws.send(
          encodeJsonFrame(MSG_CONTROL, { kind: 'error', message: err.message, code: 'OUT_OF_MEMORY' }),
          {
            binary: true,
          },
        );
        this.refuse(ws, projectId, OUT_OF_MEMORY_CLOSE_CODE, 'project too large for the server');
        return { reason: 'project too large for the server', closeCode: OUT_OF_MEMORY_CLOSE_CODE };
      });
      return;
    }
    if (socket.destroyed) return gone();
    if (!room) {
      // Browsers cannot read the status of a refused upgrade (they see code 1006, as for a lost
      // network, and connect again and again): the connection is accepted and closed at once with
      // the code a room closes its connections with when its project is deleted.
      this.opts.log.debug({ project: projectId }, 'closed a sync connection to a deleted project');
      this.accept(handshake, req, socket, head, (ws) => {
        this.refuse(ws, projectId, PROJECT_DELETED_CLOSE_CODE, 'project deleted');
        return { reason: 'project deleted', closeCode: PROJECT_DELETED_CLOSE_CODE };
      });
      return;
    }
    this.accept(handshake, req, socket, head, (ws) => {
      if (room.destroyed || this.closing) {
        this.refuse(ws, projectId, 1012, 'room closed');
        return { reason: 'room closed', closeCode: 1012 };
      }
      const conn = room.addConnection(ws, req.socket.remoteAddress);
      this.connections.set(ws, conn);
      ws.once('close', () => this.connections.delete(ws));
      return { reason: 'connected' };
    });
  }

  /**
   * Closes a connection that no room takes, as a room closes its connections (Room.close): a client
   * that does not answer the close frame within 2 s is disconnected (ws itself would wait 30 s, and
   * close() waits for every connection the server accepted). It gets an 'error' listener like a
   * room's connections: ws emits 'error' when a client breaks the protocol (an unmasked frame, say),
   * and an 'error' event that nobody listens to ends the process.
   */
  private refuse(ws: WebSocket, project: string, code: number, reason: string): void {
    ws.on('error', (err) => this.opts.log.debug({ err: err.message, project }, 'websocket error'));
    ws.close(code, reason);
    const t = setTimeout(() => ws.terminate(), 2000);
    t.unref?.();
    ws.once('close', () => clearTimeout(t));
  }

  private ping(): void {
    for (const [ws, conn] of this.connections) {
      if (!conn.alive) {
        this.opts.log.debug({ conn: conn.id }, 'terminating unresponsive sync client');
        ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  get size(): number {
    return this.connections.size;
  }

  /** Stops accepting connections and closes the open ones. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.keepalive);
    const sockets = [...this.connections.keys()];
    await Promise.all(
      sockets.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === ws.CLOSED) return resolve();
            const t = setTimeout(() => {
              ws.terminate();
              resolve();
            }, 2000);
            ws.once('close', () => {
              clearTimeout(t);
              resolve();
            });
            ws.close(1001, 'server shutting down');
          }),
      ),
    );
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
