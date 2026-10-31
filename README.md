# 3D Editor

A collaborative, offline-capable 3D editor for the web, modeled on Blender's workflow:
object & edit mode modeling, modifiers, materials, lights and cameras, keyframe animation,
sculpting and rendering — in an installable PWA that saves to your browser or to WebDAV, syncs
every change live to all devices that have a project open, can be fully driven by AI agents
over MCP, and reports detailed telemetry so the editor can be improved from real usage.

> **Scope, honestly.** Blender is the product of three decades of work; this project implements
> a broad, coherent subset of its core modeling/animation/rendering workflow (listed below) on
> an architecture designed to grow (every feature is an operator in a shared registry). Major
> Blender areas that are *not* implemented yet include rigging/armatures, physics and
> particles, geometry/shader node editors, curves/text objects, grease pencil, the video
> sequencer/compositor and path-traced rendering.

## Highlights

* **Blender-style editing** – familiar layout (viewport, outliner, properties, timeline), keymap
  (G/R/S with axis constraints & numeric input, Tab, Shift+A, X, E, I, Ctrl+B, Ctrl+R, numpad
  views…), F3 operator search, *Adjust Last Operation* panel, JavaScript console.
* **Modeling** – primitives, object transforms/parenting/joining/origins/apply, edit mode with
  vertex/edge/face selection (click, box, loops, linked…) and mesh operators (extrude, inset,
  bevel, loop cut, subdivide, merge, dissolve, fill, bridge, triangulate, spin, symmetrize,
  normals, UV projections…), non-destructive modifiers (subdivision surface, mirror, array,
  boolean, solidify, bevel, decimate, displace, wireframe, screw, deforms…), sculpt and vertex
  paint modes.
* **Look & animation** – principled PBR materials with textures, point/sun/spot/area lights,
  cameras, world settings, Wireframe/Solid/Material Preview/Rendered shading, F12 render,
  keyframes with Bezier/linear/constant interpolation, timeline, dope sheet, UV editor.
* **Files** – import/export glTF 2.0 (`.glb`/`.gltf`), OBJ, STL and PLY.
* **Offline PWA** – installable, works without a network after the first visit.
* **Storage** – browser (IndexedDB) by default; WebDAV when configured (on the server or in the
  browser), with CRDT merge-saving so concurrent devices never overwrite each other.
* **Real-time collaboration** – every change syncs to all devices with the project open (Yjs
  CRDT over WebSockets, plus BroadcastChannel between tabs); presence avatars, remote selections,
  "follow" another user's view; per-user undo.
* **AI agents (MCP)** – `/mcp` Streamable HTTP endpoint with tools for projects, scenes, objects,
  mesh editing, materials, modifiers, animation, import/export, rendering (via a live browser or
  the server's CPU renderer) and driving the live editor UI. See [docs/mcp.md](docs/mcp.md).
* **Observability** – browser and server OpenTelemetry traces/metrics/logs, Prometheus
  `/metrics`, structured logs, health checks, and a Grafana dashboard. See
  [docs/observability.md](docs/observability.md).

## Quick start

### Docker

```bash
docker run -d -p 8080:8080 -v editor-data:/data ghcr.io/sloth-os/3d-editor:latest
```

Open http://localhost:8080. Images are published for `linux/amd64`, `linux/arm64` and
`linux/arm/v7`.

With WebDAV storage and the observability stack (Grafana, Jaeger, Prometheus):

```bash
docker compose --profile webdav --profile observability up -d
```

### From source

Requires Node.js ≥ 22.12.

```bash
npm ci
npm run build
npm start              # http://localhost:8080
```

Development (hot reload; the Vite dev server proxies API/sync/MCP to the Node server):

```bash
npm run dev:server     # terminal 1, port 8080
npm run dev            # terminal 2, http://localhost:5173
```

## Configuration (server environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `PUBLIC_DIR` | built web app | Directory with the PWA build |
| `DATA_DIR` | `./data` (`/data` in Docker) | Disk persistence location |
| `SYNC_PERSISTENCE` | `memory` (`webdav` if `WEBDAV_URL` is set) | Where live projects are persisted: `memory`, `disk`, `webdav` |
| `ROOM_IDLE_TTL_SECONDS` | `3600` | Unload idle projects after this time |
| `WEBDAV_URL`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD` | – | Server-side WebDAV storage |
| `WEBDAV_BASE_PATH` | `/3d-editor` | Folder for projects on WebDAV |
| `WEBDAV_PROXY` | `true` when WebDAV is set | Expose `/dav` so browsers store projects in WebDAV without CORS or credentials |
| `AUTH_TOKEN` | – | Require `Authorization: Bearer` (or `?token=`) for API, sync, WebDAV proxy and MCP |
| `MCP_ENABLED`, `MCP_TOKEN` | `true`, – | MCP endpoint toggle and optional dedicated token |
| `TELEMETRY_ENABLED` | `true` | Accept browser telemetry at `/otlp/v1/*` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | Export server and browser telemetry to an OTLP collector |
| `LOG_LEVEL` | `info` | pino log level |

## Testing

```bash
npm run test:unit         # core, web and server unit tests (Vitest)
npm run test:integration  # server + real WebSocket clients + real MCP client + real WebDAV server
npm run test:e2e          # Playwright: production builds, real Chromium, WebDAV and MCP
npm run lint && npm run typecheck
```

CI runs all of these on every push and pull request; the Docker workflow builds and
smoke-tests the image and publishes multi-arch images to GHCR on `main` and version tags.

## Documentation

* [Architecture](docs/architecture.md)
* [Storage, offline and sync](docs/storage-and-sync.md)
* [MCP / AI agents](docs/mcp.md)
* [Observability](docs/observability.md)

## License

GPL-3.0-only — see [LICENSE](LICENSE).
