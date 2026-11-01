/*
 * Feature groups for `list_operators`: operators of one feature are spread over several registry
 * categories (constraint operators live in Object and Pose, curve operators in Add, Curve, Text
 * and Object, …), so agents can also filter by these task-oriented groups.
 */

export interface OperatorGroup {
  name: string;
  description: string;
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
    description: 'Software renders and animation renders',
    match: prefix('render.'),
  },
];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/s$/, '');

/** The group named `name` (case-insensitive; spaces, underscores and a plural "s" are ignored). */
export function findOperatorGroup(name: string): OperatorGroup | null {
  const n = normalize(name);
  return OPERATOR_GROUPS.find((g) => normalize(g.name) === n) ?? null;
}

export function operatorGroupNames(): string[] {
  return OPERATOR_GROUPS.map((g) => g.name);
}
