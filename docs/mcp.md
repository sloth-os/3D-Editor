# Controlling the editor with AI agents (MCP)

The server exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`.
Through it an agent can create and inspect projects, run any of the editor's operators, edit
meshes, curves, text, materials, modifiers, constraints, rigs, physics and animation, import and
export files, and render stills and animations on the server. Every change syncs live to all
editors that have the project open. The agent shows up there as a peer named "AI agent (_client
name_)", with its own selection.

This page is the reference for the endpoint, its 35 tools, the related REST endpoints and the
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
  work),
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
for animations, and the elapsed seconds every 5 s while a browser editor path traces (until
`time_limit` has passed). Clients should reset their request timeout on progress
(`scripts/mcp.mjs` does, with a 15-minute timeout).

## Conventions

- Right-handed, **Z up**, lengths in **metres**. As in Blender, the front view looks along +Y, so
  the "front" of generated objects faces −Y.
- Rotations are Euler XYZ in **radians** (`rotation_euler`; the rotation matrix is Rz·Ry·Rx, as in
  Blender). `add_object`, `create_mesh` and `transform_object` also accept `rotation_degrees`.
- Colours are **linear** RGB or RGBA, components 0..1. Convert sRGB values (colour pickers, hex
  codes) first.
- Objects, materials and projects are referenced by id or exact name. Names are unique per kind; a
  taken name gets a suffix (`Cube.001`), so use the name a result returns.
- Operators and their parameters use Blender's ids and names (`mesh.primitive_cube_add`,
  `object.modifier_add`, `bevel_depth`, `energy`); data paths use Blender syntax
  (`pose.bones["Arm"].rotation_euler`, `constraints["Track To"].influence`).
- **Strict names.** Unknown or misspelled names are rejected with did-you-mean suggestions and the
  list of valid names.
  - **Tool arguments** are checked before a tool runs, for names as well as types and ranges, at
    the top level and inside `view`, `selection` (and its `mesh`) and the `operations` of `batch`,
    so a rejected call changes nothing: `set_scene_settings {"sampels": 5}` fails with "Input
    validation error: Invalid arguments for tool set_scene_settings: unknown argument 'sampels'
    (did you mean 'samples'?). Valid arguments: …". A key that belongs inside a nested argument is
    pointed there (`'position' goes inside 'view'`). For a key that is no typo of a valid
    argument, the tools that take `params` add a hint that operator, modifier or command
    parameters belong there, and `set_material`, `insert_keyframe` and `set_scene_settings` name
    the operators for settings they do not take. The input schemas in `tools/list` are closed
    (`additionalProperties: false`).
  - **Operator and modifier parameters** (the `params` of `run_operator`, `batch`, `edit_mesh`,
    `add_object` and the modifier tools) are checked by the operator registry, at every nesting
    level, before the operator runs; in a `batch`, the operations before a rejected one stay
    applied. Operator JSON schemas carry `additionalProperties: false`.
- **Evaluated and stored values.** `get_scene` and `get_object` report values at a frame after
  keyframes, drivers, F-curve modifiers, constraints and physics, like Blender's properties
  editor. Where animation overrides the value stored in the document, the stored value is listed
  next to it: `stored` (transforms; light, camera and curve data), `stored_value` (shape keys),
  `stored_influence` (constraints) and `stored_params` (constraint and modifier parameters). Tools
  such as `transform_object` and the `*.properties_set` operators change stored values, which
  keyframes and drivers then override.
- **Frames.** Tools that evaluate the scene (`get_scene`, `get_object`, `get_mesh_data`,
  `render_image`, `export_scene`) use the agent's current frame unless they get a `frame`. It is 1
  in a new session and changes with `set_scene_settings {frame_current}` or the `scene.frame_set`
  operator.

## Tools

| Area             | Tools                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Projects         | `list_projects`, `create_project`, `get_project`, `rename_project`, `delete_project`                |
| Inspection       | `get_scene`, `get_object`, `get_mesh_data`, `list_operators`, `list_modifier_types`                 |
| Any operator     | `run_operator`, `batch`                                                                             |
| Objects          | `add_object`, `create_mesh`, `transform_object`, `delete_objects`, `duplicate_object`, `set_parent` |
| Materials        | `set_material`                                                                                      |
| Modifiers        | `add_modifier`, `update_modifier`, `remove_modifier`, `apply_modifier`                              |
| Mesh editing     | `edit_mesh`                                                                                         |
| Animation, scene | `insert_keyframe`, `set_scene_settings`, `set_active_camera`                                        |
| History          | `undo`, `redo`                                                                                      |
| Files            | `import_model`, `export_scene`                                                                      |
| Rendering        | `render_image`, `render_animation`                                                                  |
| Live editors     | `get_connected_clients`, `editor_command`                                                           |

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

Arguments: `project`, `frame` (default: the agent's frame), `max_objects` (1–5000, default 300).

Describes the whole scene at one frame with evaluated values (see
[Conventions](#conventions)):

- `frame`, `units` (`{up_axis: "Z", length: "meters", angles: "radians"}`), `active_camera`.
- `counts`: `objects`, `by_type`, `vertices` / `faces` (the **base** meshes of mesh objects, before
  modifiers; curves and text not included), `evaluated {vertices, faces, triangles}` (what renders
  show: after shape keys, modifiers with their render settings such as SUBSURF `render_levels`,
  SCREW `render_steps` and `show_render`, curve bevels and text, without instances),
  `evaluated_viewport` (the same with the viewport settings, listed only when the viewport shows
  other geometry), `materials`, `instances` and `instance_triangles` (particle and collection
  instances in renders), `viewport_instances` (when the viewport shows fewer), `drivers`,
  `rigid_bodies`.
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

Arguments: `project`, `object`, `frame`.

Everything about one object at a frame: the `get_scene` entry in full detail, plus `world_location`
and `world_transform {location, rotation_euler, rotation_degrees, scale}` (the final world
transform after parents, constraints and physics), `children`, materials per slot with every
property, the modifier stack with parameters (`stored_params` where animated), constraints with
parameters and errors, particle systems with settings, rigid body settings, drivers with
variables, `animation` (F-curves with up to 100 keyframes each, extrapolation and F-curve
modifiers, including the object's data), custom properties, display and visibility flags.

Type-specific detail: curves list every shape setting (`fill_mode`, bevel, `bevel_factor`,
extrude, offset, caps, twist, resolutions, path settings) and their splines with point
coordinates, radius and tilt; text its layout; armatures every bone with rest `head`/`tail`,
`posed_head_world`/`posed_tail_world`, pose channels (with `stored`) and bone constraints; lights
and cameras include the datablock `id` and every setting, including depth of field.

#### `get_mesh_data`

Reads the geometry of a mesh, curve or text object, in pages.

| Argument                                | Default                                            | Meaning                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `include`                               | `["vertices", "faces", "face_materials"]`          | Any of `vertices`, `normals`, `faces`, `face_materials`, `face_smooth`, `face_normals`, `face_centers`, `uvs`, `loose_edges`, `vertex_groups`, `heightmap`                                                                                                                                                                     |
| `source`                                | `BASE` for meshes, `EVALUATED` for curves and text | `BASE`: the stored mesh, whose indices `edit_mesh`, vertex groups and shape keys use; `EVALUATED`: after shape keys and modifiers at the frame, with the viewport settings (what `evaluated_viewport` counts); `RENDER`: with the render settings, e.g. subdivision `render_levels` (what `evaluated` counts and renders show) |
| `space`                                 | `LOCAL`                                            | `LOCAL` (object space) or `WORLD`, for positions, normals and centres                                                                                                                                                                                                                                                          |
| `vertex_offset`, `face_offset`, `limit` | 0, 0, 2000 (max 20000)                             | Paging: at most `limit` vertices and faces per call                                                                                                                                                                                                                                                                            |
| `frame`                                 | the agent's frame                                  | For evaluated and world-space data                                                                                                                                                                                                                                                                                             |
| `decimals`                              | 4                                                  | Rounding (0–6)                                                                                                                                                                                                                                                                                                                 |
| `heightmap_resolution`                  | 64 (8–256)                                         | Samples along the longer side of the object                                                                                                                                                                                                                                                                                    |

The result has `totals` (vertices, faces, triangles, loose edges), the requested fields for the
page, `material_slots` (with `face_materials`) and, when more remains, `truncated: true` and
`next {vertex_offset, face_offset}` for the next call. Faces are vertex index loops,
counter-clockwise seen from the front. `vertex_groups` (BASE only) maps each group name to the
page's weights. `heightmap` is a world-space grid of the highest surface point:
`heights[j][i]` is the height at `x = min_xy[0] + i·step[0]`, `y = min_xy[1] + j·step[1]` (`null`
where the surface does not reach), useful for placing things on terrain. The JSON is compact (no
indentation).

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

| `selection` field | Meaning                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `objects`         | Objects to select (ids or names); replaces the selection                                                                                                     |
| `active`          | The active object (default: the last of `objects`)                                                                                                           |
| `mode`            | `OBJECT` or `EDIT` (edit mode needs an active mesh object)                                                                                                   |
| `mesh`            | Edit-mode element selection: `verts`, `edges` (`[a, b]` pairs), `faces`, `all`, `select_mode` (`VERT`, `EDGE`, `FACE`; inferred from the lists when omitted) |

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

A failure is an error result: the first line is the message, followed by JSON with `ok: false`,
`error` (the message) and `code`, one of `INVALID_PARAMS`, `POLL_FAILED`, `NOT_FOUND` and `FAILED`
(see [Errors](#errors)), plus the fields above when the operator ran.

Refused operators (failures too, with the `code` named here):

- unknown ids, with up to 8 closest ids ("Did you mean: …"), `NOT_FOUND`;
- `render.render_software` and `render.render_animation`, `FAILED`: they would render on the
  server's main thread and stall every editor and agent, so `run_operator`, `batch` and
  `edit_mesh` refuse them and name the tool to use instead (`render_image`, `render_animation`);
- UI-only operators, which the web app registers for itself (none are part of the server's
  registry), `POLL_FAILED`.

#### `batch`

Arguments: `project`, `operations` (1–200 items of `{operator, params}`), `stop_on_error`
(default true).

Runs operators in order as **one undo step**: one `undo` reverts all of them. There is no
per-operation `selection`; change the selection inside the batch with `object.select`
(`{objects, active, extend}`), `object.mode_set` or `mesh.select_elements`. With `stop_on_error`
the batch stops at the first failure and keeps the changes made before it.

The result is `{ok, executed, failed, results, selection}`. Each entry of `results` is
`{operator, ok, result}` or `{operator, ok: false, error, code}` (`code` as for `run_operator`),
with `reports` when the operator reported anything. `operations_with_warnings` is added when some
operations reported a WARNING or ERROR (failed ones included) and counts them. When an operation
failed, the tool result is an error whose text starts with "_n_ of _m_ operation(s) failed"
followed by the same JSON.

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
  brief of each object (`id`, `name`, `type`, `location`, `rotation_euler`, `scale`, `parent`);
  `delete_objects` returns `{deleted, remaining}` (counts).

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
spline's `material_index`. Presets, procedural textures, coat and sheen are operators:
`material.preset_list`, `material.preset_apply`, `material.procedural_set`, `material.new`,
`material.update` (`list_operators {category: "Shading"}`).

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
  invalid values are rejected together with that schema. Object parameters (`BOOLEAN object`,
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
`all`), `select_mode` (`VERT`, `EDGE`, `FACE`; default: inferred from the lists).

Runs an edit-mode operator on one mesh object: enters Edit Mode, selects the given elements
(everything by default), runs the operator and returns to Object Mode, as one undo step. Use it
for `mesh.*` operators (`mesh.extrude_region_move {value}`, `mesh.inset`, `mesh.bevel`,
`mesh.subdivide`, `mesh.loopcut`, `mesh.delete`, `mesh.merge`, …), for `transform.translate`,
`transform.rotate` and `transform.resize` on elements, `object.material_slot_assign {index}` on a
face selection and the `uv.*` unwrap operators. Indices are those of the base mesh
(`get_mesh_data` with `source: BASE`). The result is
`{ok, operator, result, reports, mesh, selection_after}`: `mesh` statistics and the selected
element indices afterwards (at most 500 of each kind). A failure is an error result with the same
JSON plus `error` and `code`, as for `run_operator`.

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
agent's current frame).

Exports the scene evaluated at `frame`. The content is the JSON
`{format, filename, mime, bytes, frame, objects, apply_modifiers, download_url, warnings}`
(`objects` lists the requested object names, or is `"all"`), the file as an embedded base64
`resource` (up to 20 MiB) and a `resource_link` to `download_url`. **Check `warnings`**: they list
what the format could not represent.

`download_url` is `GET /api/projects/<id>/export` with the same options as query parameters
(`format` and `frame`, plus `objects` when a subset was exported and `apply_modifiers=false` when
modifiers were not applied; see [REST endpoints](#rest-endpoints)). It exports again when it is
fetched: the same file as the embedded one while the scene is unchanged, the project's current
state after later edits.

What the formats contain:

- **OBJ, STL, PLY**: world-space meshes after modifiers. OBJ is Y-up with normals, UVs and
  `usemtl` material groups; STL is binary and triangulated; PLY is binary with UVs and vertex
  colours when present. Particle and collection instances are included.
- **glTF / GLB** <!-- re-check: gltf-export (matched packages/core/src/io/gltf-export.ts on
  2026-11-06) -->: the object hierarchy (armature bones as nodes, bone-parented objects under
  their bone), meshes with one primitive per material, principled materials, cameras, lights
  (`KHR_lights_punctual`; area lights become point lights, with a warning), and particle and
  collection instances as nodes sharing their source's mesh. Animation is sampled once per frame
  over the scene frame range (at most 10000 frames): node transforms wherever an object or bone
  moves, whatever moves it (keyframes, drivers, constraints, IK, rigid bodies). Shape keys become
  morph targets; a mesh deformed only by an Armature modifier becomes a glTF skin (at most 4 bone
  influences per vertex); other changing deformation is baked into morph targets. Procedural
  textures are baked into 512×512 PNG images; a mesh without UVs gets generated UVs (Smart UV
  Project) for the bake, with a warning. Sky, mist, the world, drivers and constraints themselves
  are not exported; camera lens shift is dropped with a warning.

### Rendering

Two tools render, on the server's render threads (off the event loop that serves editors and
agents) or, for `render_image`, in a connected browser editor. `run_operator` refuses the
`render.*` operators.

#### Engines and routing

- `RASTER`: a fast rasterizer for checking layout, materials and animation. The server's software
  rasterizer draws no shadows; a browser editor renders with WebGL in its Rendered shading (scene
  lights with shadow maps).
- `PATHTRACER`: the CPU path tracer (principled BSDF, soft shadows, global illumination,
  reflections, glass, sky, mist, depth of field, procedural textures, instances, view transforms)
  for final images. It renders in parallel on all render threads. Lamps are not visible to the
  camera directly (only in reflections); use emissive materials for visible light sources. It has
  no volumes, subsurface scattering or motion blur.
- `shading: "SOLID"` (grey clay) always rasterizes. Without `shading`, renders show materials and
  scene lights. Leave it out for raster renders in a browser editor: an explicit `MATERIAL` there
  gives the viewport's Material Preview (studio light, scene lamps off), while on the server and
  for path tracing it is the default look.

<!-- re-check: browser raster shading (apps/web/src/editor/rpc.ts, viewport/engine.ts renderPixels)
matched the code on 2026-11-06 while a change to the web editor's final renders (render
visibility, RPC shading) was in progress -->

`engine` defaults to the scene's render engine (`set_scene_settings {engine}`), whichever renderer
is used. `render_image` chooses where to render with `renderer`:

| `renderer`       | `RASTER`                                                                           | `PATHTRACER`                                                                     |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `auto` (default) | A connected browser editor (WebGL, Rendered shading), else the server's rasterizer | The server's path tracer                                                         |
| `browser`        | A browser editor only (`client` picks one); an error when none is connected        | That editor's render workers (Web Workers); the samples reached are not reported |
| `software`       | The server's rasterizer                                                            | The server's path tracer                                                         |

If a browser render fails or times out (raster: 15 s; path tracing: `time_limit` + 30 s), `auto`
falls back to the server and says so in `note`, and `browser` fails. While an editor path traces,
the tool sends a progress notification every 5 s until `time_limit` has passed (to requests with
a progress token). The web editor's own Render Image (F12) and Render Animation (Ctrl+F12) windows
path trace on the same Web Workers. `render_animation` always renders on the server.

The server's render threads: `RENDER_WORKERS` (default: CPU cores, at most 8; `0` renders on the
main thread) plus one thread for raster stills, which never wait for long renders. Long renders
(path-traced stills and all animations) use every render thread; at most two run at once, sharing
the threads, and further ones wait their turn.

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
most recently active editor that accepts UI commands), `timeout_ms` (100–60000, default 10000).

Sends a UI command to a live browser editor that has the project open. It fails when none is
connected ("No browser editor accepting UI commands is connected … Open _editor_url_ in a
browser"). Commands:

| Command               | Params                                                                          | Effect                                                                                           |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `view.frame_all`      | –                                                                               | Frame all objects in the viewport                                                                |
| `view.frame_selected` | –                                                                               | Frame the editor's selection                                                                     |
| `view.set_view`       | `view` (or `type`): `FRONT`, `BACK`, `RIGHT`, `LEFT`, `TOP`, `BOTTOM`, `CAMERA` | Align the viewport                                                                               |
| `view.shading`        | `shading` (or `type`): `WIREFRAME`, `SOLID`, `MATERIAL`, `RENDERED`             | Viewport shading                                                                                 |
| `select`              | `objects`                                                                       | Set **that editor's** selection                                                                  |
| `set_mode`            | `mode`                                                                          | Switch that editor's mode (`OBJECT`, `EDIT`, `SCULPT`, `VERTEX_PAINT`)                           |
| `set_frame`           | `frame`                                                                         | Set that editor's current frame                                                                  |
| `play`                | `playing` (default true)                                                        | Start or stop playback                                                                           |
| `notify`              | `message`                                                                       | Show a message to the user                                                                       |
| `run_operator`        | `operator`, `params`                                                            | Run an operator in that editor, with its selection and its undo history (also UI-only operators) |
| `screenshot`          | `width`, `height`                                                               | A PNG of the viewport as the user sees it (returned as an image)                                 |
| `get_view`            | –                                                                               | The viewport's target, distance, yaw, pitch, orthographic flag and camera view state             |

Enum values are case-insensitive. Invalid parameters (an unknown view or shading, objects that do
not exist, a missing `frame`) and unknown commands are errors that say what is wrong and leave the
editor as it was.

### Resources

`project://{id}/scene` (JSON): the same description as `get_scene`, at the agent's frame, for each
project. `resources/list` lists one per project.

## Errors

**Tool errors** are normal tool results with `isError: true` and a text message. Most messages say
what to do. For `run_operator`, `batch` and `edit_mesh` the first line is the message and the rest
is the full result as JSON (for `batch`, including the operations that succeeded).

| Message (abridged)                                                                                                                                | Cause                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MCP error -32602: Input validation error: Invalid arguments for tool get_object: Invalid input: expected number, received string at frame`       | A tool argument of the wrong type or out of range (e.g. `time_limit` above 600)                       |
| `… Invalid arguments for tool set_scene_settings: unknown argument 'sampels' (did you mean 'samples'?). Valid arguments: …`                       | A misspelled or unknown tool argument                                                                 |
| `… Invalid arguments for tool render_image: unknown key 'fov' (did you mean 'lens' or 'fov_degrees'?) (valid keys: …) at view`                    | A misspelled key inside a nested tool argument (`view`, `selection`, batch `operations`)              |
| `… unknown argument 'name'. Valid arguments: project, operator, params, selection. Operator parameters go inside …`                               | Operator parameters given as tool arguments                                                           |
| `Invalid parameters for mesh.primitive_cylinder_add: unknown parameter 'raduis' (did you mean 'radius'?). Valid parameters: …`                    | A misspelled or unsupported operator parameter (also nested, e.g. in curve points)                    |
| `Invalid parameters for object.shade_smooth: unknown parameter 'objects'. Valid parameters: (none). This operator acts on the selected objects …` | A selection-based operator: pass `selection`                                                          |
| `Invalid parameters for object.drop_to_ground: surface: Invalid input: expected array, received string`                                           | A value of the wrong type or out of range                                                             |
| `mesh.subdivide failed: Operator requires Edit Mode`                                                                                              | The operator's preconditions (mode, selection, object type) are not met; use `edit_mesh` for `mesh.*` |
| `Unknown operator 'mesh.primitive_cylindr_add'. Did you mean: …`                                                                                  | A misspelled operator id                                                                              |
| `'render.render_software' would render on the server's main thread … Use the render_image tool instead`                                           | `render.*` through `run_operator` / `batch` / `edit_mesh`                                             |
| `Object 'Nope' not found in project 'P'. Objects: …`                                                                                              | A wrong object reference (the message lists up to 40 names)                                           |
| `Project 'X' not found. Known projects: …` / `Several projects are named 'X': … Pass the project id instead.`                                     | A wrong or ambiguous project reference                                                                |
| `'dimensions' is not animatable on object. Animatable: …`                                                                                         | `insert_keyframe` on a property that cannot be keyed                                                  |
| `'constraints["Nope"].influence' does not exist on object 'Cube': constraints has no "Nope" (it is empty).`                                       | `insert_keyframe` on a path that does not resolve                                                     |
| `A path traced image of 2048×2048 is too large (at most 2621440 pixels, e.g. 2048×1280): render smaller`                                          | Render limits                                                                                         |
| `Too many frames (5000, at most 1000): shorten the range or raise frame_step.`                                                                    | `render_animation` limits                                                                             |
| `Rendering was cancelled.`                                                                                                                        | The request was cancelled or the client disconnected                                                  |
| `<tool> failed: <message>`                                                                                                                        | An unexpected server error (also logged)                                                              |

Failed `run_operator`, `edit_mesh` and `batch` operations also carry a `code` in their JSON (the
kinds of the core operator registry):

| `code`           | Meaning                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `INVALID_PARAMS` | Unknown, misspelled or invalid parameters: fix `params`                                         |
| `POLL_FAILED`    | Wrong mode, selection or object type, or an operator only the browser UI offers                 |
| `NOT_FOUND`      | An unknown operator, object or datablock                                                        |
| `FAILED`         | The operator itself failed, or it is refused here (`render.*`: use the rendering tools instead) |

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
| `list_operators`                           | Parameter schemas when a filter matches at most 60 operators (or `include_parameters: true`)                                                                                       |
| `render_image`                             | 16–2048 per side; path tracing on the server at most 2,621,440 pixels; `time_limit` up to 600 s (default 30)                                                                       |
| Browser renders                            | Raster: 15 s per render request; path tracing: `time_limit` + 30 s                                                                                                                 |
| `render_animation`                         | 1000 frames, 2048 px per side, `time_limit` up to 600 s (default 60); GIFs and contact sheets at most 33,554,432 pixels over all frames; a contact sheet at most 16,777,216 pixels |
| Concurrent long renders                    | 2 path-traced stills or animations at once (more wait their turn; raster stills have a thread of their own)                                                                        |
| Embedded files                             | 20 MiB (`export_scene`, `render_animation`); larger animations are stored and linked                                                                                               |
| Stored renders                             | 1 hour, 256 MiB in all (oldest dropped first); kept in memory                                                                                                                      |
| `import_model`                             | 50 MB; URL downloads time out after 60 s                                                                                                                                           |
| `editor_command`                           | `timeout_ms` up to 60000                                                                                                                                                           |

## REST endpoints

The same server offers plain HTTP endpoints under `/api` (protected by `AUTH_TOKEN`, not by
`MCP_TOKEN`). Those relevant to agents:

| Endpoint                                      | Purpose                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/projects`                           | `{projects: [...]}`                                             |
| `POST /api/projects`                          | Body `{name, empty}`; 201 `{id, name}`                          |
| `GET` / `PATCH` / `DELETE /api/projects/:id`  | Details (with `persistence`) / rename (`{name}`) / delete (204) |
| `GET /api/projects/:id/snapshot`              | The document as JSON                                            |
| `GET /api/projects/:id/export?format=glb`     | An export (`glb`, `gltf`, `obj`, `stl`, `ply`); see below       |
| `GET /api/projects/:id/render.png`            | Renders a PNG on the server                                     |
| `GET /api/projects/:id/renders/:render`       | `{id, files: [{name, mime, bytes}]}` of a stored render         |
| `GET /api/projects/:id/renders/:render/:file` | A stored render file (kept for an hour)                         |

`export` takes the query parameters `format` (default `glb`), `objects` (comma-separated object
ids or names; default every object visible in renders; an unknown one is a 400 error),
`apply_modifiers` (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`; default true) and `frame`
(default: the scene's `frame_start`), and answers with the file as an attachment. The
`download_url` of `export_scene` uses these parameters.

`render.png` takes the query parameters `width` (16–2048, default 800), `height` (default from the
render aspect), `camera` (name or id), `frame` (default: the scene's `frame_start`), `engine`,
`shading`, `samples`, `max_bounces`, `denoise` (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`),
`time_limit` (seconds, default 30 for `PATHTRACER`) and `seed`, with the same meaning as for
`render_image` (there is no `view`). It always renders on the server and answers with the headers
`x-render-engine`, `x-render-threads`, `x-render-time-ms` and, for path tracing,
`x-render-samples`.

Errors: 400 for invalid parameters, an unknown camera or a path-traced image that is too large; 404
for an unknown project; 499 when the client went away during the render; 503 when the server
stopped the render or the storage is unavailable; 501 when a format or engine is not available in
the build; 500 for other failures.

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
node scripts/mcp.mjs tools [filter]                      # tool names with the first sentence of their description
node scripts/mcp.mjs ops [search]                        # list_operators (with a search string)
node scripts/mcp.mjs call <tool> ['<json args>'] [--out file] [--out-dir dir]
node scripts/mcp.mjs batch <calls.json> [--out-dir dir]  # [{ "tool": "...", "args": {...} }, ...]
```

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
