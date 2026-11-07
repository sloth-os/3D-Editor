import { BROWSER_UI_OPERATORS } from '@3d-editor/core';

/*
 * Feature groups for `list_operators`: operators of one feature are spread over several registry
 * categories (constraint operators live in Object and Pose, curve operators in Add, Curve, Text
 * and Object, …), so agents can also filter by these task-oriented groups.
 *
 * Also the operators agents reach through dedicated tools instead of run_operator / batch /
 * edit_mesh (`toolOnlyOperator`): the core render operators would render on the server's main
 * thread and stall every editor and agent until they are done. And the operators of the browser
 * editor's UI (`browserUiOperator`), which only a live editor has: editor_command runs them.
 */

/** A task-oriented group of operators (matched by operator id). */
export interface OperatorGroup {
  name: string;
  description: string;
  /** Other names the group is found by (e.g. the registry category it extends). */
  aliases?: string[];
  /** MCP tools to use for this feature (listed with the operators). */
  tools?: string[];
  match: (id: string) => boolean;
}

const prefix =
  (...prefixes: string[]) =>
  (id: string) =>
    prefixes.some((p) => id.startsWith(p));
const ids =
  (...list: string[]) =>
  (id: string) =>
    list.includes(id);
const any =
  (...fns: ((id: string) => boolean)[]) =>
  (id: string) =>
    fns.some((f) => f(id));

/** The feature groups `list_operators` accepts as `category`. */
export const OPERATOR_GROUPS: readonly OperatorGroup[] = [
  {
    name: 'Curves',
    description: 'Bezier/NURBS/poly curves, text objects, conversion to meshes',
    match: any(prefix('curve.', 'font.'), ids('object.text_add', 'object.convert')),
  },
  {
    name: 'Text',
    description: 'Text (FONT) objects',
    match: any(prefix('font.'), ids('object.text_add', 'object.convert')),
  },
  {
    name: 'Constraints',
    description: 'Object and bone constraints, tracking',
    match: any(
      prefix('constraint.', 'pose.constraint_'),
      ids(
        'object.constraint_add',
        'object.constraints_clear',
        'object.track_set',
        'object.visual_transform_apply',
        'pose.ik_add',
      ),
    ),
  },
  {
    name: 'Rigging',
    description: 'Armatures, bones, poses, IK, skinning (parenting with automatic weights), vertex groups',
    match: any(
      prefix('armature.', 'pose.', 'object.vertex_group_'),
      ids('object.armature_add', 'object.parent_set', 'object.parent_to', 'object.parent_clear'),
    ),
  },
  {
    name: 'Shape Keys',
    description: 'Mesh shape keys (morph targets)',
    match: prefix('object.shape_key_'),
  },
  {
    name: 'Vertex Groups',
    description: 'Named per-vertex weights',
    match: prefix('object.vertex_group_'),
  },
  {
    name: 'Instancing',
    description: 'Particle scattering, collection instances, making instances real',
    match: any(
      prefix('object.particle_system_', 'collection.'),
      ids(
        'object.scatter_add',
        'object.scatter_on_surface',
        'object.collection_instance_add',
        'object.instance_collection_set',
        'object.duplicates_make_real',
        'object.array_place',
        'object.move_to_collection',
      ),
    ),
  },
  {
    name: 'Particles',
    description: 'Particle systems (same as Instancing)',
    match: any(prefix('object.particle_system_'), ids('object.scatter_add', 'object.duplicates_make_real')),
  },
  {
    name: 'Generators',
    description: 'Procedural models: terrain, rocks, trees, buildings, furniture, gears …',
    match: prefix('object.generate_'),
  },
  {
    name: 'Drivers',
    description: 'Drivers, F-curve modifiers, extrapolation and animation tools',
    match: any(
      prefix('anim.driver_', 'anim.fmodifier_'),
      ids('anim.extrapolation_set', 'anim.keyframes_insert_many', 'anim.turntable', 'anim.bake_transforms'),
    ),
  },
  {
    name: 'Shading',
    description: 'Materials, presets, procedural textures, sky and mist',
    match: any(prefix('material.', 'world.'), ids('object.material_assign', 'object.material_slot_add')),
  },
  {
    name: 'Modifiers',
    description:
      'Modifier stacks (mesh, curve and text objects): use the add_modifier / update_modifier / remove_modifier / apply_modifier tools; list_modifier_types gives the parameters of every modifier type',
    tools: ['list_modifier_types', 'add_modifier', 'update_modifier', 'remove_modifier', 'apply_modifier'],
    match: prefix('object.modifier_'),
  },
  {
    name: 'Lights and Cameras',
    aliases: ['Lights', 'Cameras', 'Lighting'],
    description:
      'Light and camera objects and their data: light.properties_set (energy, colour, area light shape / size / size_y, spot cone, shadow softness), camera.properties_set (lens, clipping, orthographic scale, depth of field), aiming with object.track_set',
    tools: ['add_object', 'set_active_camera'],
    match: any(prefix('light.', 'camera.'), ids('object.light_add', 'object.camera_add', 'object.track_set')),
  },
  {
    name: 'Rendering',
    aliases: ['Render'],
    description:
      'Render with the render_image (stills: RASTER previews, PATHTRACER finals) and render_animation (contact sheets, GIF, APNG, PNG sequences) tools; render settings with set_scene_settings. These operators set up what renders show: cameras (lens, depth of field: camera.properties_set), lights (energy, area light shape and size: light.properties_set), tracking, sky and mist',
    tools: ['render_image', 'render_animation', 'set_scene_settings', 'set_active_camera'],
    match: any(
      prefix('world.', 'light.', 'camera.'),
      ids('object.camera_add', 'object.light_add', 'object.track_set'),
    ),
  },
];

/** Operators replaced by MCP tools, with the tool and how to use it instead. */
const TOOL_ONLY: Record<string, { tool: string; usage: string }> = {
  'render.render_software': {
    tool: 'render_image',
    usage:
      'same options (width, height, engine RASTER | PATHTRACER, samples, max_bounces, denoise, time_limit, seed, camera, view, frame); it returns the image',
  },
  'render.render_animation': {
    tool: 'render_animation',
    usage:
      'format CONTACT_SHEET | GIF | APNG | PNG_SEQUENCE, frame_start, frame_end, frame_step, width, height, engine, samples, time_limit, store; frames render in parallel and the result comes back as an image or files',
  },
};

/**
 * Why `id` cannot be run through run_operator / batch / edit_mesh and which tool to use instead,
 * or null when it can: render operators (`render.*`) render on the event loop of the server.
 */
export function toolOnlyOperator(id: string): string | null {
  if (!id.startsWith('render.')) return null;
  const t = TOOL_ONLY[id] ?? TOOL_ONLY['render.render_software'];
  return (
    `'${id}' would render on the server's main thread and stall every editor and agent until it is done, ` +
    `so it is not available through run_operator, batch or edit_mesh. Use the ${t.tool} tool instead ` +
    `(${t.usage}): it renders on the server's render threads.`
  );
}

/**
 * What agents use instead of some of the browser editor's UI operators, when they want the edit
 * rather than the editor's UI: `instead` is the sentence that says what (a server operator or a
 * tool, on the agent's own selection and undo history), `use` names it briefly for did-you-mean
 * lists, and `editor` says what the operator does in a live editor that an agent may not expect:
 * several are interactive there (they wait for the person's mouse), others act on the editor
 * user's selection, frame or undo history. Shift+D (object.duplicate_move), for one, is the id
 * agents know from Blender: run in a live editor it duplicates the person's selection and leaves a
 * mouse-driven move running.
 */
interface BrowserOperatorAdvice {
  instead: string;
  use?: string;
  editor?: string;
}

const BROWSER_OPERATOR_ADVICE: Record<string, BrowserOperatorAdvice> = {
  'ed.undo': {
    instead: 'To undo your own changes use the undo tool.',
    use: 'the undo tool',
    editor: "it undoes the editor user's last change, not yours",
  },
  'ed.redo': {
    instead: 'To redo your own undone changes use the redo tool.',
    use: 'the redo tool',
    editor: "it redoes the editor user's last undone change, not yours",
  },
  'screen.repeat_last': {
    instead: 'To repeat an operation run it again with run_operator (or several in one batch).',
    use: 'run_operator again',
    editor: "it repeats the editor user's last operation on the editor's selection",
  },
  'object.duplicate_move': {
    instead:
      'To duplicate objects use object.duplicate {linked, offset: [x, y, z]} on your selection (or the duplicate_object tool): it copies them and moves the copies by offset in one step.',
    use: 'object.duplicate {offset}',
    editor:
      "it duplicates the editor's selection, then waits for the person to move the copies with the mouse",
  },
  'view3d.transform_modal': {
    instead:
      'To move, rotate or scale use transform.translate {value}, transform.rotate {value, orient_axis} or transform.resize {value} on your selection (through edit_mesh for mesh elements), or the transform_object tool.',
    use: 'transform.translate / transform.rotate / transform.resize',
    editor: "it starts a move, rotation or scale of the editor's selection that follows the person's mouse",
  },
  'mesh.loopcut_pick': {
    instead:
      "To cut a loop use edit_mesh {object, operator: 'mesh.loopcut', params: {edge: [a, b], number_cuts}}, where edge is an edge of the ring as two vertex indices of the base mesh (get_mesh_data).",
    use: 'mesh.loopcut through edit_mesh',
    editor: "it cuts the edge ring under the person's mouse pointer",
  },
  'sculpt.commit_stroke': {
    instead:
      'To sculpt or paint use sculpt.brush_stroke or paint.vertex_color_stroke with the points of the stroke.',
    use: 'sculpt.brush_stroke / paint.vertex_color_stroke',
    editor: 'it commits the stroke the person is drawing with the mouse',
  },
  'render.render': {
    instead: 'For an image use render_image (render_animation for an animation): they need no editor.',
    use: 'render_image',
    editor: 'it opens the Render window',
  },
  'view3d.object_as_camera': {
    instead: 'To set the scene camera use set_active_camera.',
    use: 'set_active_camera',
  },
  'view3d.camera_to_view': {
    instead:
      'To place a camera use transform_object (object.track_set aims it at a target); render_image takes a `view` {position, target} for any viewpoint without moving a camera.',
    use: 'transform_object on the camera',
    editor: "it moves the scene camera to the editor's viewpoint",
  },
  'screen.frame_offset': {
    instead: 'To set your own current frame use scene.frame_set {frame} (most tools also take a `frame`).',
    use: 'scene.frame_set',
    editor: "it changes the editor's frame, not yours",
  },
  'screen.keyframe_jump': {
    instead:
      'To go to a keyframe use scene.frame_set {frame} with its frame from get_object (its animation lists the keyframes).',
    use: 'scene.frame_set',
    editor: "it changes the editor's frame, not yours",
  },
  'screen.animation_play': {
    instead: 'To look at the animation use render_animation (a contact sheet, GIF or APNG).',
    use: 'render_animation',
  },
  'wm.search_menu': { instead: 'To find operators use list_operators {search}.', use: 'list_operators' },
  'wm.export': { instead: 'To export the scene use export_scene.', use: 'export_scene' },
  'wm.import': { instead: 'To import a file use import_model.', use: 'import_model' },
  'wm.read_homefile': { instead: 'To create a project use create_project.', use: 'create_project' },
  'wm.open_mainfile': {
    instead: 'To find projects use list_projects: every tool takes the project to work in.',
    use: 'list_projects',
  },
  'wm.share': { instead: "For the project's link use get_project (editor_url).", use: 'get_project' },
  'wm.save_mainfile': {
    instead: 'Saving is not needed: the server stores projects itself (get_project says where).',
    editor: 'it makes that editor save its own copy at once',
  },
};

/** How a live editor runs one of its UI operators (`id`), for {@link browserUiOperator}. */
function editorRun(id: string): string {
  return (
    `editor_command {project, command: 'run_operator', params: {operator: '${id}', params: {…}}} ` +
    '(get_connected_clients lists the editors that have the project open)'
  );
}

/**
 * Why `id` cannot run through run_operator / batch / edit_mesh when it is an operator of the
 * browser editor's UI (one of BROWSER_UI_OPERATORS, or registered `uiOnly`), and how to run it in
 * a live editor instead; null for other ids. Where the tools offer the same edit (object.duplicate
 * for Shift+D's object.duplicate_move, transform.* for the interactive transform, mesh.loopcut for
 * the mouse-picked loop cut, the undo tool for ed.undo …) the message names that first and says
 * what the operator does in a live editor.
 */
export function browserUiOperator(id: string, uiOnly = false): string | null {
  if (!uiOnly && !BROWSER_UI_OPERATORS.includes(id)) return null;
  const head =
    `'${id}' is an operator of the browser editor's user interface (viewport, playback, tools, windows): ` +
    'only a live editor can run it, not run_operator, batch or edit_mesh.';
  const advice = BROWSER_OPERATOR_ADVICE[id];
  if (!advice) return `${head} Run it there with ${editorRun(id)}.`;
  return (
    `${head} ${advice.instead} In a live editor run it with ${editorRun(id)}` +
    `${advice.editor ? `: ${advice.editor}` : ''}.`
  );
}

/**
 * The note after a did-you-mean list that suggests operators of the browser editor's UI (`ids`,
 * of the `suggested` ids): what they are, what the tools offer instead where they do, and how a
 * live editor runs them.
 */
export function browserUiOperatorsNote(ids: readonly string[], suggested: readonly string[]): string {
  if (!ids.length) return '';
  const one = ids.length === 1;
  const all = ids.length === suggested.length;
  const list = one ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
  const subject = all
    ? one
      ? 'It is an operator'
      : 'They are operators'
    : `${list} ${one ? 'is an operator' : 'are operators'}`;
  const uses = ids.flatMap((id) => {
    const use = BROWSER_OPERATOR_ADVICE[id]?.use;
    return use ? [one ? use : `${use} for ${id}`] : [];
  });
  return (
    `${subject} of the browser editor's user interface${uses.length ? ` (instead: ${uses.join(', ')})` : ''}: ` +
    `a live editor runs ${one ? 'it' : 'them'} with editor_command {project, command: 'run_operator', params: {operator, params}}.`
  );
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/s$/, '');

/**
 * The group named `name` or one of its aliases (case-insensitive; spaces, underscores and a
 * plural "s" are ignored).
 */
export function findOperatorGroup(name: string): OperatorGroup | null {
  const n = normalize(name);
  return OPERATOR_GROUPS.find((g) => [g.name, ...(g.aliases ?? [])].some((x) => normalize(x) === n)) ?? null;
}

/** Names of the feature groups, in listing order. */
export function operatorGroupNames(): string[] {
  return OPERATOR_GROUPS.map((g) => g.name);
}
