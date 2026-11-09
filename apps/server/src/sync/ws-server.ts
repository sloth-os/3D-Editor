import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isValidProjectId } from '@3d-editor/core';
import type { ServerConfig } from '../config';
import { isAuthorized, pathnameOf } from '../auth';
import type { Log } from '../observability/log';
import { errorMessage } from '../observability/tracing';
import { PROJECT_DELETED_CLOSE_CODE, type RoomManager } from './room-manager';
import type { SyncConnection } from './room';

const SYNC_PATH_RE = /^\/sync\/([^/]+)\/?$/;
const KEEPALIVE_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

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
  keepaliveMs?: number;
}

/**
 * Real-time sync endpoint: WebSocket upgrades on `/sync/<projectId>` (handled outside of
 * Fastify's router, in noServer mode). Dead sockets are detected with protocol-level pings.
 */
export class SyncServer {
  readonly wss: WebSocketServer;
  private readonly connections = new Map<WebSocket, SyncConnection>();
  private readonly keepalive: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(private readonly opts: SyncServerOptions) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    this.keepalive = setInterval(() => this.ping(), opts.keepaliveMs ?? KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  /** `upgrade` listener for the HTTP server. */
  readonly handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void this.upgrade(req, socket, head).catch((err) => {
      this.opts.log.warn({ err: errorMessage(err) }, 'websocket upgrade failed');
      rejectUpgrade(socket, 500, 'internal error');
    });
  };

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    if (this.closing) return rejectUpgrade(socket, 503, 'server is shutting down');
    const pathname = pathnameOf(req.url);
    const m = SYNC_PATH_RE.exec(pathname);
    if (!m) return rejectUpgrade(socket, 404, 'not found');
    let projectId: string;
    try {
      projectId = decodeURIComponent(m[1]);
    } catch {
      return rejectUpgrade(socket, 400, 'invalid project id');
    }
    if (!isValidProjectId(projectId)) return rejectUpgrade(socket, 400, 'invalid project id');
    if (!isAuthorized(this.opts.config, pathname, req.headers, req.url)) {
      return rejectUpgrade(socket, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="3d-editor"' });
    }
    // null for a project deleted here within the hour (unless storage holds it again)
    const room = await this.opts.rooms.open(projectId, { create: true });
    if (socket.destroyed) return;
    if (!room) {
      // Browsers cannot read the status of a refused upgrade (they see code 1006, as for a lost
      // network, and connect again and again): the connection is accepted and closed at once with
      // the code a room closes its connections with when its project is deleted.
      this.opts.log.debug({ project: projectId }, 'closed a sync connection to a deleted project');
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.refuse(ws, projectId, PROJECT_DELETED_CLOSE_CODE, 'project deleted'),
      );
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (room.destroyed || this.closing) {
        this.refuse(ws, projectId, 1012, 'room closed');
        return;
      }
      const conn = room.addConnection(ws, req.socket.remoteAddress);
      this.connections.set(ws, conn);
      ws.once('close', () => this.connections.delete(ws));
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
