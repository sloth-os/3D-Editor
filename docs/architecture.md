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
│ render processes (forked): path tracing, CPU rasterizer, encoders, export       │
│ persistence: memory | disk | WebDAV (CRDT merge, If-Match)                      │
└──────┬──────────────────────────────────────────────────────────────────────────┘
       ▼
  WebDAV server (Nextcloud, rclone, Apache…)       OTel Collector → Jaeger / Prometheus / Grafana
```

The same TypeScript core runs in the browser, in the browser's render workers, on the server and
in the server's render processes: the document model, the operators, scene evaluation, both
renderers and the importers/exporters are isomorphic (no DOM, no Node APIs).

## Packages

| Package         | Purpose                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Isomorphic TypeScript: math, mesh kernel, document model, operators, modifiers, curves and text, constraints, armatures, instancing, physics, materials, animation, scene evaluation, generators, CPU rasterizer and path tracer, import/export, sync protocol, WebDAV client and project store |
| `apps/web`      | The PWA: Preact UI, three.js viewport, interaction, browser render workers, persistence, sync, telemetry, service worker                                                                                                                                                                        |
| `apps/server`   | Fastify server: hosts the PWA, real-time sync hub, MCP endpoint, REST API, render processes, WebDAV proxy, telemetry ingestion, Prometheus metrics                                                                                                                                              |
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
| Render processes (renders and exports), their CPU priority, the server's memory checks                                                                                                | `apps/server/src/render`                                      |
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
with `render_image` and `render_animation`, which use the render processes.

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
render process, and keeps its caches between calls. The MCP inspection tools keep two per document
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

### Server render processes

Server-side rendering (`apps/server/src/render`) serves the MCP tools `render_image`,
`render_animation` and `export_scene`, `GET /api/projects/:id/render.png` and the REST export, off
the event loop:

- **Processes.** A `RenderPool` of child processes (`child_process.fork`, advanced serialization)
  running `dist/render-worker.js` (shipped next to `dist/main.js`; from the sources,
  `worker-dev.mjs` runs `worker.ts` through tsx). `RENDER_WORKERS` sets the number of processes for
  long renders (default: the CPU cores, at most 8); one more is started on demand for quick raster
  renders. They start lazily, warm up before taking work, drop their document caches after two idle
  minutes and stop after ten. They never outlive the server: it stops them when it shuts down
  (`main.ts`), they exit when its IPC channel closes, and a watchdog thread in each process
  (`worker.ts`) ends a busy one when the server was killed or crashed: it checks every half second
  that the server is still its parent; in tests it fired 34–88 ms after the server's death and the
  system took the process down 1.2–2.1 s later. On Linux every thread of a render process runs at a
  lower CPU priority (nice 10, `RENDER_WORKER_NICE`; `priority.ts`): render processes still use
  every core the server leaves idle, but the server (HTTP, sync rooms, MCP, health checks) and its
  garbage collector get a core as soon as they have work, which keeps `/healthz` answering quickly
  under combined render load. Measured against the worker threads they replace (round 9, from the
  bundles, interleaved on a busy machine, identical images): a render process (its watchdog
  included) started in 488–1191 ms (median 532 ms, 12 starts), a worker thread in 684–1449 ms
  (median 841 ms); a domino-cascade thumbnail took 358–517 ms (the first one, with the start,
  1352–1902 ms), the 1280 × 720 raster still 5395–6222 ms (worker threads 5808–6405 ms), and the
  path-traced still and the GIF the same time within the noise of the machine. After those renders
  the server and its five render processes used 1060–1101 MB of memory (RSS), where the server with
  its worker threads used 704–728 MB: each process has its own Node runtime and heap (148–204 MB
  each here, about 13 MB of it the watchdog thread).
- **Out of memory.** Each render process has its own JavaScript heap: Node's default (2096 MB on a
  machine with 16 GB of memory) or `RENDER_WORKER_MEMORY_MB`. A render or export that needs more
  ends only its render process: the request it was working on fails with a
  `RenderOutOfMemoryError` within the time the process takes to die, the server logs
  `render process ran out of memory`, and the next render starts a new process. The error starts
  with `out of memory: ` whatever ended the process:
  `the render process ran out of its … MB JavaScript heap`,
  `the render process could not allocate memory (…)` or
  `the render process was killed (SIGKILL), most likely by the system because the machine ran out of memory`,
  each followed by
  `; the server keeps running and starts a new render process for the next render` (in
  single-thread mode, below: `this render was not started: …`). The MCP tools put
  `Rendering failed: `, `Rendering the animation failed: ` or `Export failed: ` before it, add what
  the tool can do instead (`OUT_OF_MEMORY_ADVICE`, `ANIMATION_OUT_OF_MEMORY_ADVICE`,
  `EXPORT_OUT_OF_MEMORY_ADVICE` in `mcp/rendering.ts`) and the JSON `{"code": "OUT_OF_MEMORY"}` on
  the next line; the REST `render.png` and export answer 507 with
  `{"error": "render failed: out of memory: …", "code": "OUT_OF_MEMORY"}` (`export failed: …` for
  the export). Requests of another long render that were waiting behind it in the same process
  (two long renders share the processes) fail with a `shared` error that starts with
  `interrupted: ` and says this render was not the cause and can run again, without the advice
  about the scene (REST: 503 with code `INTERRUPTED` and `Retry-After: 1`); a render reports its
  own failure when it has one (`primaryRenderError`). A process that
  crashes otherwise names the error it died of (the `TypeError: …` line Node prints, not its
  version banner). Renders do not run in worker threads because Node aborts the whole process when
  a worker's heap allocation fails in some paths (V8's fatal "JavaScript heap out of memory"),
  whatever the worker's resource limits: one render of a grid of 2 million triangles took the
  server down that way. A render process killed with SIGKILL (the kernel's out-of-memory killer) is
  reported the same way; render processes raise their `oom_score_adj` to 1000, so the kernel ends
  them before the server. Since round 9 a SOLID raster render of 1280 × 720 of a grid of 2,000,012
  triangles takes 4.4–5.0 s in a new render process and 1.7–2.2 s in a warm one, which peaks at
  1133–1206 MB of memory (RSS); 4,000,012 triangles take 2.9–3.5 s warm and peak at 1871–2002 MB,
  and at 2345–2553 MB in a process that rendered the 2 million triangles before (a process keeps
  the documents of its last three renders until two idle minutes drop them; rounds 9 and 10, from
  the bundle, peak RSS per render in five sessions). Their render buffers no longer take a string
  key and small arrays per corner: before, the 2 million triangles needed 21.7 s and 2.8 GB of heap
  for them alone.
- **Single-thread mode.** With `RENDER_WORKERS=0`, or after three render processes failed to start,
  a single "thread" runs the same engine on the server's main thread between event loop turns, in
  the server's own heap, where running out of memory stops the server. There a render or export is
  refused with a `RenderOutOfMemoryError` before it starts when its estimated heap need does not fit
  into the free heap with 256 MB left over (after a full garbage collection). The estimate
  (`memory.ts`) needs no evaluation: 320 bytes per triangle of the meshes shown in renders, from
  their stored counts (307 measured for a raster or path-traced render of a grid of 980,000
  triangles, decoded mesh included), plus the peak heap of their modifiers (the estimates below)
  or the render of their result at the same 320 bytes per triangle, whichever is larger; curves,
  text and instances are not counted. A grid of 2,000,012 triangles with one level of Subdivision
  Surface for renders is refused in 0.3 s (about 3,281 MB); the modifier check below also applies
  there.
- **Leasing.** Long renders (path-traced stills, animations) lease all render processes; up to two
  of them share the processes, which alternate between their tasks, and further ones wait in order.
  Quick raster renders lease one free process (the extra process or an idle one) and never wait for
  long renders; so do exports (MCP `export_scene` and the REST export), since a glTF export samples
  the animation frame by frame and bakes procedural textures, which takes seconds for large
  scenes. At most two path-traced stills hold a film at a time.
- **Documents.** The project's Yjs state goes to a render process as an update only when the
  process does not have that version yet (requests name the version; each process caches up to
  three documents together with their `SceneEvaluator`, the pool mirrors that cache, and a process
  that dropped a document gets the request again with its state), so geometry, instancing and
  simulation caches survive between renders. In scenes with an unbaked rigid-body simulation, one
  process simulates and the resulting matrices (up to 16 MB per document) are shared with the
  others, so the simulation is not repeated per process.
- **Path-traced stills** are split into bands of rows over sample ranges (tasks of about 25,000
  samples, at least three bands per process and pass); the main thread accumulates the tiles in
  one film, then a render process denoises it and encodes the PNG. **Animations** render frames in
  parallel, one per process; a path-traced animation with fewer frames than processes renders its
  frames one after the other, each in bands on all processes. Limits: 2048 × 1280 pixels for path
  tracing, 4096 × 4096 for raster images; requests report progress notifications and can be
  canceled.
- **Routing.** `render_image` with `renderer: auto` sends RASTER renders to a browser editor that
  has the project open (over the sync connection's RPC channel, so they use WebGL), and path traces
  on the server; without a browser, RASTER uses the CPU rasterizer. With `renderer: browser` both
  engines run in the editor, PATHTRACER on its render workers. `render_animation` and `render.png`
  always render on the server. Files from `render_animation {store: true}` are kept for an hour
  (at most 256 MiB) and served from `/api/projects/:id/renders/…`.
- **The server's own process.** The MCP inspection tools (`get_scene`, `get_object`,
  `get_mesh_data`) and the operators evaluate scenes in the server's process, in its heap (Node's
  default: 2096 MB on a machine with 16 GB of memory); renders and exports run in render processes
  and do not add to it. Loading the server's render module installs a memory check for every
  modifier evaluated there (core `eval/memory.ts`, `setGeometryMemoryCheck`; render processes run
  without it): each modifier's peak heap is estimated from its input and parameters before it runs,
  per face of its result (Subdivision Surface 700 bytes, Array 400, Mirror 1500 with merging,
  Solidify 1100, Wireframe 600, Triangulate 550) or of its input (Bevel 2800, Edge Split 2600,
  Smooth 1600, Weld 700, deform modifiers 400–600, Decimate 6500), measured on grids, and a
  modifier that does not fit into the free heap with 256 MB left over, after a full garbage
  collection, is skipped with the error
  `skipped on the server: this Subdivision Surface would need about … MB of JavaScript heap for a result of about … faces …`
  (scene summaries list it with the RENDER evaluation's problems; Apply fails with it). A 125 × 125 grid with Subdivision Surface
  levels 4 (4,000,000 faces, about 2,670 MB estimated, 2.4 GB measured) used to stop the server
  from one `get_scene`; now `get_scene` answers in 1.8 s (server 363 MB RSS) and
  `object.modifier_apply` fails with that error. A grid of 2,000,012 triangles with a default
  Subdivision Surface: `get_scene` in 6.7 s, the server at 952 MB.
- **Operators in the server's process.** Before an operator runs there (MCP tools, the REST API),
  the registry asks the server's check (core `operators/memory.ts`, `setOperatorMemoryCheck`) with
  the operator's estimated peak heap, from its parameters and the size of its input: in Edit Mode
  32 MB plus 3,800 bytes per face of the edited mesh (1,000 for transforms, 2,600 for selections,
  5,500 for extrudes and Inset, 10,500 for Bevel: their edge structures are keyed by strings), plus
  1,000–3,500 bytes per face the operator adds (Subdivide and Loop Cut 3,400) and the added faces
  decoded (Spin also 400 bytes per copy of a selected vertex in each step); a primitive in Object
  Mode 32 MB plus 400 bytes per face and its faces decoded; a generator (`object.generate_*`) 32 MB
  plus 1,100 bytes per face it builds and its faces decoded, the faces counted from its parameters
  as the generator builds them (`operators/memory-generators.ts`: a default tree is 19,446 faces,
  about 57 MB; a test checks the counts against generators run with random parameters); an export
  run in the process (`export_scene.*` and `export_mesh.*` through `run_operator` or `batch`, which
  build the file in the heap and return it in base64) 32 MB plus 300 (GLB) to 1,800 (OBJ) bytes per
  face it writes, every particle and collection instance (written as a mesh of its own, counted from
  the particle systems and instanced collections, nested ones included, at most 200,000 instances,
  `operators/memory-instances.ts`) with 2,000 bytes more per instance, curves and text by their
  surfaces, on top of what the export's new evaluation of the whole scene keeps decoded (modifier
  results, curve and text surfaces); entering Edit Mode (also MCP `edit_mesh`, which does it
  without the registry) 32 MB plus 600 bytes per face. Operators that give each selected object a
  mesh of its own count every object, linked duplicates included: Join (the joined mesh holds a copy
  of each), Apply Transform and Set Origin (each linked duplicate gets a copy first), Convert (a new
  evaluation of the whole scene, then for every object its geometry, a copy and the stored mesh;
  curves and text by their surfaces, below); `object.array_place` and `object.scatter_on_surface`
  with `linked: false` count the meshes their copies add. The numbers are the peak heap of
  `--trace-gc`, garbage included, on grids of growing size, rounded up; the operators that cannot
  multiply geometry, or are bounded by limits of their own, are listed with the reason
  (`UNESTIMATED_OPERATORS`, a test keeps the list complete). An operator
  that does not fit into the free heap with 256 MB left over, after a full garbage collection,
  fails with code `OUT_OF_MEMORY` and
  `not run on the server: it would need about … MB of JavaScript heap for a mesh of about … faces, and the server's process has … MB of its … MB heap free and keeps 256 MB of it for its other work. Lower … to run it on the server (a browser editor runs it in its own memory)`.
  One that adds geometry also fails when the project's meshes would then take more than half of the
  heap less those 256 MB decoded (920 MB with the default heap: about 7.8 million triangles of grids
  with UVs at 124 bytes each):
  `not run on the server: the project's meshes would then take about … MB of JavaScript heap decoded (now … MB), more than the … MB the server's process keeps for the meshes of one project …`.
  `edit_mesh mesh.subdivide {number_cuts: 1}` on a grid of 1,000,000 faces used to end the server
  after about 67 s; now it fails that way after 5.4 s (selecting the million faces), the server at
  1,398 MB of memory (RSS) at most. Joining 40 linked duplicates of a grid of 250,000 faces used to
  end the server after 20.7 s, and an OBJ export of 5,000 particle instances of a sphere of 1,280
  faces after 42 s; now the join fails in 11 ms (the project's meshes would take 2,366 MB) and the
  export in 28 ms (6,400,001 faces, 11,028 MB estimated), the server at 353 MB and 183 MB (RSS) at
  most. Browser editors and render processes run operators without a check.
- **Stored meshes in the server's process.** The open projects keep their meshes decoded
  (`SceneDoc.getMesh`: 24 bytes per vertex, 72 per face and 8 per corner, with UVs 56 more per face
  and 16 per corner, core `mesh/memory.ts`). Decoding one asks the server's check first; a mesh
  that does not fit into the free heap with 256 MB left over is not loaded:
  `this mesh of … triangles was not loaded on the server: decoding it needs about … MB of JavaScript heap, …`.
  `get_scene` then lists its stored counts with that reason (`not_loaded`, and among the problems),
  operators on it fail with code `OUT_OF_MEMORY`, other tools with the reason and that code.
  `object.convert` refuses objects whose geometry did not evaluate fully (a modifier that failed or
  was skipped, a curve or text surface that was not built), like Apply (Blender: "Modifier is
  disabled or returned error, skipping apply"), instead of baking the geometry without them.
- **Curve and text surfaces in the server's process.** The server's evaluation asks the same check
  before it builds the surface of a curve or text object (core `eval/memory.ts`
  `estimateCurveSurface`): 32 MB plus 1,000 bytes per point its splines (or the outlines of its
  glyphs) are sampled into and 520 bytes per vertex of the surface swept along them (bevel,
  extrusion) and of 2D fills, counted from the splines' points and resolution, the bevel profile
  and the text's glyphs without building anything, at most the 3,000,000 swept vertices a curve
  gets (`curve/to-mesh.ts`); text at least 64,000 bytes per character with a glyph. Peaks measured
  with `--trace-gc` per vertex: 260–300 bytes on smooth sweeps of 0.8 to 2.9 million vertices,
  up to 463 where every sample is a sharp corner; per sample 860–870 on wires of 100,000 and
  250,000 samples. A surface that does not fit into the free heap with 256 MB left over is not
  built, nor its wire:
  `skipped on the server: this curve surface would need about … MB of JavaScript heap for a result of about … faces, … Lower resolution_u, bevel_resolution or the number of spline points to evaluate it on the server (a browser editor evaluates it itself)`
  (text: `this text surface`, `Lower the length of the text or resolution_u …`). `get_scene` lists
  it among the problems, Convert refuses the object. Three curves of 2,863,684 surface vertices
  each used to end the server from `get_scene` (and converting one of them did too); now the first
  is built (2.9 s, the server at 1,071 MB RSS), the others are skipped (1,497 MB estimated each,
  1,342 MB free), and Convert fails in 0.3 s (6,986 MB estimated).
- **Snapshots in the server's process.** REST `GET /api/projects/:id/snapshot` copies every mesh
  and serializes the copy to one JSON string in the server's heap: 1.93 times the meshes' decoded
  size at the peak (a grid of 640,000 faces; 2.95 times when the meshes were not decoded yet). The
  server estimates the copy plus at most 307 characters of JSON per face of a grid (230 measured)
  and the base64 of shape keys, vertex groups and images; when that bound is over the 512 MB a
  JavaScript string can hold, it counts the characters of the meshes' values instead (0.7 s for a
  grid of 1,000,000 faces, within 30 characters of the JSON). It answers 507 with code
  `OUT_OF_MEMORY` when the copy and the JSON do not fit into the free heap with 256 MB left over,
  or when the JSON is longer than a string can be:
  `snapshot failed: not built on the server: it would need about … MB of JavaScript heap (a copy of the meshes and up to … MB of JSON), …`
  or `… the snapshot would be … MB of JSON, more than the 512 MB a JavaScript string can hold. …`.
  Three grids of 291,600 faces used to end a server with a 640 MB heap; now the snapshot is
  refused in 0.1 s and the server keeps answering.

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

See [storage-and-sync.md](storage-and-sync.md). In code: `FileStore`
(`packages/core/src/storage/filestore.ts`) is implemented by `MemoryFileStore`, the server's
`DiskFileStore` (`apps/server/src/persistence/disk.ts`) and `WebDAVClient`
(`packages/core/src/storage/webdav.ts`). A store reports an ETag only together with the content it
belongs to, and `atomicConditionalWrites` says whether it checks `If-Match` in the same step as the
write (memory and disk do, WebDAV servers do not all). `ProjectFileStore.syncDocument` merges and
writes; on WebDAV it also checks the ETag right before writing (no request between the check and the
write) and reads its write back. Server rooms (`apps/server/src/sync/room.ts`) save debounced,
refresh every 60 s while editors are connected, and when they wrote to WebDAV read storage again in
the next refresh, before eviction (a room whose read fails is not evicted) and at shutdown. Browsers
sync open projects with WebDAV in `apps/web/src/storage/webdav.ts`. A project another writer deleted
is written again only with unsaved changes: `syncDocument` creates a missing document only with
`create` (rooms pass whether they have unsaved changes; browsers whether their copy holds insertions
beyond the state vector of what they synced, which `syncRecords` keeps in localStorage together with
the deletions made in the browser, or the person saved), never once storage held all of the local
document (a deletion right after its write), and its writes never create a folder that is gone
(`createFolders` is false); its result's `stored` tells browsers what they synced, also when the
deletion came right after. `RoomManager` reads storage again before it opens a room nobody uses,
closes a room whose project was deleted elsewhere once nobody uses it, and remembers the deletion
for an hour, as it does for its own deletions, unless storage holds the project again; requests wait
5 s at most for these reads, and not for a read of the same room or project that another request
stopped waiting for while it goes on (`openReadWaitMs`, `Room.storageLate`; MCP get_project's own
check, `readBeforeAnswer`, follows the same rule). A `WebDAVClient` request fails after `timeoutMs`
(30 s on the server) also when the answer's body stops coming, with an error that names the request
and the timeout. `RoomManager.exists` throws `StorageUnavailableError` when storage fails to tell
whether a project that is not loaded exists (it used to answer no), unless the id is also the name
of a loaded project: then storage that fails, or does not answer within 5 s, makes it answer no, so
that MCP tools, which ask about a reference as an id first (`AgentSession.resolveProjectId`), find
that project by its name. `RoomManager.deleteProject` deletes the stored files between the room's
saves (`Room.deleteFromStorage`: the room writes nothing once storage deleted the project) and
closes the room only then; when storage fails to delete it, the room goes on serving. It waits for
the project's earlier reads and writes of storage (a load, the room's queue of reads and writes) 5 s
at most in all, and not at all while a read that a request stopped waiting for goes on
(`Room.storageLate`); when they have not finished, it deletes nothing. It runs one deletion of a
project at a time, and loads of the project wait for it. The sync server closes connections to a
deleted project with code 4404 (`PROJECT_DELETED_CLOSE_CODE`, `packages/core/src/sync/protocol.ts`),
after which the browser's `SyncProvider` (`apps/web/src/sync/provider.ts`) no longer reconnects by
itself (status `deleted`, which the status bar shows as `Deleted on server`); with WebDAV through
the server, `ProjectSession` connects it again once a WebDAV sync finds the project stored there
again. Save (Ctrl+S) shows what `WebDAVSync.save` reports. A room of a project that has a
`project.json` and no document writes no name into its new document (a new name item could win over
a browser's rename when the two merge); its scene (`RoomScene`) has the stored name, and so does a
browser's (`SessionScene`), which takes it from the server or WebDAV (`ProjectSession.storedName`)
until the document has a name.

## Observability

See [observability.md](observability.md).
