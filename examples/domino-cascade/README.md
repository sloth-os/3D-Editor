# Domino Cascade

An original rigid-body physics showcase built entirely through the editor's MCP server by
[`build.mjs`](build.mjs): a blue glass marble rolls down a curved aluminium chute that starts in
the top block of a tower of toy blocks, shoots off the lip and knocks over the first of **60
rainbow-coloured plastic dominoes** standing along an S-curve on an oak table. The whole chain
topples in order; the marble bounces back and rolls slowly back under the chute.

![Path-traced still, mid-cascade (frame 55)](render.png)

| Animation (showcase camera) | |
| --- | --- |
| ![Cascade GIF](preview.gif) | `preview.gif`: 48 frames (1–95, every 2nd), 480 × 270, path traced and denoised. The showcase camera starts close on the chute while the marble rolls, then pulls back to the full S while the wave runs. |

[`contact_sheet.png`](contact_sheet.png) shows every 4th frame (4–96) through the same camera.
`scene.glb` is the baked, animated scene from an export pass of an earlier version of the scene
(before the start block and the current lighting); `--export-only` regenerates it, see below.

## The scene

All sizes are real-world metres, Z up. 81 objects, 18 k render triangles, 71 materials.

* **Table** – `object.generate_table` (2.6 × 1.5 m, top at 0.75 m). Its `Wood` material is
  rewritten as satin oak boards: a `BRICK` procedural on the base colour (one random tone per
  1.3 m × 0.19 m board, hair-line seams), a fine grain along the boards as a 0.15 mm bump (a
  `WAVE` procedural: saw-tooth bands about 14 mm apart, wobbled by noise) and, with the same
  pattern, on the roughness (0.3–0.55), plus a light clear coat.
* **Dominoes** – 60 jumbo toy dominoes (80 × 40 × 14 mm, 47 g; for the thickness see
  [Known limitations](#known-limitations)). One bevelled prototype (cube →
  `object.transform_apply` → `BEVEL` modifier applied → auto smooth → rigid body) is copied with
  `object.array_place` (linked duplicates, rigid body copied along); one `batch` renames the
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
* **Supports** – four bevelled toy blocks: red, amber and blue carry the top of the chute, and a
  green **start block** sits on top with the chute's upper end running 30 mm into it. Seen from
  the cameras, the steep upper end of the polished channel and its end face would mirror the key
  and rim lights as a blown-out white crescent; the start block hides them. Four beech dowels
  (`mesh.primitive_cylinder_add`, `wood` preset recoloured) carry the bend.
* **Marble** – 28 mm sphere, `clear_glass` preset tinted blue, 29 g. It starts 50 mm down the
  lead-in; `scene.measure` checks that it is clear of the start block (6.7 mm), because an
  initial overlap would kick it.
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
iterations. The marble starts at rest at frame 1, reaches the lip at frame 25 and hits the first
domino between frames 25 and 26, its centre about 54 mm above the table (67 % of the domino
height); the wave runs at ≈ 1.2 m/s (0.85 frames per domino) and the last domino lands at
frame ≈ 80.

How `build.mjs` checks the simulation before baking it:

* **verify** – samples `rigidbody.describe` every second frame and requires that all 60 dominoes
  tilt past 45° **and** that they do so in path order; it logs the fall frame of every domino, the
  final tilts (≈ 70° = leaning on the next one, ≈ 90° for the last) and the marble's track. It
  then follows the marble frame by frame past the lip into `Domino.01` and reports when and where
  they meet (first contact is at a centre distance of marble radius + half the domino's
  thickness). `rigidbody.describe` is given the dominoes and the marble by name, so it reports
  their evaluated transforms from the live simulation or, once baked, from the keyframes: the
  same checks also run on a baked project.
* **inspect** – RASTER contact sheets of the marble run (`Ramp Cam`, frames 1–31), of the cascade
  (`Camera`, 27–87) and of the showcase camera move (1–96); `get_object` at several frames reads
  the evaluated (simulated / animated) transforms: the marble's positions, the tilt of
  `Domino.01`, `.30` and `.60` before and after the wave passes, the focus target at the still's
  frame and the showcase camera's tracked rotation.
* **bake** – `rigidbody.bake_to_keyframes` turns the motion of the 61 active bodies into keyframes
  and the script checks with `get_object` that the keys reproduce the simulated positions
  (max. difference ≈ 0.1 mm). A project that is already baked is left as it is.

The run of the final production build (see below) logged:

```text
fall frames (first sampled frame past 45°), Domino.01 … Domino.60, 20 per row:
  29 31 31 33 33 35 35 37 37 37 | 39 39 41 41 43 43 43 45 45 47
  47 47 49 49 51 51 51 53 53 55 | 55 57 57 59 59 61 61 61 63 63
  65 65 65 67 67 69 69 71 71 71 | 73 73 75 75 75 77 77 79 79 79
60/60 dominoes toppled; in order: true
final tilts: 68–72° (each leaning on the next), 76° for Domino.59, 90° for Domino.60 (flat on the table)
  f25: marble centre 5 mm past the lip, 45 mm before Domino.01's centre, 60 mm above the table; Domino.01 tilted 0.0°
  f26: marble centre 37 mm past the lip, 13 mm before Domino.01's centre, 51 mm above the table; Domino.01 tilted 9.5°
  f27: marble centre 46 mm past the lip, 4 mm before Domino.01's centre, 34 mm above the table; Domino.01 tilted 25.5°
marble: reaches the lip at frame 25; hits Domino.01 between frames 25 and 26, centre ≈ 54 mm above the table (67 % of the domino height)
wave front: frame ≈ 30.1 + 0.849·i  (1.20 m/s)
Marble     f1 [-0.754, 0.544, 0.972]  f20 [-1.077, 0.207, 0.824]  f25 [-0.930, 0.034, 0.810]  f26 [-0.909, 0.009, 0.801]
           f30 [-0.918, 0.015, 0.764]  f100 [-1.063, 0.129, 0.764]   (z 0.764 = resting on the table)
Domino.01  f20 tilt 0°   f30 tilt 57°   f40 tilt 72°
Domino.30  f45 tilt 0°   f55 tilt 60°   f65 tilt 71°
Domino.60  f70 tilt 0°   f80 tilt 90°   f95 tilt 90°
frame 55:  Focus Target next to Domino.30; Camera focuses on 'Focus Target' at 2.437 m (f/2)
bake:      61 bodies, 4072 keyframes; baked keys vs simulation: max position difference 0.113 mm
```

## Rebuild

Start a server (any port and data directory; run `npm run build` first if `apps/server/dist` is
missing), then run the script from the repository root:

```bash
PORT=4504 DATA_DIR=/tmp/dc-data RENDER_WORKERS=3 node apps/server/dist/main.js &     # or: npm start
MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs               # = --final
MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs --build-only  # no path tracing
MCP_URL=http://127.0.0.1:4504/mcp node examples/domino-cascade/build.mjs --export-only # scene.glb only
```

The script deletes an existing `domino-cascade` project and rebuilds everything from scratch; it
stops with an error on any tool error or failed check.

| Mode | Stages | Writes |
| --- | --- | --- |
| `--final` (default) | scene, verify, animate, inspect, bake, still, sheet, gif | `render.png`, `contact_sheet.png`, `preview.gif` |
| `--build-only` | scene, verify, animate, inspect, bake | inspection sheets only (≈ 17 s with 3 render threads, ≈ 25 s with 1) |
| `--preview` | scene, verify, animate, bake, preview | 640 × 360 RASTER + 24 spp path-traced check images |
| `--export-only` | scene, verify, animate, bake, export | `scene.glb` (≈ 11 s, no renders) |
| `--stages=a,b,…` | any of the stages above | stages without `scene` work on the existing project, baked or not: `verify` then checks the keyframes and `bake` leaves a baked project alone (e.g. `--stages=verify`, `--stages=animate,still`) |

Options: `--still-samples=N` / `--still-time=S` (default 256 spp / 450 s), `--frame=F` (still
frame, default 55), `--draft` (low-sample still, sheet and GIF written to `$WORK_DIR/draft`
instead of next to the script: a quick test of the whole pipeline). Environment: `MCP_URL`,
`MCP_TOKEN`, `WORK_DIR` (inspection sheets and `timings.json`, default
`$TMPDIR/domino-cascade-work`), `PROJECT_NAME`.

## Final production run

The outputs come from one run of `--final` at the end, on a fresh server with an empty data
directory and 3 render workers, on 4 CPU cores shared with other agents' editor servers. It also
proves that the project rebuilds from scratch. The server was a snapshot of the editor's server
bundle (`apps/server/dist`) built on 2026-11-05 at 16:15 UTC, between commits `550701b` and
`ab0f6d1`, and kept in an untracked directory so that the editor could not change under the
project while other work went on. Its physics engine is the one in the repository up to commit
`85feaa2`; commit `6451e56` changed it (thin bodies, deterministic body order, see
[Known limitations](#known-limitations)), so a current build simulates the scene slightly
differently — the script checks the cascade again on every run.

```bash
# server: the snapshot of apps/server/dist described above, on an empty data directory
PORT=4554 DATA_DIR=/tmp/phase3/domino-cascade/final-data RENDER_WORKERS=3 node apps/server/dist/main.js &
WORK_DIR=/tmp/phase3/domino-cascade/final-work MCP_URL=http://127.0.0.1:4554/mcp node examples/domino-cascade/build.mjs --final
```

Measured on 2026-11-06 (11:31–11:45 UTC), exit code 0:

| Stage | Settings | Wall time | Result |
| --- | --- | --- | --- |
| scene | 81 objects (74 meshes, 3 cameras, 2 lights, 2 empties), 71 materials, 72 rigid bodies, 18,122 render triangles | 0.8 s | `get_scene` problems: none; marble 6.7 mm clear of the start block |
| verify | `rigidbody.describe` at 50 frames (1, 3 … 99), then every frame from 1 until the marble has hit `Domino.01` | 2.9 s | 60/60 toppled, in path order; impact between frames 25 and 26 |
| animate | focus target (18 keys), showcase camera and its target (2 keys each) | < 0.1 s | |
| inspect | 3 RASTER contact sheets (16, 16 and 20 frames, 4.6 s + 3.7 s + 3.5 s) and 20 `get_object` checks | 12.0 s | sheets in `$WORK_DIR` |
| bake | `rigidbody.bake_to_keyframes` (61 bodies) and 20 `get_object` checks | 0.5 s | 4072 keys, max. 0.113 mm off the simulation |
| **build total** | | **16.2 s** | |
| `render.png` | 1280 × 720, frame 55, path tracer, 256 spp requested, `time_limit` 450 s, 6 bounces, denoised | 453.9 s | **127 spp** reached (time limit), 0.92 MB |
| `contact_sheet.png` | 24 frames (4, 8 … 96) of `Showcase Cam`, 320 × 180, 16 spp, denoised | 83.8 s | all 24 frames; every frame at 16 spp (no `undersampled_frames`), 1.54 MB |
| `preview.gif` | 48 frames (1, 3 … 95) of `Showcase Cam`, 480 × 270, 10 spp, denoised, 12 fps, Bayer dither | 274.5 s | all 48 frames; every frame at 10 spp (no `undersampled_frames`), 1.48 MB |
| **total** | | **828.4 s (13.8 min)** | |

## Features and tools used

* **MCP tools:** `list_projects`, `delete_project`, `create_project`, `set_scene_settings` (frame
  range, resolution, engine, samples, bounces, denoising, view transform, exposure, environment),
  `run_operator` (with `selection` for selection-based operators), `batch` (with per-operation
  `reports`), `add_modifier`, `apply_modifier`, `set_material`, `delete_objects`, `get_object`
  (evaluated values at a frame), `get_scene` (`problems`), `set_active_camera`, `render_image`
  (RASTER previews, PATHTRACER final with depth of field), `render_animation` (CONTACT_SHEET, GIF;
  RASTER inspection and PATHTRACER outputs, `camera` override), `export_scene` (glb, `warnings`).
* **Generators / layout:** `object.generate_table`, `object.array_place` (linked copies),
  `object.transform_set`, `object.rename`, `object.look_at`, `scene.measure` (clearance check).
* **Curves:** `curve.add_from_points` (POLY profile, BEZIER path, `bevel_mode OBJECT`,
  `bevel_object`, `use_fill_caps`, `twist_mode Z_UP`), `object.convert` (curve → mesh).
* **Modelling:** `mesh.primitive_cube_add / cylinder_add / uv_sphere_add / plane_add`,
  `object.transform_apply`, `BEVEL` modifier, `object.shade_auto_smooth`, `object.shade_smooth`.
* **Physics:** `rigidbody.object_add` (ACTIVE / PASSIVE; BOX, SPHERE, MESH, CONVEX_HULL,
  CYLINDER; mass, friction, restitution, margin, damping), `rigidbody.world_set`,
  `rigidbody.describe` (with `objects`: live simulation or baked keys), `rigidbody.bake_to_keyframes`.
* **Lights and cameras:** `object.light_add` (AREA, `shape RECTANGLE`, `size`, `size_y`),
  `object.camera_add` (lens, `dof_use`, `dof_focus_object`, `dof_aperture_fstop`),
  `object.empty_add`, `object.track_set` (Track To), `anim.keyframes_insert_many` (camera, target
  and focus-target paths).
* **Shading:** `material.preset_apply` (`glossy_plastic` ×60 with colour overrides, `wood`,
  `clear_glass`), `material.update` (clear coat), `material.procedural_set` (`BRICK` boards and
  parquet on the base colour, `WAVE` grain on the normal (bump) and roughness channels).

## Known limitations

The first two items are properties of the editor snapshot that made the outputs (see
[Final production run](#final-production-run)); the repository's engine has changed since.

* **Jumbo dominoes (snapshot engine):** the snapshot gives every collision box at least 5 mm
  half-thickness and uses absolute tolerances (2 mm contact slop, 3 cm/s sleep speed), so real
  7.5 mm dominoes would collide like 10 mm slabs and hover above the table. The dominoes are
  therefore 14 mm thick. Since commit `6451e56` the engine keeps boxes at their real thickness
  down to 0.2 % of their largest half size and scales the slop and the sleep speed down for thin
  and small bodies, so real-size dominoes would work on a current build; the script keeps the
  14 mm the outputs were made with.
* **Run-to-run variation (snapshot engine):** the snapshot solves the rigid bodies in the order
  of their (random) object ids, so every fresh build simulates slightly differently. The final
  run and an earlier one that a machine restart cut off, both from scratch on fresh servers,
  differ in one domino's fall frame (`Domino.43`: 65 vs 67), in the baked keys (4072 vs 4201)
  and in the final tilts by up to 2°. The build checks the full, in-order cascade every time; the
  numbers quoted above are those of the final production run. Since commit `6451e56` the engine
  orders the bodies by their start pose, so fresh builds simulate identically.
* **Rolling resistance:** there is none in the engine; linear/angular damping of 0.35 on the
  marble stands in for it, so that the rebounding marble slows down under the chute instead of
  rolling off the table.
* **Depth of field** is rendered by the path tracer only: the RASTER inspection sheets are sharp
  throughout. At GIF size (480 × 270) the blur is subtle.
* **RASTER previews** (the inspection sheets) ignore the ACES view transform in the snapshot and
  look brighter and flatter than the path-traced outputs; the lighting was judged on path-traced
  previews only. (The repository's rasterizer applies the view transform since commit `ada949d`.)
* **Wood grain:** procedural textures cannot be rotated and the `WOOD` texture's rings and fibre
  streaks are built around texture Z, so on a horizontal table top they show as end-grain rings
  or a rippled speckle. The grain is therefore a `WAVE` pattern varying along Y (lines along the
  boards), and the board colour and the grain cannot share one texture (one procedural per
  channel).
* **The still is time-limited:** on the shared machine (other processes were using part of the 4
  cores during the run) the path tracer stopped at the 450 s budget with 127 of the requested 256
  samples per pixel; denoised, it shows no visible noise.
* **GIF:** 256 colours with ordered (Bayer) dithering and 10 samples per pixel (denoised) per
  frame; the contact sheet tiles use 16 samples. Both are softer than the still.
* **scene.glb:** from an earlier export pass; `--export-only` regenerates it. glTF has no area
  lights (the exporter writes them as point lights and warns), and procedural materials are baked
  to textures.
