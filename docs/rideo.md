# rideo: 3D previs for an AI video studio

rideo, an AI video studio, makes films shot by shot with AI video models. Each of its video
requests can carry one reference video per shot (`shot.motionReference = {resourceId, mode}`
with mode `motion`, `pose` or `camera`), sent inline at the project's frame rate and resolution.
The editor is rideo's 3D previs back end: it imports a rideo clip (a scene) as a
[director's desk](director-desk.md) project, stages it in 3D (actors, props, physics, cameras),
renders a frame-exact reference clip per shot with the [video export](video-export.md), writes its
blocking back to rideo and attaches the clips to rideo's shots.

Contents:

- [Setup](#setup)
- [Recipe 1: an agent with both MCP servers](#recipe-1-an-agent-with-both-mcp-servers)
- [Recipe 2: one REST call](#recipe-2-one-rest-call)
- [What each output is for](#what-each-output-is-for)
- [The agreement principle](#the-agreement-principle)
- [What rideo should measure first](#what-rideo-should-measure-first)
- [Limits](#limits)

## Setup

Point the editor's server at rideo:

| Variable      | Meaning                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `RIDEO_URL`   | rideo's base URL (http or https); `/api/config` then reports `features.rideo: true`                 |
| `RIDEO_TOKEN` | a rideo API or agent token, sent as `Authorization: Bearer …` to `RIDEO_URL` and to no other server |

Every call can also name a rideo server of its own (`rideo: {url, token, project, clip}`); a call
that names another URL must bring its own token, because the configured one only ever goes to
`RIDEO_URL`. rideo ids look like `prj_…` (projects) and `clp_…` (clips).

The editor reads rideo's documents through its REST API: the project settings (fps, resolution,
aspect ratio, whether its desk view is on), the clip (its shots with durations, camera specs,
cast, elements, planned layout and continuity), the clip's blocking (its draft when there is one),
the characters and elements. rideo's own `/api/config` gives the video model's take limits.

## Recipe 1: an agent with both MCP servers

An agent connected to rideo's MCP server and to this editor's (`/mcp`) moves a clip through the
editor and back without any change to rideo:

1. **rideo** `blocking_get {projectId, clipId}`: read rideo's blocking of the clip
   (`{blocking, state, draft, issues, lines}`) to see what rideo staged and which lines its prompts
   carry. rideo's own tools name the ids `projectId` and `clipId`; the editor's tools take them as
   `rideo: {project, clip}`.
2. **editor** `rideo_import {rideo: {project, clip}}`: builds (or, run again, updates in place) a
   project named after the clip: the scene's fps and size from rideo's settings, the shots in
   rideo's order, each `round(durationSec × fps)` frames, a 12-frame pre-roll before cuts where
   marks jump, the cast as actors at their marks (walks to `toX`/`toZ`, riders on their mounts,
   held props in hands, kites and balloons on strings), props and landmarks as store models or
   primitives, rideo's cameras exactly as they are (only shots without one are solved, the line is
   never enforced on import), each fitted to the shot's planned layout. It returns our project id,
   our shot id for each rideo shot, the issues found and warnings (no blocking yet, rideo's desk
   view off, storyboard frames to redraw). One undo step. An agent that already has the blocking
   and the clip documents can run `desk.import_rideo_blocking` itself instead.
3. **editor**: refine the staging with the desk operators (`desk.actor_move`, `desk.tether_fly`,
   `desk.physics_throw` …), then `desk.shot_solve {only_missing: true}` and `desk.check`. Fix
   `line_crossed`, `subject_out_of_frame` and `plan_mismatch`;
   `render_animation {camera: 'shots', format: 'CONTACT_SHEET'}` shows the cut.
4. **editor**
   `export_video {project, quality: 'draft', look: 'clay', outputs: {sequence: false, clips: true, posters: false, contact_sheet: false}, passes: ['beauty', 'depth', 'pose']}`
   at rideo's fps and size (the import set them as the scene's), then
   `export_status {export, wait_s: 50}` until it is done.
5. **editor** `rideo_push {project, export, rideo: {project, clip}, mode: 'camera'}`: writes our
   blocking to the clip, then uploads each chosen shot's clip and sets its `motionReference` and
   camera move. It returns, per shot, the rideo resource and mode or the error, the blocking lines
   that differ, the boards to redraw and the shots whose staging changed since the export.
   `mode: 'camera'` keeps every shot on a camera reference until rideo has measured the others
   ([below](#what-rideo-should-measure-first)); leave it out to get the default per shot.
6. **rideo**: redraw the boards the push listed (their first frame was drawn before our staging),
   then regenerate the shots.

`rideo_import` and `rideo_push` answer when their work is done. They fail with `UNAVAILABLE` when
no rideo server is set, `NEEDS_KEY` when rideo refuses the token and `UPSTREAM` when rideo is
down or fails, each code on the line after the message ([errors](mcp.md#errors)); a project or
clip rideo does not have fails with a plain message.

`rideo_push` arguments:

| Argument         | Default                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `export`         | a finished export of the project                                                                                                           |
| `shots`          | the shots with physics, tethers, held or thrown props or a camera move (our ids or names, or rideo shot ids)                               |
| `mode`           | per shot: `camera` when rideo's first frame cannot follow our staging, else `motion` for props in motion, `pose` for actors, else `camera` |
| `pass`           | per mode: `motion` beauty, `pose` the pose pass, `camera` depth                                                                            |
| `write_blocking` | true: write our blocking first (an approved clip refuses it, and the push stops there)                                                     |

What the push checks before it uploads: each clip has exactly `round(durationSec × fps)` frames
of the rideo shot, at rideo's fps and size, H.264 MP4, at most 256 MB; a clip whose camera or
frame range changed in the project since the export is refused, changed walks turn the shot into
a camera reference. It never replaces a `performance` reference, uploads a clip only once per
content (it remembers uploads per rideo clip under `DATA_DIR/rideo-push`, and uploads again when
rideo no longer has the resource), retries 429 and 503, and stops on a refused token (401/403).
Every other shot of the clip gets our camera move too, so no shot keeps a move our staging no
longer has.

## Recipe 2: one REST call

`POST /api/rideo/previs` runs the import, a draft export and the push as one job on the server;
`GET /api/rideo/previs/:job?wait=<s>` follows it (waits up to 50 s for it to change):

```ts
// Previs a rideo clip with the editor's server: import, draft export, push.
const EDITOR = 'https://editor.example.org';
const headers = { authorization: `Bearer ${process.env.EDITOR_TOKEN}`, 'content-type': 'application/json' };

interface PrevisJob {
  id: string;
  status: 'importing' | 'exporting' | 'pushing' | 'done' | 'failed' | 'cancelled';
  project: string | null;
  export: string | null;
  export_status: { status: string; progress: { frames_done: number; frames_total: number } } | null;
  push: { status: 'done' | 'partial' | 'failed'; shots: unknown[]; boards_to_redraw: unknown[] } | null;
  error: string | null;
  warnings: string[];
}

/** Longest a previs may take here: the draft export can wait behind other exports. */
const DEADLINE_MS = 3 * 60 * 60 * 1000;

async function previs(project: string, clip: string): Promise<PrevisJob> {
  const started = await fetch(`${EDITOR}/api/rideo/previs`, {
    method: 'POST',
    headers,
    // camera references until rideo has measured the other modes (see below)
    body: JSON.stringify({ rideo: { project, clip }, push: { mode: 'camera' } }),
  });
  if (started.status !== 202) throw new Error(`previs refused: ${started.status} ${await started.text()}`);
  let job = (await started.json()) as PrevisJob;
  const id = job.id;
  const deadline = Date.now() + DEADLINE_MS;
  while (!['done', 'failed', 'cancelled'].includes(job.status)) {
    if (Date.now() > deadline) throw new Error(`previs ${id}: still ${job.status} after ${DEADLINE_MS} ms`);
    const res = await fetch(`${EDITOR}/api/rideo/previs/${id}?wait=50`, { headers });
    // 404 after the editor's server restarted: it lost the job (jobs live in its memory)
    if (!res.ok) throw new Error(`previs ${id}: ${res.status} ${await res.text()}`);
    job = (await res.json()) as PrevisJob;
  }
  return job;
}

const job = await previs('prj_0123456789', 'clp_0123456789');
console.log(job.status, job.error, job.push?.status, job.push?.boards_to_redraw, job.warnings);
```

The body takes `rideo` (required), `project` (our project; default: one named after the clip),
`export` (export parameters over the previs defaults), `push` (`shots`, `mode`, `pass`,
`write_blocking`), `cast_overrides` (actor kind by rideo character id, e.g. `{"chr_…": "pony"}`)
and `model_limits` (`{min_s, max_s}`, default: rideo's). The previs defaults: quality `draft`,
look `clay`, clips only, rideo's fps and size, and only the passes the chosen modes need (always
beauty, so a shot whose mode changes at push time still has a clip). The push writes the blocking
from a copy of the project taken when the export starts.

`POST` answers 202 with the job as soon as it has started, before it talks to rideo. It refuses
at once, with `{error, code}`, only what no job can do:

| Status | Code             | When                                                                                                                                                    |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_PARAMS` | export parameters the export refuses, or a `rideo.url` that is not an http(s) URL; a body that is not a previs request answers 400 with `{error}` alone |
| 409    | `QUEUE_FULL`     | four previs jobs already run                                                                                                                            |
| 503    | `UNAVAILABLE`    | no rideo server: `RIDEO_URL` is not set and the body names no `rideo.url`                                                                               |

Everything else ends the job later with `status: 'failed'` and the reason in `error` (a job has no
code): a rideo that is down or does not answer, a token rideo refuses (another `rideo.url` needs
its own `rideo.token`), a project or clip rideo does not have, a full export queue, a failed
export or push. A shutdown of the editor's server ends a running job `cancelled`.
`GET /api/rideo/previs/:job` answers 404 `NOT_FOUND` for a job the server does not have: previs
jobs live in the server's memory, so after a restart it knows none of the earlier ones; start the
previs again. A `wait` over 50 answers 400.

## What each output is for

| Output                              | rideo mode | What the video model gets from it                                                                                                |
| ----------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| beauty clip in the `clay` look      | `motion`   | how things move: a kite pulling on its string, a thrown ball's arc, a prop carried and let go; clay leaves the look to the model |
| `pose` pass (skeletons on black)    | `pose`     | the bodies and their blocking: who stands where, walks, sits, rides; OpenPose-18 for people, AP-10K for animals                  |
| `depth` pass                        | `camera`   | the camera move and the layout of the set without the actors' look: the safe choice when the first frame may not match           |
| `blocking_line` in `manifest.json`  | –          | the sentence rideo's prompts carry for the shot; the push compares it with rideo's own                                           |
| `rideo.camera_move` in the manifest | –          | the move the push sends with the reference, so rideo prompts the move the clip shows                                             |

## The agreement principle

rideo's own failure analysis found that when the shot description, the blocking line and the
camera view disagree, the frames follow none of them. A reference video is a fourth account of
the shot, so the bridge makes it agree with the other three:

1. The import fits every camera to the shot's planned layout (`plan_mismatch` when it cannot), so
   our clip shows the same sides and facings rideo's description plans.
2. The push writes our blocking back to rideo first (`PUT …/clips/:clipId/blocking`): rideo then
   derives its camera view, its blocking line and its camera move from the same staging as the
   clips. A shot whose line in rideo differs from the one in our manifest, or that rideo marks
   `plan_mismatch`, gets a camera reference.
3. The push sends the camera move we rendered with the reference (the shot's whole camera with our
   `move`, so its framing and lens stay).
4. When rideo's first frame cannot have been drawn from our staging (rideo's desk view is off for
   the project, or the shot's storyboard frame was approved before), the push says so, lists the
   boards to redraw and makes that shot's reference a camera reference.

## What rideo should measure first

The effect on real video models is not measured: rideo cannot run here. Before the bridge is on
by default, rideo should compare takes with and without the references on its own scenes, with
the same seeds and its usual blind scoring:

- **The kite scenes (fp56–fp62)**: physics scored 4.0–4.67 against 5.0–6.7 elsewhere; the string
  ran into empty sky, the kite floated like a balloon, slid upwind, doubled or popped in. Measure
  physics and the share of takes whose own watch names a major fault, in `motion` mode with the
  clay beauty clip.
- **Riding (improvements #55)**: riders floated beside riderless ponies. Measure in `pose` mode
  whether riders sit on their mounts through the shot.
- **Swimming, shot and reverse**: Rosie and Sammy swapped places between a shot and its reverse,
  and the shoreline and sun swapped sides. Measure continuity across those cuts with the blocking
  written back and `camera` references.

rideo's own bar is a gain of 0.5 on its scores. The bridge's defaults do not wait for that: a
shot whose first frame can follow our staging gets a `motion` reference when props move in it and
a `pose` reference when it shows actors (`camera` only otherwise). Until a mode clears the bar on
these scenes, ask for `camera` (the most conservative) as the recipes above do —
`rideo_push {…, mode: 'camera'}`, or `push: {mode: 'camera'}` in a previs request — or push no
reference.

## Limits

- **Durations**: a shot's clip has exactly `round(durationSec × fps)` frames, but rideo asks its
  model for `clamp(durationSec)` (4–10 s when the model's limits are unknown). Pass the model's
  limits (`model_limits`, default: rideo's `/api/config`): shots outside them get a
  `duration_clamped` warning, and an export with `match_model_duration: true` pads or trims each
  clip to what the model will make.
- **Inline size**: rideo sends a reference inline, base64 in the video request, so keep clips
  small: draft quality (CRF 28) and the clay look. A draft 1280 × 720 clip measured 16.6 KB for
  2 s (36.5 KB at `standard`); the push refuses clips over 256 MB.
- **Resolution**: an odd rideo resolution is refused by the export (sizes must be even).
- **Previs jobs** are kept in the server's memory (the last 100, at most 4 running); a restart
  loses them (their ids then answer 404), and a shutdown in the middle cancels one. Exports and
  their files stay on disk.
- **Pushes** are recorded in `rideo-push.json` next to the export, not in the export's `job.json`.
- **Reading rideo's text**: the import infers each character's kind (humanoid by default, animals
  for mounts and pets) and who rides whom from English words in names and summaries, without
  following pronouns across sentences; `cast_overrides` sets kinds by hand.
- **The contract** is tested against a mock of rideo's routes built from its code, not a running
  rideo.
