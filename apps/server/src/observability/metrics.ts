import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type Metric,
} from '@prometheus-io/client';
import type {
  Attributes,
  Meter,
  Counter as OtelCounter,
  Histogram as OtelHistogram,
} from '@opentelemetry/api';

/*
 * Prometheus metrics (served on /metrics). Server-side metrics are mirrored into an
 * OpenTelemetry meter when OTLP export is enabled; browser metrics (editor_*) are Prometheus
 * only because the raw browser telemetry is forwarded to the collector verbatim.
 */

type LabelValues<T extends string> = Partial<Record<T, string | number>>;

interface Mirrorable {
  attach(meter: Meter): void;
}

export class CounterMetric<T extends string = string> implements Mirrorable {
  readonly prom: Counter<T>;
  private otel: OtelCounter | null = null;

  constructor(
    registry: Registry,
    readonly name: string,
    readonly help: string,
    labelNames: readonly T[] = [],
  ) {
    this.prom = new Counter<T>({ name, help, labelNames, registers: [registry] });
  }

  inc(labels?: LabelValues<T>, value = 1): void {
    if (labels) this.prom.inc(labels as never, value);
    else this.prom.inc(value);
    this.otel?.add(value, labels as Attributes | undefined);
  }

  attach(meter: Meter): void {
    this.otel = meter.createCounter(this.name, { description: this.help });
  }
}

export class GaugeMetric<T extends string = string> implements Mirrorable {
  readonly prom: Gauge<T>;

  constructor(
    registry: Registry,
    readonly name: string,
    readonly help: string,
    labelNames: readonly T[] = [],
  ) {
    this.prom = new Gauge<T>({ name, help, labelNames, registers: [registry] });
  }

  set(value: number, labels?: LabelValues<T>): void {
    if (labels) this.prom.set(labels as never, value);
    else this.prom.set(value);
  }

  inc(labels?: LabelValues<T>, value = 1): void {
    if (labels) this.prom.inc(labels as never, value);
    else this.prom.inc(value);
  }

  dec(labels?: LabelValues<T>, value = 1): void {
    if (labels) this.prom.dec(labels as never, value);
    else this.prom.dec(value);
  }

  attach(meter: Meter): void {
    const g = meter.createObservableGauge(this.name, { description: this.help });
    g.addCallback(async (result) => {
      const snapshot = await this.prom.get();
      for (const v of snapshot.values) result.observe(v.value, v.labels as Attributes);
    });
  }
}

export class HistogramMetric<T extends string = string> implements Mirrorable {
  readonly prom: Histogram<T>;
  private otel: OtelHistogram | null = null;

  constructor(
    registry: Registry,
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
    labelNames: readonly T[] = [],
    readonly unit = '',
  ) {
    this.prom = new Histogram<T>({ name, help, labelNames, buckets, registers: [registry] });
  }

  observe(value: number, labels?: LabelValues<T>): void {
    if (!Number.isFinite(value)) return;
    if (labels) this.prom.observe(labels as never, value);
    else this.prom.observe(value);
    this.otel?.record(value, labels as Attributes | undefined);
  }

  /** Starts a timer; the returned function records the elapsed seconds. */
  startTimer(labels?: LabelValues<T>): (extra?: LabelValues<T>) => number {
    const t0 = process.hrtime.bigint();
    return (extra) => {
      const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
      this.observe(seconds, { ...labels, ...extra } as LabelValues<T>);
      return seconds;
    };
  }

  attach(meter: Meter): void {
    this.otel = meter.createHistogram(this.name, {
      description: this.help,
      unit: this.unit,
      advice: { explicitBucketBoundaries: this.buckets },
    });
  }
}

interface BucketSeries {
  labels: Record<string, string>;
  /** Per-bucket (non-cumulative) counts; the last entry is the +Inf bucket. */
  counts: number[];
  sum: number;
  count: number;
}

/**
 * Histogram that can ingest pre-aggregated (bucketed) data, e.g. OTLP histogram data points
 * sent by browsers, in addition to single observations. Registered as a custom collector.
 */
export class BucketedHistogram<T extends string = string> {
  readonly type = 'histogram' as const;
  readonly aggregator = 'sum' as const;
  private readonly series = new Map<string, BucketSeries>();

  constructor(
    registry: Registry,
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
    readonly labelNames: readonly T[] = [],
    private readonly maxSeries = 500,
  ) {
    registry.registerMetric(this as unknown as Metric);
  }

  private seriesFor(labels: LabelValues<T> = {}): BucketSeries | null {
    const norm: Record<string, string> = {};
    for (const n of this.labelNames) norm[n] = String(labels[n] ?? '');
    const key = JSON.stringify(norm);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= this.maxSeries) return null;
      s = { labels: norm, counts: new Array(this.bounds.length + 1).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  private bucketIndex(value: number): number {
    let i = 0;
    while (i < this.bounds.length && value > this.bounds[i]) i++;
    return i;
  }

  observe(value: number, labels?: LabelValues<T>, times = 1): void {
    if (!Number.isFinite(value) || !(times > 0)) return;
    const s = this.seriesFor(labels);
    if (!s) return;
    s.counts[this.bucketIndex(value)] += times;
    s.sum += value * times;
    s.count += times;
  }

  /**
   * Merges a bucketed distribution. `srcBounds` are the upper bounds of `srcCounts`
   * (srcCounts has one extra overflow entry). `scale` converts source units (e.g. ms → s).
   * Each source bucket is attributed to the first target bucket whose bound covers the source
   * bucket's upper bound, which is exact when the bounds line up.
   */
  merge(
    srcBounds: number[],
    srcCounts: number[],
    sum: number,
    count: number,
    labels?: LabelValues<T>,
    scale = 1,
  ): void {
    if (srcCounts.length !== srcBounds.length + 1) return;
    if (srcCounts.some((c) => !Number.isFinite(c) || c < 0)) return;
    const total = srcCounts.reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const s = this.seriesFor(labels);
    if (!s) return;
    for (let i = 0; i < srcCounts.length; i++) {
      const c = srcCounts[i];
      if (!c) continue;
      const upper = i < srcBounds.length ? srcBounds[i] * scale : Infinity;
      const j = upper === Infinity ? this.bounds.length : this.bucketIndex(upper - Math.abs(upper) * 1e-9);
      s.counts[j] += c;
    }
    s.count += Number.isFinite(count) && count >= total ? count : total;
    if (Number.isFinite(sum)) s.sum += sum * scale;
  }

  reset(): void {
    this.series.clear();
  }

  async get() {
    const values: { labels: Record<string, string | number>; value: number; metricName: string }[] = [];
    for (const s of this.series.values()) {
      let cum = 0;
      for (let i = 0; i < this.bounds.length; i++) {
        cum += s.counts[i];
        values.push({
          labels: { ...s.labels, le: this.bounds[i] },
          value: cum,
          metricName: `${this.name}_bucket`,
        });
      }
      values.push({ labels: { ...s.labels, le: '+Inf' }, value: s.count, metricName: `${this.name}_bucket` });
      values.push({ labels: s.labels, value: s.sum, metricName: `${this.name}_sum` });
      values.push({ labels: s.labels, value: s.count, metricName: `${this.name}_count` });
    }
    return { name: this.name, help: this.help, type: this.type, aggregator: this.aggregator, values };
  }
}

const SECONDS_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** Long jobs (video exports): 1 s to 2 h. */
const LONG_SECONDS_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
const BYTES_BUCKETS = [64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216];
/** Browser telemetry histogram bounds (milliseconds) used by the web client; converted to seconds. */
const BROWSER_MS_BOUNDS = [1, 2, 5, 10, 16, 33, 50, 100, 250, 500, 1000, 2500, 5000];
const msToSeconds = (b: number[]) => b.map((x) => x / 1000);

/** Metrics fed by browser telemetry (/otlp ingestion). */
export class ClientMetrics {
  readonly operatorExecutions: CounterMetric<'operator' | 'source' | 'status'>;
  readonly operatorDuration: BucketedHistogram<'operator'>;
  readonly spans: CounterMetric<'name'>;
  readonly logs: CounterMetric<'severity'>;
  readonly fps: BucketedHistogram;
  readonly frameTime: BucketedHistogram;
  readonly sceneTriangles: BucketedHistogram;
  readonly syncLatency: BucketedHistogram;
  readonly storageSave: BucketedHistogram;
  readonly webVitals: Record<'lcp' | 'fcp' | 'ttfb' | 'inp' | 'cls', BucketedHistogram<'rating'>>;
  readonly payloads: CounterMetric<'signal' | 'status'>;
  readonly forwardFailures: CounterMetric<'signal'>;

  constructor(registry: Registry) {
    this.operatorExecutions = new CounterMetric(
      registry,
      'editor_operator_executions_total',
      'Operator executions reported by browser editors',
      ['operator', 'source', 'status'],
    );
    this.operatorDuration = new BucketedHistogram(
      registry,
      'editor_operator_duration_seconds',
      'Operator execution time reported by browser editors',
      SECONDS_BUCKETS,
      ['operator'],
    );
    this.spans = new CounterMetric(
      registry,
      'editor_client_spans_total',
      'Other spans reported by browser editors',
      ['name'],
    );
    this.logs = new CounterMetric(
      registry,
      'editor_client_logs_total',
      'Log records reported by browser editors',
      ['severity'],
    );
    this.fps = new BucketedHistogram(
      registry,
      'editor_fps',
      'Viewport frames per second reported by browser editors',
      [5, 10, 15, 20, 24, 30, 45, 60, 90, 120, 144],
    );
    this.frameTime = new BucketedHistogram(
      registry,
      'editor_frame_time_seconds',
      'Viewport frame time reported by browser editors',
      msToSeconds(BROWSER_MS_BOUNDS),
    );
    this.sceneTriangles = new BucketedHistogram(
      registry,
      'editor_scene_triangles',
      'Triangles in the scene shown by browser editors',
      [100, 1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6, 1e7],
    );
    this.syncLatency = new BucketedHistogram(
      registry,
      'editor_sync_latency_seconds',
      'Sync round-trip latency measured by browser editors',
      msToSeconds(BROWSER_MS_BOUNDS),
    );
    this.storageSave = new BucketedHistogram(
      registry,
      'editor_storage_save_seconds',
      'Project save duration measured by browser editors',
      msToSeconds(BROWSER_MS_BOUNDS),
    );
    const vitalSeconds = [0.1, 0.2, 0.5, 0.8, 1, 1.8, 2.5, 4, 6, 10];
    this.webVitals = {
      lcp: new BucketedHistogram(
        registry,
        'editor_web_vitals_lcp_seconds',
        'Largest Contentful Paint',
        vitalSeconds,
        ['rating'],
      ),
      fcp: new BucketedHistogram(
        registry,
        'editor_web_vitals_fcp_seconds',
        'First Contentful Paint',
        vitalSeconds,
        ['rating'],
      ),
      ttfb: new BucketedHistogram(
        registry,
        'editor_web_vitals_ttfb_seconds',
        'Time To First Byte',
        vitalSeconds,
        ['rating'],
      ),
      inp: new BucketedHistogram(
        registry,
        'editor_web_vitals_inp_seconds',
        'Interaction to Next Paint',
        vitalSeconds,
        ['rating'],
      ),
      cls: new BucketedHistogram(
        registry,
        'editor_web_vitals_cls',
        'Cumulative Layout Shift',
        [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
        ['rating'],
      ),
    };
    this.payloads = new CounterMetric(
      registry,
      'telemetry_payloads_total',
      'Browser telemetry payloads received',
      ['signal', 'status'],
    );
    this.forwardFailures = new CounterMetric(
      registry,
      'telemetry_forward_failures_total',
      'Browser telemetry payloads that could not be forwarded to the OTLP collector',
      ['signal'],
    );
  }
}

export class ServerMetrics {
  readonly registry: Registry;
  readonly syncConnections: GaugeMetric;
  readonly syncRooms: GaugeMetric;
  readonly syncMessages: CounterMetric<'type' | 'direction'>;
  readonly syncUpdateBytes: HistogramMetric;
  readonly syncRpc: CounterMetric<'method' | 'status'>;
  readonly persistenceOps: CounterMetric<'op' | 'status'>;
  readonly persistenceDuration: HistogramMetric<'op'>;
  readonly httpRequests: CounterMetric<'method' | 'route' | 'status'>;
  readonly httpDuration: HistogramMetric<'method' | 'route'>;
  readonly mcpToolCalls: CounterMetric<'tool' | 'status'>;
  readonly mcpToolDuration: HistogramMetric<'tool'>;
  readonly mcpSessions: GaugeMetric;
  /** Video exports that ended, by status (done, failed, cancelled). */
  readonly videoExports: CounterMetric<'status'>;
  readonly videoExportFrames: CounterMetric;
  readonly videoExportDuration: HistogramMetric;
  /** Video exports queued or running. */
  readonly videoExportsActive: GaugeMetric;
  readonly storeSearches: CounterMetric<'provider' | 'status'>;
  readonly storeDownloads: CounterMetric<'provider' | 'status'>;
  readonly storeDownloadBytes: CounterMetric;
  readonly rideoRequests: CounterMetric<'op' | 'status'>;
  readonly client: ClientMetrics;
  private readonly mirrored: Mirrorable[];

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    const r = (this.registry = new Registry());
    if (opts.defaultMetrics !== false) collectDefaultMetrics({ register: r });
    this.syncConnections = new GaugeMetric(
      r,
      'sync_connections',
      'Open real-time sync WebSocket connections',
    );
    this.syncRooms = new GaugeMetric(r, 'sync_rooms', 'Projects (rooms) loaded in memory');
    this.syncMessages = new CounterMetric(r, 'sync_messages_total', 'Sync protocol messages', [
      'type',
      'direction',
    ]);
    this.syncUpdateBytes = new HistogramMetric<string>(
      r,
      'sync_update_bytes',
      'Size of Yjs document updates',
      BYTES_BUCKETS,
      [],
      'By',
    );
    this.syncRpc = new CounterMetric(r, 'sync_rpc_requests_total', 'RPC requests sent to connected editors', [
      'method',
      'status',
    ]);
    this.persistenceOps = new CounterMetric(r, 'persistence_operations_total', 'Persistence operations', [
      'op',
      'status',
    ]);
    this.persistenceDuration = new HistogramMetric(
      r,
      'persistence_duration_seconds',
      'Persistence operation duration',
      SECONDS_BUCKETS,
      ['op'],
      's',
    );
    this.httpRequests = new CounterMetric(r, 'http_requests_total', 'HTTP requests', [
      'method',
      'route',
      'status',
    ]);
    this.httpDuration = new HistogramMetric(
      r,
      'http_request_duration_seconds',
      'HTTP request duration',
      SECONDS_BUCKETS,
      ['method', 'route'],
      's',
    );
    this.mcpToolCalls = new CounterMetric(r, 'mcp_tool_calls_total', 'MCP tool calls', ['tool', 'status']);
    this.mcpToolDuration = new HistogramMetric(
      r,
      'mcp_tool_duration_seconds',
      'MCP tool call duration',
      SECONDS_BUCKETS,
      ['tool'],
      's',
    );
    this.mcpSessions = new GaugeMetric(r, 'mcp_sessions', 'Open MCP sessions');
    this.videoExports = new CounterMetric(r, 'video_exports_total', 'Video exports that ended, by status', [
      'status',
    ]);
    this.videoExportFrames = new CounterMetric(
      r,
      'video_export_frames_total',
      'Frames rendered by video exports',
    );
    this.videoExportDuration = new HistogramMetric<string>(
      r,
      'video_export_seconds',
      'Video export duration from start to end',
      LONG_SECONDS_BUCKETS,
      [],
      's',
    );
    this.videoExportsActive = new GaugeMetric(r, 'video_exports_active', 'Video exports queued or running');
    this.storeSearches = new CounterMetric(r, 'store_searches_total', 'Model store provider searches', [
      'provider',
      'status',
    ]);
    this.storeDownloads = new CounterMetric(r, 'store_downloads_total', 'Model store downloads', [
      'provider',
      'status',
    ]);
    this.storeDownloadBytes = new CounterMetric(
      r,
      'store_download_bytes_total',
      'Bytes the model store downloaded',
    );
    this.rideoRequests = new CounterMetric(r, 'rideo_requests_total', 'Requests to the rideo server', [
      'op',
      'status',
    ]);
    this.client = new ClientMetrics(r);
    this.mirrored = [
      this.syncConnections,
      this.syncRooms,
      this.syncMessages,
      this.syncUpdateBytes,
      this.syncRpc,
      this.persistenceOps,
      this.persistenceDuration,
      this.httpRequests,
      this.httpDuration,
      this.mcpToolCalls,
      this.mcpToolDuration,
      this.mcpSessions,
      this.videoExports,
      this.videoExportFrames,
      this.videoExportDuration,
      this.videoExportsActive,
      this.storeSearches,
      this.storeDownloads,
      this.storeDownloadBytes,
      this.rideoRequests,
    ];
  }

  /** Mirrors server metrics into an OpenTelemetry meter (OTLP export). */
  attachMeter(meter: Meter): void {
    for (const m of this.mirrored) m.attach(meter);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
