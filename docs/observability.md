# Observability

The goal is to understand *how people create and edit 3D projects* so the editor can be
improved: which tools are used, which are slow or fail, where users undo a lot, how the viewport
performs on real devices, and how sync and storage behave.

## Browser telemetry

`apps/web/src/telemetry` emits OpenTelemetry-compatible OTLP/JSON to the server
(`/otlp/v1/traces|metrics|logs`). Batches are buffered in `localStorage` while offline.

| Signal | Content |
| --- | --- |
| Spans | `operator <id>` for every operator (source: menu/hotkey/palette/redo/console/mcp, mode, status, duration, object count), `project.open`, `storage.webdav.sync`, `sync.connect`, `render.image`, `import <fmt>`, `export <fmt>`, `rpc <method>`, `viewport.sync`, `app.boot` |
| Metrics | `editor.fps`, `editor.frame_time_ms` (histogram), `editor.sync.latency_ms`, `editor.sync.update_bytes`, `editor.storage.save_ms`, `editor.render_ms`, selection and modal-transform counters, `web_vitals.*` (LCP, INP, CLS, FCP, TTFB) |
| Logs | uncaught errors and unhandled rejections, operator failures, sync/storage warnings |

No geometry, names or file contents are collected. Users can opt out in *Preferences → Privacy*;
operators of a deployment can disable ingestion with `TELEMETRY_ENABLED=false`.
*Bottom area → Diagnostics* shows the live numbers and recent spans in the app itself.

## Server

* **Logs**: structured JSON (pino) with `trace_id`/`span_id` correlation; authorization headers
  are redacted.
* **Traces**: HTTP requests, WebSocket message handling, persistence load/save, MCP tool calls and
  RPC round trips, exported with OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
* **Metrics** (`/metrics`, Prometheus): sync connections/rooms/messages/update sizes,
  persistence operations and latency, HTTP requests, MCP tool calls and latency, plus metrics
  aggregated from browser telemetry (`editor_operator_executions_total{operator,source,status}`,
  `editor_operator_duration_seconds`, client frame time, sync latency, client log counts).
* **Health**: `/healthz` (liveness) and `/readyz` (persistence reachable).

## Running the stack

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 docker compose --profile observability up -d
```

* Grafana: http://localhost:3000 — dashboard *3D Editor — Usage & Health*
  (`deploy/grafana/dashboards/3d-editor.json`)
* Jaeger: http://localhost:16686 — traces from both the server and browsers
* Prometheus: http://localhost:9090
