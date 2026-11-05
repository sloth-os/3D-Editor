import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { createOperatorRegistry } from '@3d-editor/core';
import type { ServerConfig } from './config';
import { isAuthorized, pathnameOf } from './auth';
import { createPersistence, type Persistence } from './persistence';
import { RoomManager } from './sync/room-manager';
import { SyncServer } from './sync/ws-server';
import { registerProjectRoutes } from './api/projects';
import { registerSystemRoutes } from './api/system';
import { registerOtlpRoutes } from './api/otlp';
import { registerDavProxy, registerWebDAVMethods, WEBDAV_EXTRA_METHODS } from './dav/proxy';
import { McpHub } from './mcp/hub';
import { registerStatic } from './static';
import { ServerMetrics } from './observability/metrics';
import { loggerOptions } from './observability/logger';
import { registerHttpObservability } from './observability/http';
import { startOpenTelemetry } from './observability/tracing';
import { OtlpForwarder, TelemetryIngestor } from './observability/telemetry-ingest';

export interface AppOptions {
  /** Logger override (default: pino JSON logger at config.logLevel). */
  logger?: FastifyServerOptions['logger'];
  /** Idle timeout of MCP sessions (default 30 min). */
  mcpIdleTimeoutMs?: number;
  /** Presence of quiet MCP sessions is hidden after this time (default 5 min). */
  mcpPresenceIdleMs?: number;
  /** How often idle rooms are checked for eviction. */
  sweepIntervalMs?: number;
  /** How often rooms with editors merge storage changes made by others (default 60 s, 0 = off). */
  refreshIntervalMs?: number;
  /** WebSocket keepalive ping interval (default 30 s). */
  keepaliveMs?: number;
  /** fetch used for telemetry forwarding and WebDAV persistence (tests). */
  fetch?: typeof fetch;
  /** Disable Node default process metrics (tests creating many apps). */
  defaultMetrics?: boolean;
}

export interface AppHandle {
  app: FastifyInstance;
  config: ServerConfig;
  rooms: RoomManager;
  metrics: ServerMetrics;
  persistence: Persistence;
  sync: SyncServer;
  mcp: McpHub | null;
  /** Gracefully stops everything: closes sockets and MCP sessions, persists rooms. */
  close(): Promise<void>;
}

const CORS_ALLOW_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  ...WEBDAV_EXTRA_METHODS,
].join(', ');
const CORS_ALLOW_HEADERS =
  'authorization, content-type, depth, destination, overwrite, if, if-match, if-none-match, lock-token, timeout, ' +
  'mcp-session-id, mcp-protocol-version, x-mcp-agent-id, last-event-id, traceparent, tracestate';
const CORS_EXPOSE_HEADERS =
  'etag, dav, location, lock-token, content-disposition, mcp-session-id, mcp-protocol-version';

/** Request start/end lines are written by the observability hook; Fastify keeps logging errors. */
class ServerLogController extends LogController {
  override incomingRequest(): void {}
  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (error) super.requestCompleted(error, request, reply);
  }
}

function registerCors(app: FastifyInstance, origins: string[]): void {
  if (origins.length === 0) return;
  const anyOrigin = origins.includes('*');
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || (!anyOrigin && !origins.includes(origin.replace(/\/+$/, '')))) return;
    // Raw headers so they also apply to hijacked responses (MCP streams).
    const res = reply.raw;
    res.setHeader('access-control-allow-origin', anyOrigin ? '*' : origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-expose-headers', CORS_EXPOSE_HEADERS);
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      res.setHeader('access-control-allow-methods', CORS_ALLOW_METHODS);
      res.setHeader(
        'access-control-allow-headers',
        String(request.headers['access-control-request-headers'] ?? CORS_ALLOW_HEADERS),
      );
      res.setHeader('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });
}

/**
 * Builds the server (without listening): PWA hosting, REST API, real-time sync hub, MCP endpoint,
 * WebDAV proxy, telemetry ingestion and metrics.
 */
export async function createApp(config: ServerConfig, opts: AppOptions = {}): Promise<AppHandle> {
  const startedAt = Date.now();
  const serviceName = config.otel?.serviceName ?? '3d-editor-server';
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config.logLevel, serviceName, config.version),
    logController: new ServerLogController(),
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
    return503OnClosing: true,
  });
  const log = app.log;

  const otel = await startOpenTelemetry(config.otel, log);
  const metrics = new ServerMetrics({ defaultMetrics: opts.defaultMetrics });
  if (otel.meter) metrics.attachMeter(otel.meter);

  // Hooks first: they apply to every route registered afterwards.
  registerHttpObservability(app, metrics, { tracing: otel.enabled });
  registerCors(app, config.corsOrigins);
  app.addHook('onRequest', async (request, reply) => {
    if (isAuthorized(config, pathnameOf(request.url), request.headers, request.url)) return;
    reply.header('www-authenticate', 'Bearer realm="3d-editor"');
    return reply.code(401).send({
      error: 'unauthorized: provide the access token as "Authorization: Bearer <token>" or ?token=',
    });
  });
  if (config.webdavProxy) registerWebDAVMethods(app);

  const persistence = createPersistence(config, opts.fetch);
  const rooms = new RoomManager({
    persistence,
    metrics,
    log,
    ttlMs: config.roomIdleTtlSeconds * 1000,
    debounceMs: config.persistDebounceMs,
    serverVersion: config.version,
    sweepIntervalMs: opts.sweepIntervalMs,
    refreshIntervalMs: opts.refreshIntervalMs,
  });
  const sync = new SyncServer({ rooms, config, log, keepaliveMs: opts.keepaliveMs });
  app.server.on('upgrade', sync.handleUpgrade);

  let shuttingDown = false;
  registerSystemRoutes(app, { config, persistence, metrics, startedAt, isShuttingDown: () => shuttingDown });
  registerProjectRoutes(app, rooms);
  app.get('/sync/:projectId', async (_request, reply) =>
    reply
      .code(426)
      .header('upgrade', 'websocket')
      .send({ error: 'this endpoint requires a WebSocket upgrade' }),
  );

  const ingestor = new TelemetryIngestor(metrics.client, log);
  const forwarder = config.otel
    ? new OtlpForwarder(
        config.otel.endpoint,
        config.otel.headers,
        (signal, reason) => {
          metrics.client.forwardFailures.inc({ signal });
          log.debug({ signal, reason }, 'forwarding browser telemetry failed');
        },
        10_000,
        opts.fetch,
      )
    : null;
  await registerOtlpRoutes(app, { enabled: config.telemetryEnabled, metrics, ingestor, forwarder });

  if (config.webdavProxy && config.webdav) await registerDavProxy(app, config.webdav, log);

  let mcp: McpHub | null = null;
  if (config.mcpEnabled) {
    mcp = new McpHub({
      rooms,
      registry: createOperatorRegistry(),
      config,
      metrics,
      log,
      idleTimeoutMs: opts.mcpIdleTimeoutMs,
      presenceIdleMs: opts.mcpPresenceIdleMs,
    });
    mcp.register(app);
  }

  const serving = await registerStatic(app, config.publicDir);
  if (!serving) log.info({ publicDir: config.publicDir }, 'no PWA build found: serving the API only');

  app.addHook('preClose', async () => {
    shuttingDown = true;
    await Promise.allSettled([mcp?.close(), sync.close()]);
  });
  app.addHook('onClose', async () => {
    app.server.off('upgrade', sync.handleUpgrade);
    await rooms.close();
    await forwarder?.drain();
    await otel.shutdown();
  });

  let closing: Promise<void> | null = null;
  return {
    app,
    config,
    rooms,
    metrics,
    persistence,
    sync,
    mcp,
    close() {
      closing ??= app.close();
      return closing;
    },
  };
}
