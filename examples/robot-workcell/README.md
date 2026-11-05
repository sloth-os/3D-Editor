# Robot palletizing workcell ("Cell 04")

An original industrial pick-and-place cell, built entirely through the editor's MCP server by
[`build.mjs`](build.mjs). A four-axis palletizing robot takes a plastic crate off the end of a
roller conveyor and sets it into the last free slot of a pallet. The cell has a welded-mesh safety
fence, hazard-striped floor markings, a light curtain, an E-stop station, a stack of empty pallets
and a controller cabinet with a signal tower, inside a dim factory hall.

![render](render.png)

![preview](preview.gif)

## What is in the scene

| Part | How it is made |
| --- | --- |
| Robot (teal, graphite joints) | `object.armature_add` + `armature.bone_update` + `armature.chain_add`: 4 joints. **J1_Base** yaws about Z, **J2_Shoulder / J3_Elbow** pitch (2-bone IK) and **J4_Wrist** rolls the gripper about the vertical. 16 rigid parts (turret, yoke, motors, housings, tapered arm segments, wrist flange, gripper, hose clamps) are bone-parented with `object.parent_to {type: BONE, bone}`. |
| Gears | `object.generate_gear` (slewing ring on J1, gear wheels on the shoulder and elbow), bone-parented so they turn with their joints |
| Dress-pack hose | `object.generate_pipe` along a densified path over the arm, bound with `object.parent_set {type: ARMATURE_AUTO}` (automatic weights → Armature modifier), so it bends with J1/J2/J3 |
| IK | `pose.ik_add` on J3_Elbow (chain 2) targeting the keyframed empty `IK_Target`; `pose.constraint_add DAMPED_TRACK` on J4 aims at `Wrist_Aim` (a child of the target 1 m below), which keeps the wrist vertical like a palletizer's parallel link |
| Gripper fingers | One mesh (`object.add_mesh_from_data`) with a `Grip` shape key (`object.shape_key_add` + `object.shape_key_set_positions`) that moves both fingers 58 mm inwards; keyed open → closed → open |
| Crate | Ribbed tote mesh + BEVEL modifier; 4 linked duplicates (`duplicate_object linked`) |
| Carry | A `CHILD_OF` constraint (`object.constraint_add`) on the crate targeting bone J4_Wrist of the rig, with keyed influence (0 → 1 at the grip, 1 → 0 at the release). The crate's own location is keyed for the conveyor ride and, at the release frame, to the place position read back with `constraint.describe`. |
| Conveyor | A single roller with an **ARRAY** modifier (42 rollers), one leg with **MIRROR + ARRAY**, a frame, a low end stop and a photo-eye sensor |
| Pallets | One deck board, block and base board each, multiplied by ARRAY modifiers (5 boards, 3 × 3 blocks, 3 base boards). The empty-pallet stack adds a Z ARRAY. Wood comes from `material.preset_apply wood` with re-coloured `material.procedural_set` |
| Floor | Epoxy floor with NOISE base colour and roughness, plus **procedural safety stripes**: a WAVE texture (BANDS, DIAGONAL, SAW profile, CONSTANT ramp) on the hazard border, the robot danger zone and the cable protector |
| Safety fence | `object.generate_fence` (two RAIL runs that leave a gap for the conveyor). Infill panels are thin boxes whose alpha is a procedural BRICK texture with no row offset (mortar = wire, bricks = holes, blend CLIP), which gives a welded wire mesh |
| Signage | `object.text_add` ("CELL 04 - PALLETIZING", "AUTOMATIC MACHINE - KEEP OUT") on a yellow plate |
| Status lamp | `anim.driver_add` on the amber lamp material's `emission_strength`: `14 * (fract(frame / 12) < 0.5)` (blinks) |
| Hall | Corrugated walls (WAVE bump on the normal channel), mullioned emissive windows, steel columns |
| Camera | `object.camera_add` + `object.look_at`, then a **DAMPED_TRACK** constraint (`TRACK_NEGATIVE_Z`, influence 0.5) on `Robot_Gripper`, so the camera pans with the gripper between conveyor and pallet |
| Lighting | Three area lights (warm key, cool rim, dim fill) aimed with `object.look_at`. Dark world colour, mist (`set_scene_settings mist_distance`), AgX view transform |

## Animation (96 frames, 24 fps)

The IK target path is computed in the script in cylindrical coordinates (azimuth, radius,
height) with smootherstep easing between waypoints. Every frame is keyed with
`anim.keyframes_insert_many`: the target location, J1's yaw (= the target azimuth, so the target
always lies in the arm plane) and J4's roll (= yaw − π, so the gripper and crate keep their heading).

| Frames | Action |
| --- | --- |
| 1–18 | crate rides the conveyor to the pick station; arm swings from home to above it |
| 19–28 | descend; 28–33 fingers close (shape key), Child Of influence → 1 at 33 |
| 34–43 | lift |
| 43–63 | swing through the front of the cell to the pallet (J4 counter-rotates) |
| 63–72 | lower onto the free slot; release at 72 (influence → 0, crate keyed at its place) |
| 72–77 | fingers open; 78–96 lift and return home |

The script verifies the rig through MCP queries after building. `armature.describe` gives the wrist
head vs. the target at 10 frames: **0.0 mm** IK error. `constraint.describe` gives the carried
crate vs. the gripper: **0.0 mm** offset error, and the crate lands exactly on its slot.
`scene.measure` at frame 50 reports a 2 mm gap between the finger pads and the crate, with no
intersection.

## Rebuild

```bash
# server (any port); the build deletes and recreates the project "robot-workcell"
PORT=4503 node .phase3/app/dist/main.js &        # or the normal server: npm start / docker
MCP_URL=http://127.0.0.1:4503/mcp node examples/robot-workcell/build.mjs
#   --no-render       build + verify only (~3 s)
#   --preview=DIR     extra RASTER previews and a raster contact sheet into DIR
#   --still-only / --skip-still
```

Building the scene takes about 3 s (about 300 MCP calls, most of them batched). The renders take
the rest of the time.

## Outputs

RENDER_STATS_PLACEHOLDER

## Known limitations and workarounds

- **scene.glb is a baked, reduced variant.** The glTF exporter ignores bone parenting (bone-parented
  objects land in a heap at the armature origin). It also exports no armatures/skins, IK,
  constraint results or shape-key animation; only object F-curves are written. Before export,
  `build.mjs` therefore runs `anim.bake_transforms {clear_parents, clear_constraints}` on the 16
  bone-parented parts, the crate and the camera (96 frames of world-space keys). It exports
  everything except the skinned hose and the rig helpers (`Robot_Rig`, `IK_Target`, `Wrist_Aim`),
  then calls `undo` so the live project keeps its rig. In the GLB the robot, crate and camera
  move. The gripper fingers stay open (no morph targets) and the hose is missing.
- **UV maps only for the exporter.** Procedural textures use OBJECT mapping and render without UVs,
  but the glTF exporter needs UVs to bake them to PNG, and otherwise skips them silently. The
  build adds `uv.smart_project` UVs to the 12 meshes with procedural materials.
- **Area light sizes are set through a keyframe.** `object.light_add` ignores `radius` for area
  lights, and `data.set_property` cannot find a light datablock by object name; MCP exposes no
  datablock id. The build therefore sets `data.size` / `data.size_y` with a single constant
  `insert_keyframe`.
- **Low sample counts.** The CPU was shared with other agents (load average 12–16 on 4 cores). The
  path tracer reached far fewer samples than requested within the time limits; see the table above.
  The denoiser cleans 2+ sample frames well. It cannot filter a 1-sample frame (zero variance
  estimate), so the GIF and contact sheet use a per-frame time limit that guarantees at least 2
  samples.
- The animation is one cycle, not a seamless loop: at the GIF's restart the placed crate jumps
  back onto the conveyor. The rollers do not spin. The crate's conveyor ride is keyframed, not
  simulated.
- `object.generate_fence` only makes rails or pickets. The welded wire infill is a separate panel
  object whose alpha is a procedural BRICK texture (blend CLIP).
- The wrist roll (J4) is keyed per frame as `yaw − π`, so the gripper keeps its heading. A real
  palletizer does this mechanically. The arm's yaw is likewise keyed from the target azimuth,
  because bone IK here has no per-axis locks.

Editor issues found while building this example (with repros) are collected in the Phase-3 report
(`/tmp/phase3/robot-workcell-issues.json`).
