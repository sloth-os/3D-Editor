import { describe, expect, it, vi } from 'vitest';
import { ServerMetrics } from '../../src/observability/metrics';
import {
  OtlpForwarder,
  TelemetryIngestor,
  sanitizeSpanName,
  severityOf,
} from '../../src/observability/telemetry-ingest';

const attrs = (o: Record<string, string | number | boolean>) =>
  Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === 'string'
        ? { stringValue: v }
        : typeof v === 'boolean'
          ? { boolValue: v }
          : Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v },
  }));

function span(name: string, a: Record<string, string | number | boolean>, ms: number, status = 1) {
  const start = 1_700_000_000_000_000_000n;
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name,
    kind: 1,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + BigInt(Math.round(ms * 1e6))).toString(),
    attributes: attrs(a),
    status: { code: status },
  };
}

function setup() {
  const metrics = new ServerMetrics({ defaultMetrics: false });
  const log = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const ingestor = new TelemetryIngestor(metrics.client, log, { maxSpanNames: 3 });
  return { metrics, log, ingestor, text: () => metrics.render() };
}

describe('TelemetryIngestor', () => {
  it('aggregates operator spans into executions and durations', async () => {
    const { ingestor, text } = setup();
    const res = ingestor.ingest('traces', {
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'service.name': '3d-editor-web' }) },
          scopeSpans: [
            {
              scope: { name: '3d-editor-web' },
              spans: [
                span(
                  'operator mesh.primitive_cube_add',
                  {
                    'operator.id': 'mesh.primitive_cube_add',
                    'operator.source': 'menu',
                    'operator.mode': 'OBJECT',
                  },
                  12,
                ),
                span('operator transform.translate', { 'operator.source': 'hotkey' }, 3),
                span(
                  'operator object.delete',
                  { 'operator.id': 'object.delete', 'operator.source': 'ui' },
                  2,
                  2,
                ),
                span('operator <script>', { 'operator.source': 'weird' }, 1),
              ],
            },
          ],
        },
      ],
    });
    expect(res).toEqual({ accepted: 4, rejected: 0 });
    const out = await text();
    expect(out).toContain(
      'editor_operator_executions_total{operator="mesh.primitive_cube_add",source="menu",status="ok"} 1',
    );
    expect(out).toContain(
      'editor_operator_executions_total{operator="transform.translate",source="hotkey",status="ok"} 1',
    );
    expect(out).toContain(
      'editor_operator_executions_total{operator="object.delete",source="ui",status="error"} 1',
    );
    expect(out).toContain('editor_operator_executions_total{operator="other",source="other",status="ok"} 1');
    expect(out).toContain(
      'editor_operator_duration_seconds_bucket{operator="mesh.primitive_cube_add",le="0.025"} 1',
    );
    expect(out).toContain(
      'editor_operator_duration_seconds_bucket{operator="mesh.primitive_cube_add",le="0.01"} 0',
    );
    expect(out).toMatch(/editor_operator_duration_seconds_sum\{operator="mesh.primitive_cube_add"\} 0\.012/);
    expect(out).toContain('editor_operator_duration_seconds_count{operator="transform.translate"} 1');
  });

  it('counts other spans with bounded, sanitized names', async () => {
    const { ingestor, text } = setup();
    ingestor.ingest('traces', {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span('sync.connect', {}, 5),
                span('sync.connect', {}, 5),
                span('Fetch /api/projects/123e4567-e89b-12d3-a456-426614174000', {}, 5),
                span('rpc render', {}, 5),
                span('one too many', {}, 5),
                { name: 42 },
                null,
              ],
            },
          ],
        },
      ],
    });
    const out = await text();
    expect(out).toContain('editor_client_spans_total{name="sync.connect"} 2');
    expect(out).toContain('editor_client_spans_total{name="fetch /api/projects/:id"} 1');
    expect(out).toContain('editor_client_spans_total{name="rpc render"} 1');
    expect(out).toContain('editor_client_spans_total{name="other"} 1');
  });

  it('aggregates known metrics (gauges and histograms) with unit conversion', async () => {
    const { ingestor, text } = setup();
    const res = ingestor.ingest('metrics', {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                { name: 'editor.fps', gauge: { dataPoints: [{ asDouble: 58.7 }, { asInt: '30' }] } },
                {
                  name: 'editor.frame_time_ms',
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        count: '10',
                        sum: 170,
                        bucketCounts: ['0', '0', '0', '2', '6', '2', '0', '0', '0', '0', '0', '0', '0', '0'],
                        explicitBounds: [1, 2, 5, 10, 16, 33, 50, 100, 250, 500, 1000, 2500, 5000],
                      },
                    ],
                  },
                },
                {
                  name: 'editor.sync.latency_ms',
                  histogram: {
                    dataPoints: [
                      { count: '1', sum: 40, bucketCounts: ['0', '1', '0'], explicitBounds: [10, 50] },
                    ],
                  },
                },
                {
                  name: 'web_vitals.lcp',
                  gauge: { dataPoints: [{ asDouble: 1234, attributes: attrs({ rating: 'good' }) }] },
                },
                {
                  name: 'web_vitals.cls',
                  gauge: { dataPoints: [{ asDouble: 0.02, attributes: attrs({ rating: 'bogus' }) }] },
                },
                { name: 'editor.scene.triangles', gauge: { dataPoints: [{ asInt: 12 }] } },
                { name: 'something.else', gauge: { dataPoints: [{ asDouble: 1 }] } },
                { name: 'editor.fps', gauge: { dataPoints: [{ asDouble: 'NaN' }] } },
                {
                  name: 'editor.frame_time_ms',
                  histogram: { dataPoints: [{ bucketCounts: ['1'], explicitBounds: [1, 2] }] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(res.accepted).toBe(7);
    expect(res.rejected).toBe(2);
    const out = await text();
    expect(out).toContain('editor_fps_bucket{le="30"} 1');
    expect(out).toContain('editor_fps_bucket{le="60"} 2');
    expect(out).toContain('editor_fps_count 2');
    expect(out).toContain('editor_frame_time_seconds_bucket{le="0.01"} 2');
    expect(out).toContain('editor_frame_time_seconds_bucket{le="0.016"} 8');
    expect(out).toContain('editor_frame_time_seconds_bucket{le="0.033"} 10');
    expect(out).toContain('editor_frame_time_seconds_count 10');
    expect(out).toContain('editor_frame_time_seconds_sum 0.17');
    expect(out).toContain('editor_sync_latency_seconds_bucket{le="0.05"} 1');
    expect(out).toContain('editor_sync_latency_seconds_bucket{le="0.033"} 0');
    expect(out).toContain('editor_web_vitals_lcp_seconds_bucket{rating="good",le="1.8"} 1');
    expect(out).toContain('editor_web_vitals_cls_count{rating="unknown"} 1');
    expect(out).toContain('editor_scene_triangles_count 1');
  });

  it('counts logs by severity and re-logs client errors', async () => {
    const { ingestor, log, text } = setup();
    ingestor.ingest('logs', {
      resourceLogs: [
        {
          resource: { attributes: attrs({ 'service.name': '3d-editor-web', 'session.id': 's1' }) },
          scopeLogs: [
            {
              logRecords: [
                { severityNumber: 9, severityText: 'INFO', body: { stringValue: 'hello' } },
                { severityNumber: 13, body: { stringValue: 'careful' } },
                {
                  severityNumber: 17,
                  severityText: 'ERROR',
                  body: { stringValue: 'boom' },
                  attributes: attrs({ 'error.source': 'window.onerror' }),
                },
                { severityText: 'warning', body: { stringValue: 'x' } },
                'garbage',
              ],
            },
          ],
        },
      ],
    });
    const out = await text();
    expect(out).toContain('editor_client_logs_total{severity="INFO"} 1');
    expect(out).toContain('editor_client_logs_total{severity="WARN"} 2');
    expect(out).toContain('editor_client_logs_total{severity="ERROR"} 1');
    expect(log.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = log.error.mock.calls[0];
    expect(msg).toBe('client error: boom');
    expect(obj.source).toBe('browser');
    expect(obj.client.attributes['error.source']).toBe('window.onerror');
    expect(obj.client.resource['session.id']).toBe('s1');
  });

  it('ignores malformed payloads without throwing', () => {
    const { ingestor } = setup();
    expect(ingestor.ingest('traces', null)).toEqual({ accepted: 0, rejected: 0 });
    expect(ingestor.ingest('traces', { resourceSpans: 'nope' })).toEqual({ accepted: 0, rejected: 0 });
    expect(
      ingestor.ingest('metrics', { resourceMetrics: [{ scopeMetrics: [{ metrics: [null, { name: 1 }] }] }] })
        .rejected,
    ).toBe(2);
    expect(
      ingestor.ingest('logs', { resourceLogs: [null, { scopeLogs: [{ logRecords: [1, null] }] }] }).rejected,
    ).toBe(2);
  });
});

describe('helpers', () => {
  it('sanitizes span names', () => {
    expect(sanitizeSpanName('  Sync.Connect  ')).toBe('sync.connect');
    expect(sanitizeSpanName('GET /api/projects/42')).toBe('get /api/projects/N');
    expect(sanitizeSpanName('weird<>"name')).toBe('weird_name');
    expect(sanitizeSpanName('')).toBe('unnamed');
    expect(sanitizeSpanName('x'.repeat(200))).toHaveLength(64);
  });

  it('maps severities', () => {
    expect(severityOf({ severityNumber: 1 })).toBe('TRACE');
    expect(severityOf({ severityNumber: 8 })).toBe('DEBUG');
    expect(severityOf({ severityNumber: 21 })).toBe('FATAL');
    expect(severityOf({ severityText: 'error' })).toBe('ERROR');
    expect(severityOf({})).toBe('UNSPECIFIED');
  });
});

describe('OtlpForwarder', () => {
  it('posts payloads verbatim and reports failures', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const failures: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: new TextDecoder().decode(init.body as Uint8Array),
        headers: init.headers as Record<string, string>,
      });
      return new Response('{}', { status: url.includes('logs') ? 500 : 200 });
    }) as unknown as typeof fetch;
    const f = new OtlpForwarder(
      'http://collector:4318',
      { 'x-key': 'k' },
      (signal, reason) => failures.push(`${signal}:${reason}`),
      1000,
      fetchImpl,
    );
    f.forward('traces', new TextEncoder().encode('{"resourceSpans":[]}'));
    f.forward('logs', new TextEncoder().encode('{}'), 'application/json', 'gzip');
    await f.drain();
    expect(calls[0]).toMatchObject({ url: 'http://collector:4318/v1/traces', body: '{"resourceSpans":[]}' });
    expect(calls[0].headers).toMatchObject({ 'x-key': 'k', 'content-type': 'application/json' });
    expect(calls[1].headers['content-encoding']).toBe('gzip');
    expect(failures).toEqual(['logs:HTTP 500']);
  });
});
