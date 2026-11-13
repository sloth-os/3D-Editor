import type { ClientMetrics, BucketedHistogram } from './metrics';

/*
 * Ingestion of browser telemetry sent as OTLP/HTTP JSON (`/otlp/v1/{traces,metrics,logs}`).
 * Payloads are aggregated into bounded-cardinality Prometheus metrics; parsing is defensive:
 * malformed parts are skipped, never fatal.
 */

export type OtlpSignal = 'traces' | 'metrics' | 'logs';
export const OTLP_SIGNALS: readonly OtlpSignal[] = ['traces', 'metrics', 'logs'];

export interface LogSink {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface IngestResult {
  /** Items (spans, data points, log records) that were aggregated. */
  accepted: number;
  /** Items skipped because they were malformed. */
  rejected: number;
}

type Primitive = string | number | boolean;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Converts an OTLP AnyValue to a primitive (complex values are JSON-encoded, truncated). */
export function anyValue(v: unknown): Primitive | undefined {
  if (!isObject(v)) return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (v.intValue !== undefined) return num(v.intValue);
  if (v.doubleValue !== undefined) return num(v.doubleValue);
  if (v.arrayValue !== undefined || v.kvlistValue !== undefined) {
    try {
      return JSON.stringify(v.arrayValue ?? v.kvlistValue).slice(0, 300);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** OTLP KeyValue list → plain record (bounded). */
export function attributesOf(list: unknown, max = 64): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  let n = 0;
  for (const kv of arr(list)) {
    if (n >= max) break;
    if (!isObject(kv) || typeof kv.key !== 'string') continue;
    const value = anyValue(kv.value);
    if (value === undefined) continue;
    out[kv.key.slice(0, 128)] = typeof value === 'string' ? value.slice(0, 500) : value;
    n++;
  }
  return out;
}

function nanos(v: unknown): bigint | undefined {
  try {
    if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.floor(v));
  } catch {
    /* ignore */
  }
  return undefined;
}

const OPERATOR_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const OPERATOR_SOURCES = new Set([
  'ui',
  'menu',
  'hotkey',
  'toolbar',
  'palette',
  'redo',
  'console',
  'mcp',
  'api',
  'test',
]);
const VITAL_RATINGS = new Set(['good', 'needs-improvement', 'poor']);

/** Bounded set of label values: once `max` distinct values were seen, others become 'other'. */
class LabelLimiter {
  private readonly seen = new Set<string>();
  constructor(private readonly max: number) {}
  value(v: string): string {
    if (this.seen.has(v)) return v;
    if (this.seen.size >= this.max) return 'other';
    this.seen.add(v);
    return v;
  }
}

/** Normalizes a free-form span name into a low-cardinality label. */
export function sanitizeSpanName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
    .replace(/\b[0-9a-z]*\d[0-9a-z]{7,}\b/g, ':id')
    .replace(/[^a-z0-9_.:/ -]+/g, '_')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .slice(0, 64)
    .trim();
  return s || 'unnamed';
}

export function severityOf(record: Record<string, unknown>): string {
  const n = num(record.severityNumber);
  if (n !== undefined && n >= 1 && n <= 24) {
    return ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'][Math.floor((n - 1) / 4)];
  }
  const text = typeof record.severityText === 'string' ? record.severityText.trim().toUpperCase() : '';
  if (text === 'WARNING') return 'WARN';
  if (['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(text)) return text;
  return 'UNSPECIFIED';
}

function statusIsError(status: unknown): boolean {
  if (!isObject(status)) return false;
  return status.code === 2 || status.code === '2' || status.code === 'STATUS_CODE_ERROR';
}

interface MetricTarget {
  histogram: BucketedHistogram<string>;
  /** Multiplier converting the reported unit into the histogram's unit. */
  scale: number;
  labels?: (attrs: Record<string, Primitive>) => Record<string, string>;
}

export class TelemetryIngestor {
  private readonly operatorIds: LabelLimiter;
  private readonly spanNames: LabelLimiter;
  private readonly targets: Map<string, MetricTarget>;
  private errorLogBudget = { windowStart: 0, count: 0 };
  private readonly maxErrorLogsPerMinute: number;

  constructor(
    private readonly metrics: ClientMetrics,
    private readonly log: LogSink,
    limits: { maxOperators?: number; maxSpanNames?: number; maxErrorLogsPerMinute?: number } = {},
  ) {
    this.operatorIds = new LabelLimiter(limits.maxOperators ?? 500);
    this.spanNames = new LabelLimiter(limits.maxSpanNames ?? 200);
    this.maxErrorLogsPerMinute = limits.maxErrorLogsPerMinute ?? 120;
    const rating = (a: Record<string, Primitive>) => ({
      rating: VITAL_RATINGS.has(String(a.rating)) ? String(a.rating) : 'unknown',
    });
    const ms = 1 / 1000;
    this.targets = new Map<string, MetricTarget>([
      ['editor.fps', { histogram: metrics.fps, scale: 1 }],
      ['editor.frame_time_ms', { histogram: metrics.frameTime, scale: ms }],
      ['editor.scene.triangles', { histogram: metrics.sceneTriangles, scale: 1 }],
      ['editor.sync.latency_ms', { histogram: metrics.syncLatency, scale: ms }],
      ['editor.storage.save_ms', { histogram: metrics.storageSave, scale: ms }],
      ['web_vitals.lcp', { histogram: metrics.webVitals.lcp, scale: ms, labels: rating }],
      ['web_vitals.fcp', { histogram: metrics.webVitals.fcp, scale: ms, labels: rating }],
      ['web_vitals.ttfb', { histogram: metrics.webVitals.ttfb, scale: ms, labels: rating }],
      ['web_vitals.inp', { histogram: metrics.webVitals.inp, scale: ms, labels: rating }],
      ['web_vitals.cls', { histogram: metrics.webVitals.cls, scale: 1, labels: rating }],
    ]);
  }

  ingest(signal: OtlpSignal, body: unknown): IngestResult {
    const result: IngestResult = { accepted: 0, rejected: 0 };
    if (!isObject(body)) return result;
    if (signal === 'traces') this.ingestTraces(body, result);
    else if (signal === 'metrics') this.ingestMetrics(body, result);
    else this.ingestLogs(body, result);
    return result;
  }

  // ------------------------------------------------------------------ traces

  private ingestTraces(body: Record<string, unknown>, result: IngestResult): void {
    for (const rs of arr(body.resourceSpans)) {
      if (!isObject(rs)) continue;
      for (const ss of [...arr(rs.scopeSpans), ...arr(rs.instrumentationLibrarySpans)]) {
        if (!isObject(ss)) continue;
        for (const span of arr(ss.spans)) {
          try {
            if (this.ingestSpan(span)) result.accepted++;
            else result.rejected++;
          } catch {
            result.rejected++;
          }
        }
      }
    }
  }

  private ingestSpan(span: unknown): boolean {
    if (!isObject(span) || typeof span.name !== 'string') return false;
    const attrs = attributesOf(span.attributes);
    const error = statusIsError(span.status);
    const isOperator = span.name.startsWith('operator ') || typeof attrs['operator.id'] === 'string';
    if (!isOperator) {
      this.metrics.spans.inc({ name: this.spanNames.value(sanitizeSpanName(span.name)) });
      return true;
    }
    const rawId =
      typeof attrs['operator.id'] === 'string' ? attrs['operator.id'] : span.name.slice('operator '.length);
    const id = String(rawId).trim();
    const operator = OPERATOR_ID_RE.test(id) && id.length <= 100 ? this.operatorIds.value(id) : 'other';
    const src = String(attrs['operator.source'] ?? '');
    const source = OPERATOR_SOURCES.has(src) ? src : src ? 'other' : 'unknown';
    this.metrics.operatorExecutions.inc({ operator, source, status: error ? 'error' : 'ok' });
    const seconds = spanSeconds(span, attrs);
    if (seconds !== undefined) this.metrics.operatorDuration.observe(seconds, { operator });
    return true;
  }

  // ------------------------------------------------------------------ metrics

  private ingestMetrics(body: Record<string, unknown>, result: IngestResult): void {
    for (const rm of arr(body.resourceMetrics)) {
      if (!isObject(rm)) continue;
      for (const sm of [...arr(rm.scopeMetrics), ...arr(rm.instrumentationLibraryMetrics)]) {
        if (!isObject(sm)) continue;
        for (const metric of arr(sm.metrics)) {
          if (!isObject(metric) || typeof metric.name !== 'string') {
            result.rejected++;
            continue;
          }
          const target = this.targets.get(metric.name);
          if (!target) continue; // not aggregated (still forwarded to the collector)
          for (const kind of ['gauge', 'sum', 'histogram'] as const) {
            const data = metric[kind];
            if (!isObject(data)) continue;
            for (const dp of arr(data.dataPoints)) {
              try {
                if (this.ingestDataPoint(kind, dp, target)) result.accepted++;
                else result.rejected++;
              } catch {
                result.rejected++;
              }
            }
          }
        }
      }
    }
  }

  private ingestDataPoint(kind: 'gauge' | 'sum' | 'histogram', dp: unknown, target: MetricTarget): boolean {
    if (!isObject(dp)) return false;
    const labels = target.labels ? target.labels(attributesOf(dp.attributes)) : undefined;
    if (kind === 'histogram') {
      const bounds = arr(dp.explicitBounds).map(num);
      const counts = arr(dp.bucketCounts).map(num);
      if (bounds.some((b) => b === undefined) || counts.some((c) => c === undefined)) return false;
      if (counts.length !== bounds.length + 1) return false;
      const total = (counts as number[]).reduce((a, b) => a + b, 0);
      target.histogram.merge(
        bounds as number[],
        counts as number[],
        num(dp.sum) ?? NaN,
        num(dp.count) ?? total,
        labels,
        target.scale,
      );
      return true;
    }
    const value = num(dp.asDouble) ?? num(dp.asInt);
    if (value === undefined || value < 0) return false;
    target.histogram.observe(value * target.scale, labels);
    return true;
  }

  // ------------------------------------------------------------------ logs

  private ingestLogs(body: Record<string, unknown>, result: IngestResult): void {
    for (const rl of arr(body.resourceLogs)) {
      if (!isObject(rl)) continue;
      const resource = isObject(rl.resource) ? attributesOf(rl.resource.attributes, 32) : {};
      for (const sl of [...arr(rl.scopeLogs), ...arr(rl.instrumentationLibraryLogs)]) {
        if (!isObject(sl)) continue;
        for (const rec of arr(sl.logRecords)) {
          if (!isObject(rec)) {
            result.rejected++;
            continue;
          }
          try {
            const severity = severityOf(rec);
            this.metrics.logs.inc({ severity });
            if (severity === 'ERROR' || severity === 'FATAL') this.relogError(rec, severity, resource);
            result.accepted++;
          } catch {
            result.rejected++;
          }
        }
      }
    }
  }

  private relogError(
    rec: Record<string, unknown>,
    severity: string,
    resource: Record<string, Primitive>,
  ): void {
    const now = Date.now();
    if (now - this.errorLogBudget.windowStart > 60_000) this.errorLogBudget = { windowStart: now, count: 0 };
    if (++this.errorLogBudget.count > this.maxErrorLogsPerMinute) return;
    const message = String(anyValue(rec.body) ?? '').slice(0, 2000);
    this.log.error(
      {
        source: 'browser',
        client: {
          severity,
          attributes: attributesOf(rec.attributes, 32),
          resource,
          trace_id: typeof rec.traceId === 'string' ? rec.traceId : undefined,
          span_id: typeof rec.spanId === 'string' ? rec.spanId : undefined,
        },
      },
      `client error: ${message}`,
    );
  }
}

function spanSeconds(span: Record<string, unknown>, attrs: Record<string, Primitive>): number | undefined {
  const start = nanos(span.startTimeUnixNano);
  const end = nanos(span.endTimeUnixNano);
  if (start !== undefined && end !== undefined && end >= start && start > 0n) {
    const s = Number(end - start) / 1e9;
    if (s < 86_400) return s;
  }
  const ms = num(attrs['duration.ms']);
  return ms !== undefined && ms >= 0 && ms < 86_400_000 ? ms / 1000 : undefined;
}

/** Forwards raw OTLP/HTTP payloads to the configured collector (fire and forget). */
export class OtlpForwarder {
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string>,
    private readonly onFailure: (signal: OtlpSignal, reason: string) => void,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  forward(
    signal: OtlpSignal,
    body: Uint8Array,
    contentType = 'application/json',
    contentEncoding?: string | string[],
  ): void {
    const headers: Record<string, string> = { ...this.headers, 'content-type': contentType };
    if (typeof contentEncoding === 'string' && contentEncoding) headers['content-encoding'] = contentEncoding;
    const p = (async () => {
      try {
        const res = await this.fetchImpl(`${this.endpoint}/v1/${signal}`, {
          method: 'POST',
          headers,
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // drain the body so the connection can be reused
        await res.arrayBuffer().catch(() => undefined);
        if (!res.ok) this.onFailure(signal, `HTTP ${res.status}`);
      } catch (err) {
        this.onFailure(signal, err instanceof Error ? err.message : String(err));
      }
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Waits for in-flight forwards (shutdown, tests). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}
