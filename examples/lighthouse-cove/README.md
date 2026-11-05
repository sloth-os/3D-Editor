# Lighthouse Cove — "North Point"

An original coastal scene at dusk, built from nothing by an AI agent **only through the editor's
MCP server** (`build.mjs` uses the same tools any external agent gets: `run_operator`, `batch`,
`add_object`, `set_material`, `edit_mesh`, `insert_keyframe`, `render_image`, …).

![Final path-traced still](render.png)

A small rocky island sits in a calm sea under a violet twilight sky. A white lighthouse with red
bands stands on the headland, its lantern glowing and two beams sweeping round. Below it are the
keeper's whitewashed cottage with lit windows, and a flagstone path that winds up from a sandy cove
past the cottage door to the lighthouse, with a rail fence on the seaward side. A plank jetty and a
rowing boat lie in the cove, and a painted sign at the head of the beach reads **NORTH POINT**.
Pines, bushes, rocks and dune grass are scattered over the island, and low pink-lit clouds sit on
the horizon.

| Beam animation (24 frames, path traced) | Animated loop |
| --- | --- |
| ![Contact sheet](contact_sheet.png) | ![GIF](preview.gif) |

Outputs: `render.png` (1280×720, path traced), `contact_sheet.png` (24 frames),
`preview.gif` (480×270, 24-frame seamless loop), `scene.glb` (the whole scene incl. scattered
instances), `build.mjs` (the reproducible build).

## Rebuild

```bash
# start a server (any port), then:
MCP_URL=http://127.0.0.1:4501/mcp node examples/lighthouse-cove/build.mjs
```

The script deletes an existing project called `lighthouse-cove`, recreates it empty and builds
everything, then renders and exports into this folder. Flags: `--preview` (build plus one RASTER
preview written to `$TMPDIR/lighthouse-cove-preview/`, nothing written here), `--skip-final`,
`--skip-anim`, `--skip-export`. Every design number (layout, sculpt strokes, path waypoints, camera,
sun) is a constant at the top of `build.mjs`.

## How it is built (and what it demonstrates)

| Step | Tools / operators |
| --- | --- |
| Project reset, render settings (path tracer, 128 spp, denoise, ACES, exposure, frame range) | `list_projects`, `delete_project`, `create_project {empty}`, `set_scene_settings` |
| **Island**: 64 m noise heightfield with island falloff (border at z = 0), shaped with sculpt GRAB strokes (raise the headland and western hill, carve the cove) and FLATTEN pads for the buildings | `object.generate_terrain`, `sculpt.brush_stroke` (GRAB, FLATTEN) |
| **Geometry read-back**: the terrain is exported as OBJ and parsed into a heightmap, then used for zones, heights and density maps | `export_scene {format: obj, objects}` |
| **Ground materials**: per-face zones (sand by height with a jittered edge, wider in the cove; rock by slope; grass elsewhere) assigned in Edit Mode on face selections; presets with procedural colour + bump | `material.preset_apply` (grass, rock, sand), `edit_mesh` + `object.material_slot_assign` |
| **Sea**: 600 m plane with the water preset (procedural ripples), made opaque and dark so the terrain border under it cannot show | `add_object plane`, `material.preset_apply water`, `material.update` |
| **Lighthouse** from primitives: plinth, tapered tower (cone), gallery, lantern glass, wire-frame lantern mullions, lamp, roof, vent, lightning rod, door and windows aligned to the path; circular railing from the fence generator | `add_object` (cylinder, cone, uv_sphere, cube), `object.generate_fence {closed}`, modifiers WIREFRAME, SMOOTH_BY_ANGLE |
| **Red bands**: a WAVE texture (BANDS along Z, CONSTANT ramp) in object space | `material.procedural_set` (WAVE) |
| **Glowing lamp room**: emissive lamp, warm point light, transmissive lantern glass, lit tower windows | `set_material` (emission, transmission), `add_object light` |
| **Rotating beam**: two opposite SPOT lights with visible shafts (long open cones with emission + alpha, faded with distance by a SPHERICAL GRADIENT on the alpha channel, parented to the spots). Their heading is a **driver on `rotation_euler[2]`** (`1.1 + (frame - 1) * pi / 24`): half a turn in 24 frames, so the pair loops seamlessly | `anim.driver_add`, `anim.driver_list`, `set_parent`, `transform_object`, `material.procedural_set` (GRADIENT on alpha) |
| **Keeper's cottage**: generated one-storey house with a GABLE roof, re-materialed (whitewash, slate, warm emissive windows); stone foundation and brick chimney (scale applied first, as the preset warning advises) | `object.generate_building`, `object.transform_apply`, `material.preset_apply` (rock, brick) |
| **Stone path**: Catmull-Rom resampled waypoints **dropped onto the terrain** with batched downward ray casts, built as a BEZIER curve swept along a flat 1.5 m rectangular bevel profile; flagstones from two VORONOI textures (CELL colour, DISTANCE_TO_EDGE bump) | `batch` of `scene.raycast`, `curve.add_from_points` (bevel_mode OBJECT), `material.procedural_set` (VORONOI) |
| **Fence** along the upper path, offset 1 m to the seaward side, each post at the ray-cast ground height | `object.generate_fence {points [x,y,z]}` |
| **Sign**: two posts, a board and extruded 3D text "NORTH POINT", parented to an empty that is turned to face the camera | `object.text_add`, `set_parent`, `transform_object` |
| **Jetty and boat**: plank deck (BRICK texture as planks), posts repeated with array_place, a dinghy made from the lower half of a UV sphere (upper vertices deleted in Edit Mode) with a Solidify modifier and two thwarts | `object.array_place`, `edit_mesh mesh.delete`, `add_modifier SOLIDIFY`, `material.procedural_set` (BRICK) |
| **Vegetation and rocks**: 3 conifers, 3 rocks, 2 grass tufts and a bush generated as sources; per-vertex density maps written as vertex groups (no trees on the beach, the path, the pads or the open slopes in front of the cottage; rocks on the shoreline and steep ground; dune grass along the sand edge); scattered as instances with `min_distance` | `object.generate_tree {CONIFER}`, `generate_rock`, `generate_grass_tuft`, `generate_bush`, `object.vertex_group_set_weights`, `object.scatter_add {vertex_group, min_distance}` |
| **Sky and atmosphere**: SUNSET preset with a very low sun behind the camera, custom zenith/horizon colours, light mist, four distant cumulus clouds | `world.sky_set`, `world.mist_set`, `object.generate_cloud` |
| **Camera**: aimed with a TRACK_TO constraint at an empty beside the lighthouse | `add_object empty/camera`, `object.constraint_add {TRACK_TO}`, `set_active_camera` |
| **Checks and outputs**: scene problems, driver values at frames 1/7/13, camera constraint errors; path-traced still, path-traced contact sheet and GIF, GLB export | `get_scene`, `anim.driver_list`, `get_object`, `render_image`, `render_animation`, `export_scene` |

Scene size: 59 objects (50 meshes, 2 curves, 1 text, 3 lights, 2 empties, 1 camera),
about 30k vertices / 38k faces of real geometry plus about 2,780 scattered instances (40 pines,
110 rocks, 2,600 grass tufts, 30 bushes), 41 materials and 2 drivers.

## Render times

RENDER_TIMES_PLACEHOLDER

## Known limitations and workarounds

- **Light settings through keyframes.** `data.set_property` cannot address a light by name, and
  no tool exposes light datablock ids. So `spot_size`, `spot_blend` and `shadow_soft_size` are set
  with a single keyframe at frame 1 (`insert_keyframe data.spot_size`). It acts as a constant, but
  leaves one-key F-curves on the light data.
- **Geometry read-back via OBJ.** There is no tool that returns vertex positions, so the terrain
  heights come from parsing an OBJ export (Y-up, `v x z -y`).
- **Opaque sea.** The water preset is transmissive, which shows the terrain's square border 0.6 m
  under the surface. The sea is made opaque (reflections only), so there is no shallow-water colour
  near the beach.
- **Faked beam volume.** The path tracer has no volumes, so the spot lights' cones are not visible
  in the mist. The visible shafts are emissive, alpha-blended cones, and the spots light only what
  they hit (here mostly the far sea).
- **Stepped beach edge.** Ground zones are assigned per face on a 0.5 m grid. A jittered threshold
  and dune grass hide most of the stepping, but the sand/grass edge is still slightly blocky up close.
- **Animations are path traced at 6 spp.** The RASTER engine draws the low-alpha beam shafts as a
  dotted (Bayer screen-door) pattern, so the beam animation uses low-sample path tracing. The
  frames are noisy (the alpha shafts especially) but readable.
- **Flat path profile.** The profile stays level across the path (twist Z_UP). It is 0.32 m deep
  and partly buried, so cross-slopes hide its sides, but the path does not tilt with the ground.
- **`get_object` at a frame** reports stored transforms, so the driven beam rotation is checked
  with `anim.driver_list {frame}`.
- **Approximate GLB.** `scene.glb` contains all objects and the particle instances (as nodes that
  share meshes). Procedural textures are baked to 512² PNGs; lights and emission are exported, but
  the drivers, the sky and the mist are not.
