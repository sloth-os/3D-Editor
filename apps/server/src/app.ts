import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { IncomingMessage } from 'node:http';
import { createOperatorRegistry } from '@3d-editor/core';
import type { ServerConfig } from './config';
import { isAuthorized, redactUrl, routedPath } from './auth';
import { trimTrailingSlashes } from './base-path';
import { keptForwardedPrefix, originalUrlOf, requestBaseInfo, rewriteRequestUrl } from './request-base';
import type { Log } from './observability/log';
import { createPersistence, type Persistence } from './persistence';
import { RoomManager } from './sync/room-manager';
import { SyncServer } from './sync/ws-server';
import { registerProjectRoutes } from './api/projects';
import { registerSystemRoutes } from './api/system';
import { registerOtlpRoutes } from './api/otlp';
import { registerVideoExportRoutes } from './api/video-exports';
import { registerStoreRoutes } from './api/store';
import { closeServerServices, createServerServices, type ServerServices } from './services';
import { hasFfmpeg } from './video/ffmpeg';
import { registerDavProxy, registerWebDAVMethods, WEBDAV_EXTRA_METHODS } from './dav/proxy';
import { McpHub } from './mcp/hub';
import { registerStatic } from './static';
import { ServerMetrics } from './observability/metrics';
import { loggerOptions } from './observability/logger';
import { registerHttpObservability } from './observability/http';
import { startOpenTelemetry } from './observability/tracing';
import { OtlpForwarder, TelemetryIngestor } from './observability/telemetry-ingest';

/** The base path a request's pages and links are written with (request-base.ts, docs/subpath.md). */
export { requestBase } from './request-base';

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
  /** fetch used by the model store's providers (tests; default: the global fetch). */
  serviceFetch?: typeof fetch;
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
  /** The services shared by the MCP tools and the REST routes (video exports, model store …). */
  services: ServerServices;
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

/**
 * Answers a request for BASE_PATH without its slash (`/3d`, `/3d?x=1`) with a redirect to it with
 * its slash, so that the editor's pages are inside the service worker's scope (docs/subpath.md).
 * The redirect depends on BASE_PATH alone, never on X-Forwarded-Prefix.
 */
function registerBareBaseRedirect(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const info = requestBaseInfo(request);
    if (!info?.bare) return;
    // request.url is the URL from BASE_PATH: '/' and the query
    return reply.code(308).header('location', `${info.removed}${request.url}`).send();
  });
}

/**
 * Says once per server, at warn, that a request came through a proxy that keeps in the path a prefix
 * the server does not remove: its path (from BASE_PATH) starts with its own X-Forwarded-Prefix,
 * which is not BASE_PATH (docs/subpath.md). Only once, so that clients that send the header cannot
 * fill the log.
 */
function keptPrefixWarning(basePath: string, log: Log): (req: IncomingMessage, url: string) => void {
  let said = false;
  return (req, url) => {
    if (said) return;
    const prefix = keptForwardedPrefix(req, url, basePath);
    if (prefix === null) return;
    said = true;
    log.warn(
      { prefix, url: redactUrl(originalUrlOf(req)) },
      `a request path starts with its X-Forwarded-Prefix ${prefix}, which the server does not remove ` +
        `from paths (only BASE_PATH): a proxy that keeps the prefix needs BASE_PATH=${prefix} ` +
        '(docs/subpath.md; said once)',
    );
  };
}

/**
 * The Origin a CORS answer allows (`*` when any origin is), or null: an origin is allowed when,
 * without its trailing slashes, it is one of `origins` (CORS_ORIGINS). Linear in the header's length.
 */
export function corsAllowedOrigin(origin: string | undefined, origins: readonly string[]): string | null {
  if (!origin || origins.length === 0) return null;
  if (origins.includes('*')) return '*';
  return origins.includes(trimTrailingSlashes(origin)) ? origin : null;
}

function registerCors(app: FastifyInstance, origins: string[]): void {
  if (origins.length === 0) return;
  app.addHook('onRequest', async (request, reply) => {
    const allowed = corsAllowedOrigin(request.headers.origin, origins);
    if (allowed === null) return;
    // Raw headers so they also apply to hijacked responses (MCP streams).
    const res = reply.raw;
    res.setHeader('access-control-allow-origin', allowed);
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
  // Before routing, every request's URL is put in origin form and loses BASE_PATH (request-base.ts,
  // docs/subpath.md): routes, hooks and handlers see paths from the server's root, and
  // request.originalUrl keeps the URL as sent. HTTP requests in Fastify's rewriteUrl, WebSocket
  // upgrades in an 'upgrade' listener (below).
  let warnKeptPrefix = (_req: IncomingMessage, _url: string): void => {};
  const rewrite = (req: IncomingMessage): string => {
    const url = rewriteRequestUrl(req, config.basePath);
    warnKeptPrefix(req, url);
    return url;
  };
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config.logLevel, serviceName, config.version),
    logController: new ServerLogController(),
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
    return503OnClosing: true,
    rewriteUrl: rewrite,
  });
  const log = app.log;
  warnKeptPrefix = keptPrefixWarning(config.basePath, log);

  const otel = await startOpenTelemetry(config.otel, log);
  const metrics = new ServerMetrics({ defaultMetrics: opts.defaultMetrics });
  if (otel.meter) metrics.attachMeter(otel.meter);

  // Hooks first: they apply to every route registered afterwards. The redirect of a bare base
  // comes right after the access log's hook (which only observes), before anything else answers.
  registerHttpObservability(app, metrics, { tracing: otel.enabled });
  registerBareBaseRedirect(app);
  registerCors(app, config.corsOrigins);
  // the scope of the route that serves the request, whatever the spelling of its path (auth.ts)
  app.addHook('onRequest', async (request, reply) => {
    if (isAuthorized(config, routedPath(request), request.headers, request.url)) return;
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
  const sync = new SyncServer({ rooms, config, log, metrics, keepaliveMs: opts.keepaliveMs });
  // WebSocket upgrades do not pass Fastify: their URL is rewritten here, before the sync server
  // (and any other 'upgrade' listener) reads it
  const rewriteUpgrade = (req: IncomingMessage) => {
    req.url = rewrite(req);
  };
  app.server.prependListener('upgrade', rewriteUpgrade);
  app.server.on('upgrade', sync.handleUpgrade);

  // the services of the MCP tools and REST routes (the operator registry is made now when MCP is
  // on, as before; otherwise on first use)
  const services = createServerServices({
    config,
    log,
    metrics,
    rooms,
    registry: config.mcpEnabled ? createOperatorRegistry() : undefined,
    fetch: opts.serviceFetch,
  });
  // video export needs ffmpeg: checked once at startup (`ffmpeg -version`, cached per process)
  const videoExport = await hasFfmpeg(config.ffmpegPath);

  let shuttingDown = false;
  registerSystemRoutes(app, {
    config,
    persistence,
    metrics,
    startedAt,
    isShuttingDown: () => shuttingDown,
    features: { videoExport },
  });
  registerProjectRoutes(app, rooms);
  registerVideoExportRoutes(app, services);
  registerStoreRoutes(app, services);
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
      services,
      config,
      metrics,
      log,
      idleTimeoutMs: opts.mcpIdleTimeoutMs,
      presenceIdleMs: opts.mcpPresenceIdleMs,
      history: { maxSteps: config.mcpUndoSteps, maxBytes: config.mcpUndoMemoryBytes },
    });
    mcp.register(app);
  }

  const serving = await registerStatic(app, config.publicDir, config.deskEmbed);
  if (!serving) log.info({ publicDir: config.publicDir }, 'no PWA build found: serving the API only');

  app.addHook('preClose', async () => {
    shuttingDown = true;
    // export jobs and their ffmpeg processes and model downloads stop before the projects are
    // saved and closed
    await Promise.allSettled([mcp?.close(), sync.close(), closeServerServices(services)]);
  });
  app.addHook('onClose', async () => {
    app.server.off('upgrade', sync.handleUpgrade);
    app.server.off('upgrade', rewriteUpgrade);
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
    services,
    close() {
      closing ??= app.close();
      return closing;
    },
  };
}
