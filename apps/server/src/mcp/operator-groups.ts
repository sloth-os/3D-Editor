/*
 * Feature groups for `list_operators`: operators of one feature are spread over several registry
 * categories (constraint operators live in Object and Pose, curve operators in Add, Curve, Text
 * and Object, …), so agents can also filter by these task-oriented groups.
 *
 * Also the operators agents reach through dedicated tools instead of run_operator / batch /
 * edit_mesh (`toolOnlyOperator`): the core render operators would render on the server's main
 * thread and stall every editor and agent until they are done.
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
    description: 'Modifier stacks (mesh, curve and text objects)',
    match: prefix('object.modifier_'),
  },
  {
    name: 'Rendering',
    aliases: ['Render'],
    description:
      'Render with the render_image (stills: RASTER previews, PATHTRACER finals) and render_animation (contact sheets, GIF, APNG, PNG sequences) tools; render settings with set_scene_settings. These operators set up what renders show: cameras, tracking, sky and mist',
    tools: ['render_image', 'render_animation', 'set_scene_settings', 'set_active_camera'],
    match: any(prefix('world.'), ids('object.camera_add', 'object.track_set')),
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
