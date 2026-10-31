import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, eventually, startServer, type TestServer } from '../helpers/app';

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === 'string' ? { stringValue: value } : { intValue: String(value) },
});

function tracesPayload() {
  const start = BigInt(Date.now()) * 1_000_000n;
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', '3d-editor-web')] },
        scopeSpans: [
          {
            scope: { name: '3d-editor-web', version: 'test' },
            spans: [
              {
                traceId: '0af7651916cd43dd8448eb211c80319c',
                spanId: 'b7ad6b7169203331',
                name: 'operator mesh.primitive_cube_add',
                kind: 1,
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: (start + 4_000_000n).toString(),
                attributes: [
                  kv('operator.id', 'mesh.primitive_cube_add'),
                  kv('operator.source', 'hotkey'),
                  kv('operator.mode', 'OBJECT'),
                ],
                status: { code: 1 },
              },
              {
                traceId: '0af7651916cd43dd8448eb211c80319c',
                spanId: 'b7ad6b7169203332',
                name: 'sync.connect',
                kind: 1,
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: (start + 1_000_000n).toString(),
                attributes: [],
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  };
}

const metricsPayload = {
  resourceMetrics: [
    {
      resource: { attributes: [kv('service.name', '3d-editor-web')] },
      scopeMetrics: [
        {
          scope: { name: '3d-editor-web' },
          metrics: [
            { name: 'editor.fps', unit: '', gauge: { dataPoints: [{ timeUnixNano: '1', asDouble: 60 }] } },
            {
              name: 'editor.sync.latency_ms',
              unit: 'ms',
              histogram: {
                aggregationTemporality: 1,
                dataPoints: [
                  {
                    count: '3',
                    sum: 45,
                    bucketCounts: ['0', '0', '0', '1', '2', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
                    explicitBounds: [1, 2, 5, 10, 16, 33, 50, 100, 250, 500, 1000, 2500, 5000],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

const logsPayload = {
  resourceLogs: [
    {
      resource: { attributes: [kv('service.name', '3d-editor-web')] },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1',
              severityNumber: 17,
              severityText: 'ERROR',
              body: { stringValue: 'TypeError: x is undefined' },
              attributes: [kv('error.source', 'window.onerror')],
            },
            {
              timeUnixNano: '1',
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: 'saved' },
              attributes: [],
            },
          ],
        },
      ],
    },
  ],
};

function post(server: TestServer, signal: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}/otlp/v1/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
}

describe('browser telemetry ingestion', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
    await server.cleanup();
  });

  it('aggregates traces, metrics and logs into /metrics', async () => {
    expect((await post(server, 'traces', tracesPayload())).status).toBe(200);
    expect((await post(server, 'metrics', metricsPayload)).status).toBe(200);
    expect((await post(server, 'logs', logsPayload)).status).toBe(200);
    // sendBeacon style (text/plain) and gzip encoded payloads are accepted too
    expect(
      (
        await post(server, 'traces', JSON.stringify(tracesPayload()), {
          'content-type': 'text/plain;charset=UTF-8',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(server, 'logs', gzipSync(JSON.stringify(logsPayload)), { 'content-encoding': 'gzip' }))
        .status,
    ).toBe(200);

    const res = await fetch(`${server.url}/metrics`);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain(
      'editor_operator_executions_total{operator="mesh.primitive_cube_add",source="hotkey",status="ok"} 2',
    );
    expect(text).toContain('editor_operator_duration_seconds_count{operator="mesh.primitive_cube_add"} 2');
    expect(text).toContain('editor_client_spans_total{name="sync.connect"} 2');
    expect(text).toContain('editor_fps_count 1');
    expect(text).toContain('editor_sync_latency_seconds_count 3');
    expect(text).toContain('editor_sync_latency_seconds_bucket{le="0.016"} 3');
    expect(text).toContain('editor_client_logs_total{severity="ERROR"} 2');
    expect(text).toContain('editor_client_logs_total{severity="INFO"} 2');
    expect(text).toContain('telemetry_payloads_total{signal="traces",status="accepted"} 2');
    expect(text).toMatch(/http_requests_total\{method="POST",route="\/otlp\/v1\/:signal",status="200"\} \d+/);
  });

  it('rejects malformed, unsupported and oversized payloads', async () => {
    expect((await post(server, 'traces', '{not json')).status).toBe(400);
    expect((await post(server, 'traces', '[1,2]')).status).toBe(400);
    expect((await post(server, 'profiles', {})).status).toBe(404);
    expect((await post(server, 'traces', 'x', { 'content-type': 'application/x-protobuf' })).status).toBe(
      415,
    );
    const big = JSON.stringify({ resourceSpans: [], pad: 'x'.repeat(5 * 1024 * 1024) });
    expect((await post(server, 'traces', big)).status).toBe(413);
    const partial = await post(server, 'traces', {
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'ok span' }, { nope: true }] }] }],
    });
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
  });
});

describe('telemetry disabled', () => {
  it('answers 204 and drops payloads', async () => {
    const server = await startServer({ TELEMETRY_ENABLED: 'false' });
    try {
      expect((await api(server.url, '/api/config')).body.features.telemetry).toBe(false);
      const res = await post(server, 'traces', tracesPayload());
      expect(res.status).toBe(204);
      const text = await (await fetch(`${server.url}/metrics`)).text();
      expect(text).not.toContain('editor_operator_executions_total{');
      expect(text).toContain('telemetry_payloads_total{signal="traces",status="dropped"} 1');
    } finally {
      await server.close();
      await server.cleanup();
    }
  });
});

describe('OTLP export and forwarding', () => {
  let collector: http.Server;
  let collectorUrl: string;
  const received: { path: string; body: string; headers: http.IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    collector = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: req.headers,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', () => r()));
    const addr = collector.address() as { port: number };
    collectorUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => collector.close(() => r()));
  });

  it('forwards browser payloads verbatim and exports server spans', async () => {
    const server = await startServer({
      OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=k1',
    });
    let closed = false;
    try {
      const body = JSON.stringify(tracesPayload());
      expect((await post(server, 'traces', body)).status).toBe(200);
      await eventually(
        () => received.some((r) => r.path === '/v1/traces' && r.body === body),
        5000,
        'forwarded payload',
      );
      const fwd = received.find((r) => r.body === body)!;
      expect(fwd.headers['x-collector-key']).toBe('k1');
      expect((await api(server.url, '/healthz')).status).toBe(200);
      await server.close(); // flushes the SDK
      closed = true;
      await eventually(
        () =>
          received.some(
            (r) =>
              r.path === '/v1/traces' &&
              r.body !== body &&
              r.body.includes('3d-editor-server') &&
              r.body.includes('GET /healthz'),
          ),
        10_000,
        'server spans exported',
      );
    } finally {
      if (!closed) await server.close();
      await server.cleanup();
    }
  });

  it('counts forwarding failures', async () => {
    const server = await startServer({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    try {
      expect((await post(server, 'logs', logsPayload)).status).toBe(200);
      await eventually(
        async () =>
          /telemetry_forward_failures_total\{signal="logs"\} 1/.test(
            await (await fetch(`${server.url}/metrics`)).text(),
          ),
        10_000,
        'failure counter',
      );
    } finally {
      await server.close();
      await server.cleanup();
    }
  });
});
