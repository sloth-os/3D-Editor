# Lighthouse Cove: "North Point"

An original coastal scene at dusk. An AI agent built it from nothing, using **only the editor's MCP
server**. `build.mjs` calls the same tools that any external agent gets: `run_operator`, `batch`,
`add_object`, `set_material`, `get_mesh_data`, `get_object`, `render_image`, `render_animation`
and others.

![Final path-traced still](render.png)

A small rocky island lies in a calm sea under a pink and violet twilight sky. A white lighthouse
with red bands stands on the headland. Its lantern glows, and two opposite beams sweep round over
the water. Below the lighthouse is the keeper's whitewashed cottage. Its windows are lit, warm
light falls on the ground in front of them, and a porch lamp burns by the door. A flagstone path
winds up from a sandy cove, past the cottage door, to the foot of the lighthouse, with a rail fence
on its seaward side; steps cut into the stone plinth climb the last metre to the lighthouse door.
A plank jetty and a rowing boat lie in the cove. A wooden sign at the head of the beach reads
**NORTH POINT**. Pines, bushes, rocks and dune grass are scattered over the island, but not on the
beach or the path. Thin cloud streaks lie low over the horizon.

| Beam sweep (24 frames, path traced) | Animated loop |
| --- | --- |
| ![Contact sheet](contact_sheet.png) | ![GIF](preview.gif) |

The outputs in this folder:

- `render.png`: the final still, 1280×720, path traced and denoised.
- `contact_sheet.png`: the 24 frames of the beam sweep, path traced.
- `preview.gif`: the same 24 frames as a seamless loop, 480×270 at 10 fps.
- `build.mjs`: the reproducible build.
- `scene.glb` comes from the export stage (`--export-only`). The glTF exporter is still being
  finished, so the file is generated in a later pass and is not part of this folder yet.

## Rebuild

Start a server on any port, then run the build against it:

```bash
cd /path/to/3D-Editor
PORT=4501 DATA_DIR=/tmp/lc-data node apps/server/dist/main.js &   # or any running editor server
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs                 # full run (11–15 min with RENDER_WORKERS=3, depending on the load)
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs --build-only    # scene + checks only (5–10 s)
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs --preview       # + RASTER and 16-spp previews in $TMPDIR/lighthouse-cove-preview (about 45 s)
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs --export-only   # scene + checks + scene.glb, no renders (about 20 s)
```

The script deletes any project called `lighthouse-cove`, creates it again empty, builds the whole
scene and checks it. The **default mode** then renders the outputs into this folder:
`render.png`, `contact_sheet.png` and `preview.gif`. It does not export `scene.glb`.

The flags:

- `--skip-final` skips the still.
- `--skip-anim` skips the animation.
- `--export` also exports `scene.glb` after the renders.
- `--out <dir>` writes the outputs to another folder (for example `--export-only --out /tmp/x`).
- `--keep` makes the script fail instead of deleting an existing project.
- `--check-all` adds the 2,600 grass tufts to the scatter placement check (4 s more).

Any tool error stops the build, and so does any operator WARNING, because a warning means that
some input was ignored. So does any failed check (next section). The layout and the main design
numbers are constants at the top of `build.mjs`: the terrain, the sculpt strokes, the path
waypoints, the steps, the fence spacing, the scatter settings, the camera, the sun, the mist and the
beam phase. The details (object sizes, colours, light energies, the cloud streaks) are written
where each part is built.

## The brief, element by element

| Requested | How it is built | Checked by |
| --- | --- | --- |
| Small rocky island | `object.generate_terrain` (64 m, 129² vertices, FBM noise, `island_falloff: 1`). Then `sculpt.brush_stroke` GRAB strokes raise the headland and the western hill and carve the cove, and FLATTEN dabs even out the building pads | `get_mesh_data` heightmap (−1.4 … 5.5 m) |
| Sand / grass / rock materials | `material.preset_apply` grass, rock and sand give each zone its own procedural texture, bump and roughness. Their colours are set to neutral greys with `material.procedural_set`, and the hue comes from **vertex colours**. A colour is computed for every vertex from its height above the sea, the slope and the distance to the path and buildings, with smooth noise breaking up the boundaries: a chain of six blends (lush grass → dry grass → worn earth → two rock greys → dry and wet sand). `paint.vertex_color_set` fills the base colour and each blend is **one** `paint.vertex_color_stroke` with one dab per vertex, placed off the vertex so that the brush falloff blends it by exactly the computed amount (7 operators in one `batch`; see the known limitations). The faces get a material slot from the average weights of their corners (`edit_mesh` + `object.material_slot_assign`), while the colour blends smoothly across the faces | The island exported with `export_mesh.ply` (its vertex colours, 8-bit): all 16,641 vertices within 1/255 of the computed colours |
| Calm sea | A 600 m plane with the `water` preset, made opaque and glossy (`material.update`), with a lighter teal SPHERICAL `GRADIENT` over the shallows | Visual |
| White lighthouse with red bands | Primitives (`add_object` cylinder, cone, uv_sphere, cube) plus a closed RAIL `object.generate_fence` for the gallery railing. The bands are one `WAVE` texture (BANDS along Z, CONSTANT ramp) in object space | Visual |
| Glowing lamp room | An emissive lamp, a warm POINT light and alpha-blended, faintly emissive lantern glass. The glass is BLEND rather than refractive, so the lamp light reaches the gallery, the railing and the roof (see the known limitations) | Path-traced crop |
| Keeper's cottage, GABLE roof | `object.generate_building {roof: GABLE, materials: false}` with our own materials in its five slots, on a stone foundation, with a brick chimney | Visual |
| Lit windows | One **RECTANGLE area light** per window, sized to the pane. The panes are found with `get_mesh_data {face_materials, face_centers, face_normals}` on the generated building, and the lights are added with `object.light_add {type: AREA, shape: RECTANGLE, size, size_y}` in one `batch`. A small porch lamp has its own POINT light | Path-traced crop |
| Winding stone path, with bevel, dropped onto the terrain | `curve.add_from_points` BEZIER with a 1.5 m flat profile (`bevel_mode: OBJECT`). The waypoints are resampled every 0.8 m and **dropped onto the ground** with batched downward `scene.raycast`s. Two more ray casts 0.7 m to the left and right of each point set a per-point **tilt**, so the path banks with the cross-slope. The flagstones are two VORONOI textures, CELL colour and DISTANCE_TO_EDGE bump. The headland falls about 1 m per metre in front of the lighthouse, so the path stops at the plinth and **steps cut into the plinth** lead to the door: a hidden box cuts a notch out of the plinth (`add_modifier` BOOLEAN DIFFERENCE) and four step blocks fill it (`object.transform_apply`, `object.join`, `object.rename`): 5 rises of 0.20 m and treads of 0.26 m from the top of the path end to the door sill | `get_mesh_data` of the evaluated path against the island heightmap: the highest point is 0.28 m above the ground (the build fails above 0.4 m) |
| Fence along part of it | `object.generate_fence {points: [x, y, z], materials: false}` 1.05 m to the seaward side of the upper path. Every post stands on a ray-cast ground height, sunk 0.1 m: the 13 fence points are at most 1.9 m apart, less than `post_spacing` (2.0 m), so the generator puts a post on each point and adds none in between | One-off: the 13 posts split out of the evaluated fence mesh, with `scene.raycast` at the four corners of each post: every corner is 0.05–0.15 m below the ground |
| Conifers, rocks, grass tufts, kept off the beach and the path | `object.generate_tree {CONIFER}` ×3, `generate_rock` ×3, `generate_grass_tuft` ×2 and `generate_bush` as sources. Per-vertex density maps are written as vertex groups (`object.vertex_group_set_weights`). Every vertex of the dry beach (sand faces above the waterline), the path, the building pads and the sign gets weight 0. Trees grow on the western hill and the northern slopes. Rocks lie along the shoreline, standing in the shallows, and on steep ground. Grass tufts grow all over the land and are densest just above the sand. They are scattered with `object.scatter_add {vertex_group, min_distance}`: 40 pines, 100 rocks, 2,600 tufts and 30 bushes | **Placement check** in `build.mjs`. Each system is made real for a moment (`object.duplicates_make_real` in a `batch` that hides the other systems), listed with `get_scene`, and the batch is undone. Closest pairs: pines 2.61 m (min_distance 2.6), rocks 1.38 m (1.3), bushes 2.22 m (2.2), and with `--check-all` tufts 0.32 m (0.32). None stands on the path or the dry beach; 48 of the rocks stand in the shallows |
| Wooden sign "NORTH POINT" on a post | A board on two posts, parented to an empty that is turned to face the camera. The letters are `object.text_add {body: "NORTH POINT", extrude}`. The wood grain is a distorted WAVE texture, applied after `object.transform_apply` of the board's scale | Visual |
| Sunset sky with a low sun, light mist | `world.sky_set {preset: SUNSET, sun_elevation: 0.04, sun_rotation: 4.22}` with custom zenith and horizon colours, and `world.mist_set {distance: 800}` (95 % at 800 m: the island stays clear, the far sea and the clouds fade into a lavender haze). The sun is behind the camera, low on the right, and lights the tower warm; the sky ahead is the pink and violet twilight side. Four thin cloud streaks come from `object.generate_cloud`, each generated small and stretched by its object scale. They glow in exactly the mist colour (see the known limitations for why) | Visual, plus a path-traced frame where a beam crosses the clouds |
| Rotating beam: a spot light driven from the frame | Two opposite SPOT lights (`add_object {type: light, light_type: SPOT}` with `spot_size`, `spot_blend`, `shadow_soft_size`). Each has an `anim.driver_add` on `rotation_euler[2]` with the expression `phase + (frame - 1) * pi / 24`: half a turn in 24 frames, so the pair loops seamlessly. The visible shafts are explained below | `get_object {frame}` at frames 1, 7, 13, 19 and 25. The evaluated heading of beam A is 81.9°, 126.9°, 171.9°, 216.9° and 261.9° (7.5° per frame), and frame 25 equals frame 1 with the beams swapped |
| Camera aimed with TRACK_TO at an empty near the lighthouse | `add_object empty` ("Camera Target") **on the lighthouse's axis**, 2.4 m above the door sill, + `object.constraint_add {type: TRACK_TO, target}` + `set_active_camera`. A **lens shift** (`shift_x` −0.105, `shift_y` 0.011, passed to `add_object camera`) moves the frame so that it is centred on a point between the cottage and the tower: the camera stays aimed at the lighthouse, which stands right of centre, and the cottage and the pines fit in. The shift is computed in `build.mjs` from the camera, target and centre positions | The camera's evaluated `world_transform` from `get_object` aims 0.002° off the target. Projected with it and the lens shift, the frame centre point lands at pixel (640.0, 360.0) of the 1280×720 frame and the lighthouse axis at (774, 374) |

**The beam shafts.** The path tracer has no volumes, so the light of the beams in the mist is
faked. Each beam has two nested open cones (`add_object cone`) parented to the spot light. The
cones are made of **index-matched glass**: transmission 1, IOR 1, roughness 0, white. Camera rays
pass straight through them and pick up their emission. The emission is a QUADRATIC_SPHERE
`GRADIENT` on the emission channel, so the shaft fades out with distance. The glow is added
deterministically, so the shafts are free of noise even at a few samples per pixel.

The earlier version of this project used an alpha-blended emissive cone. In the path tracer that
is stochastic coverage, so the shaft stayed grainy at 23 spp in the still and was mostly dots in
the 6-spp animation. A third, wider and fainter cone was also tried, to soften the edges of the
shafts; it made the beams wider and added a third visible band without softening them, so the
shafts keep two cones.

## Editor features this project exercises

- **Generators**: terrain, building (GABLE), fence (open path with z values, and a closed ring),
  conifer trees, rocks, grass tufts, a bush and clouds. Every generator whose default materials
  would be replaced runs with `materials: false`, so the project has no unused materials.
- **Sculpting**: GRAB and FLATTEN with `sculpt.brush_stroke`.
- **Vertex paint**: `paint.vertex_color_set` and `paint.vertex_color_stroke`. The renderers
  multiply the material base colour, including a procedural one, by the vertex colours.
- **Geometry read-back**: `get_mesh_data` for vertices, faces, face materials, face centres and
  normals in world space, the evaluated surface of a curve, and heightmaps; `export_mesh.ply` to
  read the painted vertex colours back.
- **Mesh editing**: `edit_mesh` with face selections (`object.material_slot_assign`) and vertex
  selections (`mesh.delete` turns a UV sphere into the boat hull), Boolean, Solidify, Wireframe
  and Smooth by Angle modifiers, `object.transform_apply`, `object.join`, `object.rename`,
  `object.shade_smooth`.
- **Materials**: presets, procedural textures (WAVE, VORONOI, GRADIENT, BRICK and NOISE presets)
  on the base_color, normal and emission channels, emission, transmission and alpha blending.
- **Lights and cameras by name**: every light setting is passed straight to `add_object` or
  `object.light_add`, including spot cone, blend, radius and area shape and size. The camera
  gets `lens`, `sensor_width`, `clip_end` and the lens shift.
- **Curves and text**: a bevel profile object, per-point tilt, `data.set_property` to hide the
  profile helper and the Boolean cutter, and extruded text.
- **Instancing**: `object.scatter_add` with vertex-group density and `min_distance`,
  `object.particle_system_update` (visibility), `object.duplicates_make_real` plus `undo` for the
  placement check, and `object.array_place` for the jetty posts.
- **Animation**: `anim.driver_add`, with evaluated values checked through `get_object {frame}`.
- **Constraints**: TRACK_TO.
- **World**: `world.sky_set` (the SUNSET preset with a low sun and custom zenith, horizon and
  ground colours) and `world.mist_set`.
- **Scene queries**: batched `scene.raycast`, plus `get_scene` counts, material users and
  `problems`.
- **Rendering**: `render_image` with the path tracer (ACES, denoise, time limit) and
  `render_animation` CONTACT_SHEET and GIF, path traced and denoised.
- **Export**: `export_scene {format: glb}` in the export stage.

The MCP tools it calls: `list_projects`, `delete_project`, `create_project`,
`set_scene_settings`, `run_operator`, `batch`, `add_object`, `transform_object`, `set_parent`,
`set_material`, `add_modifier`, `edit_mesh`, `get_mesh_data`, `get_object`, `get_scene`,
`set_active_camera`, `undo`, `render_image`, `render_animation` and `export_scene`.

Scene size: 71 objects (55 meshes, 2 curves, 1 text, 10 lights, 2 empties, 1 camera; the Boolean
cutter and the path profile are hidden), 40k vertices and 57k faces evaluated (79k triangles),
plus 2,770 scattered instances (2.5 M instance triangles). There are 33 materials, all in use,
and 2 drivers.

## Final production run

The final production run used a fresh server with an empty data directory and 3 render workers,
and ran the whole `build.mjs` in its default mode. It also proves that the project rebuilds from
scratch:

```bash
PORT=4551 DATA_DIR=<new empty dir> RENDER_WORKERS=3 node .phase3/app-v2/dist/main.js &   # a snapshot of the editor server
MCP_URL=http://127.0.0.1:4551/mcp node examples/lighthouse-cove/build.mjs
```

Measured on 2026-11-06. The run held the render lock from 12:24:50 to 12:39:58, and the
machine's 4 cores were shared with other agents (load average 7–12). Exit code 0:

| Stage | Settings | Time | Result |
| --- | --- | --- | --- |
| Build and checks | the whole scene, then the material, beam, path, colour, camera and placement checks | 6.8 s | all checks passed (island 3.0 s, of which 1.9 s are the vertex colours; checks 1.7 s) |
| Final still `render.png` | 1280×720, path tracer, 128 spp, 8 bounces, denoise, ACES, time limit 480 s | 480.7 s | **118 of 128 spp**, 3 threads, 0.63 MB |
| `contact_sheet.png` | 24 frames, 320×180 each, 6 columns, path tracer, 12 spp, denoise | 73.9 s | 24 frames, none dropped, 1.06 MB |
| `preview.gif` | 24 frames, 480×270, 10 fps, path tracer, 16 spp, denoise, Floyd–Steinberg dither | 344.9 s | 24 frames, none dropped, 0.97 MB |
| **Total** | | **906.4 s (15.1 min)** | |

The still stopped at its 480 s time limit after 118 of the 128 requested samples per pixel, and
the GIF took more than twice as long as in the previous final run (156 s): other agents' renders
kept the machine busy. The previous final run reached all 128 samples in 460 s at a load average
of 6–9; with denoising, the difference is not visible. The saved project (`document.ybin` in the
server's data directory) is 23.0 MB. Since this run, only a section comment in `build.mjs` has
changed.

## Known limitations

They describe the editor snapshot that the final run used (`.phase3/app-v2`). The editor's current
source already changes three of them: shadow rays and the mist pass through glass, and vertex
colours can be set from data (`paint.vertex_color_set_data`). A rebuild on a newer server can
therefore look slightly different (for example, the shafts would no longer shade the top of the
tower around frame 22).

- **The spot lights light almost nothing visible.** The beams point out to sea and pass over
  the island, and the path tracer has no participating media, so the visible beams are the
  emissive glass shafts described above. The spot lights exist and turn as the brief asks. The
  shaft walls also block most of their light (see the next point).
- **Glass is opaque to light in the path tracer.** This includes the index-matched IOR-1 glass of
  the shafts. Camera rays pass through it, but shadow rays do not. As a result:
  - The shafts cast shadows. Once per loop, around frame 22, a beam points straight at the low
    sun and the top of the tower is briefly shaded. The beam phase is chosen so that this never
    happens in the still.
  - The lantern glass is alpha-blended rather than refractive. Refractive glass would keep the
    lamp light inside the lantern.
- **The path tracer loses the mist behind glass.** It applies the world mist once per camera
  ray, using the depth of the first surface hit. When that surface is glass (the shafts, but
  also any window), whatever is seen through it gets the mist of the glass's depth, which is
  almost none. Two consequences:
  - Lit clouds behind a passing beam lost their mist and showed up dark brown. RASTER gets this
    right. The workaround: the clouds sit 830–1000 m away, where the mist covers 96–99 % of their
    own shading anyway, so they have a black base colour and emit exactly the mist colour. They
    look the same with or without mist, so they look the same through a beam. The price is that
    they are flat, with no lit and shaded sides; a fifth, high cloud that read as flat cut-out
    blobs was dropped.
  - The sky has no mist, but sky seen through a shaft gets the 1–3 % mist of the shaft's depth.
    Where the outer cone ends against the sky (the far end of the left beam in the still), this
    shows as a faint, hard-edged elliptical cap, 2–3 levels (of 255) lighter than the sky around
    it. The shaft's own glow has faded to zero there, so a shorter or faster fade does not remove
    it.
- **RASTER previews show the beams as solid bright tubes.** The software rasterizer ignores the
  procedural emission of transmissive materials. `--preview` therefore also renders a small
  path-traced image, which is cheap because the shafts need few samples.
- **The sea is opaque.** Transmissive water would show the square border of the terrain 0.6 m
  under the surface, and the path tracer does not light a sea bed through refracting water. The
  sea therefore shows reflections plus a teal tint over the shallows, without real
  shallow-water transparency.
- **The ground zones switch per face.** The colours blend smoothly, through vertex colours, but
  the texture and bump of the grass, rock and sand materials still change at face edges of the
  0.5 m grid. At this camera distance the change is not visible.
- **There is no operator to set vertex colours from data** in the editor snapshot this project is
  built with. The colours are painted with brush dabs instead: each dab sits next to its vertex at
  the distance where the brush falloff (smoothstep) gives exactly the wanted blend, with a radius
  small enough to touch no other vertex. This relies on the documented falloff, so the build
  checks the result through a PLY export. (The repository's current source adds
  `paint.vertex_color_set_data`, which would replace the trick with one call.)
- **The synced document keeps every replaced mesh layer.** Each operator that changes the
  16,641-vertex island adds a whole new copy of the attribute layers it changes (up to 1.4 MB) to
  the project's document, and the old copies are never dropped. After it is generated, the
  island is changed by 19 operators (6 sculpt strokes, 7 paint operators, 2 material slot
  assignments and 4 vertex groups), and the saved project is 23.0 MB. The previous version
  painted the colours with 145 strokes, one per quantised colour, and saved as 213 MB, which the
  web editor had to download before it could show the project.
- **Scatter positions can only be checked indirectly.** No MCP tool lists where the instances of
  a particle system are, so the placement check makes each system real and undoes it. The 2,600
  grass tufts are only checked with `--check-all`, to keep the default build light.
- **The path still floats slightly in places.** It is banked with the ground, but on the steep
  final stretch below the lighthouse it floats up to 0.28 m above the terrain, against 0.11 m for
  a perfect fit.
- **Depth of field is not used.** With a 26 mm lens, focus on the lighthouse about 48 m away and
  everything else 11–60 m away (and the clouds far beyond), the circle of confusion stays at about
  one pixel or less even at f/1.4. `camera.properties_set {dof_use, dof_focus_distance,
  dof_aperture_fstop}` would therefore have no visible effect on this wide shot.
- **`scene.glb` is regenerated later.** The present exporter writes about 6.3 MB in 12 s, bakes
  procedural textures to PNG and exports the window area lights as point lights. glTF has no lens
  shift, so the exported camera is centred on the lighthouse. It says both in its warnings.
  Drivers, the sky and the mist are not part of glTF.
