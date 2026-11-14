# Embedding the director's desk

The [director's desk](director-desk.md) also runs inside another web application, its _host_, as
an iframe: `desk.html`, the web app's second page. The host describes a scene in words (a _brief_:
the set, the cast, the props and the shots, with no positions), the person stages and directs it
in the desk, and the desk renders every shot's reference clips in the browser and hands them to
the host, with the scene's state for the host to keep. Host and desk share no code and no server:
everything they exchange goes through the messages of the **desk embed protocol**, version 1. The
AI video studio rideo is the first host.

This repository owns the contract. Version 1 is frozen: a change that is not backwards compatible
is version 2, and both sides list the versions they speak. A host needs nothing of this repository
but a desk URL, this page and the [fixtures](#fixtures).

Contents: [the contract](#the-contract) · [hosting the desk](#hosting-the-desk) ·
[what the desk does](#what-the-desk-does) · [limits and timings](#limits-and-timings) ·
[browser support](#browser-support) · [readings of the contract](#readings-of-the-contract) ·
[testing a host](#testing-a-host)

## The contract

### Topology

- The desk is served from **its own origin**: the 3D-Editor server (the editor at `/`, the desk at
  `/desk.html`), or any static host that serves the built `apps/web/dist` with the
  [headers](#headers) below. Never from a path of the host's origin: the host's service worker,
  storage and routes would collide with the desk's.
- The host embeds it as shown under [the iframe](#the-iframe): no `sandbox`, or a sandbox that
  includes `allow-scripts allow-same-origin allow-downloads` (without `allow-same-origin` the
  desk's origin is `null`, so it cannot connect at all), and never the `credentialless` attribute
  (its storage is thrown away).
- The desk page is served with `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: cross-origin`, so that hosts that are cross-origin isolated (COEP
  `require-corp` or `credentialless`) can embed it, and with
  `Content-Security-Policy: frame-ancestors <allowed host origins>` (default `*`). It never needs
  `SharedArrayBuffer`.
- Both pages must be secure contexts (HTTPS, or `http://localhost` and `127.0.0.1` in
  development): WebCodecs and the Origin Private File System exist only there.
- The desk keeps its working copy in its own (partitioned) IndexedDB, keyed by the host's origin
  and the scene id. The **authoritative** copy is the opaque _desk state_ the host stores and gives
  back: browser storage can be cleared, and another device has none.

### Connection

1. When the desk page has loaded it posts, to `window.parent`, with target origin `'*'` and no
   data: `{ "protocol": "3d-desk", "type": "hello", "versions": [1] }`.
2. The host accepts a `hello` only if `event.source === iframe.contentWindow`, `event.origin` is
   the desk's origin (from its configured desk URL) and `versions` contains a version it speaks.
   It then creates a `MessageChannel` and posts
   `{ "protocol": "3d-desk", "type": "connect", "version": 1 }` to `iframe.contentWindow` with
   target origin = the desk's origin, transferring `port2`.
3. The desk accepts one `connect`, only from `window.parent` (`event.source === window.parent`),
   with a version it speaks, and records `event.origin` as the host's origin. All later messages
   travel on the port, in both directions. Nothing else is ever posted on `window`.
4. The host gives up if no `hello` arrives within 15 s of the iframe's `load` event (a COEP or
   CORP failure shows a browser error page inside the iframe and fires no error event) and tells
   the person.

Port messages are plain objects with a `type`. Every request that expects a reply carries an `id`
(1–64 characters) chosen by the sender; the reply carries the same `id`. Binary data is an
`ArrayBuffer`, transferred (not copied). Unknown `type`s are ignored (and logged); a known `type`
that fails validation is answered with `error` `bad_message` when it had an `id`.

The desk posts `hello` once, at the page's `load` event, and only inside a frame. It ignores window
messages of other protocols, a `connect` from another window, from an origin that is not `http` or
`https` (such as `null`) or without a `MessagePort`. A `connect` of a version it does not speak is
answered on that port with `error` `unsupported_version` and the port is closed; the desk keeps
waiting for a `connect` it can take. Once connected it reads no more window messages (they are
logged and ignored), and it checks every message it sends against the protocol's schemas (a
problem is logged; the host's own validation decides). `ready` is always the first message on the
port: what the host sends before it waits, and is handled in order once `ready` is out.

### Messages from the host

| Type         | Fields                                                                                                                                                             | What the desk does                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`       | `scene`: SceneBrief; `state`: DeskState or null; `options`: OpenOptions (optional)                                                                                 | Opens the scene: restores `state` (merged with its local copy of the same scene, if any), else its local copy, else stages the brief from scratch. Replies `opened`. Sent once per connection; a second `open` is answered with `error` `busy` |
| `export`     | `id`; `shots`: shot ids (optional, default all); `modes`: Mode[] (optional, default `options.modes`, else `["camera"]`); `still`: boolean (optional, default true) | Renders reference clips (and stills) in the browser and replies `progress`… then `result`, or `error`. One export at a time (`busy`)                                                                                                           |
| `cancel`     | `id` (of an export)                                                                                                                                                | Stops that export; it ends with `error` `cancelled`                                                                                                                                                                                            |
| `save`       | `id`                                                                                                                                                               | Replies `state` with the same `id`, now                                                                                                                                                                                                        |
| `result-ack` | `id` (of a `result`); `ok`: boolean; `message`: string (optional); `shots`: `[{shotId, ok, error?}]` (optional)                                                    | Shows the person what the host did with the result                                                                                                                                                                                             |

### Messages from the desk

| Type       | Fields                                                                                                                                                                                                       | When                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`    | `deskVersion`: string; `protocol`: 1; `capabilities.export`: `available` (boolean), `reason` (string or null), `container` `"mp4"`, `videoCodec` `"avc1"`, `modes` (Mode[]); `capabilities.offline`: boolean | Right after `connect`. `export.available` is false where the browser cannot encode H.264 (no WebCodecs, not a secure context): `reason` says why                                                         |
| `opened`   | `sceneId`; `source`: `"state"`, `"local"` or `"brief"`; `changes`: BriefChanges or null                                                                                                                      | After `open`. `changes` lists how the brief differs from the scene the state was staged from (the desk offers to update its shots; it never drops the person's staging silently)                         |
| `state`    | `id` (only when answering `save`); `sceneId`; `state`: DeskState; `shots`: number                                                                                                                            | After `opened`, after edits (at most every 5 s, 2 s after the last change), when the person presses Done, and in answer to `save`. The host stores `state` as it is and hands it back in the next `open` |
| `progress` | `id` (of the export); `phase`: `"prepare"`, `"render"`, `"encode"` or `"finish"`; `done`: integer; `total`: integer; `shotId`: string (optional)                                                             | During an export                                                                                                                                                                                         |
| `result`   | `id` (the export's id, or `desk-` and a number when the person pressed **Send** in the desk); `sceneId`; `fps`; `width`; `height`; `shots`: ShotResult[]; `files`: ResultFile[]                              | When an export finished. The ArrayBuffers of `files` are transferred                                                                                                                                     |
| `error`    | `id` (optional); `code`: ErrorCode; `message`: string                                                                                                                                                        | A request failed, or something the host should show                                                                                                                                                      |
| `close`    | `reason`: `"done"` or `"cancel"`                                                                                                                                                                             | The person pressed **Done** (after a final `state`) or **Close** in the desk                                                                                                                             |

### Types

```ts
type Id = string;            // /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/
type Mode = 'motion' | 'pose' | 'camera';
// motion: the beauty pass in the clay look (bodies and their motion)
// pose:   the pose pass (OpenPose-18 / AP-10K skeletons on black)
// camera: the depth pass (inverse depth, the camera's motion through the set)

type SceneBrief = {
  id: Id;                    // the host's scene
  name: string;              // 1–200 characters
  fps: number;               // integer 1–120
  width: number;             // even integer 16–4096
  height: number;            // even integer 16–4096
  set: {
    description: string;     // ≤ 4000: the place, as the host describes it
    interior: boolean | null;          // null: decide from the words
    timeOfDay: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'golden_hour' | 'dusk' | 'night' | null;
  };
  cast: {                    // ≤ 16
    id: Id;
    name: string;            // 1–120
    description: string;     // ≤ 4000: who they are (words such as "a golden retriever", "a girl of 8")
    kind: string | null;     // ≤ 60, a hint such as "person", "child", "dog", "horse"; null: from the words
    heightM: number | null;  // 0.1–4
  }[];
  elements: {                // ≤ 64: the location and the props
    id: Id;
    name: string;            // 1–120
    description: string;     // ≤ 2000
    kind: 'location' | 'prop' | 'other';
  }[];
  shots: {                   // 1–200, in order
    id: Id;
    index: number;           // integer ≥ 0, strictly increasing
    durationSec: number;     // > 0, ≤ 600
    description: string;     // ≤ 4000
    action: string;          // ≤ 4000
    castIds: Id[];           // ⊆ cast ids
    elementIds: Id[];        // ⊆ element ids
    framing: 'extreme_wide' | 'wide' | 'medium' | 'medium_close' | 'close_up' | 'extreme_close_up'
           | 'over_shoulder' | 'pov' | 'insert' | null;
    movement: string | null; // ≤ 60, the host's words for the camera movement ("dolly_in", "tracking")
    move: Move | null;       // a named move the shot must have
    lensMm: number | null;   // integer 8–800
    continuity: 'cut' | 'continuous';
    layout: {                // ≤ 8, the planned first frame: who is on which side, facing which way
      castId: Id;
      side: 'left' | 'centre' | 'right';
      facing: 'left' | 'right' | 'camera' | 'away';
    }[];
  }[];
};

type Move = 'locked_off' | 'push_in' | 'pull_out' | 'dolly_left' | 'dolly_right' | 'pan_left' | 'pan_right'
  | 'tilt_up' | 'tilt_down' | 'tracking_follow' | 'steadicam_walk' | 'orbit_left' | 'orbit_right' | 'crane_up'
  | 'crane_down' | 'whip_pan' | 'handheld' | 'dolly_zoom' | 'drone_flyover' | 'rack_focus';

type DeskState = {
  format: '3d-editor.desk-state';
  version: 1;
  data: ArrayBuffer;         // opaque to the host; ≤ 64 MiB
};

type OpenOptions = {
  hostName?: string;         // ≤ 40, shown on the desk's Send button ("Send to rideo")
  modes?: Mode[];            // the reference modes the host takes, its order (default ["camera"])
  defaultMode?: Mode;        // preselected in the desk's Follow menu (default modes[0])
  readOnly?: boolean;        // default false: view and export, no edits
};

type BriefChanges = {
  added: Id[];               // shots in the brief, not staged
  removed: Id[];             // shots staged, no longer in the brief
  retimed: Id[];             // shots whose duration changed
  recast: Id[];              // shots whose cast changed
  cast: { added: Id[]; removed: Id[] };
};

type ShotResult = {
  shotId: Id;
  frames: number;            // = max(1, round(durationSec × fps)), every file of the shot has exactly these
  durationSec: number;       // = frames / fps
  references: Partial<Record<Mode, string>>;   // mode → file name, for the modes asked for
  still: string | null;      // file name of a PNG of the shot's first frame (clay look), when asked for
  camera: { lensMm: number; move: Move | null };   // the staged camera (lens rounded to an integer 8–800)
  line: string;              // where everyone stands and faces, in words, through the shot's camera
  moves: string | null;      // who walks where during the shot, in words (null: nobody moves)
  planAgrees: boolean | null;     // the camera shows the planned layout (null: the shot had none)
  issues: { code: string; severity: 'error' | 'warning'; message: string }[];   // the desk's checks
};

type ResultFile = { name: string; mime: 'video/mp4' | 'image/png'; data: ArrayBuffer };
// Clip names: `<shotId>.<mode>.mp4`; stills: `<shotId>.still.png`.
// Clips: MP4 (moov first), one H.264 (avc1) video track, no audio, yuv420p BT.709 limited range (tagged in the
// stream and in a `colr` box), constant frame rate = fps, exactly `frames` frames, width × height, a key frame
// first. Stills: 8-bit RGB PNG, width × height.

type ErrorCode = 'bad_message' | 'unsupported_version' | 'invalid_scene' | 'busy' | 'export_unavailable'
  | 'export_failed' | 'out_of_memory' | 'cancelled' | 'not_open' | 'state_unreadable';
```

### Rules

- The desk never sends a host URL, token or anything the host did not give it, and never talks to
  the host's server. The host never sends secrets to the desk (no tokens, no signed media URLs).
- The desk accepts a brief with any `Id`s the pattern allows; it keeps the host's ids on its shots
  and actors so results name the host's shots.
- A `state` from another scene id (or a format or version the desk does not read) is not applied:
  the desk stages the brief and reports `error` `state_unreadable` (without an `id`).
- `result.shots` lists the shots of the export (all the brief's shots when the export named none)
  in brief order; a shot the desk could not render is left out and reported in an `error`
  `export_failed` with its id in the message (other shots still come back).
- Timing: the desk answers `connect` within 2 s with `ready` and `open` with `opened` as soon as
  the scene is staged (seconds for long scenes; it shows its own progress).

[Readings of the contract](#readings-of-the-contract) lists where the desk had to choose a reading.

### Fixtures

The contract comes with one valid example of every message and some invalid ones; in JSON an
`ArrayBuffer` is written `{"$bytes": "<base64>"}`. Both repositories keep a copy of these files and
test their own schemas against them, so a change on one side that breaks the other shows up in its
tests. In this repository:

- `apps/web/test/fixtures/desk-protocol/`: the 22 valid messages (`hello.json`, `connect.json`,
  `open.json`, `open-with-state.json`, `ready.json`, `ready-no-export.json`, `opened.json`,
  `opened-changed.json`, `state.json`, `state-reply.json`, `progress.json`, `result.json`,
  `result-desk.json`, `export.json`, `export-defaults.json`, `cancel.json`, `save.json`,
  `result-ack.json`, `result-ack-partial.json`, `error.json`, `error-no-id.json`, `close.json`)
  and under `invalid/` the 10 that must not validate. `apps/web/test/desk-protocol.test.ts` checks
  the desk's schemas (`apps/web/src/embed/protocol.ts`) against them.
- `packages/core/test/fixtures/desk-embed/`: copies of the briefs (`open.json`,
  `open-with-state.json`, `opened-changed.json` and four invalid ones) that core's staging tests
  read; `desk-protocol.test.ts` checks that they are the same files.

## Hosting the desk

### Its own origin

Serve the desk from an origin of its own, such as `https://desk.example.com`. The 3D-Editor server
does that already: it serves the editor at `/` and the desk at `/desk.html` (also at `/desk`), and
never the editor's `index.html` for the desk's paths. So does any static host serving
`apps/web/dist` (`npm run build`) with the headers below. Several hosts can embed the same desk
origin; each host's scenes stay apart ([projects](#projects-per-host-and-scene)).

### Headers

| Path                                   | Header                         | Value                                                                            |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `/desk.html` (and `/desk`)             | `Cross-Origin-Embedder-Policy` | `DESK_EMBED_COEP`: `require-corp` (default) or `credentialless`; none with `off` |
|                                        | `Cross-Origin-Resource-Policy` | `cross-origin`                                                                   |
|                                        | `Content-Security-Policy`      | `frame-ancestors` and the sources of `DESK_EMBED_ORIGINS` (default `*`)          |
|                                        | `Cache-Control`                | `no-cache`                                                                       |
| `/assets/*` (scripts, styles, workers) | `Cross-Origin-Embedder-Policy` | as the page                                                                      |
|                                        | `Cross-Origin-Resource-Policy` | `cross-origin`                                                                   |
|                                        | `Cache-Control`                | `public, max-age=31536000, immutable`                                            |

- A cross-origin isolated host (COOP `same-origin` and COEP `require-corp` or `credentialless`)
  loads a cross-origin frame only when the framed document has a COEP of its own and a CORP that
  allows the host. Without them the frame shows the browser's error page, and no event tells the
  host: hence its 15 s wait for `hello`.
- The desk's dedicated workers (the staging worker, the export's render workers) start from
  scripts under `assets/`, and a dedicated worker of a document with a COEP needs a compatible COEP
  on its script, so the built files carry the page's COEP and CORP too. The editor's pages load the
  same files; for them the headers change nothing (the editor's workers fetch nothing from other
  origins).
- Never `X-Frame-Options`: it cannot name the hosts, and `frame-ancestors` replaces it. The server
  never sends it.
- The service worker keeps the responses it precached, headers included. After `DESK_EMBED_COEP` or
  `DESK_EMBED_ORIGINS` changed on a deployment, a browser that has the desk's service worker keeps
  getting the old headers from it until the next build of the app (a new `sw.js`) replaces its
  cache. Set them before the first deployment, or deploy a new build with the change.

### Configuration

The server reads two environment variables (also in the [README](../README.md)); the web app's Vite
dev and preview servers read the same two and send the same headers.

| Variable             | Default        | Meaning                                                                                                                                                                                                                                |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESK_EMBED_ORIGINS` | `*`            | Comma-separated origins that may embed the desk, its `frame-ancestors`: `*` (any site), origins such as `https://studio.example.com`, `https://*.example.com` or `http://localhost:5173`, `'self'` (the desk's own origin) or `'none'` |
| `DESK_EMBED_COEP`    | `require-corp` | `Cross-Origin-Embedder-Policy` of the desk page and the built files: `require-corp`, `credentialless` or `off` (none sent)                                                                                                             |

An origin is `http` or `https`, a host name (its first label may be `*`), an IPv4 address or a
bracketed IPv6 address, and an optional port (a number or `*`), with no path; trailing slashes are
dropped and host names lowercased. `*` admits every site (other entries are then redundant), and
`'none'` cannot be combined with origins. The server checks both variables when it starts and
stops for a value it cannot use, with `Invalid configuration: DESK_EMBED_ORIGINS: …` or
`Invalid configuration: DESK_EMBED_COEP: …`. `credentialless` serves cross-origin isolated hosts as
well as `require-corp`; `off` is for a proxy in front of the server that sets the header itself (a
cross-origin isolated host cannot embed a desk without one).

### Static hosts

Any static host works if it serves `apps/web/dist` with the [headers](#headers) for `desk.html`
and `assets/`, revalidates the rest (`sw.js` above all), and never sends `X-Frame-Options`. Hosts
then frame `/desk.html`, or `/desk` where the server maps it. With nginx:

```nginx
server {
  listen 443 ssl;
  server_name desk.example.com;
  # ssl_certificate and ssl_certificate_key as for any site
  root /srv/3d-editor/apps/web/dist;

  # the desk: who may embed it, and what a cross-origin isolated host needs of it
  location = /desk.html {
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;
    add_header Content-Security-Policy "frame-ancestors https://studio.example.com" always;
    add_header Cache-Control "no-cache" always;
  }
  location = /desk {
    rewrite ^ /desk.html last;
  }
  # the built scripts, styles and workers (hashed names): the desk's workers start from them
  location /assets/ {
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }
  # the editor, sw.js and the rest
  location / {
    add_header Cache-Control "no-cache" always;
    try_files $uri /index.html;
  }
}
```

### The iframe

```html
<iframe
  src="https://desk.example.com/desk.html"
  title="3D director's desk"
  allow="fullscreen; clipboard-write; screen-wake-lock"
></iframe>
```

- No `sandbox`, or one with at least `allow-scripts allow-same-origin allow-downloads`: without
  `allow-same-origin` the desk's origin is `null`, so its `hello` comes from no origin the host can
  accept and the desk never connects (it would have no storage either).
- `screen-wake-lock` in `allow` lets the desk keep the screen on while it exports (on a phone the
  screen would otherwise turn off and the export stop). A frame's permissions policy refuses the
  wake lock unless the host allows it, and the desk asks for one only where it may.
- Never the `credentialless` attribute: such a frame gets storage of its own that is thrown away
  with the page, and the local copy with it.
- Give the frame the panel it opens in, from a phone's 390 × 844 up: up to 760 pixels wide the desk
  shows the viewport over its bottom tabs (the shot list is the **Shots** tab); wider, the shot
  list and inspector sit beside the viewport. Keep the frame while the person works: removing it
  ends the connection and stops a running export (the scene is kept in the local copy and in the
  last state the host has).

### Secure contexts and storage

Both pages must be secure contexts: HTTPS, or `http://localhost` and `http://127.0.0.1` in
development. Elsewhere the desk still stages and edits, but cannot export (`ready` says why in
`export.reason`) and has no service worker.

Browsers keep a framed page's storage apart per top-level site (storage partitioning): the desk
embedded by `https://studio.example.com` has its IndexedDB, service worker and caches apart from
the desk embedded by another site, and from the editor opened at the desk's origin itself. A
scene's local copy therefore exists only in the browser and under the host site it was made in,
which is why the host keeps the authoritative state. The first visit under a host site loads the
page and its workers from the network; later visits come from the service worker of that
partition. Note that `localhost` and `127.0.0.1` are different sites: a host at one embedding a
desk at the other is a cross-site frame, as in production.

### Development

`npm run dev` serves the editor at `http://localhost:5173/` and the desk at
`http://localhost:5173/desk.html` (also `/desk`), with the headers of `DESK_EMBED_COEP` and
`DESK_EMBED_ORIGINS` on the page and on every script, style and worker it loads (requests to the
proxied `/api`, `/dav`, `/otlp`, `/mcp` and `/sync` are left alone). `npm run preview` does the same
for the build. In development the desk registers no service worker: it works online only.

## What the desk does

### Starting

`desk.html` loads its own entry (`apps/web/src/embed/main.tsx`), not the editor's. It never asks
a server for its configuration (`/api/config`) and starts none of what the editor starts from
it: no telemetry, no server RPC, no live sync, no server WebDAV, no server probe, no launch queue
or file handlers. It keeps everything in the browser's IndexedDB, and neither reads nor writes the
editor's preferences (`3d-editor:prefs:v1`): its own are the defaults with storage in the
browser, no sync and no telemetry, for the page's life. Where the browser blocks storage it keeps
the scene in memory (the host's state is the copy that counts) and nothing fails. It registers
the service worker itself, starts its staging worker with the page, and posts `hello` at the
page's `load` event. After the page has loaded it sends nothing to any server, and its own files
come from the service worker's cache (on the first visit under a host site the service worker
fetches them once, in the background, as it installs).

Inside the frame the desk is the editor's Director workspace, focused: the viewport looking
through the shot cameras, the shot list and inspector with each shot's issues, the sequence strip,
the timeline and playback, the staging tools and the Asset Browser with the built-in models, under
a compact header: the scene's name, where it was opened from and whether the host has its latest
state, the brief's changes with **Update shots**, **Send to …** (the host's name), **Done** and
**Close**, and an export's progress with **Cancel**. It has no top-bar menus, workspaces, project
list, presence, share or update button, Console, Diagnostics, UV editor, Dope Sheet or Properties
editor; the viewport's menus grey out what it hides (Import…). The desk ignores their keys:
Ctrl/Cmd+S and Ctrl/Cmd+O do nothing at all (not the browser's Save Page or Open File either), and
the others keep what the browser does with them (F3 finds in the page). Which panels are open, and
their sizes, it keeps under its own keys of the browser's storage (`3d-editor:desk:panel:*`,
`3d-editor:desk:size:*`), never the editor's. When the scene opens the desk looks through the first
shot's camera.

### Projects per host and scene

Each scene a host opens is a project of this browser, under a local id made from the host's origin
(the `connect`'s `event.origin`) and the scene id: `desk-` followed by the first 32 hex digits of
the SHA-256 of the origin and the id joined by a line feed. Two hosts never share a project, and
neither do two scenes of one host. The project lives in IndexedDB as the editor's projects do (the
document in the database `3d-editor-project-<id>`, an entry in the local project list), within the
storage partition of the host's site. Where the desk's storage is the editor's own (the sample, or
a host on the same site as the desk) its projects show in the editor's project list too.

### The desk state

`state.data` is opaque to the host, at most 64 MiB. The desk writes a container of its own there
(version 1, `apps/web/src/embed/state.ts`):

| Bytes   | Content                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------- |
| 0–7     | the magic `3DDESK\r\n`                                                                                |
| 8       | the container version, `1`                                                                            |
| 9       | the payload's compression: `0` none, `1` gzip                                                         |
| 10–11   | `0`                                                                                                   |
| 12–15   | the header's length in bytes (unsigned 32-bit, little-endian)                                         |
| header  | UTF-8 JSON: `sceneId`, `lineage`, `shots`, `savedAt`, `deskVersion`, `updateBytes`                    |
| payload | the scene's Yjs document (`Y.encodeStateAsUpdate`), gzipped where the browser has `CompressionStream` |

The header reads without unpacking the payload, so another scene's state is recognized at once.
`lineage` names the staging the document comes from: a random id written into the document when
the desk stages a brief from scratch, and kept by every copy and state made from it.

A state the desk does not read is not applied: another `format` or `version`, data that is not
this container or is cut short, another scene's state, a payload that does not unpack or is no
document, or a document with no staging of the scene. The desk then opens as without a state (its
local copy, else the brief), tells the person why, and sends `error` `state_unreadable` without an
`id`, before `opened`.

The desk sends `state` after `opened`, 2 s after the last edit (at most one every 5 s while edits
go on), on **Done**, before **Close** when edits have not been sent, and at once in answer to
`save` (with its `id`). After Done or Close nothing goes on its own: edits made then (an undo
behind the closed panel) wait until the person goes back to the desk. The desk's header bar says
whether the host has the latest one ("Sent to rideo 12 s ago", "Changes not sent to rideo yet");
when the host stores it is the host's matter. A state that would be over 64 MiB is not sent:
the desk answers with `error` `out_of_memory` (with the `save`'s `id` when it answers one), tells
the person, and keeps the scene in the browser; the next edit tries again. A state that cannot be
written for another reason is answered the same way with `export_failed`
([Readings](#readings-of-the-contract)).

### Opening a scene

`open` follows the merge rule (`restorePlan` in `state.ts`):

| The host's state               | The local copy           | The desk                                                                               | `source` |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------- | -------- |
| readable, the copy's `lineage` | a staging of the scene   | merges the state into the copy: one Yjs history, so edits made on either side are kept | `state`  |
| readable, another `lineage`    | none, or another staging | replaces the copy with the state                                                       | `state`  |
| none, or one it does not read  | a staging of the scene   | opens the copy                                                                         | `local`  |
| none, or one it does not read  | none                     | stages the brief                                                                       | `brief`  |

Staging runs core's `stageBrief` in a module worker (`apps/web/src/embed/stage.worker.ts`) on a
copy of the document and applies the result as one change that undo does not track (the staging
is where the scene starts); the page stays responsive and shows the work. Then come `opened` and a
first `state`, so the host's copy is current from the start. A brief that validates but cannot be
staged is answered with `error` `invalid_scene` without an `id`; it does not count as the
connection's `open`, and the host may send another. **Close** while the scene opens cancels the
open: `close` goes at once and nothing after it (no `opened`, no `state`); the desk lets go of the
scene and takes a later `open`, as it does after a Close before any `open`.

### A later brief: changes and Update shots

When the scene opens from a state or the local copy, the desk compares the brief with the one the
scene was staged from (core's `briefChanges`) and sends the differences in `opened.changes`: shots
added, removed, retimed and recast, cast members added and removed. It never changes the person's
staging by itself: a banner lists the changes with **Update shots**, which brings the staging up to
the brief (core's `updateFromBrief`, in the worker: new shots staged, dropped ones removed, changed
ones changed, hand edits of the others kept) as **one undo step** (Ctrl+Z takes it back, and the
banner with it: the desk compares the brief with the scene again once edits pause), and **Not
now**, which hides the banner. A read-only open shows the changes without the button. How a
brief becomes a scene, and what an update keeps, is in
[director-desk.md](director-desk.md#staging-from-a-brief).

### Send and export

An `export` from the host and the person's **Send to …** run the same export, in the browser, with
the [browser export engine](video-export.md#browser-export) on a snapshot of the scene: preset
`reference` (draft quality, the clay look) at the brief's width, height and frame rate, one engine
export per shot in brief order.

- **Shots**: the brief's shots, those the `export` names or else all (an empty list names none:
  all), in brief order whatever order the host named them in. A shot of the brief that is not
  staged yet (the brief added it, and the person has not pressed Update shots) is left out and
  named in an `error` `export_failed`. An id that is no shot of the brief is answered with
  `bad_message`, and nothing is exported. A shot the brief dropped is never exported.
- **Modes**: `motion` renders the beauty pass in the clay look, `pose` the pose pass, `camera` the
  depth pass; the `export`'s `modes` (each once; an empty list asks for the open's), else the
  open's `options.modes`, else `["camera"]`. **Send** renders the one mode the header's **Follow**
  menu shows: the host's `options.modes` in its order (the menu shows when there are two or more),
  preselected with `options.defaultMode`, else the first.
- **Stills** (`still`, default true; Send always): the beauty image of each shot's first frame.
- **Files**: `<shotId>.<mode>.mp4` and `<shotId>.still.png`, named with the host's shot ids and
  transferred with the `result`; the desk keeps no copy, and each shot's engine files in the
  Origin Private File System are deleted as soon as their bytes are in the result. Every clip of a
  shot must have exactly the frames the engine planned for it at the brief's rate (the shot's
  frames resampled from the scene's rate, counted before anything renders), else the shot is left
  out (`export_failed`, naming the clip).
- **Progress**: `prepare`, then `render` (frames rendered and encoded of all the export's frames,
  with the shot being rendered), `encode` (files read out for the result) and `finish`, at most
  one message every 100 ms; the last message of each phase always goes (the last frames rendered,
  `encode` N of N, `finish`), and all of them before the `result`.
- **Failures**: a shot that fails (out of memory, an encoder that stops) is left out and named in
  an `error` `export_failed` after the `result`, with the export's `id` and the cause in its
  message (`sht_a: out of memory: …`); the other shots come back. When no shot comes back the
  export ends with one `error` instead of a `result`: `out_of_memory` when every shot ran out of
  memory, `export_unavailable` when the browser could encode none, else `export_failed`.
- **Memory**: the result is handed over at once, its files' bytes in this tab, so before rendering
  the desk estimates its size from the encoder's bit rate, the frames, the modes and the stills.
  One over what the tab can hold for it (half of what a render may use: a quarter of the device's
  memory, at most 2 GB) is refused at once with `out_of_memory`, the estimate and the limit in the
  message: export fewer shots or modes at a time, or ask for a smaller size.
- **Result**: `fps`, `width` and `height` are the brief's. Each `ShotResult` has the shot's frames
  at the brief's rate (as the clips have them), the files of the modes asked for, the staged
  camera (its lens rounded to whole millimetres in 8–800, its named move), the blocking line, who
  moves where, whether the camera shows the planned layout, and the desk's checks of the shot.
- **Size**: a brief over 3840 × 2160 (wider than 3840 or higher than 2160 pixels, a portrait scene
  too) is answered with `export_unavailable` at once (the engine renders at most that; staging and
  editing work at any size); the desk says so when it opens such a scene, and **Send** is off with
  the reason. A browser that cannot encode H.264 at the brief's size and rate is answered with
  `export_unavailable` too.
- **Screen**: while it exports, the desk keeps the screen on where its frame may
  ([the iframe](#the-iframe): `screen-wake-lock`).
- **One at a time**: an `export` or Send while one runs, or while Update shots runs, is answered
  with `busy`. `cancel` with the export's `id`, or **Cancel** in the desk, ends it with `error`
  `cancelled`.

A host refuses a clip of another length than the brief's `max(1, round(durationSec × fps))`
frames. A shot has another length when the person made it longer or shorter in the desk, or when
the brief retimed it (or changed its frame rate) since it was staged and Update shots has not
brought it up to the brief. Its `ShotResult` carries the issue `brief_length` (severity `error`)
saying which: for a shot the brief retimed it points to Update shots (in a read-only open, to
opening the scene for editing), for one changed in the desk to setting its length back. **Send**
first lists such shots in those two groups, offers **Update shots** for the brief's, and asks
before sending. The host's `result-ack` is shown to the person: its message, and each shot it
refused with the reason.

### Done and Close

**Done** sends a last `state`, then `close` with `reason` `"done"`. **Close** sends `close` with
`reason` `"cancel"`, after a `state` when edits have not been sent, so the host's newest state is
always the scene as the person left it. Either cancels a running export: its `error` `cancelled`
goes first (the desk waits up to 2 s for the export to end), then the `state` and `close`. The
desk then says that it is closed and waits for the host to remove the frame. After `close` nothing
goes on its own (no `state`, no `progress`); an `export` is answered with `not_open`, and `save`
still with the scene's state. **Back to the desk** returns to the scene (nothing is sent, and
edits, those made while it was closed too, send states as before).

### Read-only

`options.readOnly: true` opens the scene to look at, play and export: every operator that changes
the scene is refused in the operator registry's own check, so no key, button or panel can run one,
and nothing writes the scene past it: a model file dropped on the viewport is refused before it is
read, a value dragged in a field (the viewport's sidebar) is not written while it moves, and the
menus grey out what is refused, with the reason. The header says **Read-only**, and Update shots is
not offered. Send, Done and Close work as usual.

### Offline

`ready.capabilities.offline` is `true`: once loaded, the desk stages, edits, exports and keeps its
copy without a network, and talks to nobody but its host. The page loads offline once the service
worker has it: the web app's service worker (`sw.js`, scope `/`) precaches `desk.html` and every
file it loads, the desk registers it itself, and it serves `/desk.html` and `/desk` (with any query)
from its cache, never the editor's `index.html`. A new version of the app waits until every page it
serves is closed and takes over at the next load, so a session in a host is never reloaded under
the person. Without the service worker (the first visit under a host site, development, a browser
that refuses one) the desk works while the network does.

### Opened on its own: the sample

Opened directly (not in a frame), `desk.html` says what it is, links to the full editor and offers
**Try a sample scene**: the desk then runs with the page as its host on the contract's example
brief (a girl and her puppy with a kite in a meadow; the modes camera, motion and pose). Send keeps
the files on the page as download links; Done or Close reloads the page. It needs no host and no
server, so it is a quick check of a deployment, offline too.

## Limits and timings

From the contract: a brief has at most 200 shots, 16 cast members and 64 elements, each shot at
most 600 s; a state at most 64 MiB. From the desk: an export at most 3840 × 2160 (3840 pixels
wide, 2160 high), with a result the tab can hold at once, and one at a time.

Measured in headless Chromium on a 4-core machine with 15 GB of memory and software WebGL, the
desk served by the production server and embedded by a cross-origin isolated host on another site
(three runs each; the example brief is the contract's: 2 shots, 5.5 s, 1280 × 720 at 24 fps; the
long brief has 60 shots of 2–4 s, 172.5 s in all):

| What                                                                            | Time or size                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Desk page: navigation to `hello`                                                | 0.37–0.47 s                                     |
| `connect` to `ready`                                                            | 41–72 ms                                        |
| Host page start to `ready`                                                      | 0.46–0.60 s                                     |
| Example brief: staging in the worker                                            | 0.28–0.32 s (`open` to `opened` 0.52–0.56 s)    |
| Long brief: staging in the worker                                               | 2.8–3.6 s (`open` to `opened` 3.8–4.6 s)        |
| Long brief: opened from the host's state in a browser without a copy            | 2.0–2.1 s                                       |
| Example export: camera and pose with stills (132 frames, 6 files, about 960 KB) | 26–34 s (29 s and 44 s in end-to-end test runs) |
| State of the example brief                                                      | about 118 KB                                    |
| State of the long brief                                                         | about 1.5 MB                                    |

Staging takes longer the more shots a brief has, and an export the more frames, modes and pixels
it renders; both show their progress, and the page stays responsive. An export renders on as many
workers as the tab's memory holds (at most 8;
[memory in the browser](video-export.md#memory-in-the-browser)), so a shorter brief, fewer modes
or a smaller size is faster. A host should wait for `opened` and `result` without a time limit of
its own, and offer the person a way out (the desk's own Close, or `cancel` for an export).

## Browser support

The desk is tested in Chromium, at desktop and phone sizes. In the frame it needs ES modules and
module workers, IndexedDB (without it the scene lives in memory) and WebGL 2 for the viewport. To
export it needs a secure context, WebCodecs' `VideoEncoder` with an H.264 encoder that takes the
brief's size and frame rate, and the Origin Private File System (without it the files stay in
memory). `ready.capabilities.export` says what the browser can do for 1280 × 720 at 24 fps, since
`ready` comes before the brief, with the reason in words when it cannot; each export checks again
at the brief's size and rate. With `CompressionStream` the state is gzipped; a browser without it
writes the state uncompressed and cannot read a gzipped one (`state_unreadable`).

## Readings of the contract

Where the contract leaves room, the desk takes the most robust reading:

- **A brief larger than the export engine renders.** Briefs may be up to 4096 pixels a side; the
  engine renders at most 3840 × 2160, per axis (3840 wide, 2160 high, a portrait scene too). The
  desk stages and edits any size, says so when it opens such a brief, and answers an export of it
  at once with `export_unavailable`, its message giving the limit, rather than scaling the clips.
- **A state too large to send.** No code names it: the desk sends `out_of_memory` (with the
  `save`'s `id` when it answers one) and keeps the scene in the browser. **A state that cannot be
  written** for another reason (the browser refuses to compress or encode it) is answered with
  `export_failed` the same way: no code names a failed write either.
- **A result too large to hand over.** The contract bounds no result, but the desk hands one over
  at once: an export whose result is estimated over what the tab can hold is refused before it
  renders, with `out_of_memory`.
- **An `open` that does not validate.** `open` has no `id`, so "`bad_message` when it had an `id`"
  would leave the host without an answer: the desk answers an `open` whose brief does not validate
  with `invalid_scene`, and one whose envelope (`state`, `options`) does not with `bad_message`,
  both without an `id`. Neither counts as the connection's `open`, and neither does one whose
  brief cannot be staged (`invalid_scene`).
- **The shots of an export.** "The brief" is the brief of this connection's `open`. A shot of it
  that is not staged yet is one the desk could not render: left out and named in `export_failed`.
  An id that is no shot of the brief is a bad request (`bad_message`, nothing exported). Results
  come in brief order whatever order `export.shots` names them in.
- **`frames` of a shot.** The desk reports the frames its clips have: the shot's frames resampled
  from the scene's rate to the brief's (`round(frames × fps ÷ scene fps)`, as the engine renders
  them), so a brief whose frame rate changed since staging still exports. Where they differ from
  the brief's frames it adds the issue `brief_length` (an error) saying whose change it is, and
  asks before Send; it does not stretch or cut the clip to the brief's length.
- **Errors of shots left out** follow the `result`, each with the export's `id` and the code
  `export_failed` whatever made the shot fail (the cause is in the message); an export of which no
  shot comes back ends with one `error` and no `result`, its code naming the cause
  (`out_of_memory`, `export_unavailable`, else `export_failed`).
- **The progress phases.** The engine encodes while it renders, so `render` counts frames rendered
  and encoded, and `encode` counts the files read out for the result.
- **`ready` before the brief.** `capabilities.export` is checked for 1280 × 720 at 24 fps (when the
  browser's encoder check takes longer than 1.5 s, whether WebCodecs exists decides, so `ready`
  still comes within 2 s), and every export checks again at the brief's size. `export.modes` lists
  the three modes the desk renders, not the host's options, which come later.
- **`offline`** is always `true`: it describes the desk once loaded. Whether the page itself loads
  without a network depends on its service worker having cached it in that browser and host site.
- **`unsupported_version`** answers, on its port, a `connect` of a version the desk does not speak;
  the desk then closes that port and keeps waiting for a `connect` it can take.
- **A `cancel` of an id that is not the running export** is ignored (and logged).
- **`save` before `open`**, and after a Close that came before any scene opened, is answered with
  `not_open`; after Done or Close of an open scene the desk still answers `save`.
- **Close while the scene opens** cancels the open: nothing follows `close`, and a later `open` is
  taken (one sent before the cancelled open let go of its scene waits for it).
- **Requests before `ready`** wait until `ready` is out, then are handled in order.
- **Lists.** The contract bounds no list: `export.shots: []` names no shot (every shot of the brief,
  as when it is missing), `export.modes: []` asks for the open's, and a repeated mode counts once,
  in `export.modes` and `options.modes` alike.
- **Options**: an empty or missing `hostName` is "the host"; `modes` keeps the host's order without
  repeats (an empty list is the default, `["camera"]`); a `defaultMode` not among `modes` becomes
  the first of them. The Follow menu lists `modes` in that order, and Send renders its mode.
- **Wake lock.** The desk asks for one while it exports only where the frame's permissions policy
  allows `screen-wake-lock`, so a host that does not allow it sees no policy violation.

## Testing a host

- **Schemas.** Keep a copy of the [fixtures](#fixtures) and check the host's schemas against them:
  every valid message parses, every file under `invalid/` fails.
- **The real desk.** Build and start a 3D-Editor server (`npm run build`, then `npm start`; or the
  Docker image), point the host's desk URL at `http://127.0.0.1:8080/desk.html`, and serve the host
  from `http://localhost:<port>` (cross-origin isolated if the host is in production), so the frame
  is cross-site as it will be. Opened on its own, the same `desk.html` runs the
  [sample](#opened-on-its-own-the-sample) with no host at all.
- **The fake host.** `e2e/fixtures/desk-host/index.html` is a complete host of the protocol in one
  page with no dependencies: it embeds `?desk=<url>`, answers `hello` with a `connect` and a
  `MessageChannel`, records every message (binary data, a result's files too, in the fixtures'
  `$bytes` notation) and keeps the last state and the last result's files; `window.host` drives
  it (`open`, `send`, `mount`, `connectFromSibling`, `postToDesk`, `messages`, `state`, `file`). A
  host's own end-to-end test can start from it.
- **The end-to-end test.** `e2e/tests/desk-embed.spec.ts` serves the fake host with COOP
  `same-origin` and COEP `require-corp` from another site than the desk and goes through the
  protocol: the handshake, `ready`, `open` of the example brief, states, an export of camera and
  pose with stills (each clip checked: the index first, one `avc1` track, BT.709 limited range,
  exactly the shot's frames, a key frame first; each still an RGB PNG), `result-ack`, `save` and
  Done, with nothing going to the network after the page has loaded; reopening from the host's state
  and from the local copy, and with a changed brief and Update shots; what the desk ignores or
  refuses; Send of a shot made longer; Follow and Send of one mode, the viewport's keys only over
  the viewport, a portrait brief over the export's size, and the wake lock with and without
  `screen-wake-lock`; read-only; offline; a phone's 390 × 844; and the page on its own. Every
  message the desk sends is checked against the schemas. Run it with
  `cd e2e && npx playwright test tests/desk-embed.spec.ts --trace off` after `npm run build`.

A host should check, besides its own logic, that it:

- accepts `hello` only from the frame's window and the desk's origin, and gives up after 15 s;
- stores `state` as it comes and gives it back unchanged in the next `open` (a state of another
  scene is answered with `state_unreadable` and the brief staged anew);
- shows `opened.changes` or leaves them to the desk, and takes `state` messages at any time;
- matches a `result` and the `error`s that follow it by `id`, takes files only of the shots in
  `result.shots`, and answers with `result-ack`;
- ignores message types it does not know, as the desk does.
