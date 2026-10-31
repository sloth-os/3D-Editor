import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { ServerMetrics } from '../observability/metrics';
import {
  OTLP_SIGNALS,
  type OtlpForwarder,
  type OtlpSignal,
  type TelemetryIngestor,
} from '../observability/telemetry-ingest';

export const OTLP_BODY_LIMIT = 5 * 1024 * 1024;

/**
 * Browser telemetry ingestion: `POST /otlp/v1/{traces,metrics,logs}` with OTLP/HTTP JSON.
 * Payloads are aggregated into Prometheus metrics and, when an OTLP endpoint is configured,
 * forwarded verbatim to the collector.
 */
export async function registerOtlpRoutes(
  app: FastifyInstance,
  deps: {
    enabled: boolean;
    metrics: ServerMetrics;
    ingestor: TelemetryIngestor;
    forwarder: OtlpForwarder | null;
  },
): Promise<void> {
  const { metrics, ingestor, forwarder } = deps;
  const payloads = metrics.client.payloads;

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: OTLP_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

    scope.post<{ Params: { signal: string } }>(
      '/otlp/v1/:signal',
      { bodyLimit: OTLP_BODY_LIMIT },
      async (request, reply) => {
        const signal = request.params.signal as OtlpSignal;
        if (!OTLP_SIGNALS.includes(signal))
          return reply.code(404).send({ error: `unknown OTLP signal '${request.params.signal}'` });
        if (!deps.enabled) {
          payloads.inc({ signal, status: 'dropped' });
          return reply.code(204).send();
        }
        const contentType = String(request.headers['content-type'] ?? 'application/json').toLowerCase();
        if (!contentType.includes('json') && !contentType.startsWith('text/plain')) {
          payloads.inc({ signal, status: 'unsupported' });
          return reply.code(415).send({ error: 'only OTLP/HTTP JSON payloads are supported' });
        }
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        let text: string;
        try {
          const encoding = String(request.headers['content-encoding'] ?? '').toLowerCase();
          text =
            encoding === 'gzip'
              ? zlib.gunzipSync(raw, { maxOutputLength: OTLP_BODY_LIMIT * 4 }).toString('utf8')
              : encoding === 'deflate'
                ? zlib.inflateSync(raw, { maxOutputLength: OTLP_BODY_LIMIT * 4 }).toString('utf8')
                : raw.toString('utf8');
        } catch {
          payloads.inc({ signal, status: 'invalid' });
          return reply.code(400).send({ error: 'could not decompress the payload' });
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          payloads.inc({ signal, status: 'invalid' });
          return reply.code(400).send({ error: 'invalid JSON' });
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          payloads.inc({ signal, status: 'invalid' });
          return reply.code(400).send({ error: 'expected an OTLP JSON object' });
        }
        const result = ingestor.ingest(signal, body);
        forwarder?.forward(
          signal,
          raw,
          String(request.headers['content-type'] ?? 'application/json'),
          request.headers['content-encoding'],
        );
        payloads.inc({ signal, status: 'accepted' });
        if (result.rejected === 0) return reply.code(200).send({});
        const field =
          signal === 'traces'
            ? 'rejectedSpans'
            : signal === 'metrics'
              ? 'rejectedDataPoints'
              : 'rejectedLogRecords';
        return reply.code(200).send({
          partialSuccess: {
            [field]: String(result.rejected),
            errorMessage: 'some items were malformed and ignored',
          },
        });
      },
    );
  });
}
