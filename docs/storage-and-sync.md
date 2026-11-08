# Storage, offline and multi-device sync

## Where projects are saved

| Configuration                                 | Saved to                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| No WebDAV configured (default)                | The browser (IndexedDB).                                                                                                                        |
| Server started with `WEBDAV_URL`              | WebDAV, through the server's `/dav` proxy (credentials stay on the server, no CORS needed). The server also persists the live sync rooms there. |
| WebDAV URL entered in _Preferences → Storage_ | WebDAV, accessed directly from the browser (the WebDAV server must send CORS headers).                                                          |

Projects are **always** cached in IndexedDB as well, which is what makes the app work offline.
When WebDAV is configured the local copy is merged with the WebDAV copy on open, a moment
after each change, every 20 s (to pick up other devices) and when the tab is hidden.

Saving is a CRDT merge (`ProjectFileStore.syncDocument`): read the stored state, merge it into
the local document, and write the merged state back with `If-Match` (retrying on HTTP 412).
Every save and every refresh merges the content it reads: none skips the stored document because
its ETag equals the one of the last sync, as ETags made from the modification time repeat for
writes within one tick of the server's clock. A device that was offline for a long time merges its
edits like any other save.

Layout on WebDAV (and in the server's `DATA_DIR` for `SYNC_PERSISTENCE=disk`):

```
<base>/projects/<project-id>/project.json     name, timestamps, stats, thumbnail
<base>/projects/<project-id>/document.ybin    Yjs document state
```

### Several writers saving at once

Browsers, editor servers sharing one storage, and MCP agents through a server can save the same
project at the same moment. Every writer:

- **Uses an ETag only with its own content.** A read takes the ETag the GET response carries. When
  it carries none (servers that send none, browsers when CORS does not expose the header), the read
  takes the ETag PROPFIND reports both right before and right after the GET; when they differ,
  another write came between and it reads again, 3 times at most, then goes on without an ETag (and
  writes without `If-Match`). Reads that do not use the ETag (`project.json`, a server loading a
  project, reading a write back) are one GET. A write reports an ETag only when the PUT response carries
  one.
- **Writes with `If-Match` the ETag read** (`If-None-Match: *` for a new project). On HTTP 412 it
  reads, merges and writes again, 5 attempts at most; then the save fails and is retried later.
- **On WebDAV, checks and reads back**, as servers handle `If-Match` differently (table below):
  right before writing it checks that the document's ETag is still the one it read (HEAD, or
  PROPFIND when GET carries none) and sends the write next, with no request between (a new
  project's folders are created before the check, which finds no document; when PROPFIND finds
  one but reports no ETag, as nginx's does, a GET tells whether another writer created it
  meanwhile); after writing it reads the write back (one GET, or just the ETag when the PUT
  response carried one), and when another write replaced it, merges that one and writes again if
  it lacks the writer's changes.
- **Reads storage again later.** A server room that wrote to WebDAV reads the document again in
  the next refresh (every 60 s), before it is evicted (idle for `ROOM_IDLE_TTL_SECONDS`) and when
  the server stops, and writes its changes again if they are missing; it is not evicted while that
  read fails. Browsers sync every 20 s while the project is open.
- **Does not bring back deleted projects.** When such a read finds no document because another
  server deleted the project, a room with no unsaved changes writes nothing; a change made in the
  room afterwards (by an editor still connected to it) saves the project again.

`SYNC_PERSISTENCE=disk` checks `If-Match` and writes in one step under a lock, gives each version a
later modification time than the one it replaces (the ETag is `"<size>-<mtime>"`), and reads a
file's content and ETag from one open file. The server must be the only writer of its `DATA_DIR`.

What WebDAV servers do, from their sources (the integration tests run webdav-server as it is and
with ETags and checks added, like Nextcloud):

| Server                                          | ETag with GET                                   | ETag with PUT | `If-Match` and `If-None-Match` on PUT                                      |
| ----------------------------------------------- | ----------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| Nextcloud (Sabre/DAV)                           | yes                                             | yes           | checked (`Server::checkPreconditions`) before the PUT handler runs         |
| Apache `mod_dav_fs` 2.4                         | yes; weak (`W/`) for 1 s after a change         | no            | checked (`ap_meets_conditions`, strong comparison) before the body is read |
| nginx `dav_methods PUT`                         | `"<mtime in s>-<size>"` (hex)                   | no            | ignored (nginx checks `If-Match` only for responses with status 200)       |
| rclone `serve webdav` (golang.org/x/net/webdav) | mtime in ns and size, or a hash (`--etag-hash`) | yes           | ignored (a TODO in `handlePut`)                                            |
| webdav-server 2.6 (tests)                       | no; PROPFIND: md5 of the mtime in ms            | no            | ignored (it checks only the WebDAV `If` header)                            |

What this guarantees:

- Disk storage: no save replaces a change it has not merged.
- Nextcloud: its file locking (on by default) holds a shared lock on an existing file from before
  the `If-Match` check and needs an exclusive one to replace the file, so of two overlapping saves
  at least one fails with HTTP 423 (Locked), and both do when each upload ends while the other
  request still holds its shared lock. A failed save is retried later; nothing is lost. A file that
  does not exist yet has no lock: two writers creating the same project at once can replace one
  another.
- Apache checks `If-Match` before it reads the body, so two saves that read the same version can
  both pass the check, and the later write replaces the earlier one. nginx, rclone and
  webdav-server let a save replace any write that landed after the writer's ETag check, and one its
  check missed because the ETag stayed the same (nginx: same size within the same second;
  webdav-server: within the same millisecond).
- On WebDAV, the writer whose change was replaced writes it again at its next read of the
  document: its read-back right after the save, its server's next refresh, eviction or shutdown, or
  its browser's next sync. The change is lost from storage only when that writer stops (a server
  stopping or killed, its room evicted, a browser tab closed) after its last read, and the other
  save lands after that read.
- Apache sends a weak ETag for a second after a change, and a weak ETag never matches `If-Match`:
  a save within that second gets HTTP 412 five times and fails; a server room retries it 3 s later
  (with the default `PERSIST_DEBOUNCE_MS`), a browser at its next sync.

What it costs: a save that writes sends these requests for the document, then one PUT of
`project.json` (a server room also reads `project.json` first, with one GET):

| Server                                                                 | Requests for the document                                       | Document downloads |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------ |
| ETag with GET and PUT (Nextcloud, rclone)                              | GET, HEAD (check), PUT, HEAD (confirm)                          | 1                  |
| ETag with GET only (Apache, nginx)                                     | GET, HEAD (check), PUT, GET (read-back)                         | 2                  |
| no ETag with GET or PUT (webdav-server, or `ETag` not exposed by CORS) | PROPFIND, GET, PROPFIND, PROPFIND (check), PUT, GET (read-back) | 2                  |

A new project adds one MKCOL per folder of `<base>/projects/<id>` (3 with the default base path
`/3d-editor`) before the check. A client that has not yet seen whether GET responses carry an
ETag sends a PROPFIND before the first GET whose ETag it needs. A save or refresh that has nothing
to write takes only the read. A server room that wrote to WebDAV downloads the document once more in
its next refresh (rooms with connected editors refresh every 60 s anyway). Listing projects reads
each `project.json` with one GET.

A server room saving one change to the tests' webdav-server on the same machine (base path
`/3d-editor`; medians of 7 saves of a 0.48 MB document and of 3 saves of a 134 MB one, ranges over
3 and 2 runs) took 45–49 ms and 1.56–1.68 s without ETags (8 requests, the document downloaded
twice), and 44–47 ms and 1.17–1.21 s with ETags in GET and PUT responses (6 requests). A refresh
that finds nothing new took 39–45 ms and 0.87–0.89 s, and 34–37 ms and 0.85–0.91 s.

A WebDAV server used directly from the browser must allow (CORS) the `PROPFIND`, `PUT`, `MKCOL`
and `DELETE` methods and the `Authorization`, `Content-Type`, `Depth`, `If-Match` and
`If-None-Match` request headers, and should expose `ETag`: without it, every save takes the
requests of a server that sends no ETag (above).

## Real-time sync

Every open project connects a WebSocket to `/sync/<project-id>` on the editor server. The
protocol is Yjs sync + awareness (presence) plus JSON RPC and control frames
(`packages/core/src/sync/protocol.ts`). Tabs of the same browser additionally talk over
`BroadcastChannel`, which also works offline.

- Changes appear on every device that has the project open, typically within one network round
  trip. Peers are shown as avatars; click one to follow that user's viewport.
- A device that was offline merges automatically when it reconnects.
- Share a project with _File → Copy Share Link_; opening the link on another device joins the same
  live session (and, with WebDAV, the project also shows up in that device's project list).
- Project names are unique on a server, ignoring letter case: MCP agents and the REST API cannot
  create or rename a project to a name another project has. Projects created in a browser (also
  offline) and renamed in the editor's Scene tab are synced as they are, so a duplicate name can
  still appear; tools then refer to such a project by its id.

`SYNC_PERSISTENCE` controls what the server does with live rooms: `memory` (rooms live while
devices are connected plus `ROOM_IDLE_TTL_SECONDS`; browsers keep their own copies; lost when the
server stops), `disk` (`DATA_DIR`, recommended for Docker so MCP-created projects survive restarts),
or `webdav`. Without it the server uses `webdav` when `WEBDAV_URL` is set, `disk` when `DATA_DIR`
is set (the Docker image sets it), and `memory` otherwise; the active mode is logged at startup
and reported by the MCP `get_project` tool.

## Offline / PWA

The service worker precaches the whole application, so after the first visit the editor starts
without a network connection. It can be installed as an app (desktop and mobile) and registers
file handlers for `.glb`, `.gltf`, `.obj`, `.stl` and `.ply`. When a new version is deployed the
top bar offers to reload.
