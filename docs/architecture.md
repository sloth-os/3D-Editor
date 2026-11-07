# Architecture

```
┌───────────────────────────────── Browser (PWA) ─────────────────────────────────┐
│  Preact UI ── operator registry ── SceneDoc (Yjs CRDT) ── SceneEvaluator        │
│  keymap, menus,     │                  │                      │                 │
│  F3, console     undo manager      y-indexeddb (always)    three.js viewport    │
│                  (own changes)     WebDAV merge-sync (opt)                      │
│                                    SyncProvider (WebSocket + BroadcastChannel)  │
│  render workers (Web Workers): path tracing, APNG/GIF encoding                  │
│  telemetry ──────────────────┐                                                  │
└──────────────────────────────┼───────────────────┬──────────────────────────────┘
                               │ OTLP/JSON         │ binary Yjs protocol + RPC
┌──────────────────────────────▼───────────────────▼──────────────────────────────┐
│ Node server (Fastify): static PWA · /sync rooms (Yjs) · /mcp (AI agents)        │
│ /api (projects, export, render.png) · /dav WebDAV proxy · /otlp · /metrics      │
│ render threads (worker_threads): path tracing, CPU rasterizer, encoders, export │
│ persistence: memory | disk | WebDAV (CRDT merge, If-Match)                      │
└──────┬──────────────────────────────────────────────────────────────────────────┘
       ▼
  WebDAV server (Nextcloud, rclone, Apache…)       OTel Collector → Jaeger / Prometheus / Grafana
```

The same TypeScript core runs in the browser, in the browser's render workers, on the server and
in the server's render threads: the document model, the operators, scene evaluation, both renderers
and the importers/exporters are isomorphic (no DOM, no Node APIs).

## Packages

| Package         | Purpose                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Isomorphic TypeScript: math, mesh kernel, document model, operators, modifiers, curves and text, constraints, armatures, instancing, physics, materials, animation, scene evaluation, generators, CPU rasterizer and path tracer, import/export, sync protocol, WebDAV client and project store |
| `apps/web`      | The PWA: Preact UI, three.js viewport, interaction, browser render workers, persistence, sync, telemetry, service worker                                                                                                                                                                        |
| `apps/server`   | Fastify server: hosts the PWA, real-time sync hub, MCP endpoint, REST API, render threads, WebDAV proxy, telemetry ingestion, Prometheus metrics                                                                                                                                                |
| `e2e`           | Playwright tests against the production builds, a real WebDAV server and real MCP clients                                                                                                                                                                                                       |
| `scripts`       | `mcp.mjs`, a small MCP client (CLI and module) used by the [example projects](../examples)                                                                                                                                                                                                      |

### Where each subsystem lives

| Subsystem                                                                                                                                                                             | Location                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Vectors, matrices, quaternions                                                                                                                                                        | `packages/core/src/math`                                      |
| Mesh kernel: topology, normals, triangulation, UV projections, sculpt and paint dabs, shape key blending, edit operations                                                             | `packages/core/src/mesh` (edit operations in `mesh/ops`)      |
| Document model: `SceneDoc`, datablock types and defaults                                                                                                                              | `packages/core/src/doc`                                       |
| Operator registry and all built-in operators                                                                                                                                          | `packages/core/src/operators`                                 |
| Modifier registry and the 22 modifier types                                                                                                                                           | `packages/core/src/modifiers`                                 |
| F-curves, F-curve modifiers, drivers and their expression language, animatable data paths                                                                                             | `packages/core/src/anim`                                      |
| Splines (Bezier, NURBS), curve-to-mesh (bevel, extrude, fill), built-in font, text layout, paths                                                                                      | `packages/core/src/curve`                                     |
| Constraint catalogue and schemas, solvers, dependency graph, baking                                                                                                                   | `packages/core/src/constraints`                               |
| Armatures: pose evaluation, IK (FABRIK), bone constraints, skinning, automatic weights                                                                                                | `packages/core/src/armature`                                  |
| Collection instances and particle systems: distribution, expansion, export items                                                                                                      | `packages/core/src/instancing`                                |
| Rigid bodies: shapes, broad and narrow phase, solver, simulation cache                                                                                                                | `packages/core/src/physics`                                   |
| Procedural textures, material presets, surface sampling, generated coordinates                                                                                                        | `packages/core/src/material`                                  |
| Per-frame state and scene evaluation (`FrameState`, `SceneEvaluator`)                                                                                                                 | `packages/core/src/eval`                                      |
| CPU rasterizer, sky, environment lighting, animation encoders (GIF, APNG, contact sheets)                                                                                             | `packages/core/src/render`                                    |
| Path tracer: scene compiler, BVH, BSDF, lights, integrator, film, denoiser, display                                                                                                   | `packages/core/src/render/pathtrace`                          |
| Procedural generators and spatial queries (ray casts, drops, distances)                                                                                                               | `packages/core/src/generate`                                  |
| glTF, OBJ, STL, PLY import and export; procedural texture baking                                                                                                                      | `packages/core/src/io`                                        |
| Sync protocol, WebDAV client, project store                                                                                                                                           | `packages/core/src/sync`, `packages/core/src/storage`         |
| UI: layout, outliner, Properties tabs, dope sheet, timeline, dialogs                                                                                                                  | `apps/web/src/ui`                                             |
| Keymap, menus, UI-only operators, operator runner, RPC handler                                                                                                                        | `apps/web/src/editor`                                         |
| three.js viewport: scene mirroring, materials and procedural GLSL, sky and world environment, colour management, glass layers, sun shadow fitting, picking, modal transforms, brushes | `apps/web/src/viewport`                                       |
| Browser rendering: worker pool, progressive path tracing, animation rendering                                                                                                         | `apps/web/src/render`                                         |
| Project session, local index, WebDAV storage, sync provider, telemetry, PWA                                                                                                           | `apps/web/src/project`, `storage`, `sync`, `telemetry`, `pwa` |
| Server app, configuration, authentication                                                                                                                                             | `apps/server/src/app.ts`, `config.ts`, `auth.ts`              |
| Sync rooms, unique project names and persistence                                                                                                                                      | `apps/server/src/sync`, `apps/server/src/persistence`         |
| MCP tools, instructions, scene summaries, operator groups, editor commands, bounded undo histories                                                                                    | `apps/server/src/mcp`                                         |
| Render threads (renders and exports), their CPU priority                                                                                                                              | `apps/server/src/render`                                      |
| REST API, WebDAV proxy, observability                                                                                                                                                 | `apps/server/src/api`, `dav`, `observability`                 |

## Document model

Every project is one Yjs document (`SceneDoc` is a typed facade). Top-level maps hold the settings
(`meta`, `scene`, `render`, `world`), the datablocks (`objects`, `meshes`, `materials`, `lights`,
`cameras`, `images`, `collections`, `curves`, `armatures`) and the animation (`fcurves`, `drivers`).
Datablock fields are individual last-writer-wins registers, so two people changing different
properties of the same object merge without conflict. Mesh geometry is stored as one compact binary
blob per mesh (`mesh/codec.ts`), replaced atomically on each edit; shape keys and vertex groups
are stored next to it as binary arrays. Object-level lists (modifiers, constraints, particle
systems, the pose of an armature object, rigid body settings) are fields of the object, so
concurrent edits to the same list are last-writer-wins.

Field names follow Blender's Python API (`location`, `rotation_euler`, `hide_viewport`,
`base_color`, `energy`, `lens`, `bevel_depth`, …) and the coordinate system is Blender's: Z up,
right handed, meters, Euler XYZ rotations in radians. Animation curves address their channel by
target, Blender data path and index (`pose.bones["Arm"].rotation_euler`, index 1).

Per-user state (selection, mode, current frame, 3D cursor, viewport camera) is _not_ stored in
the document; it is published through Yjs awareness for presence ("follow" another user's view,
see who selected what). MCP agents have the same per-user state on the server.

## Operators

All user actions are operators (`registry.run(ctx, id, params)`) with Blender-style ids such as
`mesh.primitive_cube_add`, `object.modifier_add`, `mesh.extrude_region_move` or
`transform.rotate`. The core registers about 260 of them (`createOperatorRegistry()` in
`packages/core/src/operators/index.ts`); the web app adds about 40 UI-only operators (view
navigation, dialogs, modal tools) with `uiOnly: true`. An operator:

- **validates its parameters strictly** with a zod schema: defaults are filled in, values are
  checked, and parameter names the schema does not declare are rejected at every nesting level
  with did-you-mean suggestions and the list of valid names (`INVALID_PARAMS`), so a misspelled key
  never silently falls back to a default. The JSON schemas generated for UIs and MCP are closed
  (`additionalProperties: false`);
- **polls** before running: a wrong mode or an empty selection fails with `POLL_FAILED` and a
  reason;
- **runs inside one Yjs transaction**, so it is exactly one undo step and one sync update for every
  device (read-only and selection operators set `undo: false` and run outside a transaction);
- **reports** info, warnings and errors (shown in the Info log, returned to agents) and returns a
  result object (created ids, measurements, counts);
- **is traced** by telemetry (`operator <id>` span with source, mode, status and duration).

The same registry serves menus, hotkeys, the F3 search, the redo panel ("Adjust Last Operation"),
the JavaScript console and MCP. MCP exposes it directly: `list_operators` lists every operator
except the UI-only and `render.*` ones, with JSON schemas (filterable by registry category or by
feature groups such as Curves, Rigging, Physics or Rendering, see
`apps/server/src/mcp/operator-groups.ts`), `run_operator` runs one, `batch` runs several in one
undo step, and `edit_mesh` runs `mesh.*` operators on an explicit vertex/edge/face selection. The
dedicated MCP tools (`add_object`, `set_material`, `add_modifier`, `insert_keyframe`, …) are thin
wrappers around the same operators. The `render.*` operators are refused through `run_operator`,
`batch` and `edit_mesh`, because they would render on the server's main thread; agents render
with `render_image` and `render_animation`, which use the render threads.

## Undo

Each replica has its own `Y.UndoManager` tracking only its own origin, so _undo never reverts
someone else's work_. MCP agents get their own undo history per project. Sessions that send the
same agent id (`x-mcp-agent-id` header or `?agent=`) share one history and one editor state, so a
CLI that opens a session per call can still undo its previous call; the history is kept for six
hours after the last session ends.

The server bounds every agent's history (`apps/server/src/mcp/history.ts`). A `Y.UndoManager`
keeps everything a tracked change deleted so that undo can restore it, and Yjs never
garbage-collects such items, so an agent that kept replacing large meshes used to make the
server's replica (and the saved project) grow with its whole edit history. Each agent now keeps at
most `MCP_UNDO_STEPS` steps (default 100) and `MCP_UNDO_MEMORY_MB` of replaced or deleted data
(default 64 MB) per project, the newest step always included. Dropped steps, data created and
deleted again within one step, and everything a history held when it ends (its session or agent id
expired, the project was deleted or unloaded) are garbage-collected.

## Scene evaluation

`SceneEvaluator.evaluate(frame)` (`packages/core/src/eval/evaluate.ts`) turns the document into
an `EvaluatedScene`: per object the evaluated datablock, local and world matrices, visibility,
evaluated geometry, wire lines, curve data, pose, light/camera data, materials and the errors of
its constraints and modifiers; plus the instances, the world, render and scene settings, the
active camera and a list of non-fatal problems (drivers, poses, curves, instancing, physics). The
viewport, both renderers, the exporters, the MCP scene summaries and the scene-tool operators all
read the scene through it. One evaluator lives in every project session, render worker and server
render thread, and keeps its caches between calls. The MCP inspection tools keep two per document
(render and viewport settings) and reuse the 16 most recent evaluations (by frame and settings)
until the document changes (`apps/server/src/mcp/eval-cache.ts`).

In short, per frame: F-curves → drivers → parenting → armature poses → constraints (in dependency
order) → rigid body overrides, then shape keys → curves and text → modifier stacks → instancing.
The rigid body simulation itself is stepped before everything else, because its passive and
animated bodies need the unsimulated transforms. The steps, in order:

1. **Rigid body simulation** (when the rigid body world is enabled and has bodies):
   `RigidBodySimulator` (`packages/core/src/physics`) steps the simulation from the world's start
   frame up to the requested frame and caches every simulated frame. Passive and animated bodies
   follow their unsimulated transforms (a `FrameState` without physics). The cache is shared per
   document and invalidated only when an input of the simulation changes.
2. **Frame state** (`eval/frame-state.ts`), computed lazily per datablock and memoised:
   - **F-curves**: keyframes (Bezier, linear or constant), extrapolation and F-curve modifiers
     (`anim/fcurve.ts`, `anim/fmodifiers.ts`) are applied to objects, materials, lights, cameras,
     the world, shape key values and curve data;
   - **drivers** (`anim/drivers.ts`) then override their channels; a driver that reads a datablock
     still being resolved (for example its own object) sees the F-curve values;
   - **world matrices**, per object on demand: an object-level **dependency graph**
     (`constraints/depgraph.ts`: parents, bone parents and constraint targets) orders the
     evaluation so dependencies come first without deep recursion, and finds dependency cycles.
     The local matrix is composed from the animated transform and multiplied by the parent's world
     matrix (for bone parents, the posed bone's tail). A rigid body driven by the simulation takes
     its simulated matrix; otherwise the **constraint stack** is solved (`constraints/solve.ts`),
     skipping and reporting constraints that lie on a cycle;
   - **armature poses** (`armature/pose.ts`) are evaluated bone by bone on demand: rest pose, pose
     channels, then bone constraints and IK (`armature/ik.ts`, FABRIK with pole targets). Bones are
     evaluated individually so an object parented to a bone, or a constraint targeting a bone, can
     be resolved while another bone of the same armature is still being evaluated;
   - **curve paths** for Follow Path, Clamp To and the Curve modifier.
3. **Geometry**, per mesh, curve and text object, again dependency-aware (a Boolean operand or an
   Armature modifier's armature is evaluated first):
   - **curves and text** become a surface through `curve/to-mesh.ts` (bevel, bevel object,
     extrusion, fill, caps, the built-in font); a curve without a surface feeds its wire to the
     modifier stack;
   - **shape keys** are blended into mesh positions (not while the mesh is in Edit Mode);
   - **modifier stacks** (`modifiers/`) run with the modifiers enabled for the viewport, render or
     Edit Mode, with access to other objects' evaluated meshes and matrices, armature poses and
     curve paths. Results are cached under a content key (base geometry version, modifier
     parameters, signatures of everything the stack reads, the frame for time-dependent
     modifiers), so unchanged objects are not recomputed.
4. **Cameras** with a depth-of-field focus object get the focus distance of that frame.
5. **Instancing** (`instancing/expand.ts`): collection instances and particle systems expand into
   instance matrices referencing source objects (content-keyed caches; at most 200,000 instances).

Operators that need the scene at another frame (`scene.measure` with `frame`,
`anim.bake_transforms`) evaluate those frames without changing the current one.

## Rendering

### Viewport

The viewport (`apps/web/src/viewport`) mirrors the evaluated scene into three.js: meshes with
their evaluated geometry, `InstancedMesh`es for instances, line helpers for curves, empties, lights,
cameras and bones. Materials are built from the Principled fields, with procedural textures
compiled to GLSL (`procedural-glsl.ts`, the same functions the CPU renderers use). Shading modes:
Wireframe, Solid, Material Preview (a studio HDRI, whatever the world) and Rendered (scene lights
with shadow maps, the world's environment, procedural sky or colour, mist, the render view
transform and exposure).

Rendered shading and the browser's final renders (F12, Render Animation, MCP renders) are made to
look like the core renderers: lamps get the intensities the CPU rasterizer and the path tracer use
(Blender's watts and W/m², `scene-objects.ts`); exposure and the view transform are applied by an
output pass with the core's curves (`view-transform.ts`) instead of three.js tone mapping; STUDIO
and IMAGE worlds are sampled from the core's environment and lit with image-based lighting
(`world-env.ts`); a scene without any light gets the core renderers' camera-relative studio rig.
Glass is drawn from a picture of what lies behind it (`transmission.ts`), in levels so that glass
seen through glass shows (up to three levels, one above about a million drawn triangles), with the
refraction offset scaled to the object's size. A sun's shadow map is fitted to what the camera
sees before every render (`sun-shadow.ts`). Final renders evaluate the document as it is, at the
requested frame, for rendering: objects visible in renders (`hide_render`), modifiers, curves and
particles with their render settings.

### Renderers

There are two render engines (`render.engine`):

- **RASTER**: in the browser, WebGL with the Rendered look; on the server (and in tools without a
  browser), the CPU rasterizer in `packages/core/src/render` (Z-buffered triangles, Blender light
  units, studio/image/sky lighting with prefiltered reflections, procedural textures, sorted
  transparency, the view transform and exposure, Film > Transparent, no shadows). Glossy surfaces
  also reflect the lit scene through one 32 px cube-map probe placed in front of what the image
  centre shows and looked up by direction only (no parallax); meshes over 20,000 triangles are
  drawn into it from coarse stand-ins. Neither rasterizer lights surfaces with emissive meshes.
- **PATHTRACER**: the CPU path tracer in `packages/core/src/render/pathtrace`. `preparePathTrace`
  evaluates the scene and compiles it (one BVH per distinct mesh plus a top-level BVH over the
  instances, compiled materials, lamps and emissive triangles as light sources, an importance
  table for the environment, the camera);
  `PathTracer.renderRows` renders bands of rows for a range of sample indices into tiles; a
  `PathFilm` accumulates color, emission, albedo, normal, depth and a luminance moment for the
  variance estimate; `denoiseFilm` filters the result and `filmToRGBA8` applies the view transform
  and exposure. Samples are pure functions of
  pixel, sample index and seed, so without a time limit an image is identical however the work is
  split across threads. Rendering is progressive (passes of 1, 2, 4, 8, then 16 samples per pixel)
  and can stop at a time limit after at least one sample per pixel. Shadow rays treat glass and
  alpha-transparent surfaces as thin sheets that tint and dim the light, so lamps inside glass light
  their surroundings; glass reached from a diffuse or glossy vertex is thin-walled for that path
  too, so glass casts no caustics (mirrors do, blurred by Filter Glossy), while the camera,
  mirrors and smooth glass still see refraction (`integrator.ts`). Mist follows the camera path
  through glass and transparent layers.

`renderSceneSoftware` (`render/index.ts`) dispatches between the two for headless callers, and
`renderAnimation` (`render/animation.ts`) renders frame ranges into GIF, APNG, PNG sequences or
labeled contact sheets.

### Browser render workers

F12 with the path tracer and Ctrl+F12 run on a pool of Web Workers (`apps/web/src/render`): one per
core (`navigator.hardwareConcurrency`, at most 8), started on first use and stopped after 90
seconds without work; where workers cannot start, an in-process stand-in runs the same code between
event loop turns. Each worker receives the document as a Yjs state update (later renders send only
the difference), evaluates and compiles the scene itself, and renders bands of rows handed out pass
by pass (`schedule.ts`). The main thread adds the tiles to one film and refreshes the preview row by
row; at the end a worker denoises and tone maps the mean film. Animation frames are rendered one
after the other (path traced on the workers, or rasterized with WebGL) and streamed to an APNG or
GIF encoder on a worker, so the main thread keeps no frames. Canceling keeps the samples or frames
finished so far. The editor's RPC handler path traces on these workers when a request asks for
`engine: PATHTRACER`: the server's MCP `render_image` sends such requests with
`renderer: browser` (with `renderer: auto` it path traces on the server and sends only raster
renders to browsers).

### Server render threads

Server-side rendering (`apps/server/src/render`) serves the MCP tools `render_image` and
`render_animation` and `GET /api/projects/:id/render.png`, off the event loop:

- **Threads.** A `RenderPool` of `worker_threads` running `dist/render-worker.js` (shipped next to
  `dist/main.js`). `RENDER_WORKERS` sets the number of threads for long renders (default: the CPU
  cores, at most 8); one more worker is started on demand for quick raster renders. With
  `RENDER_WORKERS=0`, or when workers cannot start, a single "thread" runs the same engine on the
  main thread between event loop turns. Workers start lazily, warm up before taking work, drop
  their document caches after two idle minutes and stop after ten. On Linux they run at a lower
  CPU priority (nice 10, `RENDER_WORKER_NICE`; `priority.ts`): they still use every core the main
  thread leaves idle, but the main thread (HTTP, sync rooms, MCP, health checks) and the garbage
  collector get a core as soon as they have work, which keeps `/healthz` answering quickly under
  combined render load.
- **Leasing.** Long renders (path-traced stills, animations) lease all render threads; up to two
  of them share the threads, which alternate between their tasks, and further ones wait in order.
  Quick raster renders lease one free thread (the extra worker or an idle one) and never wait for
  long renders; so do exports (MCP `export_scene` and the REST export), since a glTF export samples
  the animation frame by frame and bakes procedural textures, which takes seconds for large
  scenes. At most two path-traced stills hold a film at a time.
- **Documents.** The project's Yjs state is shared with the threads as an update; each thread
  caches up to three documents together with their `SceneEvaluator`, so geometry, instancing and
  simulation caches survive between renders. In scenes with an unbaked rigid-body simulation, one
  thread simulates and the resulting matrices (up to 16 MB per document) are shared with the
  others, so the simulation is not repeated per thread.
- **Path-traced stills** are split into bands of rows over sample ranges (tasks of about 25,000
  samples, at least three bands per thread and pass); the main thread accumulates the tiles in one
  film, then a render thread denoises it and encodes the PNG. **Animations** render frames in
  parallel, one per thread; a path-traced animation with fewer frames than threads renders its
  frames one after the other, each in bands on all threads. Limits: 2048 × 1280 pixels for path
  tracing, 4096 × 4096 for raster images; requests report progress notifications and can be
  canceled.
- **Routing.** `render_image` with `renderer: auto` sends RASTER renders to a browser editor that
  has the project open (over the sync connection's RPC channel, so they use WebGL), and path traces
  on the server; without a browser, RASTER uses the CPU rasterizer. With `renderer: browser` both
  engines run in the editor, PATHTRACER on its render workers. `render_animation` and `render.png`
  always render on the server. Files from `render_animation {store: true}` are kept for an hour
  (at most 256 MiB) and served from `/api/projects/:id/renders/…`.

## Server

- **Sync rooms** (`apps/server/src/sync`): one room per open project holds a server-side replica of
  the Yjs document and relays the binary Yjs protocol and awareness between WebSocket clients
  (`/sync/:projectId`). Rooms load from and save to the persistence backend (debounced,
  `PERSIST_DEBOUNCE_MS`) and unload after `ROOM_IDLE_TTL_SECONDS` without clients. Rooms also carry
  RPC requests from the server to browser editors (`render`, `ui`). Project names are unique on a
  server, ignoring letter case: MCP `create_project` / `rename_project` and REST `POST` / `PATCH`
  check them one request at a time (`project-names.ts`). Projects that browser editors create
  (locally, then synced) and renames in the editor's Scene tab are not checked.
- **MCP** (`apps/server/src/mcp`): a Streamable HTTP endpoint. Every MCP session is an agent that
  edits the room's replica through the same operator registry, with its own transaction origin,
  undo history (bounded, see [Undo](#undo)), editor state and presence (shown as "AI agent" in
  the editors). Tool arguments are checked strictly (`strict-args.ts`), and so are the commands
  and parameter names of `editor_command` before they reach an editor (`editor-commands.ts`).
  Scene summaries (`scene-summary.ts`) report evaluated values next to stored ones. See
  [mcp.md](mcp.md).
- **REST API** (`apps/server/src/api`): project listing and management, snapshots, exports,
  `render.png` and stored renders, `/api/config`, `/healthz`, `/readyz`, `/metrics`.

## Persistence & sync

See [storage-and-sync.md](storage-and-sync.md).

## Observability

See [observability.md](observability.md).
