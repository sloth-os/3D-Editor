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
winds up from a sandy cove, past the cottage door, to the lighthouse door, with a rail fence on
its seaward side. A plank jetty and a rowing boat lie in the cove. A wooden sign at the head of
the beach reads **NORTH POINT**. Pines, bushes, rocks and dune grass are scattered over the
island, and thin cloud streaks catch the last light low over the horizon.

| Beam sweep (24 frames, path traced) | Animated loop |
| --- | --- |
| ![Contact sheet](contact_sheet.png) | ![GIF](preview.gif) |

The outputs in this folder:

- `render.png`: the final still, 1280×720, path traced.
- `contact_sheet.png`: the 24 frames of the beam sweep.
- `preview.gif`: the same 24 frames as a seamless loop, 480×270.
- `build.mjs`: the reproducible build.
- `scene.glb`: written by the export stage (see below).

## Rebuild

Start a server on any port, then run the build against it:

```bash
cd /path/to/3D-Editor
PORT=4501 DATA_DIR=/tmp/lc-data node apps/server/dist/main.js &   # or any running editor server
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs                 # full run
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs --build-only    # scene + checks only (~10–15 s)
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs --preview       # + RASTER and 16-spp previews in $TMPDIR/lighthouse-cove-preview
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs --export-only   # scene + checks + scene.glb, no renders
```

The script deletes any project called `lighthouse-cove`, creates it again empty, builds the whole
scene and checks it. The **default mode** then renders the outputs into this folder:
`render.png`, `contact_sheet.png` and `preview.gif`. It does not export `scene.glb`.

The flags:

- `--skip-final` skips the still.
- `--skip-anim` skips the animation.
- `--export` also exports `scene.glb` after the renders.
- `--out <dir>` writes the outputs to another folder.
- `--keep` makes the script fail instead of deleting an existing project.

Any tool error stops the build, and so does any operator WARNING, because a warning means some
input was ignored. Every design number is a constant at the top of `build.mjs`: the layout, the
sculpt strokes, the path waypoints, the camera, the sun and the beam phase.

## The brief, element by element

| Requested | How it is built | Checked by |
| --- | --- | --- |
| Small rocky island | `object.generate_terrain` (64 m, 129² vertices, FBM noise, `island_falloff: 1`). Then `sculpt.brush_stroke` GRAB strokes raise the headland and the western hill and carve the cove, and FLATTEN dabs even out the building pads | `get_mesh_data` heightmap (−1.4 … 5.5 m) |
| Sand / grass / rock materials | `material.preset_apply` grass, rock and sand give each zone its own procedural texture, bump and roughness. Their colours are set to neutral greys with `material.procedural_set`, and the hue comes from **vertex colours**. A colour is computed for every vertex from its height above the sea, the slope and the distance to the path and buildings, with smooth noise breaking up the boundaries. The vertices are painted with `paint.vertex_color_stroke`, one dab per vertex (145 colours in one `batch`). The faces get a material slot from the average weights of their corners (`edit_mesh` + `object.material_slot_assign`), while the colour blends smoothly across the faces | Path-traced crops (no blocky beach edge) |
| Calm sea | A 600 m plane with the `water` preset, made opaque and glossy (`material.update`), with a lighter teal SPHERICAL `GRADIENT` over the shallows | Visual |
| White lighthouse with red bands | Primitives (`add_object` cylinder, cone, uv_sphere, cube) plus a closed RAIL `object.generate_fence` for the gallery railing. The bands are one `WAVE` texture (BANDS along Z, CONSTANT ramp) in object space | Visual |
| Glowing lamp room | An emissive lamp, a warm POINT light and alpha-blended, faintly emissive lantern glass. The glass is BLEND rather than refractive, so the lamp light reaches the gallery, the railing and the roof (see the known limitations) | Path-traced crop |
| Keeper's cottage, GABLE roof | `object.generate_building {roof: GABLE}`, given new materials, on a stone foundation, with a brick chimney | Visual |
| Lit windows | One **RECTANGLE area light** per window, sized to the pane. The panes are found with `get_mesh_data {face_materials, face_centers, face_normals}` on the generated building, and the lights are added with `object.light_add {type: AREA, shape: RECTANGLE, size, size_y}` in one `batch`. A small porch lamp has its own POINT light | Path-traced crop |
| Winding stone path, with bevel, dropped onto the terrain | `curve.add_from_points` BEZIER with a 1.5 m flat profile (`bevel_mode: OBJECT`). The waypoints are resampled every 0.8 m and **dropped onto the ground** with batched downward `scene.raycast`s. Two more ray casts 0.7 m to the left and right of each point set a per-point **tilt**, so the path banks with the cross-slope. The flagstones are two VORONOI textures, CELL colour and DISTANCE_TO_EDGE bump | `get_mesh_data` of the evaluated path against the island heightmap: the highest point is 0.31 m above the ground (0.56 m without banking) |
| Fence along part of it | `object.generate_fence {points: [x, y, z]}` 1 m to the seaward side of the upper path, with every post on a ray-cast ground height | Visual |
| Conifers, rocks, grass tufts, kept off the beach and the path | `object.generate_tree {CONIFER}` ×3, `generate_rock` ×3, `generate_grass_tuft` ×2 and `generate_bush` as sources. Per-vertex density maps are written as vertex groups (`object.vertex_group_set_weights`): no trees on the sand, the path, the pads or the open slopes; rocks on the shoreline and steep ground; dune grass along the sand edge. They are scattered with `object.scatter_add {vertex_group, min_distance}` | `scatter_add` results: 40 pines, 110 rocks, 2600 tufts, 30 bushes |
| Wooden sign "NORTH POINT" on a post | A board on two posts, parented to an empty that is turned to face the camera. The letters are `object.text_add {body: "NORTH POINT", extrude}`. The wood grain is a distorted WAVE texture, applied after `object.transform_apply` of the board's scale | Visual |
| Sunset sky with a low sun, light mist | `world.sky_set {preset: SUNSET, sun_elevation: 0.04, sun_rotation: 4.22}` with custom zenith and horizon colours, and `world.mist_set {distance: 800}`. Five thin cloud streaks come from `object.generate_cloud`, each generated small and stretched by its object scale | Visual |
| Rotating beam: a spot light driven from the frame | Two opposite SPOT lights (`object.light_add` with `spot_size`, `spot_blend`, `shadow_soft_size`). Each has an `anim.driver_add` on `rotation_euler[2]` with the expression `phase + (frame - 1) * pi / 24`: half a turn in 24 frames, so the pair loops seamlessly. The visible shafts are explained below | `get_object {frame}` at frames 1, 7, 13, 19 and 25. The evaluated heading of beam A is 81.9°, 126.9°, 171.9°, 216.9° and 261.9° (7.5° per frame), and frame 25 equals frame 1 with the beams swapped |
| Camera aimed with TRACK_TO at an empty near the lighthouse | `add_object empty` ("Camera Target") + `object.constraint_add {type: TRACK_TO, target}` + `set_active_camera` | The camera's evaluated `world_transform` from `get_object` aims 0.001° off the target |

**The beam shafts.** The path tracer has no volumes, so the light of the beams in the mist is
faked. Each beam has two nested open cones (`add_object cone`) parented to the spot light. The
cones are made of **index-matched glass**: transmission 1, IOR 1, roughness 0, white. Camera rays
pass straight through them and pick up their emission. The emission is a QUADRATIC_SPHERE
`GRADIENT` on the emission channel, so the shaft fades out with distance. The glow is added
deterministically, so the shafts are free of noise even at a few samples per pixel.

The earlier version of this project used an alpha-blended emissive cone. In the path tracer that
is stochastic coverage, so the shaft stayed grainy at 23 spp in the still and was mostly dots in
the 6-spp animation.

## Editor features this project exercises

- **Generators**: terrain, building (GABLE), fence (open path with z values, and a closed ring),
  conifer trees, rocks, grass tufts, a bush and clouds.
- **Sculpting**: GRAB and FLATTEN with `sculpt.brush_stroke`.
- **Vertex paint**: `paint.vertex_color_set` and `paint.vertex_color_stroke`. The renderers
  multiply the material base colour, including a procedural one, by the vertex colours.
- **Geometry read-back**: `get_mesh_data` for vertices, faces, face materials, face centres and
  normals in world space, the evaluated surface of a curve, and heightmaps. It replaces the OBJ
  export and parsing of the first version.
- **Materials**: presets, procedural textures (WAVE, VORONOI, GRADIENT, BRICK and NOISE presets)
  on the base_color, normal and emission channels, emission, transmission and alpha blending.
- **Lights and cameras by name**: every light setting is passed straight to `object.light_add`,
  including spot cone, blend, radius and area shape and size. The camera gets `lens` and
  `clip_end`. These replace the single-keyframe workaround of the first version.
- **Curves and text**: a bevel profile object, per-point tilt, `data.set_property` to hide the
  profile helper, and extruded text.
- **Instancing**: `object.scatter_add` with vertex-group density and `min_distance`;
  `object.array_place` for the jetty posts.
- **Animation**: `anim.driver_add`, with evaluated values checked through `get_object {frame}`.
- **Constraints**: TRACK_TO.
- **Scene queries**: batched `scene.raycast`, plus `get_scene` counts and `problems`.
- **Rendering**: `render_image` with the path tracer (ACES, denoise, time limit) and
  `render_animation` CONTACT_SHEET and GIF, path traced and denoised.

Scene size: 70 objects (54 meshes, 2 curves, 1 text, 10 lights, 2 empties, 1 camera), 44k
vertices and 64k faces evaluated (86k triangles), plus 2,780 scattered instances (2.5 M instance
triangles). There are 43 materials and 2 drivers.

## Final production run

The final production run used a fresh server with an empty data directory and 3 render workers,
and ran the whole `build.mjs` in its default mode. It also proves that the project rebuilds from
scratch:

```bash
PORT=4551 DATA_DIR=<fresh dir> RENDER_WORKERS=3 node .phase3/app-v2/dist/main.js &
MCP_URL=http://127.0.0.1:4551/mcp node examples/lighthouse-cove/build.mjs
```

FINAL_RUN_TIMINGS

## Known limitations

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
- **There is no operator to set vertex colours from data.** Each vertex is painted with its own
  small `paint.vertex_color_stroke` dab, with the colours quantised to 145 values. This takes 7–9
  s of the build.
- **The path still floats slightly in places.** It is banked with the ground, but on the steep
  final stretch below the lighthouse it floats up to 0.31 m above the terrain, against 0.11 m for
  a perfect fit.
- **Depth of field is not used.** With a 26 mm lens and everything 15–60 m away, the circle of
  confusion stays below one pixel even at f/1.4, so `camera.properties_set {dof_use}` would have
  no visible effect.
- **`scene.glb` comes from the export stage.** Run `--export-only` or add `--export`. The glTF
  exporter is still being finished, so the file is regenerated in a later pass. The present
  exporter writes about 6.2 MB, bakes procedural textures to PNG and exports area lights as
  point lights. Drivers, the sky and the mist are not part of glTF.
