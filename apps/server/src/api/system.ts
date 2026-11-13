import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config';
import type { Persistence } from '../persistence';
import type { ServerMetrics } from '../observability/metrics';
import { DAV_PREFIX } from '../dav/rewrite';

/** Public client configuration (`GET /api/config`). */
export function clientConfig(config: ServerConfig, persistence: Persistence) {
  return {
    version: config.version,
    features: {
      sync: true,
      mcp: config.mcpEnabled,
      telemetry: config.telemetryEnabled,
      webdavProxy: config.webdavProxy,
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
  },
): void {
  const { config, persistence, metrics } = deps;

  app.get('/api/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return clientConfig(config, persistence);
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
