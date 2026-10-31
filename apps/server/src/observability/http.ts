import type { FastifyInstance, FastifyRequest } from 'fastify';
import { context, propagation, trace, SpanKind, SpanStatusCode, type Context } from '@opentelemetry/api';
import type { ServerMetrics } from './metrics';
import { tracer } from './tracing';
import { pathnameOf, redactUrl } from '../auth';

const kTraceContext = Symbol('traceContext');

type TracedRequest = FastifyRequest & { [kTraceContext]?: Context };

/** Routes whose successful requests are only logged at debug level (high volume, low value). */
function isQuietRoute(route: string): boolean {
  return (
    route === '/*' ||
    route === 'unmatched' ||
    route.startsWith('/otlp') ||
    route === '/metrics' ||
    route === '/healthz' ||
    route === '/readyz'
  );
}

/**
 * Request metrics (http_requests_total, http_request_duration_seconds), server spans (when
 * tracing is enabled) and one "request completed" log line per request. Uses the raw
 * response's `close` event so hijacked replies (MCP streams, WebDAV proxy) are covered too.
 */
export function registerHttpObservability(
  app: FastifyInstance,
  metrics: ServerMetrics,
  opts: { tracing: boolean },
): void {
  app.addHook('onRequest', (request: TracedRequest, reply, done) => {
    const start = process.hrtime.bigint();
    const method = request.method;
    const route = request.routeOptions?.url ?? 'unmatched';
    let ctx: Context | undefined;
    const span = opts.tracing
      ? tracer().startSpan(
          `${method} ${route}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'http.request.method': method,
              'http.route': route,
              'url.path': pathnameOf(request.url),
              'user_agent.original': String(request.headers['user-agent'] ?? ''),
            },
          },
          propagation.extract(context.active(), request.headers),
        )
      : undefined;
    if (span) {
      ctx = trace.setSpan(propagation.extract(context.active(), request.headers), span);
      request[kTraceContext] = ctx;
    }
    let finished = false;
    reply.raw.once('close', () => {
      if (finished) return;
      finished = true;
      const status = reply.raw.statusCode;
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const aborted = !reply.raw.writableFinished;
      metrics.httpRequests.inc({ method, route, status: String(status) });
      metrics.httpDuration.observe(seconds, { method, route });
      if (span) {
        span.setAttribute('http.response.status_code', status);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
      const level = status >= 500 ? 'error' : isQuietRoute(route) && status < 400 ? 'debug' : 'info';
      // The close event runs outside the request's async context: add the trace ids explicitly.
      const sc = span?.spanContext();
      request.log[level](
        {
          ...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}),
          method,
          url: redactUrl(request.url),
          route,
          statusCode: status,
          responseTimeMs: Math.round(seconds * 1e5) / 100,
          aborted,
        },
        'request completed',
      );
    });
    if (ctx) context.with(ctx, done);
    else done();
  });

  // Re-enter the request's trace context right before the handler (body parsing happens in
  // stream callbacks that lose the async context).
  app.addHook('preHandler', (request: TracedRequest, _reply, done) => {
    const ctx = request[kTraceContext];
    if (ctx) context.with(ctx, done);
    else done();
  });
}
