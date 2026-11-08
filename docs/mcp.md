# Controlling the editor with AI agents (MCP)

The server exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`.
Through it an agent can create and inspect projects, run any of the editor's operators, edit
meshes, curves, text, materials, modifiers, constraints, rigs, physics and animation, import and
export files, and render stills and animations on the server. Every change syncs live to all
editors that have the project open. The agent shows up there as a peer named "AI agent (_client
name_)", with its own selection.

This page is the reference for the endpoint, its 36 tools, the related REST endpoints and the
`scripts/mcp.mjs` client. For a task-oriented guide (workflow, recipes, render budgets, common
errors, the example projects) see [agent-guide.md](agent-guide.md).

Contents:

- [Connecting](#connecting): endpoint, authentication, sessions and agent ids
- [Conventions](#conventions)
- [Tools](#tools): projects, inspection, operators, objects, materials, modifiers, mesh editing,
  animation and settings, undo, files, rendering, live editors, resources
- [Errors](#errors) and [limits](#limits)
- [REST endpoints](#rest-endpoints)
- [`scripts/mcp.mjs`](#scriptsmcpmjs-cli-and-module)
- [Example session](#example-session)

## Connecting

The endpoint speaks Streamable HTTP with stateful sessions:

- `POST /mcp` with an `initialize` request opens a session. The response carries the session id
  in the `Mcp-Session-Id` header; every later request sends it back.
- `GET /mcp` (with `Mcp-Session-Id`) opens the server-to-client event stream. `DELETE /mcp` ends
  the session at once, and its avatar disappears from the project.
- The server is named `3d-editor`. Its `initialize` result carries usage instructions
  (conventions, tool overview, workflows; source: `apps/server/src/mcp/instructions.ts`).

Claude Code:

```bash
claude mcp add --transport http 3d-editor http://localhost:8080/mcp
```

Any MCP client with Streamable HTTP support connects the same way. Clients that only speak stdio
can use a bridge such as `mcp-remote`:

```json
{
  "mcpServers": {
    "3d-editor": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8080/mcp"] }
  }
}
```

### Authentication

| Server setting | Effect                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| `AUTH_TOKEN`   | One shared token, required on `/api`, `/sync`, `/mcp`, `/dav` and `/otlp` |
| `MCP_TOKEN`    | An additional token that is accepted on `/mcp` only                       |
| neither        | `/mcp` is open                                                            |

Send the token as `Authorization: Bearer <token>` or as a `?token=<token>` query parameter (the
query parameter is redacted from logs). Without a valid token the server answers `401` with
`WWW-Authenticate: Bearer realm="3d-editor"`.

```bash
claude mcp add --transport http 3d-editor http://localhost:8080/mcp --header "Authorization: Bearer <token>"
```

The download links that `export_scene` and `render_animation` return point at `/api/...`. When the
server has an `AUTH_TOKEN`, fetching them needs that token; an `MCP_TOKEN` alone is not accepted
there.

Other settings: `MCP_ENABLED=false` removes the endpoint. Browser-based clients on another origin
need `CORS_ORIGINS`; CORS allows the `mcp-session-id`, `mcp-protocol-version` and `x-mcp-agent-id`
request headers and exposes `mcp-session-id`.

### Sessions, agent ids and what they share

For every project it touches, an MCP session has:

- an **undo history** that tracks only that agent's changes (`undo` never reverts other people's
  work; bounded, see [Undo and redo](#undo-and-redo)),
- an **editor state**: selected objects, active object, mode (`OBJECT` or `EDIT`), current frame
  (1 at the start), 3D cursor and the edit-mode element selection,
- a **presence** entry: the avatar "AI agent (_client title or name from `initialize`_)" with its
  selection, mode and frame, visible to everyone in the project.

Without an agent id, history and editor state end with the session. Clients that open a new
session for every call (one-shot CLIs, scripts that reconnect) keep them by sending an **agent id**
with the `initialize` request:

- header `x-mcp-agent-id: <id>`, or
- query parameter `?agent=<id>` on the endpoint URL, e.g. `http://localhost:8080/mcp?agent=cove`.

An id is 1–128 characters of letters, digits and `. _ : @ / + -`. Anything else fails the
`initialize` request with HTTP 400 (JSON-RPC error `-32602`). Sessions with the same agent id
share one undo history and one editor state per project, so `undo` in a new session reverts the
previous session's change. Each session still has its own presence entry.

A shared identity is kept for 6 hours after its last session closed, and at most 200 are kept (the
least recently used idle ones are dropped first). Its history is lost when the server restarts or
when the project is unloaded: a project nobody has open (no editor, no MCP session) is unloaded
after `ROOM_IDLE_TTL_SECONDS` (default 3600 s).

### Session lifecycle

| Event                                          | Result                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| No request for 5 minutes                       | The avatar is hidden; the next request shows it again                                   |
| No request for 30 minutes (and no open stream) | The session is closed; requests with its id get HTTP 404 `Session not found`: reconnect |
| The client disconnects while a request runs    | The request is cancelled (a running render stops)                                       |
| The client sends `notifications/cancelled`     | Same                                                                                    |
| The server shuts down                          | New requests get HTTP 503                                                               |

**Progress.** When a request carries a progress token (`_meta.progressToken`), long renders send
`notifications/progress` at most every 250 ms: samples per pixel for path-traced stills, frames
for animations, and the elapsed seconds every 5 s while a request waits for a browser editor (a
`render_image` with `renderer: "browser"` until the image arrives, an `editor_command` until the
editor answers). Clients should reset their request timeout on progress (`scripts/mcp.mjs` does,
with a 15-minute timeout): the 60 s default of clients built on the MCP TypeScript SDK is too short
for long renders. The server's own waits for a browser editor outside path tracing stay under it
(at most 55 s), so their errors arrive first.

## Conventions

- Right-handed, **Z up**, lengths in **metres**. As in Blender, the front view looks along +Y, so
  the "front" of generated objects faces −Y.
- Rotations are Euler XYZ in **radians** (`rotation_euler`; the rotation matrix is Rz·Ry·Rx, as in
  Blender). `add_object`, `create_mesh` and `transform_object` also accept `rotation_degrees`.
- Colours are **linear** RGB or RGBA, components 0..1. Convert sRGB values (colour pickers, hex
  codes) first.
- Objects, materials and projects are referenced by id or exact name. Names are unique per kind; a
  taken object or material name gets a suffix (`Cube.001`), so use the name a result returns.
  Project names are unique on the server, ignoring letter case: `create_project` and
  `rename_project` refuse a name another project has (see [Projects](#projects)).
- Operators and their parameters use Blender's ids and names (`mesh.primitive_cube_add`,
  `object.modifier_add`, `bevel_depth`, `energy`); data paths use Blender syntax
  (`pose.bones["Arm"].rotation_euler`, `constraints["Track To"].influence`).
- **Strict names.** Unknown or misspelled names are rejected with did-you-mean suggestions and the
  list of valid names.
  - **Tool arguments** are checked before a tool runs, for names as well as types and ranges, at the
    top level and inside `view`, `selection` (and its `mesh`) and the `operations` of `batch` (and
    their `selection`), so a rejected call changes nothing: `set_scene_settings {"sampels": 5}`
    fails with "Input validation error: Invalid arguments for tool set_scene_settings: unknown
    argument 'sampels' (did you mean 'samples'?). Valid arguments: …". A key that belongs inside a
    nested argument is pointed there (`'position' goes inside 'view'`). For a key that is no typo of
    a valid argument, the tools that take `params` add a hint that operator, modifier or command
    parameters belong there, and `set_material`, `insert_keyframe` and `set_scene_settings` name the
    operators for settings they do not take. The input schemas in `tools/list` are closed
    (`additionalProperties: false`).
  - **Operator and modifier parameters** (the `params` of `run_operator`, `batch`, `edit_mesh`,
    `add_object` and the modifier tools) are checked by the operator registry, at every nesting
    level, before the operator runs; in a `batch`, the operations before a rejected one stay
    applied. Operator JSON schemas carry `additionalProperties: false`.
  - **`editor_command`** commands, their parameter names and the values the server checks
    (`screenshot` sizes and `shading`, the types of `notify` and `run_operator` values) are checked
    by the server before anything is sent to an editor, also when no editor is connected.
- **Evaluated and stored values.** `get_scene` and `get_object` report values at a frame after
  keyframes, drivers, F-curve modifiers, constraints and physics, like Blender's properties
  editor. Where animation overrides the value stored in the document, the stored value is listed
  next to it: `stored` (transforms; light, camera and curve data), `stored_value` (shape keys),
  `stored_influence` (constraints) and `stored_params` (constraint and modifier parameters). Tools
  such as `transform_object` and the `*.properties_set` operators change stored values, which
  keyframes and drivers then override.
- **Frames.** Tools that evaluate the scene (`get_scene`, `get_object`, `get_mesh_data`,
  `get_instances`, `render_image`, `export_scene`) use the agent's current frame unless they get a
  `frame`. It is 1 in a new session and changes with `set_scene_settings {frame_current}` or the
  `scene.frame_set` operator.
- **Failed calls change nothing**, the agent's editor state included: a `selection` is applied all
  or nothing, and when a `run_operator`, `edit_mesh` or `batch` operation fails, the agent's
  selection, active object and mode are put back as they were before it (the failure's `selection`
  shows them).
- **Precision.** `get_scene` rounds numbers to 4 decimals (0.1 mm), `get_object` and the object
  briefs that `add_object`, `create_mesh`, `transform_object`, `duplicate_object`, `set_parent` and
  `import_model` return to 6 (1 µm); `get_scene` and `get_object` take `decimals` (0–6).

## Tools

| Area             | Tools                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Projects         | `list_projects`, `create_project`, `get_project`, `rename_project`, `delete_project`                 |
| Inspection       | `get_scene`, `get_object`, `get_mesh_data`, `get_instances`, `list_operators`, `list_modifier_types` |
| Any operator     | `run_operator`, `batch`                                                                              |
| Objects          | `add_object`, `create_mesh`, `transform_object`, `delete_objects`, `duplicate_object`, `set_parent`  |
| Materials        | `set_material`                                                                                       |
| Modifiers        | `add_modifier`, `update_modifier`, `remove_modifier`, `apply_modifier`                               |
| Mesh editing     | `edit_mesh`                                                                                          |
| Animation, scene | `insert_keyframe`, `set_scene_settings`, `set_active_camera`                                         |
| History          | `undo`, `redo`                                                                                       |
| Files            | `import_model`, `export_scene`                                                                       |
| Rendering        | `render_image`, `render_animation`                                                                   |
| Live editors     | `get_connected_clients`, `editor_command`                                                            |

Every tool that changes the document is **one undo step** (`batch` included; `delete_project`
cannot be undone). Read-only tools (`list_*`, `get_*`, `export_scene`, `render_image`,
`render_animation`) change nothing and carry `readOnlyHint`; `delete_project` and
`delete_objects` carry `destructiveHint`.

Results are JSON text, except where noted (images, embedded files). Failures are tool results with
`isError: true`; see [Errors](#errors).

### Projects

| Tool             | Arguments                       | Returns                                                                                          |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `list_projects`  | –                               | `projects[]`: `id`, `name`, `created_at`, `updated_at`, `stats`, `peers`, `loaded`, `editor_url` |
| `create_project` | `name`, `empty` (default false) | `id`, `name`, `editor_url`, `objects[]`                                                          |
| `get_project`    | `project`                       | Listing fields, `persistence`, `persistence_note`, `stored_at`, `editor_url`, `clients[]`        |
| `rename_project` | `project`, `name`               | `id`, `name`                                                                                     |
| `delete_project` | `project`, `confirm: true`      | `deleted` (id)                                                                                   |

- `project` arguments take a project id or its exact name (a case-insensitive match is tried when
  no exact one exists). Several projects with the same name are an error that lists their ids.
- Project names are unique, ignoring letter case. `create_project` and `rename_project` refuse a
  name another project already has (`Lighthouse` when `lighthouse` exists, too) with an error that
  gives that project's id: work in it, delete it first (`delete_project`) or choose another name.
  Renaming a project to another case of its own name is allowed. The REST API applies the same
  rule; projects that browser editors create (locally, then synced) and renames in the editor's
  Scene tab are not checked, so a duplicate name can still appear (pass the id then).
- `create_project` starts with Blender's startup scene (a 2 m cube `Cube` with `Material`, a
  `Camera` and a point `Light`) unless `empty` is true. `editor_url` (`/?project=<id>`) opens the
  project in the web editor.
- `get_project` reports the server's persistence: `persistence` is `disk` or `webdav` (projects are
  saved and survive restarts) or `memory` (lost when the server stops); `persistence_note`
  explains it, and `stored_at` gives the directory or WebDAV location (not for `memory`).
  `clients` lists who has the project open (`name`, `kind`: human or agent).
- `delete_project` removes the stored files and disconnects every editor; it cannot be undone. The
  project's stored renders are no longer downloadable.

### Inspecting the scene

#### `get_scene`

Arguments: `project`, `frame` (default: the agent's frame), `max_objects` (1–5000, default 300),
`decimals` (0–6, default 4 = 0.1 mm).

Describes the whole scene at one frame with evaluated values (see
[Conventions](#conventions)):

- `frame`, `units` (`{up_axis: "Z", length: "meters", angles: "radians"}`), `active_camera`.
- `counts`: `objects`, `by_type`, `vertices` / `faces` (the **base** meshes of mesh objects, before
  modifiers; curves and text not included), `evaluated {vertices, faces, triangles}` (what renders
  show, of the objects shown in renders, the same objects the renderers and `export_scene` use:
  after shape keys, modifiers with their render settings such as SUBSURF `render_levels`, SCREW
  `render_steps` and `show_render`, curve bevels and text, without instances), `not_rendered`
  (objects hidden from renders with `hide_render`, such as Boolean cutters, helpers and the hidden
  sources of scatters: `{objects, vertices, faces, triangles}` with at most 24 names (plus
  `objects_total` when there are more), and `instances` / `instance_triangles` of hidden
  emitters), `evaluated_viewport` (the objects shown in the viewport with the viewport settings,
  like the editor's statistics overlay; listed whenever it differs), `materials`, `instances` and
  `instance_triangles` (particle and collection instances whose emitter or instancing empty is
  shown in renders), `viewport_instances` (when the viewport shows a different number), `drivers`,
  `rigid_bodies`. A collection's `hide_render` is not applied (its objects still render and export,
  and are counted in `evaluated`); a collection hidden with `hide_viewport` is left out of renders
  too.
- `scene` (frame range, fps, units, gravity and `rigidbody_world` when there are rigid bodies),
  `render` (engine, resolution, samples, max_bounces, use_denoising, film_transparent,
  view_transform, exposure) and `world` (colour, strength, environment, sky, mist; `animated` and
  `stored` when keys or drivers change world settings).
- `objects[]`: id, name, type, parent (and `parent_bone`), collection, local `location`,
  `rotation_euler`, `rotation_degrees`, `scale` (with `stored`), `world_bounds` (of the render
  geometry after modifiers, armature deformation, constraints and physics; of the wire for a curve
  without a surface), `data` (see below), material names, modifiers (with object references by
  name), constraints (type, targets, influence, `errors`), particle systems (count, instanced
  object or collection, `instances`), `rigid_body`, `simulated`, `animated` channels, `drivers`
  (path and expression), `modifier_errors` and `problems`.
- `objects_truncated` when more objects exist than `max_objects` (the counts always cover all).
- `materials[]` (main values, procedural channels, `users`), `collections[]`.
- `problems[]`: every evaluation error (drivers, constraints, modifiers, poses, curves, instancing,
  physics) as `{source, object, message, …}`, at most 40. Check it after building.

`data` depends on the object type: meshes give base statistics, `evaluated` statistics (render
settings; `evaluated_viewport` too where the viewport differs), shape keys (values at the frame)
and vertex group names; curves give spline counts, `fill_mode`, the bevel, extrude and other shape
settings that differ from the defaults, and `evaluated` geometry (or a note that a wire curve has
no surface, with `wire_edges`); text gives `body`, size and alignment; armatures give bone names
with parents, `pose_position`, posed and IK bones; lights give the datablock name, type, energy,
colour, shadow and shape fields; cameras give lens, clipping and depth of field. Long lists are
cut at 12 entries per object (24 for animated channels, bones and vertex groups) with a `*_total`
count; use `get_object` for everything about one object.

Evaluations are cached per document state and frame, so repeated `get_scene`, `get_object` and
`get_mesh_data` calls (checking motion at many frames, say) are cheap until the scene changes.

#### `get_object`

Arguments: `project`, `object`, `frame`, `decimals` (0–6, default 6 = 1 µm, so sub-millimetre
parts such as labels, engravings and fine bevels read back as they were made).

Everything about one object at a frame: the `get_scene` entry in full detail, plus `world_location`
and `world_transform {location, rotation_euler, rotation_degrees, scale}` (the final world
transform after parents, constraints and physics), `children`, materials per slot with every
property, the modifier stack with parameters (`stored_params` where animated), constraints with
parameters and errors, particle systems with settings, rigid body settings, drivers with
variables, `animation` (F-curves with up to 100 keyframes each, extrapolation and F-curve
modifiers, including the object's data), custom properties, display and visibility flags. The
mesh statistics in `data` are those of the object itself, also when it is hidden from renders
(`get_scene` then counts it in `not_rendered`). Particle systems give instance counts; their
transforms come from [`get_instances`](#get_instances).

Type-specific detail: curves list every shape setting (`fill_mode`, bevel, `bevel_factor`,
extrude, offset, caps, twist, resolutions, path settings) and their splines with point
coordinates, radius and tilt; text its layout; armatures every bone with rest `head`/`tail`,
`posed_head_world`/`posed_tail_world`, pose channels (with `stored`) and bone constraints; lights
and cameras include the datablock `id` and every setting, including depth of field.

#### `get_mesh_data`

Reads the geometry of a mesh, curve or text object, in pages.

| Argument                                | Default                                            | Meaning                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `include`                               | `["vertices", "faces", "face_materials"]`          | Any of `vertices`, `normals`, `colors`, `faces`, `face_materials`, `face_smooth`, `face_normals`, `face_centers`, `uvs`, `loose_edges`, `vertex_groups`, `heightmap`                                                                                                                                                           |
| `source`                                | `BASE` for meshes, `EVALUATED` for curves and text | `BASE`: the stored mesh, whose indices `edit_mesh`, vertex groups and shape keys use; `EVALUATED`: after shape keys and modifiers at the frame, with the viewport settings (what `evaluated_viewport` counts); `RENDER`: with the render settings, e.g. subdivision `render_levels` (what `evaluated` counts and renders show) |
| `space`                                 | `LOCAL`                                            | `LOCAL` (object space) or `WORLD`, for positions, normals and centres                                                                                                                                                                                                                                                          |
| `vertex_offset`, `face_offset`, `limit` | 0, 0, 2000 (max 20000)                             | Paging: at most `limit` vertices and faces per call                                                                                                                                                                                                                                                                            |
| `frame`                                 | the agent's frame                                  | For evaluated and world-space data                                                                                                                                                                                                                                                                                             |
| `decimals`                              | 4                                                  | Rounding (0–6)                                                                                                                                                                                                                                                                                                                 |
| `heightmap_resolution`                  | 64 (8–256)                                         | Samples along the longer side of the object                                                                                                                                                                                                                                                                                    |

The result has `totals` (vertices, faces, triangles, loose edges), the requested fields for the
page, `material_slots` (with `face_materials`) and, when more remains, `truncated: true` and
`next {vertex_offset, face_offset}` for the next call. Faces are vertex index loops,
counter-clockwise seen from the front. `colors` are linear `[r, g, b, a]` (0..1) per vertex from
the vertex colour layer that `paint.vertex_color_set`, `_stroke` and `_set_data` write (`null`
without one). `vertex_groups` (BASE only) maps each group name to the page's weights.
`heightmap` is a world-space grid of the highest surface point: `heights[j][i]` is the height at
`x = min_xy[0] + i·step[0]`, `y = min_xy[1] + j·step[1]` (`null` where the surface does not
reach), useful for placing things on terrain. The JSON is compact (no indentation).

#### `get_instances`

Lists the instances an object generates, with the world transform of each, in pages: every
particle of its particle systems (`object.scatter_add`, `object.particle_system_add`; a particle
that instances a whole collection gives one entry per collection object) and the objects of the
collection it instances (`object.collection_instance_add`). Use it to check a scatter (spacing,
nothing on a path or in the water, sizes, orientations) without making the instances real.

| Argument          | Default            | Meaning                                                                                                                                                 |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `object`          | –                  | The particle emitter or collection-instancing empty (id or name)                                                                                        |
| `particle_system` | all of them        | Only this particle system (name or id)                                                                                                                  |
| `source`          | `RENDER`           | `RENDER`: what renders show (every particle of the systems with `show_render`); `VIEWPORT`: what the editor shows (display percentage, `show_viewport`) |
| `frame`           | the agent's frame  | Frame to evaluate                                                                                                                                       |
| `offset`, `limit` | 0, 1000 (max 5000) | Paging                                                                                                                                                  |
| `decimals`        | 4                  | Rounding (0–6)                                                                                                                                          |

Each entry of `instances` is `{system, particle}` (or `{collection}` for a collection instance),
the instanced `source` object, and its world `location` (m), `rotation_euler` (radians, XYZ) and
`scale`. The result also has, per particle system, `instance_object` or `instance_collection`,
`count`, the `particles` and `instances` placed and `location_bounds` (min/max of the instance
locations), with `shown: false` when the system is switched off for that `source`; `total` (of the
listed kind), `range`, `problems` (instancing errors) and `emitter_hidden` when the emitter itself
is hidden there. When more remain, `truncated: true` and `next {offset}`. An object without
particle systems or an instanced collection is an error. The JSON is compact.

#### `list_operators`

Arguments: `category`, `search`, `include_parameters`.

The operator catalogue: 263 operators are registered, of which the 2 `render.*` operators are not
listed (renders go through the [rendering tools](#rendering)). `category` accepts, case-insensitively:

- a **registry category**: Add, Animation, Armature, Collection, Curve, Data, Export, Import,
  Layout, Material, Mesh, Object, Paint, Physics, Pose, Scene, Sculpt, Select, Snap, Text,
  Transform, UV, World;
- a **feature group**, which collects the operators of one feature across categories: Curves,
  Text, Constraints, Rigging, Shape Keys, Vertex Groups, Instancing, Particles, Generators, Drivers,
  Shading, Modifiers, Lights and Cameras (also `Lights`, `Cameras`, `Lighting`), Rendering (also
  `Render`). Spaces, underscores and a trailing plural "s" are ignored. Groups whose feature is
  served by tools name them in `group.tools` (Modifiers, Lights and Cameras, Rendering).

When a name is both (Text), the result is the union. `search` matches id, label and description.
Without filters the result is a compact list (`id`, `category`, `description`); with a filter that
matches at most 60 operators, or with `include_parameters: true`, every entry also has `label` and
`parameters` (the JSON schema). The result also lists `categories`, `groups` and `modifier_types`.
An unknown category is an error that lists all categories and groups.

#### `list_modifier_types`

Arguments: `type` (identifier or label, e.g. `SCREW` or `Subdivision Surface`), `category`
(`GENERATE`, `DEFORM`, `NORMALS`), `include_parameters`.

The 22 modifier types with label, category, description and, for at most 6 matching types (or with
`include_parameters`), the JSON schema of their parameters (Blender names, enums, ranges, defaults,
units in the descriptions): ARMATURE, ARRAY, BEVEL, BOOLEAN, BUILD, CAST, CURVE, DECIMATE, DISPLACE,
EDGE_SPLIT, MIRROR, SCREW, SHRINKWRAP, SIMPLE_DEFORM, SMOOTH, SMOOTH_BY_ANGLE, SOLIDIFY, SUBSURF,
TRIANGULATE, WAVE, WELD, WIREFRAME.

### Running operators

#### `run_operator`

Arguments: `project`, `operator`, `params`, `selection`.

Runs one operator with its defaults filled in, as one undo step. Operators act on the agent's own
selection and mode, like in Blender. `selection` sets them before the operator runs and **persists
for the agent's later calls**:

| `selection` field | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `objects`         | Objects to select (ids or names); replaces the selection                                                                                                                                                                                                                                                                                                                                                                       |
| `active`          | The active object (default: the last of `objects`)                                                                                                                                                                                                                                                                                                                                                                             |
| `mode`            | `OBJECT` or `EDIT` (edit mode needs an active mesh object)                                                                                                                                                                                                                                                                                                                                                                     |
| `mesh`            | Edit-mode element selection (needs `mode: "EDIT"`): `verts`, `edges` (`[a, b]` pairs: two vertices an edge of the mesh connects), `faces`, `all` (without lists: everything, the default, or nothing with `false`), `select_mode` (`VERT`: the listed vertices with those of the listed edges and faces; `EDGE`: only `edges`; `FACE`: only `faces`; when omitted `FACE` for faces alone, `EDGE` for edges alone, else `VERT`) |

A `selection` is applied all or nothing: one that cannot be applied (an unknown object, Edit Mode
without an active mesh, `mesh` without `mode: "EDIT"`, an element index out of range, an edge the
mesh does not have, lists that `select_mode` does not select from, `all: true` with lists) fails the
call and changes nothing, and when the operator itself fails, the agent's selection, active object
and mode go back to what they were before the call.

Many operators take explicit object arguments (`object`, `objects`, `target`). Operators that act
on the selection take none: `object.transform_apply`, `object.shade_smooth`, `object.convert`,
`object.join`, `object.origin_set`, `object.duplicate`, `object.parent_set`, `transform.*` and
others. Passing `objects` to them fails with a message that says so; pass `selection` instead.
Operators that add objects make the new object selected and active, and the selection stays that
way for later calls.

The result is `{ok, operator, result, reports, duration_ms, selection}`: `result` is the
operator's own return value (ids, names, counts, `errors` lists of constraints and particle
systems …), `reports` its INFO / WARNING / ERROR messages (for example "apply the scale"), and
`selection` the agent's resulting `mode`, `selected`, `active` and `frame` (with element counts in
edit mode). Read the reports: an operator can succeed and still warn that a setting has no effect.

Every failure is an error result: the first line is the message, followed by JSON
`{ok: false, operator, error, code, selection}`, also when the `selection` cannot be applied, the
project is unknown or the operator id is refused (below). `error` is the message (for an operator
failure without the `<operator> failed:` prefix of the first line), `code` one of
`INVALID_PARAMS`, `POLL_FAILED`, `NOT_FOUND` and `FAILED` (see [Errors](#errors)) and `selection`
the agent's editor state, which the failed call left as it was. When the operator ran, `result`
(`null`), `reports` and `duration_ms` are added; when the project cannot be found, `selection` is
left out. The message is always one line: a line break in a name it quotes (object and project
names can contain them) is written as in JSON (`\n`, `\r`, `\u2028` …), so the JSON always starts
on the second line. A `selection` that cannot be applied fails with these messages and codes:

| Failure                                                                                                   | `code`        | Message (abridged)                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| An unknown object in `selection.objects` or `selection.active`                                            | `NOT_FOUND`   | `Object 'Nope' not found in project 'P'. Objects: …`                                                            |
| `mode: "EDIT"` without an active mesh object                                                              | `POLL_FAILED` | `Edit mode needs an active mesh object (selection.active): 'Camera' is …`                                       |
| `mesh` without `mode: "EDIT"` (in Object Mode)                                                            | `POLL_FAILED` | `selection.mesh selects vertices, edges or faces in Edit Mode: add …`                                           |
| An element index the base mesh does not have (`verts`, `faces`, the vertices of `edges`)                  | `POLL_FAILED` | `face index 99 out of range (mesh has 6 faces)`                                                                 |
| An edge the base mesh does not have: two of its vertices that no edge connects (or the same vertex twice) | `POLL_FAILED` | `edge [0, 3]: vertices 0 and 3 are not connected by an edge of the mesh: an edge joins …`                       |
| A list that `select_mode` does not select from (`EDGE`: only `edges`, `FACE`: only `faces`)               | `POLL_FAILED` | `select_mode 'FACE' selects only the listed faces, so the listed verts would be ignored: list only faces, or …` |
| `all: true` with `verts`, `edges` or `faces`                                                              | `POLL_FAILED` | `all: true selects every element, so the listed faces would change nothing: …`                                  |
| Both: `all: true` with lists that `select_mode` does not select from                                      | `POLL_FAILED` | `select_mode 'EDGE' selects only the listed edges, so the listed faces would be ignored, and all: true …`       |
| An unknown project                                                                                        | `NOT_FOUND`   | `Project 'X' not found. Known projects: …`                                                                      |

The code is decided by the kind of error (an unknown project or object is a "not found" error),
never by the wording of its message. Every remedy that a refused element selection names is accepted
as it is: one message names both problems when they come together, and each of its remedies for the
lists also leaves `all` out ("…: leave all out and list edges instead, leave all and select_mode out
(or leave all out and pass 'FACE') to select the listed faces, leave all out and pass 'VERT' to
select the vertices of the listed faces, or leave the lists out to select everything").

Refused operator ids (failures too, with the `code` named here):

- unknown ids, `NOT_FOUND`, with up to 8 closest ids, letter case ignored: first the ids that
  complete the unknown one (the same namespace, and a last segment that starts with its last
  segment of 3 characters or more; the shortest first: `wm.save` gets `wm.save_mainfile`,
  `view3d.view` the `view3d.view_*` ids, `object.dupli` `object.duplicate`, `object.duplicate_move`
  and `object.duplicates_make_real`), then the nearest by edit distance ("Unknown operator
  'mesh.primitive_cube_ad'. Did you mean: mesh.primitive_cube_add, …? Use list_operators."). The
  closest ids include the browser editor's UI operators (next item), which a note after the list
  names as such, with what to use instead and how a live editor runs them: `VIEW3D.VIEW_ALL` or
  `view3d.view_al` get "Did you mean: view3d.view_all, view3d.view_axis, …? They are operators of
  the browser editor's user interface: a live editor runs them with editor_command {project,
  command: 'run_operator', params: {operator, params}}. Use list_operators." The note's advice
  names the id it is for, unless the note is about one id that it names or that is the only
  suggestion and completes the unknown id, so it never reads as advice for the id the agent meant:
  `wm.save` gets "Did you mean: wm.save_mainfile, wm.share? They are operators of the browser
  editor's user interface (instead: nothing (the server stores projects) for wm.save_mainfile,
  get_project for wm.share): a live editor runs them with …";
- the operators of the browser editor's own user interface, `NOT_FOUND`: the web app registers
  them for itself (view navigation such as `view3d.view_all`, `view3d.view_axis`,
  `view3d.view_camera`, the `view3d.toggle_*` switches, `screen.animation_play`,
  `screen.frame_offset`, `wm.save_mainfile`, `wm.tool_set`, `ed.undo`, `render.render`, Shift+D's
  `object.duplicate_move` …; the list is `BROWSER_UI_OPERATORS` in `packages/core`), so the server
  does not have them. The message says so, how to run one in a live editor that has the project
  open (see [`editor_command`](#editor_command)) and what it does there: it acts on the person's
  editor (their view, selection, frame, tool, undo history, project or clipboard, windows on their
  screen), not on the agent's own state. Where the tools do the same, it names that first (table
  below);
- `render.render_software` and `render.render_animation`, `FAILED`: they would render on the
  server's main thread and stall every editor and agent, so `run_operator`, `batch` and
  `edit_mesh` refuse them and name the tool to use instead (`render_image`, `render_animation`).

What the message of a browser UI operator names instead, and what the operator does when an agent
runs it in a live editor (– : no counterpart among the tools):

| Browser UI operator                                                                                                                                                                    | Instead (the agent's own selection and history)                                                                                                   | In a live editor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `object.duplicate_move` (Shift+D)                                                                                                                                                      | `object.duplicate {linked, offset: [x, y, z]}` (copies and moves them in one step), or the `duplicate_object` tool                                | Duplicates the editor's selection, then waits for the person to move the copies with the mouse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `view3d.transform_modal` (G, R, S)                                                                                                                                                     | `transform.translate {value}`, `transform.rotate {value, orient_axis}`, `transform.resize {value}` (`edit_mesh` for elements), `transform_object` | Starts a move, rotation or scale of the editor's selection that follows the person's mouse until they click                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mesh.loopcut_pick` (Ctrl+R)                                                                                                                                                           | `edit_mesh` with `mesh.loopcut {edge: [a, b], number_cuts}` (an edge of the ring, as base mesh vertex indices)                                    | In Edit Mode, cuts the edge ring of the editor's active mesh under the person's mouse pointer (fails over no edge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sculpt.commit_stroke`                                                                                                                                                                 | `sculpt.brush_stroke`, `paint.vertex_color_stroke` with the points of the stroke                                                                  | Commits the stroke the person is drawing (fails without one)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ed.undo`, `ed.redo`                                                                                                                                                                   | The `undo` and `redo` tools (the agent's own changes)                                                                                             | Undoes or redoes the last change of that editor's undo history: the person's, or an operator run there with `editor_command`, never the agent's changes made with the tools                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `screen.repeat_last`                                                                                                                                                                   | `run_operator` again (or a `batch`)                                                                                                               | Runs the person's last operation again on the editor's selection (operations run with `editor_command` are not repeated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `screen.frame_offset`, `screen.keyframe_jump`                                                                                                                                          | `scene.frame_set {frame}` (the agent's own frame; `get_object` lists the keyframes)                                                               | Moves the editor's current frame (to a keyframe of the editor's selected objects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `screen.animation_play`                                                                                                                                                                | `render_animation`                                                                                                                                | Starts or stops playback in that editor (`editor_command` `play` sets it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `render.render`                                                                                                                                                                        | `render_image`, `render_animation`                                                                                                                | Opens the Render window on the person's screen and renders the scene there at once (path traced on that computer's render workers with `PATHTRACER`), without returning the image; `{animation: true}` opens the Render Animation window instead, which renders nothing until the person presses its Render button                                                                                                                                                                                                                                                                                                 |
| `view3d.object_as_camera`                                                                                                                                                              | `set_active_camera`                                                                                                                               | Makes the editor's active object, a camera, the scene camera and switches that editor to the camera view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `view3d.camera_to_view`                                                                                                                                                                | `transform_object` on the camera (`object.track_set` aims it); `render_image` takes a `view`                                                      | Moves the scene camera to the editor's viewpoint and switches that editor to the camera view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wm.read_homefile`                                                                                                                                                                     | `create_project`                                                                                                                                  | Creates a new project (`{name, empty}`) and switches the person's editor to it, away from the project it had open, which it leaves before it can answer: `editor_command` says it got no answer (`list_projects` lists the new project)                                                                                                                                                                                                                                                                                                                                                                            |
| `wm.share`                                                                                                                                                                             | `get_project` (`editor_url`)                                                                                                                      | Puts the project's link on the person's clipboard, replacing what they had copied (a browser that refuses the copy shows them the link in a message; an editor page without clipboard access, served over plain HTTP from a host other than localhost, does nothing)                                                                                                                                                                                                                                                                                                                                               |
| `wm.import`                                                                                                                                                                            | `import_model`                                                                                                                                    | Asks the browser for a file chooser on the person's screen, which browsers block unless the person has just clicked or pressed a key: from `editor_command` it normally opens nothing (and still answers ok)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wm.export`, `wm.open_mainfile`, `wm.search_menu`                                                                                                                                      | `export_scene`, `list_projects`, `list_operators {search}`                                                                                        | Open the Export window, the project browser or the operator search on the person's screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `wm.preferences`, `wm.call_menu`                                                                                                                                                       | –                                                                                                                                                 | Open the Preferences window or a popup menu on the person's screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `wm.save_mainfile`                                                                                                                                                                     | Nothing: the server stores projects itself                                                                                                        | Makes that editor sync its WebDAV copy at once if it has one (its copy in the browser is always up to date) and shows the person a "Saved" message                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `view3d.view_all`, `view3d.view_selected`, `view3d.view_axis`, `view3d.view_camera`, `view3d.view_orbit`, `view3d.view_persportho`, `view3d.zoom`                                      | – (`render_image` takes a `view` for any viewpoint)                                                                                               | Change the person's view: `view3d.view_all`, `view3d.view_selected`, `view3d.view_axis` and `view3d.zoom` out of the camera view, `view3d.view_camera` into or out of it (it fails without a scene camera), and in the camera view `view3d.view_orbit` and `view3d.view_persportho` change only the view the person gets back when they leave it (`editor_command` `view.frame_all` and `view.frame_selected` do what `view3d.view_all` and `view3d.view_selected` do, and `view.set_view` what `view3d.view_axis` and `view3d.view_camera` do, but `view.set_view {view: "CAMERA"}` never leaves the camera view) |
| `view3d.toggle_xray`, `view3d.toggle_overlays`, `view3d.toggle_sidebar`, `view3d.toggle_toolbar`, `view3d.toggle_wireframe_overlay`, `view3d.toggle_snapping`, `view3d.toggle_shading` | –                                                                                                                                                 | Change that editor's display: X-ray (see-through objects in Solid shading only; in Edit Mode the cage shows through and the person's box selections and vertex and edge clicks also select hidden elements, while a face click picks the front face; selecting objects works the same with it on or off), overlays, sidebar, tool bar, wireframe overlay, snapping of the person's transforms, viewport shading (`editor_command` `view.shading` sets it)                                                                                                                                                          |
| `wm.tool_set`, `screen.workspace_set`                                                                                                                                                  | –                                                                                                                                                 | Change the person's active tool (what their mouse does) or workspace layout (Shading also switches their viewport to Material Preview)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Two of the messages (one line each):

```text
'view3d.view_all' is an operator of the browser editor's user interface (viewport, playback, tools,
windows): only a live editor can run it, not run_operator, batch or edit_mesh. Run it there with
editor_command {project, command: 'run_operator', params: {operator: 'view3d.view_all', params: {…}}}
(get_connected_clients lists the editors that have the project open): it frames every visible object
in that editor's viewport, changing the person's view, out of the camera view (editor_command
view.frame_all does the same).

'object.duplicate_move' is an operator of the browser editor's user interface (viewport, playback,
tools, windows): only a live editor can run it, not run_operator, batch or edit_mesh. To duplicate
objects use object.duplicate {linked, offset: [x, y, z]} on your selection (or the duplicate_object
tool): it copies them and moves the copies by offset in one step. In a live editor run it with
editor_command {project, command: 'run_operator', params: {operator: 'object.duplicate_move', params:
{…}}} (get_connected_clients lists the editors that have the project open): it duplicates the
editor's selection, then waits for the person to move the copies with the mouse.
```

#### `batch`

Arguments: `project`, `operations` (1–200 items of `{operator, params, selection}`),
`stop_on_error` (default true).

Runs operators in order as **one undo step**: one `undo` reverts all of them. An operation's
optional `selection` (as for `run_operator`: objects, active object, mode, edit-mode elements) is
set before that operation runs and stays set for the following ones, for operators that act on the
selection (`object.convert`, `object.transform_apply`, `object.shade_smooth` …); `object.select`
(`{objects, active, extend}`), `object.mode_set` and `mesh.select_elements` work inside a batch
too. An operation that fails changes nothing in the agent's editor state: its selection is not
kept, so the following operations see the selection of before it. With `stop_on_error` the batch
stops at the first failure and keeps the changes made before it.

The result is `{ok, executed, failed, results, selection}`. Each entry of `results` is
`{operator, ok, result}` or `{operator, ok: false, error, code}` (`code` as for `run_operator`: an
operation whose `selection` cannot be applied fails with an `error` starting with `selection:` and
the message of the table above, with `NOT_FOUND` for an unknown object and `POLL_FAILED` otherwise;
unknown operator ids and the browser editor's UI operators are refused with the messages of
`run_operator` and `NOT_FOUND`, `render.render_software` and `render.render_animation` with
`FAILED`), with `reports` when the operator reported anything. `error` is one line, as in
`run_operator`. `operations_with_warnings` is added when some operations reported a WARNING or ERROR
(failed ones included) and counts them. When an operation failed, the tool result is an error whose
text starts with "_n_ of _m_ operation(s) failed" followed by the same JSON. When the call fails as
a whole (an unknown project), the first line is the message and the JSON adds `error` and `code`
(`{ok: false, executed: 0, failed: 0, results: [], error, code: "NOT_FOUND"}`).

### Objects

| Tool               | Arguments                                                                                                   | Notes                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_object`       | `type`, `name`, `params`, `location`, `rotation` or `rotation_degrees`, `scale`, `light_type`               | Types: `cube`, `plane`, `grid`, `circle`, `uv_sphere`, `ico_sphere`, `cylinder`, `cone`, `torus`, `bezier_curve`, `bezier_circle`, `nurbs_path`, `text`, `armature`, `empty`, `camera`, `light` |
| `create_mesh`      | `name`, `vertices`, `faces`, `edges`, `uvs`, `smooth`, `location`, `rotation` / `rotation_degrees`, `scale` | Raw geometry, like Blender's `mesh.from_pydata`                                                                                                                                                 |
| `transform_object` | `object` or `objects`, `location`, `rotation` / `rotation_degrees`, `scale`, `relative`                     | Local (parent) space; `relative` adds location and rotation and multiplies scale                                                                                                                |
| `delete_objects`   | `objects`                                                                                                   | Children are kept and re-parented, keeping their world transform                                                                                                                                |
| `duplicate_object` | `object`, `linked`, `offset`, `name`                                                                        | `linked: true` shares the mesh data (Alt+D)                                                                                                                                                     |
| `set_parent`       | `object` or `objects`, `parent` (null clears), `keep_transform` (default true)                              | Object parenting; for armature or bone parenting use `object.parent_to` with `type`                                                                                                             |

- `add_object` runs the matching operator (`mesh.primitive_*_add`, `curve.primitive_*_add`,
  `object.text_add`, `object.armature_add`, `object.empty_add`, `object.camera_add`,
  `object.light_add`); `params` are that operator's parameters and are validated the same way, e.g.
  `cube {size}`, `uv_sphere {segments, ring_count, radius}`, `cylinder {vertices, radius, depth}`,
  curves `{radius, bevel_depth, extrude}`, `text {body, size, extrude, align_x}`,
  `armature {bone_name, radius}`, `empty {type, radius}`, `camera {lens, clip_end, dof_use, …}`,
  `light {energy, color, shape, size, size_y, spot_size, spot_blend, shadow_soft_size, …}` with
  `light_type` `POINT`, `SUN`, `SPOT` or `AREA`. Light energy is in watts (W/m² for `SUN`). The new
  object becomes selected and active. Generators (`object.generate_*`) and `curve.add_from_points`
  run through `run_operator`.
- `create_mesh` takes `vertices` (`[[x, y, z], …]`, object space), `faces` (vertex index lists,
  counter-clockwise seen from outside), optional loose `edges` and per-face `uvs` (flat
  `[u0, v0, u1, v1, …]` per face). It returns the object and mesh statistics.
- `transform_object` sets stored values. On an animated channel the keyframes still win at their
  frames; key the channel instead (`insert_keyframe`).
- `add_object`, `create_mesh`, `transform_object`, `duplicate_object` and `set_parent` return a
  brief of each object (`id`, `name`, `type`, `location`, `rotation_euler`, `scale`, `parent`;
  transforms rounded to 6 decimals); `delete_objects` returns `{deleted, remaining}` (counts).

### Materials

#### `set_material`

Arguments: `project`, `object`, `material` (an existing material) or `name`, `base_color`,
`metallic`, `roughness`, `emission_color`, `emission_strength`, `alpha`, `transmission`, `ior`
(1–4), `blend_method` (`OPAQUE`, `CLIP`, `BLEND`), `slot` (0–63, default 0).

Gives a mesh, curve or text object a principled material in a slot, as one undo step:

- `material` assigns an existing material (by id or name) and applies the given properties to it;
- `name` updates the material of that name, or creates it;
- with neither, the slot's material is edited when only this object uses it, otherwise a new
  material "_object_ Material" is created.

The result is `{object, slot, created, material}`. Curve splines and text pick their slot with the
spline's `material_index`. Presets, procedural textures and the other Principled settings
(`coat_weight`, `coat_roughness`, `sheen_weight`, `sheen_tint`, `normal_strength`,
`alpha_threshold`, `use_backface_culling`) are operators: `material.preset_list`,
`material.preset_apply`, `material.procedural_set`, `material.new`, `material.update`
(`list_operators {category: "Shading"}`).

### Modifiers

| Tool              | Arguments                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `add_modifier`    | `object`, `type` (identifier or label), `name`, `params`                                                |
| `update_modifier` | `object`, `modifier` (name or id), `params`, `name`, `show_viewport`, `show_render`, `show_in_editmode` |
| `remove_modifier` | `object`, `modifier`                                                                                    |
| `apply_modifier`  | `object`, `modifier`                                                                                    |

- Modifiers work on mesh, curve and text objects; on curves and text they act on the generated
  surface, or on the wire of a curve that has none (so `SCREW` revolves a profile curve).
- Parameter names follow Blender; `list_modifier_types {type}` gives the schema. Unknown names and
  invalid values are rejected together with that schema. `show_viewport`, `show_render`,
  `show_in_editmode` or `name` given inside `params` (when the type has no parameter of that name)
  are an error that says they are arguments of the tool itself. Object parameters (`BOOLEAN object`,
  `ARMATURE object`, `CURVE object`, `ARRAY offset_object`, `MIRROR mirror_object`, …) take object
  names or ids.
- `apply_modifier` bakes the stack up to that modifier into the mesh and removes it (mesh objects
  only). To bake a curve or text object with all its modifiers, convert it:
  `run_operator {operator: "object.convert", params: {target: "MESH"}, selection: {objects: [name]}}`.
- Results include `stack` (the modifier names after the change) and `via` (whether the change went
  through the `object.modifier_*` operators or a direct document edit).

### Mesh editing

#### `edit_mesh`

Arguments: `project`, `object`, `operator`, `params`, `selection` (`verts`, `edges`, `faces`,
`all`), `select_mode` (`VERT`, `EDGE`, `FACE`; default: inferred from the lists), as in the `mesh`
of a `run_operator` selection: `select_mode` `EDGE` selects only `edges` and `FACE` only `faces`,
other lists with them are refused, and so is `all: true` with lists (with the same messages).

Runs an edit-mode operator on one mesh object: enters Edit Mode, selects the given elements
(everything by default), runs the operator and returns to Object Mode, as one undo step. Use it for
`mesh.*` operators (`mesh.extrude_region_move {value}`, `mesh.inset`, `mesh.bevel`,
`mesh.subdivide`, `mesh.loopcut`, `mesh.delete`, `mesh.merge`, …), for `transform.translate`,
`transform.rotate` and `transform.resize` on elements, `object.material_slot_assign {index}` on a
face selection and the `uv.*` unwrap operators. Indices are those of the base mesh (`get_mesh_data`
with `source: BASE`); an edge `[a, b]` is two vertices that follow each other in one of its faces
(the last with the first), or one of its loose edges. The result is
`{ok, operator, result, reports, mesh, selection_after}`: `mesh` statistics and the selected element
indices afterwards (at most 500 of each kind). Afterwards the object is the agent's selected and
active object, in Object Mode.

Every failure is an error result like those of `run_operator`: the first line is the message,
followed by JSON `{ok: false, operator, error, code, selection}` (with `result`, `reports`, `mesh`
and `selection_after` when the operator ran; without `selection` when the project cannot be
found), and it changes nothing in the agent's editor state, whose unchanged selection, active
object, mode and element selection `selection` shows. Besides the operator's own failures:

| Failure                                                                                                                      | `code`            | Message (abridged)                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| An unknown object                                                                                                            | `NOT_FOUND`       | `Object 'Nope' not found in project 'P'. Objects: …`                                                                       |
| An object that is not a mesh                                                                                                 | `POLL_FAILED`     | `'Camera' is not a mesh object.`                                                                                           |
| An element index the base mesh does not have                                                                                 | `POLL_FAILED`     | `face index 42 out of range (mesh has 6 faces)`                                                                            |
| An edge the base mesh does not have (`selection.edges`)                                                                      | `POLL_FAILED`     | `edge [0, 3]: vertices 0 and 3 are not connected by an edge of the mesh: …`                                                |
| A list that `select_mode` does not select from, or `all: true` with lists                                                    | `POLL_FAILED`     | `select_mode 'FACE' selects only the listed faces, so the listed verts would be ignored: …`                                |
| An unknown operator id, an operator of the browser editor's UI (`mesh.loopcut_pick` names `mesh.loopcut`), `render.render_*` | as `run_operator` | as `run_operator` (`Unknown operator …`, `'view3d.view_selected' is an operator of the browser editor's user interface …`) |

### Animation and scene settings

#### `insert_keyframe`

Arguments: `project`, `object` (object id or name, or `"world"`), `property`, `frame`, `value`,
`index`, `interpolation` (`CONSTANT`, `LINEAR`, `BEZIER`; default `BEZIER`), `material_slot`.

Inserts a keyframe on an animatable property. `value` (a number or a vector) sets the keyed value;
without it the current value is keyed. `index` keys one channel of a vector. Property paths:

| Path                                                                                                                                                                                                  | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `location`, `rotation_euler`, `scale`, `color`                                                                                                                                                        | Object transform and viewport colour                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pose.bones["B"].location` / `rotation_euler` / `scale`                                                                                                                                               | A pose bone (bone axes; a bone that was never posed gets its channel first)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pose.bones["B"].constraints["IK"].influence`                                                                                                                                                         | A bone constraint's influence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `constraints["Name"].influence` or another numeric parameter                                                                                                                                          | An object constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `modifiers["Name"].<parameter>`                                                                                                                                                                       | A modifier parameter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `particle_systems["Name"].<setting>`                                                                                                                                                                  | A particle system setting                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `data.<field>`                                                                                                                                                                                        | The object's data: light (`energy`, `color`, `spot_size`, `spot_blend`, `shadow_soft_size`, `size`, `size_y`), camera (`lens`, `ortho_scale`, `shift_x`, `shift_y`, `dof_focus_distance`, `dof_aperture_fstop`, `clip_start`, `clip_end`), curve or text (`bevel_depth`, `bevel_factor_start`, `bevel_factor_end`, `extrude`, `offset`, `eval_time`, `size`, `space_*`, `shear`, `offset_x`, `offset_y`, `splines[i].points[j].co` / `handle_left` / `handle_right` / `radius` / `tilt` / `weight`) |
| `shape_keys["Key"].value` (or `data.shape_keys["Key"].value`)                                                                                                                                         | A mesh shape key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `material.<field>`                                                                                                                                                                                    | The material in `material_slot` (default: the first filled slot): `base_color`, `metallic`, `roughness`, `ior`, `transmission`, `emission_color`, `emission_strength`, `alpha`, `coat_weight`, `sheen_weight`, and procedural texture parameters `material.textures.<channel>.procedural.<parameter>`                                                                                                                                                                                               |
| `object: "world"` with `color`, `strength`, `environment_rotation`, `environment_strength`, `sun_elevation`, `sun_rotation`, `sun_intensity`, `sky_zenith_color`, `sky_horizon_color`, `mist_density` | World settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

A path that is not animatable is an error listing what is; a path that does not resolve (a missing
constraint name, a spline index out of range) is an error naming the missing part. The result is
`{inserted, target_type, target, path, frame}`.

For many keys at once use `run_operator anim.keyframes_insert_many` (one channel, up to 100000
keys, optional easing and extrapolation). Drivers (`anim.driver_add`), F-curve modifiers
(`anim.fmodifier_add`), extrapolation (`anim.extrapolation_set`), baking (`anim.bake_transforms`)
and turntables (`anim.turntable`) are operators: `list_operators {category: "Drivers"}`.

#### `set_scene_settings`

Changes scene, render, world and physics settings in one undo step. Only the given fields change.

| Group   | Fields                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene   | `frame_start`, `frame_end`, `fps`, `unit_system` (`METRIC`, `IMPERIAL`, `NONE`), `frame_current` (the agent's own frame, not stored)                                                                                                                                                                                                                                                                                    |
| Render  | `resolution_x`, `resolution_y`, `resolution_percentage`, `engine` (`RASTER`, `PATHTRACER`), `samples`, `max_bounces`, `use_denoising`, `film_transparent`, `view_transform` (`STANDARD`, `AGX`, `FILMIC`, `ACES`, `NEUTRAL`), `exposure`                                                                                                                                                                                |
| World   | `world_color`, `world_strength`, `environment` (`NONE`, `STUDIO`, `SKY`, `IMAGE`), `environment_strength`                                                                                                                                                                                                                                                                                                               |
| Sky     | `sky_preset` (`NOON`, `CLEAR_DAY`, `MORNING`, `SUNSET`, `DUSK`, `NIGHT`, `OVERCAST`), `sun_elevation` (radians above the horizon), `sun_rotation` (azimuth in radians, counter-clockwise from +Y; about 3.9 front-lights a scene seen from Blender's default camera direction), `sun_intensity` (W/m²), `sun_size` (angular diameter, radians). Any of them switches the environment to `SKY` (same as `world.sky_set`) |
| Mist    | `mist_density` (1/m, 0 = off) or `mist_distance` (metres where the mist reaches 95 %), `mist_color` (same as `world.mist_set`)                                                                                                                                                                                                                                                                                          |
| Physics | `use_gravity`, `gravity` (m/s², default `[0, 0, -9.81]`), `rigidbody_enabled`, `rigidbody_frame_start`, `rigidbody_frame_end`, `substeps_per_frame`, `solver_iterations`, `time_scale` (same as `rigidbody.world_set`)                                                                                                                                                                                                  |

The defaults of a new project are 1920×1080, `RASTER`, 64 samples, 4 bounces, denoising on, `AGX`,
frames 1–250 at 24 fps and a `STUDIO` environment. The result is the resulting `scene`, `render`
and `world` summary, `frame_current`, and `applied` with what the sky, mist and rigid body world
operators reported (e.g. `sun_direction`, `distance_95`, `simulated_frame_end`). Lights and
cameras are objects: change their data with `light.properties_set` and `camera.properties_set`.

#### `set_active_camera`

Arguments: `project`, `camera`. Makes a camera object the scene camera that renders use.

### Undo and redo

Arguments: `project`, `steps` (1–100, default 1).

`undo` reverts the agent's own most recent changes in a project; `redo` re-applies undone ones.
Changes by other people or agents are never reverted. Each tool call that changed the document is
one step (a `batch` is one step). Read-only tools add none, and neither do failed calls, except a
`batch` that failed after some of its operations were applied: those changes stay, as one step.
The scope is the session, or the agent id when the client sends one (see
[Sessions](#sessions-agent-ids-and-what-they-share)). The result is
`{undone | redone, can_undo, can_redo}`, plus a `note` naming the history when fewer steps than
asked were available.

The history is bounded per agent and project: it keeps the last 100 steps and at most 64 MB of
replaced or deleted data (the server settings `MCP_UNDO_STEPS` and `MCP_UNDO_MEMORY_MB`; the
`undo` tool's description states this server's limits). Older steps are dropped, the newest one
is always kept, and the `note` says when steps were dropped. Undo soon after a change, and rebuild
rather than undo far back.

### Import and export

#### `import_model`

Arguments: `project`, `format` (`gltf`, `glb`, `obj`, `stl`, `ply`; detected from the URL or
`name` when omitted), `data_base64` or `url` (exactly one), `name` (base name for the created
objects), `location`.

Imports a file of at most 50 MB as one undo step. URLs must be http(s); downloads time out after 60
seconds and cloud metadata addresses are refused. Y-up formats are converted to Z-up. The imported
objects become selected. The result is `{format, bytes, objects, warnings}`.

#### `export_scene`

Arguments: `project`, `format` (`glb` default, `gltf`, `obj`, `stl`, `ply`), `objects` (a subset;
default every object visible in renders), `apply_modifiers` (default true), `frame` (default: the
agent's current frame), `bake_resolution` (glTF/GLB: the size in pixels, 64–4096, of the square
images procedural textures are baked into, for every bake; default: per mesh, see below).

Exports the scene evaluated at `frame`, on a render thread, so a long export does not hold up the
server (a glTF export samples every frame of the scene range, which takes seconds for long ranges
and large scenes). The content is the JSON
`{format, filename, mime, bytes, frame, objects, apply_modifiers, download_url, elapsed_ms, warnings}`
(`objects` lists the requested object names, or is `"all"`; `bake_resolution` is added when it was
given), the file as an embedded base64 `resource` (up to 20 MiB) and a `resource_link` to
`download_url`. **Check `warnings`**: they list what the format could not represent.

`download_url` is `GET /api/projects/<id>/export` with the same options as query parameters
(`format` and `frame`, plus `objects` when a subset was exported, `apply_modifiers=false` when
modifiers were not applied and `bake_resolution` when it was given; see
[REST endpoints](#rest-endpoints)). It exports again when it is fetched: the same file as the
embedded one while the scene is unchanged, the project's current state after later edits.

What the formats contain:

- **OBJ, STL, PLY**: world-space meshes after modifiers. OBJ is Y-up with normals, UVs and
  `usemtl` material groups; STL is binary and triangulated; PLY is binary with UVs and vertex
  colours when present. Particle and collection instances are included.
- **glTF / GLB** <!-- re-check: gltf-export (matched packages/core/src/io/gltf-export.ts on
  2026-11-07) -->: the object hierarchy (armature bones as nodes, bone-parented objects under
  their bone), meshes with one primitive per material, principled materials (with
  `KHR_materials_emissive_strength`, `_transmission`, `_ior`, `_clearcoat` and `_sheen`), cameras,
  lights (`KHR_lights_punctual`; area lights become point lights, with a warning), and particle and
  collection instances as nodes sharing their source's mesh.
  - **Animation** is sampled once per frame over the scene frame range (at most 10000 frames):
    node transforms wherever an object or bone moves, whatever moves it (keyframes, drivers,
    constraints, IK, rigid bodies). Where an object's motion curves between frames (a fast orbit),
    it gets 2 or 4 keys per frame in those frame intervals; motion that is straight between frames
    (LINEAR keys, rigid bodies) keeps one key per frame. A warning names a node whose sub-frame
    samples still deviate by more than 0.5 mm (or 0.1 % of its path's extent), or says when the
    budget of 3000 sub-frame scene evaluations ran out.
  - **Deformation**: shape keys become morph targets; a mesh deformed only by an Armature modifier
    becomes a glTF skin (at most 4 bone influences per vertex; with `apply_modifiers: false`, a
    mesh whose first Armature modifier uses an exported armature, without its other modifiers);
    other changing deformation is baked into morph targets, at most about 12 million floats of
    them (counted per written vertex), keeping every n-th frame beyond that, with a warning.
  - **Procedural textures** are baked into PNG images sized per mesh at about 64 texels per metre of
    surface (512–2048 px, powers of two; a UV-mapped bake shared by several meshes is sized for the
    largest), all automatic bakes within a budget of 3 × 2048² texels (but none below 512 px).
    `bake_resolution` sets one size for every bake, without the budget: raise it for large objects
    that look blurry, lower it for scenes with many baked meshes, whose files can otherwise be
    large. A material whose bake depends on the mesh (GENERATED or OBJECT mapping, bump) is written
    once per distinct mesh, named `Name`, `Name.001` … (images follow), with a warning. A mesh
    without UVs, or with overlapping UVs, gets generated UVs (Smart UV Project) for its
    GENERATED/OBJECT-mapped textures, with a warning; when image textures or UV-mapped procedurals
    need its own UVs, those are kept and a warning says the bake is wrong where faces overlap. Image
    textures on a mesh without UVs are dropped, with a warning.
  - **Not exported**: the sky, mist, the world, drivers and constraints themselves, and animated
    camera, light, material and world properties (a warning names them; the file keeps their values
    at the export frame; a value held by two equal BEZIER keys can be reported too, from rounding);
    camera lens shift is dropped with a warning.

### Rendering

Two tools render, on the server's render threads (off the event loop that serves editors and
agents) or, for `render_image`, in a connected browser editor. `run_operator`, `batch` and
`edit_mesh` refuse the core render operators `render.render_software` and `render.render_animation`
(`FAILED`, naming these tools) and the browser editor's `render.render`, which opens its Render
window (`NOT_FOUND`, as all its UI operators).

#### Engines and routing

- `RASTER`: a fast rasterizer for checking layout, materials and animation, with the scene's view
  transform and exposure and Film > Transparent. The server's software rasterizer draws no
  shadows, and its glossy reflections come from one small reflection probe in front of what the
  image centre shows, looked up by direction only: water, floors and large glossy tables far from
  that point can show reflections the path tracer does not (a wide smear of a nearby object, a far
  end that is too bright). A browser editor renders with WebGL in its Rendered shading (scene
  lights with shadow maps). Neither rasterizer lights other surfaces with emissive meshes. Judge
  shadows, reflections and mesh lights with `PATHTRACER`.
- `PATHTRACER`: the CPU path tracer (principled BSDF, soft shadows, global illumination,
  reflections, glass, sky, mist, depth of field, procedural textures, instances, view transforms)
  for final images. It renders in parallel on all render threads. Lamps are not visible to the
  camera directly (only in reflections); use emissive materials for visible light sources. Light
  passes glass as through a thin sheet (tinted and dimmed, never focused), so lamps inside
  lanterns and bulbs light their surroundings, but glass casts no caustics. It has no volumes,
  subsurface scattering or motion blur.
- `shading: "SOLID"` (grey clay) always rasterizes. Without `shading`, or with `MATERIAL`, renders
  show materials, scene lights and the world, in a browser editor too (its final-render look, not
  the viewport's Material Preview).

<!-- re-check: browser raster shading (apps/web/src/editor/rpc.ts rpcRenderShading,
viewport/engine.ts renderPixels) matched the code on 2026-11-07 -->

`engine` defaults to the scene's render engine (`set_scene_settings {engine}`), whichever renderer
is used. `render_image` chooses where to render with `renderer`:

| `renderer`       | `RASTER`                                                                           | `PATHTRACER`                                                                     |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `auto` (default) | A connected browser editor (WebGL, Rendered shading), else the server's rasterizer | The server's path tracer                                                         |
| `browser`        | A browser editor only (`client` picks one); an error when none is connected        | That editor's render workers (Web Workers); the samples reached are not reported |
| `software`       | The server's rasterizer                                                            | The server's path tracer                                                         |

How long the server waits for an editor's image: with `auto`, 15 s for a raster image; with
`browser`, 55 s for a raster image (an editor without GPU acceleration, software WebGL as in a
headless browser, can take tens of seconds for a heavy scene) and `time_limit` + 30 s for a path
trace (loading, compiling, denoising and the PNG). 55 s is less than the 60 s that MCP clients built
on the TypeScript SDK wait for a request by default, so the server's error, which says what to do,
arrives before such a client gives up with "Request timed out"; a path trace that takes longer sends
progress notifications (below), and the client needs a longer request timeout or one that it resets
on progress.

If a browser render fails or times out, `auto` renders on the server instead and says why in `note`,
and `browser` fails with what to do (a path trace: lower `time_limit` or the size, or path trace on
the server). The editor does not stop drawing an image the server stopped waiting for, and until it
has finished, its next renders and commands wait behind it. Meanwhile `render_image` sends renders
to another connected editor that is not busy (without `client`), else `auto` renders on the server
without asking the busy editor (its `note` says so), and the errors of `browser` renders and
`editor_command` name the earlier request the editor was still busy with ("it was still busy with an
earlier request that the server had stopped waiting for: a RASTER render sent 16 s ago"). A path
trace runs on the editor's render workers and does not hold up its other requests. An editor that
answered its last raster image (of the same shading: `SOLID` is judged apart) after the server had
stopped waiting, or took longer than the 15 s `auto` waits, is not asked by `auto` for 2 minutes
after that image either, so that `auto` does not wait 15 s in vain for each render of an editor that
stays that slow: in software WebGL a raster image can take longer than `auto` waits (in a headless
editor at the default 800×450, the first image of a 71-material scene took 21.9–29.9 s while it
compiled the materials, and the next ones 3.7–7.4 s; images of 4 million triangles took 4.5–13.3 s).
A faster answer (`renderer: "browser"`, which waits longer) makes `auto` use the editor again at
once. The notes and the error of a raster image that timed out (one line each):

```text
note:  browser render failed: the editor did not finish the RASTER image within 15 s (renderer 'auto'
       waits 15 s before it renders on the server; renderer 'browser' waits 55 s); it may still be
       drawing it, and until it has, renderer 'auto' renders on the server without asking it
note:  the browser editor is still busy with an earlier request that the server stopped waiting for
       (a RASTER render sent 3 s ago): renderer 'auto' renders on the server until it has finished
note:  the browser editor answered its last RASTER image after 21 s, when the server had stopped
       waiting for it: renderer 'auto' renders on the server and asks that editor again 120 s after
       that image; renderer 'browser' waits up to 55 s
error: browser render failed: the editor did not finish the RASTER image within 55 s. It may still
       be drawing it, and its next renders and commands wait until it has. A heavy scene takes tens
       of seconds in an editor without GPU acceleration (software WebGL, e.g. a headless browser):
       render on the server with renderer 'software' (or 'auto'), render a smaller image, or pass
       shading 'SOLID' (grey clay, faster).
```

A `SOLID` render that times out is not told to use `SOLID`: its error ends with "render on the
server with renderer 'software' (or 'auto') or render a smaller image."

While a `browser` render waits, the tool sends a progress notification every 5 s to requests with
a progress token, until the image arrives or the wait ends (for a path trace, `progress` counts the
seconds up to `time_limit` and then stays there while the editor finishes), so clients that reset
their request timeout on progress keep waiting. The web editor's own Render Image (F12) and Render
Animation (Ctrl+F12) windows path trace on the same Web Workers. `render_animation` always renders
on the server.

The server's render threads: `RENDER_WORKERS` (default: CPU cores, at most 8; `0` renders on the
main thread) plus one thread for raster stills and exports, which never wait for long renders.
Long renders (path-traced stills and all animations) use every render thread; at most two run at
once, sharing the threads, and further ones wait their turn. On Linux the render threads run at a
lower CPU priority (`RENDER_WORKER_NICE`, default 10), so the server keeps answering while they
work.

#### `render_image`

| Argument      | Default                             | Meaning                                                                                                                                                                                                                                                              |
| ------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `width`       | 800                                 | 16–2048 pixels                                                                                                                                                                                                                                                       |
| `height`      | from the render resolution's aspect | 16–2048 pixels; images path traced on the server may have at most 2,621,440 pixels (2048×1280)                                                                                                                                                                       |
| `camera`      | the scene camera                    | A camera object (id or name)                                                                                                                                                                                                                                         |
| `view`        | –                                   | A viewpoint without a camera: `position`, `target`, `up` (default `[0, 0, 1]`), and `fov_degrees` (**vertical** field of view, default 50) or `lens` (mm, as a Blender camera with a 36 mm sensor across the image's longer side: 50 mm ≈ 39.6° across it), not both |
| `engine`      | the scene's engine                  | `RASTER` or `PATHTRACER`                                                                                                                                                                                                                                             |
| `samples`     | render settings (64)                | `PATHTRACER`: samples per pixel (1–4096); `RASTER`: anti-aliasing supersampling 1, 2 or 4 (default 2)                                                                                                                                                                |
| `max_bounces` | render settings (4)                 | `PATHTRACER`: light bounces of any kind (0–64; 0 = direct light only)                                                                                                                                                                                                |
| `denoise`     | render settings (on)                | `PATHTRACER`: denoise the result                                                                                                                                                                                                                                     |
| `time_limit`  | 30                                  | `PATHTRACER`: wall-clock seconds (0.1–600); sampling stops when they are used up, after at least one sample per pixel                                                                                                                                                |
| `seed`        | 0                                   | `PATHTRACER`: noise pattern; the same seed and settings give the same image                                                                                                                                                                                          |
| `frame`       | the agent's frame                   | Frame to render                                                                                                                                                                                                                                                      |
| `renderer`    | `auto`                              | See the routing table                                                                                                                                                                                                                                                |
| `shading`     | materials and lights                | `MATERIAL` or `SOLID` (see [Engines and routing](#engines-and-routing) for browser renders)                                                                                                                                                                          |
| `client`      | most recently active editor         | Browser editor connection id or client name                                                                                                                                                                                                                          |

The horizontal field of view of a landscape image is wider than `fov_degrees`:
`hfov = 2·atan(tan(fov/2)·width/height)`. Without a camera and a `view`, the server renders an
automatic 3/4 view of all objects; a browser editor uses its viewport.

The result is a PNG `image` followed by a JSON text: `renderer` (`browser` or `software`),
`engine`, `width`, `height`, `frame`, `elapsed_ms`; for server renders `threads`, and for path
tracing `samples` (reached) and `requested_samples`, with `time_limit_reached: true` and a `hint`
when the time limit stopped sampling early; `warnings` (e.g. textures that could not be used, or
degenerate triangles that were skipped, with the objects they belong to), `note` (why the browser
was not used) and `note_engine` (when `SOLID` shading rasterized a `PATHTRACER` request). Browser
renders add `client` and `connection`; path traced ones `requested_samples`, `time_limit` and
`note_samples` (the editor does not report the samples it reached).

#### `render_animation`

| Argument                                                         | Default                                | Meaning                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`                                                         | `CONTACT_SHEET`                        | `CONTACT_SHEET` (one PNG with every frame in a labelled grid), `GIF` (256 colours), `APNG` (lossless, returned as `image/png`), `PNG_SEQUENCE` (one PNG per frame) |
| `frame_start`, `frame_end`, `frame_step`                         | the scene range, step 1                | Rendered frames; at most 1000 per call                                                                                                                             |
| `width`, `height`                                                | render resolution scaled to fit 480 px | Frame size (max 2048 per side; one side keeps the render aspect). Contact sheet tiles default to at most 240 px, smaller for many frames                           |
| `camera`                                                         | the scene camera                       | Without one: a fixed automatic view framing all rendered frames, returned as `view`                                                                                |
| `engine`, `shading`, `samples`, `max_bounces`, `denoise`, `seed` | as `render_image`                      | Shared by every frame                                                                                                                                              |
| `animated_seed`                                                  | false                                  | `PATHTRACER`: change the noise pattern every frame (steadier, smaller files when false)                                                                            |
| `time_limit`                                                     | 60                                     | Wall-clock seconds for the whole render (1–600)                                                                                                                    |
| `frame_time_limit`                                               | a share of `time_limit`                | `PATHTRACER`: at most this many seconds of sampling per frame (0.1–600)                                                                                            |
| `fps`                                                            | scene fps / `frame_step` (real time)   | GIF / APNG playback rate                                                                                                                                           |
| `loop`                                                           | 0 (forever)                            | GIF / APNG play count                                                                                                                                              |
| `dither`, `colors`                                               | `FLOYD_STEINBERG`, 256                 | GIF dithering (`FLOYD_STEINBERG`, `BAYER` (ordered, stable between frames), `NONE`) and palette size                                                               |
| `columns`                                                        | a roughly square sheet                 | Contact sheet tiles per row                                                                                                                                        |
| `store`                                                          | false                                  | Keep the files on the server for an hour and return download links                                                                                                 |

Frames render in parallel, one per render thread (`parallelism: "FRAMES"`). When a path-traced
animation has fewer frames than there are render threads, its frames render one after the other,
each path traced by all threads (`parallelism: "BANDS"`). Rigid body simulation runs once per
render and is shared by the threads.

**Time budget.** Each path-traced frame gets an equal share of the remaining `time_limit` (capped
by `frame_time_limit`) and stops sampling when it runs out; frames that cannot start before the
budget is used up are dropped. The result then has `truncated: true`, `time_limit_reached: true`
and a `hint`; `undersampled_frames` lists frames that got fewer samples than requested, and
`frame_samples` the samples each frame reached.

**Content.** For `CONTACT_SHEET`, `GIF` and `APNG`: the `image`, then the JSON text. For
`PNG_SEQUENCE`: the JSON text, then one embedded `resource` per frame (`image/png`, URIs ending in
`frame_0001.png` …). With `store: true`, or automatically when the files total more than 20 MiB
(they are then not embedded), the files are kept on the server and the result adds `download_urls`
and `resource_link` entries (up to 50) under `/api/projects/<id>/renders/<render>/<file>`.

The JSON text: `format`, `engine`, `mime`, `width` and `height` (of one frame), `fps`, `frames`
(rendered frame numbers), `frame_count`, `requested_frames`, `truncated`, `bytes`, `threads`,
`parallelism`, `elapsed_ms`; for path tracing `requested_samples`,
`samples_reached {min, mean, max}` and `frame_samples` (samples per pixel of each rendered frame,
in the order of `frames`); and when they apply `time_limit_reached`, `hint`,
`undersampled_frames`, `warnings` (each once, at most 20), `sheet {width, height, columns, rows}`,
`view {position, target, fov_degrees}` (usable as a `render_image` view), `download_urls` and
`note`.

### Live editors

#### `get_connected_clients`

Arguments: `project`. Who works on the project now: `connections` (browser editor connections with
their capabilities, e.g. `render` and `ui`) and `presence` (people and agents with `kind`, `name`,
`color`, `mode`, `selection`, `active`, `frame`; your own entry has `you: true` and, with an agent
id, `agent_id`).

#### `editor_command`

Arguments: `project`, `command`, `params`, `client` (connection id or client name; default: the
most recently active editor that accepts UI commands), `timeout_ms` (100–55000, default 10000).

Sends a UI command to a live browser editor that has the project open. The server first checks the
command and the names of its parameters (with did-you-mean suggestions and the valid names, also
when no editor is connected), then fails when no editor is connected ("No browser editor accepting
UI commands is connected … Open _editor_url_ in a browser"), and when the editor's connection to the
project closes before it answers (see `run_operator` below). Commands:

| Command               | Params                                                                                                                            | Effect                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view.frame_all`      | –                                                                                                                                 | Frame every visible object in the viewport, out of the camera view                                                                                                                                                                              |
| `view.frame_selected` | –                                                                                                                                 | Frame the editor's selection, out of the camera view: its selected objects (every visible one when none is selected), in Edit Mode the selected vertices of its active mesh (all of them when none is)                                          |
| `view.set_view`       | `view` (or `type`): `FRONT`, `BACK`, `RIGHT`, `LEFT`, `TOP`, `BOTTOM`, `CAMERA`                                                   | Align the viewport                                                                                                                                                                                                                              |
| `view.shading`        | `shading` (or `type`): `WIREFRAME`, `SOLID`, `MATERIAL`, `RENDERED`                                                               | Viewport shading                                                                                                                                                                                                                                |
| `select`              | `objects`                                                                                                                         | Set **that editor's** selection                                                                                                                                                                                                                 |
| `set_mode`            | `mode`                                                                                                                            | Switch that editor's mode (`OBJECT`, `EDIT`, `SCULPT`, `VERTEX_PAINT`)                                                                                                                                                                          |
| `set_frame`           | `frame`                                                                                                                           | Set that editor's current frame                                                                                                                                                                                                                 |
| `play`                | `playing` (default true)                                                                                                          | Start or stop playback                                                                                                                                                                                                                          |
| `notify`              | `message`                                                                                                                         | Show a message to the user                                                                                                                                                                                                                      |
| `run_operator`        | `operator`, `params`                                                                                                              | Run an operator in that editor, with its selection and its undo history (also UI-only operators)                                                                                                                                                |
| `screenshot`          | `width`, `height` (whole pixels, 16–4096; default: the viewport size), `shading` (as for `view.shading`; default: the viewport's) | A PNG of the viewport as the person sees it (returned as an image), see below                                                                                                                                                                   |
| `get_view`            | –                                                                                                                                 | The viewport's target, distance, yaw, pitch, orthographic flag and camera view state; while the viewport animates a view change (an axis view, an orbit step or framing, asked for by a command, an operator or the person) the view it ends on |

Enum values are case-insensitive. Unknown commands and misspelled parameter names are refused by the
server, and so are invalid values of `screenshot` (a `width` or `height` that is not a whole number
from 16 to 4096, an unknown `shading`: "screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or
RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?).") and values of the wrong type
for `notify` and `run_operator`; other invalid values (an unknown view, shading or mode, objects
that do not exist, a missing or non-numeric `frame`) are errors from the editor. Either way the
error says what is wrong and the editor stays as it was. The tool returns `{command, result}` with
the editor's answer: `view.set_view`, `view.shading` and `set_mode` report the view, shading or mode
the editor has afterwards, and a command the editor cannot carry out (Edit Mode without an active
mesh, the camera view without a scene camera) answers `ok: false` with the reason in `error`.
`select` answers `{selected, names}`; `[]` deselects everything.

`screenshot` shows the viewport as the person sees it: its view (the scene camera when the viewport
looks through it; during an animated view change the view it ends on), in the shading the viewport
shows, or in `shading` when given, without overlays. It is rasterized (WebGL) like the viewport,
never path traced: `MATERIAL` is Material Preview (a studio environment lights the scene, unlike the
`MATERIAL` of `render_image`, which shows the scene's lights and world), and `RENDERED` is the
Rendered viewport (the scene's lights and world, with shadows when the render settings use them),
also when the scene's render engine is `PATHTRACER`: path traced images come from `render_image`.
The first screenshot in a shading the editor has not drawn since it opened the project costs as much
as the viewport's first frame in it, and the editor keeps what it built for both (a material edit
that needs a shader no material had compiles it, see below); the viewport keeps its own shading.

`run_operator` is how agents run the operators of the browser editor's own user interface
(`view3d.*`, `wm.*`, `screen.*`, `ed.*`, `render.render` …), which the `run_operator` tool refuses
with a message that says what each one does there and names this command: `editor_command` with
`{project, command: 'run_operator', params: {operator: 'view3d.view_all', params: {}}}`. They act on
that editor and the person at it: its view, its selection, its frame and its undo history (`ed.undo`
undoes the last change there: the person's, or an operator the agent ran there with
`editor_command`, never the agent's changes made with the tools: use the `undo` tool for those),
windows on the person's screen, even the project it has open and the person's clipboard
(`wm.share`), and the interactive ones wait for the person's mouse (`object.duplicate_move`
duplicates the person's selection and leaves a move running, `view3d.transform_modal` starts one):
for edits, use the server operators and tools the refusal names (`object.duplicate {offset}`,
`transform.translate`, `create_project` …). `wm.read_homefile` creates a new project and switches
the editor to it, which closes its connection to the agent's project before it can answer, so the
tool answers with an error that says so: "editor_command 'run_operator' got no answer for
wm.read_homefile, as expected: the editor creates a new project ('Untitled') and switches to it,
which closes its connection to this project before it can answer; list_projects lists the new
project, get_connected_clients the editors that still have this one open." When the connection
closes before the answer for another reason (the page was closed or reloaded, the editor opened
another project or lost its connection, or the server closed the project), the error says so and
that whether the editor carried the command out is unknown.

`timeout_ms` is how long the server waits for the editor's answer, at most 55000 (less than the 60 s
request timeout of MCP clients built on the TypeScript SDK, so the server's error arrives first). An
editor builds and compiles the scene's materials for `MATERIAL` or `RENDERED` shading the first time
it draws that shading after it opened the project, for a screenshot or a frame of its viewport, and
keeps them for later ones. A material edit builds that material again and keeps the one it replaces
until the new one has been drawn in every shading the old one was drawn in, so the new one gets the
old one's shader when they need the same one: an edit of values (colours, roughness, the type and
settings of a procedural texture) compiles nothing, and an edit that needs a shader no material had
(coat or sheen turned on, procedural textures on a set of channels that no other material has)
compiles it for the next screenshot or frame in each of these shadings. A screenshot is drawn with
the viewport's anti-aliasing: 4× multisampling, which the viewport turns off for a scene of more
than a million drawn triangles and after a frame whose scene and overlays took more than a second to
draw (its full-screen passes, such as selection outlines, do not count, nor do frames that build
shaders or their pipelines or that a screenshot held up), until drawing them takes less than 125 ms;
a shading (with X-ray on or off) drawn before only with the other sample count is drawn with that
one. So a screenshot in a shading the editor has drawn (in `SOLID` with the same X-ray setting)
compiles nothing, unless a material edit needs a shader no material had; it costs a frame of that
shading at the screenshot's size and work of its own: it waits for the frames the GPU still draws
for the viewport, prepares the scene for its shading, reads the pixels back and encodes a PNG.
Without GPU acceleration (software WebGL, as in a headless browser) the first time takes tens of
seconds for a heavy scene, and compiling one shader seconds, more for a material with procedural
textures.

Measured in such an editor (headless Chromium with SwiftShader, a scene of 81 objects and 71
materials, 1280×720 screenshots, each case in two or more runs at load averages from 0.4 to 6.7 on 4
CPUs; the times vary with the machine's load), with the viewport in `SOLID`: the first `MATERIAL` or
`RENDERED` screenshot took 18.8–27.0 s, also when the other had been drawn before, and the next ones
0.9–1.4 s; `SOLID` and `WIREFRAME` screenshots took 0.5–1.0 s, and `render_image` with
`shading: "SOLID"` (grey clay; rendered on the server, as the scene's render engine was
`PATHTRACER`) 1.7–3.6 s. Switching the viewport to `MATERIAL` or `RENDERED` the first time took
18.5–30.6 s until its first frame was drawn; screenshots in its shading then took 0.9–2.9 s, the
first one in the other of the two 18.8–25.8 s and the next ones 1.3–2.8 s, and `SOLID` or
`WIREFRAME` ones 0.9–2.0 s. After roughness edits of the table, the dowels, the floor, the glass
marble and two plastics, the next screenshots in both shadings took 0.8–3.8 s, in either order and
with the viewport in any shading, and no shader was compiled. After edits that needed a new shader
(coat or sheen turned on for a plastic, a `NOISE` or `VORONOI` texture on a channel that no material
had textured), the viewport in `MATERIAL` or `RENDERED` had drawn the change 0.6–4.5 s after the
edit, and the first screenshot in the other of the two took 1.4–3.8 s; with the viewport in `SOLID`,
the first screenshot in each of the two took 1.0–3.8 s. Turning sheen on took 10.8–12.9 s in each of
the two shadings for the table's material, whose colour, roughness and bump are `BRICK` and `WAVE`
textures, 8.3–11.4 s for the dowels' (`WOOD` on colour and bump) and 2.1–3.2 s for the floor's
(`BRICK` on its colour). A screenshot waits until the frame the viewport is drawing is done, also a
`SOLID` or `WIREFRAME` one, so one sent while the viewport draws such a change or its first frame in
a shading takes up to that frame's time longer. X-ray changes nothing in `MATERIAL` or `RENDERED`
shading outside Edit Mode: the viewport's next frame took 0.4–1.7 s, and no shader was compiled.
With a grid of a million triangles added to the scene, the viewport drew without multisampling from
the start: its first `MATERIAL` or `RENDERED` frame took 12.3–14.8 s, and the next two screenshots
in that shading 1.2–3.3 s; after a 2600×1700 viewport had turned multisampling off, its first
`MATERIAL` frame back at 1400×860 took 12.0–15.3 s and the next two screenshots 0.4–1.3 s. A scene
of millions of triangles takes seconds per frame in any shading: with 4 million triangles and the
viewport in `SOLID` (without multisampling), a screenshot without `shading` or with
`shading: "SOLID"` took 3.3–5.2 s, a `WIREFRAME` one 4.1–11.9 s, and the first `MATERIAL` and
`RENDERED` ones 5.5–8.0 s (3.3–6.0 s later). The other commands draw nothing themselves, but wait
while the editor's main thread is busy: for 4.0–6.2 s after the viewport switched to `MATERIAL` or
`RENDERED` for the first time (while it builds the scene's materials; the rest of that frame holds
up only screenshots), for the whole of a screenshot it draws, and with 4 million triangles for each
frame it draws (a `select` took 2.5–3.8 s there, and a `get_view` sent during a `select` or a
screenshot waited until it was done: up to 6.4 s). An editor that was not busy answered a `get_view`
in milliseconds.

The editor finishes a command the server stopped waiting for, and keeps what a screenshot compiled:
a first `RENDERED` screenshot that timed out after 3 s, retried at once, answered 17.7–20.9 s later
(the rest of the first one, then a screenshot that compiled nothing), and the next one in 1.0–1.7 s.
With the default `timeout_ms` a first `MATERIAL` screenshot and its first retry timed out, and the
second retry answered in 2.1–6.3 s. After an edit that needed a new shader, `RENDERED` and
`MATERIAL` screenshots with `timeout_ms: 1000` timed out, and their retries answered in 1.0–3.0 s;
after sheen was turned on for the table's or the dowels' material, the first screenshot in a shading
with the default `timeout_ms` timed out, and its retry answered in 0.8–1.4 s. When the editor does
not answer in time the error says so and what to do (one line each):

```text
editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 10000 ms (at most
55000); it may still carry the command out, and its next commands and renders wait until it has. The
screenshot is drawn in the viewport's shading, like a frame of the viewport. An editor without GPU
acceleration (software WebGL, e.g. a headless browser) takes seconds for that with a scene of
millions of triangles in any shading (3.3–5.2 s in SOLID with 4 million) and with a heavy scene in
MATERIAL or RENDERED shading, and tens of seconds for its first screenshot or frame in one of these
two after it opened the project, while it builds and compiles the scene's materials for that
shading. After a material edit that needs a shader no material had (coat or sheen turned on, a
procedural texture on a set of channels that no other material has), its next screenshot or frame in
each of these two compiles it (0.6–4.5 s, or up to 12.9 s for a material with several procedural
textures). The times given were measured in software WebGL and vary with the machine's load. It
keeps what it compiled, so a retry waits for the editor to finish and compiles nothing again. Retry
with a larger timeout_ms (at most 55000), or pass shading 'SOLID' for the screenshot (grey clay,
much faster); for a quick look use render_image with shading 'SOLID', and render_image for final
images.

editor_command 'select' failed: the editor did not answer within timeout_ms = 10000 ms (at most
55000); it may still carry the command out, and its next commands and renders wait until it has.
'select' waits while the editor draws its viewport. An editor without GPU acceleration (software
WebGL, e.g. a headless browser) takes seconds per frame for a scene with millions of triangles, and
seconds for its first frame of a heavy scene in MATERIAL or RENDERED shading, while it builds and
compiles the scene's materials. Pass a larger timeout_ms (at most 55000), or switch the viewport to
SOLID shading (editor_command view.shading {shading: 'SOLID'}), which draws much faster.
```

A screenshot with `shading` `MATERIAL` or `RENDERED` says the same about that shading; one with
`shading` `SOLID` or `WIREFRAME` says that a scene with millions of triangles takes seconds even
then, that a screenshot waits until the frame its viewport is drawing is done, which in `MATERIAL`
or `RENDERED` shading compiles shaders the first time after the editor opened the project and after
a material edit that needs a shader no material had (0.6–4.5 s, or up to 12.9 s for a material with
several procedural textures; the times given were measured in software WebGL and vary with the
machine's load), and that a retry then compiles nothing again, and advises a retry with a larger
`timeout_ms` or `render_image` with `shading: "SOLID"` and `renderer: "software"` (grey clay,
rendered on the server without the editor, which can run out of memory for millions of triangles:
that render took 2.2–2.5 s with a grid of a million triangles added to the scene, and ran out of
memory after 17.4–21.4 s with a grid of 2 million triangles). At the maximum the advice starts with
"With timeout_ms at its maximum (55000), …" instead of a larger `timeout_ms`. When the editor was
still busy with an earlier request that the server had stopped waiting for (a screenshot or render
that timed out), the error names it after the first sentence ("It was still busy with an earlier
request that the server had stopped waiting for (editor_command 'screenshot' sent 12 s ago).").
While the tool waits, it sends a progress notification every 5 s to requests with a progress token.

### Resources

`project://{id}/scene` (JSON): the same description as `get_scene`, at the agent's frame, for each
project. `resources/list` lists one per project.

## Errors

**Tool errors** are normal tool results with `isError: true` and a text message. Most messages say
what to do. Every failure of `run_operator` and `edit_mesh`, and every `batch` call with a failure,
is uniform: the first line is the message and the rest is JSON with `ok: false`, `error` and `code`
— for `run_operator` and `edit_mesh` `{ok: false, operator, error, code, selection, …}`, also when
the `selection`, the object, an element index, the project or the operator id is the problem; for
`batch` the full result, including the operations that succeeded (see the tools above). Errors of
the tool arguments (`Input validation error: …`, checked before any tool runs) and the errors of
the other tools are plain messages. A message never spans lines: line breaks in the names it
quotes are written as `\n`, `\r` or `\u2028`, as in JSON.

| Message (abridged)                                                                                                                                                                    | Cause                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP error -32602: Input validation error: Invalid arguments for tool get_object: Invalid input: expected number, received string at frame`                                           | A tool argument of the wrong type or out of range (e.g. `time_limit` above 600)                                                                                                                                                                                                     |
| `… Invalid arguments for tool set_scene_settings: unknown argument 'sampels' (did you mean 'samples'?). Valid arguments: …`                                                           | A misspelled or unknown tool argument                                                                                                                                                                                                                                               |
| `… Invalid arguments for tool render_image: unknown key 'fov' (did you mean 'lens' or 'fov_degrees'?) (valid keys: …) at view`                                                        | A misspelled key inside a nested tool argument (`view`, `selection`, batch `operations`)                                                                                                                                                                                            |
| `… unknown argument 'name'. Valid arguments: project, operator, params, selection. Operator parameters go inside …`                                                                   | Operator parameters given as tool arguments                                                                                                                                                                                                                                         |
| `Invalid parameters for mesh.primitive_cylinder_add: unknown parameter 'raduis' (did you mean 'radius'?). Valid parameters: …`                                                        | A misspelled or unsupported operator parameter (also nested, e.g. in curve points)                                                                                                                                                                                                  |
| `Invalid parameters for object.shade_smooth: unknown parameter 'objects'. Valid parameters: (none). This operator acts on the selected objects …`                                     | A selection-based operator: pass `selection`                                                                                                                                                                                                                                        |
| `Invalid parameters for object.drop_to_ground: surface: Invalid input: expected array, received string`                                                                               | A value of the wrong type or out of range                                                                                                                                                                                                                                           |
| `mesh.subdivide failed: Operator requires Edit Mode`                                                                                                                                  | The operator's preconditions (mode, selection, object type) are not met; use `edit_mesh` for `mesh.*`                                                                                                                                                                               |
| `Unknown operator 'mesh.primitive_cylindr_add'. Did you mean: …`                                                                                                                      | A misspelled or incomplete operator id (its completions first), letter case ignored; browser UI operators among the suggestions are named as such (`NOT_FOUND`)                                                                                                                     |
| `'view3d.view_all' is an operator of the browser editor's user interface … Run it there with editor_command {project, command: 'run_operator', …}`                                    | An operator of the browser editor's UI through `run_operator` / `batch` / `edit_mesh` (`NOT_FOUND`); some name the tool or operator to use instead                                                                                                                                  |
| `'render.render_software' would render on the server's main thread … Use the render_image tool instead`                                                                               | `render.render_software` or `render.render_animation` through `run_operator` / `batch` / `edit_mesh` (`FAILED`)                                                                                                                                                                     |
| `Object 'Nope' not found in project 'P'. Objects: …`                                                                                                                                  | A wrong object reference (the message lists up to 40 names; `NOT_FOUND`)                                                                                                                                                                                                            |
| `Project 'X' not found. Known projects: …` / `Several projects are named 'X': … Pass the project id instead.`                                                                         | A wrong or ambiguous project reference                                                                                                                                                                                                                                              |
| `A project named 'Lighthouse' already exists (id …). … Project names are unique because tools find projects by name …`                                                                | `create_project` / `rename_project` with a name another project has (letter case ignored)                                                                                                                                                                                           |
| `selection.mesh selects vertices, edges or faces in Edit Mode: add mode 'EDIT' …`                                                                                                     | An element selection without `mode: "EDIT"` (`POLL_FAILED`)                                                                                                                                                                                                                         |
| `Edit mode needs an active mesh object (selection.active): 'Camera' is a CAMERA object.`                                                                                              | `mode: "EDIT"` in a `selection` without an active mesh object (`POLL_FAILED`)                                                                                                                                                                                                       |
| `face index 99 out of range (mesh has 6 faces)`                                                                                                                                       | An element index of a `selection` (`run_operator`, `edit_mesh`) that the base mesh does not have                                                                                                                                                                                    |
| `edge [0, 3]: vertices 0 and 3 are not connected by an edge of the mesh: an edge joins two vertices that follow each other in one of the faces …`                                     | An edge of a `selection` that the base mesh does not have (`POLL_FAILED`): edges join neighbours in a face of `get_mesh_data`, or are its `loose_edges`                                                                                                                             |
| `select_mode 'FACE' selects only the listed faces, so the listed verts would be ignored: …` / `all: true selects every element, so the listed faces would change nothing: …`          | Element lists that a `selection` would ignore (`POLL_FAILED`): `select_mode` `EDGE` selects only `edges`, `FACE` only `faces`; `all: true` selects everything (both together: one message); every remedy named is accepted as it is                                                 |
| `'Camera' is not a mesh object.`                                                                                                                                                      | `edit_mesh` on an object that is not a mesh (`POLL_FAILED`)                                                                                                                                                                                                                         |
| `'show_render' is not a parameter of the BEVEL modifier. Its visibility (show_render) is set after adding it, with update_modifier …`                                                 | A modifier setting given inside `params` instead of as a tool argument                                                                                                                                                                                                              |
| `Unknown parameter 'veiw' (did you mean 'view'?) for the editor command view.set_view. Its parameters: …`                                                                             | A misspelled `editor_command` command or parameter (refused before anything is sent)                                                                                                                                                                                                |
| `screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?).`                                                     | An invalid `screenshot` value (`width` and `height` too; refused before anything is sent)                                                                                                                                                                                           |
| `editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 10000 ms (at most 55000); …`                                                                       | The editor needed longer: retry with a larger `timeout_ms` (the editor keeps the materials it compiled) or take the screenshot with `shading: "SOLID"`; a quick look: `render_image {shading: "SOLID"}`; final images: `render_image`                                               |
| `editor_command 'run_operator' got no answer for wm.read_homefile, as expected: …` / `editor_command '…' failed: the editor's connection to this project closed before it answered …` | The editor left the project before it answered: `wm.read_homefile` switched it to a new project; otherwise its page was closed or reloaded, it opened another project or lost its connection, or the server closed the project (whether it carried the command out is then unknown) |
| `browser render failed: the editor did not finish the RASTER image within 55 s. …`                                                                                                    | `render_image` with `renderer: "browser"` on a heavy scene: render on the server, smaller or `SOLID`                                                                                                                                                                                |
| `'dimensions' is not animatable on object. Animatable: …`                                                                                                                             | `insert_keyframe` on a property that cannot be keyed                                                                                                                                                                                                                                |
| `'constraints["Nope"].influence' does not exist on object 'Cube': constraints has no "Nope" (it is empty).`                                                                           | `insert_keyframe` on a path that does not resolve                                                                                                                                                                                                                                   |
| `A path traced image of 2048×2048 is too large (at most 2621440 pixels, e.g. 2048×1280): render smaller`                                                                              | Render limits                                                                                                                                                                                                                                                                       |
| `Too many frames (5000, at most 1000): shorten the range or raise frame_step.`                                                                                                        | `render_animation` limits                                                                                                                                                                                                                                                           |
| `Rendering was cancelled.`                                                                                                                                                            | The request was cancelled or the client disconnected                                                                                                                                                                                                                                |
| `<tool> failed: <message>`                                                                                                                                                            | An unexpected server error (also logged)                                                                                                                                                                                                                                            |

The `code` of `run_operator`, `edit_mesh` and `batch` failures is one of the kinds of the core
operator registry, decided by the kind of error, never by the wording of its message:

| `code`           | Meaning                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INVALID_PARAMS` | Unknown, misspelled or invalid parameters: fix `params`                                                                                                                                                                                                                                                                        |
| `POLL_FAILED`    | Wrong mode, selection or object type (`edit_mesh` on an object that is not a mesh), or a `selection` that cannot be applied: Edit Mode without an active mesh, `mesh` without Edit Mode, an element index out of range, an edge the mesh does not have, a list that `select_mode` does not select from, `all: true` with lists |
| `NOT_FOUND`      | An unknown project, object, datablock or operator id (with the closest ids); an operator of the browser editor's UI, `render.render` included (the message says how to run it with `editor_command`, and what to use instead where the tools offer it)                                                                         |
| `FAILED`         | The operator itself failed, it is refused here (`render.render_software`, `render.render_animation`: use the rendering tools instead), or another failure (the message says why)                                                                                                                                               |

An operator can also **succeed with problems**: check `reports` (WARNING / ERROR), `errors` lists in
results (`object.constraint_add`, `object.track_set`, particle systems, `anim.driver_add` per
driver) and the `problems` list of `get_scene`.

**Protocol errors** come back as JSON-RPC errors with an HTTP status:

| HTTP | JSON-RPC code | Message                                                  | When                                                                               |
| ---- | ------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 400  | -32000        | `Bad Request: No valid session ID provided`              | A non-`initialize` POST without `Mcp-Session-Id`                                   |
| 400  | -32000        | `Missing Mcp-Session-Id header`                          | `GET` or `DELETE` without a session id                                             |
| 400  | -32602        | `agent id must be 1-128 characters: …`                   | A malformed `x-mcp-agent-id` / `?agent=`                                           |
| 401  | –             | `unauthorized: provide the access token as …`            | Missing or wrong token                                                             |
| 404  | -32001        | `Session not found`                                      | Unknown or expired session (idle for 30 minutes, server restart): initialize again |
| 503  | -32000        | `Too many open MCP sessions` / `server is shutting down` | 1000 open sessions / shutdown                                                      |
| 500  | -32603        | `Internal server error`                                  | An unexpected transport failure                                                    |

## Limits

| What                                       | Limit                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request body                               | 100 MB (enough for a base64-encoded 50 MB import)                                                                                                                                  |
| Open MCP sessions                          | 1000                                                                                                                                                                               |
| Session idle timeout / avatar hidden after | 30 minutes / 5 minutes                                                                                                                                                             |
| Agent identities                           | 200, each kept 6 hours after its last session                                                                                                                                      |
| `batch`                                    | 200 operations per call                                                                                                                                                            |
| `undo` / `redo`                            | 100 steps per call                                                                                                                                                                 |
| `get_scene`                                | `max_objects` up to 5000 (default 300); `problems` up to 40                                                                                                                        |
| `get_mesh_data`                            | 20000 vertices and faces per page (default 2000); heightmap up to 256 samples per side                                                                                             |
| `get_instances`                            | 5000 instances per page (default 1000)                                                                                                                                             |
| Undo history                               | 100 steps and 64 MB of replaced or deleted data per agent and project (`MCP_UNDO_STEPS`, `MCP_UNDO_MEMORY_MB`); older steps are dropped                                            |
| `list_operators`                           | Parameter schemas when a filter matches at most 60 operators (or `include_parameters: true`)                                                                                       |
| `render_image`                             | 16–2048 per side; path tracing on the server at most 2,621,440 pixels; `time_limit` up to 600 s (default 30)                                                                       |
| Browser renders                            | Raster: 55 s with `renderer: "browser"`, 15 s with `auto` (then the server renders); path tracing: `time_limit` + 30 s                                                             |
| `render_animation`                         | 1000 frames, 2048 px per side, `time_limit` up to 600 s (default 60); GIFs and contact sheets at most 33,554,432 pixels over all frames; a contact sheet at most 16,777,216 pixels |
| Concurrent long renders                    | 2 path-traced stills or animations at once (more wait their turn; raster stills have a thread of their own)                                                                        |
| Embedded files                             | 20 MiB (`export_scene`, `render_animation`); larger animations are stored and linked                                                                                               |
| Stored renders                             | 1 hour, 256 MiB in all (oldest dropped first); kept in memory                                                                                                                      |
| `import_model`                             | 50 MB; URL downloads time out after 60 s                                                                                                                                           |
| `editor_command`                           | `timeout_ms` 100–55000 (default 10000); screenshots 16–4096 px per side                                                                                                            |

## REST endpoints

The same server offers plain HTTP endpoints under `/api` (protected by `AUTH_TOKEN`, not by
`MCP_TOKEN`). Those relevant to agents:

| Endpoint                                      | Purpose                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`                           | `{projects: [...]}`                                                                                                                         |
| `POST /api/projects`                          | Body `{name, empty}`; 201 `{id, name}`; 409 `{error, id, ids}` for a taken name; without `name` the first free `Untitled`, `Untitled.001` … |
| `GET` / `PATCH` / `DELETE /api/projects/:id`  | Details (with `persistence`) / rename (`{name}`; 409 for a name another project has) / delete (204)                                         |
| `GET /api/projects/:id/snapshot`              | The document as JSON                                                                                                                        |
| `GET /api/projects/:id/export?format=glb`     | An export (`glb`, `gltf`, `obj`, `stl`, `ply`); see below                                                                                   |
| `GET /api/projects/:id/render.png`            | Renders a PNG on the server                                                                                                                 |
| `GET /api/projects/:id/renders/:render`       | `{id, files: [{name, mime, bytes}]}` of a stored render                                                                                     |
| `GET /api/projects/:id/renders/:render/:file` | A stored render file (kept for an hour)                                                                                                     |

Project names are unique ignoring letter case, as for the MCP tools: `POST` and `PATCH` answer 409
with the error, the holder's `id` and all matching `ids` when another project has the name.

`export` takes the query parameters `format` (default `glb`), `objects` (comma-separated object
ids or names; default every object visible in renders; an unknown one is a 400 error),
`apply_modifiers` (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`; default true), `frame`
(default: the scene's `frame_start`) and `bake_resolution` (glTF: 64–4096 px for every procedural
texture bake; default per mesh, as for `export_scene`), and answers with the file as an attachment
and the header `x-export-time-ms`. It exports on a render thread; 499 when the client went away,
503 when the server stopped the export. The `download_url` of `export_scene` uses these
parameters.

`render.png` takes the query parameters `width` (16–2048, default 800), `height` (default from the
render aspect), `camera` (name or id), `frame` (default: the scene's `frame_start`), `engine`,
`shading`, `samples`, `max_bounces`, `denoise` (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`),
`time_limit` (seconds, default 30 for `PATHTRACER`) and `seed`, with the same meaning as for
`render_image` (there is no `view`). It always renders on the server and answers with the headers
`x-render-engine`, `x-render-threads`, `x-render-time-ms` and, for path tracing,
`x-render-samples`.

Errors: 400 for invalid parameters, an unknown camera or a path-traced image that is too large; 404
for an unknown project; 409 for a project name another project has; 499 when the client went
away during a render or export; 503 when the server stopped it or the storage is unavailable; 501
when a format or engine is not available in the build; 500 for other failures.

## `scripts/mcp.mjs` (CLI and module)

A small Streamable HTTP client in the repository, built on the MCP TypeScript SDK.

Environment:

| Variable       | Default                     | Meaning                                                                                                                                                                                                           |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_URL`      | `http://127.0.0.1:8080/mcp` | Endpoint                                                                                                                                                                                                          |
| `MCP_TOKEN`    | –                           | Bearer token to send (the server's `AUTH_TOKEN` or its `MCP_TOKEN`)                                                                                                                                               |
| `MCP_AGENT_ID` | CLI: `cli-<hash>`           | Agent id sent as `x-mcp-agent-id`. The CLI default is one id per user, host and working directory (12 hex digits of a SHA-256), so successive CLI calls share one undo history; set it to keep separate histories |

CLI:

```bash
node scripts/mcp.mjs tools [filter] [--json]             # tool names and first sentences; with a filter, each matching tool in full
node scripts/mcp.mjs ops [search]                        # list_operators (with a search string)
node scripts/mcp.mjs call <tool> ['<json args>'] [--out file] [--out-dir dir]
node scripts/mcp.mjs batch <calls.json> [--out-dir dir]  # [{ "tool": "...", "args": {...} }, ...]
```

- `tools` without a filter prints each tool's name and the first sentence of its description; with
  a filter (a tool name or part of one), each matching tool's full description and its arguments
  with types, ranges, defaults and nested fields; `--json` prints their input schemas instead.
- `call` prints `{saved, result, elapsed_ms}`; images and embedded files in `result` are replaced by
  their base64 sizes. `--out` writes the first image or embedded file, `--out-dir` every image and
  embedded file (named by their URIs: `frame_0001.png`, exports by file name, images as
  `image_1.png` …).
- `batch` runs the calls in order in one session, printing a line per call; `--out-dir` saves the
  files of call _i_ into `dir/i/`. A failing call stops the batch.
- Progress notifications are printed to stderr. Tool errors print `tool error: <message>` and exit
  with code 1; usage errors exit with 2. Every run closes its session with an HTTP `DELETE`.

Module:

```js
import { connect } from './scripts/mcp.mjs';

const mcp = await connect(); // MCP_URL, MCP_TOKEN and MCP_AGENT_ID from the environment
// or: await connect('http://host:8080/mcp', token, { agentId: 'my-build' })
const scene = await mcp.call('get_scene', { project: 'Demo' });
const shot = await mcp.call(
  'render_image',
  { project: 'Demo', width: 640 },
  { onProgress: (p) => console.log(p) },
);
await mcp.close(); // ends the session (HTTP DELETE)
```

`call` returns the parsed JSON of a text result. Results with files return
`{text, images: [{mimeType, data}], resources: [{uri, mimeType, blob}], links: [{uri, name, mimeType}]}`
(`text` parsed when it is JSON; `data` and `blob` are base64). Tool errors throw `McpToolError`
with the error text. Calls time out after 15 minutes, reset by every progress notification.
Without an `agentId` (option or `MCP_AGENT_ID`), a module connection has its own history.

## Example session

```text
 1. create_project     { "name": "Low-poly island", "empty": true }
 2. run_operator       { "project": "Low-poly island", "operator": "object.generate_terrain",
                         "params": { "name": "Island", "size": 40, "height": 4, "island_falloff": 1, "seed": 3 } }
 3. add_object         { "project": "Low-poly island", "type": "plane", "name": "Sea",
                         "params": { "size": 200 }, "location": [0, 0, 0.4] }
 4. run_operator       { "project": "Low-poly island", "operator": "material.preset_apply",
                         "params": { "preset": "water", "objects": ["Sea"] } }
 5. add_object         { "project": "Low-poly island", "type": "camera", "name": "Camera",
                         "location": [30, -30, 14] }
 6. run_operator       { "project": "Low-poly island", "operator": "object.track_set",
                         "params": { "type": "TRACKTO", "target": "Island", "objects": ["Camera"] } }
 7. set_scene_settings { "project": "Low-poly island", "sky_preset": "SUNSET", "sun_rotation": 3.9,
                         "frame_end": 48 }
 8. insert_keyframe    { "project": "Low-poly island", "object": "Camera", "property": "location", "frame": 1 }
 9. insert_keyframe    { "project": "Low-poly island", "object": "Camera", "property": "location",
                         "frame": 48, "value": [36, -20, 10] }
10. get_scene          { "project": "Low-poly island", "max_objects": 10 }        → check "problems"
11. render_image       { "project": "Low-poly island", "width": 640, "engine": "RASTER" }
12. render_animation   { "project": "Low-poly island", "format": "CONTACT_SHEET", "engine": "RASTER",
                         "frame_step": 4 }                                       → 12 labelled tiles
13. render_image       { "project": "Low-poly island", "width": 1280, "height": 720,
                         "engine": "PATHTRACER", "samples": 128, "denoise": true, "time_limit": 120 }
14. export_scene       { "project": "Low-poly island", "format": "glb" }          → check "warnings"
```

The camera adds itself as the scene camera (there was none), keeps aiming at the island through
the Track To constraint, and moves between the keys of steps 8 (the current location) and 9.
Complete builds are in `examples/`; see the [agent guide](agent-guide.md#example-projects).
