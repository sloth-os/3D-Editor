/*
 * Lightweight browser telemetry emitting OTLP/HTTP JSON (traces, metrics, logs) to the editor
 * server (`/otlp/v1/*`), which aggregates it into Prometheus metrics and forwards it to an
 * OpenTelemetry collector when configured.
 *
 * - No geometry, names or file contents are ever sent: only operator ids, counts, timings,
 *   error messages and environment info.
 * - Batches are buffered while offline (persisted in localStorage, bounded) and flushed later.
 * - Users can opt out in Preferences; the server can disable ingestion.
 */

type AttrValue = string | number | boolean;
export type Attributes = Record<string, AttrValue | undefined>;

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attributes;
  status: { code: 0 | 1 | 2; message?: string };
  events: { timeUnixNano: string; name: string; attributes: Attributes }[];
}

interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Attributes;
  traceId?: string;
  spanId?: string;
}

interface Histogram {
  bounds: number[];
  counts: number[];
  sum: number;
  count: number;
  min: number;
  max: number;
  attrs: Attributes;
  unit: string;
}

const BUFFER_KEY = '3d-editor:telemetry-buffer';
const MAX_BUFFER_BYTES = 250_000;

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nowNanos(): string {
  // performance.timeOrigin + now gives sub-ms precision; BigInt keeps nanoseconds exact.
  const ms = performance.timeOrigin + performance.now();
  return (BigInt(Math.floor(ms * 1000)) * 1000n).toString();
}

function toOtlpAttrs(a: Attributes): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, v] of Object.entries(a)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out.push({ key, value: { stringValue: v.slice(0, 500) } });
    else if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } });
    else if (Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } });
    else out.push({ key, value: { doubleValue: v } });
  }
  return out;
}

export interface TelemetryConfig {
  endpoint: string;
  headers: () => Record<string, string>;
  enabled: () => boolean;
  resource: Attributes;
}

export class ActiveSpan {
  readonly spanId = hex(8);
  private ended = false;
  private readonly startNanos = nowNanos();
  private readonly t0 = performance.now();
  readonly attributes: Attributes;
  private status: SpanRecord['status'] = { code: 0 };
  private readonly events: SpanRecord['events'] = [];

  constructor(
    private readonly tel: Telemetry,
    readonly name: string,
    attrs: Attributes,
    readonly traceId: string,
    readonly parentSpanId?: string,
  ) {
    this.attributes = { ...attrs };
  }

  setAttribute(k: string, v: AttrValue | undefined): this {
    this.attributes[k] = v;
    return this;
  }
  addEvent(name: string, attributes: Attributes = {}): this {
    this.events.push({ timeUnixNano: nowNanos(), name, attributes });
    return this;
  }
  setError(message: string): this {
    this.status = { code: 2, message: message.slice(0, 300) };
    return this;
  }
  setOk(): this {
    this.status = { code: 1 };
    return this;
  }
  /** W3C traceparent header value for propagating this span. */
  traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-01`;
  }
  end(): number {
    if (this.ended) return 0;
    this.ended = true;
    const durationMs = performance.now() - this.t0;
    this.tel.recordSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: 1,
      startTimeUnixNano: this.startNanos,
      endTimeUnixNano: nowNanos(),
      attributes: { ...this.attributes, 'duration.ms': Math.round(durationMs * 1000) / 1000 },
      status: this.status,
      events: this.events,
    });
    return durationMs;
  }
}

export class Telemetry {
  private spans: SpanRecord[] = [];
  private logs: LogRecord[] = [];
  private gauges = new Map<string, { value: number; attrs: Attributes; unit: string }>();
  private counters = new Map<string, { value: number; attrs: Attributes; unit: string }>();
  private histograms = new Map<string, Histogram>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: TelemetryConfig | null = null;
  readonly sessionId = hex(8);
  /** Recent spans kept locally for the in-app diagnostics panel. */
  readonly recent: { name: string; durationMs: number; ok: boolean; at: number }[] = [];
  private flushing = false;

  configure(config: TelemetryConfig): void {
    this.config = config;
    if (!this.timer && typeof window !== 'undefined') {
      this.timer = setInterval(() => void this.flush(), 15_000);
      window.addEventListener('online', () => void this.flushBuffered());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush(true);
      });
      window.addEventListener('pagehide', () => this.flush(true));
    }
    void this.flushBuffered();
  }

  get enabled(): boolean {
    return !!this.config && this.config.enabled();
  }

  startSpan(name: string, attrs: Attributes = {}, parent?: ActiveSpan): ActiveSpan {
    return new ActiveSpan(this, name, attrs, parent?.traceId ?? hex(16), parent?.spanId);
  }

  /** Runs `fn` inside a span; records errors and returns fn's result. */
  async trace<T>(name: string, attrs: Attributes, fn: (span: ActiveSpan) => Promise<T> | T): Promise<T> {
    const span = this.startSpan(name, attrs);
    try {
      const r = await fn(span);
      span.setOk();
      return r;
    } catch (err) {
      span.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  recordSpan(s: SpanRecord): void {
    const durationMs = Number(s.attributes['duration.ms'] ?? 0);
    this.recent.push({ name: s.name, durationMs, ok: s.status.code !== 2, at: Date.now() });
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    if (!this.enabled) return;
    this.spans.push(s);
    if (this.spans.length >= 100) void this.flush();
  }

  gauge(name: string, value: number, attrs: Attributes = {}, unit = ''): void {
    if (!Number.isFinite(value)) return;
    this.gauges.set(`${name}|${JSON.stringify(attrs)}`, { value, attrs: { ...attrs, __name: name }, unit });
  }

  count(name: string, inc = 1, attrs: Attributes = {}, unit = '1'): void {
    const k = `${name}|${JSON.stringify(attrs)}`;
    const c = this.counters.get(k) ?? { value: 0, attrs: { ...attrs, __name: name }, unit };
    c.value += inc;
    this.counters.set(k, c);
  }

  histogram(name: string, value: number, attrs: Attributes = {}, unit = 'ms', bounds = [1, 2, 5, 10, 16, 33, 50, 100, 250, 500, 1000, 2500, 5000]): void {
    if (!Number.isFinite(value)) return;
    const k = `${name}|${JSON.stringify(attrs)}`;
    let h = this.histograms.get(k);
    if (!h) {
      h = { bounds, counts: new Array(bounds.length + 1).fill(0), sum: 0, count: 0, min: value, max: value, attrs: { ...attrs, __name: name }, unit };
      this.histograms.set(k, h);
    }
    let i = 0;
    while (i < bounds.length && value > bounds[i]) i++;
    h.counts[i]++;
    h.sum += value;
    h.count++;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
  }

  log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, attrs: Attributes = {}, span?: ActiveSpan): void {
    if (!this.enabled) return;
    const sev = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }[level];
    this.logs.push({
      timeUnixNano: nowNanos(),
      severityNumber: sev,
      severityText: level,
      body: message.slice(0, 2000),
      attributes: attrs,
      traceId: span?.traceId,
      spanId: span?.spanId,
    });
    if (this.logs.length >= 50) void this.flush();
  }

  private resource() {
    return { attributes: toOtlpAttrs({ ...(this.config?.resource ?? {}), 'session.id': this.sessionId }) };
  }
  private scope() {
    return { name: '3d-editor-web', version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev' };
  }

  private buildPayloads(): { path: string; body: unknown }[] {
    const out: { path: string; body: unknown }[] = [];
    if (this.spans.length) {
      const spans = this.spans.splice(0);
      out.push({
        path: '/v1/traces',
        body: {
          resourceSpans: [
            {
              resource: this.resource(),
              scopeSpans: [
                {
                  scope: this.scope(),
                  spans: spans.map((s) => ({
                    ...s,
                    attributes: toOtlpAttrs(s.attributes),
                    events: s.events.map((e) => ({ ...e, attributes: toOtlpAttrs(e.attributes) })),
                  })),
                },
              ],
            },
          ],
        },
      });
    }
    const now = nowNanos();
    const metrics: unknown[] = [];
    const strip = (a: Attributes) => {
      const { __name: _n, ...rest } = a;
      return toOtlpAttrs(rest);
    };
    const byName = <T extends { attrs: Attributes }>(m: Map<string, T>) => {
      const groups = new Map<string, T[]>();
      for (const v of m.values()) {
        const n = String(v.attrs.__name);
        const g = groups.get(n);
        if (g) g.push(v);
        else groups.set(n, [v]);
      }
      return groups;
    };
    for (const [name, pts] of byName(this.gauges))
      metrics.push({
        name,
        unit: (pts[0] as { unit: string }).unit,
        gauge: { dataPoints: pts.map((p) => ({ timeUnixNano: now, asDouble: (p as { value: number }).value, attributes: strip(p.attrs) })) },
      });
    for (const [name, pts] of byName(this.counters))
      metrics.push({
        name,
        unit: (pts[0] as { unit: string }).unit,
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: pts.map((p) => ({ timeUnixNano: now, asDouble: (p as { value: number }).value, attributes: strip(p.attrs) })),
        },
      });
    for (const [name, pts] of byName(this.histograms))
      metrics.push({
        name,
        unit: pts[0].unit,
        histogram: {
          aggregationTemporality: 1,
          dataPoints: pts.map((h) => ({
            timeUnixNano: now,
            count: String(h.count),
            sum: h.sum,
            min: h.min,
            max: h.max,
            bucketCounts: h.counts.map(String),
            explicitBounds: h.bounds,
            attributes: strip(h.attrs),
          })),
        },
      });
    this.gauges.clear();
    this.counters.clear();
    this.histograms.clear();
    if (metrics.length)
      out.push({ path: '/v1/metrics', body: { resourceMetrics: [{ resource: this.resource(), scopeMetrics: [{ scope: this.scope(), metrics }] }] } });
    if (this.logs.length) {
      const logs = this.logs.splice(0);
      out.push({
        path: '/v1/logs',
        body: {
          resourceLogs: [
            {
              resource: this.resource(),
              scopeLogs: [{ scope: this.scope(), logRecords: logs.map((l) => ({ ...l, body: { stringValue: l.body }, attributes: toOtlpAttrs(l.attributes) })) }],
            },
          ],
        },
      });
    }
    return out;
  }

  /** Sends pending telemetry. With `beacon`, uses sendBeacon (page unload). */
  async flush(beacon = false): Promise<void> {
    if (!this.config || !this.enabled) {
      this.spans = [];
      this.logs = [];
      return;
    }
    const payloads = this.buildPayloads();
    if (!payloads.length) return;
    if (!navigator.onLine) {
      this.buffer(payloads);
      return;
    }
    for (const p of payloads) {
      const url = `${this.config.endpoint}${p.path}`;
      const body = JSON.stringify(p.body);
      if (beacon && navigator.sendBeacon) {
        if (!navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) this.buffer([p]);
        continue;
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.config.headers() },
          body,
          keepalive: body.length < 60_000,
        });
        if (!res.ok && res.status >= 500) this.buffer([p]);
      } catch {
        this.buffer([p]);
      }
    }
  }

  private buffer(payloads: { path: string; body: unknown }[]): void {
    try {
      const existing = JSON.parse(localStorage.getItem(BUFFER_KEY) ?? '[]') as { path: string; body: unknown }[];
      let all = [...existing, ...payloads];
      while (all.length && JSON.stringify(all).length > MAX_BUFFER_BYTES) all = all.slice(1);
      localStorage.setItem(BUFFER_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  async flushBuffered(): Promise<void> {
    if (!this.config || !this.enabled || !navigator.onLine || this.flushing) return;
    this.flushing = true;
    try {
      const raw = localStorage.getItem(BUFFER_KEY);
      if (!raw) return;
      localStorage.removeItem(BUFFER_KEY);
      const items = JSON.parse(raw) as { path: string; body: unknown }[];
      for (const p of items) {
        try {
          await fetch(`${this.config.endpoint}${p.path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.config.headers() },
            body: JSON.stringify(p.body),
          });
        } catch {
          this.buffer([p]);
        }
      }
    } catch {
      /* ignore corrupt buffer */
    } finally {
      this.flushing = false;
    }
  }
}

export const telemetry = new Telemetry();
