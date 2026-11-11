# Building 3D projects through MCP: a guide for AI agents

This guide is for AI agents (and the people who write their scripts) that build complete scenes
through the editor's MCP endpoint: modelled, lit, animated, rendered and exported. It is
distilled from the server code and from five projects that agents built entirely through MCP (see
[Example projects](#example-projects)). The exact tool arguments and limits are in the
[MCP reference](mcp.md); the server also sends a short version of this guide with its `initialize`
result.

Contents:

1. [Before you start](#before-you-start)
2. [The build loop](#the-build-loop)
3. [Units, axes and rotations](#units-axes-and-rotations)
4. [Selection and modes](#selection-and-modes)
5. [Modelling](#modelling)
6. [Materials](#materials)
7. [Curves and text](#curves-and-text)
8. [Lights, cameras and the world](#lights-cameras-and-the-world)
9. [Animation](#animation)
10. [Constraints](#constraints)
11. [Rigging](#rigging)
12. [Physics](#physics)
13. [Generators, layout and scattering](#generators-layout-and-scattering)
14. [Render budgets](#render-budgets)
15. [Exporting](#exporting)
16. [Common errors and how to read them](#common-errors-and-how-to-read-them)
17. [Example projects](#example-projects)
18. [What the editor does not have](#what-the-editor-does-not-have)

## Before you start

- **Connect** as described in [mcp.md](mcp.md#connecting). If your client reconnects for every
  call (a CLI, a script that restarts), send an agent id (`x-mcp-agent-id` header or `?agent=` on
  the URL) so `undo` and your selection survive between connections.
- **Check persistence** with `get_project`: with `persistence: "memory"` the project is lost when
  the server stops. Export what you need (`export_scene`) or ask for a server with `DATA_DIR`. When
  another server sharing the storage, or a browser syncing with it, deleted the project while you
  work on it, `get_project` says so (`deleted_from_storage: true`: it checks storage before it
  answers, unless the server read it in the last 2 s, and waits up to 5 s for that): your next
  change stores the whole project again, so call `get_project` before you go on after a pause, and
  stop if the deletion was meant. When `list_projects` has `storage_listing_failed: true` (storage
  failed or did not answer within 30 s), it lists only the projects loaded on the server.
- **Read schemas instead of guessing.** Names are strict: a misspelled tool argument
  (`set_scene_settings {"sampels": 5}`), a misspelled key inside `view`, `selection` or a batch
  operation, and a misspelled operator or modifier parameter all fail with did-you-mean
  suggestions and the valid names before anything changes (in a `batch`, the operations before
  the failing one stay applied). Tool input schemas are in `tools/list`
  (`node scripts/mcp.mjs tools <tool>` prints a tool's arguments with types, ranges and defaults);
  operator parameters go inside `params`. The catalogues explain themselves:
  - `list_operators {category: "<group>"}` returns the operators of a feature with their JSON
    schemas, e.g. `Curves`, `Constraints`, `Rigging`, `Physics`, `Generators`, `Drivers`,
    `Shading`, `Lights and Cameras`, `Layout`, `Scene`;
  - `list_modifier_types {type}` for modifier parameters;
  - the read-only operators `constraint.type_list`, `anim.fmodifier_type_list`,
    `material.preset_list` describe their families.
- **Humans may be editing at the same time.** Re-read (`get_scene`, `get_object`) before you rely
  on earlier results, and use names from results rather than the names you asked for.

## The build loop

Every example project follows the same loop:

1. **Start from a clean project.** Delete an older project of the same name and create it with
   `empty: true`, so the build is reproducible (all five example scripts do this). Project names
   are unique, ignoring letter case: `create_project` refuses a taken name and gives the id of the
   project that has it.
2. **Set the scene up first** with one `set_scene_settings` call: resolution, frame range and
   fps, render engine, samples, bounces, denoising, view transform.
3. **Build in stages.** Group the operators of one stage into a `batch`: it is one undo step, the
   result lists every operation's `result` and `reports`, and it stops at the first failure. A
   batch takes at most 200 operations; split longer lists.
4. **Verify after each stage**, numerically before visually:
   - `get_scene {max_objects}`: `counts` and especially `problems`;
   - `get_object {object, frame}`: evaluated transforms at a frame, `world_transform`,
     constraint and modifier errors;
   - `scene.measure`, `scene.raycast`, `scene.stats` (operators, read-only; they take `frame`).
     `scene.measure` computes exact surface distances for up to 25 objects, nearest pairs first,
     within about 3 s; a pair left out says why in `surface_distance_skipped` (`time budget`, or
     an object without faces), and `surface_distances {computed, skipped, no_surface}` adds up to
     the number of pairs;
   - `get_mesh_data` for vertex indices, face materials, vertex colours, UVs and terrain
     heightmaps; `get_instances` for where scattered instances are;
   - per feature: `armature.describe {frame}`, `constraint.describe {frame}`,
     `rigidbody.describe {frame}`, `anim.driver_list {frame}`.
5. **Look at it**: a `RASTER` `render_image` for layout, a small path-traced still for lighting
   and materials, a `render_animation` contact sheet for motion.
6. **Fix and repeat.** `undo` reverts your last tool call (a whole batch at once). Your history
   keeps the last 100 steps per project and at most 64 MB of replaced or deleted data (server
   defaults), so undo soon after a change and rebuild rather than undo far back.
7. **Final outputs**: the path-traced still, the animation, the export.

A minimal script skeleton with `scripts/mcp.mjs`, close to what the example scripts use:

```js
import { connect } from '../../scripts/mcp.mjs'; // relative to examples/<name>/build.mjs

const NAME = 'my-scene';
const mcp = await connect(); // MCP_URL, MCP_TOKEN, MCP_AGENT_ID from the environment
let project = NAME;
const tool = (name, args = {}) => mcp.call(name, { project, ...args });

/** One operator; returns its result and prints its warnings. */
async function op(operator, params = {}, selection) {
  const r = await tool('run_operator', { operator, params, ...(selection ? { selection } : {}) });
  for (const rep of r.reports)
    if (rep.level !== 'INFO') console.warn(`${operator}: ${rep.level} ${rep.message}`);
  return r.result;
}

/** Many operators, one undo step per 200; a failure throws (McpToolError with the JSON details). */
async function batch(operations) {
  const out = [];
  for (let i = 0; i < operations.length; i += 200) {
    const r = await tool('batch', { operations: operations.slice(i, i + 200) });
    for (const x of r.results)
      for (const rep of x.reports ?? [])
        if (rep.level !== 'INFO') console.warn(`${x.operator}: ${rep.message}`);
    out.push(...r.results.map((x) => x.result));
  }
  return out;
}

try {
  const { projects } = await mcp.call('list_projects');
  // compare names like create_project does (trimmed, ignoring letter case)
  const key = (name) => name.trim().toLowerCase();
  for (const p of projects.filter((p) => key(p.name) === key(NAME)))
    await mcp.call('delete_project', { project: p.id, confirm: true });
  project = (await mcp.call('create_project', { name: NAME, empty: true })).id;
  await tool('set_scene_settings', {
    resolution_x: 1280,
    resolution_y: 720,
    frame_end: 48,
    engine: 'PATHTRACER',
  });
  // … build in stages …
  const scene = await tool('get_scene', { max_objects: 1 });
  if (scene.problems?.length) throw new Error(JSON.stringify(scene.problems));
} finally {
  await mcp.close(); // ends the session: no avatar is left behind
}
```

## Units, axes and rotations

- **Metres, Z up, right-handed.** The ground is the XY plane. Blender's front view looks along
  +Y, so "facing the viewer" usually means facing −Y.
- **Euler XYZ in radians** (Blender's default rotation mode; objects have no quaternion or other
  rotation modes). The rotation is applied about X, then Y, then Z, in the parent's axes. Only
  `add_object`, `create_mesh` and `transform_object` accept `rotation_degrees`; every operator
  parameter is in radians (`rotation`, `spot_size`, `sun_elevation`, `pole_angle`, the `angle` of
  `object.shade_auto_smooth` and `SMOOTH_BY_ANGLE` …).
- **Local axes that matter:**
  - cameras look down their local −Z with +Y up; spot, area and sun lights shine down local −Z;
  - text lies in its local XY plane facing +Z with the first baseline at the origin: rotate it by
    `[π/2, 0, 0]` to stand it up facing −Y;
  - generated objects stand on z = 0 with their origin at the foot; buildings, chairs and shelves
    face −Y; `object.generate_wheel` puts the axle along X; gears lie in the XY plane.
- **Aim, don't compute angles.** `object.look_at {objects, point | target}` rotates once;
  `object.track_set` or a `TRACK_TO` / `DAMPED_TRACK` constraint keeps aiming while things move.
- **Scale versus size.** Generators and primitives take real sizes; `object.dimensions_set` scales
  an object to target dimensions. Procedural textures with `OBJECT` mapping are sized in object
  space, before the object's scale, so a cube scaled into a wall stretches its bricks: apply the
  scale with `object.transform_apply {rotation: false, scale: true}` (a selection-based operator)
  first; the preset and procedural operators warn about it. Pass `rotation: false`: it defaults to
  true, so `{scale: true}` alone applies the rotation too, which resets `rotation_euler` to 0
  (rotation keys and aims that follow start from there) and lines the texture up with the world
  axes instead of the object's former ones. Children of a non-uniformly scaled parent shear when
  they rotate, so scale meshes rather than parents (the robot workcell keeps every object scale
  at 1).
- **Colours are linear RGB(A)**, components 0..1. Convert sRGB colour values first:

  ```js
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  ```

## Selection and modes

Each agent has its own selection, active object and mode, separate from every human's, and they
**persist between calls**:

- Operators that add objects (`add_object`, primitives, generators, `object.text_add` …) make the
  new object selected and active.
- Many operators act on the selection and take no object argument: `object.transform_apply`,
  `object.shade_smooth`, `object.shade_flat`, `object.shade_auto_smooth`, `object.convert`,
  `object.join` (into the active object), `object.origin_set`, `object.duplicate`,
  `object.parent_set` (to the active object), `transform.translate|rotate|resize`,
  `anim.keyframe_insert` and others. Run them with an explicit selection:

  ```json
  {
    "operator": "object.transform_apply",
    "params": { "rotation": false, "scale": true },
    "selection": { "objects": ["Deck", "Post"], "mode": "OBJECT" }
  }
  ```

  Passing `objects` to such an operator fails with a message that tells you so. Running one
  without setting the selection silently acts on whatever was selected last.

- Inside a `batch`, give an operation its own `selection` (`{operator, params, selection}`; it
  stays set for the following operations), or put `object.select {objects, active}` before the
  selection-based operation (the product-shot script does this for `object.shade_smooth`).
- A call that fails changes nothing, your editor state included: a `selection` is applied all or
  nothing, and when the operator (or a batch operation) fails, your selection, active object and
  mode stay as they were before it.
- `mesh.*` operators need Edit Mode. Use `edit_mesh`, which enters Edit Mode on one object,
  selects the elements you list, runs the operator and returns to Object Mode, leaving the object
  selected and active. If you enter Edit Mode yourself through
  `run_operator {selection: {mode: "EDIT"}}` (an element selection in `selection.mesh` needs
  `mode: "EDIT"`), you stay there until you pass `selection: {mode: "OBJECT"}`, and object
  operators fail their mode checks meanwhile.
- Element indices are those of the stored (base) mesh: read them with
  `get_mesh_data {source: "BASE"}`. An edge in `edges` is `[a, b]` with two vertices that follow
  each other in one of its faces (the last with the first) or a loose edge
  (`include: ["loose_edges"]`); any other pair is refused (`POLL_FAILED`), not skipped. Operators
  that change topology renumber elements, so read again after them.
- `select_mode` decides how the lists are read: `VERT` selects the listed vertices together with
  the vertices of the listed edges and faces, `EDGE` only the listed `edges` and `FACE` only the
  listed `faces`. Left out, it is `FACE` for faces alone, `EDGE` for edges alone and `VERT`
  otherwise. Lists that the select mode would not use are refused (`POLL_FAILED`), and so is
  `all: true` with lists (it selects everything); `all: false` without lists selects nothing. The
  refusal names both problems when they come together, and every remedy it names works as it is.

## Modelling

- **Primitives**: `add_object` (17 types) or the `mesh.primitive_*_add` operators, which also
  take `name`, `location`, `rotation` and `scale` and can go into a `batch`.
- **Computed geometry**: `create_mesh` or `object.add_mesh_from_data {name, vertices, faces}`
  (faces counter-clockwise seen from outside). The robot-workcell script builds almost every part
  this way, as boxes and cylinders at their real size and position, in batches.
- **Edit-mode operations** with `edit_mesh`: `mesh.extrude_region_move {value}`, `mesh.inset`,
  `mesh.bevel`, `mesh.subdivide`, `mesh.loopcut` (needs an `edge`), `mesh.delete {type}`,
  `mesh.merge`, `mesh.bridge_edge_loops`, `mesh.spin`, `mesh.solidify`, `transform.*` on elements.
  The lighthouse script makes a rowing boat by deleting the upper half of a UV sphere this way.
- **Modifiers** stay editable: `BEVEL`, `ARRAY`, `MIRROR`, `SOLIDIFY`, `BOOLEAN`, `SCREW`,
  `SUBSURF`, `WIREFRAME`, `SMOOTH_BY_ANGLE`, `DISPLACE`, `CURVE`, `SIMPLE_DEFORM` and others (22
  types; `list_modifier_types`). `apply_modifier` bakes one into the mesh (a boolean with a
  temporary cutter: add, apply, delete the cutter, as the orrery's gear windows do).
- **Joining and shading**: `object.join` merges the selected meshes into the active one;
  `object.shade_smooth` / `object.shade_auto_smooth {angle}` or a `SMOOTH_BY_ANGLE` modifier.
- **Sculpting numerically**: `sculpt.brush_stroke {object, brush, points, radius, strength}`
  applies dabs at world-space points. `GRAB` with `grab_delta` is the precise brush for shaping
  terrain; `FLATTEN` converges to the average plane of the area, which can be tilted.

## Materials

- `set_material {object, name, base_color, metallic, roughness, …}` creates or updates a
  principled material and assigns it to a slot, for meshes, curves and text alike. Reuse a
  material with `{material: "Name"}`; assign one to many objects with
  `object.material_assign {material, objects, slot}`.
- **Presets**: `material.preset_list` lists 33 physically plausible presets (metals, plastics,
  glass, water, ceramics, stone, wood, fabrics, emissive, ground, patterns);
  `material.preset_apply {preset, objects, name, slot}` creates one material from a preset for the
  given objects. Tweak it afterwards with `material.update` (which also sets `coat_weight`,
  `coat_roughness`, `sheen_weight`, `sheen_tint`, `normal_strength`, `alpha_threshold` and
  `use_backface_culling`).
- **Procedural textures**: `material.procedural_set {material, channel, procedural}` puts one
  texture on a channel: `base_color`, `metallic`, `roughness`, `normal` (bump), `emission` or
  `alpha`. Types: `NOISE`, `VORONOI`, `CHECKER`, `GRADIENT`, `WAVE`, `BRICK`, `MARBLE`, `WOOD`,
  `MAGIC`; mapping `GENERATED`, `OBJECT` (metres in object space) or `UV`; `color_a` / `color_b`
  with `ramp_low` / `ramp_high` shape the colour ramp; type-specific settings go in `params`
  (e.g. `BRICK {brick_width, row_height, mortar_size}`, `WAVE {wave_type, direction}`; see the
  operator's schema). Fields you pass are merged into the channel's existing texture unless
  `replace: true`. The viewport, both renderers and the glTF bake evaluate textures the same way.
- **Line widths come from the ramp**, not from the type options: for thin `MARBLE` veins set
  `ramp_low: 0`, `ramp_high` about 0.25 and `params.ramp_interpolation: "EASE"` (with the default
  0..1 ramp, marble is a soft, cloudy mix of both colours); narrow the ramp the same way for thin
  `WAVE` or `WOOD` lines. `WOOD` rings go around `params.axis`: `Z` (the default) suits a post or
  log standing up; set `X` or `Y` for table tops and floor boards running along X or Y, so the
  grain follows the boards.
- **Watch the warnings**: presets and procedurals warn when an object is scaled (OBJECT mapping
  stretches with the scale: apply the scale first), when alpha is used with `blend_method: OPAQUE`
  (set `CLIP` or `BLEND`) or emission has strength 0.
- **Glass and liquids**: `transmission: 1`, `roughness: 0`, `ior` (1.45–1.5 for glass, about 1.33
  for water). The camera sees through several surfaces, so raise `max_bounces` (a glass bottle
  with liquid inside means six refractions before the backdrop; the product shot sets 10). Lamps
  inside glass (lanterns, bulbs) light their surroundings without tricks: the path tracer lets
  direct light through glass as through a thin sheet, tinted by the base colour and dimmed by the
  reflection, and index-matched glass (IOR 1) casts almost no shadow. Glass casts no caustics
  (no bright focus under a glass ball), and reflections of glass in glossy (not mirror-smooth)
  surfaces show it as a thin sheet, without refraction.
- **Several materials on one mesh**: fill slots 0, 1, 2 … with `set_material {slot}`, then assign
  faces in Edit Mode with `edit_mesh` and the operator `object.material_slot_assign {index}`,
  passing the faces as `selection: {faces: [...], all: false}` (the lighthouse terrain zones and
  the robot gripper pads do this). Generators come with numbered slots (listed in their result as
  `material_slots`). Curve splines pick a slot with `material_index`.
- **Shared generator materials**: generators fill their slots with default materials by name
  (`Bark`, `Rock`, `Grass` …) and reuse existing materials of that name, so editing `Rock`
  changes every generated rock. Pass `materials: false` to get empty slots, or assign new
  materials.
- **Vertex colours**: `paint.vertex_color_set` / `paint.vertex_color_stroke` multiply the base
  colour; `paint.vertex_color_set_data {object, colors}` (with `indices` or `start`, or `ranges`
  instead) writes exact linear colours per vertex in one call (in `get_mesh_data` vertex order),
  e.g. computed from height and slope; `get_mesh_data {include: ["colors"]}` reads them back.
- Image textures cannot be loaded through MCP; they arrive with imported glTF files or through
  the web editor's Material tab.

## Curves and text

- **Create** with `curve.add_from_points {points, type, cyclic, dimensions, location}` (`type`
  `POLY`, `BEZIER` (a smooth curve through the points) or `NURBS`; `dimensions` `2D` or `3D`) or
  the `curve.primitive_*` operators; `add_object` offers `bezier_curve`, `bezier_circle` and
  `nurbs_path`.
- **Give it a surface**: `bevel_depth` (round tube), `extrude` (ribbon), a 2D fill
  (`dimensions: "2D"` with `fill_mode` `BOTH`, `FRONT`, `BACK` or `NONE`), or a profile:
  `bevel_mode: "OBJECT"` with `bevel_object` naming another (usually 2D, cyclic) curve whose shape
  is swept along this one. Hide the profile afterwards with
  `data.set_property {kind: "objects", target, values: {hide_viewport: true, hide_render: true}}`.
  `twist_mode: "Z_UP"` keeps a profile level along a path. A point's `tilt` (radians) rolls the
  profile: positive tilt raises its left (+x) side, seen along the direction of travel, like a road
  banked for a right turn; with `fill_mode: "HALF"`, `twist_mode: "Z_UP"` and a tilt of −π/2 on
  every point, a half tube opens upward (a gutter). Change these later with
  `curve.properties_set`, points with `curve.spline_set_points`.
- **A wire curve has no surface**: `get_scene` says so in its data summary, and `get_mesh_data`
  refuses it. Modifiers still work on the wire, so a `SCREW` modifier on a profile curve makes a
  lathed object: the product shot turns its bottle, perfume, cap and pedestal this way (a POLY
  profile in a vertical plane, `SCREW {axis: "Z", steps}`, then `SMOOTH_BY_ANGLE`).
- **Text**: `object.text_add {body, size, extrude, align_x, align_y}` (the built-in font,
  printable ASCII and Latin-1; `\n` for new lines). Its result gives the layout box from the font
  metrics (`width`, `height`, `bounds`: what `align_x` and `align_y` place) and the extent of the
  letters themselves (`ink_width`, `ink_height`, `ink_bounds`: what `scene.measure` reports), so
  you can fit text to a plate and resize it with `font.text_set {object, size}` (the orrery's
  motto plate). `size` is the em height; capitals are 0.7 × size.
- **Materials** work on curves and text like on meshes (`set_material`).
- **Convert** to a mesh for booleans, mesh editing or exact geometry:
  `object.convert {target: "MESH"}` with `selection: {objects: [...]}`. It keeps name, transform and
  materials, and bakes the object's modifiers. An object whose geometry did not evaluate fully (a
  modifier that failed or was skipped for memory, a surface that was not built: the `problems` of
  `get_scene`) is refused with those errors and nothing is converted (`OUT_OF_MEMORY` when memory
  was the cause, else `FAILED`). The orrery engraves its motto: text → mesh → `BOOLEAN DIFFERENCE`
  on the plate.
- **Animate** a growing curve with `insert_keyframe {property: "data.bevel_factor_end"}`, a curve
  path with `data.eval_time` or `constraint.followpath_path_animate`.

## Lights, cameras and the world

- **Lights**: `add_object {type: "light", light_type: "AREA", params: {...}}` or
  `object.light_add`, with `energy`, `color`, `shape`, `size`, `size_y` … given directly. Energy is
  in watts (`SUN`: W/m²; the daytime sky presets use 3–3.5). Irradiance falls with the square of
  the distance, so a light twice as far away needs four times the energy for the same brightness.
- **Change light data** with `light.properties_set`: `object` or `objects`, then any of `energy`,
  `color`, `shape`, `size`, `size_y`, `spot_size`, `spot_blend`, `shadow_soft_size`, `angle`
  (sun softness) and `keyframe`. It changes several lights at once, warns about fields that do not
  apply to the light type, and keys the values with `keyframe: true`. `get_object` shows the
  values (and the datablock `id`).
- **Lamps are invisible to the camera in the path tracer**; they only appear in reflections. For a
  visible lamp, add an emissive mesh (the lighthouse lamp is a sphere with
  `emission_strength: 45` next to a point light). The path tracer has no volumes either: the
  lighthouse beams are glowing cones of index-matched glass (`transmission: 1`, `ior: 1`), which
  camera rays and light pass straight through.
- **Emissive meshes light their surroundings only in the path tracer.** RASTER renders and the
  viewport draw the emitter itself but light nothing with it, so a scene lit only by mesh lights
  looks dark in a RASTER preview. A scene with no lamp, no sky or environment light, no emissive
  material and a dark world is lit by a camera-relative studio rig in every renderer, so it is
  never black; that rig disappears as soon as you add a light.
- **Cameras**: `add_object {type: "camera", params: {lens}}` (the first camera becomes the scene
  camera), aim it with `object.look_at` or a tracking constraint, and switch with
  `set_active_camera`. `camera.properties_set` changes `lens`, clipping, `type: "ORTHO"`,
  `ortho_scale`, shift and **depth of field**: `dof_use: true` with `dof_focus_object` (an object
  name) or `dof_focus_distance` (metres) and `dof_aperture_fstop`. Depth of field only renders in
  the path tracer; `keyframe: true` keys a focus pull.
- **Quick looks without a camera**: `render_image {view: {position, target, lens}}`.
- **World** (`set_scene_settings`):
  - `environment: "STUDIO"` (the default): an even studio light; scale it with
    `environment_strength`;
  - a procedural sky: `sky_preset` (`NOON`, `CLEAR_DAY`, `MORNING`, `SUNSET`, `DUSK`, `NIGHT`,
    `OVERCAST`) plus `sun_elevation` and `sun_rotation` (radians; azimuth counter-clockwise from
    +Y; about 3.9 lights a scene seen from Blender's default camera direction from the front).
    `world.sky_set` also sets zenith, horizon and ground colours;
  - `environment: "NONE"` with `world_color` and `world_strength` for a plain background;
  - mist: `mist_distance` (metres at which it reaches 95 %) and `mist_color`;
  - the studio environment lights the scene but is hidden from the background by default (the
    background shows the world colour); `data.set_property` with `kind: "world"` and
    `values: {show_environment_background: true}` shows it, and `environment_rotation` (radians)
    turns it (the orrery turns its studio by 200°). Switching to a sky with `world.sky_set` or
    `set_scene_settings` also shows the sky as the background (`world.sky_set` with
    `show_background: false` hides it).

## Animation

- **Set the range first**: `set_scene_settings {frame_start, frame_end, fps}`.
- **Keyframes**: `insert_keyframe {object, property, frame, value}` for single keys (without `value`
  it keys the value the property shows at your current frame, an animated or driven one too, as
  Blender keys the current value); paths include pose bones, constraint influences, modifier and
  particle settings, light, camera and curve data (`data.…`), shape keys, materials (`material.…`)
  and the world (`object: "world"`); see the [path table](mcp.md#insert_keyframe). For many keys use
  `anim.keyframes_insert_many {target, path, index, frames, values, interpolation, easing}` (one
  channel per call, all in one batch). The robot script keys 96 frames of an IK target and two bone
  rotations in one batch this way.
- **Interpolation**: `BEZIER` (default, eased), `LINEAR`, `CONSTANT` (hold: switches and on/off
  states).
- **Loops**: make the last key equal the first one, one loop length later, and set
  `anim.extrapolation_set {objects, type: "CYCLIC"}` (or `extrapolation` on
  `anim.keyframes_insert_many`). The orrery keys its master rotation from 0 at frame 1 to 2π at
  frame 49 for a seamless 48-frame loop; `anim.turntable` builds such a loop for a camera orbit.
- **Drivers** compute a value every frame: `anim.driver_add {target, path, index, expression}`
  plus optional `variables`. Expressions are a safe Python-like subset with `frame`, `pi`, maths
  functions, `noise()`, conditionals and variables that read other properties, for example
  `{name: "m", target: "Master Drive", path: "rotation_euler", index: 2}`. A driver overrides
  keyframes on the same channel. Its result gives the value at the current frame and an `error`
  (for example a math domain error), which also appears in `get_scene` `problems`; it does not
  fail the call. The lighthouse beams turn half a revolution in 24 frames with an expression of
  the form `"<start angle> + (frame - 1) * pi / 24"`; the orrery drives a whole gear train from
  one channel.
- **F-curve modifiers**: `anim.fmodifier_add {target, path, index, type, params}` with `NOISE`
  (`{strength, scale}`: camera shake, flicker), `STEPPED` (stop motion), `GENERATOR`, `LIMITS` or
  `ENVELOPE`; `anim.fmodifier_type_list` has the schemas.
- **Stored versus evaluated**: `transform_object` and the `*.properties_set` operators set values; a
  channel that already has keyframes is keyed at your current frame with its new value, so the
  object shows it there, while its keys at other frames stay and it still moves between them (key
  those frames too, or remove keys with `anim.keyframes_remove`, to change the motion).
  `object.origin_set` and `object.transform_apply` key an animated channel they change at your
  current frame the same way. Drivers override keys and stored values. `get_object {frame}` shows
  evaluated values with the stored ones under `stored`.
- **Check motion** with `get_object {object, frame}` at a few frames (`world_transform` for
  parented or constrained objects), `anim.driver_list {frame}`, and a `render_animation` contact
  sheet with a `frame_step` that gives 12–24 tiles.
- **Bake** the visual result into keys with `anim.bake_transforms {objects, frame_start, frame_end}`
  (optionally `clear_constraints`, `clear_parents`) when you need plain keyframes; it also bakes
  rigid body motion.

## Constraints

- `object.constraint_add {object, type, target, subtarget, influence, params}` with the Blender
  types `COPY_LOCATION`, `COPY_ROTATION`, `COPY_SCALE`, `COPY_TRANSFORMS`, `LIMIT_DISTANCE`,
  `LIMIT_LOCATION`, `LIMIT_ROTATION`, `LIMIT_SCALE`, `CLAMP_TO`, `DAMPED_TRACK`, `LOCKED_TRACK`,
  `TRACK_TO`, `CHILD_OF`, `FLOOR`, `FOLLOW_PATH`, `PIVOT`. `subtarget` names a bone when the target
  is an armature; `FOLLOW_PATH` and `CLAMP_TO` need a curve target. `constraint.type_list` gives
  every type's parameters.
- **Read `errors` in the result**: a missing target or a dependency cycle does not fail the call.
  The same errors appear in `get_object` and in `get_scene` `problems`.
- `object.track_set {type: TRACKTO | DAMPTRACK | LOCKTRACK, target, objects}` adds tracking
  constraints set up for cameras and lights (−Z at the target).
- **Child Of** sets its inverse when it gets a target, so the owner does not jump. To pick an
  object up and put it down, key the constraint's influence with `CONSTANT` interpolation and key
  the object's own transform where it is released. The robot workcell reads the crate's world
  position at the release frame with `constraint.describe {object, frame}` and keys it there.
- **Follow Path**: `constraint.followpath_path_animate {object, constraint, frame_start, length}`
  times the trip along the curve (the orrery's moon).
- `constraint.update`, `constraint.move_to_index`, `constraint.apply` and `constraint.delete`
  edit the stack; `constraint.describe {frame}` gives the evaluated world location, rotation and
  scale.

## Rigging

1. **Armature**: `object.armature_add {name, bone_name, radius, location}` makes one bone along
   +Z, `radius` metres long. Shape it with `armature.bone_update {bone, head, tail}`, add bones
   with `armature.bone_add` or a connected chain with `armature.chain_add {points, names, parent}`
   (armature space unless `space: "WORLD"`). Helper bones that should not deform get
   `use_deform: false`. `armature.properties_set {display_type, show_names}` changes how the rig
   is drawn.
2. **Rigid parts** follow a bone: `object.parent_to` with `parent: "Rig"`, `type: "BONE"` and
   `bone` (the robot's arm segments, gears and clamps).
3. **Skinned meshes**: `object.parent_to` with `parent: "Rig"` and `type: "ARMATURE_AUTO"` adds an
   Armature modifier and vertex groups with automatic weights; the result lists the groups. The
   mesh needs vertices where it bends (loop cuts, a dense sweep: the robot's hose is resampled
   every 4 cm). `ARMATURE_NAME` and `ARMATURE_ENVELOPE` are the other binding types;
   `object.vertex_group_*` operators edit weights.
4. **Posing**: `pose.bone_transform_set {object, bone, rotation_euler, keyframe: true, frame}`
   (bone axes: Y runs along the bone; rotating about X or Z bends it) or `insert_keyframe` with
   `property: 'pose.bones["Upper"].rotation_euler'`. `pose.transforms_clear` resets.
5. **IK**: `pose.ik_add {object, bone, target, chain_count, pole_target, pole_angle}` puts the end
   of a `chain_count`-bone chain on a target object (usually an empty you animate) or bone.
   `pose.ik_settings_set {object, bone, …}` locks (`lock_ik_x`), limits (`use_ik_limit_z` with
   `ik_min_z` / `ik_max_z`, radians from the rest pose) or stiffens (`ik_stiffness_y`) a bone's
   rotation in every IK chain that contains it; a base bone that may only yaw locks X and Z (two
   locks make a hinge about the third axis; `lock_ik_y` alone allows swing without twist). The
   web editor shows these settings in the Inverse Kinematics panel of the active bone.
   Other bone constraints (`pose.constraint_add`): `COPY_ROTATION`, `COPY_LOCATION`,
   `DAMPED_TRACK`, `LIMIT_ROTATION`. The robot keeps its wrist vertical with a `DAMPED_TRACK` to an
   empty below the IK target.
6. **Verify** with `armature.describe {object, frame}`: `posed_head_world` and `posed_tail_world`
   per bone and pose `errors`. The robot script measures its IK error in millimetres this way.

**Shape keys**: `object.shape_key_add {object, name}` (the mesh is the basis),
`object.shape_key_set_positions {key, indices, offsets | positions}`, then
`object.shape_key_set {key, value, keyframe: true, frame}` or `insert_keyframe` with
`property: 'shape_keys["Grip"].value'` (the robot's gripper fingers close with a shape key).

## Physics

1. **Bodies**: `rigidbody.object_add {objects, type, collision_shape, mass}` with `type` `ACTIVE`
   (falls and collides) or `PASSIVE` (floors, walls), plus `friction`, `restitution`,
   `collision_margin`, `linear_damping` and `angular_damping`. Defaults follow Blender: 1 kg,
   friction 0.5, restitution 0, margin 0.04 m, `CONVEX_HULL` for ACTIVE and `MESH` for PASSIVE.
   Shapes: `BOX`, `SPHERE`, `CAPSULE`, `CYLINDER`, `CONE`, `CONVEX_HULL`, `MESH`. Only mesh objects
   can have rigid bodies. Collision shapes keep the true thickness of thin objects (a domino, a
   coin, a card) down to 0.2 % of their largest dimension; a thinner mesh is simulated thicker,
   and the result's `collision_note` (and a warning) says so.
2. **Small objects need small margins.** `collision_margin` is the distance within which contacts
   are detected before surfaces touch (shapes are not inflated by it). The 4 cm default is more
   than the gap between closely spaced dominoes; the domino cascade uses 0.001–0.002 m. Bounces
   use the product of both bodies' `restitution`, so the ground needs a non-zero value too.
   Collision shapes are built from each object's mesh and world scale at the world's
   `frame_start`.
3. **World**: `rigidbody.world_set` (`frame_start`, `frame_end`, `substeps_per_frame`,
   `solver_iterations`) or the same fields in `set_scene_settings` (`rigidbody_frame_end` …).
   Objects keep their own transforms up to `frame_start`; after `frame_end` they hold the last
   state; at most 20000 frames are simulated. Fast or small objects need more substeps (the
   domino cascade uses 20 substeps and 20 iterations).
4. **Inspect** with `rigidbody.describe {frame, objects}` (world location and rotation, whether a
   body is moving, `sleeping`, the simulated shape and problems), `get_object {frame}`, and a
   `RASTER` contact sheet. Any change to bodies or the world resets the simulation cache;
   `rigidbody.cache_free` forces a fresh simulation (and drops the shared collision shapes).
5. **Bake** when the motion is right:
   `rigidbody.bake_to_keyframes {objects, frame_start, frame_end}` writes LINEAR keys (every `step`
   frames) and removes the baked objects' rigid bodies. They get the custom property
   `rigid_body_baked` (`"frames A-B step S"`), so `rigidbody.describe` keeps listing them (motion
   `KEYFRAMED`, `baked_objects`); `rigidbody.object_add` on such an object removes the marker. The
   domino script compares the keyed positions with the simulation before and after (at most 2 mm
   apart). Unbaked scenes also render and export: renders simulate, and the glTF exporter samples
   the evaluated motion (see [Exporting](#exporting)).

Limits: no rigid body constraints (joints, hinges), no cloth, soft body, fluid or smoke; collision
shapes are built from the base mesh at `frame_start`; resting bodies go to sleep.

## Generators, layout and scattering

**Generators** (`list_operators {category: "Generators"}`) make complete meshes at real size with
named material slots: `object.generate_terrain`, `generate_rock`, `generate_tree` (`DECIDUOUS`,
`CONIFER`, `PALM`), `generate_bush`, `generate_grass_tuft`, `generate_flower`, `generate_cloud`,
`generate_blob`, `generate_building` (`FLAT`, `GABLE`, `HIP` roofs), `generate_arch`,
`generate_column`, `generate_stairs`, `generate_fence` (along points with per-point heights),
`generate_pipe` (along points), `generate_table`, `generate_chair`, `generate_shelf`,
`generate_barrel`, `generate_wheel`, `generate_gear`, `generate_spring`. Their results report
`dimensions`, world `bounds` and `material_slots`. They run in Object Mode, place the object at the
3D cursor unless you pass `location`, and refuse meshes over 1,000,000 faces. `generate_cloud`
makes one connected cloud at any proportions (flat layers, long streaks), so generate clouds at
their final size instead of scaling small ones.

**Placing things** (category Layout):

- `object.drop_to_ground {objects, surface: ["Terrain"], align_to_normal}` lowers objects onto
  what is below them (`surface` is a list; without it any visible surface, else the plane z = 0).
  A parent drops together with its children.
- `scene.raycast {origin, direction, objects}` returns hit point and normal. Batch many raycasts
  in one `batch` to read terrain heights (the lighthouse path and fence), or read a whole
  heightmap with `get_mesh_data {include: ["heightmap"]}`.
- `object.snap_to_surface`, `object.align`, `object.distribute`, `object.dimensions_set`,
  `object.array_place` (`LINE`, `GRID`, `CIRCLE`; linked copies by default) and
  `object.randomize_transform`. The last keeps Blender's defaults, which randomize the scale
  between 0× and 2×: pass `use_scale: false` or small values.

**Scattering**:

- `object.scatter_add {surface, objects, count, seed, min_distance}` (plus `size`, `size_random`,
  `rotation_random`, `align_to_normal`, `vertex_group`, `name`) adds a particle system that
  instances the source objects (up to 200,000 instances in a scene). Instances cost far less than
  real objects and render and export, but each one drawn still takes memory in a server render (it
  grows with the number of instances and the size of the source), and OBJ, STL and PLY exports
  write each one as a copy: when a server render or export runs out of memory, lower `count` or the
  source's detail. Instances are not objects: `get_scene` counts them under `counts.instances`, and
  `get_instances {object}` lists each one's source object and world transform (to check spacing,
  paths and beaches without making them real). The sources are hidden by default (`get_scene` lists
  them under `counts.not_rendered`). Each instance's origin sits on the surface, so sources should
  have their origin at the base (generators do; mesh primitives have it at the centre and sink
  halfway).
- Density maps are vertex groups: write one weight per surface vertex with
  `object.vertex_group_set_weights {object, group, weights}` and pass `vertex_group`. The
  lighthouse keeps trees off paths, beaches and building pads this way.
- `object.scatter_on_surface` places real, editable copies instead; `object.duplicates_make_real`
  turns instances into objects; `object.particle_system_add` / `_update` expose every particle
  setting.

## Render budgets

| Purpose                        | Typical settings (ranges the example scripts used while this guide was written)                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Layout check                   | `render_image {engine: "RASTER", width: 640}`                                                          |
| Motion check                   | `render_animation {format: "CONTACT_SHEET", engine: "RASTER", frame_step}` with 12–24 tiles            |
| Lighting and material preview  | `PATHTRACER`, 640×360, 16–64 samples, `denoise: true`, `time_limit` 45–60                              |
| Final still                    | `PATHTRACER`, 1280×720, 128–256 samples, `denoise: true`, `max_bounces` 6–10, `time_limit` 420–480     |
| Animation (contact sheet, GIF) | `PATHTRACER`, 320×180 tiles or 480×270 GIF frames, 6–32 samples, `denoise: true`, `time_limit` 200–600 |

- `RASTER` is for layout and motion, not for light: the server's rasterizer draws no shadows,
  takes glossy reflections from one probe in front of what the image centre shows (water, floors
  and large glossy tables far from that point can show reflections the path tracer does not), and
  no rasterizer lights anything with emissive meshes. Judge shadows, reflections, glass and mesh
  lights in a small path-traced preview.
- Path tracing time grows with pixels × samples × bounces and with scene complexity. `time_limit`
  is wall-clock time: sampling stops when it is used up, after at least one sample per pixel. The
  result says what was reached (`samples` against `requested_samples`, `time_limit_reached`), so
  check it and raise the limit or lower the size or samples if needed.
- For animations `time_limit` covers the whole render. Every path-traced frame gets an equal share
  of what is left; frames that cannot start in time are dropped (`truncated: true`),
  `undersampled_frames` lists frames that stopped early and `frame_samples` the samples each frame
  reached. `frame_time_limit` caps one frame. Low sample counts work with `denoise: true`.
- Renders run in the server's shared render processes. At most two long renders (path-traced stills
  and animations) run at once across all agents and REST clients; others wait, while raster stills
  always get a render process of their own. The 600 s limit applies per call. A render or export
  that needs more memory than its render process has ends only that process: the server keeps
  running and starts a new one. The call fails with code `OUT_OF_MEMORY` (JSON after the message)
  and a message that starts "Rendering failed: out of memory: " (`render_animation`: "Rendering the
  animation failed: out of memory: ", `export_scene`: "Export failed: out of memory: ") and ends
  with what to lower. A server render or export loads and evaluates every mesh of the scene with its
  modifiers at their render settings, also meshes hidden from renders (`hide_render`) and, for an
  export, meshes it does not write and with `apply_modifiers: false`: lower the render levels
  (`render_levels`) of Subdivision Surface modifiers or the number of particle instances, or delete
  meshes the project no longer needs; or render in a browser editor that has the project open
  (`renderer: "browser"`; for an animation, its frames one by one with `render_image`). An export
  also needs less memory to write fewer `objects`, base meshes (`apply_modifiers: false`) or format
  `glb`. Another long render that waited in the same process fails with "Rendering failed:
  interrupted: …" and no code: it was not the cause, so run it again.
- Long renders send progress notifications; make your client's timeout reset on progress
  (`scripts/mcp.mjs` does). Disconnecting cancels the render.
- `seed` fixes the noise pattern, so two renders with the same settings are comparable.
- `view_transform` (`AGX` default, `STANDARD`, `FILMIC`, `ACES`, `NEUTRAL`) and `exposure` change
  the look of path-traced and `RASTER` renders alike (and of the editor's Rendered view, which
  uses the same curves and light units). The orrery uses `STANDARD` to keep a saturated sun; the
  product shot uses `NEUTRAL` for faithful product colours.
- In a browser, the web editor path traces on Web Workers (F12, Ctrl+F12). `render_image` path
  traces on the server unless you pass `renderer: "browser"`, which uses those workers of a
  connected editor; the result then does not report the samples reached. `render_animation`
  always renders on the server.
- A screenshot shows the viewport as the person sees it, in the viewport's shading unless you pass
  `shading`. `RENDERED` is rasterized like the Rendered viewport, never path traced, whatever the
  render engine. An editor without GPU acceleration (software WebGL, e.g. a headless browser) is
  slow with heavy scenes in `MATERIAL` or `RENDERED` shading: the first screenshot or viewport frame
  in each of them after it opened the project builds and compiles the scene's materials for that
  shading (13–38 s for a scene with 71 materials), and the editor keeps them, so later screenshots
  in that shading compile nothing and take 0.3–3.9 s, also after the viewport switched to it, turned
  its anti-aliasing off (for slow frames or more than a million triangles) or toggled X-ray, and
  after material edits that change values (colours, roughness, texture settings). An edit that needs
  a shader no material had (coat or sheen turned on, a procedural texture on a set of channels that
  no other material has) compiles it for the next screenshot or frame in each of these two shadings
  (0.6–4.2 s in that scene, up to 18 s for a material with several procedural textures). A `SOLID`
  or `WIREFRAME` screenshot (0.4–1.7 s for that scene) waits until the viewport's frame in progress
  is done, also one that compiles; the other commands wait while the editor's main thread is busy:
  during a screenshot, while it builds the materials after the viewport switched to `MATERIAL` or
  `RENDERED` for the first time and during each frame of a scene with millions of triangles. X-ray
  changes nothing in `MATERIAL` or `RENDERED` shading outside Edit Mode. A screenshot of a scene of
  millions of triangles takes half a second or more in any shading (0.5–5.3 s per `SOLID` screenshot
  with 4 million), and several times as long for the first `WIREFRAME` screenshot or frame of such a
  scene, while the editor builds the wires of every mesh. With the default `renderer: "auto"`,
  `render_image` waits 15 s for such an editor's raster image and then renders on the server (`note`
  says so); `renderer: "browser"` waits up to 55 s and then fails, saying what to do. For
  `editor_command` raise `timeout_ms` (default 10000, at most 55000: both stay under the 60 s an MCP
  client built on the TypeScript SDK waits by default) and take screenshots with `shading: "SOLID"`;
  for a quick look use `render_image {shading: "SOLID"}`: grey clay, which renders on the server
  while the editor is busy (right after a timeout) and when the scene's render engine is
  `PATHTRACER` (1.1–4.0 s at 1280×720 for that scene, 1.2–7.4 s for 2 million triangles, 2.2–14 s
  for 4 or 6 million); a scene that needs more memory than a server render has fails with "Rendering
  failed: out of memory: …" (`OUT_OF_MEMORY`), and then only a screenshot with a larger `timeout_ms`
  shows it. Make final images with `render_image`. These times are the ranges measured on a calm
  machine with 4 CPUs, the editor in software WebGL (SwiftShader), widened by 25 % (the longest
  `SOLID` screenshot with 4 million triangles by 50 %; [how](mcp.md#live-editors)); on a busy one
  (load averages of 3–15) the same steps took up to 3.5 times as long.
- An editor keeps drawing an image the server stopped waiting for, and its next renders and commands
  wait behind it; a screenshot that timed out still compiles what it needs and keeps it, so
  retrying it waits for the rest and compiles nothing again. Until it has finished,
  `render_image` uses another connected editor that is not busy, else `renderer: "auto"` renders on
  the server without asking it (`note` says so), and a timeout of `editor_command` or of a
  `renderer: "browser"` render names the earlier request it was still busy with: do not fire more
  requests at a busy editor. After an editor needed longer than `auto` waits for a raster image,
  `auto` renders on the server for 2 minutes without asking it (so it stays fast);
  `renderer: "browser"` still uses it.

## Exporting

- `export_scene {format: "glb"}` (or `gltf`, `obj`, `stl`, `ply`; `objects` for a subset,
  `apply_modifiers`, `frame`, `bake_resolution`) exports at your current frame unless you pass
  `frame`, and returns the file embedded (up to 20 MiB) with a download link and `elapsed_ms`. It
  runs in a server render process; a glTF export samples every frame of the scene range, so long
  ranges and large scenes take seconds. Always read `warnings`.
- The download link exports again when it is fetched, with the same format, objects,
  `apply_modifiers`, frame and `bake_resolution` (after later edits it gives the project as it is
  then); it needs the server's `AUTH_TOKEN` when one is set.
- OBJ, STL and PLY hold static, world-space meshes.
- <!-- re-check: gltf-export (matched packages/core/src/io/gltf-export.ts on 2026-11-07) --> glTF:
  hierarchy, materials (procedural textures baked to PNG), cameras, lights (area lights become
  point lights), instances, and animation sampled every frame over the scene range (keyframes,
  drivers, constraints, IK and physics as node transforms, with 2 or 4 keys per frame where a
  motion curves between frames; shape keys as morph targets; armature-deformed meshes as skins,
  also with `apply_modifiers: false`; other deformation baked to morph targets, every n-th frame
  beyond a size budget, with a warning). Sky, mist, the drivers and constraints themselves and
  animated camera, light, material and world properties are not exported (a warning names the
  properties; the file keeps their values at the export frame).
- Procedural bakes are sized per mesh at about 64 texels per metre of surface (512–2048 px),
  within a budget for the whole export, but never below 512 px. A material whose bake depends on
  the mesh (GENERATED or OBJECT mapping, bump) is baked once per distinct mesh and written as
  `Name`, `Name.001` …, so a large scene with many such meshes can still make a large file: pass a
  smaller `bake_resolution` (64–4096 px; it sets every bake and skips the budget). Pass a larger
  one when a large object (a terrain, a floor) looks blurry. Meshes without UVs, or with
  overlapping UVs, get generated UVs for those textures.
- The glTF exporter samples the evaluated motion itself, so live drivers and constraints export
  as they are: the orrery exports its driven gear train and the moon's Follow Path directly,
  extending the frame range by one frame for the export so the clip ends where it starts. To get
  plain keyframes (for another tool, or to edit the motion by hand), bake with
  `anim.bake_transforms` inside one batch and `undo` it afterwards to get the live setup back.

## Common errors and how to read them

Tool errors explain themselves; read the whole message, including the JSON after the first line.
Every failure of `run_operator` and `edit_mesh` has the same shape: the message on the first line,
then `{ok: false, operator, error, code, selection, …}`, where `selection` is your selection, active
object and mode, which the failed call left as they were. In a `batch` each failed operation is
`{operator, ok: false, error, code}` (a `selection` that cannot be applied: `error` starts with
`selection:`). Branch on `code`:

- `INVALID_PARAMS`: unknown, misspelled or invalid parameters: fix `params`;
- `POLL_FAILED`: wrong mode, selection or object type, or a `selection` that cannot be applied:
  `mode: "EDIT"` without an active mesh, `mesh` elements without `mode: "EDIT"`, an element index
  out of range, an edge `[a, b]` whose two vertices no edge of the mesh connects (edges join
  vertices that follow each other in a face of `get_mesh_data`, the last with the first, or are its
  `loose_edges`), lists that `select_mode` does not use (`EDGE` uses only `edges`, `FACE` only
  `faces`), `all: true` with lists; `edit_mesh` on an object that is not a mesh;
- `NOT_FOUND`: an unknown project, object, datablock or operator id. A misspelled operator id comes
  with the closest ids, letter case ignored, the ids it is the beginning of first (`wm.save` →
  `wm.save_mainfile`, `VIEW3D.VIEW_ALL` → `view3d.view_all`); an operator of the browser editor's
  own UI (`view3d.view_all`, `screen.animation_play`, `wm.save_mainfile`, `ed.undo`,
  `render.render`, Shift+D's `object.duplicate_move` …) with how to run it in a live editor:
  `editor_command` with `command: "run_operator"` and `params: {operator, params}`
  (`get_connected_clients` lists the editors), and what it does there. Where the tools do the same,
  the message names that first: use it, because in a live editor these operators act on the person's
  editor, not on your state: their selection, view, frame and undo history, windows on their screen,
  even their project (`wm.read_homefile` switches their editor to a new project, so the editor
  leaves yours before it can answer and `editor_command` reports that) and clipboard (`wm.share`),
  and the interactive ones wait for their mouse (`object.duplicate_move` duplicates
  the person's selection and leaves a move running). For an edit use `object.duplicate {offset}`
  instead of `object.duplicate_move`, `transform.translate` / `rotate` / `resize` instead of
  `view3d.transform_modal`, `edit_mesh` with `mesh.loopcut {edge}` instead of `mesh.loopcut_pick`,
  `undo` instead of `ed.undo`, `scene.frame_set` instead of `screen.frame_offset`, `create_project`
  instead of `wm.read_homefile`, `get_project` (`editor_url`) instead of `wm.share`;
- `FAILED`: the operator itself failed, or `render.render_software` / `render.render_animation`
  (use `render_image` / `render_animation`; `render.render` is a browser UI operator: `NOT_FOUND`);
- `OUT_OF_MEMORY`: the server's process would run out of memory: the operator was not run, or a mesh
  it reads was not loaded (`get_scene` lists such a mesh with `not_loaded`). The message says how
  much it needs, what is free and what to lower (where the operator has something to lower); a
  browser editor that has the project open runs it in its own memory. Renders and exports that ran
  out of memory carry this code too.

The message is always one line (line breaks in names show as `\n`), so the JSON starts on the
second line.

The codes come from the kind of error, never from the wording of the message.

| You see                                                                                               | Meaning and fix                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown parameter 'raduis' (did you mean 'radius'?). Valid parameters: …`                            | Misspelled or unsupported operator parameter; use a listed name                                                                                                                                                                                                                                                                                                                                                             |
| `unknown argument 'sampels' (did you mean 'samples'?). Valid arguments: …`                            | Misspelled tool argument; operator parameters go inside `params`                                                                                                                                                                                                                                                                                                                                                            |
| `unknown key 'fov' (did you mean 'lens' or 'fov_degrees'?) (valid keys: …) at view`                   | Misspelled key inside `view`, `selection` or a batch operation                                                                                                                                                                                                                                                                                                                                                              |
| `Input validation error: Invalid arguments for tool get_object: … at frame`                           | A tool argument of the wrong type or out of range (e.g. `time_limit` above 600)                                                                                                                                                                                                                                                                                                                                             |
| `unknown parameter 'objects'. Valid parameters: (none). This operator acts on the selected objects …` | A selection-based operator; pass `selection: {objects: [...]}`                                                                                                                                                                                                                                                                                                                                                              |
| `surface: Invalid input: expected array, received string`                                             | Wrong value type; check the schema (`list_operators {search}`)                                                                                                                                                                                                                                                                                                                                                              |
| `Operator requires Edit Mode`                                                                         | A `mesh.*` operator through `run_operator`; use `edit_mesh`                                                                                                                                                                                                                                                                                                                                                                 |
| `Unknown operator '…'. Did you mean: …`                                                               | Misspelled operator id (`NOT_FOUND`); use one of the suggested ids                                                                                                                                                                                                                                                                                                                                                          |
| `'view3d.view_all' is an operator of the browser editor's user interface … Run it there with …`       | An operator of the editor's UI (`NOT_FOUND`): use what it names instead, or `editor_command` in a live editor                                                                                                                                                                                                                                                                                                               |
| `Edit mode needs an active mesh object (selection.active): 'Camera' is a CAMERA object.`              | `mode: "EDIT"` needs a mesh as the active object (`POLL_FAILED`)                                                                                                                                                                                                                                                                                                                                                            |
| `'Camera' is not a mesh object.`                                                                      | `edit_mesh` works on mesh objects only (`POLL_FAILED`)                                                                                                                                                                                                                                                                                                                                                                      |
| `face index 99 out of range (mesh has 6 faces)`                                                       | An element index the base mesh does not have (`POLL_FAILED`); read indices with `get_mesh_data`                                                                                                                                                                                                                                                                                                                             |
| `edge [0, 3]: vertices 0 and 3 are not connected by an edge of the mesh: …`                           | Not an edge (`POLL_FAILED`): pick neighbours in a face of `get_mesh_data`, or a loose edge                                                                                                                                                                                                                                                                                                                                  |
| `select_mode 'FACE' selects only the listed faces, so the listed verts would be ignored: …`           | Lists the select mode does not use (`POLL_FAILED`): list only faces (`FACE`) or edges (`EDGE`), or pass the mode the message names (left out, `select_mode` is `FACE` for faces alone, `EDGE` for edges alone, else `VERT`); with `all: true` also leave `all` out                                                                                                                                                          |
| `'render.render_software' would render on the server's main thread …`                                 | Use `render_image` / `render_animation` (`FAILED`)                                                                                                                                                                                                                                                                                                                                                                          |
| `Object 'X' not found in project 'P'. Objects: …`                                                     | The name changed (`.001` suffix) or the object was deleted; use names from results                                                                                                                                                                                                                                                                                                                                          |
| `Several projects are named 'X' …`                                                                    | Pass the project id                                                                                                                                                                                                                                                                                                                                                                                                         |
| `A project named 'X' already exists (id …) …`                                                         | Names are unique, ignoring case: work in that project, delete it first or pick another name                                                                                                                                                                                                                                                                                                                                 |
| `selection.mesh selects vertices, edges or faces in Edit Mode: add mode 'EDIT' …`                     | Pass `mode: "EDIT"` with an element selection, or use `edit_mesh`                                                                                                                                                                                                                                                                                                                                                           |
| `'…' is not animatable on object. Animatable: …`                                                      | Key a listed path; use `data.` for light, camera, curve and mesh data and `material.` for materials                                                                                                                                                                                                                                                                                                                         |
| `'constraints["Nope"].influence' does not exist on object 'Cube': constraints has no "Nope" …`        | The path names something that does not exist; check names with `get_object`                                                                                                                                                                                                                                                                                                                                                 |
| `n of m operation(s) failed`                                                                          | Find the first `ok: false` in `results`; earlier operations were applied (one undo step reverts them)                                                                                                                                                                                                                                                                                                                       |
| `A path traced image of … is too large (at most 2621440 pixels …)`                                    | Render smaller                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Too many frames (…, at most 1000)`                                                                   | Raise `frame_step` or shorten the range                                                                                                                                                                                                                                                                                                                                                                                     |
| `No browser editor accepting UI commands is connected …`                                              | `editor_command` needs the project open in a browser                                                                                                                                                                                                                                                                                                                                                                        |
| `editor_command '…' failed: the editor did not answer within timeout_ms = 10000 ms (at most 55000) …` | Slow editor (first `MATERIAL`/`RENDERED` screenshot, first `WIREFRAME` one of millions of triangles, or after a material edit that needs a new shader): retry with a larger `timeout_ms` (it keeps what it compiled); screenshots `shading: "SOLID"`; quick look: `render_image {shading: "SOLID"}` (on the server while the editor is busy and for a `PATHTRACER` scene; if that runs out of memory, retry the screenshot) |
| `editor_command '…' failed: the editor's connection to this project closed before it answered …`      | Its page was closed or reloaded, it opened another project or lost its connection: whether it ran the command is unknown (`wm.read_homefile` gets its own message: the editor switched to the new project)                                                                                                                                                                                                                  |
| `browser render failed: the editor did not finish the RASTER image within 55 s …`                     | `renderer: "browser"` on a heavy scene: use `software` / `auto`, a smaller size or `shading: "SOLID"`                                                                                                                                                                                                                                                                                                                       |
| `browser render failed: Path tracing was not started: it needs about … GB of memory …`                | A `renderer: "browser"` path trace that would not fit into the editor tab's memory: lower the resolution or the triangles, use `RASTER`, or render on the server (`renderer: "software"`)                                                                                                                                                                                                                                   |
| `Rendering failed: out of memory: the render process ran out of its 2096 MB JavaScript heap; …`       | A server render needed more memory than its render process has (`OUT_OF_MEMORY`; the server keeps running): lower the render levels of Subdivision Surface modifiers or the particle instances (hiding meshes from renders does not help: they are evaluated too), or render in a browser editor (`renderer: "browser"`); `render_animation` and `export_scene` fail the same way with their own advice                     |
| `mesh.subdivide failed: not run on the server: it would need about … MB of JavaScript heap …`         | An operator that would not fit into the server's free heap (`OUT_OF_MEMORY`): lower what the message names, if it names something, or run it in a browser editor that has the project open                                                                                                                                                                                                                                  |
| `Nothing to undo in the history of this MCP session …`                                                | The session is new: send an agent id to undo across connections                                                                                                                                                                                                                                                                                                                                                             |
| HTTP 404 `Session not found`                                                                          | The session expired (30 minutes idle) or the server restarted: connect again                                                                                                                                                                                                                                                                                                                                                |

Problems that do not fail a call:

- `reports` with level `WARNING` (scaled objects under OBJECT-mapped textures, settings that do not
  apply, a driver that fails at the current frame);
- `errors` in operator results: constraints without targets or in cycles, particle system
  problems, driver errors;
- `get_scene` `problems`: every evaluation error in the scene, by object;
- path-traced results with `time_limit_reached`, or animations with `truncated` and
  `undersampled_frames`;
- `export_scene` `warnings`.

Pitfalls the example projects ran into:

- The selection persists: a selection-based operator without `selection` acts on what the last
  call selected (often the object you just added).
- Names are made unique (`Cube.001`): use the `name` a result returns.
- Operator parameters given as tool arguments fail the call, like misspelled tool arguments
  (`base_colour`, `rotaton`, `parms`): `run_operator {operator: "object.empty_add", name: "E"}`
  is rejected with a message that operator parameters go inside `params`.
- `transform_object` on an animated channel keys the new value at your current frame only: its keys
  at other frames stay, so the object still moves between them.
- `get_scene`, `get_object` and `render_image` use your current frame, which starts at 1.
- A scaled object stretches its OBJECT-mapped procedural textures: apply the scale first.
- Light that should be visible in the image needs an emissive surface.
- A scattered source with its origin at its centre sinks halfway into the surface.
- The default 4 cm collision margin is too large for small, closely spaced rigid bodies.
- `object.drop_to_ground` takes `surface` as a list.
- `time_limit` is capped at 600 s per render call; larger values are rejected.
- A `RASTER` preview of a scene lit by emissive meshes looks dark: only the path tracer lights
  with them.
- A held value keyed with two equal `BEZIER` keys (a light's energy, a material's roughness) can
  still be reported by `export_scene` as an animated property it does not export, from rounding;
  `LINEAR` or `CONSTANT` keys avoid it.

## Example projects

Five projects were built from nothing through MCP alone, and re-run on the final editor. Each
folder has a re-runnable `build.mjs` (it deletes and rebuilds its project, checks it and writes its
renders into the folder; `--export-only` writes `scene.glb` instead, and each script's header lists
its other modes; run it with `MCP_URL=http://host:port/mcp node examples/<name>/build.mjs`), the
outputs it produced (`render.png`, `contact_sheet.png`, `preview.gif`, `scene.glb`, `editor.png`)
and a README. The [examples index](../examples/README.md) summarizes each project, the editor
features and MCP tools it uses and how to rebuild it. The operator ids below are the best search
terms in the scripts.

### Lighthouse Cove

[Folder](../examples/lighthouse-cove/), [build.mjs](../examples/lighthouse-cove/build.mjs),
[README](../examples/lighthouse-cove/README.md). A coastal scene at dusk. Look for:
`object.generate_terrain` shaped with `sculpt.brush_stroke` (GRAB, FLATTEN); per-face ground zones
with `edit_mesh` and `object.material_slot_assign`; per-vertex colours computed in the script and
written with `paint.vertex_color_set_data`; heights from batched `scene.raycast`; a
flagstone path built with `curve.add_from_points` and `bevel_mode: "OBJECT"`;
`object.generate_fence` along points with heights; density maps written with
`object.vertex_group_set_weights` and used by `object.scatter_add`; `world.sky_set`,
`world.mist_set` and `object.generate_cloud`; lighthouse beams turned by `anim.driver_add` on
`frame`; a camera aimed by a `TRACK_TO` constraint.

### Clockwork Orrery

[Folder](../examples/clockwork-orrery/), [build.mjs](../examples/clockwork-orrery/build.mjs),
[README](../examples/clockwork-orrery/README.md). A brass orrery. Look for: one master channel
(`anim.keyframes_insert_many` with `anim.extrapolation_set` CYCLIC) and a `batch` of
`anim.driver_add` drivers with variables for every planet and gear ratio; `object.generate_gear`;
numerals and an engraved motto (`object.text_add`, `font.text_set`, `object.convert`, `BOOLEAN`);
a moon on `FOLLOW_PATH` timed with `constraint.followpath_path_animate`; depth of field; the
motion checked with `get_object` and clearances with `scene.measure` at several frames; the live
drivers and constraint exported directly to glTF over frames 1–49 for a seamless loop.

### Robot Workcell

[Folder](../examples/robot-workcell/), [build.mjs](../examples/robot-workcell/build.mjs),
[README](../examples/robot-workcell/README.md). A palletizing robot. Look for: parts from raw
geometry (`object.add_mesh_from_data` in batches); a rig from `object.armature_add`,
`armature.bone_update` and `armature.chain_add`; rigid parts parented with `type: "BONE"`; a hose
skinned with `ARMATURE_AUTO`; `pose.ik_add` (a three-bone chain) with a keyed target, per-bone IK
locks and limits (`pose.ik_settings_set`) that make it a palletizer, and a `DAMPED_TRACK` bone
constraint; a gripper shape key; a crate carried with `CHILD_OF` and keyed influence, its positions
read with `constraint.describe`; the IK error measured with `armature.describe`; `ARRAY` and
`MIRROR` modifiers; a driver on a material's `emission_strength`.

### Domino Cascade

[Folder](../examples/domino-cascade/), [build.mjs](../examples/domino-cascade/build.mjs),
[README](../examples/domino-cascade/README.md). Rigid-body physics. Look for: 60 dominoes laid out
with `object.array_place` and a batch of `object.transform_set`; a chute swept from a C-shaped
profile (`bevel_object`) and converted to a mesh; `rigidbody.object_add` with BOX, SPHERE, MESH,
CONVEX_HULL and CYLINDER shapes and small margins; `rigidbody.world_set` substeps; the topple order
checked with `rigidbody.describe` frame by frame; `rigidbody.bake_to_keyframes` verified against
the simulation; RASTER contact sheets from a second camera.

### Product Shot

[Folder](../examples/product-shot/), [build.mjs](../examples/product-shot/build.mjs),
[README](../examples/product-shot/README.md). A perfume bottle. Look for: lathed glass, liquid and
cap (profile curves with `SCREW`); transmission and IOR with a high `max_bounces`; a label of flat
2D curves and text built in one `batch`; a cyclorama from an extruded 2D curve; area-light
softboxes; depth of field focused on the label; `anim.turntable` with the studio parented to the
pivot; `view_transform: "NEUTRAL"`.

## What the editor does not have

Compared with Blender, these are missing; plan around them rather than searching for them:

- **Node editors**: no geometry nodes and no shader node editor. A material is one principled BSDF
  with at most one image or procedural texture per channel; there is no compositor or video
  sequencer.
- **Scripting**: no Python. Automation goes through MCP (the web app has a JavaScript console);
  drivers use a small expression language.
- **Object types**: meshes, curves, text, armatures, empties, cameras and lights only. No
  metaballs (`generate_blob` and `generate_cloud` produce meshes), NURBS surfaces, lattices,
  grease pencil, volumes, light probes or speakers.
- **Modifiers**: the 22 types above; no Remesh, Multiresolution, Skin, Lattice, Hook, Ocean or
  geometry-nodes modifiers.
- **Simulation**: rigid bodies without constraints or joints. No cloth, soft body, fluid, smoke,
  dynamic paint or hair. Particle systems are static scatters (no emission over time).
- **Animation and rigging**: Euler XYZ rotations only, no NLA or action library, no B-bones; bone
  constraints are limited to IK, Copy Rotation, Copy Location, Damped Track and Limit Rotation;
  object constraints to the 16 types listed above.
- **Rendering**: a CPU path tracer and rasterizers; no GPU path tracing, volumes, subsurface
  scattering, glass (refractive) caustics, motion blur, render passes or light linking. The
  denoiser is a simple filter, so very low sample counts stay blotchy. Animations come out as GIF,
  APNG, PNG sequences or contact sheets, not video files.
- **Text and UVs**: one built-in font without text boxes or word wrap; UV unwrapping is
  projection-based (Smart UV Project, cube, cylinder, sphere), without angle-based unwrapping.
- **Images**: no operator loads image textures through MCP.
