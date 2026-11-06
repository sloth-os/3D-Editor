# Robot palletizing workcell ("Cell 04")

An original industrial pick-and-place cell, built entirely through the editor's MCP server by
[`build.mjs`](build.mjs). A teal four-axis palletizing robot lifts a plastic crate off the end of a
roller conveyor, swings it through the front of the cell and sets it into the last free slot of a
pallet. Meanwhile the conveyor moves the queue one place forward, and the next crate rolls out of
an infeed hood through a roll-up door. The cell also has a welded-mesh safety fence, hazard-striped
floor markings, a light curtain, an E-stop station, a stack of empty pallets and a controller
cabinet with a signal tower. It stands in a dim factory hall.

![Path-traced still, frame 49](render.png)

![The 96-frame cycle as a 48-frame GIF](preview.gif)

![Every 4th frame of the cycle (path traced)](contact_sheet.png)

## What is in the scene

| Part | How it is made |
| --- | --- |
| Robot rig | `object.armature_add` + `armature.bone_update` (J1_Base) + `armature.chain_add` (J2_Shoulder, J3_Elbow, J4_Wrist): **J1** yaws about Z, **J2 / J3** pitch (2-bone IK), **J4** rolls the gripper about the vertical. |
| Rigid parts | 18 parts: turret with shoulder yoke, motors, joint housings, tapered arm segments, wrist flange, gripper, three gears, three hose clamps and two clamp-bracket meshes. They are made with `object.add_mesh_from_data`, `object.generate_gear` and `mesh.primitive_torus_add` and bone-parented like Blender's Ctrl+P > Bone: `object.select` (parts + armature active), then `object.parent_set {type: BONE, bone}`. The elbow bends between 78° and 127° in the cycle, and its layout is chosen so that nothing collides over that range: the forearm starts inside the 0.16 m elbow housing, and the rear elbow motor sits beside the arm's centre plane. As a result no link, motor or hose passes through another part at any frame (the build checks this, see Verification). The base plate and pedestal are plain children of the rig. |
| Gears | `object.generate_gear`: a 60-tooth slewing ring on J1 and gear wheels on the shoulder and elbow, bone-parented so they turn with their joints. `materials: false`, because the parts get their own materials (otherwise the generator would leave an unused default "Steel" material behind). |
| Dress-pack hose | `object.generate_pipe` along a path that runs up the back of the upper arm, around the back of the elbow next to the elbow motor and along the top of the forearm. It is bound with `object.parent_set {type: ARMATURE_AUTO}` (automatic bone-heat weights + Armature modifier), so it bends with J1, J2 and J3. On a hose that runs 17 cm from its bones, the automatic weights blend over long stretches. With the raw weights, the hose root (55 % J1_Base, 42 % J2_Shoulder) slid up to 112 mm over its fitting, and the hose moved up to 36 mm out of the centre of its clamps. The build therefore reads the weights with `get_mesh_data` and pins each clamped stretch to the bone of its link: root → J1_Base, upper-arm clamps → J2_Shoulder, forearm → J3_Elbow. Each pinned stretch blends back into the automatic weights over 12–15 cm, so the automatic weights still bend the hose at the shoulder and around the elbow. The fixed weights are written back with `object.vertex_group_set_weights`. Three clamps on brackets hold the hose to the arm. |
| IK | `pose.ik_add` on J3_Elbow (chain 2) targeting the keyframed empty `IK_Target`. `pose.constraint_add DAMPED_TRACK` on J4 aims at `Wrist_Aim` (a child of the target, 1 m below it), which keeps the wrist vertical like a palletizer's parallel link. |
| Gripper fingers | One mesh with a `Grip` shape key (`object.shape_key_add` + `object.shape_key_set_positions`) that moves both fingers 58 mm inwards. `insert_keyframe shape_keys["Grip"].value` keys it open → closed → open. |
| Carry | A `CHILD_OF` constraint (`object.constraint_add`) on the crate targets bone J4_Wrist, with keyed influence: 0 → 1 when the fingers have closed, 1 → 0 at the release. The crate's own location is keyed at frame 1 (pick station) and, at the release frame, at the place position read back with `constraint.describe`. |
| Conveyor | One roller with an **ARRAY** modifier (51 rollers), one leg with **MIRROR + ARRAY**, side frames, an end stop, a drive box and a photo-eye sensor. At the far end, outside the fence, stands an infeed hood with a hazard band and a roll-up door. The door's Z location has smooth BEZIER keys: it opens at frames 45–51 and closes behind the emerging crate at 58–64. Nine crates are linked duplicates (`duplicate_object linked`) of one ribbed tote mesh with a BEVEL modifier: six on the belt (one of them waiting unseen inside the hood) and three on the pallet. |
| Pallets | One deck board, one block and one base board each, multiplied by ARRAY modifiers (5 boards, 3 × 3 blocks, 3 base boards). The stack of empty pallets adds a Z ARRAY. Wood comes from `material.preset_apply wood`, re-coloured with `material.procedural_set`. |
| Floor | Dark epoxy with a NOISE base colour and roughness. **Procedural safety stripes**: a WAVE texture (BANDS, DIAGONAL, SAW profile, CONSTANT ramp) on the hazard border, the robot danger zone, the cable protector and the infeed's hazard band. |
| Safety fence | `object.generate_fence` makes two RAIL runs that leave a gap for the conveyor. The welded-mesh infill panels are thin boxes whose alpha is a procedural BRICK texture without row offset (mortar = wire, bricks = holes, blend CLIP). The panel edges sit where the 5 cm wire grid cannot leave loose wire ends: the top edge inside the generated top rail, the side edges inside the posts and the bottom edge on a full wire. |
| Props | `object.text_add` signs ("CELL 04 - PALLETIZING", "AUTOMATIC MACHINE - KEEP OUT"), a controller cabinet with an emissive HMI and a signal tower, a light curtain, an E-stop station and a striped cable protector. The tower's amber lamp blinks through `anim.driver_add` on the material's `emission_strength` (`14 * (fract(frame / 12) < 0.5)`). |
| Hall | North, west and east corrugated walls (a WAVE bump on the normal channel; the side walls use a second material with the waves along Y), glowing window strips and steel columns. |
| Camera | `object.camera_add` (30 mm) + `object.look_at`. A **DAMPED_TRACK** constraint (`TRACK_NEGATIVE_Z`, influence 0.5) on `Robot_Gripper` makes the camera pan after the gripper between conveyor and pallet. **Depth of field** with `camera.properties_set {dof_use, dof_focus_object: Robot_Gripper, dof_aperture_fstop: 2.8}` keeps the gripper in focus at every frame (focus distance 3.9–5.7 m). |
| Lighting | `object.light_add` with area-light shapes and sizes: two 4.2 × 0.45 m **RECTANGLE** LED strips over the cell, a cool 3 × 1 m RECTANGLE rim light behind the robot and a warm **SPOT** key (`spot_size`, `spot_blend`, `shadow_soft_size`) from the front left. Also a dark world colour, mist (`set_scene_settings mist_distance`), the AgX view transform and emissive windows. |

The scene has 76 objects (66 meshes), 28 materials and about 31 900 evaluated triangles.

## Animation (96 frames, 24 fps)

The script computes the IK target path in cylindrical coordinates (azimuth, radius, height),
with smootherstep easing between waypoints. Every frame is keyed with
`anim.keyframes_insert_many`: the target location, J1's yaw (= the target azimuth, so the target
always lies in the arm plane) and J4's roll (= yaw − π, so the gripper and the crate keep their
heading).

| Frames | Action |
| --- | --- |
| 1–16 | The crate waits at the pick station; the arm swings from home to above it (hold at 16–19). |
| 19–28 | Descend. 28–33: the fingers close (shape key); Child Of influence → 1 at 33. |
| 34–43 | Lift. |
| 43–63 | Swing through the front of the cell to the pallet (J4 counter-rotates). At 44–62 the conveyor moves every waiting crate one pitch (1.05 m) forward. At 45–51 the infeed door opens and the next crate rolls out; at 58–64 the door closes behind it. |
| 63–72 | Lower onto the free slot; release at 72 (influence → 0, crate keyed at its place). |
| 72–77 | The fingers open. 78–96: lift and return home. |

At frame 96, every crate on the conveyor stands where the crate ahead of it stood at frame 1, and
the infeed door is closed again. The conveyor part of the GIF therefore loops seamlessly. The one
change at the loop point is on the pallet: the crate placed there disappears, and its slot is
empty again at frame 1. The door moves while the camera follows the gripper to the pallet, so the
GIF shows it only at the edge of the frame.

## Verification (part of every build)

After building, `build.mjs` checks the evaluated scene through MCP queries and aborts if any check
fails:

- **IK.** `armature.describe` at 17 frames: the wrist joint reaches the IK target (worst error
  **0.0 mm**).
- **Carry, fingers, focus.** `get_object {frame}` (evaluated values) at the same 17 frames:
  - The crate sits at the pick station before the grip, rides with the gripper while gripped and
    stays on its slot after the release (worst error **0.06 mm**).
  - The Child Of influence is 0 / 1 / 0 and the `Grip` shape key is 0 / 1 / 0 as planned.
  - The camera's evaluated DOF focus distance follows the gripper (3.9–5.7 m).
- **Hose.** `get_mesh_data {source: EVALUATED, space: WORLD}` at 8 frames:
  - The hose root stays on its turret fitting, within **0.02 mm**. The check compares it with the
    rest-pose root turned by the J1 yaw, so it also catches the root sliding up, down or around
    the fitting.
  - The hose stays centred in its three clamps (at most **0.1 mm** from the ring centres, which
    are read with `get_object`).
  - The wrist end keeps its distance to the wrist joint (0.1265 m at every frame).
- **Clearances.** `scene.measure {frame}` (closest distance between the actual surfaces) at 12
  frames that cover the elbow's 78–127° range and the shoulder's range:
  - The hose touches neither the upper arm, forearm, elbow motor, elbow housing, elbow gear,
    shoulder housing nor turret.
  - Neither the elbow motor nor the forearm touches the upper arm.
  - The tightest clearances are 11.2 mm (hose to elbow housing), 12.6 mm (forearm to upper arm)
    and 13.5 mm (elbow motor to upper arm).
- **Grip clearance.** `scene.measure {frame: 50}`: 2 mm between the finger pads and the carried
  crate, no intersection.
- **Conveyor loop.**
  - `get_object` at frames 1 and 96: each of the five queued crates moved exactly one pitch, and
    the first one reaches the pick station.
  - Nine `scene.raycast {frame: 1}` rays go from the camera to the corners and the centre of the
    crate waiting inside the hood. All of them hit something else first, so that crate is
    invisible.
  - The door is closed at frames 1 and 96. `scene.measure` every 2nd frame from 44 to 64 shows
    that it never touches the crate passing under it.

## Editor features exercised

- **MCP tools:** `list_projects`, `delete_project`, `create_project`, `set_scene_settings`,
  `run_operator`, `batch` (with per-operation warning reports), `add_modifier`, `edit_mesh`,
  `duplicate_object`, `transform_object`, `insert_keyframe`, `set_active_camera`, `get_scene`,
  `get_object` (evaluated values and world transforms at a frame), `get_mesh_data` (weights,
  evaluated vertices), `render_image`, `render_animation` (CONTACT_SHEET, GIF), `export_scene`.
- **Operators:** `object.armature_add`, `armature.bone_update`, `armature.chain_add`,
  `armature.properties_set`, `armature.describe`, `pose.ik_add`, `pose.constraint_add`,
  `object.parent_set` (BONE, ARMATURE_AUTO, OBJECT), `object.parent_to`,
  `object.vertex_group_set_weights`, `object.shape_key_add`, `object.shape_key_set_positions`,
  `object.constraint_add` (CHILD_OF, DAMPED_TRACK), `constraint.describe`,
  `anim.keyframes_insert_many` (LINEAR, CONSTANT and BEZIER keys), `anim.driver_add`,
  `object.generate_gear`, `object.generate_pipe`, `object.generate_fence`,
  `object.add_mesh_from_data`, `mesh.primitive_cylinder_add`, `mesh.primitive_torus_add`,
  `object.text_add`, `object.empty_add`, `object.camera_add`, `camera.properties_set` (depth of
  field), `object.light_add` (RECTANGLE / SPOT), `object.look_at`, `object.modifier_add`,
  `material.new`, `material.update`, `material.preset_apply`, `material.procedural_set` (NOISE,
  WAVE, BRICK; base colour, roughness, alpha, normal), `object.material_assign`,
  `object.material_slot_assign`, `object.shade_smooth`, `object.shade_auto_smooth`,
  `object.select`, `scene.frame_set`, `scene.measure`, `scene.raycast`.
- **Modifiers:** ARRAY (rollers, legs, pallets, pallet stack), MIRROR, BEVEL, ARMATURE (from
  ARMATURE_AUTO).
- **Rendering:** path tracer with denoising, depth of field, area-light shapes, mist and AgX;
  path-traced contact sheet and GIF.

## Rebuild

```bash
# 1. A server (any port; run `npm run build` first if apps/server/dist is missing). The build
#    deletes and recreates the project "robot-workcell" on it.
PORT=4503 npm start &                               # or any running server / the Docker image

# 2. The build. The modes are exclusive; the scene is always rebuilt and verified first.
MCP_URL=http://127.0.0.1:4503/mcp node examples/robot-workcell/build.mjs
#   (no flag)          final renders: render.png, contact_sheet.png, preview.gif
#   --no-render        build + verify only (about 9 s)
#   --export-only      build + verify, then scene.glb (no renders)
#   --preview=DIR      build + verify, then RASTER stills, a RASTER contact sheet and a small
#                      path-traced frame into DIR (outputs untouched)
#   --still-only / --anim-only   only the still / only the contact sheet and GIF
#   --still-time=S     time limit of the still (default 480 s)
```

Unknown, repeated or incomplete arguments (for example `--preview` without `=DIR`) and
contradictory combinations (two modes, `--still-only --anim-only`, final-render options with a
mode) are rejected before anything is built, so a typo can never start the final renders and
overwrite the outputs.

FINAL_RUN_BUILD_SENTENCE The renders take the rest of the time. They are time-limited, so the
samples reached depend on the CPU. The script prints the project's editor URL
(`http://<host>/?project=<id>`): open it to scrub the timeline and inspect the rig, the
constraints, the shape key and the driver in the web editor.

## Final production run

FINAL_RUN_SECTION

## Known limitations

- **The GIF is one cycle, not a perfect loop.** The conveyor and the infeed door loop seamlessly,
  but at the restart the crate on the pallet disappears and its slot is empty again.
- **No IK locks.** The editor has no per-bone IK locks or limits (Blender `lock_ik_*`), so the IK
  chain covers only the two pitch joints. J1's yaw and J4's roll are keyed per frame from the
  target azimuth (a commented workaround in `build.mjs`). A real palletizer keeps the wrist
  vertical mechanically; here a Damped Track on J4 does it.
- **Hose weights needed a fix-up.** On the hose, the automatic weights blend too far along the
  arm, so the build pins the stretches at the root and the clamps to their bones (see above). The
  editor has no weight clean-up operators (limit total, levels, smooth) to do this without
  computing the weights in the script.
- **Fence infill is a separate object.** `object.generate_fence` makes posts and rails or
  pickets only, so the welded wire mesh is a panel object with a procedural BRICK alpha. At GIF
  resolution the 8 mm wires are sub-pixel and shimmer slightly.
- **Rollers do not turn.** They are smooth cylinders of one ARRAY object, so a spin would be
  invisible. The crates' conveyor ride is keyframed, not simulated.
- FINAL_RUN_SAMPLES_LIMITATION
- **scene.glb** is written by `--export-only` from the live, rigged scene. Area lights become
  point lights in glTF, and procedural textures are baked through automatically generated UVs
  (both are reported as `export_scene` warnings). It will be regenerated with the finished glTF
  exporter.
