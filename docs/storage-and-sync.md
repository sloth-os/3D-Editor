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
Concurrent writers — several browsers, the server, an MCP agent — never lose each other's edits,
even after long offline periods.

Layout on WebDAV (and in the server's `DATA_DIR` for `SYNC_PERSISTENCE=disk`):

```
<base>/projects/<project-id>/project.json     name, timestamps, stats, thumbnail
<base>/projects/<project-id>/document.ybin    Yjs document state
```

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
