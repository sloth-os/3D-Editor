import {
  context,
  isSpanContextValid,
  logs,
  metrics,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Span,
} from '@opentelemetry/api';
import type { OtelSettings } from '../config';
import { PACKAGE_VERSION } from '../version';

/*
 * OpenTelemetry tracing helpers. Without an OTLP endpoint no SDK is registered: the API then
 * hands out no-op spans, so instrumented code paths cost (almost) nothing.
 */

const TRACER_NAME = '3d-editor-server';

export function tracer() {
  return trace.getTracer(TRACER_NAME, PACKAGE_VERSION);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function markSpanError(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
}

/** Runs `fn` inside an active span (ended automatically, errors recorded and rethrown). */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes, kind }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      markSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant of {@link withSpan}. */
export function withSpanSync<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T,
  kind: SpanKind = SpanKind.INTERNAL,
): T {
  return tracer().startActiveSpan(name, { attributes, kind }, (span) => {
    try {
      return fn(span);
    } catch (err) {
      markSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** W3C `traceparent` of the active span (undefined when tracing is disabled). */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** pino `mixin`: adds the active trace/span ids to every log line. */
export function traceLogMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const sc = span.spanContext();
  if (!isSpanContextValid(sc)) return {};
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

export interface OtelRuntime {
  enabled: boolean;
  meter: Meter | null;
  shutdown(): Promise<void>;
}

const DISABLED: OtelRuntime = { enabled: false, meter: null, shutdown: async () => {} };

interface ActiveSdk {
  endpoint: string;
  refs: number;
  sdk: { shutdown(): Promise<void> };
}

let active: ActiveSdk | null = null;

/**
 * Starts the OpenTelemetry Node SDK with OTLP/HTTP trace + metric exporters. The SDK is loaded
 * lazily (dynamic import) so a server without OTLP endpoint never pays for it. The global
 * registration is shared (ref-counted) between app instances in the same process.
 */
export async function startOpenTelemetry(
  settings: OtelSettings | null,
  log?: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void },
): Promise<OtelRuntime> {
  if (!settings) return DISABLED;
  if (active) {
    if (active.endpoint !== settings.endpoint) {
      log?.warn(
        { endpoint: settings.endpoint },
        'OpenTelemetry already started with another endpoint in this process',
      );
    }
    active.refs++;
  } else {
    const [
      { NodeSDK },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      { PeriodicExportingMetricReader },
      resources,
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/resources'),
    ]);
    const headers = settings.headers;
    const sdk = new NodeSDK({
      serviceName: settings.serviceName,
      resource: resources
        .defaultResource()
        .merge(resources.resourceFromAttributes({ 'service.version': PACKAGE_VERSION })),
      traceExporter: new OTLPTraceExporter({ url: `${settings.endpoint}/v1/traces`, headers }),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${settings.endpoint}/v1/metrics`, headers }),
          exportIntervalMillis: 15_000,
        }),
      ],
      logRecordProcessors: [],
      instrumentations: [],
    });
    sdk.start();
    active = { endpoint: settings.endpoint, refs: 1, sdk };
    log?.info({ endpoint: settings.endpoint, service: settings.serviceName }, 'OpenTelemetry export enabled');
  }
  let stopped = false;
  return {
    enabled: true,
    meter: metrics.getMeter(TRACER_NAME, PACKAGE_VERSION),
    async shutdown() {
      if (stopped || !active) return;
      stopped = true;
      if (--active.refs > 0) return;
      const { sdk } = active;
      active = null;
      try {
        // Flush pending telemetry, but never let an unreachable collector block or fail shutdown.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          sdk.shutdown(),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, 3000))),
        ]);
        clearTimeout(timer);
      } catch (err) {
        log?.warn({ err: errorMessage(err) }, 'OpenTelemetry shutdown failed');
      } finally {
        // Unregister the globals so a later app instance (tests) can register again.
        trace.disable();
        metrics.disable();
        logs.disable();
        propagation.disable();
        context.disable();
      }
    },
  };
}

export { SpanKind, SpanStatusCode };
