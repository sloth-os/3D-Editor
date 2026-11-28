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

Contents: [the contract](#the-contract) · [library units](#library-units) ·
[hosting the desk](#hosting-the-desk) · [what the desk does](#what-the-desk-does) ·
[limits and timings](#limits-and-timings) · [browser support](#browser-support) ·
[readings of the contract](#readings-of-the-contract) · [testing a host](#testing-a-host)

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
| `open`       | `scene`: SceneBrief; `state`: DeskState or null; `options`: OpenOptions (optional); `units`: OpenUnit[] (optional, [library units](#library-units))                | Opens the scene: restores `state` (merged with its local copy of the same scene, if any), else its local copy, else stages the brief from scratch. Replies `opened`. Sent once per connection; a second `open` is answered with `error` `busy` |
| `export`     | `id`; `shots`: shot ids (optional, default all); `modes`: Mode[] (optional, default `options.modes`, else `["camera"]`); `still`: boolean (optional, default true) | Renders reference clips (and stills) in the browser and replies `progress`… then `result`, or `error`. One export at a time (`busy`)                                                                                                           |
| `cancel`     | `id` (of an export)                                                                                                                                                | Stops that export; it ends with `error` `cancelled`                                                                                                                                                                                            |
| `save`       | `id`                                                                                                                                                               | Replies `state` with the same `id`, now                                                                                                                                                                                                        |
| `result-ack` | `id` (of a `result`); `ok`: boolean; `message`: string (optional); `shots`: `[{shotId, ok, error?}]` (optional)                                                    | Shows the person what the host did with the result                                                                                                                                                                                             |
| `unit-ack`   | `id` (of a `unit-publish`); `ok`: boolean; `ref`, `version`, `linked` (required when `ok`); `code`, `message` (optional)                                           | Tells the person what the host did with a unit they saved to its library, and adopts it when `linked` ([library units](#publishing-and-linking))                                                                                               |

### Messages from the desk

| Type           | Fields                                                                                                                                                                                                                                                                         | When                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`        | `deskVersion`: string; `protocol`: 1; `capabilities.export`: `available` (boolean), `reason` (string or null), `container` `"mp4"`, `videoCodec` `"avc1"`, `modes` (Mode[]); `capabilities.offline`: boolean; `capabilities.units` (optional, [library units](#library-units)) | Right after `connect`. `export.available` is false where the browser cannot encode H.264 (no WebCodecs, not a secure context): `reason` says why                                                                       |
| `opened`       | `sceneId`; `source`: `"state"`, `"local"` or `"brief"`; `changes`: BriefChanges or null                                                                                                                                                                                        | After `open`. `changes` lists how the brief differs from the scene the state was staged from (the desk offers to update its shots; it never drops the person's staging silently)                                       |
| `state`        | `id` (only when answering `save`); `sceneId`; `state`: DeskState; `shots`: number; `units`: StateUnit[] (only after an open with units)                                                                                                                                        | After `opened`, after edits (at most every 5 s, 2 s after the last change), when the person presses Done, and in answer to `save`. The host stores `state` as it is and hands it back in the next `open`               |
| `progress`     | `id` (of the export); `phase`: `"prepare"`, `"render"`, `"encode"` or `"finish"`; `done`: integer; `total`: integer; `shotId`: string (optional)                                                                                                                               | During an export                                                                                                                                                                                                       |
| `result`       | `id` (the export's id, or `desk-` and a number when the person pressed **Send** in the desk); `sceneId`; `fps`; `width`; `height`; `shots`: ShotResult[]; `files`: ResultFile[]                                                                                                | When an export finished. The ArrayBuffers of `files` are transferred                                                                                                                                                   |
| `error`        | `id` (optional); `code`: ErrorCode; `message`: string                                                                                                                                                                                                                          | A request failed, or something the host should show                                                                                                                                                                    |
| `close`        | `reason`: `"done"` or `"cancel"`                                                                                                                                                                                                                                               | The person pressed **Done** (after a final `state`) or **Close** in the desk                                                                                                                                           |
| `unit-publish` | `id`; `kind`; `name`; `description`, `newVersionOf`, `from` (optional); `unit`; `sha256`; `thumbnail`; `meta`                                                                                                                                                                  | The person saved the set, a prop or an actor to the host's library (only after an open whose `options.units.publish` is true). The ArrayBuffers of `unit` and `thumbnail` are transferred; the host answers `unit-ack` |

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
    unit?: UnitPin;          // a library set for the place (library units)
  };
  cast: {                    // ≤ 16
    id: Id;
    name: string;            // 1–120
    description: string;     // ≤ 4000: who they are (words such as "a golden retriever", "a girl of 8")
    kind: string | null;     // ≤ 60, a hint such as "person", "child", "dog", "horse"; null: from the words
    heightM: number | null;  // 0.1–4
    unit?: UnitPin;          // a library figure for this cast member (library units)
  }[];
  elements: {                // ≤ 64: the location and the props
    id: Id;
    name: string;            // 1–120
    description: string;     // ≤ 2000
    kind: 'location' | 'prop' | 'other';
    unit?: UnitPin;          // a library prop (library units; ignored on a 'location')
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
  units?: UnitsOption;       // library units for this open (library units)
};

type BriefChanges = {
  added: Id[];               // shots in the brief, not staged
  removed: Id[];             // shots staged, no longer in the brief
  retimed: Id[];             // shots whose frame count changed (a new duration or a new frame rate)
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
  the desk reports `error` `state_unreadable` (without an `id`) and opens as without a state, from
  its local copy of the scene where it has one, else by staging the brief (the contract says the
  brief is staged: [Readings](#readings-of-the-contract)).
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

- `apps/web/test/fixtures/desk-protocol/`: the 31 valid messages (`hello.json`, `connect.json`,
  `open.json`, `open-with-state.json`, `ready.json`, `ready-no-export.json`, `opened.json`,
  `opened-changed.json`, `state.json`, `state-reply.json`, `progress.json`, `result.json`,
  `result-desk.json`, `export.json`, `export-defaults.json`, `cancel.json`, `save.json`,
  `result-ack.json`, `result-ack-partial.json`, `error.json`, `error-no-id.json`, `close.json`,
  and those of [library units](#library-units): `ready-units.json`, `open-units.json`,
  `open-units-figure-hints.json`, `unit-publish-set.json`, `unit-publish-figure-new-version.json`,
  `unit-ack-linked.json`, `unit-ack-unlinked.json`, `unit-ack-refused.json`, `state-units.json`)
  and under `invalid/` the 16 that must not validate (those of library units:
  `open-units-bad-pin.json` with a SHA-256 of 63 digits, `unit-publish-two-from.json`,
  `unit-publish-bad-sha.json`, `unit-publish-thumbnail-too-large.json`,
  `unit-ack-ok-without-ref.json`, `state-units-bad-staged.json`).
  `apps/web/test/desk-protocol.test.ts` checks the desk's schemas (`apps/web/src/embed/protocol.ts`)
  against them. The messages' unit files are short texts, not units (a desk refuses them as
  `unreadable`), with their real SHA-256 values; the pins of `open-units.json` (on the set, a cast
  member and a prop) and its `units` agree. Under `units/`, `unit-file-prop.json` is a real unit
  file in `{"$bytes": …}` (the example brief's red kite, written by core), laid out as
  [The unit file](#the-unit-file) says.
- `packages/core/test/fixtures/desk-embed/`: copies of the briefs (`open.json`,
  `open-with-state.json`, `opened-changed.json`, `open-units.json`, `open-units-figure-hints.json`
  and five invalid ones) that core's staging tests read, and of `units/unit-file-prop.json`, which
  core's unit tests read; `desk-protocol.test.ts` checks that they are the same files. Next to them
  is core's own `staged-golden.json`: how the desk staged each of those briefs without pins, and
  five more (an interior, water, animals, a rider on a mount, a kite in flight), before library
  units; `desk-brief-golden.test.ts` holds staging to it.

## Library units

A host with a library of 3D pieces lets the person reuse them across scenes: the set of a place, a
prop, an actor's figure. Each is a _unit_, a file the desk writes (format `3d-editor.desk-unit`,
version 1) and the host keeps, one file per version of a library item. The brief _pins_ a unit to
its set, a cast member or an element; the host sends the pinned units' files with `open`; the desk
stages the scene with them and says in every `state` what it staged; and the person can save the
set, a prop or an actor to the host's library (`unit-publish`), which the host may link to the
scene. All of it is additive to version 1 of the protocol: a desk with units says so in
`ready.capabilities.units`, and nothing else of them is sent unless the host's `open` then carries
`options.units`, so desks and hosts from before library units keep working with each other and
with the new ones.

### Negotiation

| The desk                  | The host                            | What happens                                                                                                                              |
| ------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| from before library units | with units                          | Its `ready` has no `capabilities.units`, so the host sends no pins, no `options.units` and no `units`: the scene opens as before          |
| with units                | from before library units           | The host ignores `capabilities.units` and its `open` has no `options.units`: the desk sends no `units` in `state` and no `unit-publish`   |
| with units                | with units, units off for this open | The host leaves out `options.units` (it, or the person, never uses the library): as with a host from before units                         |
| with units                | with units, `options.units` given   | The brief's pins and `open.units` count, every `state` carries `units`, and with `publish` true the person can save to the host's library |

The desk reads `options.units` leniently: an absent or malformed one, or one of another `version`,
turns units off for that open; it never fails the open. It logs one it does not read, with the
shape it reads (`{version: 1, publish: boolean}`), and an absent one when the brief has pins or
`open.units` comes (a host from before units sends neither). A host reads `capabilities.units`
leniently too: kinds it does not know are dropped, and a malformed one or one without version 1 in
`versions` means no units; it never fails the `ready`. With units off the desk takes no
`open.units` and sends no `units` in `state` and no `unit-publish`; a pin in the brief is staged
from the words.

Units off is for a host, or a person, that never uses the library. A host that uses it keeps
`options.units` on while it is offline, and sends no file it cannot get: those pins wait
(`pending`, `missing`) and nothing the scene holds is taken out. A scene that holds units, opened
with units off, is what a host from before units would see: the desk reads the brief as pinning
nothing, so its banner offers to take the units out (back to the brief's words) with Update shots.

### Fields and messages

```ts
type UnitPin = {             // one unit file
  ref: Id;                   // the host's library item
  version: number;           // integer 1–1 000 000 000, given by the host: one per file of the item
  sha256: string;            // 64 lowercase hex digits: the SHA-256 of the file's exact bytes
};

// SceneBrief's pins: optional, no default (a brief without pins has the hash and record it had)
//   set.unit?: UnitPin          a 'set' unit for the scene's place
//   cast[].unit?: UnitPin       a 'figure' unit for the cast member
//   elements[].unit?: UnitPin   a 'prop' unit; on an element of kind 'location' ignored with a warning

type UnitsCapability = {     // ready.capabilities.units: a desk with units always sends it
  versions: number[];        // the versions of options.units it reads: [1]
  kinds: ('set' | 'prop' | 'figure')[];
  maxBytes: number;          // the largest unit file it takes: 33554432 (32 MiB)
  publish: boolean;          // true: it can send unit-publish
};

type UnitsOption = {         // OpenOptions.units: the host turns units on for this open
  version: 1;
  publish: boolean;          // false: the desk offers no Save to library
};

type OpenUnit = {            // open.units[]: ≤ 81 entries, ≤ 48 MiB in all, the data transferred
  ref: Id;
  version: number;
  sha256: string;            // of unit.data
  unit: { format: string; version: number; data: ArrayBuffer };   // format 1–64 characters; data 1 B–32 MiB
};

type UnitPublish = {         // desk → host: a unit the person saves to the host's library
  type: 'unit-publish';
  id: string;                // 'pub-1', 'pub-2', …
  kind: 'set' | 'prop' | 'figure';
  name: string;              // 1–120; with newVersionOf the item's name, which the host keeps
  description?: string;      // ≤ 2000; with newVersionOf the new version's note
  newVersionOf?: { ref: Id; version: number };   // the item's version it is based on: save its next version
  from?: { castId: Id | null; elementId: Id | null; set: boolean };   // the brief slot: exactly one of the three
  unit: { format: '3d-editor.desk-unit'; version: 1; data: ArrayBuffer };   // 1 B–32 MiB, transferred
  sha256: string;            // of unit.data
  thumbnail: { mime: 'image/png'; data: ArrayBuffer } | null;   // ≤ 64 KiB, ≤ 256 px a side, transferred
  meta: {                    // ≤ 16 KiB as JSON (UTF-8)
    dimensionsM: [number, number, number];   // its size in metres along x, y and z, each ≥ 0 (a set's: its stage and height)
    objects: number;         // integer ≥ 0
    triangles: number;       // integer ≥ 0
    actor: { kind: string; heightM: number } | null;   // a figure's kind (1–60) and height (> 0, ≤ 8)
    credits: { name: string; author: string | null; license: string }[];   // ≤ 32; 1–120, ≤ 200, 1–64
    deskVersion: string;     // 1–64
    digest: string;          // the SHA-256 of the unit's unpacked body: informational
  };
};

type UnitAck = {             // host → desk, with the unit-publish's id
  type: 'unit-ack';
  id: string;
  ok: boolean;
  ref?: Id;                  // required when ok: the item it saved
  version?: number;          // required when ok: the version it saved
  linked?: boolean;          // required when ok: it linked the unit to the slot of `from`
  code?: string;             // when not ok: a PublishRefusal (any 1–40 characters are read)
  message?: string;          // ≤ 2000, shown to the person
};

type PublishRefusal = 'refused' | 'conflict' | 'too_large' | 'invalid' | 'unavailable' | 'failed';

type StateUnit = {           // state.units[]: one row per brief slot whose record has a pin, ≤ 128
  slot: string;              // 'set', 'cast:<castId>' or 'el:<elementId>'; rows in plain string order
  ref: Id;                   // the pin the slot's record holds
  version: number;
  sha256: string;
  staged: 'unit' | 'pending' | 'refused';
  local: boolean;            // staged 'unit', but the slot no longer holds a linked instance
  why?: string;              // pending or refused: the reason (≤ 40)
};
```

### The unit file

A unit file (the `data` of an `open.units` entry or of `unit-publish.unit`) is a container the desk
writes with core (`packages/core/src/desk/units/format.ts`):

| Bytes  | Content                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–7    | the magic `3DUNIT\r\n`                                                                                                                          |
| 8      | the container version: `1`                                                                                                                      |
| 9      | the body's compression: `0` none, `1` gzip                                                                                                      |
| 10–11  | both `0`                                                                                                                                        |
| 12–15  | the header's length in bytes (unsigned 32-bit, little-endian), at most 64 KiB                                                                   |
| header | UTF-8 JSON holding at least `format` (`3d-editor.desk-unit`), `version` (`1`), `kind` (`set`, `prop` or `figure`) and `name` (1–120 characters) |
| body   | the unit itself, gzipped when byte 9 says so                                                                                                    |

This layout is stable for format `3d-editor.desk-unit` version 1, and it is all of a unit file a
host may read: the prefix and the header, which reads without the body, to check a file before it
keeps it. The header's other fields (the body's digest and size, counts, bounds, credits, facts of
its kind) and the body are the desk's own; what a host stores of a unit comes in
`unit-publish.meta`. The fixture `units/unit-file-prop.json` is such a file ([Fixtures](#fixtures)).

### The host's part

- It sends pins, `options.units` and `open.units` only after a `ready` whose `capabilities.units`
  lists version 1, and pins only the kinds it lists.
- Pins: `set.unit` for the scene's place (a `set` unit), `cast[].unit` for a figure and
  `elements[].unit` for a prop. A pin on an element of kind `location` is ignored with a staging
  warning: the place's set goes in `set.unit`. With a figure pin it sends the figure's kind and
  height (its `meta.actor` when it was published: the desk's height, an animal's withers) as the
  cast member's `kind` and `heightM` (`heightM` only within 0.1–4 m), as
  `open-units-figure-hints.json` does, so that the desk plans the actor as the figure even when the
  file does not come: the actor standing in takes that height as it is, and the figure fits it when
  its file comes.
- `open.units`: the file of every pin of the brief it can get, in slot order (the set, the cast in
  brief order, then the elements), each `ref@version` once, stopping before 48 MiB in all. It may
  leave out a pin whose `ref@version` the scene's stored state lists in its `units` with `staged`
  `unit`: the desk needs no file for a slot that already holds that version. It may leave out the
  file of a slot whose row there says `local` true, whatever the brief pins on it: the desk places
  no unit in a slot made local. A file it cannot get (offline, a failed fetch, bytes that do not
  hash to the pin) is left out: the desk stages that slot from the words (`pending`, `missing`), and
  a later open that brings the file offers Update shots.
- The files travel as transferred `ArrayBuffer`s in `open`: the host's page gets them from its own
  server, and the desk is never given a URL or a token to fetch them.
- It keeps each `state`'s `units` with the state: per slot, whether the scene holds the pinned
  version. Rows it cannot read (malformed, more than 128) count as unknown.

### The desk's part

- It parses each `open.units` entry on its own: an entry that does not validate (its fields, data
  of 1 byte to 32 MiB as an `ArrayBuffer` or a view of one) is left out and logged, entries after
  the 81st are left out, and the open goes on; the pin of an entry left out counts as not sent.
- An entry counts for a pin when its `ref`, `version` and `sha256` are the pin's, its bytes hash to
  that SHA-256, its format and version are ones the desk reads, and the kind in its header fits the
  pin's slot (the set takes a `set` unit, a cast member a `figure`, an element a `prop`). Otherwise
  the slot is staged from the words and recorded `pending` or `refused`
  ([when a unit is not used](#when-a-unit-is-not-used)). An entry that matches no pin is ignored.
- Staging places a set unit as the scene's place (its ground and its pieces), a prop unit as the
  element's prop and a figure unit as the cast member's actor. Each is an _instance_ of
  `ref@version` that the person can edit in the desk; **Make local** cuts a slot's link to its unit:
  it keeps the pieces, and the slot stays local whatever later briefs pin (a new version, another
  item or none; no Update shots places a unit there), its row keeping the `ref@version` it was made
  local from with `staged` `unit` and `local` true.
- After the open it keeps in memory the files an **Update shots** could place (those of slots that
  do not hold their pinned version yet, within one staging's budget), and only a file whose SHA-256
  is its pin's: another one is let go, and its pin waits as `mismatch`. It keeps them while the
  scene is open, also once an Update shots has placed them (Ctrl+Z may take that back, and Update
  shots places them again), and each Update shots gets copies of those the scene wants then. None
  stay after: the desk has no cache of units, so a later open needs the files again unless the
  scene already holds their versions.
- A later brief that moves a pin (a new version, another item, or none) is a change the desk offers
  to bring in with **Update shots**, as one undo step that keeps the parts the person edited by
  hand; it never moves a pin by itself. `opened.changes` lists shots and cast only, so it is `null`
  for a change of pins alone, while the desk's banner offers Update shots.
- After an open with units every `state` carries `units`: one row per brief slot whose record has a
  pin, sorted by `slot` in plain string order (`cast:…`, `el:…`, `set`), at most 128.
- The person sees it in the desk's **Library** tab, a bottom tab only after an open with units:
  each unit the scene holds or the brief pins with its version and status, Make local, and Save to
  library ([director-desk.md](director-desk.md#the-library-tab)).

### Publishing and linking

With `options.units.publish` true the person can save the set, a prop or an actor to the host's
library: **Save to library…** in the desk sends `unit-publish` with the unit file, its SHA-256, a
PNG thumbnail (or `null`) and `meta`. A prop's or a figure's `meta.dimensionsM` is the box its
meshes fill; a set's is the set itself, as the words staged it or as the person edited it: its
stage's width and depth, whatever stands beyond the stage's edge, and its height from the lowest to
the highest of its own pieces (its ground, walls, landmarks and dressing, beyond the edge too),
without the world beyond the set that its ground reaches out to the horizon (a 12 × 10 m room with
3.2 m walls is `[12, 10, 3.2]`; a 4 m tower standing beyond its edge makes it `[12, 10, 4]`).
`from` names the brief slot the unit came from (exactly one of `castId`, `elementId` and `set`),
and `newVersionOf` the library version it is based on when the slot holds an instance of
an item: the host saves the unit as that item's next version, keeps the item's name and takes
`description` as the new version's note (`name` is the item's name as the desk knows it, from the
version the slot holds; the desk offers no other). Without it the unit is a new item, named `name`,
with `description`. A read-only open may publish too. The host answers `unit-ack` with the same
`id`: `ok` true with the `ref` and `version` it saved and `linked`, or `ok` false with a `code` and
a `message`:

| `code`        | The host                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| `refused`     | does not let this person or this open save to its library                           |
| `conflict`    | has a newer version of the item than `newVersionOf` (someone saved one since)       |
| `too_large`   | does not take a file, a thumbnail or a `meta` this large                            |
| `invalid`     | finds the file, the thumbnail or a field invalid (a SHA-256 that is not the file's) |
| `unavailable` | cannot save now (offline, its storage unavailable): the person may try again later  |
| `failed`      | failed for another reason                                                           |

**The link rule.** The host saves the unit, and links it to the entity `from` names (its project's
set, cast member or element, whose pin moves to the new `ref@version`) only when (a) the open is
editable (not read-only), (b) the person may edit the project, and (c) the entity has no pin or
pins the same `ref` (the unit is a new version of its own item). Otherwise it answers `ok` true and
`linked` false, with the reason in `message`, and the entity keeps its pin.

**What `linked` means for the desk.** With `linked` true the host's project pins the slot to
`ref@version`, and its next brief says so. The desk adopts the unit at once: the slot's pieces
become an instance of `ref@version` (their ids unchanged, and not an undo step: it records what the
host did, and Ctrl+Z does not go back past it, as the undo history before it is cleared) and the
slot's record takes the pin with `staged` `unit`, so the next brief brings no change for the slot
and needs no file. With `linked` false, or `ok` false, the desk changes nothing in the scene; a
read-only open never adopts. The desk changes the scene one step at a time: Update shots is off
while the scene adopts a unit, and an ack that comes while Update shots runs is adopted once the
update has ended, in the scene the update left. A unit whose object is no longer in the scene (for
a set: none of its pieces is), as when that update replaced it, is not adopted, and the person is
told why; the link comes with the next open's brief, whose Update shots puts the unit in.

The desk waits for the `unit-ack` 120 s plus 10 s per MiB of the file (counted up: 440 s for
32 MiB), then tells the person that the host did not say whether it saved the unit; an ack that
comes later is not applied. A `unit-ack` that does not validate but has a valid `id` is answered
with `error` `bad_message` with that `id`, as for any message, and fails the publish waiting on it
at once. Only the desk's own ends (no answer in time, an answer that does not validate, the desk
closed first) tell the person that it is not known whether the host saved the unit; an `ok` false
tells them it was not saved, with the host's `message`, whatever its `code`.

**A link the desk did not take in.** An editable open keeps in the scene each save it sends from a
slot, one record per `unit-publish` (the file's SHA-256 and the objects it was made from; at most 8
per slot, a ninth letting go of the slot's oldest), not as an undo step, so that it travels with the
local copy and the desk state. The desk lets go of a save when the host answers that very save
`ok` false, whatever its `code`, or the message cannot be sent; an earlier save of the same file
stays. A save whose end the desk does not know (its ack came after the wait, was not valid, or the
desk closed first) stays, and so does one the host saved without linking it, so that a link the
person makes later in the host is taken in the same way. A unit the host saved and linked without
the desk adopting it comes with a later brief that pins that very file (`sha256` the one sent) in
that slot, and the open sends the file as for any pin. Update shots then matches the pin against
every save kept for the slot and makes the scene's own objects (those of the latest save of that
file that are still in the scene) the instance of `ref@version`, as the ack would have (one undo
step with the rest of the update), and adds no copy of them. When those objects are no longer in the
scene (a set's every piece; another unit's root, or the slot holds another instance), it puts the
unit in as for any pin, with a warning. Either way the slot's other saves go, as they do when the
scene adopts a unit of the slot on a linked ack, or when the slot holds the pinned version already;
a brief that pins none of the slot's saves leaves them kept.

### When a unit is not used

A slot whose unit the desk does not use is staged from the brief's words, with a warning in the
desk, and its record says why. The record's state is the row's `staged` and `why` in `state.units`:

| The desk's reason  | Record and `state.units` | When                                                                                             | Tried again                         | A host shows                                                       |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| none               | `unit`                   | The slot holds an instance of the pinned version                                                 | —                                   | up to date, or a newer version of its pin waiting for Update shots |
| none, `local` true | `unit`                   | The person made the slot local: its pieces stay, unlinked, whatever later briefs pin             | —                                   | made local                                                         |
| `missing`          | `pending`                | No entry for the pin in `open.units`, or one left out                                            | at the next open                    | waiting for the unit                                               |
| `mismatch`         | `pending`                | An entry for the pin's `ref` and `version` with another SHA-256, or bytes that do not hash to it | at the next open                    | waiting for the unit                                               |
| `unavailable`      | `pending`                | Sent and matching, not usable this time: the budget spent, reading failed, the scene in its way  | at the next open                    | waiting for the unit                                               |
| `unreadable`       | `refused`                | Not a unit file the desk reads, or a damaged one                                                 | when the brief pins another version | cannot use the unit, with the reason                               |
| `too_new`          | `refused`                | A unit of a newer format version than the desk reads                                             | when the brief pins another version | cannot use the unit, with the reason                               |
| `too_large`        | `refused`                | Larger than the desk takes for one unit                                                          | when the brief pins another version | cannot use the unit, with the reason                               |
| `wrong_kind`       | `refused`                | Its kind does not fit the slot (a `prop` unit on the set)                                        | when the brief pins another version | cannot use the unit, with the reason                               |
| `figure_kind`      | `refused`                | A figure of a kind the desk does not build, or not the kind of the actor staged                  | when the brief pins another version | cannot use the unit, with the reason                               |
| `figure_rig`       | `refused`                | A figure whose bones are not its kind's, or not the height of the actor staged (±5 mm)           | when the brief pins another version | cannot use the unit, with the reason                               |
| `over_budget`      | `refused`                | A unit a single instance of which can never fit one staging's budget (160 MiB unpacked)          | when the brief pins another version | cannot use the unit, with the reason                               |
| `set_ground`       | `refused`                | A set whose ground is more than 1 cm off height 0                                                | when the brief pins another version | cannot use the unit, with the reason                               |
| —                  | no `units` in `state`    | An open without units, a desk from before units, rows the host cannot read                       | —                                   | unknown                                                            |

A `pending` slot is tried again at every open: when one brings its file, the desk offers Update
shots. So it does, once, for a pin whose file the host sent but the desk cannot use (a `refused`
reason above), so that the refusal reaches the record: Update shots keeps what the slot holds, warns
why and records the pin `refused`, as `state.units` then says. A `refused` slot is tried again only
when the brief pins another version or item, so a unit the desk cannot use never offers Update
shots again and again.

`unavailable` means the host sent matching bytes but the desk could not use them this time, for a
reason that may pass: the open's unit budget (48 MiB of files and 160 MiB unpacked, counted in slot
order: the set, the cast, the elements) was already spent by earlier slots, the staging worker
failed while reading the unit (out of memory, a worker restart), or the scene was in the unit's way
as it went in (an object of the person's own at the id the unit's root takes; the warning names
it), in which case the slot stays as it was or staged from the words and the other slots go in. The
next open tries again. A version pinned in several slots counts as one file and one decoded body,
and the scene's copy of it in each slot that places it, so a slot past the budget is `unavailable`
although the same version went into the slots before it: the next open places it there, as those
slots hold theirs already.
`over_budget` is only for a unit a single instance of which can never fit the staging's budget: its
body, and the scene's copy of it with each byte array written out at every reference (a file may
share one array among many records, and inserting copies it for each), which the desk counts again
once the unit is decoded. `figure_kind` and `figure_rig` are also how an update answers a figure
that does not fit the actor staged for its member (another kind, or a height more than 5 mm off):
the actor stays as it is, and staging the brief in a new project uses the figure.

### The three hashes

- **The file's SHA-256**, 64 lowercase hex digits of the exact bytes of a unit file, is the only one
  that travels: in every pin, each `open.units` entry, `unit-publish.sha256` and each `state.units`
  row. The host keys unit files by it and checks what the desk publishes against it; the desk
  checks every file the host sends against it.
- **The unit's digest**, the SHA-256 of its unpacked body, is in the unit's header and in
  `unit-publish.meta.digest`. Two files of one body packed differently have different SHA-256 values
  and the same digest. It is informational: nothing in the protocol is keyed or checked by it.
- **A host's own digests** of its library items stay inside the host (for a unit, rideo's version
  digest is the file's SHA-256).

### Unit limits and timings

| What                                | Limit                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A unit file                         | 1 byte to 32 MiB (`capabilities.units.maxBytes`: 33554432)                                                                           |
| `open.units`                        | at most 81 entries (a set, 16 cast members, 64 elements), at most 48 MiB in all                                                      |
| The units one staging places        | 48 MiB of files and 160 MiB unpacked (a version's file and body once, its copy in each slot), in slot order; past that `unavailable` |
| A version                           | an integer 1–1 000 000 000                                                                                                           |
| A thumbnail                         | a PNG of at most 64 KiB and at most 256 px a side                                                                                    |
| `meta`                              | at most 16 KiB as JSON in UTF-8, at most 32 credits                                                                                  |
| A saved unit's name and description | 1–120 characters, at most 2000                                                                                                       |
| `state.units`                       | at most 128 rows                                                                                                                     |
| `unit-ack`                          | `code` 1–40 characters, `message` at most 2000                                                                                       |
| The desk's wait for `unit-ack`      | 120 s plus 10 s per MiB of the file, counted up (440 s for 32 MiB)                                                                   |

### Server calls

The units go from the host's server to its page and from the page to the desk in `open`, in one
hop, and the desk calls no server. No host server calls the 3D-Editor's server either: its only
part is serving the desk's static files, the best case for one server serving many people. A call
from the host's server was weighed for this and left out, by measurement: staging a brief with
core on a server takes 3.4 s and 91 MB of heap for a 60-shot brief, and 24 s and 444 MB at the
brief's maximum (200 shots, 16 cast members), to save the person 1.7–2.5 s at the first open; and
reference clips render only in the browser, so a state a server updates gives no new reference
until someone opens the desk and sends again. The candidate for later is `update-units`: the
server moves a unit pin to a new version inside a stored desk state, in about 0.3 s per 60-shot
state and 0.9 s per 200-shot state, with a cache of unit files by SHA-256, a token scope of its
own and a pool of processes. It pays off when many stored scenes must take a new version without
being opened, and for agents that work without a browser.

## Hosting the desk

### Its own origin

Serve the desk from an origin of its own, such as `https://desk.example.com`. The 3D-Editor server
does that already: it serves the editor at `/` and the desk at `/desk.html` (also at `/desk`), and
never the editor's `index.html` for the desk's paths. So does any static host serving
`apps/web/dist` (`npm run build`) with the headers below. Several hosts can embed the same desk
origin; each host's scenes stay apart ([projects](#projects-per-host-and-scene)). The server can
also live under a path of the desk's site, the desk then at `https://desk.example.com/3d/desk.html`
([serving under a subpath](subpath.md)): the paths below are then under that prefix, and the
origin stays the desk's own.

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
- The desk's service worker answers `/desk.html` and `/desk` with the headers the server sends
  now whenever the server answers within 4 s ([offline](#offline)), so a change of
  `DESK_EMBED_ORIGINS` or `DESK_EMBED_COEP` reaches every browser that is online at its next load of
  the desk (a host taken off the list can no longer frame it there), with no new build. The service
  worker keeps those headers for its offline copy of the page: offline, the desk loads with the
  headers it was last served with. A worker script it serves without a COEP gets `require-corp`,
  which every page accepts for its workers, so a desk whose COEP was turned on after its files were
  cached still starts its workers. Browsers keep the built files a year (`immutable`), each with the
  headers it came with, so set `DESK_EMBED_COEP` before the first deployment where you can.

### Configuration

The server reads two environment variables (also in the [README](../README.md)); the web app's Vite
dev and preview servers read the same two and send the same headers.

| Variable             | Default        | Meaning                                                                                                                                                                                                                                |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESK_EMBED_ORIGINS` | `*`            | Comma-separated origins that may embed the desk, its `frame-ancestors`: `*` (any site), origins such as `https://studio.example.com`, `https://*.example.com` or `http://localhost:5173`, `'self'` (the desk's own origin) or `'none'` |
| `DESK_EMBED_COEP`    | `require-corp` | `Cross-Origin-Embedder-Policy` of the desk page and the built files: `require-corp`, `credentialless` or `off` (none sent)                                                                                                             |

An origin is `http` or `https`, a host name (its first label may be `*`) or an IPv4 address, and an
optional port (1 to 65535 other than the ports browsers refuse, or `*`), with no path, query or user
name. The ports browsers refuse are Fetch's bad ports, such as 1, 25 or 6000: browsers load nothing
from them, so no page that frames the desk has one (`BAD_PORTS` in `apps/server/src/desk-embed.ts`;
4190 and 6679 are on Fetch's list, but Chromium still loads them, so they are taken). The server
writes each as the browser writes origins: trailing slashes dropped, lowercased, an international
name in punycode, a default port (`:443`, `:80`) dropped. No IPv6 address: Content Security Policy
has no way to name one, and browsers drop such a source from `frame-ancestors`, so give that host a
name. `*` admits every site (other entries are then redundant), and `'none'` cannot be combined with
origins. The server checks both variables when it starts and stops for a value it cannot use, with
the reason, such as `Invalid configuration: DESK_EMBED_ORIGINS: 'https://a.example/x' has a path, …`
or `Invalid configuration: DESK_EMBED_COEP: …`. `credentialless` serves cross-origin isolated hosts
as well as `require-corp`; `off` is for a proxy in front of the server that sets the header itself
(a cross-origin isolated host cannot embed a desk without one).

### Static hosts

Any static host works if it serves `apps/web/dist` with the [headers](#headers) for `desk.html`
and `assets/`, revalidates the rest (`sw.js` above all), and never sends `X-Frame-Options`. Hosts
then frame `/desk.html`, or `/desk` where the server maps it. The build's URLs are relative, so the
folder can sit under any path of the site; a static host answers deeper paths with 404 rather than
`index.html` ([static hosts](subpath.md#static-hosts)). With nginx:

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
  # the editor, sw.js and the rest; no index.html at deeper paths (its file URLs are relative)
  location / {
    add_header Cache-Control "no-cache" always;
    try_files $uri $uri/ =404;
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
`DESK_EMBED_ORIGINS` chosen by path as the server chooses them by file (`viteDeskRoute` in
`apps/server/src/desk-embed.ts`): the page's on the desk page, the built files' on the modules and
workers it loads (`/src/`, `/@vite/`, `/@fs/`, `/@id/`, `/node_modules/`), none on the editor's
pages, the proxied `/api`, `/dav`, `/otlp`, `/mcp` and `/sync`, or anything else. `npm run preview`
does the same for the build, the built files' headers on `/assets/` only, so never on `index.html`,
`sw.js` or the manifest, whoever asks for them. Both serve the editor at `/desk/` and
`/desk.html/`, as the server does. In development the desk registers no service worker: it works
online only.

## What the desk does

### Starting

`desk.html` loads its own entry (`apps/web/src/embed/main.tsx`), not the editor's. It never asks a
server for its configuration (`/api/config`) and starts none of what the editor starts from it: no
telemetry, no server RPC, no live sync, no server WebDAV, no server probe, no launch queue or file
handlers. It keeps everything in the browser's IndexedDB, and neither reads nor writes the editor's
preferences (`3d-editor:prefs:v1`): its own are the defaults with storage in the browser, no sync
and no telemetry, for the page's life. Where the browser blocks storage it keeps the scene in memory
(the host's state is the copy that counts) and nothing fails. Where storage works at first but fails
as a scene opens (its database does not open, does not answer within 10 s, or refuses a write) it
keeps that scene in memory too and says so: it reads the local copy where it can but writes nothing,
and opening never hangs on storage (a database that did not answer is not asked again for the copy,
so the open waits 10 s at most for it). It registers the service worker itself, starts
its staging worker with the page, and posts `hello` at the page's `load` event. After the page has
loaded it sends nothing to any server, and its own files come from the service worker's cache (on
the first visit under a host site the service worker fetches them once, in the background, as it
installs).

Inside the frame the desk is the editor's Director workspace, focused: the viewport looking
through the shot cameras, the shot list and inspector with each shot's issues, the sequence strip,
the timeline and playback, the staging tools and the Asset Browser with the built-in models, under
a compact header: the scene's name, where it was opened from and whether the host has its latest
state, the brief's changes with **Update shots**, **Follow** (the reference clip **Send** renders,
when the host takes more than one), **Send to …** (the host's name), **Done** and **Close**, and an
export's progress with **Cancel**. They keep one line at every width, Done and Close always in the
frame whatever the host's name (it may have 40 characters): where the header is narrow the scene's
name and the host's name in Send are cut short, and so are the notes on where the scene came from
and whether the host has its latest state, with the name, each in proportion to its length but never
to less than about its first word (or a fifth of the room the actions leave, where that is less),
their tooltips having them whole; on a phone the notes give way first, Follow has no label, Send
says just "Send" (the host's name in its tooltip) and Close is its icon. It has no top-bar menus,
workspaces, project list, presence, share or update button, Console, Diagnostics, UV editor, Dope
Sheet or Properties editor; the viewport's menus grey out what it hides (Import…). The desk ignores
their keys: Ctrl/Cmd+S and Ctrl/Cmd+O do nothing at all (not the browser's Save Page or Open File
either, also on a keyboard layout without Latin letters, where the browser takes the keys of S and O
for them), and the others keep what the browser does with them (F3 finds in the page). Which panels
are open, and their sizes, it keeps under its own keys of the browser's storage
(`3d-editor:desk:panel:*`, `3d-editor:desk:size:*`), never the editor's. When the scene opens the
desk looks through the first shot's camera.

### Projects per host and scene

Each scene a host opens is a project of this browser, under a local id made from the host's origin
(the `connect`'s `event.origin`) and the scene id: `desk-` followed by the first 32 hex digits of
the SHA-256 of the origin and the id joined by a line feed. Two hosts never share a project, and
neither do two scenes of one host. The project lives in IndexedDB as the editor's projects do (the
document in the database `3d-editor-project-<id>`, an entry in the local project list), within the
storage partition of the host's site. Where the desk's storage is the editor's own (the sample, or
a host on the same site as the desk) its projects show in the editor's project list too.

One desk of a browser has a scene open at a time: while a scene is open, its desk holds a Web Lock
(`navigator.locks`) named `3d-editor-desk:` followed by the scene's local id. A second desk opening
the same scene of the same host (another tab, window or frame under the same host site) waits for
it, saying "This scene is open in another tab or window of this browser. The desk opens it here as
soon as it is closed there.", and opens the scene once the first lets go of it: when that desk's
page goes away or opens another scene (after Done or Close a desk keeps its scene, as the person
may go back to it). It never clears the database under the first. A Close ends the wait: the
notice offers **Close** as the header does. Browsers without Web Locks (Safari before 15.4) do not
let desks wait for each other, so there a second desk on the scene can still replace the copy
under the first.

### The desk state

`state.data` is opaque to the host, at most 64 MiB. The desk writes a container of its own there
(version 1, or 2 when the scene holds [library units](#library-units);
`apps/web/src/embed/state.ts`):

| Bytes   | Content                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0–7     | the magic `3DDESK\r\n`                                                                                                                   |
| 8       | the container version: `1`, or `2` when the document holds instances of library units                                                    |
| 9       | the payload's compression: `0` none, `1` gzip                                                                                            |
| 10–11   | `0`                                                                                                                                      |
| 12–15   | the header's length in bytes (unsigned 32-bit, little-endian)                                                                            |
| header  | UTF-8 JSON of at most 64 KiB: `sceneId`, `lineage`, `shots`, `deskVersion`, `updateBytes`, in order (earlier desks also wrote `savedAt`) |
| payload | the scene's Yjs document (`Y.encodeStateAsUpdate`), gzipped where the browser has `CompressionStream`                                    |

Version 2 is version 1's layout, written exactly when the scene's document holds an instance of a
library unit (a set, prop or figure placed from a unit the host sent, or linked after the person
saved it to the host's library); a scene without one is written as version 1, so a state without
units reads in every desk. This desk reads both. A desk from before library units reads only
version 1: it answers a version-2 state with `error` `state_unreadable` and opens as without a
state (its local copy, else the brief), and sends no `state` on its own, so the host keeps the
state it stored unless the person edits the scene in that desk.

The header reads without unpacking the payload, so another scene's state is recognized at once.
`lineage` names the staging the document comes from: a random id written into the document when
the desk stages a brief from scratch, and kept by every copy and state made from it. A header
written with a `savedAt` (as earlier desks wrote it) still reads; the desk ignores keys it does
not know.

`updateBytes` is the document's length unpacked, at most 256 MiB. The desk refuses a header that
claims more than 256 MiB before it unpacks anything. It unpacks a gzipped payload 4 KiB at a time,
copies what each slice gives into one buffer of the size the header claims, and stops as soon as
the payload gives more than the header says. Every desk reads both payloads: where the browser has
no `DecompressionStream` it unpacks gzip with a script (fflate), checking its CRC-32 and length.
Unpacking a state takes the memory its header claims and what one slice unpacks to (at most about
4 MiB, and up to 8 MiB more for fflate's work), never the document twice.

An unchanged scene gives the same bytes. The header holds no time and keeps its keys in one order,
and the gzip header's time is 0 and its system byte 255. While the scene still holds what the
state the host gave held (a state that replaced the local copy, or was merged into a copy that had
nothing more), or what the last state the desk sent held, the desk sends exactly those bytes
again, whatever another browser's gzip would make of the document. A host that compares states by
their bytes (a digest) stores one copy of a scene that was only looked at.

A state the desk does not read is not applied: another `format` or `version`, data that is not
this container or is cut short, a header over 64 KiB or one claiming more than 256 MiB, another
scene's state, a payload that does not unpack, unpacks to more than its header says or is no
document, or a document with no staging of the scene or with another `lineage` than its header's.
The desk checks all of this before it chooses how to open, so a state it does not read never
replaces or clears the local copy. It opens as without a state (its local copy, else the brief),
tells the person why, and sends `error` `state_unreadable` without an `id`, before `opened`. It
then sends no `state` on its own: the host keeps the state it has until the person edits the
scene, presses **Done**, or the host sends `save` ([Readings](#readings-of-the-contract)).

The desk sends `state` after `opened`, 2 s after the last edit (at most one every 5 s while edits
go on; edits count from `opened` on, so one made while the first `state` is written goes in the
next), on **Done**, before **Close** when edits have not been sent, and at once in answer to
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
first `state`, so the host's copy is current from the start (`opened` alone after a state the desk
did not read). A brief that validates but cannot be staged is answered with `error` `invalid_scene`
without an `id`; it does not count as the connection's `open`, and the host may send another.
**Close** while the scene opens cancels the open, at any moment of it (while the host's state
unpacks, while the desk waits for another desk, while it stages; the work it shows offers
**Close**): `close` goes at once and nothing after it (no `opened`, no `state`), and the work stops
there: a staging under way is stopped in its worker and never applied, and the desk shows its
closed panel, not the work. An open cancelled before the local copy is read changes nothing of it;
one cancelled later writes nothing new into it (a copy the open was replacing, a staging of
another lineage or a copy with no staging of the scene, may be cleared already: the next open then
starts from the host's state or the brief). From the Close on, also while the cancelled open still
lets go of its scene, no scene is open: `save` and `export` are answered with `not_open`. The desk
lets go of the scene and takes a later `open`, as it does after a Close before any `open`.

The shot list shows the staging's checks at once (their issues), and once the scene is open,
whatever it opened from, the desk runs the full checks in the background (each shot's blocking
line and layout too), as it does again after **Update shots**. A check is of the scene as it was
when the check was asked for: an edit made while it runs shows it as out of date. The staging
worker does one thing at a time; the person's requests (an export's shot results, Update shots) go
ahead of a check still waiting, though a check already running ends first.

### A later brief: changes and Update shots

When the scene opens from a state or the local copy, the desk compares the brief with the one the
scene was staged from (core's `briefChanges`) and sends the differences in `opened.changes`: shots
added, removed, retimed and recast, cast members added and removed. These are the contract's lists
and nothing more, and `opened.changes` is `null` when none of them has an entry; what else differs
(the desk's own notes, such as the frame rate, the set or shots renumbered) only the desk's banner
lists, with Update shots as for the others. It never changes the person's
staging by itself: a banner lists the changes with **Update shots**, which brings the staging up to
the brief (core's `updateFromBrief`, in the worker: new shots staged, dropped ones removed, changed
ones changed, hand edits of the others kept) as **one undo step** (Ctrl+Z takes it back, and the
banner with it: the desk compares the brief with the scene again once edits pause; not once a unit
was linked since, see [publishing and linking](#publishing-and-linking)), and **Not now**, which
hides the banner. A read-only open shows the changes without the button. How a
brief becomes a scene, and what an update keeps, is in
[director-desk.md](director-desk.md#staging-from-a-brief).

What the staging and each Update shots warn of (core's `report.warnings`, such as the person's
objects that stay where a piece was built anew or taken out, what no longer follows a piece's
animation, notes edited in the desk that an update keeps over the brief's, or a library unit that
is not here or cannot be used) the desk shows the person: after the open's staging and after each
Update shots, its notice says how many warnings there are and lists each one under it (the list
scrolls past a few lines, below the header). A staging or an Update shots that warns of nothing
lists none, so the list of an earlier one goes with the notice it replaces. Ctrl+Z that takes an
Update shots back puts its notice away too, warnings and all, as they were of the update; a notice
something else gave since stays, and a redo brings the update back without them. The host is sent
nothing of them: the protocol has no message for them, and `opened` and `state` are as without.

### Send and export

An `export` from the host and the person's **Send to …** run the same export, in the browser, with
the [browser export engine](video-export.md#browser-export) on a snapshot of the scene: preset
`reference` (draft quality, the clay look) at the brief's width, height and frame rate, one engine
export per shot in brief order.

- **Shots**: the brief's shots, those the `export` names or else all (an empty list names none:
  all), in the order of the `open`'s brief, whatever order the host named them in and whatever
  order they were staged in (a brief that reorders its shots needs no Update shots for that). A
  shot of the brief that is not staged yet (the brief added it, and the person has not pressed
  Update shots) is left out and named in an `error` `export_failed`. An id that is no shot of the
  brief is answered with `bad_message`, and nothing is exported. A shot the brief dropped is never
  exported.
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
  one message every 100 ms, also when a busy page runs its timers late; the last message of each
  phase always goes, at once when the next phase starts (the last frames rendered, `encode` N of
  N, `finish`), and all of them before the `result`.
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
worker has it: the web app's service worker (the `sw.js` next to the page, built from
`apps/web/src/pwa/sw.ts`, its scope the app's base: `/`, or `/3d/` for an editor [served under a
subpath](subpath.md)) precaches `desk.html` and every file it loads, the desk registers it itself,
and it answers `desk.html` and `desk` in its scope (`/desk.html` and `/desk` at the root), with any
query, never with the editor's `index.html`. It answers with its precached copy of the page, the
version whose files it serves, and with the server's current [headers](#headers) when the server
answers within 4 s; offline, or when the server does not answer in time, with the headers the page
was last served with (a 5xx counts as no answer; a redirect or another error from the server is
passed on). `desk/` and `desk.html/` in its scope are the editor's, as on the server.

A new version of the app installs in the background and waits until every page the old one serves
is closed, then takes over at the next load, so a session in a host is never reloaded under the
person. The editor's **Update** makes a waiting version take over at once; while a desk page is
open in the same browser partition (the sample, or a host on the same site as the desk), the
version refuses and keeps waiting, so the files of a running desk never change under it, and it
answers the editor, which says "A director's desk is open in this browser; close it to update":
close the desk, then press Update again. Without the service worker (the first visit under a host
site, development, a browser that refuses one) the desk works while the network does.

Upgrading from a build without the desk: a browser that ran an earlier build of the editor keeps
that build's service worker until the new one takes over, and the old one answers `/desk.html` and
`/desk` with the editor, which it knew instead. This happens only in the editor's own partition:
the desk opened on its own, and a host on the same site as the desk, whose frame then gets the
editor without the desk's headers (a cross-origin isolated host refuses it and gives up waiting for
`hello`). To end it, press the editor's Update in that browser (also in the editor shown at
`/desk.html`, which is no desk) with no other page at a desk address open, or close all of the
editor's tabs and windows; then load the desk again. A host on another site never had the old
service worker in its partition.

### Opened on its own: the sample

Opened directly (not in a frame), `desk.html` says what it is, links to the full editor and offers
**Try a sample scene**: the desk then runs with the page as its host on the contract's example
brief (a girl and her puppy with a kite in a meadow; the modes camera, motion and pose). Send keeps
the files on the page as download links; Done or Close reloads the page. It needs no host and no
server, so it is a quick check of a deployment, offline too.

## Limits and timings

From the contract: a brief has at most 200 shots, 16 cast members and 64 elements, each shot at
most 600 s; a state at most 64 MiB. From the desk: an export at most 3840 × 2160 (3840 pixels
wide, 2160 high), with a result the tab can hold at once, and one at a time; a state's header at
most 64 KiB and its document at most 256 MiB unpacked; 10 s for the scene's storage to answer
before the desk keeps the scene in memory. Library units have their own
([unit limits and timings](#unit-limits-and-timings)).

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
writes the state uncompressed. Every desk reads both: a gzipped state with `DecompressionStream`,
or where there is none with a script (fflate). Web Locks keep one desk per scene in a browser;
without them desks do not wait for each other.

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
  come in the order of that brief whatever order `export.shots` names them in, also when the host
  reordered its shots since the scene was staged (before Update shots and after it).
- **`opened.changes`** holds the contract's five lists and nothing more, and is `null` when none of
  them has an entry: a brief that differs only in what they do not cover (the set, the props,
  shots renumbered or reworded) gives `null`, and the desk's own banner lists it and offers Update
  shots.
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
- **`save` before `open`**, and after a Close that came before any scene opened (one that cancelled
  an open too, also while that open still lets go of its scene), is answered with `not_open`, and
  the person is shown nothing about it; after Done or Close of an open scene the desk still
  answers `save`.
- **Close while the scene opens** cancels the open: nothing follows `close`, the open's work stops
  (a staging under way is not kept), and a later `open` is taken (one sent before the cancelled
  open let go of its scene waits for it).
- **A state the desk does not read** (another scene, format or version, or one that does not
  unpack or holds no staging of the scene). The contract has the brief staged; the desk opens its
  local copy of the scene where it has one (`source` `local`: work the host never got is not
  lost), else stages the brief (`source` `brief`), and sends `state_unreadable` without an `id`
  either way.
- **No first `state` after a state the desk does not read.** The contract has a first `state`
  follow `opened`; after a state it could not read the desk sends none until the person edits the
  scene, presses Done, or the host sends `save`, so that a browser that cannot read the host's
  state never replaces it just by opening the scene.
- **A scene open in another desk of the browser.** `opened` comes once that desk lets go of the
  scene (the desk shows why it waits, with Close), not as soon as the scene is staged; a Close
  ends the wait.
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
- **The unit file.** `units/unit-file-prop.json` is made by core: run
  `npx tsx packages/core/test/fixtures/desk-embed/units/generate.ts` from the repository's root,
  when the unit format or what staging makes of the example's kite changes, and it writes both
  copies. Staging draws the scene's ids at random, so each run writes other bytes;
  `packages/core/test/desk-unit-fixture.test.ts` checks that the copies are what the generator
  makes today but for those ids, the order they give a block's records and the header's `digest`.
- **The real desk.** Build and start a 3D-Editor server (`npm run build`, then `npm start`; or the
  Docker image), point the host's desk URL at `http://127.0.0.1:8080/desk.html`, and serve the host
  from `http://localhost:<port>` (cross-origin isolated if the host is in production), so the frame
  is cross-site as it will be. Opened on its own, the same `desk.html` runs the
  [sample](#opened-on-its-own-the-sample) with no host at all.
- **The fake host.** `e2e/fixtures/desk-host/index.html` is a complete host of the protocol in one
  page with no dependencies: it embeds `?desk=<url>`, answers `hello` with a `connect` and a
  `MessageChannel`, records every message (binary data, a result's files too, in the fixtures'
  `$bytes` notation) and keeps the last state and the last result's files. `window.host` drives
  it: `mount` and `unmount` the desk's frame (`deskOrigin` is its origin, `connected` whether the
  port is up), `open` a scene (with the last state, the open's `options`, and its library `units`:
  entries with `{"$bytes"}` data, or `"ref@version"` of a unit it saved), `send` any message,
  `connectFromSibling` and `postToDesk` (what a desk must refuse), and read `messages`,
  `windowMessages`, `state`, `file`, `fileNames` and `fileSizes`. With library units it saves each
  `unit-publish` in its own library, read with `library` (each `ref@version` and its SHA-256), and
  answers as `publishMode` says: `linked` (by the link rule: a read-only open is answered `linked`
  false, "the scene is read-only"), `linked-always` (linked even then, which the rule forbids: the
  desk's own guard is tested with it), `unlinked`, `refused:<code>`, or `never` (the test answers
  with `ackPublish`). A host's own end-to-end test can start from it.
- **The end-to-end test.** `e2e/tests/desk-embed.spec.ts` serves the fake host with COOP
  `same-origin` and COEP `require-corp` from another site than the desk and goes through the
  protocol: the handshake, `ready`, `open` of the example brief, states, an export of camera and
  pose with stills (each clip checked: the index first, one `avc1` track, BT.709 limited range,
  exactly the shot's frames, a key frame first; each still an RGB PNG), `result-ack`, `save` and
  Done, with nothing going to the network after the page has loaded; reopening from the host's state
  and from the local copy, and with a changed brief and Update shots; what the desk ignores or
  refuses; Close while a long brief stages (the staging stopped, nothing of it kept); Send of a
  shot made longer; Follow and Send of one mode, the viewport's keys only over the viewport, a
  portrait brief over the export's size, and the wake lock with and without `screen-wake-lock`;
  read-only; offline; a phone's 390 × 844, and 360 px with the longest host and scene names (Done
  and Close in the frame); and the page on its own. Every message the desk sends is checked against
  the schemas. Run it with
  `cd e2e && npx playwright test tests/desk-embed.spec.ts --trace off` after `npm run build`.
- **Library units.** `e2e/tests/desk-library.spec.ts` drives the same fake host with real unit
  files made by core in Node (`e2e/fixtures/desk-host/units.ts`): pins with their files staged as
  units (`state.units`, the Library tab, Make local and its undo); a pin whose file was not sent,
  placed by Update shots once a later open sends it; Save to library as a new item the host links
  (the scene adopts it) and then as a new version of it, each `unit-publish` checked (its SHA-256,
  a square thumbnail that shows the unit in colour); the Save dialog's keyboard (its focus, Tab
  inside it, no key of the editor acting behind it); a read-only open (saved, not linked, and a
  host that links it all the same); a host that refuses or answers late; a host from before units;
  and phones of 390 and 360 px. Run it the same way:
  `cd e2e && npx playwright test tests/desk-library.spec.ts --trace off` after `npm run build`.
- **Storage partitioning.** The desk's specs (`e2e/tests/desk-*.spec.ts`) run in the `desk`
  Playwright project, with Chromium's third-party storage partitioning on as browsers ship it
  (Playwright turns it off by default). `e2e/tests/desk-partition.spec.ts` checks that it is on (the
  framed desk sees none of its origin's first-party storage), that the desk registers its service
  worker in a cross-site host's partition and loads, stages and exports there offline, and that a
  change of `DESK_EMBED_ORIGINS` reaches a browser whose service worker holds the desk, online at
  once and offline after, and that a new version of the app waits while a desk page is open in the
  partition (the editor's Update says why) and takes over once the desk is closed. Run it the same
  way, after `npm run build`.

A host should check, besides its own logic, that it:

- accepts `hello` only from the frame's window and the desk's origin, and gives up after 15 s;
- stores `state` as it comes and gives it back unchanged in the next `open` (a state of another
  scene is answered with `state_unreadable`, and the desk opens its own copy of the scene, else
  stages the brief; a scene that did not change comes back as the same bytes);
- shows `opened.changes` or leaves them to the desk, and takes `state` messages at any time;
- matches a `result` and the `error`s that follow it by `id`, takes files only of the shots in
  `result.shots`, and answers with `result-ack`;
- ignores message types it does not know, as the desk does;
- with [library units](#library-units): sends pins, `options.units` and `open.units` only to a desk
  whose `ready` announced `capabilities.units`, reads `capabilities.units` and `state.units`
  leniently, and answers every `unit-publish` with a `unit-ack` (`ref`, `version` and `linked`
  when `ok`) within the desk's wait.
