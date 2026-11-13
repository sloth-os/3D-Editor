import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config';
import type { Persistence } from '../persistence';
import type { ServerMetrics } from '../observability/metrics';
import { DAV_PREFIX } from '../dav/rewrite';

/** What the server found at startup that the client configuration reports. */
export interface StartupFeatures {
  /** ffmpeg runs (FFMPEG_PATH): video export is possible. */
  videoExport: boolean;
}

/** Public client configuration (`GET /api/config`). */
export function clientConfig(
  config: ServerConfig,
  persistence: Persistence,
  startup: StartupFeatures = { videoExport: false },
) {
  return {
    version: config.version,
    features: {
      sync: true,
      mcp: config.mcpEnabled,
      telemetry: config.telemetryEnabled,
      webdavProxy: config.webdavProxy,
      /** Server video export (ffmpeg was found at startup). */
      videoExport: startup.videoExport,
      /** The model store (built-in models always; external providers per STORE_PROVIDERS). */
      modelStore: true,
      /** The rideo bridge (RIDEO_URL is set). */
      rideo: config.rideoUrl !== null,
    },
    webdav:
      config.webdavProxy && config.webdav
        ? { url: DAV_PREFIX, basePath: config.webdav.basePath || '/' }
        : null,
    persistence: persistence.mode,
  };
}

export function registerSystemRoutes(
  app: FastifyInstance,
  deps: {
    config: ServerConfig;
    persistence: Persistence;
    metrics: ServerMetrics;
    startedAt: number;
    isShuttingDown: () => boolean;
    /** What the server found at startup (default: no video export). */
    features?: StartupFeatures;
  },
): void {
  const { config, persistence, metrics } = deps;

  app.get('/api/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return clientConfig(config, persistence, deps.features);
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    version: config.version,
    uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
  }));

  app.get('/readyz', async (_request, reply) => {
    if (deps.isShuttingDown()) return reply.code(503).send({ status: 'shutting_down' });
    const check = await persistence.check().catch((err: unknown) => ({ ok: false, message: String(err) }));
    const body = {
      status: check.ok ? 'ready' : 'unavailable',
      persistence: { mode: persistence.mode, ok: check.ok, message: check.message },
    };
    return reply.code(check.ok ? 200 : 503).send(body);
  });

  app.get('/metrics', async (_request, reply) => {
    const body = await metrics.render();
    return reply.header('content-type', metrics.contentType).header('cache-control', 'no-store').send(body);
  });
}
