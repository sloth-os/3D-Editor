import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telemetry } from '../src/telemetry/telemetry';

describe('telemetry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  function make(enabled = true) {
    const t = new Telemetry();
    t.configure({ endpoint: 'http://x/otlp', headers: () => ({}), enabled: () => enabled, resource: { 'service.name': 'test' } });
    return t;
  }

  it('exports spans, metrics and logs as OTLP JSON', async () => {
    const t = make();
    const span = t.startSpan('operator mesh.primitive_cube_add', { 'operator.id': 'mesh.primitive_cube_add', count: 2, ratio: 0.5, ok: true });
    span.setOk();
    span.end();
    t.histogram('editor.frame_time_ms', 16);
    t.histogram('editor.frame_time_ms', 40);
    t.gauge('editor.fps', 60);
    t.count('editor.select.click', 3, { mode: 'OBJECT' });
    t.log('ERROR', 'boom', { where: 'test' });
    await t.flush();
    const bodies = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse((init as RequestInit).body as string) }));
    const traces = bodies.find((b) => b.url.endsWith('/v1/traces'))!.body;
    const s = traces.resourceSpans[0].scopeSpans[0].spans[0];
    expect(s.name).toBe('operator mesh.primitive_cube_add');
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.status.code).toBe(1);
    expect(s.attributes).toContainEqual({ key: 'count', value: { intValue: '2' } });
    expect(s.attributes).toContainEqual({ key: 'ratio', value: { doubleValue: 0.5 } });
    const metrics = bodies.find((b) => b.url.endsWith('/v1/metrics'))!.body.resourceMetrics[0].scopeMetrics[0].metrics;
    const hist = metrics.find((m: { name: string }) => m.name === 'editor.frame_time_ms');
    expect(hist.histogram.dataPoints[0].count).toBe('2');
    expect(hist.histogram.dataPoints[0].sum).toBe(56);
    expect(metrics.find((m: { name: string }) => m.name === 'editor.fps').gauge.dataPoints[0].asDouble).toBe(60);
    expect(metrics.find((m: { name: string }) => m.name === 'editor.select.click').sum.dataPoints[0].asDouble).toBe(3);
    const logs = bodies.find((b) => b.url.endsWith('/v1/logs'))!.body;
    expect(logs.resourceLogs[0].scopeLogs[0].logRecords[0]).toMatchObject({ severityText: 'ERROR', body: { stringValue: 'boom' } });
    const res = traces.resourceSpans[0].resource.attributes;
    expect(res).toContainEqual({ key: 'service.name', value: { stringValue: 'test' } });
  });

  it('sends nothing when disabled but keeps local diagnostics', async () => {
    const t = make(false);
    t.startSpan('x').end();
    await t.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.recent.at(-1)?.name).toBe('x');
  });

  it('buffers telemetry while offline and flushes later', async () => {
    const t = make();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    t.startSpan('offline span').end();
    await t.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('3d-editor:telemetry-buffer')).toContain('offline span');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    await t.flushBuffered();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('3d-editor:telemetry-buffer')).toBeNull();
  });

  it('propagates trace context to child spans', () => {
    const t = make();
    const parent = t.startSpan('parent');
    const child = t.startSpan('child', {}, parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(parent.traceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
