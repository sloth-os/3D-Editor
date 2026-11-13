import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHttpObservability } from '../../src/observability/http';
import { ServerMetrics } from '../../src/observability/metrics';

describe('access log (request completed)', () => {
  it('logs 507 refusals at warn, other 5xx at error and 4xx at info', async () => {
    const logged: { level: number; msg?: string; statusCode?: number }[] = [];
    const app = Fastify({
      logger: { level: 'info', stream: { write: (line: string) => void logged.push(JSON.parse(line)) } },
      // (only this module's line: Fastify's own request lines are off)
      disableRequestLogging: true,
    });
    registerHttpObservability(app, new ServerMetrics({ defaultMetrics: false }), { tracing: false });
    app.get('/s/:code', async (request, reply) => {
      const code = Number((request.params as { code: string }).code);
      return reply.code(code).send({ error: 'x' });
    });
    try {
      for (const code of [200, 404, 500, 503, 507]) {
        const res = await app.inject({ method: 'GET', url: `/s/${code}` });
        expect(res.statusCode).toBe(code);
      }
    } finally {
      await app.close();
    }
    const levels = Object.fromEntries(
      logged.filter((l) => l.msg === 'request completed').map((l) => [l.statusCode, l.level]),
    );
    // pino levels: 30 info, 40 warn, 50 error
    expect(levels).toEqual({ 200: 30, 404: 30, 500: 50, 503: 50, 507: 40 });
  });
});
