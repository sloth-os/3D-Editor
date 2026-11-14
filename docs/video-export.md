# Video export

The server renders the shots of the [director's desk](director-desk.md) (or a plain frame range)
in its render processes and encodes them with ffmpeg: one H.264 MP4 of the whole sequence, one
frame-exact clip per shot, posters, a labelled contact sheet, control passes (depth, normals,
object mask, edges, pose skeletons) and a `manifest.json` that says what every frame shows. An
export is a background job: start it, follow it, download the files.

Contents: [requirements](#requirements) · [parameters](#parameters) ·
[quality presets and speed](#quality-presets-and-speed) · [outputs](#outputs) ·
[the manifest](#the-manifest) · [jobs](#jobs) · [memory](#memory) · [REST](#rest) ·
[MCP](#mcp) · [troubleshooting](#troubleshooting)

## Requirements

- **ffmpeg with libx264** on the server. The server runs `FFMPEG_PATH -version` (default `ffmpeg`,
  looked up on the `PATH`; a value with a slash is a file path) once at startup; `/api/config`
  reports `features.videoExport: true` when that works, whatever encoders that ffmpeg has. Without
  ffmpeg, or with one that has no libx264 encoder, every export is refused with code
  `FFMPEG_UNAVAILABLE` and the remedy ("Install ffmpeg with libx264 on the server (Debian/Ubuntu:
  apt-get install ffmpeg; Alpine: apk add ffmpeg) or set FFMPEG_PATH to it, then restart the
  server."). VP9 needs ffmpeg's libvpx-vp9 as well; without it an export asked for VP9 is encoded
  as H.264.
- **The Docker image ships ffmpeg** (Alpine's package, with libx264 and libvpx), so
  `docker run … ghcr.io/sloth-os/3d-editor` exports out of the box. An image built with
  `--build-arg WITH_FFMPEG=0` leaves it out (about 130 MB smaller) and has no video export.
- **Render processes**: a server run with `RENDER_WORKERS=0` (rendering on its main thread) refuses
  exports with `UNAVAILABLE`.
- **Disk**: exports are written to `EXPORT_DIR` (default `<DATA_DIR>/exports`); see
  [jobs](#jobs) for the cleanup.

| Variable            | Default              | Meaning                                                                         |
| ------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `FFMPEG_PATH`       | `ffmpeg`             | The ffmpeg program: a name on the `PATH` or a file path                         |
| `EXPORT_DIR`        | `<DATA_DIR>/exports` | Where exports are written (`<EXPORT_DIR>/<project>/<export>/`)                  |
| `EXPORT_MAX_MB`     | `20480`              | Disk space all exports may take; the oldest finished ones are deleted beyond it |
| `EXPORT_TTL_HOURS`  | `168`                | Hours a finished export is kept                                                 |
| `EXPORT_MAX_QUEUED` | `8`                  | Exports that may wait to start; more are refused with `QUEUE_FULL`              |
| `RENDER_WORKERS`    | CPU cores, at most 8 | Render processes; an export uses all of them that its memory allows             |

## Parameters

One schema serves the MCP tool `export_video` (with `project`) and the body of
`POST /api/projects/:id/video-exports`; unknown keys are refused.

| Parameter                  | Default                        | Meaning                                                                                                        |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `preset`                   | –                              | `rideo`: the clips `rideo_push` sends (below); the parameters given win over it                                |
| `shots`                    | every enabled shot             | Shot ids or names in cut order, or `'all'`; a scene without shots exports its frame range                      |
| `frame_start`, `frame_end` | the scene's range              | Scene frames (inclusive) of an export without shots                                                            |
| `camera`                   | the scene camera               | The camera of an export without shots                                                                          |
| `outputs`                  | all `true`                     | `{sequence, clips, posters, contact_sheet}`                                                                    |
| `width`, `height`          | render resolution × percentage | Even, 16–3840 × 16–2160; one of them alone keeps the render aspect                                             |
| `fps`                      | the scene's fps                | Output rate (0–120); frames are sampled from the scene at that rate                                            |
| `quality`                  | `standard`                     | `draft`, `standard` or `high` (below)                                                                          |
| `look`                     | `material`                     | `material` (the scene as it is), `clay` (grey clay, no textures) or `solid` (flat colours)                     |
| `passes`                   | `['beauty']`                   | Any of `beauty`, `depth`, `normal`, `mask`, `edges`, `pose`, each its own video                                |
| `codec`                    | `h264`                         | `h264` (MP4) or `vp9` (WebM)                                                                                   |
| `match_model_duration`     | `false`                        | Pad (hold the last frame) or trim each clip to the video model's shortest and longest take (the desk settings) |
| `label`                    | –                              | A name for the export (200 characters)                                                                         |

At most 100,000 output frames per export.

Preset `rideo` makes the clips [`rideo_push`](rideo.md) sends: quality `draft`, look `clay` and
clips only (no sequence, posters or contact sheet), with the passes `beauty`, `depth` and `pose`,
one for each reference mode (`motion`, `camera` and `pose`), at the render resolution at 100 %
(`rideo_import` sets it to rideo's) and the scene's fps (rideo's too). The parameters given win over
the preset, `outputs` key by key.

## Quality presets and speed

Every preset renders with the CPU rasterizer, shading once per pixel and triangle (MSAA style), with
sun and spot shadows; the encoder settings make the files smaller or sharper.

| Quality    | Samples per axis           | Ambient occlusion | x264             | VP9             |
| ---------- | -------------------------- | ----------------- | ---------------- | --------------- |
| `draft`    | 1                          | no                | CRF 28, veryfast | CRF 40, speed 6 |
| `standard` | 2                          | yes               | CRF 23, medium   | CRF 33, speed 4 |
| `high`     | 4 up to 1280 × 720, else 2 | yes               | CRF 18, slow     | CRF 28, speed 2 |

Measured with real render processes and ffmpeg 6.1 on a 4-core machine that other work shared
(the load average is given; the same export on a calm machine is faster). The 720p rows export
one 2 s over-the-shoulder shot (two actors and a flying kite on a grass set, sky and sun) of the
[worked example](director-desk.md#worked-example-a-kite-on-a-hill):

| Size        | Frames | Quality    | Passes              | Render processes | Time    | Frames/s | Load    |
| ----------- | ------ | ---------- | ------------------- | ---------------- | ------- | -------- | ------- |
| 1280 × 720  | 48     | `draft`    | beauty              | 4                | 16.2 s  | 3.0      | 1.3–2.9 |
| 1280 × 720  | 48     | `standard` | beauty              | 4                | 20.0 s  | 2.4      | 2.9–3.6 |
| 1280 × 720  | 48     | `high`     | beauty              | 4                | 73.0 s  | 0.66     | 3.6–8.7 |
| 1280 × 720  | 48     | `standard` | beauty, depth, pose | 4                | 24.2 s  | 2.0      | 8.7–8.9 |
| 640 × 360   | 720    | `draft`    | beauty, depth, pose | 4                | 65–80 s | 9.0–11.1 | 0.4–4   |
| 1280 × 720  | 96     | `standard` | beauty, depth, pose | 2                | 65.2 s  | 1.5      | 3.6–5.5 |
| 1920 × 1080 | 48     | `standard` | all six             | 2                | 80.0 s  | 0.6      | 4.6–6.4 |

The 640 × 360 row is the whole worked example (six shots, three runs); the last two rows are a
two-shot scene with a walking actor. Time is from the job's start to its end, measuring, rendering,
encoding, cutting the clips and writing posters and manifest included. `export_video` returns
`estimate_s`, and `export_status` the measured `fps` and `eta_s` while it runs.

## Outputs

Files are written to `<EXPORT_DIR>/<project>/<export>/` and listed in the job's `files` with their
kind, bytes, frames, duration, sha256 and download `url`:

| File                                      | What it is                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `sequence.mp4`                            | the whole cut (`sequence.<pass>.mp4` for the other passes)                                                             |
| `shot-01-<name>.mp4` …                    | one clip per shot with exactly the shot's frames (`frame_end − frame_start + 1`), `shot-01-<name>.<pass>.mp4` per pass |
| `shot-01-<name>.png`, `.jpg`              | the first frame of each shot (posters)                                                                                 |
| `contact-sheet.png`                       | the first and middle frame of every shot, labelled `<shot>-<frame>`                                                    |
| `sequence.mask.mkv`, `sequence.edges.mkv` | the mask and edge passes again, lossless (libx264rgb, qp 0), next to their preview MP4s                                |
| `manifest.json`                           | below                                                                                                                  |

**Encoding**: H.264 (libx264) without B-frames, yuv420p, BT.709 matrix, primaries and transfer
tags, full range converted to limited, `+faststart`, no audio, even sizes, a keyframe at every
shot start and at least every 2 s. The clips are cut from the sequence by stream copy at those
keyframes, so they are frame-exact (the tests check every clip's frame count and duration with
`ffprobe`); x264 gets an explicit thread count (1.5 per core, at most one per two macroblock rows).

**Passes**, each rendered from the same evaluation as the beauty image:

- `depth`: 1 byte per pixel, white at the shot's nearest depth and black at its farthest, linear in
  1/depth between, the range fixed per shot (so a shot never flickers);
- `normal`: view-space normals as RGB;
- `mask`: each object in a colour of its own, the same in every shot of the export (`mask_palette`
  in the manifest; actors in their desk colour);
- `edges`: black lines on white where depth jumps or normals turn;
- `pose`: OpenPose-18 skeletons of the people and AP-10K skeletons of the animals on black, in the
  OpenPose colours.

Strings (a kite's, anything with `desk_role: 'string'`) are drawn as screen-space lines at least 2
px wide in the beauty, mask, edge and pose passes, hidden behind opaque objects. Objects hidden by
their scale (a kite after `after: 'hide'`, the actors and props a rideo import hides in shots they
are not in) draw nothing in any pass: no skeleton, no string line, no mask colour. What tells them
is their geometry, which a hide key shrinks to under a micrometre across (a string to under a
micrometre thick), so a store model shown at a tiny scale (one in micrometres made 1 m tall is shown
at 1e-6) is drawn, boxed and measured as any other.

## The manifest

`manifest.json` (version 1) describes the export from the snapshot it rendered:

- top level: `version`, `project {id, name}`, `created_at`, `fps`, `width`, `height`, `aspect`,
  `frames`, `duration_s`, `codec`, `color` (bt709, limited), `look`, `quality`, `passes`, `files`,
  `credits` (every store model in the scene: `object`, `name`, `store_id`, `license`, `author`,
  `source_url`), `issues` (`desk.check`'s), `warnings`, `mask_palette` and `shots`;
- per shot: `id`, `name`, `index`, `external` (the rideo clip and shot it came from),
  `camera {object, name, lens_mm, sensor_mm: 36}`, `framing`, `angle`, `height`, `move`, `notes`,
  `scene_frames`, `output_frames`, `timecode_in` and `timecode_out` (HH:MM:SS:FF, the out point the
  frame after the shot, as in edit decision lists), `duration_s`, `files` (by pass, and the
  posters), `blocking_line` (rideo's sentence for the shot's first frame), `moves_line`, `subjects`
  (`object`, `name`, `role`, `color`, `character_id`, `element_id`), `camera_track` (every output
  frame: `frame`, `position`, `rotation_quat` [x, y, z, w], `fov_deg`), `subject_tracks` (by rideo
  character id or object id: `frame`, `x`, `y`, `w`, `h` in output pixels from the top left,
  `visible`, and `hidden: true` with a zero box while the subject is hidden by its scale) and
  `rideo {clip, shot, camera_move, layout, moves}`.

Coordinates are the editor's (metres, Z up; [conventions](director-desk.md#coordinates)).

## Jobs

- **Snapshot**: the export renders a copy of the project taken when it was asked for (stored next
  to the job as `snapshot.ybin` until it ends): edits made meanwhile, by people or agents, never
  reach it.
- **Queue**: one export renders at a time; the others wait first come, first served. At most
  `EXPORT_MAX_QUEUED` (8) may wait: more are refused with `QUEUE_FULL` (REST 409). Unknown projects
  and shots are refused before that (`NOT_FOUND`).
- **Status**: `queued`, `running`, `encoding`, `done`, `failed` or `cancelled`, with
  `progress {frames_done, frames_total, fraction, fps, eta_s, shot}`, `warnings`, `error` and
  `error_code`, and
  `render {processes, render_workers, process_mb, ffmpeg_mb, available_mb, memory_source}` (how it
  renders, below). `export_status` and `GET …?wait=` wait up to 50 s for the job to change status
  (not for every frame), so poll in a loop.
- **Persistence**: each job is `job.json` in its folder. A queued job survives a restart and waits
  again; a running one cannot go on and becomes failed: "server shut down while the export ran"
  when the server stops normally (SIGTERM, as `docker stop` and deploys send, or Ctrl+C), "server
  restarted while the export ran" when it stopped without that (a crash, `kill -9`, a power cut).
- **Cleanup**: every 15 minutes finished jobs older than `EXPORT_TTL_HOURS` (168) are deleted, and
  the oldest finished ones beyond `EXPORT_MAX_MB` (20480) of exports in all.
- **Cancel**: `cancel_export` stops a queued or running job, which ends `cancelled`; a finished
  job is left as it is. With `delete_files: true` it also deletes the job and its files, whatever
  its status (a finished export too), and returns the job as it was. `DELETE` over REST does the
  same as `delete_files: true`.
- **Render process deaths**: a frame whose render process dies is rendered again on a new one (a
  frame may take down at most 3 processes before the export fails).
- **Metrics**: `video_exports_total{status}`, `video_export_frames_total`, `video_export_seconds`
  and `video_exports_active` on `/metrics`.

## Memory

Before an export starts rendering, the server decides how many render processes it can use: the
memory available (Linux `MemAvailable`, or the container's cgroup limit minus its use when that is
lower) less what ffmpeg needs for the streams and the server's own share, divided by what one
render process needs at this size and with these passes (a process already running needs only
what it does not hold yet; one the export starts adds its base, about 128 MiB). The server starts
only the render processes the export renders on: with fewer than `RENDER_WORKERS` it renders on
fewer, starts no others and adds a warning; when not even one fits, `export_video` is refused at
once with `OUT_OF_MEMORY` (the message says what the export needs and what to change: a smaller
size, fewer passes or quality `draft`). The decision is in the job's `render` field.

Each pass is its own encoder stream (mask and edges two), so passes multiply ffmpeg's memory:
one 1080p `standard` x264 stream measured about 535 MiB. A render process needed about 400 MB at
720p with three passes and 550–580 MB at 1080p with six. Render processes give their working
buffers back when an export ends; they run with `MALLOC_MMAP_THRESHOLD_=1048576` (unless the
environment sets it or `GLIBC_TUNABLES`) so glibc returns the memory to the system (musl, in the
Alpine image, ignores the variable).

## REST

| Endpoint                                                   | Purpose                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /api/projects/:id/video-exports`                     | Start an export (body: the [parameters](#parameters)); 202 with the job |
| `GET /api/projects/:id/video-exports`                      | `{exports: [...]}`, newest first                                        |
| `GET /api/projects/:id/video-exports/:export?wait=<s>`     | The job, after waiting up to `wait` (0–50) seconds for it to change     |
| `GET /api/projects/:id/video-exports/:export/files/<name>` | A file, streamed with `ETag`, `Range` (206) and `HEAD`                  |
| `DELETE /api/projects/:id/video-exports/:export`           | Cancel it and delete its files                                          |

Failures answer `{error, code}`: 503 for `UNAVAILABLE` and `FFMPEG_UNAVAILABLE`, 409 for
`QUEUE_FULL`, 404 for unknown projects, shots and exports, 400 for invalid parameters, 507 for
`OUT_OF_MEMORY`. The routes need the server's `AUTH_TOKEN` like every `/api` route (a Bearer header
or `?token=`); download links carry no token.

```bash
curl -sS -X POST http://localhost:8080/api/projects/$ID/video-exports \
  -H 'content-type: application/json' -d '{"quality": "draft", "width": 640, "height": 360}'
curl -sS "http://localhost:8080/api/projects/$ID/video-exports/$EXPORT?wait=30"
curl -sS -o sequence.mp4 "http://localhost:8080/api/projects/$ID/video-exports/$EXPORT/files/sequence.mp4"
```

## MCP

| Tool            | Arguments                                   | Returns                                              |
| --------------- | ------------------------------------------- | ---------------------------------------------------- |
| `export_video`  | `project` and the [parameters](#parameters) | `{export, status, frames_total, estimate_s}` at once |
| `export_status` | `export`, `wait_s` (0–50)                   | the job (files with download links when done)        |
| `cancel_export` | `export`, `delete_files` (false)            | the job                                              |
| `list_exports`  | `project` (default: every project)          | the jobs, newest first                               |

`render_image` and `render_animation` take `camera: 'shots'` to look through the camera of the
shot that covers each frame (the scene camera where none does): a quick check of the cut before an
export. In the editor, Render › Export Video… (Ctrl+Shift+F12) runs the same jobs
([director-desk.md](director-desk.md#in-the-editor)).

## Troubleshooting

| Symptom                                                                                 | Cause and remedy                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features.videoExport: false`; `FFMPEG_UNAVAILABLE` "is not installed on the server"    | ffmpeg was not found, or `FFMPEG_PATH` does not run it: install it (Debian/Ubuntu `apt-get install ffmpeg`, Alpine `apk add ffmpeg`) or set `FFMPEG_PATH`, then restart                                 |
| `FFMPEG_UNAVAILABLE` "has no libx264 encoder" although `features.videoExport` is `true` | this ffmpeg runs but was built without libx264 (the flag only checks that ffmpeg runs): install one with it (the Debian/Ubuntu and Alpine packages have it) or point `FFMPEG_PATH` to one, then restart |
| `UNAVAILABLE` "needs render processes"                                                  | `RENDER_WORKERS=0`: set it to 1 or more                                                                                                                                                                 |
| `QUEUE_FULL` (409)                                                                      | `EXPORT_MAX_QUEUED` exports already wait: wait for one, cancel one, or raise the setting                                                                                                                |
| `OUT_OF_MEMORY` at start, or a "memory:" warning                                        | not enough memory for the render processes and ffmpeg: a smaller size, fewer passes, quality `draft`, or free memory on the server                                                                      |
| failed "server shut down while the export ran"                                          | the server was stopped (SIGTERM, Ctrl+C) during the export: start the export again                                                                                                                      |
| failed "server restarted while the export ran"                                          | the server ended without a shutdown (a crash, `kill -9`) during the export: start the export again                                                                                                      |
| failed "the export grew larger than EXPORT_MAX_MB"                                      | export fewer frames, a smaller size or fewer passes, or raise `EXPORT_MAX_MB`                                                                                                                           |
| a subject out of frame in a clip                                                        | run `desk.check`: `subject_out_of_frame` names the shot and frame; solve the shot again or widen its framing (a subject a pan or tilt brings in by its last frame is `subject_revealed`, a warning)     |
| a kite's string runs from where the hand was                                            | the anchor actor moved, posed or mounted after `desk.tether_fly`: `desk.check` reports `tether_detached` with the frames; fly the kite again after the anchor's last move                               |
| an actor walks on water, or a body rolls on it                                          | `desk.check` reports `walks_on_water` (route the walk around it, or give a swimmer `in_water: true`) and `body_in_water` (re-aim the throw, or release it again and bake with `{water: 'float'}`)       |
| a kite's string missing                                                                 | strings come from `desk.tether_fly` (or objects with `desk_role: 'string'`); a string is hidden before its flight starts                                                                                |
| the clip has a different length than rideo expects                                      | rideo asks its model for `clamp(duration)`: set the desk's take limits and export with `match_model_duration: true`                                                                                     |
| exports disappear                                                                       | finished exports are deleted after `EXPORT_TTL_HOURS` and beyond `EXPORT_MAX_MB`                                                                                                                        |
