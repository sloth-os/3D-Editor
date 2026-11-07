# Observability

The goal is to understand _how people create and edit 3D projects_ so the editor can be
improved: which tools are used, which are slow or fail, where users undo a lot, how the viewport
performs on real devices, and how sync and storage behave.

## Browser telemetry

`apps/web/src/telemetry` emits OpenTelemetry-compatible OTLP/JSON to the server
(`/otlp/v1/traces|metrics|logs`). Batches are buffered in `localStorage` while offline.

| Signal  | Content                                                                                                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spans   | `operator <id>` for every operator (source: menu/hotkey/palette/redo/console/mcp, mode, status, duration, object count), `project.open`, `storage.webdav.sync`, `sync.connect`, `render.image`, `import <fmt>`, `export <fmt>`, `rpc <method>`, `viewport.sync`, `app.boot` |
| Metrics | `editor.fps`, `editor.frame_time_ms` (histogram), `editor.sync.latency_ms`, `editor.sync.update_bytes`, `editor.storage.save_ms`, `editor.render_ms`, selection and modal-transform counters, `web_vitals.*` (LCP, INP, CLS, FCP, TTFB)                                     |
| Logs    | uncaught errors and unhandled rejections, operator failures, sync/storage warnings                                                                                                                                                                                          |

No geometry, names or file contents are collected. Users can opt out in _Preferences → Privacy_;
operators of a deployment can disable ingestion with `TELEMETRY_ENABLED=false`.
_Bottom area → Diagnostics_ shows the live numbers and recent spans in the app itself.

## Server

- **Logs**: structured JSON (pino) with `trace_id`/`span_id` correlation; authorization headers
  are redacted.
- **Traces**: HTTP requests, WebSocket message handling, persistence load/save, MCP tool calls and
  RPC round trips, exported with OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Metrics** (`/metrics`, Prometheus):
  - server: `sync_connections`, `sync_rooms`, `sync_messages_total{type,direction}`,
    `sync_update_bytes`, `sync_rpc_requests_total`, `persistence_operations_total{op,status}`,
    `persistence_duration_seconds{op}`, `http_requests_total`, `http_request_duration_seconds`,
    `mcp_sessions`, `mcp_tool_calls_total{tool,status}`, `mcp_tool_duration_seconds{tool}`,
    `telemetry_payloads_total`, `telemetry_forward_failures_total`, plus Node.js runtime metrics
  - aggregated from browsers: `editor_operator_executions_total{operator,source,status}`,
    `editor_operator_duration_seconds{operator}`, `editor_client_spans_total`,
    `editor_client_logs_total{severity}`, `editor_fps`, `editor_frame_time_seconds`,
    `editor_scene_triangles`, `editor_sync_latency_seconds`, `editor_storage_save_seconds`,
    `editor_web_vitals_{lcp,inp,fcp,ttfb}_seconds`, `editor_web_vitals_cls`
  - undo/redo counters per operator (`editor.undo` / `editor.redo` with `undo.operator`) and other
    client counters are forwarded to the OTLP collector for product analysis
- **Health**: `/healthz` (liveness) and `/readyz` (persistence reachable). On Linux the render
  threads run at a lower CPU priority (`RENDER_WORKER_NICE`, default 10), so health checks and
  other requests are answered promptly while renders keep every core busy.

## Running the stack

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 docker compose --profile observability up -d
```

- Grafana: http://localhost:3000 — dashboard _3D Editor — Usage & Health_
  (`deploy/grafana/dashboards/3d-editor.json`)
- Jaeger: http://localhost:16686 — traces from both the server and browsers
- Prometheus: http://localhost:9090
