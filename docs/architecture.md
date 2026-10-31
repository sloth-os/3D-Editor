# Architecture

```
┌──────────────────────────── Browser (PWA) ─────────────────────────────┐
│  Preact UI  ── operators (registry) ── SceneDoc (Yjs CRDT) ── three.js │
│     │              │                        │                          │
│  keymap/menus   undo manager          y-indexeddb (always)             │
│  telemetry ─────────────────┐         WebDAV merge-sync (optional)     │
│                             │         SyncProvider (WebSocket + tabs)  │
└─────────────────────────────┼────────────────┬─────────────────────────┘
                              │ OTLP/JSON      │ binary Yjs protocol
┌─────────────────────────────▼────────────────▼─────────────────────────┐
│ Node server: static PWA · /sync rooms (Yjs) · /mcp (Model Context      │
│ Protocol) · /dav WebDAV proxy · /otlp ingestion · /metrics · /healthz  │
│     │ persistence: memory | disk | WebDAV (CRDT merge, If-Match)       │
└─────┼──────────────────────────────────────────────────────────────────┘
      ▼
  WebDAV server (Nextcloud, rclone, Apache…)       OTel Collector → Jaeger / Prometheus / Grafana
```

## Packages

| Package | Purpose |
| --- | --- |
| `packages/core` | Isomorphic TypeScript (browser + Node): math, polygon mesh kernel, document model, modifiers, animation, scene evaluation, operators, import/export, software renderer, sync protocol, WebDAV client and project store. |
| `apps/web` | The PWA: Preact UI, three.js viewport, interaction, persistence, sync, telemetry, service worker. |
| `apps/server` | Fastify server: hosts the PWA, real-time sync hub, MCP endpoint, WebDAV proxy, telemetry ingestion, Prometheus metrics. |
| `e2e` | Playwright tests against the production builds, a real WebDAV server and real MCP clients. |

## Document model

Every project is one Yjs document (`SceneDoc` is a typed facade). Top-level maps hold datablocks
(`objects`, `meshes`, `materials`, `lights`, `cameras`, `images`, `collections`), animation curves
(`fcurves`) and settings (`meta`, `scene`, `render`, `world`). Datablock fields are individual
last-writer-wins registers, so two people changing different properties of the same object
merge without conflict. Mesh geometry is stored as one compact binary blob per mesh
(`mesh/codec.ts`), replaced atomically on each edit.

Field names follow Blender's Python API (`location`, `rotation_euler`, `hide_viewport`,
`base_color`, `energy`, `lens`, …) and the coordinate system is Blender's: Z up, right handed,
meters, Euler XYZ rotations in radians.

Per-user state (selection, mode, current frame, 3D cursor, viewport camera) is *not* stored in
the document; it is published through Yjs awareness for presence ("follow" another user's view,
see who selected what).

## Operators

All user actions are operators (`registry.run(ctx, id, params)`) with Blender-style ids such as
`mesh.primitive_cube_add`, `object.modifier_add`, `mesh.extrude_region_move`,
`transform.rotate`. An operator:

* validates parameters with a zod schema (defaults filled in; JSON schema is generated for UIs
  and MCP),
* runs inside one Yjs transaction → exactly one undo step that syncs to every device,
* is reported to the Info log and traced by telemetry (`operator <id>` span).

The same registry serves menus, hotkeys, the F3 search, the redo panel ("Adjust Last
Operation"), the JavaScript console, and MCP tools. UI-only operators (view navigation,
dialogs) are registered by the web app with `uiOnly: true`.

## Undo

Each replica has its own `Y.UndoManager` tracking only its own origin, so *undo never reverts
someone else's work*. MCP sessions get their own undo history per project.

## Rendering

The viewport is evaluated by `SceneEvaluator` (animation → parenting → modifier stacks, cached
by content keys) and mirrored into three.js. Shading modes: Wireframe, Solid (studio matcap),
Material Preview (PBR + studio environment), Rendered (scene lights, shadows, world, tone
mapping). F12 renders offscreen from the active camera at the output resolution. The server has a
CPU rasterizer (`core/render`) so MCP agents can get images without a browser; when an editor is
open the server delegates rendering to it over RPC.

## Persistence & sync

See [storage-and-sync.md](storage-and-sync.md).

## Observability

See [observability.md](observability.md).
