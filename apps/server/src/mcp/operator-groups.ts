import { BROWSER_UI_OPERATORS } from '@3d-editor/core';
import { NEW_SHADER_SECONDS, measured } from './editor-costs';

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
    description:
      'Materials, presets, procedural textures, sky and mist. In a browser editor without GPU acceleration ' +
      '(e.g. a headless browser), an edit that needs a shader no material had (coat or sheen turned on, a procedural ' +
      'texture on a set of channels that no other material has) makes the next screenshot or viewport frame ' +
      `in MATERIAL and in RENDERED shading compile it (${measured(NEW_SHADER_SECONDS)}; edits of values ` +
      "compile nothing): pass editor_command a larger timeout_ms or shading 'SOLID'",
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
    `(${t.usage}): it renders in the server's render processes.`
  );
}

/**
 * What the browser editor's UI operators do in a live editor, and what agents use instead where
 * the tools offer it. `editor` says what the operator does there, which an agent may not expect:
 * it acts on the person's editor, not on the agent's own state: their view and view settings,
 * selection, frame, tool and undo history, windows and menus on their screen, their project and
 * clipboard, and several are interactive (they wait for the person's mouse). Shift+D
 * (object.duplicate_move), for one, is the id agents know from Blender: run in a live editor it
 * duplicates the person's selection and leaves a mouse-driven move running. `instead` is the
 * sentence that says what to use for the edit (a server operator or a tool, on the agent's own
 * selection and undo history), and `use` names it briefly for did-you-mean lists. What each one
 * does is ui-operators.ts in apps/web (the web editor registers them there).
 */
interface BrowserOperatorAdvice {
  editor: string;
  instead?: string;
  use?: string;
}

const BROWSER_OPERATOR_ADVICE: Record<string, BrowserOperatorAdvice> = {
  'ed.undo': {
    instead: 'To undo your own changes use the undo tool.',
    use: 'the undo tool',
    editor:
      "it undoes the last change in that editor's undo history: the person's, or an operator run there with " +
      'editor_command, never your changes made with the tools',
  },
  'ed.redo': {
    instead: 'To redo your own undone changes use the redo tool.',
    use: 'the redo tool',
    editor:
      "it redoes the last change undone in that editor's undo history, never your changes made with the tools",
  },
  'screen.repeat_last': {
    instead: 'To repeat an operation run it again with run_operator (or several in one batch).',
    use: 'run_operator again',
    editor:
      "it runs the person's last operation again (operations run with editor_command are not repeated) on " +
      "the editor's selection, as a new step of the person's undo history, and fails when there is nothing " +
      'to repeat',
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
    editor:
      "it starts a move, rotation or scale ({mode: translate, rotate or resize}) of the editor's selection " +
      "that follows the person's mouse until they click",
  },
  'mesh.loopcut_pick': {
    instead:
      "To cut a loop use edit_mesh {object, operator: 'mesh.loopcut', params: {edge: [a, b], number_cuts}}, where edge is an edge of the ring as two vertex indices of the base mesh (get_mesh_data).",
    use: 'mesh.loopcut through edit_mesh',
    editor:
      "in Edit Mode it cuts the edge ring of the editor's active mesh under the person's mouse pointer, and " +
      'fails when the pointer is over no edge',
  },
  'sculpt.commit_stroke': {
    instead:
      'To sculpt or paint use sculpt.brush_stroke or paint.vertex_color_stroke with the points of the stroke.',
    use: 'sculpt.brush_stroke / paint.vertex_color_stroke',
    editor:
      'it commits the sculpt or paint stroke the person is drawing with the mouse, and fails when there is none',
  },
  'render.render': {
    instead: 'For an image use render_image (render_animation for an animation): they need no editor.',
    use: 'render_image',
    editor:
      "it opens the Render window on the person's screen and renders the scene there at once, at the output " +
      "resolution, from the scene camera (else the editor's view; with the render engine PATHTRACER path " +
      "traced on that computer's render workers, as many as its tab's memory allows; a render that would " +
      "not fit into the tab's memory, path traced or with WebGL, is not started: the window says why), " +
      'without returning the image; with ' +
      '{animation: true} it opens the Render Animation window instead, which renders nothing until the ' +
      'person presses its Render button',
  },
  'view3d.object_as_camera': {
    instead: 'To set the scene camera use set_active_camera.',
    use: 'set_active_camera',
    editor:
      "it makes the editor's active object, which must be a camera, the scene camera (a step of the person's " +
      'undo history) and switches that editor to the camera view',
  },
  'view3d.camera_to_view': {
    instead:
      'To place a camera use transform_object (object.track_set aims it at a target); render_image takes a `view` {position, target} for any viewpoint without moving a camera.',
    use: 'transform_object on the camera',
    editor:
      "it moves the scene camera to the editor's viewpoint (a step of the person's undo history; under a parent " +
      "in the parent's space as the scene shows it at the editor's frame, and an animated channel it changes is " +
      'keyed there with its new value) and switches that editor to the camera view, and fails without a scene camera',
  },
  'screen.frame_offset': {
    instead: 'To set your own current frame use scene.frame_set {frame} (most tools also take a `frame`).',
    use: 'scene.frame_set',
    editor: "it moves the editor's current frame, not yours, by `delta` frames (default 1)",
  },
  'screen.keyframe_jump': {
    instead:
      'To go to a keyframe use scene.frame_set {frame} with its frame from get_object (its animation lists the keyframes).',
    use: 'scene.frame_set',
    editor:
      "it moves the editor's current frame, not yours, to the next keyframe (`next`, default true; false: the " +
      "previous one) of the editor's selected objects (of all objects when none is selected), and fails when " +
      'there is none',
  },
  'screen.animation_play': {
    instead: 'To look at the animation use render_animation (a contact sheet, GIF or APNG).',
    use: 'render_animation',
    editor:
      'it starts or stops playback in that editor, whose frame then keeps changing (editor_command play ' +
      '{playing} sets it)',
  },
  'wm.search_menu': {
    instead: 'To find operators use list_operators {search}.',
    use: 'list_operators',
    editor: "it opens the operator search on the person's screen",
  },
  'wm.export': {
    instead: 'To export the scene use export_scene.',
    use: 'export_scene',
    editor: "it opens the Export window on the person's screen",
  },
  'wm.import': {
    instead: 'To import a file use import_model.',
    use: 'import_model',
    editor:
      "it asks the browser to open a file chooser on the person's screen, which browsers block unless the " +
      'person has just clicked or pressed a key, so from editor_command it normally opens nothing (and still ' +
      'answers ok)',
  },
  'wm.read_homefile': {
    instead: 'To create a project use create_project.',
    use: 'create_project',
    editor:
      "it creates a new project ({name, empty}) and switches the person's editor to it, away from the project " +
      'it had open, which it leaves before it can answer (editor_command says so; list_projects lists the ' +
      'new project)',
  },
  'wm.open_mainfile': {
    instead: 'To find projects use list_projects: every tool takes the project to work in.',
    use: 'list_projects',
    editor: "it opens the project browser on the person's screen",
  },
  'wm.share': {
    instead: "For the project's link use get_project (editor_url).",
    use: 'get_project',
    editor:
      "it puts the project's link on the person's clipboard, replacing what they had copied (a browser that " +
      'refuses the copy shows them the link in a message; an editor page without clipboard access, served ' +
      'over plain HTTP from a host other than localhost, does nothing)',
  },
  'wm.save_mainfile': {
    instead: 'Saving is not needed: the server stores projects itself (get_project says where).',
    use: 'nothing (the server stores projects)',
    editor:
      'it makes that editor store its copy in WebDAV at once if it syncs with WebDAV (its copy in the browser is ' +
      "always up to date) and shows the person what happened: 'Saved to WebDAV', 'Saved in this browser' (no " +
      "WebDAV), 'Not saved to WebDAV (<reason>). The project is saved in this browser.', or that it syncs once " +
      'back online; with WebDAV, a project that the server or another device had deleted is stored there again ' +
      '(for example \'"<name>" was deleted on the server; this browser stored it there again.\'). It also connects that ' +
      'editor to the server again, which closes the connection again while the server has the project deleted ' +
      '(within an hour of deleting it, unless storage holds it again)',
  },
  'view3d.view_all': {
    editor:
      "it frames every visible object in that editor's viewport, changing the person's view, out of the " +
      'camera view (editor_command view.frame_all does the same)',
  },
  'view3d.view_selected': {
    editor:
      "it frames the editor's selection (in Edit Mode its selected vertices), changing the person's view, " +
      'out of the camera view (editor_command view.frame_selected does the same)',
  },
  'view3d.view_axis': {
    editor:
      "it turns the person's view to an axis ({type: FRONT, BACK, RIGHT, LEFT, TOP or BOTTOM}, orthographic), " +
      'out of the camera view (editor_command view.set_view does the same)',
  },
  'view3d.view_camera': {
    editor:
      "it switches the person's view into or out of the scene camera's view, and fails without a scene camera " +
      "(editor_command view.set_view {view: 'CAMERA'} switches into it, never out of it, and fails the same " +
      'way)',
  },
  'view3d.view_orbit': {
    editor:
      "it orbits the person's view ({type: ORBITLEFT, ORBITRIGHT, ORBITUP or ORBITDOWN}) by `angle` (radians, " +
      'default π/12: 15°); in the camera view it changes only the view they get back when they leave it',
  },
  'view3d.view_persportho': {
    editor:
      "it switches the person's view between perspective and orthographic; in the camera view it changes only " +
      'the view they get back when they leave it',
  },
  'view3d.zoom': {
    editor:
      "it zooms the person's view in by 1.25× per unit of `delta` (default 1; negative values zoom out), out " +
      'of the camera view',
  },
  'view3d.toggle_xray': {
    editor:
      'it turns X-ray on or off in that editor: in Solid shading its objects turn see-through (Wireframe ' +
      'shading always shows them so; Material Preview and Rendered draw them as they are), and in Edit Mode ' +
      "the edit cage shows through them and the person's box selections and clicks on vertices or edges also " +
      'select hidden ones (a click on a face picks the front one; selecting objects works the same with it ' +
      'on or off)',
  },
  'view3d.toggle_overlays': { editor: "it shows or hides the overlays of that editor's viewport" },
  'view3d.toggle_sidebar': { editor: "it shows or hides the viewport's sidebar in that editor" },
  'view3d.toggle_toolbar': { editor: "it shows or hides the viewport's tool bar in that editor" },
  'view3d.toggle_wireframe_overlay': {
    editor: "it shows or hides the wireframe over shaded objects in that editor's viewport",
  },
  'view3d.toggle_snapping': {
    editor: "it turns snapping on or off for the person's transforms in that editor",
  },
  'view3d.toggle_shading': {
    editor:
      "it switches the shading of the person's viewport ({type: WIREFRAME, SOLID, MATERIAL or RENDERED}; " +
      'WIREFRAME again goes back to SOLID; editor_command view.shading sets it)',
  },
  'wm.tool_set': {
    editor:
      "it changes the person's active tool in that editor ({tool: select, cursor, move, rotate, scale, " +
      'sculpt_draw, sculpt_smooth, sculpt_grab, sculpt_inflate, sculpt_flatten or paint}), and with it what ' +
      'their mouse does in the viewport',
  },
  'wm.call_menu': {
    editor:
      'it opens a popup menu ({name: add, snap, delete, merge, separate, uv, shading, view, context, apply, ' +
      'parent, parent_clear, constraint_add_targets, track or generators}; another name opens nothing) on ' +
      "the person's screen, at their mouse pointer unless x and y are given",
  },
  'wm.preferences': { editor: "it opens the Preferences window on the person's screen" },
  'screen.workspace_set': {
    editor:
      "it switches the person's workspace layout ({name: Layout, Modeling, Shading, Animation or Scripting}; " +
      'Shading also switches their viewport to Material Preview)',
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
 * browser editor's UI (one of BROWSER_UI_OPERATORS, or registered `uiOnly`), how to run it in a
 * live editor instead and what it does there (on the person's editor); null for other ids. Where
 * the tools offer the same edit (object.duplicate for Shift+D's object.duplicate_move, transform.*
 * for the interactive transform, mesh.loopcut for the mouse-picked loop cut, the undo tool for
 * ed.undo …) the message names that first.
 */
export function browserUiOperator(id: string, uiOnly = false): string | null {
  if (!uiOnly && !BROWSER_UI_OPERATORS.includes(id)) return null;
  const head =
    `'${id}' is an operator of the browser editor's user interface (viewport, playback, tools, windows): ` +
    'only a live editor can run it, not run_operator, batch or edit_mesh.';
  const advice = BROWSER_OPERATOR_ADVICE[id];
  if (!advice) return `${head} Run it there with ${editorRun(id)}.`;
  if (!advice.instead) return `${head} Run it there with ${editorRun(id)}: ${advice.editor}.`;
  return `${head} ${advice.instead} In a live editor run it with ${editorRun(id)}: ${advice.editor}.`;
}

/** `id` in lower case, split at its last dot: the namespace ('' without one) and the last segment. */
function idParts(id: string): { space: string; tail: string } {
  const lower = id.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot < 0 ? { space: '', tail: lower } : { space: lower.slice(0, dot), tail: lower.slice(dot + 1) };
}

/**
 * Whether `candidate` is a completion of the (unknown) operator id `typed`: the same namespace,
 * and a last segment that starts with `typed`'s last segment of at least 3 characters, letter
 * case ignored ('wm.save' → wm.save_mainfile, 'object.dupli' → object.duplicate).
 */
export function completesOperatorId(typed: string, candidate: string): boolean {
  const t = idParts(typed);
  const c = idParts(candidate);
  return t.space !== '' && t.space === c.space && t.tail.length >= 3 && c.tail.startsWith(t.tail);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The operator ids among `candidates` closest to an unknown id `typed`, at most `max`, letter case
 * ignored: first its completions ({@link completesOperatorId}, the shortest first: 'object.dupli' →
 * object.duplicate, object.duplicate_move …), then the ids nearest by edit distance, where an id
 * that contains `typed`'s last segment counts as nearer ('VIEW3D.VIEW_ALL' or 'view3d.viewall' →
 * view3d.view_all).
 */
export function closestOperatorIds(typed: string, candidates: readonly string[], max = 8): string[] {
  const needle = typed.toLowerCase();
  const { tail } = idParts(typed);
  const completions = candidates
    .filter((c) => completesOperatorId(typed, c))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const near = candidates
    .filter((c) => !completions.includes(c))
    .map((c) => {
      const cand = c.toLowerCase();
      let score = editDistance(needle, cand);
      if (tail.length > 2 && cand.includes(tail)) score -= 3;
      return { id: c, score };
    })
    .filter((x) => x.score <= Math.max(4, Math.ceil(needle.length / 2)))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .map((x) => x.id);
  return [...completions, ...near].slice(0, max);
}

/**
 * The note after a did-you-mean list (`suggested`, for the unknown id `typed`) that suggests
 * operators of the browser editor's UI (`ids`): what they are, what the tools offer instead where
 * they do, and how a live editor runs them. Advice for one id must not read as advice for another
 * one, such as the id the agent meant ('wm.save' suggests wm.save_mainfile and wm.share, and
 * get_project is what to use for wm.share), so each piece of advice names its id, unless the note
 * is about one id that its sentence names, or that is the only suggestion and completes `typed`.
 */
export function browserUiOperatorsNote(
  ids: readonly string[],
  suggested: readonly string[],
  typed: string,
): string {
  if (!ids.length) return '';
  const one = ids.length === 1;
  const all = ids.length === suggested.length;
  const list = one ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
  const subject = all
    ? one
      ? 'It is an operator'
      : 'They are operators'
    : `${list} ${one ? 'is an operator' : 'are operators'}`;
  // "It is" names no id: its advice needs the id unless the agent evidently meant it
  const plain = one && (!all || completesOperatorId(typed, ids[0]));
  const uses = ids.flatMap((id) => {
    const use = BROWSER_OPERATOR_ADVICE[id]?.use;
    return use ? [plain ? use : `${use} for ${id}`] : [];
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
