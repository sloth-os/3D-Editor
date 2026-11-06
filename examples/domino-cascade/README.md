# Domino Cascade

An original rigid-body physics showcase built entirely through the editor's MCP server by
[`build.mjs`](build.mjs): a blue glass marble rolls down a curved aluminium chute that winds down
from a tower of toy blocks, shoots off the lip and knocks over the first of **60 rainbow-coloured
plastic dominoes** standing along an S-curve on an oak table. The whole chain topples in order;
the marble bounces back and comes to rest under the lip.

![Path-traced still, mid-cascade (frame 55)](render.png)

| Animation (showcase camera) | |
| --- | --- |
| ![Cascade GIF](preview.gif) | `preview.gif`: 48 frames (1–95, every 2nd), 480 × 270, path traced and denoised. The showcase camera starts close on the chute while the marble rolls, then pulls back to the full S while the wave runs. |

[`contact_sheet.png`](contact_sheet.png) shows every 4th frame (4–96) through the same camera.
`scene.glb` is the baked, animated scene from an earlier export pass (it is regenerated with the
finished glTF exporter by `--export-only`, see below).

## The scene

All sizes are real-world metres, Z up. 80 objects, 18 k render triangles, 70 materials.

* **Table** – `object.generate_table` (2.6 × 1.5 m, top at 0.75 m). Its `Wood` material is
  rewritten as satin oak boards: a `BRICK` procedural on the base colour (one random tone per
  1.3 m × 0.19 m board, hair-line seams), a fine grain along the boards as a 0.15 mm bump (a
  `WAVE` procedural: saw-tooth bands about 14 mm apart, wobbled by noise) and, with the same
  pattern, on the roughness (0.3–0.55), plus a light clear coat.
* **Dominoes** – 60 jumbo toy dominoes (80 × 40 × 14 mm, 47 g). One bevelled prototype
  (cube → `object.transform_apply` → `BEVEL` modifier applied → auto smooth → rigid body) is copied
  with `object.array_place` (linked duplicates, rigid body copied along); one `batch` renames the
  copies and moves each onto the S-curve `y = −0.35 sin(2π(x + 0.9) / 2)` with
  `object.transform_set`: equal 42.5 mm arc-length spacing (0.53 × height) and a Z rotation that
  follows the tangent. Each domino gets its own `glossy_plastic` preset material; the hues run
  red → orange → yellow → green → cyan → blue → violet → magenta with the same number of dominoes
  per segment (a linear hue ramp spends a third of the line on yellow-green).
* **Chute** – a closed 2D POLY curve (`Chute Profile`, a 3 mm thick 140° C-section of 22 mm inner
  radius) is the **bevel object** of a 3D Bezier path (`curve.add_from_points`, `twist_mode Z_UP`)
  computed in the script: a 0.15 m lead-in leaving the tower, a 132° left-hand bend of 0.24 m
  radius and a straight run-out aligned with the first domino. Its height falls as `(1 − u)²`
  (steep at the top, level at the lip). `object.convert` turns it into a mesh, the profile curve
  is deleted. Satin aluminium.
* **Supports** – three bevelled toy blocks (red, amber, blue) carry the top of the chute, four
  beech dowels (`mesh.primitive_cylinder_add`, `wood` preset recoloured) carry the bend.
* **Marble** – 28 mm sphere, `clear_glass` preset tinted blue, 29 g.
* **Room** – a dark walnut plank floor (`BRICK` procedural) and muted teal plaster walls that set
  off the warm oak and the saturated plastic.

### Lighting and cameras

* **Key Light** – AREA light, `shape: RECTANGLE`, 2.0 × 1.1 m, 650 W, warm, from the left
  (window-like soft box, set directly in `object.light_add`).
* **Rim Light** – AREA light, `RECTANGLE` strip 1.6 × 0.4 m, 260 W, cool, from the back right: long
  highlights on the domino edges.
* Dim `STUDIO` environment (0.15), ACES view transform at −0.5 EV (more saturated than AgX, which
  suits the toy colours).
* **Camera** (still) – 45 mm, three-quarter view from the front right (azimuth −50°, elevation 22°)
  that frames the whole S and the chute; **depth of field** at f/2 with `dof_focus_object` = the
  `Focus Target` empty.
* **Focus Target** – an empty keyed (`anim.keyframes_insert_many`, LINEAR) from the simulation:
  it follows the marble down the chute, then runs along the line with the wave front (a
  least-squares fit of the frames at which the dominoes fall), so the plane of focus is always on
  the action — at frame 55 it is next to `Domino.30`.
* **Showcase Cam** (GIF and contact sheet) – `object.track_set` (Track To) aimed at the
  `Showcase Target` empty; camera and target are keyed (BEZIER) from a close-up of the chute at
  frame 26 to the main camera's framing at frame 60; f/2.8 on the same focus target.
* **Ramp Cam** – a close-up of the chute for the marble-run inspection sheet.

## Physics

| Object | Rigid body | Shape | Settings |
| --- | --- | --- | --- |
| Table | PASSIVE | CONVEX_HULL (its hull top is the table top) | friction 0.6, restitution 0.1 |
| Chute | PASSIVE | MESH (concave channel) | friction 0.4 |
| Dowels / blocks | PASSIVE | CYLINDER / BOX | stray-marble colliders |
| Floor | PASSIVE | BOX | friction 0.6 |
| 60 dominoes | ACTIVE | BOX | 47 g, friction 0.5, restitution 0.1, margin 2 mm |
| Marble | ACTIVE | SPHERE | 29 g, friction 0.4, restitution 0.2, linear/angular damping 0.35 |

`rigidbody.world_set`: frames 1–100 at 24 fps, 20 substeps per frame (2.1 ms steps), 20 solver
iterations. The marble leaves the tower at frame 1, reaches the lip at frame ≈ 26 and hits the
first domino at frame ≈ 27, about 75 % of the way up; the wave runs at ≈ 1.2 m/s (0.85 frames
per domino) and the last domino lands at frame ≈ 80.

How `build.mjs` checks the simulation before baking it:

* **verify** – samples `rigidbody.describe` every second frame and requires that all 60 dominoes
  tilt past 45° **and** that they do so in path order; it logs the fall frame of every domino, the
  final tilts (≈ 70° = leaning on the next one, 89° for the last) and the marble's track.
* **inspect** – RASTER contact sheets of the marble run (`Ramp Cam`, frames 1–31), of the cascade
  (`Camera`, 27–87) and of the showcase camera move (1–96); `get_object` at several frames reads
  the evaluated (simulated / animated) transforms: the marble's positions, the tilt of
  `Domino.01`, `.30` and `.60` before and after the wave passes, the focus target at the still's
  frame and the showcase camera's tracked rotation.
* **bake** – `rigidbody.bake_to_keyframes` turns the motion of the 61 active bodies into keyframes
  and the script checks with `get_object` that the keys reproduce the simulated positions
  (max. difference ≈ 0.1 mm).

The run of the final production build (see below) logged:

FINAL_SIM_PLACEHOLDER

## Rebuild

Start a server (any port), then:

```bash
MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs              # = --final
MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs --build-only # no path tracing
MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs --export-only # scene.glb only
```

The script deletes an existing `domino-cascade` project and rebuilds everything from scratch; it
stops with an error on any tool error or failed check.

| Mode | Stages | Writes |
| --- | --- | --- |
| `--final` (default) | scene, verify, animate, inspect, bake, still, sheet, gif | `render.png`, `contact_sheet.png`, `preview.gif` |
| `--build-only` | scene, verify, animate, inspect, bake | inspection sheets only (≈ 25 s) |
| `--preview` | scene, verify, animate, bake, preview | 640 × 360 RASTER + 24 spp path-traced check images |
| `--export-only` | scene, verify, animate, bake, export | `scene.glb` (≈ 11 s, no renders) |
| `--stages=a,b,…` | any of the stages above | stages without `scene` work on the existing project, e.g. `--stages=still` |

Options: `--still-samples=N` / `--still-time=S` (default 256 spp / 450 s), `--frame=F` (still
frame, default 55), `--draft` (low-sample still, sheet and GIF written to `$WORK_DIR/draft`
instead of next to the script: a quick test of the whole pipeline). Environment: `MCP_URL`,
`MCP_TOKEN`, `WORK_DIR` (inspection sheets and `timings.json`, default
`$TMPDIR/domino-cascade-work`), `PROJECT_NAME`.

## Final production run

FINAL_RUN_PLACEHOLDER

## Features and tools used

* **MCP tools:** `list_projects`, `delete_project`, `create_project`, `set_scene_settings` (frame
  range, resolution, engine, samples, bounces, denoising, view transform, exposure, environment),
  `run_operator` (with `selection` for selection-based operators), `batch` (with per-operation
  `reports`), `add_modifier`, `apply_modifier`, `set_material`, `delete_objects`, `get_object`
  (evaluated values at a frame), `get_scene` (`problems`), `set_active_camera`, `render_image`
  (RASTER previews, PATHTRACER final with depth of field), `render_animation` (CONTACT_SHEET, GIF;
  RASTER inspection and PATHTRACER outputs, `camera` override), `export_scene` (glb, `warnings`).
* **Generators / layout:** `object.generate_table`, `object.array_place` (linked copies),
  `object.transform_set`, `object.rename`, `object.look_at`.
* **Curves:** `curve.add_from_points` (POLY profile, BEZIER path, `bevel_mode OBJECT`,
  `bevel_object`, `use_fill_caps`, `twist_mode Z_UP`), `object.convert` (curve → mesh).
* **Modelling:** `mesh.primitive_cube_add / cylinder_add / uv_sphere_add / plane_add`,
  `object.transform_apply`, `BEVEL` modifier, `object.shade_auto_smooth`, `object.shade_smooth`.
* **Physics:** `rigidbody.object_add` (ACTIVE / PASSIVE; BOX, SPHERE, MESH, CONVEX_HULL,
  CYLINDER; mass, friction, restitution, margin, damping), `rigidbody.world_set`,
  `rigidbody.describe`, `rigidbody.bake_to_keyframes`.
* **Lights and cameras:** `object.light_add` (AREA, `shape RECTANGLE`, `size`, `size_y`),
  `object.camera_add` (lens, `dof_use`, `dof_focus_object`, `dof_aperture_fstop`),
  `object.empty_add`, `object.track_set` (Track To), `anim.keyframes_insert_many` (camera, target
  and focus-target paths).
* **Shading:** `material.preset_apply` (`glossy_plastic` ×60 with colour overrides, `wood`,
  `clear_glass`), `material.update` (clear coat), `material.procedural_set` (`BRICK` boards and
  parquet on the base colour, `WAVE` grain on the normal (bump) and roughness channels).

## Known limitations

* **Jumbo dominoes:** the physics engine works with absolute tolerances (2 mm contact slop, 3 cm/s
  sleep speed) and gives every box at least 5 mm half-thickness, so real 7.5 mm dominoes would
  collide like 10 mm slabs and hover above the table. The dominoes are therefore 14 mm thick.
* **Rolling resistance:** there is none in the engine; linear/angular damping of 0.35 on the
  marble stands in for it, so that the rebounding marble comes to rest under the lip instead of
  rolling off the table.
* **Run-to-run variation:** rigid bodies are solved in the order of their (random) object ids,
  so every fresh build simulates slightly differently (individual dominoes fall ±2 frames earlier
  or later). The build checks the full, in-order cascade every time; the numbers quoted above are
  those of the final production run.
* **Depth of field** is rendered by the path tracer only: the RASTER inspection sheets are sharp
  throughout. At GIF size (480 × 270) the blur is subtle.
* **RASTER previews** (the inspection sheets) ignore the ACES view transform and look brighter and
  flatter than the path-traced outputs; the lighting was judged on path-traced previews only.
* **Wood grain:** procedural textures cannot be rotated and the `WOOD` texture's rings and fibre
  streaks are built around texture Z, so on a horizontal table top they show as end-grain rings
  or a rippled speckle. The grain is therefore a `WAVE` pattern varying along Y (lines along the
  boards), and the board colour and the grain cannot share one texture (one procedural per
  channel).
* **GIF:** 256 colours with ordered (Bayer) dithering and 10 samples per pixel (denoised) per
  frame; the contact sheet tiles use 16 samples. Both are softer than the still.
* **scene.glb:** from an earlier export pass; `--export-only` regenerates it. glTF has no area
  lights (the exporter writes them as point lights and warns), and procedural materials are baked
  to textures.
