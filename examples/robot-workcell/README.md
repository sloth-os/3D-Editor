# Robot palletizing workcell ("Cell 04")

An original industrial pick-and-place cell, built entirely through the editor's MCP server by
[`build.mjs`](build.mjs). A teal four-axis palletizing robot lifts a plastic crate off the end of a
roller conveyor, swings it through the front of the cell and sets it into the last free slot of a
pallet; meanwhile the conveyor indexes the next crate into the pick station. The cell has a
welded-mesh safety fence, hazard-striped floor markings, a light curtain, an E-stop station, a
stack of empty pallets and a controller cabinet with a signal tower, inside a dim factory hall.

![Path-traced still, frame 49](render.png)

![The 96-frame cycle as a 48-frame GIF](preview.gif)

![Every 4th frame of the cycle (path traced)](contact_sheet.png)

## What is in the scene

| Part | How it is made |
| --- | --- |
| Robot rig | `object.armature_add` + `armature.bone_update` (J1_Base) + `armature.chain_add` (J2_Shoulder, J3_Elbow, J4_Wrist): **J1** yaws about Z, **J2 / J3** pitch (2-bone IK), **J4** rolls the gripper about the vertical. |
| Rigid parts | 16 parts (turret with shoulder yoke, motors, joint housings, tapered arm segments, wrist flange, gripper, three gears, three hose clamps) made with `object.add_mesh_from_data`, `object.generate_gear` and `mesh.primitive_torus_add`, bone-parented like Blender's Ctrl+P > Bone: `object.select` (parts + armature active) then `object.parent_set {type: BONE, bone}`. The base plate and pedestal are plain children of the rig. |
| Gears | `object.generate_gear`: a 60-tooth slewing ring on J1 and gear wheels on the shoulder and elbow, bone-parented so they turn with their joints. |
| Dress-pack hose | `object.generate_pipe` along a densified path over the arm, bound with `object.parent_set {type: ARMATURE_AUTO}` (automatic weights + Armature modifier), so it bends with J1, J2 and J3. The automatic weights gave the hose root on the turret ~45 % shoulder influence (it slid 38 mm over its fitting when the shoulder pitched), so the build reads the weights with `get_mesh_data`, pins the first 10 cm to J1_Base with a 15 cm blend and writes them back with `object.vertex_group_set_weights`. |
| IK | `pose.ik_add` on J3_Elbow (chain 2) targeting the keyframed empty `IK_Target`; `pose.constraint_add DAMPED_TRACK` on J4 aims at `Wrist_Aim` (a child of the target 1 m below it), which keeps the wrist vertical like a palletizer's parallel link. |
| Gripper fingers | One mesh with a `Grip` shape key (`object.shape_key_add` + `object.shape_key_set_positions`) that moves both fingers 58 mm inwards; `insert_keyframe shape_keys["Grip"].value` keys open → closed → open. |
| Carry | A `CHILD_OF` constraint (`object.constraint_add`) on the crate targeting bone J4_Wrist with keyed influence (0 → 1 when the fingers have closed, 1 → 0 at the release). The crate's own location is keyed at frame 1 (pick station) and at the release frame to the place position read back with `constraint.describe`. |
| Conveyor | One roller with an **ARRAY** modifier (42 rollers), one leg with **MIRROR + ARRAY**, side frames, an end stop, a drive box and a photo-eye sensor. Five crates on the belt are linked duplicates (`duplicate_object linked`) of one ribbed tote mesh with a BEVEL modifier. |
| Pallets | One deck board, block and base board each, multiplied by ARRAY modifiers (5 boards, 3 × 3 blocks, 3 base boards); the empty-pallet stack adds a Z ARRAY. Wood from `material.preset_apply wood`, re-coloured with `material.procedural_set`. |
| Floor | Dark epoxy with NOISE base colour and roughness, and **procedural safety stripes**: a WAVE texture (BANDS, DIAGONAL, SAW profile, CONSTANT ramp) on the hazard border, the robot danger zone and the cable protector. |
| Safety fence | `object.generate_fence` (two RAIL runs leaving a gap for the conveyor). The welded-mesh infill panels are thin boxes whose alpha is a procedural BRICK texture without row offset (mortar = wire, bricks = holes, blend CLIP). |
| Props | `object.text_add` signs ("CELL 04 - PALLETIZING", "AUTOMATIC MACHINE - KEEP OUT"), controller cabinet with an emissive HMI and a signal tower whose amber lamp blinks through `anim.driver_add` on the material's `emission_strength` (`14 * (fract(frame / 12) < 0.5)`), light curtain, E-stop station, striped cable protector. |
| Hall | North, west and east corrugated walls (WAVE bump on the normal channel; the side walls use a second material with the waves along Y), glowing window strips, steel columns. |
| Camera | `object.camera_add` (30 mm) + `object.look_at`, a **DAMPED_TRACK** constraint (`TRACK_NEGATIVE_Z`, influence 0.5) on `Robot_Gripper`, so the camera pans after the gripper between conveyor and pallet, and **depth of field** with `camera.properties_set {dof_use, dof_focus_object: Robot_Gripper, dof_aperture_fstop: 2.8}`: the gripper stays in focus at every frame (focus distance 3.9–5.7 m). |
| Lighting | `object.light_add` with area-light shapes and sizes: two 4.2 × 0.45 m **RECTANGLE** LED strips over the cell, a cool 3 × 1 m RECTANGLE rim light behind the robot, plus a warm **SPOT** key (`spot_size`, `spot_blend`, `shadow_soft_size`) from the front-left; dark world colour, mist (`set_scene_settings mist_distance`), AgX view transform, emissive windows. |

The scene has 71 objects (61 meshes), 30 materials and about 30 000 evaluated triangles.

## Animation (96 frames, 24 fps)

The IK target path is computed in the script in cylindrical coordinates (azimuth, radius,
height) with smootherstep easing between waypoints. Every frame is keyed with
`anim.keyframes_insert_many`: the target location, J1's yaw (= the target azimuth, so the target
always lies in the arm plane) and J4's roll (= yaw − π, so the gripper and crate keep their
heading).

| Frames | Action |
| --- | --- |
| 1–16 | the crate waits at the pick station; the arm swings from home to above it (16–19 hold) |
| 19–28 | descend; 28–33 fingers close (shape key); Child Of influence → 1 at 33 |
| 34–43 | lift |
| 43–63 | swing through the front of the cell to the pallet (J4 counter-rotates); 44–62 the conveyor indexes every waiting crate one pitch (1.05 m) forward |
| 63–72 | lower onto the free slot; release at 72 (influence → 0, crate keyed at its place) |
| 72–77 | fingers open; 78–96 lift and return home |

At frame 96 the next crate stands exactly where this one started, so the conveyor part of the
GIF loops seamlessly (only the crate on the pallet pops back at the loop point).

## Verification (part of every build)

After building, `build.mjs` checks the evaluated scene through MCP queries and aborts if a check
fails:

- `armature.describe` at 17 frames: the wrist joint reaches the IK target (worst error **0.0 mm**).
- `get_object {frame}` (evaluated values) at the same frames: the crate sits at the pick station
  before the grip, rides with the gripper while gripped and stays on its slot after the release
  (worst error **0.06 mm**); the Child Of influence is 0 / 1 / 0 and the `Grip` shape key is
  0 / 1 / 0 as planned; the camera's evaluated DOF focus distance follows the gripper (3.9–5.7 m).
- `get_mesh_data {source: EVALUATED, space: WORLD}` at 6 frames: the skinned hose's wrist end stays
  0.121–0.129 m from the wrist joint and its root stays on its turret fitting (radius 0.302 m at
  every frame), i.e. the hose bends with the arm without detaching.
- `scene.measure {frame: 50}`: 2 mm clearance between the finger pads and the carried crate, no
  intersection.
- `get_object` at frames 1 and 96: each queued crate moved exactly one pitch; the first one
  reaches the pick station.

## Editor features exercised

- **MCP tools:** `list_projects`, `delete_project`, `create_project`, `set_scene_settings`,
  `run_operator`, `batch` (with per-operation warning reports), `add_modifier`, `edit_mesh`,
  `duplicate_object`, `transform_object`, `insert_keyframe`, `set_active_camera`, `get_scene`,
  `get_object` (evaluated values at a frame), `get_mesh_data` (weights, evaluated vertices),
  `render_image`, `render_animation` (CONTACT_SHEET, GIF), `export_scene`.
- **Operators:** `object.armature_add`, `armature.bone_update`, `armature.chain_add`,
  `armature.properties_set`, `armature.describe`, `pose.ik_add`, `pose.constraint_add`,
  `object.parent_set` (BONE, ARMATURE_AUTO, OBJECT), `object.parent_to`,
  `object.vertex_group_set_weights`, `object.shape_key_add`, `object.shape_key_set_positions`,
  `object.constraint_add` (CHILD_OF, DAMPED_TRACK), `constraint.describe`,
  `anim.keyframes_insert_many`, `anim.driver_add`, `object.generate_gear`, `object.generate_pipe`,
  `object.generate_fence`, `object.add_mesh_from_data`, `mesh.primitive_cylinder_add`,
  `mesh.primitive_torus_add`, `object.text_add`, `object.empty_add`, `object.camera_add`,
  `camera.properties_set` (depth of field), `object.light_add` (RECTANGLE / SPOT),
  `object.look_at`, `object.modifier_add`, `material.new`, `material.update`,
  `material.preset_apply`, `material.procedural_set` (NOISE, WAVE, BRICK; base colour, roughness,
  alpha, normal), `object.material_assign`, `object.material_slot_assign`,
  `object.shade_smooth`, `object.shade_auto_smooth`, `object.select`, `scene.frame_set`,
  `scene.measure`.
- **Modifiers:** ARRAY (rollers, legs, pallets, pallet stack), MIRROR, BEVEL, ARMATURE (from
  ARMATURE_AUTO).
- **Rendering:** path tracer with denoising, depth of field, area-light shapes, mist and AgX;
  path-traced contact sheet and GIF.

## Rebuild

```bash
# 1. a server (any port; npm run build first if apps/server/dist is missing). The build
#    deletes and recreates the project "robot-workcell" on it.
PORT=4503 npm start &                               # or any running server / the Docker image

# 2. the build (modes are exclusive; the scene is always rebuilt and verified first)
MCP_URL=http://127.0.0.1:4503/mcp node examples/robot-workcell/build.mjs
#   (no flag)          final renders: render.png, contact_sheet.png, preview.gif
#   --no-render        build + verify only (about 3 s)
#   --export-only      build + verify, then scene.glb (no renders)
#   --preview=DIR      build + verify, then RASTER stills, a RASTER contact sheet and a small
#                      path-traced frame into DIR (outputs untouched)
#   --still-only / --anim-only   only the still / only the contact sheet and GIF
#   --still-time=S     time limit of the still (default 480 s)
```

Building and verifying the scene takes about 3 s and 176 MCP tool calls (177 when an older
project is deleted first; most operators run inside `batch` calls); the renders take the rest of
the time. They are time-limited, so the samples reached depend on the CPU. The script prints the
project's editor URL (`http://<host>/?project=<id>`): open it to scrub the timeline and inspect
the rig, the constraints, the shape key and the driver in the web editor.

## Final production run

The outputs in this folder come from one run of `build.mjs` (default mode) against a fresh
server with an empty data directory, which also shows that the project rebuilds from scratch. The
machine has 4 cores and was shared with other agents during the run (1-minute load average 5.5–11,
mean 8), so the path tracer reached fewer samples than it would on an idle machine.

```bash
PORT=4553 DATA_DIR=/tmp/phase3/robot-workcell/final-data RENDER_WORKERS=3 node .phase3/app-v2/dist/main.js &
MCP_URL=http://127.0.0.1:4553/mcp node examples/robot-workcell/build.mjs
```

| Stage | Settings | Wall time | Result |
| --- | --- | --- | --- |
| Build + verification | 176 MCP tool calls | 2.7 s | IK error 0.0 mm, crate error 0.06 mm, pad clearance 2.0 mm |
| `render.png` | PATHTRACER 1280×720, frame 49, 256 spp requested, 6 bounces, denoised, time limit 480 s | 484.6 s | **79 spp** reached (3 render threads); 1.27 MB |
| `contact_sheet.png` | PATHTRACER, frames 1–96 every 4th (24 tiles of 320×180), 12 spp, 4 bounces, denoised, 10 s per frame | 85.9 s | 21 of 24 frames stopped at the per-frame limit (≈ 7 spp); 2.81 MB |
| `preview.gif` | PATHTRACER, frames 1–95 every 2nd (48 frames, 12 fps), 480×270, 16 spp, 4 bounces, denoised, 15 s per frame, Bayer dither | 245.1 s | all 48 frames stopped at the per-frame limit (≈ 4–9 spp); 4.21 MB |
| **Total** | | **818 s (13.6 min)** | exit code 0 |

`render_animation` reports which frames stopped early but not how many samples they reached; the
≈ values come from `render_image` calls with the same size, samples and time limit on the same
(equally loaded) machine.

## Known limitations

- **The GIF is one cycle, not a perfect loop.** The conveyor queue loops seamlessly, but at the
  restart the crate on the pallet disappears and its slot is empty again.
- **No IK locks.** The editor has no per-bone IK locks or limits (Blender `lock_ik_*`), so the
  IK chain only covers the two pitch joints; J1's yaw and J4's roll are keyed per frame from the
  target azimuth. A real palletizer keeps the wrist vertical mechanically; here a Damped Track on
  J4 does it.
- **Hose weights needed a manual fix-up.** Automatic weights blend the hose root with the
  shoulder bone; the build pins it to J1_Base with `object.vertex_group_set_weights` (see above).
- **Fence infill is a separate object.** `object.generate_fence` makes posts and rails or
  pickets only; the welded wire mesh is a panel object with a procedural BRICK alpha. At GIF
  resolution the 4 mm wires are sub-pixel and shimmer slightly.
- **Rollers do not turn** (they are smooth cylinders of one ARRAY object, so a spin would be
  invisible), and the crates' conveyor ride is keyframed, not simulated.
- **Low sample counts.** The CPU was shared with other agents, so the path tracer stopped at its
  time limits: 79 spp for the still, roughly 4–9 spp per GIF frame (see the table above). The
  denoiser cleans even 1–2 sample frames, but fine details (the fence wires, the hose) are softer
  than in a converged render, and `render_animation` does not report the samples each frame
  reached.
- **scene.glb** is written by `--export-only` from the live, rigged scene; area lights become
  point lights in glTF and procedural textures are baked through automatically generated UVs
  (both reported as `export_scene` warnings). It is regenerated with the finished glTF exporter.

Editor issues found while building this example were reported to the editor's developers with
exact MCP repros (Phase-3 issue reports).
