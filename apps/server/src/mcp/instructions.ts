/** Server instructions sent to MCP clients on initialization. */
export const MCP_INSTRUCTIONS = `You control a Blender-inspired, real-time collaborative 3D editor.

Conventions
- Coordinate system: right-handed, Z is up (the XY plane is the ground), +Y is "forward/back" like in Blender.
- Units: lengths in meters, angles in radians (tools with a \`rotation_degrees\` argument convert for you), colors are linear RGB(A) in 0..1.
- Operators use Blender-style ids and parameter names (e.g. mesh.primitive_cube_add, transform.translate, mesh.extrude_region_move, object.shade_smooth). Datablock fields follow Blender's Python API (location, rotation_euler, scale, base_color, energy, lens, ...).
- Names are unique per kind (Blender style: "Cube", "Cube.001"). Objects, materials and projects can be referenced by id or by exact name.

Collaboration
- Every change is applied to the shared CRDT document and syncs live to every open editor (browsers on other devices see your edits immediately). Humans may be editing at the same time: re-read the scene (get_scene / get_object) before relying on earlier results.
- You appear to other users as "AI agent (<your client name>)" with your own selection.
- undo / redo only revert your own changes. \`batch\` runs several operators as a single undo step.

Typical workflow
1. list_projects or create_project (projects open in the editor at /?project=<id>).
2. get_scene to inspect objects, materials, bounds and settings.
3. add_object / create_mesh / transform_object / set_material / add_modifier / edit_mesh / insert_keyframe / set_scene_settings, or run_operator for anything else.
4. render_image to look at the result (uses a connected browser editor when available, else the built-in software renderer).

Use list_operators to discover the full operator catalogue with JSON-schema parameters, then run_operator to execute any operator (selection and mode can be set per call).`;
