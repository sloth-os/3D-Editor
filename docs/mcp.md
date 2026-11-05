# Controlling the editor with AI agents (MCP)

The server exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at
`/mcp` (Streamable HTTP). Agents get full control over projects: they can create and inspect
projects, add and edit objects, run any editor operator, edit meshes, manage materials,
modifiers and animation, import/export files and render images. **Every change an agent makes
is synced live to all devices that have the project open**, and the agent appears as a peer
(robot avatar) with its selection highlighted.

## Connecting

Claude Code:

```bash
claude mcp add --transport http 3d-editor http://localhost:8080/mcp
```

Any MCP client that supports Streamable HTTP can connect the same way. Clients that only
speak stdio can use a generic HTTP bridge, e.g. in a desktop client's config:

```json
{ "mcpServers": { "3d-editor": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8080/mcp"] } } }
```
 If the server runs with
`AUTH_TOKEN` (or `MCP_TOKEN`), send `Authorization: Bearer <token>`:

```bash
claude mcp add --transport http 3d-editor http://localhost:8080/mcp --header "Authorization: Bearer <token>"
```

## Conventions

* Z is up, units are meters, rotations are Euler XYZ in **radians** (tools that accept
  `rotation_degrees` say so).
* Ids and names: objects can be referenced by id or by (unique) name.
* Operators use Blender's ids and parameter names (`mesh.primitive_cube_add`,
  `object.modifier_add`, `mesh.extrude_region_move`, `transform.rotate`…). `list_operators`
  returns every operator with its JSON schema; `run_operator` runs any of them.
* Each tool call is one undo step in the agent's own undo history (`undo` / `redo` never revert
  human edits). The history (with the agent's selection, mode and frame) belongs to the MCP
  session; clients that open a new session per call share one history by sending the same agent
  id with every connection: header `x-mcp-agent-id: <id>` or `?agent=<id>` on the endpoint URL.
  `scripts/mcp.mjs` does this (`MCP_AGENT_ID`, by default one id per user and working directory)
  and ends its sessions with an HTTP `DELETE`, so no "AI agent" presence is left behind.
* `get_scene` / `get_object` report the values at the requested frame (keyframes, drivers,
  constraints applied) and list the stored document values next to them where animation
  overrides them (`stored`, `stored_value`, `stored_influence`).

## Tools (overview)

| Area | Tools |
| --- | --- |
| Projects | `list_projects`, `create_project`, `get_project`, `rename_project`, `delete_project` |
| Inspect | `get_scene`, `get_object`, `get_mesh_data` (vertex positions, faces, face materials, normals, UVs, vertex groups, heightmap; paged), `list_operators`, `list_modifier_types`, `get_connected_clients` |
| Objects | `add_object`, `transform_object`, `delete_objects`, `duplicate_object`, `set_parent`, `create_mesh` |
| Modeling | `edit_mesh` (any `mesh.*` operator with an explicit vertex/edge/face selection), `run_operator`, `batch` |
| Look | `set_material`, `add_modifier`, `update_modifier`, `remove_modifier`, `apply_modifier`, `set_scene_settings`, `set_active_camera` |
| Animation | `insert_keyframe` |
| Files | `import_model` (base64 or URL), `export_scene` |
| Visual feedback | `render_image` (rendered by an open browser editor via WebGL, otherwise by the server's CPU renderer), `editor_command` (drive the live editor UI: frame view, switch shading, select, notify the user, screenshot) |
| History | `undo`, `redo` |

The project scene is also available as a resource: `project://{id}/scene`.

## Example session

1. `create_project { "name": "Low-poly island" }`
2. `add_object { "project": "<id>", "type": "cylinder", "params": { "vertices": 7, "radius": 3, "depth": 0.6 } }`
3. `add_modifier { "project": "<id>", "object": "Cylinder", "type": "DISPLACE", "params": { "strength": 0.4 } }`
4. `set_material { "project": "<id>", "object": "Cylinder", "base_color": [0.3, 0.6, 0.2, 1], "roughness": 0.9 }`
5. `render_image { "project": "<id>", "width": 800, "height": 450 }` → PNG the agent can look at.
