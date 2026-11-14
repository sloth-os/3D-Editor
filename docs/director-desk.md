# The director's desk

The director's desk turns the editor into a previs tool for AI video: you build a scene once (a
set, actors that walk, run, sit and ride, props from the [model store](model-store.md), physics),
cut it into shots (a camera and a range of scene frames each), let the solver place the cameras
from a shot description, check continuity across the cuts, and render every shot as a
frame-exact reference clip with the [video export](video-export.md). Its first consumer is the AI
video studio rideo: [rideo.md](rideo.md) shows how a rideo clip comes in, and how our blocking and
clips go back to it.

AI video models are good at texture and light and bad at what a 3D scene gets right for free:
props and the sun stay on their side from cut to cut, the camera keeps to one side of the 180°
line, a kite on a string pulls against the wind instead of floating like a balloon, a rider sits
on the horse. The desk stages that once, in metres, and hands the model a reference video (and a
blocking line that says the same thing) for each shot.

Contents:

- [Concepts](#concepts): set, actors, props, shots, cut order and coverage, camera solver,
  camera moves, continuity checks, physics presets, kites and balloons, vehicles
- [The agreement principle](#the-agreement-principle) with rideo
- [In the editor](#in-the-editor): the Director workspace, the Asset Browser, Export Video
- [Over MCP](#over-mcp): the operators and their parameters, and a
  [worked example](#worked-example-a-kite-on-a-hill)
- [Coordinates](#coordinates)
- [Limits and known gaps](#limits-and-known-gaps)

## Concepts

Everything the desk does is an operator in the editor's registry (`desk.*` and `store.*`, 27
operators): menus and panels in the browser, `run_operator` and `batch` for MCP agents, one undo
step per call. The shots and the desk settings are part of the scene document, so they sync live
to every editor and agent that has the project open.

### The set

`desk.set_build` builds rideo's set: a ground plane of `width` × `depth` metres (default 12 × 10,
centred on the origin) whose colour comes from what the ground is (`ground`: grass, sand, road,
wooden floor …, with rideo's colour table), a SKY world whose sun stands at `sun_azimuth_deg` and
`sun_elevation_deg` (default 135° and 40°, rideo's defaults), and with `interior: true` four 3.2 m
walls facing into the room (their backs are culled, so a camera outside the room sees in). The sky
sun is the one key light; with `sky: false` the world is the STUDIO environment and one SUN lamp
shines from the same direction. Building the set again replaces what it built before, and the
materials and lights only it used.

Landmarks (a barn, a lake, trees) are store models or plain objects; the solver pushes cameras out
of solid ones and lets them stand over water (`desk_shape: 'water'`, a store model's water part,
or a label whose head noun is lake, sea, river …).

### Actors

`desk.actor_add {kind, name?, color?, height_m?, location?, facing_deg?, pose?}` adds a rigged
mannequin: an ARMATURE with fixed bone names and one low-poly mesh part per bone in the actor's
colour, with darker joints and a nose so the facing reads in every frame.

| Kind                             | Default height                      | Notes                                                                                                                                                                       |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adult`, `man`, `woman`          | 1.7, 1.76, 1.64 m (top of the head) | humanoid bones `root`, `hips`, `spine`, `chest`, `neck`, `head`, `shoulder.L/R`, `upper_arm.L/R`, `forearm.L/R`, `hand.L/R`, `thigh.L/R`, `shin.L/R`, `foot.L/R`, `toe.L/R` |
| `child`, `toddler`, `elder`      | 1.2, 0.9, 1.65 m                    | a child has a larger head; an elder stoops slightly                                                                                                                         |
| `horse`, `pony`, `donkey`, `cow` | 1.6, 1.2, 1.1, 1.4 m (withers)      | quadruped bones plus a `saddle` bone: the four mounts                                                                                                                       |
| `dog`, `small_dog`, `cat`        | 0.55, 0.3, 0.25 m                   | quadruped bones `root`, `hips`, `spine`, `chest`, `neck`, `head`, `tail.1`–`tail.3`, `upper_leg` / `lower_leg` / `foot` × `.FL/.FR/.BL/.BR`                                 |
| `sheep`, `pig`, `deer`, `bear`   | 0.75, 0.65, 1.0, 1.05 m             |                                                                                                                                                                             |
| `duck`, `bird`                   | –                                   | not built yet: refused with the list of the built kinds                                                                                                                     |

Colours default to rideo's cast palette in order (#ff8a3d, #3d8bff, #3dbe6b, #a35bff, #f2c230,
#ff5fa2, #2ec4c4, #e5484d). An actor is about 3,300–4,100 triangles.

- **Poses** (`desk.actor_pose {actor, pose, frame?, blend_frames=6, hold_frames?, layer='auto'}`):
  rideo's ten (`stand`, `walk`, `run`, `sit`, `crouch`, `kneel`, `lie`, `reach`, `point`, `wave`)
  plus `idle`, `talk`, `arms_crossed`, `hands_on_hips`, `carry`, `throw`, `kick`, `jump`, `look_up`,
  `ride` and `sit_ground`; animals `stand`, `walk`, `trot`, `gallop`, `sit`, `lie`, `eat` and
  `look_up`. The gestures (reach, point, wave, talk, arms_crossed, hands_on_hips, carry, look_up)
  move only the upper body when the actor sits, kneels, crouches, lies, rides or walks at that frame
  (`layer: 'auto'`; `'full'` always keys the whole body, `'upper'` never the legs). A pose stays
  until the next one: `hold_frames` only adds a key where the hold ends, so key `stand` or `idle`
  after a gesture to end it.
- **Walking**
  (`desk.actor_move {actor, points, frame_start, speed_mps? | frame_end?, gait='auto', face_path=true, end_pose?}`):
  the armature object's location and heading are keyed along the path, and a gait is keyed for every
  cycle with the stride matching the speed, so the feet do not slide (planted feet drift 1–2 cm).
  Walk 1.3 m/s and run 3.5 m/s by default; animals walk, trot and gallop. Turns sharper than 135°
  split the path, with a stepped turn on the spot. The result gives the arrival frame and the length
  walked (corners rounded).
- **Facing and looking**: `desk.actor_face {actor, facing_deg | target, frame, turn_frames=8}` turns
  the body (stepping round on the spot);
  `desk.actor_look_at {actor, target | null, frame, blend_frames=6}` turns the head toward an
  object, `null` looks ahead again.
- **Holding** (`desk.actor_hold {actor, prop, hand='right', frame, release_frame?}`): the prop
  glides into the hand over the 6 frames before `frame` (a CHILD_OF constraint on the hand bone
  whose influence is keyed 0 → 1) and the arm takes a carrying posture. At `release_frame` its
  visual transform is keyed; a prop with a rigid body falls or flies from there, one without stays
  where it was let go.
- **Riding** (`desk.actor_mount {rider, mount, frame, dismount_frame?}`): a humanoid sits in the
  `ride` pose on the `saddle` bone of a horse, pony, donkey or cow, with the legs round the
  barrel.

Locomotion moves the armature object, never the `root` bone, so an actor's object transform is
where it stands: the camera solver, the checks, the subject tracks of the export and the rideo
export all read it.

### Props and the model store

`store.add {model, name?, location?, rotation_deg?, height_m? | width_m? | depth_m? | scale?, color?, params?}`
adds one of the 170 built-in procedural models at its real size: an EMPTY root with named parts, the
origin at the base centre, the front facing −Y. People and animals in the catalog are actors.
External models (Khronos samples, Poly Haven, Sketchfab, Poly Pizza, your own JSON catalogs) come
through the server's `store_add` tool or the Asset Browser and are normalized the same way, with
their licence and attribution recorded on the root. See [model-store.md](model-store.md).

### Shots, cut order and coverage

A shot is a camera over a range of scene frames, with what it should show:

| Field                                   | Meaning                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`, `enabled`                       | a disabled shot stays in the list but is left out of the cut                                                                   |
| `camera`                                | a CAMERA object (`desk.shot_add` makes one named after the shot when none is given)                                            |
| `frame_start`, `frame_end`              | scene frames, inclusive; the clip of the shot has `frame_end − frame_start + 1` frames                                         |
| `framing`, `angle`, `height`, `lens_mm` | the shot description the solver works from (rideo's words, below)                                                              |
| `move`                                  | the camera move over the shot (one of rideo's 20 move ids)                                                                     |
| `subjects`, `layout`                    | the actors and props it shows (the first leads), and the planned screen layout: who is left, centre or right, facing which way |
| `continuity`                            | `cut`, or `continuous` when the action carries on from the shot before                                                         |
| `pre_roll`                              | frames before `frame_start` that are animated and simulated but never exported                                                 |
| `notes`, `external`                     | free text (2000 characters), and the rideo clip and shot it came from                                                          |

The **cut order** is the order of the list (`desk.shot_move` reorders it). Shots may overlap in
scene time: two cameras on the same action are **coverage**, and the cut decides which one the
film shows. `desk.shot_add` without a range puts the new shot after the last one (`duration_s`,
default 5 s at the scene's fps) and extends the scene's frame range. Two shots on the same camera
may not overlap (the second is refused, naming both); give each angle its own camera.

The desk settings (`desk.import_rideo_blocking` writes them) hold the set size, the main pair of
the 180° line (default: the two actors who share the most shots), the aspect the shots were
solved for (default: the render resolution's) and the video model's shortest and longest take:
shots outside them get a `duration_clamped` warning, and an export with `match_model_duration`
pads or trims the clips.

### The camera solver

`desk.shot_solve {shots?, enforce_line=true, fit_plan=true, keep_lens=false, only_missing=false}`
(and `desk.shot_add` / `desk.shot_update` when the description changes) places each camera the
way rideo's own solver does, so the camera views agree with rideo's: positions match rideo's
within 1.5 mm in the tests, and a camera only stands back from rideo's position when rideo's would
lose a subject during the shot.

| Framing            | Coverage (m) | Default lens (mm) | Look-at height |
| ------------------ | ------------ | ----------------- | -------------- |
| `extreme_wide`     | 10           | 18                | 0.5            |
| `wide`             | 4.2          | 24                | 0.5            |
| `medium`           | 1.25         | 35                | 0.72           |
| `medium_close`     | 0.85         | 50                | 0.8            |
| `close_up`         | 0.45         | 85                | 0.92           |
| `extreme_close_up` | 0.22         | 100               | 0.93           |
| `over_shoulder`    | 1.1          | 50                | 0.88           |
| `pov`              | 2.5          | 28                | 0.9            |
| `insert`           | 0.35         | 85                | 0.55           |

- **Lens and sensor**: a 36 mm wide sensor (`sensor_fit: HORIZONTAL`); `lens_mm` 8–800 overrides
  the framing's lens.
- **Angle** around the subjects: `front`, `three_quarter_left` / `three_quarter_right` (±35°),
  `profile_left` / `profile_right` (±90°), `back`, `over_shoulder`, `pov`. **Height**: `eye`,
  `low`, `high` (1.2 m above the head), `overhead` (4 m above the head).
- **The plan** (`layout`): the solver keeps the camera whose view puts each subject on its planned
  side, facing the planned way (it tries front, both three-quarters, both profiles, back and both
  shoulders); `plan_mismatch` when none agrees. The plan wins over the line.
- **The 180° line**: cameras that crossed the line of the main pair are mirrored to its side
  (orbits are exempt).
- **In frame over the whole shot**: a camera is fitted over the shot's frames, not only its first,
  standing back at most about one framing step (twice its framing's distance, 2.4 times for `wide`,
  4 times for `extreme_wide`, never for `over_shoulder` and `pov`); a shot that names no angle may
  take a side angle that keeps its subjects at its framing. Animals are framed by their body length,
  flying props do not set the camera height, and `tracking_follow` and `steadicam_walk` follow the
  group. The result names each shot that stands back far enough to read as another framing
  (`widened`, `effective_framing`), loses a subject (`out_of_frame`) or gives up its plan
  (`gave_up`).
- **Seeing past bystanders**: a camera through which an actor the shot does not frame hides a
  subject (its eyes, or its body below them) steps up to 20° aside or 1 m up to see past them.
  Subjects still hidden are listed in the result (`occluded`, with the frames and who hides them),
  and a warning (`occluded_subject`) suggests restaging, adding the bystander to the subjects or
  another angle or height; `desk.check` runs the same test through the camera as keyed. A rider's
  mount does not hide her, nor she it.

`desk.shot_add` with `from_view: {position, target, lens_mm}` places the camera at a view (the
viewport's, in the editor) instead of solving it.

### Camera moves

`move` on a shot (or `desk.camera_move {camera | shot, move, frame_start?, frame_end?, amount?}`)
keys the move over the shot's range; `amount` scales the library's distance or angle (1 by
default):

| Move                                | What is keyed                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `locked_off`                        | nothing                                                                            |
| `push_in`, `pull_out`               | 35 % of the distance toward or away from the subject, eased                        |
| `dolly_left`, `dolly_right`         | 1.5 m sideways, eased (a camera mirrored over the line keeps the screen direction) |
| `crane_up`, `crane_down`            | 2 m up or down, eased                                                              |
| `pan_left`, `pan_right`             | 30° of rotation only                                                               |
| `tilt_up`, `tilt_down`              | 15° of rotation only                                                               |
| `orbit_left`, `orbit_right`         | 30° round the target, at least 8 keys on the arc                                   |
| `whip_pan`                          | a 90° turn over 6 frames in the middle of the shot                                 |
| `handheld`                          | a NOISE F-curve modifier (3 cm, 0.012 rad), seeded by the shot                     |
| `steadicam_walk`, `tracking_follow` | follows the subjects, a key on every frame (steadicam with a 1.2 cm bob at 1.8 Hz) |
| `dolly_zoom`                        | the lens against the distance, keeping the subject's size                          |
| `drone_flyover`                     | a high arc that rises at least 4 m                                                 |
| `rack_focus`                        | depth of field on, focus near → far over the middle third                          |

A camera keeps its roll (a dutch angle) through its moves, and a move on a camera that another
shot also uses keeps that shot's first and last view.

### Continuity checks

`desk.check {shots?}` changes nothing and returns `{issues, lines, layouts, summary}`:

| Severity | Codes                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| error    | `line_crossed`, `subject_out_of_frame` (at the shot's first, middle and last frame; a pan's or tilt's first and last), `camera_inside` (water exempt), `missing_camera`, `tether_detached` (a kite's string left over 5 cm from its anchor) |
| warning  | `plan_mismatch`, `screen_direction`, `jump_cut`, `absent_in_frame`, `subject_hidden`, `subject_revealed` (brought in by a pan or tilt), `occluded_subject`, `actors_overlap` (< 0.35 m), `outside_set`, `empty_shot`, `duration_clamped`    |
| info     | `physics_unbaked`, `shot_gap`                                                                                                                                                                                                               |

Objects put away by a hide key (scaled to nothing: `after: 'hide'` of `desk.tether_fly`, the actors
and props a rideo import hides) are nowhere at the frames they are hidden: a subject hidden at a
frame the check samples is `subject_hidden`, not `subject_out_of_frame`, a hidden bystander is never
`absent_in_frame` and hides nobody, and the solver frames the subjects shown at each frame.
`occluded_subject` is a subject hidden behind an actor the shot does not frame (see above). A pan
or a tilt turns away from its subjects by design, so only its first frame must frame them; one it
brings into the frame by its last frame instead is `subject_revealed`, and one in the frame at
neither is `subject_out_of_frame`. A rider and the mount she sits on move as one: they are never
the pair of the 180° line where she rides, and cross the frame once, as the mount
(`screen_direction`).

`lines` gives each shot's blocking line in rideo's own sentence format, which is what rideo puts
into its prompts, e.g. "Blocking: Ada is left of frame, facing right. Light: the sun is ahead of
the camera, behind the scene." The export's manifest carries the same line for every shot, so a
push can compare it with rideo's.

### Physics presets

The presets give props rigid bodies that start at a frame, and fit the rigid body world to the
frames the bodies need:

- `desk.physics_setup {objects, kind='active', shape?, mass?, friction?, restitution?, ground=true}`:
  `active` (falls and collides), `passive` (a floor, a wall) or `animated` (follows its keys and
  pushes active bodies); SPHERE for balls (by name or store tag), BOX for other bodies, MESH for
  passive ones; a passive ground at z = 0 when none is under them.
- `desk.physics_drop {objects, frame, height?}`,
  `desk.physics_throw {object, target, frame, flight_s=1, spin?}` (the launch velocity that lands it
  on a point or an object after `flight_s`),
  `desk.physics_push {object, direction, speed_mps, frame}`.
- `desk.physics_bake {frame_start?, frame_end?, objects?}`: keys the simulation and removes the
  rigid bodies and the hold constraints of held props, so renders and exports need no simulation
  (at most 2,000,000 body frames per bake). A store model's body moves the model's root, so the
  model stays one object.

A body with a start frame follows its keys, its parent or the hand that holds it until then
(kinematic), and is simulated from there with the velocity it had (plus any launch velocity): a
ball thrown from a hand leaves at the hand's speed.

### Kites and balloons

`desk.tether_fly {flyer, anchor, anchor_bone?, length_m, wind_dir_deg, wind_mps, frame_start, frame_end, launch_frames?, tail=true, string=true, seed?, after='hold'}`
flies a kite or a balloon on a string tied to an anchor, usually an actor's hand
(`anchor_bone: 'hand.R'`), in seeded wind with gusts and lulls. The string is never longer than
`length_m` and the kite never goes below the ground; a kite flies at about 55° above the anchor in
6 m/s of wind (53–55° over three seeds), lower and less steadily in light wind (33–45° in 3 m/s),
and dips in the lulls. It rises over `launch_frames` (default: the string paid out at 2.5 m/s, at
least 2 s; 0 starts already flying). The string is an object of its own (`desk_role: 'string'`),
drawn by the video export as a line at least 2 px wide, so it never vanishes at a distance. After
`frame_end`, `after` decides: `hold` leaves the kite where the flight ends, `hide` hides kite, tail
and string, and `land` brings a kite down to lie on the ground downwind (1.6 times as long as a
stone dropped from its height takes, at least 1.5 s). A kite can fly again: each flight keys only
its own frames and reuses the string and the tail, one flown over an earlier flight replaces it from
its `frame_start` on, and between two flights kite, string and tail stay as the earlier one left
them. The flight keys the string where the anchor is at each of its frames, so fly the kite after
the anchor's own moves: an anchor walked, posed, mounted or handed a prop afterwards leaves the
string behind. `desk.check` reports a string more than 5 cm from its anchor (`tether_detached`),
and `desk.actor_move`, `desk.actor_pose`, `desk.actor_face`, `desk.actor_hold` and
`desk.actor_mount` warn when they leave one behind; `desk.tether_fly` again with the same options
ties it back on.

### Vehicles

The catalog's vehicles (sedan, hatchback, SUV, pickup truck, van, bus, bicycle, motorcycle, rowboat,
sailboat) share a rig: an EMPTY root, `body`, `wheel.FL/FR/BL/BR` turning about their hub and
`steer.FL/FR` pivots, and `saddle` empties for riders.
`desk.vehicle_drive {vehicle, points, frame_start, speed_mps | frame_end}` drives one along a smooth
path with an eased speed: each wheel turns with its own travel (no slip), and the front wheels steer
into the turns (at most 35°, 120°/s).

## The agreement principle

rideo's own failure analysis found that when the shot description, the blocking line and the
camera view disagree, the generated frames follow none of them. So everything the desk hands
rideo agrees with what rideo already tells its model:

1. Each shot's planned layout (`shot.layout` in rideo: who is left, centre or right, facing which
   way) is respected: cameras are fitted to it, and `plan_mismatch` says when no camera can be.
2. Our final blocking is written back to rideo before any reference clip is pushed, so rideo's
   camera view, blocking line and camera move derive from the same staging as the clips.
3. The camera move we render is the one rideo prompts: the push sends `camera.move` with the
   reference.
4. When rideo's first frame cannot have been drawn from our staging (rideo's desk view is off for
   the project, or the shot's storyboard frame was approved before), the push says so, lists the
   boards to redraw and makes that shot's reference a camera reference.

How much this helps real video models is not measured yet: the defaults stay conservative, and
[rideo.md](rideo.md#what-rideo-should-measure-first) lists the scenes to measure first.

## In the editor

**Director workspace** (the workspace tabs at the top): the right column holds the Director panel
with three tabs, and the bottom area opens on the Sequence tab.

- **Shots**: the shot list in cut order (name, length, framing, camera, frames, issue count) with
  Add from view, duplicate, delete (the camera made for the shot goes too), up, down, look through,
  Solve, Solve all and Check; Check lists the issues, and clicking one selects its shot and
  objects. Below it the shot inspector edits every field (one undo step each) and shows the
  blocking line of the last check.
- **Actor**: the selected actor's kind, colour and height; Pose (at the current frame), Walk or Run
  to the 3D cursor (animals Walk, Trot, Gallop), Look at, Face 3D cursor; with no actor selected,
  an Add button per built kind (also in Add › Actor).
- **Assets**: the Asset Browser, also a bottom tab of its own: search, a provider select with each
  provider's state, category chips, lazily loaded thumbnails, licence badges, Add, and drag and
  drop onto the viewport (onto what is under the mouse, else the ground at z = 0, else the 3D
  cursor). External models are downloaded through the server and inserted in the browser with
  `store.insert_files`, so Ctrl+Z undoes them.
- **Sequence** (bottom tab): one block per shot, proportional to its length, with timecode and a
  playhead; click or drag to scrub, ←/→ and Shift+←/→ step, Home/End jump, Space plays the cut
  through the shot cameras.
- **View › Follow Shots** makes the viewport's camera view, F12 and Render Animation look through
  the camera of the shot at the current frame (`view3d.toggle_follow_shots`); **View › Camera
  Guides** draws the rule-of-thirds lines and a 93 % action-safe frame
  (`view3d.toggle_camera_guides`). Both also sit in the viewport header in camera view and in the
  Director workspace.
- On a phone (760 px wide or less) a Shots bottom tab hosts the Director panel.

**Render › Export Video…** (Ctrl+Shift+F12) opens the Export Video window: the shots (all, a
selection, or a frame range), the size (the scene's output size, 1280 × 720, 1920 × 1080,
854 × 480, 720 × 1280, 1080 × 1080 or custom), quality, look, passes, codec and outputs, an
estimate of the frames and length, then progress (frame N of T, frames/s, time left, the current
shot) with Cancel, download links, a preview and the recent exports. It needs the server with
ffmpeg (`features.videoExport` in `/api/config`); the standalone app says why it is not available.
See [video-export.md](video-export.md).

## Over MCP

Agents reach every desk operator with `run_operator` / `batch`
(`list_operators {category: "Director"}` lists them with their JSON schemas; the groups Actors and
Model Store narrow it), and the server adds tools for what runs in the background or talks to other
servers: `export_video`, `export_status`, `cancel_export`, `list_exports`, `store_search`,
`store_add`, `rideo_import` and `rideo_push`. `render_image` and `render_animation` take
`camera: 'shots'` to look through the shot cameras.

| Operator                     | Parameters (defaults)                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk.set_build`             | `width` (12), `depth` (10), `ground` ('grass'), `interior` (false), `sun_azimuth_deg` (135), `sun_elevation_deg` (40), `sky` (true)                                                                                        |
| `desk.actor_add`             | `kind`, `name`, `color`, `height_m`, `location` (3D cursor), `facing_deg` (0), `pose` (stand)                                                                                                                              |
| `desk.actor_pose`            | `actor`, `pose`, `frame` (current), `blend_frames` (6), `hold_frames`, `layer` ('auto')                                                                                                                                    |
| `desk.actor_move`            | `actor`, `points`, `frame_start`, `speed_mps` or `frame_end`, `gait` ('auto'), `face_path` (true), `end_pose`                                                                                                              |
| `desk.actor_face`            | `actor`, `facing_deg` or `target`, `frame`, `turn_frames` (8)                                                                                                                                                              |
| `desk.actor_look_at`         | `actor`, `target` (or null), `frame`, `blend_frames` (6)                                                                                                                                                                   |
| `desk.actor_hold`            | `actor`, `prop`, `hand` ('right'), `frame`, `release_frame`                                                                                                                                                                |
| `desk.actor_mount`           | `rider`, `mount`, `frame`, `dismount_frame`                                                                                                                                                                                |
| `desk.shot_add`              | `name`, `camera`, `frame_start`, `frame_end`, `duration_s` (5), `framing`, `angle`, `height`, `move`, `lens_mm`, `subjects`, `layout`, `notes`, `continuity` ('cut'), `pre_roll` (0), `solve` (true), `from_view`, `index` |
| `desk.shot_update`           | `shot` and any field of `desk.shot_add`, `enabled`, `resolve` (null clears framing, angle, height, move, lens_mm or camera)                                                                                                |
| `desk.shot_remove`           | `shots`, `delete_cameras` (false)                                                                                                                                                                                          |
| `desk.shot_move`             | `shot`, `index`                                                                                                                                                                                                            |
| `desk.shot_solve`            | `shots` (all), `enforce_line` (true), `fit_plan` (true), `keep_lens` (false), `only_missing` (false)                                                                                                                       |
| `desk.camera_move`           | `camera` or `shot`, `move`, `frame_start`, `frame_end`, `amount` (1)                                                                                                                                                       |
| `desk.check`                 | `shots` (all enabled)                                                                                                                                                                                                      |
| `desk.physics_setup`         | `objects`, `kind` ('active'), `shape`, `mass`, `friction`, `restitution`, `ground` (true)                                                                                                                                  |
| `desk.physics_drop`          | `objects`, `frame`, `height` (0)                                                                                                                                                                                           |
| `desk.physics_throw`         | `object`, `target`, `frame`, `flight_s` (1), `spin`                                                                                                                                                                        |
| `desk.physics_push`          | `object`, `direction`, `speed_mps`, `frame`                                                                                                                                                                                |
| `desk.physics_bake`          | `frame_start`, `frame_end`, `objects` (every simulated body)                                                                                                                                                               |
| `desk.tether_fly`            | `flyer`, `anchor`, `anchor_bone`, `length_m`, `wind_dir_deg`, `wind_mps`, `frame_start`, `frame_end`, `launch_frames`, `tail` (true), `string` (true), `seed`, `after` ('hold')                                            |
| `desk.vehicle_drive`         | `vehicle`, `points`, `frame_start`, `speed_mps` or `frame_end`                                                                                                                                                             |
| `desk.import_rideo_blocking` | `blocking`, `shots`, `characters`, `elements`, `settings`, `model_limits`, `state`, `cast_overrides`, `project`, `clip`, `pre_roll_frames` (12), `update` (true)                                                           |
| `desk.export_rideo_blocking` | none: returns the scene as rideo's SceneBlocking v1                                                                                                                                                                        |
| `store.add`                  | `model`, `name`, `location`, `rotation_deg`, `height_m`, `width_m`, `depth_m`, `scale`, `color`, `params`                                                                                                                  |
| `store.search`               | `query`, `category`, `limit` (20), `offset` (0)                                                                                                                                                                            |
| `store.insert_files`         | `entry`, `format`, `files` (base64 by path), `main`, `location`, `rotation_deg`, `height_m`, `width_m`, `depth_m`, `name`                                                                                                  |

Objects are named by id or exact name. Operators that add things return ids and names; results
and warnings are in each call's `result` and `reports`. Most rideo users never call the two
`*_rideo_blocking` operators themselves: `rideo_import` and `rideo_push` do (see
[rideo.md](rideo.md)).

### Worked example: a kite on a hill

Two actors, a kite on a string held by the child, six shots, solve, check and a draft export,
with [`scripts/mcp.mjs`](../scripts/mcp.mjs) (run from the repository root with `MCP_URL` set):

```js
import { connect } from './scripts/mcp.mjs';

const mcp = await connect();
const project = 'Kite Hill';
const op = (operator, params) => mcp.call('run_operator', { project, operator, params });

await mcp.call('create_project', { name: project, empty: true });
await mcp.call('set_scene_settings', { project, fps: 24, resolution_x: 1280, resolution_y: 720 });

// the set: a grass field, the sun behind the scene on the right (rideo's default 135°/40°)
await op('desk.set_build', { width: 40, depth: 40, ground: 'grass' });

// two actors facing each other 3 m apart (facing 90: toward +X; -90: toward -X)
await op('desk.actor_add', { kind: 'woman', name: 'Ada', location: [-1.5, 0, 0], facing_deg: 90 });
await op('desk.actor_add', { kind: 'child', name: 'Ben', location: [1.5, 0, 0], facing_deg: -90 });

// a spool in Ben's right hand and a kite on 15 m of string tied to that hand; the wind blows
// toward +Y (180), so a front camera sees the kite behind the pair
await op('store.add', { model: 'kite_spool', name: 'Spool', location: [1.8, 0, 0] });
await op('desk.actor_hold', { actor: 'Ben', prop: 'Spool', hand: 'right', frame: 1 });
await op('store.add', { model: 'diamond_kite', name: 'Kite', location: [1.5, 2, 0] });
await op('desk.tether_fly', {
  flyer: 'Kite', anchor: 'Ben', anchor_bone: 'hand.R', length_m: 15,
  wind_dir_deg: 180, wind_mps: 6, frame_start: 1, frame_end: 720, launch_frames: 96, after: 'hold',
});

// Ada walks up to Ben and waves; a pose holds until the next key, so she lowers her arm after
await op('desk.actor_move', { actor: 'Ada', points: [[-1.5, 0, 0], [-0.7, 0, 0]], frame_start: 60 });
await op('desk.actor_pose', { actor: 'Ada', pose: 'wave', frame: 150, hold_frames: 24 });
await op('desk.actor_pose', { actor: 'Ada', pose: 'stand', frame: 186 });
// Ben looks up at the kite while the kite shot (S4, frames 361-480) plays, then back at Ada
await op('desk.actor_look_at', { actor: 'Ben', target: 'Kite', frame: 370 });
await op('desk.actor_look_at', { actor: 'Ben', target: null, frame: 470 });

// six shots of 5 s each, in cut order, two of them with a planned layout
const shots = [
  { name: 'S1 Wide', framing: 'extreme_wide', subjects: ['Ada', 'Ben', 'Kite'] },
  { name: 'S2 Ada', framing: 'medium_close', subjects: ['Ada'],
    layout: [{ subject: 'Ada', side: 'left', facing: 'right' }] },
  { name: 'S3 Ben', framing: 'medium_close', subjects: ['Ben'],
    layout: [{ subject: 'Ben', side: 'right', facing: 'left' }] },
  { name: 'S4 Kite', framing: 'wide', height: 'low', subjects: ['Kite'] },
  { name: 'S5 Over Ada', framing: 'over_shoulder', subjects: ['Ada', 'Ben'] },
  { name: 'S6 Orbit', framing: 'medium', subjects: ['Ada', 'Ben'], move: 'orbit_left' },
];
for (const shot of shots) await op('desk.shot_add', { ...shot, duration_s: 5 });

await op('desk.shot_solve', {});
const { result: check } = await op('desk.check', {});
console.log(check.issues, check.lines);

// a draft export with the depth and pose passes
const job = await mcp.call('export_video', {
  project, quality: 'draft', width: 640, height: 360, passes: ['beauty', 'depth', 'pose'],
});
let status;
do status = await mcp.call('export_status', { export: job.export, wait_s: 50 });
while (!['done', 'failed', 'cancelled'].includes(status.status));
console.log(status.status, status.files.map((f) => f.url));
await mcp.close();
```

What it gives, measured in three runs on a 4-core machine shared with other work (load 0.4–4):

- Building the scene and the six shots takes 1.2–1.3 s. `desk.check` finds no issue, and its lines
  read like "Blocking: Ada is left of frame, facing right. Light: the sun is ahead of the camera,
  behind the scene." (S2) and "Blocking: Ben is in the centre, facing the camera, Ada's shoulder in
  the left foreground. …" (S5).
- The kite rises to the end of its string in 4 s; after the launch its bridle stays at a mean
  elevation of 54° above Ben's hand (`mean_elevation_deg` in the result of `desk.tether_fly`).
- The export renders 720 frames at 640 × 360 in 65–80 s (9–11 frames/s on 4 render processes) and
  writes `sequence.mp4`, six frame-exact clips per pass (`shot-01-s1-wide.mp4`,
  `shot-01-s1-wide.depth.mp4`, `shot-01-s1-wide.pose.mp4` …), a poster per shot, a contact sheet and
  `manifest.json`.

## Coordinates

- The editor: metres, **Z up**, right-handed, the ground at z = 0, **the front faces −Y** (a
  camera "in front" of the set looks toward +Y). Rotations are Euler XYZ in radians; the desk's
  angles are degrees about +Z: `facing_deg` 0 faces the front (−Y), 90 faces +X, −90 faces −X.
- rideo: metres, y up, x right, z toward the audience. **rideo (x, y, z) → editor (x, −z, y)**, and
  rideo's `facingDeg` is the editor's `facing_deg` (0 toward the audience, 90 to the right).
- Heights: rideo's `heightM` is the top of its figure, the desk's `height_m` a person's height but
  an animal's withers: the rideo import and export convert an animal's (a pony drawn 1.3 m tall in
  rideo has its withers about 0.98 m up), a person's is the same number.
- The sun: rideo's azimuth and elevation are the same numbers in `desk.set_build`
  (`sun_azimuth_deg`: 0 in front of the set, 90 to its right, 180 behind it). The SKY world gets
  `sun_rotation = rad(azimuth) + π` and `sun_elevation = rad(elevation)`.
- Wind: `wind_dir_deg` is where the wind blows toward, with the same angles (0 toward −Y).
- Cameras look down their −Z axis with +Y up, no roll unless a move keeps one.

## Limits and known gaps

- **Kinds**: `duck` and `bird` are not built; `desk.actor_add` refuses them with the list of the
  built kinds. There is no stirrup pose, so children on big mounts sit with their legs splayed
  over the barrel, and short-necked animals (dogs, cats, sheep, pigs, bears) cannot graze from the
  ground.
- **Hiding is by scale**: `hide_render` cannot be keyed, so a kite after `after: 'hide'`, and the
  actors and props a rideo import hides in shots they are not in, are scaled to 1e-8 of the scale
  they are shown at for those frames. They are sub-pixel in every render, but still objects of the
  scene (the video export draws nothing of them in any pass, and its subject tracks say `hidden`).
  `desk.check` and the solver tell a hidden object by its size (under a micrometre across), so a
  store model in very large units shown a few centimetres across is not hidden; the export reads
  the world scale alone, and takes such a model shown at under 1e-7 of its units for hidden.
- **Holding**: there is no reach before a grab: the prop glides into the hand over 6 frames. A
  released prop without a rigid body stays where it was let go.
- **Gaits** key about 17 keys per channel per cycle on the legs (fewer keys let planted feet slide),
  so long walks make long F-curves.
- **Tethers**: the string is straight, without sag; kite and tail collide with the ground at z = 0
  only, not with terrain or props. A flight flown before a later one already keyed leaves that one
  as it was flown: it starts where the kite was then, so fly the later flights again.
- **Physics**: balls are recognized by name or store tag (other round objects need
  `shape: 'SPHERE'`); there is no rolling resistance (the presets give balls an angular damping of
  0.9, a ball with Blender's default 0.1 rolls on); water is not a collider. A body carried by a
  rotating, non-uniformly scaled parent is sheared before its release and cannot be baked exactly.
- **Vehicles** follow the path's height only: no terrain, suspension or slip, and the wheels slide
  sideways a little on tight curves.
- **Cameras**: the solids cameras are pushed out of are the stored meshes (modifiers ignored); moves
  do not avoid solids along their path. An actor outside the shot that hides a subject is seen past
  or reported (`occluded`), but a prop, a rock or a building may block the view without a warning. A
  wide frame that holds a long walk can leave the subjects small, and the plan is judged at the
  shot's first frame. Depth of field is a camera setting, so a `rack_focus` shot's focus reaches
  other shots on the same camera.
- **rideo import**: the kind of each character and who rides whom are read from English text only,
  without following pronouns across sentences; hand-made keys on imported actors and props are
  replaced on re-import (user objects, shots, physics and materials are kept), and the re-import's
  warnings name the actors, props, landmarks and shot cameras changed in the desk since the last
  import, so stage them after the last import, or write the blocking to rideo first. Importing a
  long clip takes seconds (about 5 s for 20 shots with 6 actors when it was measured).
- **rideo bridge**: tested against a mock of rideo's routes, not a running rideo; previs jobs (100
  kept, 4 at once) are kept in `DATA_DIR` across restarts, but one running when the server stops
  ends failed and must be started again. See [rideo.md](rideo.md#limits).
- **Real video models**: whether the references improve rideo's takes is not measured yet
  ([rideo.md](rideo.md#what-rideo-should-measure-first)).
