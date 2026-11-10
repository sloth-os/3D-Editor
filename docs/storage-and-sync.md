# Storage, offline and multi-device sync

## Where projects are saved

| Configuration                                 | Saved to                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| No WebDAV configured (default)                | The browser (IndexedDB).                                                                                                                        |
| Server started with `WEBDAV_URL`              | WebDAV, through the server's `/dav` proxy (credentials stay on the server, no CORS needed). The server also persists the live sync rooms there. |
| WebDAV URL entered in _Preferences → Storage_ | WebDAV, accessed directly from the browser (the WebDAV server must send CORS headers).                                                          |

Projects are **always** cached in IndexedDB as well, which is what makes the app work offline.
When WebDAV is configured the local copy is merged with the WebDAV copy on open, a moment
after each change, every 20 s (to pick up other devices) and when the tab is hidden. A project
deleted from WebDAV (on another device, or in another tab) is not stored there again unless the
tab's copy changed since the browser's last sync (see [Deleted projects](#deleted-projects)).
Save (Ctrl+S) syncs at once and says what happened: `Saved to WebDAV`, `Saved in this browser`
(no WebDAV), stored there again after a deletion, deleted right after this save, offline (saved in
this browser; WebDAV syncs when the browser is back online), or `Not saved to WebDAV` with the
reason.

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
  project's folders are created before the check, which finds no document; when the check cannot
  tell, because nginx's PROPFIND reports no ETag or the request failed, a GET tells whether another
  writer created the document meanwhile); after writing it reads the write back (one GET, or just
  the ETag when the PUT response carried one), and when another write replaced it, merges that one
  and writes again if it lacks the writer's changes.
- **Reads storage again later.** A server room that wrote to WebDAV reads the document again in the
  next refresh (every 60 s), before it is evicted (idle for `ROOM_IDLE_TTL_SECONDS`) and when the
  server stops, and writes its changes again if they are missing; it is not evicted while that read
  fails. A room that nobody uses reads the document again before the server opens it, unless it read
  it within the last 2 s; the server waits 5 s at most for that read (and for the check whether
  storage holds a project it deleted again, for the check whether a project has an id that is also
  the name of a loaded project, both below, and for MCP get_project's check of storage before it
  answers), and once a request stopped waiting for a read of a project, the requests that come while
  that read goes on wait for none of that project's reads: an MCP tool that asks whether a project
  exists and then opens it, deletes it, or checks storage before it answers, as get_project does,
  waits 5 s for that project's reads, not twice that (when it lists the projects too, the listing
  waits for none of them, but the listing itself can take 30 s, below). Browsers sync every 20 s
  while the project is open.
- **Does not bring back deleted projects** (next section).

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

### Deleted projects

A project can be deleted (in a browser's project list, with the REST API or the MCP
`delete_project` tool) while other servers and browsers have it open. They follow one rule: a
writer stores a project that is gone from storage again only when it holds changes made since its
last read or write of storage (unsaved changes), and so keeps that work; otherwise it writes
nothing.

- A writer that saved its changes has none left: when the deletion lands right after its write
  (its read-back finds no document, or its write of `project.json` finds no folder), it writes
  neither the document nor `project.json` again (writes never create a project's folder that is
  gone; they used to, which left a `project.json` that every server listed without a document).
  When another writer's save replaced its write without its changes (servers that ignore
  `If-Match`) and the deletion came after that, those changes count as unsaved only if the
  writer's own save finds the replacement in its read-back and writes with `create`: a room's save
  of unsaved changes, a browser's sync while its copy holds insertions beyond its record (below),
  or Save. That save stores the project again. When the replacement lands after the writer's
  read-back confirmed its write and the deletion comes before the writer's next read, that read
  writes nothing unless the writer made changes since, or the person saves in a browser (a room's
  refresh does not create a document, and the browser's record holds the replaced write): those
  changes are gone with the project.
- A server room learns of the deletion when it reads storage: in the periodic refresh (rooms with
  editors connected, and rooms that wrote to WebDAV since their last read), in its read-back,
  before eviction or at shutdown when it wrote since its last read, and before the server opens a
  room that nobody uses (no editor connected, no MCP session, no unsaved changes), unless that
  room read storage within the last 2 s. Without unsaved changes it writes nothing. A room that
  nobody uses is then closed (right away, or by the next check for idle rooms, every 60 s by
  default), and the server answers like the one that deleted the project: it does not list or
  open it (MCP tools answer that the project was not found), and closes sync connections to it
  for an hour (code 4404, below). A room in use stays open, and a change made in it saves the
  project again. The server logs both at `info`:
  - `project deleted from storage elsewhere: not saved again unless it changes on this server`
  - `project deleted from storage elsewhere: saved again with the changes made on this server`
- A server lists what storage lists, and the projects whose rooms are in use or have unsaved
  changes. When storage does not list a loaded project that nobody uses, the server asks whether its
  document is still stored (its `project.json` may be unreadable), and waits 5 s at most for the
  answer (without one, the project counts as stored): when it is not stored, the room reads storage
  and is closed. When listing storage fails, the server lists the projects it has loaded and logs
  `listing projects failed` at `warn`. Listing fails too when reading the `project.json` of a listed
  project fails (a `project.json` that is not valid JSON lists no project, as a missing one), with
  the reason `could not read the project.json of <n> of <m> stored projects (<reason>)`: such a
  project used to be left out without a word, as if it did not exist. A browser's project list then
  shows the projects whose `project.json` it read, and the reason. A storage request that gets no
  complete answer fails after 30 s (on WebDAV; also one whose answer stops coming), with the reason
  `<method> <path> got no complete answer within 30 s`, so with storage that accepts connections and
  does not answer, listing the projects (MCP `list_projects`, `GET /api/projects`) takes 30 s before
  the server lists the projects it has loaded (`list_projects` then says `storage_listing_failed`).
  A request that names a project the server has not loaded (an MCP tool, REST
  `DELETE /api/projects/<id>`) reads its `project.json` (without one, its document): when that read
  fails, the request fails with `could not read project <id> from storage (<reason>)`, on WebDAV
  after 30 s with storage that does not answer (it used to answer that the project was not found,
  after 90 s). MCP tools take a project's id or name and try the id first, and a name such as
  `Lighthouse` is a valid id too: when a project the server has loaded has that name (ignoring
  letter case), storage that fails, or does not answer within 5 s, leaves the name to find that
  project (such calls used to fail with that error while storage failed, also for the agent working
  on the project); while a read that a request stopped waiting for goes on, the requests that name
  the project, or check storage for it as get_project does, do not wait for storage again.
- The server that deleted a project closes sync connections to it for an hour (they would upload
  a browser's copy as a new project), but lists and opens it as soon as storage holds it again
  (another writer saved its unsaved changes). It asks storage whether it does when a request needs
  the project (opening it, listing projects, a sync connection), and waits 5 s at most for the
  answer, once (the requests that come while that check goes on, after one stopped waiting for it,
  do not wait): without an answer, the project counts as still deleted, and the requests after the
  answer find it.
- When the server deletes a project (REST `DELETE /api/projects/<id>`, MCP `delete_project`), it
  deletes the stored files first: until storage has deleted them, the project's room serves its
  editors and agents, and from then on it saves nothing (a save would store the project again). Only
  then does the server close the project's sync connections, with code 4404 (`project deleted`). The
  deletion first waits for the project's earlier reads and writes of storage (a load of the project,
  the read before the server opens a room nobody uses, saves) 5 s at most in all, and not at all
  while one that a request stopped waiting for goes on (the rule above); when they have not
  finished, it deletes nothing, then or later. One deletion of a project runs at a time (another one
  asked for meanwhile waits for it, and after one that deleted the project finds it deleted), and
  requests that would load the project from storage wait for the deletion. When nothing was deleted,
  or storage fails to delete the project (on WebDAV: the DELETE fails, gets no answer within 30 s,
  or is answered with 207 Multi-Status because some files were not deleted), the room goes on
  serving and saving, its connections stay open, the server does not count the project as deleted,
  and the request fails: REST answers 500 and MCP `delete_project` an error, which say that the
  server could not delete the project from storage and why (when nothing was deleted:
  `storage did not finish this project's earlier reads and writes within 5 s`, or
  `storage has not finished a read of this project that a request stopped waiting for after 5 s`
  when the deletion did not wait because such a read went on), that nothing was deleted or that
  storage may still hold all or part of it, that the project stays open on this server for its
  editors and agents (when it is loaded), and to delete it again. With storage that accepts
  connections and does not answer, a deletion fails after 5 s (its waits; at once while such a read
  goes on) or after 30 s (its own request: the DELETE or, for a project the server has not loaded,
  the read of its `project.json`). A new connection to a project it deleted, or whose room it closed
  after finding the project deleted from storage, the server accepts and closes at once with code
  4404 (browsers cannot read the status of a refused WebSocket upgrade: they took HTTP 410 for a
  lost network and connected again and again). A browser whose connection is closed with that code
  says that the project was deleted on the server, shows `Deleted on server` in the status bar (sync
  status `deleted`, a red dot; the tooltip says what the browser does with the project), and no
  longer connects to the server for that project by itself; it keeps its copy and its edits, in
  IndexedDB and in its other tabs, and syncs with WebDAV by the rules above. Reloading the page, or
  Save (Ctrl+S), connects again; while the server has the project deleted it closes that connection
  the same way, and the page says nothing more (a reload says it once again). It says so again for a
  new deletion, after a room of the server took one of its connections (the server held the project
  again).
- With WebDAV through the server (`WEBDAV_URL`, the `/dav` proxy), WebDAV is the server's
  storage: a browser says once that the project was deleted, whether the server's connection or a
  WebDAV sync tells it first, and the server's message says that a change or Save stores the
  project on the server again. When a WebDAV sync then finds the project stored there again (this
  browser's change or Save stored it again, or another writer did), the browser connects to the
  server again, which opens the project again, and the page syncs live again. With WebDAV used
  directly, the browser's storage tells nothing about the server's, and it does not connect again
  by itself.
- A browser remembers in localStorage, which all its tabs share, per project and WebDAV store, the
  state vector of the stored states its syncs read or wrote (also of a write another writer
  deleted right after). When the store no longer has a project the browser synced before, a tab
  stores it again only if its copy holds changes made since (its own, or ones it received live
  from others); else it shows `WebDAV deleted` in the status bar, says once that the project was
  deleted (on another device, or in this browser), and keeps its copy. A later change, or Save
  (Ctrl+S), stores it again and says so. Changes that only delete things do not count: they are
  gone with the project. A project the browser never synced with that store is uploaded, unless
  a tab of this browser deleted it.
- Deleting a project in the browser keeps that record and notes the deletion before it deletes
  the WebDAV copy, so that the browser's other tabs that have the project open follow the rule
  (they used to upload it at their next sync, as a project they had never synced). It does not
  sync the open project a last time first, and waits for a sync that is running: either could
  land after the deletion.

Limits: a browser that connects to a server more than an hour after the deletion (or to another
server that has no room for the project, or one restarted since) uploads its copy over the sync
connection, and the server stores it as a new project: it cannot tell such a copy from a project
created offline. A browser with no record of syncing a project (a private window, blocked storage,
or a project it last synced with an earlier version) treats it as never synced. The records stay in
localStorage after a project is deleted. nginx with `create_full_put_path on` creates missing
folders on PUT itself: a deletion between a save's document and its `project.json` leaves that
`project.json`. Servers list such a project under the name in its `project.json` and open it with an
empty scene; its first change stores a document again. The server writes no name into that scene's
document (a name the server wrote would be a new write of the name, and a browser that renamed the
project in its copy of the full document could lose its rename when the two copies merge, as Yjs
resolves two concurrent writes of one key by client id): agents, and editors wherever they show the
project's name (the title, the Scene tab, the names of rendered and exported files, messages,
project lists), see the name in `project.json` instead, saves keep it there, and the document gets a
name when someone renames the project. Browsers get that name from the server after their first sync
with it (`GET /api/projects/<id>`), or from WebDAV (they read `project.json` once: before a sync
that can write it, or after a sync that leaves the document without a name); until then they show
`Untitled`.

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
