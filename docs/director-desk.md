# The director's desk

The director's desk turns the editor into a previs tool for AI video: you build a scene once (a
set, actors that walk, run, sit and ride, props from the [model store](model-store.md), physics),
cut it into shots (a camera and a range of scene frames each), let the solver place the cameras
from a shot description, check continuity across the cuts, and render every shot as a
frame-exact reference clip with the [video export](video-export.md). Its first consumer is the AI
video studio rideo, which embeds the desk in its storyboard: [embedding.md](embedding.md) is the
contract between a host and the desk (the host's scene brief in, the staged shots' reference clips
and results out), and [Staging from a brief](#staging-from-a-brief) says what the desk makes of a
brief.

AI video models are good at texture and light and bad at what a 3D scene gets right for free:
props and the sun stay on their side from cut to cut, the camera keeps to one side of the 180°
line, a kite on a string pulls against the wind instead of floating like a balloon, a rider sits
on the horse. The desk stages that once, in metres, and hands the model a reference video (and a
blocking line that says the same thing) for each shot.

Contents:

- [Concepts](#concepts): set, actors, props, shots, cut order and coverage, camera solver,
  camera moves, continuity checks, physics presets, kites and balloons, vehicles
- [Staging from a brief](#staging-from-a-brief): what a host's brief becomes, later briefs, the
  results per shot, and the [SceneBlocking v1](#sceneblocking-v1) format underneath
- [The agreement principle](#the-agreement-principle)
- [In the editor](#in-the-editor): the Director workspace, the Asset Browser, Export Video, and
  the embedded desk's [Library tab](#the-library-tab) and [Save to library](#save-to-library)
- [Over MCP](#over-mcp): the operators and their parameters, and a
  [worked example](#worked-example-a-kite-on-a-hill)
- [Coordinates](#coordinates)
- [Limits and known gaps](#limits-and-known-gaps)

## Concepts

Everything the desk does is an operator in the editor's registry (`desk.*` and `store.*`, 30
operators): menus and panels in the browser, `run_operator` and `batch` for MCP agents, one undo
step per call. The shots and the desk settings are part of the scene document, so they sync live
to every editor and agent that has the project open.

### The set

`desk.set_build` builds the set: a ground plane of `width` × `depth` metres (default 12 × 10,
centred on the origin) whose colour comes from what the ground is (`ground`: grass, sand, road,
wooden floor …, each with its colour), a SKY world whose sun stands at `sun_azimuth_deg` and
`sun_elevation_deg` (default 135° and 40°; a brief's time of day sets them), and with
`interior: true` four 3.2 m walls facing into the room (their backs are culled, so a camera outside
the room sees in). The sky sun is the one key light; with `sky: false` the world is the STUDIO
environment and one SUN lamp shines from the same direction. Building the set again replaces what it
built before, and the materials and lights only it used.

Landmarks (a barn, a lake, trees) are store models or plain objects; the solver pushes cameras out
of solid ones and lets them stand over water (`desk_shape: 'water'`, a store model's water part,
or a label whose head noun is lake, sea, river …).

### Actors

`desk.actor_add {kind, name?, color?, height_m?, location?, facing_deg?, pose?, in_water?}` adds a
rigged mannequin: an ARMATURE with fixed bone names and one low-poly mesh part per bone in the
actor's colour, with darker joints and a nose so the facing reads in every frame. `in_water: true`
makes it a swimmer or a wader: it belongs in the water at every frame (see the checks).

| Kind                             | Default height                      | Notes                                                                                                                                                                       |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adult`, `man`, `woman`          | 1.7, 1.76, 1.64 m (top of the head) | humanoid bones `root`, `hips`, `spine`, `chest`, `neck`, `head`, `shoulder.L/R`, `upper_arm.L/R`, `forearm.L/R`, `hand.L/R`, `thigh.L/R`, `shin.L/R`, `foot.L/R`, `toe.L/R` |
| `child`, `toddler`, `elder`      | 1.2, 0.9, 1.65 m                    | a child has a larger head; an elder stoops slightly                                                                                                                         |
| `horse`, `pony`, `donkey`, `cow` | 1.6, 1.2, 1.1, 1.4 m (withers)      | quadruped bones plus a `saddle` bone: the four mounts                                                                                                                       |
| `dog`, `small_dog`, `cat`        | 0.55, 0.3, 0.25 m                   | quadruped bones `root`, `hips`, `spine`, `chest`, `neck`, `head`, `tail.1`–`tail.3`, `upper_leg` / `lower_leg` / `foot` × `.FL/.FR/.BL/.BR`                                 |
| `sheep`, `pig`, `deer`, `bear`   | 0.75, 0.65, 1.0, 1.05 m             |                                                                                                                                                                             |
| `duck`, `bird`                   | –                                   | not built yet: refused with the list of the built kinds                                                                                                                     |

Colours default to the cast palette in order (#ff8a3d, #3d8bff, #3dbe6b, #a35bff, #f2c230,
#ff5fa2, #2ec4c4, #e5484d). An actor is about 3,300–4,100 triangles.

- **Poses** (`desk.actor_pose {actor, pose, frame?, blend_frames=6, hold_frames?, layer='auto'}`):
  the ten of SceneBlocking v1 (`stand`, `walk`, `run`, `sit`, `crouch`, `kneel`, `lie`, `reach`,
  `point`, `wave`) plus `idle`, `talk`, `arms_crossed`, `hands_on_hips`, `carry`, `throw`, `kick`,
  `jump`, `look_up`, `ride` and `sit_ground`; animals `stand`, `walk`, `trot`, `gallop`, `sit`,
  `lie`, `eat` and `look_up`. The gestures (reach, point, wave, talk, arms_crossed, hands_on_hips,
  carry, look_up) move only the upper body when the actor sits, kneels, crouches, lies, rides or
  walks at that frame (`layer: 'auto'`; `'full'` always keys the whole body, `'upper'` never the
  legs). A pose stays until the next one: `hold_frames` only adds a key where the hold ends, so key
  `stand` or `idle` after a gesture to end it.
- **Walking**
  (`desk.actor_move {actor, points, frame_start, speed_mps? | frame_end?, gait='auto', face_path=true, end_pose?, in_water?}`):
  the armature object's location and heading are keyed along the path, and a gait is keyed for every
  cycle with the stride matching the speed, so the feet do not slide (planted feet drift 1–2 cm).
  Walk 1.3 m/s and run 3.5 m/s by default; animals walk, trot and gallop. Turns sharper than 135°
  split the path, with a stepped turn on the spot. The result gives the arrival frame and the length
  walked (corners rounded). `in_water: true` marks the frames of the move as a swim or a wade (the
  actor belongs in the water from `frame_start` to its end), `false` marks them as on land again.
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
where it stands: the camera solver, the checks, the subject tracks of the export and the
SceneBlocking export all read it.

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
| `framing`, `angle`, `height`, `lens_mm` | the shot description the solver works from (below)                                                                             |
| `move`                                  | the camera move over the shot (one of the 20 moves below)                                                                      |
| `subjects`, `layout`                    | the actors and props it shows (the first leads), and the planned screen layout: who is left, centre or right, facing which way |
| `continuity`                            | `cut`, or `continuous` when the action carries on from the shot before                                                         |
| `pre_roll`                              | frames before `frame_start` that are animated and simulated but never exported                                                 |
| `notes`, `external`                     | free text (2000 characters), and the host's scene and shot it came from (a brief's or a SceneBlocking clip's)                  |

The **cut order** is the order of the list (`desk.shot_move` reorders it). Shots may overlap in
scene time: two cameras on the same action are **coverage**, and the cut decides which one the
film shows. `desk.shot_add` without a range puts the new shot after the last one (`duration_s`,
default 5 s at the scene's fps) and extends the scene's frame range. Two shots on the same camera
may not overlap (the second is refused, naming both); give each angle its own camera.

The desk settings (staging a brief or a SceneBlocking writes them) hold the set size, the main pair
of the 180° line (default: the two actors who share the most shots), the aspect the shots were
solved for (default: the render resolution's) and the video model's shortest and longest take: shots
outside them get a `duration_clamped` warning, and an export with `match_model_duration` pads or
trims the clips.

### The camera solver

`desk.shot_solve {shots?, enforce_line=true, fit_plan=true, keep_lens=false, only_missing=false}`
(and `desk.shot_add` / `desk.shot_update` when the description changes) places each camera the
way the solver of rideo's former desk did, the one SceneBlocking v1 documents were blocked with:
positions match its within 1.5 mm in the tests, and a camera only stands back from that position
when it would lose a subject during the shot.

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

| Severity | Codes                                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| error    | `line_crossed`, `subject_out_of_frame` (at the shot's first, middle and last frame; a pan's or tilt's first and last), `camera_inside` (water exempt), `missing_camera`, `tether_detached` (a kite's string left over 5 cm from its anchor), `walks_on_water` (an actor standing on water in the picture) |
| warning  | `plan_mismatch`, `screen_direction`, `jump_cut`, `absent_in_frame`, `subject_hidden`, `subject_revealed` (brought in by a pan or tilt), `occluded_subject`, `body_in_water` (a physics body in water it does not float on), `actors_overlap` (< 0.35 m), `outside_set`, `empty_shot`, `duration_clamped`  |
| info     | `physics_unbaked`, `shot_gap`                                                                                                                                                                                                                                                                             |

Objects put away by a hide key (scaled to nothing: `after: 'hide'` of `desk.tether_fly`, the actors
and props a staging hides in the shots they are not in) are nowhere at the frames they are hidden: a
subject hidden at a frame the check samples is `subject_hidden`, not `subject_out_of_frame`, a
hidden bystander is never `absent_in_frame` and hides nobody, and the solver frames the subjects
shown at each frame. `occluded_subject` is a subject hidden behind an actor the shot does not frame
(see above). A pan or a tilt turns away from its subjects by design, so only its first frame must
frame them; one it brings into the frame by its last frame instead is `subject_revealed`, and one in
the frame at neither is `subject_out_of_frame`. A rider and the mount she sits on move as one: they
are never the pair of the 180° line where she rides, and cross the frame once, as the mount
(`screen_direction`).

Water is the water part of a store model (the lake's, the sea's, a fountain's, a trough's, a
well's), a mesh whose `desk_shape` is `water` (the water landmarks of a staging), and a landmark,
prop or set piece whose label names water ("the pond"), a SceneBlocking's boxes and cylinders too
(its blue "river" box); a mesh renders do not draw (its own `hide_render`) is none. Its footprint is
its own polygons that face up (a box of water's top), never a box around them, so the lake's sandy
shore is dry ground. `walks_on_water` looks at every actor in the picture every 6 frames (and finds
the first and last frame of each stretch to the frame), and at every frame between two of them near
water, so a dash across a ditch is seen: the actor's mark (its origin, where its feet are) over
water whose surface is within 15 cm of it. A rider is left to her mount and a rower to the boat that
carries her (an actor parented to anything but a plain empty, or held to it by a constraint); an
actor renders do not draw, one put away by a hide key, one whose lowest point clears the water by 10
cm (a jump) and one on a bridge or a pier deck over the water are not on it. A swimmer or a wader
belongs in the water: `desk.actor_add {in_water: true}` marks every frame of an actor,
`desk.actor_move {in_water: true}` the frames of a move (`false` takes them out again), and a
SceneBlocking import marks the shots in which an actor stands in its water; the check leaves an
actor alone at the frames its `desk_in_water` names (`true`, or spans such as `'..12, 30..40'`).
`body_in_water` looks at the bodies physics moves (baked keys on every frame, a rigid body the bake
will simulate every 6 frames): the middle of the body over water, its bottom at or under the
surface, until the frame `desk.physics_bake` let it float from (its `desk_floats`).

`lines` gives each shot's blocking line, a sentence a host can put into its prompts (in the
sentence format of SceneBlocking v1), e.g. "Blocking: Ada is left of frame, facing right. Light: the
sun is ahead of the camera, behind the scene." The export's manifest and the shot results carry the
same line, from the same staging as the clips.

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
- `desk.physics_bake {frame_start?, frame_end?, objects?, water='float'}`: keys the simulation and
  removes the rigid bodies and the hold constraints of held props, so renders and exports need no
  simulation (at most 2,000,000 body frames per bake). A store model's body moves the model's root,
  so the model stays one object. Bodies that reach water float there (below); `water: 'ignore'` keys
  the simulation as it is.

A body with a start frame follows its keys, its parent or the hand that holds it until then
(kinematic), and is simulated from there with the velocity it had (plus any launch velocity): a
ball thrown from a hand leaves at the hand's speed.

Water is no collider of the simulation: a ball rolls over a lake as over the ground. The bake
follows each body instead, and from the frame its middle comes over water with its bottom at the
surface (or reaching it by the next frame) it keys the body floating: the impact leaves it at most 2
m/s, which dies away with a time constant of 0.7 s, so it drifts at most 1.4 m on from where it
touches the water and stops at the water's edge; its centre settles a quarter of its radius under
the surface, but never deeper than half the height its top stands above it, so the top of a frisbee
or a book stays out of the water, and bobs up to 1.5 cm (less for a flat body) at half a hertz; its
spin dies down, and a flat body (its thinnest side at most half its largest) turns to lie flat on
the water. A body denser than water (the rigid body's mass over the volume of its collision shape)
sinks to two radii under the surface in about a second instead. The frame it reached the water is
kept in its custom property `desk_floats`, the result lists it in `floats` (the frame, the water,
whether it sinks), and a bake to the simulation's end keys a floating body until 3 s after that
frame. The same keys come out of the same scene every time.

`desk.physics_throw`, `desk.physics_drop` and `desk.physics_push` warn when the body reaches water
in the simulation (it lands in it, or rolls or bounces into it after coming down on dry ground),
`desk.actor_move` where a path crosses water (the metres along the path and about when; not for a
move made in the water), and `desk.actor_add` and `store.add` (people and animals) where an actor is
put down on water; their advice names a bridge's deck for a path and `in_water` for a swimmer or a
wader.

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

## Staging from a brief

A host that embeds the desk ([embedding.md](embedding.md)) describes a scene in words, not in
metres: a `SceneBrief` with the frame rate and size, the set (its description, whether it is an
interior, the time of day), the cast, the elements (the location and the props) and the shots, each
with its duration, description, action, cast, framing, movement words, planned layout and
continuity, and no positions. `stageBrief(doc, brief)` (in `@3d-editor/core`; the operator
`desk.stage_brief`, and `desk_stage_brief` over MCP) stages it in a project without shots, as one
undo step, and runs in a web worker as well as on the server:

- **Frames**: the scene takes the brief's fps and size. Each brief shot becomes a shot of
  `max(1, round(durationSec × fps))` frames, in brief order from the scene's first frame, back to
  back except before a cut where a rider gets on or off a mount between two shots: that cut gets a
  pre-roll gap before it (`pre_roll_frames` of `desk.stage_brief`, default 12, at most 1000), where
  the change is animated. Each is named `Shot N` (its index + 1), with the brief's description and
  action as its notes, and with the host's ids
  (`external: {source: 'host', clip: <scene id>, shot: <shot id>, index}`), so the results name the
  host's shots.
- **The cast**: an actor for every cast member a shot casts (its `castIds`, and those its planned
  layout names besides); a member in no shot is left out, with a warning. Its kind is the hint when
  the hint names a kind the desk builds ("child", "dog", "golden retriever"), a person read from the
  words when the hint says "person", else read from the name and description (age and gender words;
  an animal that rides, or holds a prop it does not carry in its mouth, is a person). A description
  that opens with rideo's identity line, `Name: <age> <gender>, <build>; <marks>; wearing …`, gives
  the person's age and gender (`Bo: 6 male` a child, `Tom: 72 male` an elder,
  `Ana: early 30s female` a woman; 3 and under a toddler, 12 and under a child, 65 and over an
  elder). The line runs to its first sentence end (see [Briefs](#limits-and-known-gaps) for where
  a sentence ends): a period inside a number (`1.85 m`), after a title (`Dr.`, `Mrs.`, `St.`) or
  an initial (`Dr. Okafor`, `St. Ives`, `J. Smith`) unless a capitalised sentence opener follows,
  or after an abbreviation no capital follows (`approx. 160 cm`, `e.g. a scar`) does
  not end it. An age may be written out: `early twenties`, `30-ish`, `thirty-something`,
  `18 months` (a toddler); early, mid and late put an age 2, 5 and 8 years into its decade, so
  `late sixties` or `late 60s` is an elder (teens, and words such as "elderly", are not read as an
  age but as age words). A line whose first item ends with a gender word (male, female, man,
  woman, boy, girl, non-binary) is a person's whatever its age says, unless the line names an
  animal as what the member is before its first `;`, as its age, ethnicity or build
  (`Pip: 3 male, golden retriever, small`, `Kit: kitten female`, `Rex: young male, beagle`): then
  it is that animal. An animal word there is a feature of a person instead before a body part or a
  look ("bull neck", "doe eyes", "horse face", "pony tail"), or after "as a" or "like a" ("strong as
  an ox", "as strong as a big old bull", "thick-necked as a bull", "built like a bear"), but not
  "as" after a word that gives a role: a past participle, any ending in "-ed" and the common
  irregular ones, after a hyphen too ("retired as a race horse", "driven as a carriage horse",
  "hand-reared as a foal", "bottle-fed as a lamb"), unless it says what the member has or is like
  ("thick-necked", "quick-witted"), a form of work, use, breed, train, serve, act, double, live,
  run, compete, perform or volunteer ("worked as a plough horse", "doubles as a gun dog"), or
  "home", "life", "up", "out", "away", "over", "years" or "family" ("brought home as a puppy",
  "began life as a race horse", "given away as a puppy"). Another word between the role word and
  "as" makes a likeness ("used mainly as a pack horse"), and an animal named only in a likeness is
  not one ("Babe: 4 male, blue, strong as an ox" is a person unless the sentence after the line
  names the ox). "Bear", "bull", "ox" or "gorilla" before a build word is a person's build when the
  line's outfit names a garment only a person wears (a shirt, a suit, jeans, a jersey, a cassock,
  shoes and others, next to an animal's gear too: "White, bear build; wearing a flannel shirt",
  "Irish, bear build; wearing a black cassock and a white clerical collar"); otherwise it names the
  animal whatever the ethnicity and marks say ("brown, hulking bear build", "Hereford, massive bull
  build", "White, bear build; beard", "Black, old bear build; wearing a faded circus collar"), as
  "sturdy pony build" names a pony;
  before another animal word the later is the animal ("cattle dog" is a dog), unless it is the
  young, the sex or a breed word ("Shetland pony mare", "bear cub"), or the first is a breed of dog:
  the first breed of a cross names it ("golden retriever-poodle mix" is a retriever, not a small
  dog). In the first item only the age can name the animal (`puppy male`). Animal words among its
  marks ("bull neck", "doe eyes", "a parrot on his shoulder") or in the name ("Wolf") do not make a
  person an animal, unless the sentence after the line names the animal ("A curious white duck.").
  An animal word that says what a member has or resembles is not what it is: a possessive ("crow's
  feet"), one before "-like" ("a crow-like old woman") or before a hyphened "-ed" word
  ("bull-necked", "doe-eyed"), "a bear of a man", as before "tattoo", "costume" or "ears".
  An animal the desk has no figure for stands in as the built kind nearest its size, with a warning:
  birds and small animals as a `cat`, foxes and wolves as a `dog`, goats as a `sheep`, big cats as a
  `bear`, big grazers as a `cow`, camels and zebras as a `horse`. `heightM` sets its height (an
  animal's is the top of its figure, as in [SceneBlocking v1](#sceneblocking-v1): its withers come
  out lower). Each stands where the first shot that plans it puts it (left −1.2 m, centre 0, right
  +1.2 m, a second one on a side 1.2 m behind the first, facing as planned for a front camera), the
  others in a row at the front, and is hidden in the shots that do not cast it.
- **Props**: an element of kind `prop` is the built-in model its name names (else a 0.4 m cube in
  the colour a colour word of its name or first sentence gives), one of kind `other` only when its
  name names a built-in model (a style is not staged, with a warning), and `location` elements are
  words for the set. A prop a shot's words give to a cast member ("Mira runs with the kite") is in
  that member's right hand in the shots they are in, and put away in the others; a held kite or
  balloon flies on its string over those shots instead. Any other prop stands 0.7 m beside the first
  cast member of the first shot that lists it, on a side clear of the others.
- **The set**: an interior when the brief says so, else when the words of the set and the locations
  name a room before any outdoor place ("inside", "flat", "bar", "cafe", "factory" or "museum" with
  an outdoor place right after it says where that place is, as in "deep inside the forest" or "the
  cafe terrace", but a room's name always names a room, and an outdoor word that names a building is
  not the place: "the kitchen of the lake house", "inside the park's cafe"; boats, ships, yachts,
  sheds, tents, caravans and other shelters are buildings: "inside the river boat", "inside the
  garden shed"), or when "inside" or "indoors" opens a clause after outdoor words, on its own or of
  a room or a building ("a cabin in the woods, inside by the fire", not "the garden, inside the
  gate"); a deck (a boat's or a house's) is outdoors, unless "below deck", but a deck of cards
  (between "of" and "cards" at most one word of any kind, then up to three that describe cards: "a
  deck of his cards", "a deck of worn old playing cards", "a deck of Bicycle playing cards"; "on the
  deck of the ship cards are dealt" and "on the deck of the galleon sailors play cards" are the
  ship's), a tape, cassette, DJ or skateboard deck and a deck chair are not; its ground from the
  first ground word they name (grass, sand, snow, ice, wood, carpet, dirt, stone), else a wooden
  floor inside and plain ground outside; the sun from the time of day (below). Open water that the
  set or a location names (a puddle, pond, pool, fountain, stream, brook, creek, canal, river, lake,
  lagoon, loch, reservoir, bay, harbour, sea or ocean; not after "no" or "without") is a water
  landmark of its size (a pond 5 × 4 m, a lake 20 × 10 m, a river a strip 30 m long and 6 m wide,
  the sea one 80 × 30 m) on the side its clause gives it (on the left, on the right, in front,
  behind), behind the cast when it gives none, and 1.5 m clear of the cast and the standing props,
  so nobody starts out on it. The set is at least 12 × 10 m and grows to hold everything with a 2 m
  margin (at most 200 m).
- **Cameras**: the brief's framing, else the one its description's first sentence (else its
  action's) names ("close-up", "wide shot", "over the shoulder" …), else `medium`; the brief's
  `move`, else the one its movement words amount to (`dolly_in` a `push_in`, `tracking` a
  `tracking_follow`, a `pan` or an `orbit` the way its words turn, `steadicam` a `steadicam_walk` …;
  words the desk does not know are a locked-off camera, with a warning); its `lensMm`, else the
  framing's. Every camera is solved from them and fitted to the shot's planned layout without
  enforcing the line, as [the agreement principle](#the-agreement-principle) has it: the plan wins.
- **Checks**: `desk.check` runs on the staged shots. The report gives, per brief shot, the desk
  shot, its frames and camera, the cast staged (with the kind and why), the props (with who holds
  them), the issues with the host's shot ids, and the warnings: what the desk read differently from
  the brief, or could not stage as it says. Fix the check's errors (`line_crossed`,
  `subject_out_of_frame`, `camera_inside`, `missing_camera`, `tether_detached`, `walks_on_water`)
  and `plan_mismatch` before a host's references are exported: the staging is the desk's guess at
  what the words mean, and `desk_shot_results` lists what is left per shot.

| `timeOfDay`   | Sun azimuth | Sun elevation |
| ------------- | ----------- | ------------- |
| `dawn`        | 95°         | 4°            |
| `morning`     | 120°        | 25°           |
| `noon`        | 175°        | 68°           |
| `afternoon`   | 225°        | 40°           |
| `golden_hour` | 255°        | 10°           |
| `dusk`        | 268°        | 3°            |
| `night`       | 200°        | 35° (a moon)  |
| none          | 135°        | 40°           |

The azimuth is the one `desk.set_build` takes (0 in front of the set, 90 to its right, 180 behind
it): the day runs from the right of the set over its back to its left, so a front camera sees the
morning light come from its right and the evening light from its left.

`briefRecord(doc)` says what a project was staged from (the host's scene id and the brief's hash).
The record lives in the document (the scene settings' `brief`), so it travels with the desk state a
host stores. `briefChanges(doc, brief)` lists how a later brief differs from the one staged, as far
as an update acts on it: as the contract's `BriefChanges` (shots added; staged shots removed; shots
retimed, whose frame count changed, by a new duration or a new frame rate, to a length the desk shot
does not have already; shots recast; cast members added that a shot casts, and removed ones whose
actor is staged), and in `other` (the desk's own, left out when empty) what else an update acts on:
the frame rate and size, the set, the props, shots with a new camera plan, shots of the desk with
new words or numbers, cast members with an actor renamed (not one the desk gave the new name
already) or of another kind or height. A shot removed in the desk counts only when the brief changes
its length, cast or camera plan (an update stages it again). It is null exactly when an update would
change nothing of the staging and refuse no library pin the record does not refuse already; such an
update gives only the warnings every update of the brief repeats (how the desk reads the brief, a
shot whose length was changed in the desk, a cast member kept as the kind staged), so a desk that
offers the update on a non-null value offers it whenever it does something. A lens and move the host
gives back as the desk staged them (copied from the shot results) are no change.
`briefChanges(doc, brief, {units})` counts the library pins whose unit the desk holds ([library
units](#library-units); headers are enough): what an update does with them is named in `other` only,
in the desk's words ("the set from the library", "a new version of the library set", "another
library set", "the set from the words (no library set)", "1 cast member from the library", "2 cast
members with a new library figure", "1 cast member back to a mannequin", "1 prop from the library",
"1 prop with a new library version", "1 prop back to the words"); the contract's lists never carry a
pin. A pin whose unit the desk does not hold is no change. One whose unit it holds but cannot use is
a change until an update has recorded it refused ("a library set that cannot be used", "1 cast
member with a library figure that cannot be used", "1 prop with a library version that cannot be
used"): the update keeps what the slot has and warns why, and the pin is not tried again.

`shotResults(doc, {shots?})` (`desk.shot_results`, and `desk_shot_results` over MCP) is what the
desk tells a host about each staged shot besides its files, in brief order: its frames and duration,
the staged camera's lens (an integer 8–800 mm) and move, the blocking line through its camera at its
first frame, who walks where (`moves`, null when nobody moves), whether the camera shows the planned
layout (`planAgrees`, null without a plan) and its checks (errors and warnings). An export adds the
reference clips and stills.

### Library units

A brief may pin library units ([embedding.md](embedding.md#library-units)): the set (`set.unit`, a
set unit), a cast member (a figure) and an element of kind `prop` or `other` (a prop); a pin on a
location is ignored, with a warning (the place's set is `set.unit`).
`stageBrief(doc, brief, {units})` and `updateFromBrief(doc, brief, {units})` take the units the desk
holds for the pins: `unitSourceOf(files, problems)` reads the header of each file the host sent
(their SHA-256 checked by the caller) at once and decodes a body only to place it. Without `units`
every pin is staged from the words. Per slot:

- **The set** is put in before the cast as the scene's place: an instance with key `set` whose root
  (an empty at the origin) carries `desk_role` `set`, the scene, its ground's name and its planning
  facts. No ground, wall, landmark or water of the words is built; the set is lit (the sun or sky of
  the time of day) and the desk takes its stage (its width and depth, 2–200 m) and interior. A mark
  of the words within 0.3 m of one of its pieces (its landmarks but the ground and the lights) moves
  to the nearest free spot on rings 0.3 m apart (out to 3 m, starting toward the audience, inside
  the stage), and a standing prop's spot keeps clear of them too: when the set is first placed only
  (a later version or another set moves nobody).
- **A figure** is its cast member's actor (key `cast:<castId>`): its kind, height and colour are the
  figure's (a kind or height in the brief that differs is no change, with a warning), on the desk's
  rig for its kind, so it stands, walks, poses and holds as a mannequin of that kind would. While
  the figure is not placed, its member stands in as a mannequin of the brief's `kind` at the brief's
  `heightM` taken as the desk height, not converted (the host sends the figure's own height: an
  animal's withers), so that the figure fits the stand-in when its file comes.
- **A prop** is its element's prop (key `el:<elementId>`) at the spot the words give it, its base on
  the ground, at the unit's own size; it is held, hidden and flown as the words' prop would be.

A pin whose unit is not held, or cannot be used, is staged from the words, with a warning, and the
record says why: `pending` (not sent, not the pinned file, the budget spent, a failed read) is tried
again at the next open, `refused` (unreadable, too new, too large, of another kind, a figure the
desk does not build or whose bones are not its kind's, a set whose ground is off height 0, a unit
that can never fit a staging) only when the brief pins another version ([when a unit is not
used](embedding.md#when-a-unit-is-not-used)). The units one staging takes are counted in slot order
(the set, the cast, the elements): 48 MiB of files and 160 MiB unpacked (a version pinned in several
slots is one file and one decoded body, and the scene's copy of it in each slot that places it, with
byte arrays the file shares counted at every reference); a slot past that waits, `pending`
`unavailable`, for the next open. The report's `units` has a row per pin: its slot (`set`,
`cast:<castId>`, `el:<elementId>`), `ref`, `version`, the object (the set's root, the actor, the
prop) and `staged` `unit` (the slot holds that version) or `words` with `why` (a reason above, or
`local`). The record keeps each pin with what was staged for it; a brief without pins records
nothing more, so it stages, records and reports exactly as before.

`pinsWanted(doc, brief)` lists the pins whose slot an update would place, update or replace if the
unit were held (not those the scene holds, made local, or refused at that version): the files a desk
keeps for a later Update shots. `pinsRefused(doc, brief, units)` lists, with why, the pins whose
unit the desk holds but cannot use and that the record does not refuse yet (an Update shots records
them `refused`). `adoptPublished(doc, brief, {slot, link, pin, linked, header})` makes the scene's
published objects an instance of the version the host saved (no id changes; the caller chooses the
transaction's origin); only when `linked` does the slot's record take the pin (`staged` `unit`, and
for a set the record's set is the unit's), so that the next brief, which pins it, is no change.
`stateUnitRows(doc)` is the desk state's `units`. An exported blocking
(`desk.export_rideo_blocking`) writes no landmark of a library set's pieces (a warning says how
many), also once the set is made local (its pieces stay the set's while the record says the slot
holds the unit), and takes a linked set's ground name from its root, so importing it again keeps
the set and adds no copies.

### Updating from a later brief

`updateFromBrief(doc, brief)` (`desk.update_from_brief`; `desk_stage_brief` on a project staged from
the same scene) brings a staging up to a later brief of the same scene, as one undo step. It acts on
how the brief differs from the one staged before (the record), not on how the desk differs from the
brief, so what was done by hand stays: a shot the brief did not change keeps its camera and its
actors' marks, poses and keys, whatever was done to them in the desk, and its length when it was
made shorter or longer there (with a warning); one removed in the desk stays removed until the
brief changes its length, cast or camera plan. Time is edited as an editor's ripple edit does, in
frames no other shot covers, so the shots after an edit keep their staging, only earlier or later,
and no other shot's keys are cut:

- a shot the brief no longer has goes, with its camera (unless another shot uses it) and those of
  its frames no other shot covers;
- a shot whose frame count the brief changed (its duration, or the frame rate) grows at its end over
  free frames and the shots that overlap its end, or shrinks by its own frames only, its camera's
  move fitted to its new length;
- a new shot comes after the brief's shot before it (first when it leads: the scene's and the rigid
  body world's frame ranges then start with it), in time and in the cut (in the shot list right
  after that shot, or right before the brief's shot after it when it leads), its camera solved and
  fitted to its plan, the cast not in it hidden; the scene's frame range grows to hold a shot the
  update puts or lengthens past its end (a range shortened in the desk stays so for the shots it
  left out); a rider that a shot it stages, or whose words or cast change, puts on a mount is
  not seated by an update: it stands beside the mount, with a warning (`desk.actor_mount` seats it,
  and staging the brief in a new project mounts it as staging does);
- a recast shot shows its new cast and hides the rest, and is solved again, as is a shot whose
  camera plan changed (framing, movement, lens, move, layout, continuity) and every shot when the
  size changed;
- a camera set by hand in the desk is never solved again: the update keeps it and warns;
- cast members the brief drops go; new ones stand on a free spot of the front row, shown in their
  shots; one the brief renames is renamed, also one whose name was made unique (`Guard.001` beside
  another `Guard`: the record keeps the name the desk gave each actor), while one the desk renamed
  keeps the desk's name, with a warning; one whose kind or height the brief changes stays the actor
  staged, with a warning;
- props whose element went go and new ones are placed; a held prop whose holder or holder's shots
  changed is held (or flown) again; the set is built again when its plan changed;
- notes the desk did not edit follow the brief's words, and the desk's own shot names (`Shot 3`)
  follow the brief's order;
- library pins act per slot ([library units](#library-units)): a set unit placed takes the place of
  the words' set (its ground, walls and landmarks go), a new version of the same item updates the
  instance (its root and the parts not edited in the desk keep their ids), another item replaces it,
  and no pin brings the words' set back; the cameras still as staged are then solved again (one set
  by hand is kept, with a warning). A figure restyles its member's actor in place (the same
  armature, keys, holds and shots) when its kind and height (within 5 mm) are the actor's; another
  kind or height is refused and the actor kept (stage the brief in a new project to rebuild it), and
  no pin brings back the mannequin of the actor's kind and height. A prop unit replaces the
  element's prop or updates it to a new version (its root id stays), and no pin brings the words'
  prop back. A unit not held changes nothing (the words, or the version placed, stay), a slot made
  local stays local, and a refused pin is not tried again.

A ripple moves everything keyed after the edit: F-curve keys (where frames are cut or inserted, a
curve keeps the values it had on both sides of the edit, so an actor a later shot hides stays shown
in the shot before it), F-curve modifier ranges (one wholly inside cut frames goes, as does a shot),
the shots, the scene's and the rigid body world's frame ranges, rigid body start frames, tether
flights, the frames actors spend in water and those bodies float from; a driver that reads `frame`
is left as it is, with a warning. An update keeps the cut order (the shot list's) of the shots the
desk keeps, also an order the person gave them in the desk (`desk.shot_move`), and warns when the
brief now orders them otherwise than it did and the desk does not: stage the brief in a new project
to follow a new order. It refuses a project not staged from a brief, or staged from another scene.

### SceneBlocking v1

Underneath, `stageBrief` stages through the import of SceneBlocking v1, the JSON blocking document
of rideo's former 3D desk: the set, each cast member's mark per shot (metres, y up, z toward the
audience: see [Coordinates](#coordinates)), walk targets, cameras, props and landmarks. The desk
keeps it as an interchange format for agents that hold such documents: `desk.import_rideo_blocking`
stages one (marks and walks, riders on their mounts, props in hands, kites and balloons on strings,
blocked cameras kept as they are, the others solved), and `desk.export_rideo_blocking` writes the
scene back as one. Their ids follow the brief's pattern (letters, digits and `_ . : -`, up to 100
characters) and their lists the brief's limits (16 cast members, 64 props and landmarks). A brief
never needs them.

## The agreement principle

When a shot's description, its blocking line and its camera view disagree, the frames a video model
makes follow none of them (rideo's failure analysis of its own takes found so). So everything the
desk hands a host agrees with what the host tells its model:

1. Each shot's planned layout (who is left, centre or right, facing which way) is respected:
   cameras are fitted to it, and `plan_mismatch` (`planAgrees: false` in the results) says when no
   camera can be.
2. A shot's results come from the same staging as its clips: the blocking line and the moves a host
   prompts describe what the reference shows.
3. The camera move in the results (`camera.move`) is the one the clips show, so the move a host
   prompts is the move of the reference.
4. Nothing reaches a host's model unasked: a host gets `camera` references (the depth pass) unless
   it asks for `motion` or `pose` ones, the most conservative choice while their effect is not
   measured (see the [limits](#limits-and-known-gaps)).

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
shot) with Cancel, download links (and Download all as one ZIP), a preview and the recent server
exports. It exports on this device (render workers and WebCodecs, no server needed); where the
server has ffmpeg (`features.videoExport` in `/api/config`) and holds the project, Export On
offers it too. A browser that cannot export (no secure page, no WebCodecs H.264 encoder) is told
why. See [video-export.md](video-export.md).

**Embedded in a host** (`desk.html`): the same Director workspace, focused, in another web
application's frame. The host's brief is staged in the browser (in a worker), the person directs
it, **Update shots** brings the staging up to a later brief as one undo step, and **Send to …**
renders every shot's reference clips in the browser and hands them to the host, which also keeps
the scene's state; Done and Close end the session. Opened on its own, the page offers a sample
scene. See [embedding.md](embedding.md). A host that keeps a library of 3D pieces adds the
[Library tab](#the-library-tab).

### The Library tab

After an open whose host turned [library units](embedding.md#library-units) on (`options.units`),
the embedded desk has a **Library** bottom tab; on a phone it opens the bottom area as the Shots
tab does. A host from before library units, or an open without them, gets the desk as before: no
tab, nothing saved, no units in its states. Under **From the library** the tab lists one row per
library unit the scene holds or its brief pins, in slot order (the set, the cast, the elements,
then instances of no slot): the unit's name (else the slot's), its kind (set, figure or prop), the
version, and its status in words:

| The row says                                                       | When                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| up to date                                                         | The slot holds an instance of the version its pin names                                  |
| 3 parts edited here                                                | It does, with three of its parts (or drivers it gave them) edited or deleted in the desk |
| v3 is here: Update shots places it                                 | The brief pins a version the slot does not hold, and the host sent its file              |
| the brief pins v3: Update shots brings it in                       | The same over the version the slot holds: Update shots updates or replaces it            |
| waiting: its file was not sent; staged from the words              | The pin waits (`pending`, with its reason): tried again at the next open                 |
| the brief pins v3: waiting for its file; v2 stays                  | The same over the version the slot holds, which stays                                    |
| refused: it was made by a newer desk; staged from the words        | The pin cannot be used (`refused`, with its reason) until the brief pins another version |
| the brief pins v3: refused (it was made by a newer desk); v2 stays | The same over the version the slot holds, which stays                                    |
| made local: it stays as it is                                      | The slot was made local                                                                  |

A pinned version whose file the host sent but the staging cannot use (a newer desk's, one that does
not read, a figure that does not fit the actor) shows refused, with why, as soon as the scene opens,
not as one Update shots brings in; the Update shots the banner offers then records it so.

**Linked instances.** A unit that staging or Update shots places, or that the host links after a
save, is an _instance_ of the library's `ref@version`: its objects are the scene's own, which the
person moves, poses, re-colours or deletes as any others, and each remembers what the version made
it, so the row counts the parts edited or deleted here and an update knows what to keep. The
host's state says per slot which version the scene holds and how (`state.units`).

**Make local** (on a row with an instance; not in a read-only open) keeps the instance's objects as
plain objects of the scene, no longer linked to the library, as one undo step (Ctrl+Z links them
again). The slot stays local: no later brief, version or Update shots places a unit there again,
and the host's state says so (`staged` `unit` with `local` true, and the `ref@version` it was made
local from), so the host need not send that slot's file again.

**What an update keeps and replaces.** Nothing moves until the person runs **Update shots** (one
undo step). For a new version of the item a slot holds, the instance is updated in place:

- a part left as the version made it takes the new version's shape and look and keeps its id, so
  shots, holds, constraints and keys still find it; what the scene owns stays (names, the
  collection and physics of every part, the instance's placement, constraints, hiding and pose);
- a part edited in the desk keeps the edit (with a warning when the new version changed it too),
  and a part deleted in the desk stays deleted;
- a part only the new version has is added; one it drops goes when it was left as it was and
  nothing that stays uses it (keys, drivers, shots, the scene's camera, a camera's focus, another
  object or a part the update keeps), else it stays with what it uses;
- the drivers the unit gave follow the same rules: one left as it was takes the new version or goes
  with it, one edited in the desk is kept (with a warning when the new version changed it too), one
  deleted in the desk stays deleted; one the new version drops together with a part the scene keeps
  stays on that part, the scene's own from then on, and so does what it reads;
- a new version with the same content changes no part, only the version the instance names.

Another item pinned to the slot replaces the instance: its objects, edits and all, give way to the
new unit's, at the set's place or the prop's spot. So does a prop's new version whose root is
another type of object than the instance's (an empty in one version, a mesh in the next), which no
update turns into the other: a warning says so (naming the scene's object when the scene changed the
instance's root). What the person put on a prop that another item or such a version replaces
(objects of their own below it) stays, hung from the new root where it is in the world, and the
warnings name it; one that the new root's uneven scale would change there stays where it was, no
longer on the prop, and a warning says so. A figure, a new version or another item, restyles its
member's actor in place (the same armature, keys, holds and shots) when its kind and height are the
actor's, and is refused otherwise. A brief that drops the pin brings back the words' set, the
mannequin or the words' prop. A new look in place of an old one (a figure or a library prop where
the words built the mannequin or the prop, the mannequin again where a figure was) takes away only
the old look: what the person put on the actor or the prop in the desk stays where it is, and the
update's warnings name it. A slot made local takes none of it;
[Updating from a later brief](#updating-from-a-later-brief) says the rest.

#### Save to library

**Save to library…** in the tab opens a dialog over the desk. It is off, with the reason shown,
when the host takes no units saved from this open (`publish` false), while a save or Update shots
runs, and when nothing in the scene can be saved. The dialog has:

- **What**: the set, each actor by its cast member's name, each prop; first the selected actor or
  prop, else the set.
- **Name** (1–120 characters; the instance's, the place's, the cast member's or the prop's name to
  start with) and **Description** (at most 2000).
- **Save as a new version of Harbor v3**, ticked, when the target is an instance of a library unit
  (also right after a save the host linked: chosen again, its target is an instance of what was
  saved). A new version is saved under its item's name, which the host keeps: Name shows it and
  cannot be changed, and Description is the new version's note. Unticked, it is a new item under
  the name typed, and the scene keeps the version it holds. For a target that is no instance it is
  a new item, which the host links (and the scene adopts) when the slot pins nothing.
- The unit as it would be saved, made in the staging worker without changing the scene: its
  thumbnail, its objects, triangles, size and dimensions (a figure's kind and height), and its
  warnings; a unit that cannot be made says why, and Save stays off.

Save sends it to the host (`unit-publish`); the dialog shows the progress (making the unit,
waiting for the host with the seconds counted, linking the scene), then what came of it:

- "Saved 'Harbor' v3 to rideo; linked to the scene's place" (or to the actor or prop it came
  from): the host linked it, and the scene adopts it at once (not an undo step, and Ctrl+Z does not
  go back past it): the slot's pieces are an instance of that version, the tab shows it up to date,
  and the next state pins it;
- "Saved 'Harbor' v1 to rideo; not linked: …", with the host's reason: saved in the library, and
  the scene stays as it is. From a read-only open, which may save too, the host saves it but does
  not link it and says why: "Saved 'Harbor' v1 to rideo; not linked: the scene is read-only" from
  rideo. "not linked here" shows only when a host links it all the same: the scene stays as it is;
- "Not saved: …", with the host's reason whatever code it answers with (refused, a conflict with a
  newer version, too large, unavailable …), or the desk's (a name or a unit it cannot send);
- "Not known whether rideo saved 'Harbor': it did not answer in time. Look in its library before
  saving again." when the host did not answer in time (or the desk closed first, or the answer was
  not valid), and only then: the host may have saved it, and linked it, all the same. An answer that
  comes later is not applied; a link the host made comes with its next brief, and Update shots then
  makes the scene's own pieces (or actor, or prop) the instance of that version, with no copy of
  them beside them (where they are gone, it puts the unit in).

Closing the dialog while the host saves lets the save go on: the tab says how far it is and how it
ended. One save runs at a time, and Update shots is off while one links the scene; a link the host
answers while Update shots runs is made once the update has ended. The dialog is modal: it takes
the keyboard focus, Tab goes round its own controls, Space and Enter press its buttons, and no key
of the editor (Ctrl+Z, Space, the arrows) acts on the scene behind it; Escape closes it, but not the
Escape that ends an IME composition in the Name or Description. Closed, it gives the focus back to
Save to library….

## Over MCP

Agents reach every desk operator with `run_operator` / `batch`
(`list_operators {category: "Director"}` lists them with their JSON schemas; the groups Actors and
Model Store narrow it), and the server adds tools for what runs in the background, talks to other
servers or takes a host's brief: `export_video`, `export_status`, `cancel_export`, `list_exports`,
`store_search`, `store_add`, `desk_stage_brief` and `desk_shot_results`. `render_image` and
`render_animation` take `camera: 'shots'` to look through the shot cameras.

| Operator                     | Parameters (defaults)                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desk.set_build`             | `width` (12), `depth` (10), `ground` ('grass'), `interior` (false), `sun_azimuth_deg` (135), `sun_elevation_deg` (40), `sky` (true)                                                                                        |
| `desk.actor_add`             | `kind`, `name`, `color`, `height_m`, `location` (3D cursor), `facing_deg` (0), `pose` (stand), `in_water` (false)                                                                                                          |
| `desk.actor_pose`            | `actor`, `pose`, `frame` (current), `blend_frames` (6), `hold_frames`, `layer` ('auto')                                                                                                                                    |
| `desk.actor_move`            | `actor`, `points`, `frame_start`, `speed_mps` or `frame_end`, `gait` ('auto'), `face_path` (true), `end_pose`, `in_water` (as it was)                                                                                      |
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
| `desk.physics_bake`          | `frame_start`, `frame_end`, `objects` (every simulated body), `water` ('float')                                                                                                                                            |
| `desk.tether_fly`            | `flyer`, `anchor`, `anchor_bone`, `length_m`, `wind_dir_deg`, `wind_mps`, `frame_start`, `frame_end`, `launch_frames`, `tail` (true), `string` (true), `seed`, `after` ('hold')                                            |
| `desk.vehicle_drive`         | `vehicle`, `points`, `frame_start`, `speed_mps` or `frame_end`                                                                                                                                                             |
| `desk.import_rideo_blocking` | `blocking`, `shots`, `characters`, `elements`, `settings`, `model_limits`, `state`, `cast_overrides`, `project`, `clip`, `pre_roll_frames` (12), `update` (true)                                                           |
| `desk.export_rideo_blocking` | none: returns the scene as a SceneBlocking v1 document                                                                                                                                                                     |
| `desk.stage_brief`           | `brief` (a SceneBrief), `pre_roll_frames` (12)                                                                                                                                                                             |
| `desk.update_from_brief`     | `brief` (a later SceneBrief of the same scene)                                                                                                                                                                             |
| `desk.shot_results`          | `shots` (every staged shot, by the host's ids): read-only, returns `{shots}`                                                                                                                                               |
| `store.add`                  | `model`, `name`, `location`, `rotation_deg`, `height_m`, `width_m`, `depth_m`, `scale`, `color`, `params`                                                                                                                  |
| `store.search`               | `query`, `category`, `limit` (20), `offset` (0)                                                                                                                                                                            |
| `store.insert_files`         | `entry`, `format`, `files` (base64 by path), `main`, `location`, `rotation_deg`, `height_m`, `width_m`, `depth_m`, `name`                                                                                                  |

Objects are named by id or exact name. Operators that add things return ids and names; results
and warnings are in each call's `result` and `reports`. An agent staging a host's brief calls
`desk_stage_brief` and `desk_shot_results`, which run `desk.stage_brief`, `desk.update_from_brief`
and `desk.shot_results`, then exports with `export_video {preset: 'reference'}`.

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

// the set: a grass field, the sun behind the scene on the right (the default 135°/40°)
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
- SceneBlocking v1: metres, y up, x right, z toward the audience. **SceneBlocking (x, y, z) →
  editor (x, −z, y)**, and its `facingDeg` is the editor's `facing_deg` (0 toward the audience, 90
  to the right).
- Heights: a SceneBlocking's or a brief's `heightM` is the top of the figure, the desk's `height_m`
  a person's height but an animal's withers: staging, import and export convert an animal's (a pony
  drawn 1.3 m tall has its withers about 0.98 m up), a person's is the same number. A brief's member
  that pins a library figure is the exception: its `heightM` is the figure's desk height, as is.
- The sun: a SceneBlocking's azimuth and elevation are the same numbers in `desk.set_build`
  (`sun_azimuth_deg`: 0 in front of the set, 90 to its right, 180 behind it). The SKY world gets
  `sun_rotation = rad(azimuth) + π` and `sun_elevation = rad(elevation)`.
- Wind: `wind_dir_deg` is where the wind blows toward, with the same angles (0 toward −Y).
- Cameras look down their −Z axis with +Y up, no roll unless a move keeps one.

## Limits and known gaps

- **Kinds**: `duck` and `bird` are not built; `desk.actor_add` refuses them with the list of the
  built kinds (a brief's birds stand in as cats). There is no stirrup pose, so children on big
  mounts sit with their legs splayed over the barrel, and short-necked animals (dogs, cats, sheep,
  pigs, bears) cannot graze from the ground.
- **Hiding is by scale**: `hide_render` cannot be keyed, so a kite after `after: 'hide'`, and the
  actors and props a staging hides in shots they are not in, are scaled to 1e-8 of the scale
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
  0.9, a ball with Blender's default 0.1 rolls on). A body carried by a rotating, non-uniformly
  scaled parent is sheared before its release and cannot be baked exactly.
- **Water**: it is no collider: until the bake makes a body float, the simulation (and a
  `water: 'ignore'` bake) rolls it over a lake as over the ground. A floating body drifts on its
  own: it passes through what stands in the water (a pier's posts, a boat) and stops at the edge of
  the water it came into. `body_in_water` reads a body the simulation moves (not baked yet) every 6
  frames, so a bounce off the water between two of them goes unreported; a baked body is read on
  every frame. `walks_on_water` reads an actor's mark, not its feet: an animal whose middle is on
  the shore while its front legs are in the water is not on it. An actor is not checked at the
  frames it belongs in the water, wherever it stands then (one added with `in_water: true` never),
  and a boat is neither an actor nor a body: what it carries stands on it, and it floats only as it
  is keyed.
- **Vehicles** follow the path's height only: no terrain, suspension or slip, and the wheels slide
  sideways a little on tight curves.
- **Cameras**: the solids cameras are pushed out of are the stored meshes (modifiers ignored); moves
  do not avoid solids along their path. An actor outside the shot that hides a subject is seen past
  or reported (`occluded`), but a prop, a rock or a building may block the view without a warning. A
  wide frame that holds a long walk can leave the subjects small, and the plan is judged at the
  shot's first frame. Depth of field is a camera setting, so a `rack_focus` shot's focus reaches
  other shots on the same camera.
- **Briefs**: the kinds of the cast, who rides whom, who holds what and where the water lies are
  read from English words only, without following pronouns across sentences ("Mira walks in. She
  grabs the kite." gives the kite to nobody). Sentences are split in the text's own case, at ".",
  "!", "?", ";" or a line break, but not at a period inside a number, after an abbreviation no
  capital follows (`approx.`, `e.g.`; "in", "no", "max" and a few more only beside a number, as in
  `6 ft 2 in.` or `No. 5`), or after a title written with a capital or an initial (`Dr. Okafor`,
  `St. Ives`, `J. A. Smith`) unless the next word opens a sentence and is written with a capital
  ("He", "The", "Then"), so "Exit at Gate C. Pip barks." and "Tom runs along Elm St. in the rain."
  stay one sentence, but "Dr. An arrives." is two. A brief places nobody, so the cast starts on the
  planned sides or in a row and moves only as it is staged afterwards (`desk.actor_move` …). An
  update keeps hand edits of unchanged shots and the desk's cut order but does not follow a new
  order of the brief, and a recast or replanned shot's camera is solved again unless it was set by
  hand. Staging a brief took 0.1–0.4 s for 2 shots and 2 cast members, 1.3 s for 20 shots and 6,
  8 s for 60 and 12, and 34 s for 200 and 12 (a 4-core machine shared with other work);
  `shotResults` and an update each took about 40 % of that. Most of it is the camera solve and the
  checks, which measure every actor of the scene in every shot: stage long scenes in a worker and
  show progress.
- **Library units**: a set's pieces do not block the camera solver, and no check says an actor
  stands inside one; marks keep clear of them only when the set is first placed, so a later version
  or another set moves no actor or prop staged before. An update does not rebuild an actor for a
  figure of another kind or height (it keeps the actor and refuses the figure).
- **SceneBlocking import**: the kind of each character and who rides whom are read from English
  text only; hand-made keys on imported actors and props are replaced on re-import (user objects,
  shots, physics and materials are kept), and the re-import's warnings name the actors, props,
  landmarks and shot cameras changed in the desk since the last import. Importing a long clip takes
  seconds (about 5 s for 20 shots with 6 actors when it was measured).
- **Real video models**: whether the references improve a model's takes is not measured yet. A host
  should compare takes with and without them on its own scenes (the kite flights, riders on their
  mounts, and shot and reverse by water that motivated the desk), with the same seeds and blind
  scoring, before asking for `motion` or `pose` references by default.
