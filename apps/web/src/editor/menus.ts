import { CONSTRAINT_TYPES, ROOT_COLLECTION_ID, type ConstraintCategory } from '@3d-editor/core';
import { session } from '../app/store';
import { registry } from './editor';

export interface MenuItem {
  label?: string;
  /** Operator to run. */
  op?: string;
  params?: Record<string, unknown>;
  /** Arbitrary action instead of an operator. */
  action?: () => void;
  shortcut?: string;
  submenu?: MenuItem[] | (() => MenuItem[]);
  checked?: () => boolean;
  enabled?: () => boolean;
  sep?: true;
  title?: string;
}

const sep: MenuItem = { sep: true };

/** A greyed-out placeholder line (e.g. "No collections"). */
const note = (label: string): MenuItem => ({ label, enabled: () => false });

/**
 * Operators that menus run with default parameters and whose result is usually tuned afterwards.
 * The web UI makes them redoable so they open the "Adjust Last Operation" panel, like their
 * Blender counterparts (registry overrides only change UI behaviour, not the operators).
 */
export const REDO_PANEL_OPERATORS: readonly string[] = [
  'object.convert',
  'object.parent_set',
  'object.track_set',
  'object.duplicates_make_real',
  'rigidbody.bake_to_keyframes',
  'anim.turntable',
  'anim.bake_transforms',
];

/** Marks {@link REDO_PANEL_OPERATORS} redoable in the editor's registry (idempotent). */
export function enableRedoPanelOperators(reg = registry): void {
  for (const id of REDO_PANEL_OPERATORS) {
    const def = reg.get(id);
    if (def && !def.redoable) reg.override({ ...def, redoable: true });
  }
}
enableRedoPanelOperators();

// ------------------------------------------------------------------ Add menu

export const ADD_MESH: MenuItem[] = [
  { label: 'Plane', op: 'mesh.primitive_plane_add' },
  { label: 'Cube', op: 'mesh.primitive_cube_add' },
  { label: 'Circle', op: 'mesh.primitive_circle_add' },
  { label: 'UV Sphere', op: 'mesh.primitive_uv_sphere_add' },
  { label: 'Ico Sphere', op: 'mesh.primitive_ico_sphere_add' },
  { label: 'Cylinder', op: 'mesh.primitive_cylinder_add' },
  { label: 'Cone', op: 'mesh.primitive_cone_add' },
  { label: 'Torus', op: 'mesh.primitive_torus_add' },
  sep,
  { label: 'Grid', op: 'mesh.primitive_grid_add' },
];

/** Add > Curve (Blender's curve primitives). */
export const ADD_CURVE: MenuItem[] = [
  { label: 'Bezier', op: 'curve.primitive_bezier_curve_add' },
  { label: 'Circle', op: 'curve.primitive_bezier_circle_add' },
  sep,
  { label: 'Nurbs Curve', op: 'curve.primitive_nurbs_curve_add' },
  { label: 'Nurbs Circle', op: 'curve.primitive_nurbs_circle_add' },
  { label: 'Path', op: 'curve.primitive_nurbs_path_add' },
];

/** Add > Collection Instance: one entry per collection of the open project. */
export function COLLECTION_INSTANCE_MENU(): MenuItem[] {
  const doc = session.value?.doc;
  const collections = doc ? doc.listCollections().filter((c) => c.id !== ROOT_COLLECTION_ID) : [];
  if (!collections.length) return [note('No collections to instance')];
  return collections.map((c) => ({
    label: c.name,
    op: 'object.collection_instance_add',
    params: { collection: c.id },
  }));
}

export const ADD_EMPTY: MenuItem[] = [
  { label: 'Plain Axes', op: 'object.empty_add', params: { type: 'PLAIN_AXES' } },
  { label: 'Arrows', op: 'object.empty_add', params: { type: 'ARROWS' } },
  { label: 'Single Arrow', op: 'object.empty_add', params: { type: 'SINGLE_ARROW' } },
  { label: 'Circle', op: 'object.empty_add', params: { type: 'CIRCLE' } },
  { label: 'Cube', op: 'object.empty_add', params: { type: 'CUBE' } },
  { label: 'Sphere', op: 'object.empty_add', params: { type: 'SPHERE' } },
  { label: 'Cone', op: 'object.empty_add', params: { type: 'CONE' } },
  sep,
  { label: 'Collection Instance', submenu: COLLECTION_INSTANCE_MENU },
];

/** Grouping of the procedural generators (operators missing here are listed under "Other"). */
const GENERATOR_GROUPS: [string, string[]][] = [
  ['Nature', ['terrain', 'rock', 'tree', 'bush', 'grass_tuft', 'flower', 'cloud', 'blob']],
  ['Architecture', ['building', 'stairs', 'fence', 'column', 'arch']],
  ['Furniture & Props', ['table', 'chair', 'shelf', 'barrel']],
  ['Mechanical', ['gear', 'spring', 'wheel', 'pipe']],
];

/** Add > Generators: every registered `object.generate_*` operator, grouped by theme. */
export function GENERATORS_MENU(): MenuItem[] {
  const ops = registry.list().filter((d) => d.id.startsWith('object.generate_'));
  const used = new Set<string>();
  const out: MenuItem[] = [];
  const group = (title: string, ids: string[]) => {
    const defs = ids.map((id) => ops.find((d) => d.id === id)).filter((d) => !!d);
    if (!defs.length) return;
    out.push({ title });
    for (const d of defs) {
      used.add(d.id);
      out.push({ label: d.label, op: d.id });
    }
  };
  for (const [title, names] of GENERATOR_GROUPS)
    group(
      title,
      names.map((n) => `object.generate_${n}`),
    );
  group(
    'Other',
    ops.filter((d) => !used.has(d.id)).map((d) => d.id),
  );
  return out.length ? out : [note('No generators available')];
}

export const ADD_MENU: MenuItem[] = [
  { title: 'Add' },
  { label: 'Mesh', submenu: ADD_MESH },
  { label: 'Curve', submenu: ADD_CURVE },
  { label: 'Text', op: 'object.text_add' },
  sep,
  { label: 'Armature', op: 'object.armature_add' },
  { label: 'Empty', submenu: ADD_EMPTY },
  sep,
  {
    label: 'Light',
    submenu: [
      { label: 'Point', op: 'object.light_add', params: { type: 'POINT' } },
      { label: 'Sun', op: 'object.light_add', params: { type: 'SUN' } },
      { label: 'Spot', op: 'object.light_add', params: { type: 'SPOT' } },
      { label: 'Area', op: 'object.light_add', params: { type: 'AREA' } },
    ],
  },
  { label: 'Camera', op: 'object.camera_add' },
  sep,
  { label: 'Collection Instance', submenu: COLLECTION_INSTANCE_MENU },
  { label: 'Generators', submenu: GENERATORS_MENU },
  sep,
  { label: 'Import…', op: 'wm.import' },
];

const modeIs = (m: string) => () => session.value?.state.mode === m;

export const FILE_MENU = (): MenuItem[] => [
  { label: 'New', op: 'wm.read_homefile', shortcut: 'Ctrl N' },
  { label: 'New (Empty)', op: 'wm.read_homefile', params: { empty: true } },
  { label: 'Open…', op: 'wm.open_mainfile', shortcut: 'Ctrl O' },
  sep,
  { label: 'Save', op: 'wm.save_mainfile', shortcut: 'Ctrl S' },
  { label: 'Copy Share Link', op: 'wm.share' },
  sep,
  { label: 'Import…', op: 'wm.import' },
  {
    label: 'Export',
    submenu: [
      { label: 'glTF 2.0 (.glb)', op: 'wm.export', params: { format: 'glb' } },
      { label: 'glTF 2.0 (.gltf)', op: 'wm.export', params: { format: 'gltf' } },
      { label: 'Wavefront (.obj)', op: 'wm.export', params: { format: 'obj' } },
      { label: 'STL (.stl)', op: 'wm.export', params: { format: 'stl' } },
      { label: 'Stanford PLY (.ply)', op: 'wm.export', params: { format: 'ply' } },
    ],
  },
  sep,
  { label: 'Preferences…', op: 'wm.preferences', shortcut: 'Ctrl ,' },
];

export const EDIT_MENU = (): MenuItem[] => [
  { label: 'Undo', op: 'ed.undo', shortcut: 'Ctrl Z', enabled: () => !!session.value?.undo.canUndo() },
  { label: 'Redo', op: 'ed.redo', shortcut: 'Ctrl Shift Z', enabled: () => !!session.value?.undo.canRedo() },
  sep,
  { label: 'Menu Search…', op: 'wm.search_menu', shortcut: 'F3' },
  sep,
  { label: 'Preferences…', op: 'wm.preferences' },
];

export const RENDER_MENU = (): MenuItem[] => [
  { label: 'Render Image', op: 'render.render', shortcut: 'F12' },
  { label: 'Rendered Shading', op: 'view3d.toggle_shading', params: { type: 'RENDERED' } },
];

export const HELP_MENU = (open: (k: 'shortcuts' | 'about') => void): MenuItem[] => [
  { label: 'Keyboard Shortcuts', action: () => open('shortcuts'), shortcut: 'F1' },
  { label: 'About 3D Editor', action: () => open('about') },
];

export const VIEW_MENU = (): MenuItem[] => [
  {
    label: 'Toolbar',
    op: 'view3d.toggle_toolbar',
    shortcut: 'T',
    checked: () => !!session.value?.view.toolbar.value,
  },
  {
    label: 'Sidebar',
    op: 'view3d.toggle_sidebar',
    shortcut: 'N',
    checked: () => !!session.value?.view.sidebar.value,
  },
  sep,
  { label: 'Frame Selected', op: 'view3d.view_selected', shortcut: 'Numpad .' },
  { label: 'Frame All', op: 'view3d.view_all', shortcut: 'Home' },
  sep,
  { label: 'Camera', op: 'view3d.view_camera', shortcut: 'Numpad 0' },
  { label: 'Align Active Camera to View', op: 'view3d.camera_to_view', shortcut: 'Ctrl Alt Numpad 0' },
  { label: 'Perspective/Orthographic', op: 'view3d.view_persportho', shortcut: 'Numpad 5' },
  {
    label: 'Viewpoint',
    submenu: [
      { label: 'Top', op: 'view3d.view_axis', params: { type: 'TOP' }, shortcut: 'Numpad 7' },
      { label: 'Bottom', op: 'view3d.view_axis', params: { type: 'BOTTOM' }, shortcut: 'Ctrl Numpad 7' },
      { label: 'Front', op: 'view3d.view_axis', params: { type: 'FRONT' }, shortcut: 'Numpad 1' },
      { label: 'Back', op: 'view3d.view_axis', params: { type: 'BACK' }, shortcut: 'Ctrl Numpad 1' },
      { label: 'Right', op: 'view3d.view_axis', params: { type: 'RIGHT' }, shortcut: 'Numpad 3' },
      { label: 'Left', op: 'view3d.view_axis', params: { type: 'LEFT' }, shortcut: 'Ctrl Numpad 3' },
    ],
  },
  sep,
  {
    label: 'X-Ray',
    op: 'view3d.toggle_xray',
    shortcut: 'Alt Z',
    checked: () => !!session.value?.view.xray.value,
  },
  { label: 'Overlays', op: 'view3d.toggle_overlays', checked: () => !!session.value?.view.overlays.value },
  {
    label: 'Wireframe Overlay',
    op: 'view3d.toggle_wireframe_overlay',
    checked: () => !!session.value?.view.showWireframe.value,
  },
  sep,
  { label: 'Play Animation', op: 'screen.animation_play', shortcut: 'Space' },
];

export const SELECT_MENU_OBJECT = (): MenuItem[] => [
  { label: 'All', op: 'object.select_all', params: { action: 'SELECT' }, shortcut: 'A' },
  { label: 'None', op: 'object.select_all', params: { action: 'DESELECT' }, shortcut: 'Alt A' },
  { label: 'Invert', op: 'object.select_all', params: { action: 'INVERT' }, shortcut: 'Ctrl I' },
  sep,
  {
    label: 'Select All by Type',
    submenu: (['MESH', 'EMPTY', 'CAMERA', 'LIGHT'] as const).map((t) => ({
      label: t.charAt(0) + t.slice(1).toLowerCase(),
      op: 'object.select_by_type',
      params: { type: t },
    })),
  },
];

export const SELECT_MENU_EDIT = (): MenuItem[] => [
  { label: 'All', op: 'mesh.select_all', params: { action: 'SELECT' }, shortcut: 'A' },
  { label: 'None', op: 'mesh.select_all', params: { action: 'DESELECT' }, shortcut: 'Alt A' },
  { label: 'Invert', op: 'mesh.select_all', params: { action: 'INVERT' }, shortcut: 'Ctrl I' },
  sep,
  { label: 'More', op: 'mesh.select_more', shortcut: 'Ctrl +' },
  { label: 'Less', op: 'mesh.select_less', shortcut: 'Ctrl -' },
  { label: 'Linked', op: 'mesh.select_linked', shortcut: 'Ctrl L' },
  { label: 'Random', op: 'mesh.select_random' },
  { label: 'Non Manifold', op: 'mesh.select_non_manifold' },
  { label: 'Loose Geometry', op: 'mesh.select_loose' },
  { label: 'Faces Facing Up', op: 'mesh.select_by_normal', params: { direction: [0, 0, 1] } },
];

// ------------------------------------------------------------------ Object menu

export const TRANSFORM_MENU = (): MenuItem[] => [
  { label: 'Move', op: 'view3d.transform_modal', params: { mode: 'translate' }, shortcut: 'G' },
  { label: 'Rotate', op: 'view3d.transform_modal', params: { mode: 'rotate' }, shortcut: 'R' },
  { label: 'Scale', op: 'view3d.transform_modal', params: { mode: 'resize' }, shortcut: 'S' },
  sep,
  { label: 'Randomize Transform', op: 'object.randomize_transform' },
  { label: 'Align Objects', op: 'object.align' },
  { label: 'Set Dimensions', op: 'object.dimensions_set' },
];

/** Object > Apply (also the Ctrl+A popup). */
export const APPLY_MENU = (): MenuItem[] => [
  {
    label: 'Location',
    op: 'object.transform_apply',
    params: { location: true, rotation: false, scale: false },
  },
  {
    label: 'Rotation',
    op: 'object.transform_apply',
    params: { location: false, rotation: true, scale: false },
  },
  {
    label: 'Scale',
    op: 'object.transform_apply',
    params: { location: false, rotation: false, scale: true },
  },
  {
    label: 'All Transforms',
    op: 'object.transform_apply',
    params: { location: true, rotation: true, scale: true },
  },
  sep,
  { label: 'Visual Transform', op: 'object.visual_transform_apply' },
  { label: 'Visual Geometry to Mesh', op: 'object.convert', params: { target: 'MESH' } },
  sep,
  { label: 'Make Instances Real', op: 'object.duplicates_make_real', shortcut: 'Shift Ctrl A' },
];

export const SET_ORIGIN_MENU = (): MenuItem[] => [
  { label: 'Origin to Geometry', op: 'object.origin_set', params: { type: 'ORIGIN_GEOMETRY' } },
  { label: 'Origin to 3D Cursor', op: 'object.origin_set', params: { type: 'ORIGIN_CURSOR' } },
  { label: 'Geometry to Origin', op: 'object.origin_set', params: { type: 'GEOMETRY_ORIGIN' } },
];

/** The active object and the other selected objects of the open project. */
function selection(): { activeId: string | null; others: string[] } {
  const st = session.value?.state;
  const activeId = st?.activeId ?? null;
  return { activeId, others: (st?.selectedIds ?? []).filter((id) => id !== activeId) };
}

/** Object > Parent "Set Parent To" entries; armature-specific ones when the active object is an armature. */
export const PARENT_SET_MENU = (): MenuItem[] => {
  const s = session.value;
  const active = s?.state.activeId ? s.doc.getObject(s.state.activeId) : null;
  const set = (label: string, params: Record<string, unknown>, shortcut?: string): MenuItem => ({
    label,
    op: 'object.parent_set',
    params,
    shortcut,
  });
  const items: MenuItem[] = [
    set('Object', { type: 'OBJECT', keep_transform: true }),
    set('Object (Without Inverse)', { type: 'OBJECT', keep_transform: false }),
  ];
  if (active?.type === 'ARMATURE') {
    const bones = (active.data ? s!.doc.getArmature(active.data)?.bones : null) ?? [];
    items.push(
      sep,
      set('Armature Deform', { type: 'ARMATURE' }),
      set('With Empty Groups', { type: 'ARMATURE_NAME' }),
      set('With Envelope Weights', { type: 'ARMATURE_ENVELOPE' }),
      set('With Automatic Weights', { type: 'ARMATURE_AUTO' }),
      {
        label: 'Bone',
        submenu: bones.length
          ? bones.map((b) => set(b.name, { type: 'BONE', bone: b.name }))
          : [note('The armature has no bones')],
      },
    );
  }
  return items;
};

export const PARENT_CLEAR_MENU = (): MenuItem[] => [
  { label: 'Clear Parent', op: 'object.parent_clear', params: { type: 'CLEAR' } },
  {
    label: 'Clear and Keep Transformation',
    op: 'object.parent_clear',
    params: { type: 'CLEAR_KEEP_TRANSFORM' },
  },
];

const CONSTRAINT_CATEGORIES: [ConstraintCategory, string][] = [
  ['TRANSFORM', 'Transform'],
  ['TRACKING', 'Tracking'],
  ['RELATIONSHIP', 'Relationship'],
];

/**
 * "Add Object Constraint" menu: every object constraint type under Blender's column titles
 * (Transform, Tracking, Relationship). `objectId` is the owner (default: the active object).
 * With `targetId` (Add Constraint with Targets) the constraint gets that target when its type
 * reads one and the target has a suitable type (Follow Path and Clamp To need a curve).
 */
export function constraintAddItems(objectId?: string, targetId?: string | null): MenuItem[] {
  const target = targetId ? session.value?.doc.getObject(targetId) : null;
  const out: MenuItem[] = [];
  for (const [category, title] of CONSTRAINT_CATEGORIES) {
    const types = CONSTRAINT_TYPES.filter((t) => t.category === category && !t.boneOnly);
    if (!types.length) continue;
    out.push({ title });
    for (const t of types) {
      const params: Record<string, unknown> = { type: t.type };
      if (objectId) params.object = objectId;
      if (target && t.target !== 'NONE' && (!t.targetObjectType || t.targetObjectType === target.type))
        params.target = target.id;
      out.push({ label: t.label, op: 'object.constraint_add', params });
    }
  }
  return out;
}

/** Shift+Ctrl+C: constraints for the active object targeting the other selected object. */
export const CONSTRAINT_WITH_TARGETS_MENU = (): MenuItem[] => {
  const { activeId, others } = selection();
  if (!activeId) return [note('No active object')];
  return constraintAddItems(activeId, others[0] ?? null);
};

export const CONSTRAINT_MENU = (): MenuItem[] => [
  {
    label: 'Add Constraint (with Targets)',
    submenu: CONSTRAINT_WITH_TARGETS_MENU,
    shortcut: 'Shift Ctrl C',
  },
  { label: 'Clear Object Constraints', op: 'object.constraints_clear', shortcut: 'Ctrl Alt C' },
];

/** Object > Track: the selected objects track the active one. */
export const TRACK_MENU = (): MenuItem[] => [
  { label: 'Damped Track Constraint', op: 'object.track_set', params: { type: 'DAMPTRACK' } },
  { label: 'Track To Constraint', op: 'object.track_set', params: { type: 'TRACKTO' } },
  { label: 'Lock Track Constraint', op: 'object.track_set', params: { type: 'LOCKTRACK' } },
];

export const RIGID_BODY_MENU = (): MenuItem[] => [
  { label: 'Add Active', op: 'rigidbody.object_add', params: { type: 'ACTIVE' } },
  { label: 'Add Passive', op: 'rigidbody.object_add', params: { type: 'PASSIVE' } },
  { label: 'Remove', op: 'rigidbody.object_remove' },
  sep,
  { label: 'Bake to Keyframes', op: 'rigidbody.bake_to_keyframes' },
  { label: 'Free Cache', op: 'rigidbody.cache_free' },
];

export const CONVERT_MENU = (): MenuItem[] => [
  { label: 'Mesh', op: 'object.convert', params: { target: 'MESH' } },
  { label: 'Curve', op: 'object.convert', params: { target: 'CURVE' } },
];

/** Object > Layout: alignment, placement and scattering tools for the selection. */
export const LAYOUT_MENU = (): MenuItem[] => {
  const { activeId, others } = selection();
  const cursor = session.value?.state.cursorLocation ?? [0, 0, 0];
  return [
    { label: 'Align Objects', op: 'object.align' },
    { label: 'Distribute', op: 'object.distribute' },
    { label: 'Drop to Ground', op: 'object.drop_to_ground' },
    {
      // the surface under (or just above) the 3D cursor, cast straight down
      label: 'Snap to Surface at 3D Cursor',
      op: 'object.snap_to_surface',
      params: { ray_origin: [cursor[0], cursor[1], cursor[2] + 1], ray_direction: [0, 0, -1] },
    },
    sep,
    {
      label: 'Look At Active',
      op: 'object.look_at',
      params: activeId ? { objects: others, target: activeId } : {},
      enabled: () => !!activeId && others.length > 0,
    },
    { label: 'Look At 3D Cursor', op: 'object.look_at', params: { point: [...cursor] } },
    sep,
    { label: 'Randomize Transform', op: 'object.randomize_transform' },
    { label: 'Set Dimensions', op: 'object.dimensions_set' },
    sep,
    { label: 'Array Place', op: 'object.array_place' },
    {
      label: 'Scatter on Surface',
      op: 'object.scatter_on_surface',
      enabled: () => !!activeId && others.length > 0,
    },
  ];
};

export const ANIMATION_MENU = (): MenuItem[] => {
  const s = session.value;
  const active = s?.state.activeId ? s.doc.getObject(s.state.activeId) : null;
  const orbit = active && active.type !== 'CAMERA' ? { target: active.id } : {};
  return [
    { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
    { label: 'Delete Keyframes', op: 'anim.keyframe_delete', shortcut: 'Alt I' },
    { label: 'Clear Keyframes', op: 'anim.keyframe_clear' },
    sep,
    { label: 'Interpolation: Bezier', op: 'anim.interpolation_type', params: { type: 'BEZIER' } },
    { label: 'Interpolation: Linear', op: 'anim.interpolation_type', params: { type: 'LINEAR' } },
    { label: 'Interpolation: Constant', op: 'anim.interpolation_type', params: { type: 'CONSTANT' } },
    {
      // every curve of the selected objects, including their data's (light, camera, a path's
      // Evaluation Time keyed by Animate Path, shape keys) and their materials'
      label: 'Extrapolation',
      submenu: [
        {
          label: 'Constant Extrapolation',
          op: 'anim.extrapolation_set',
          params: { type: 'CONSTANT', include_data: true },
        },
        {
          label: 'Linear Extrapolation',
          op: 'anim.extrapolation_set',
          params: { type: 'LINEAR', include_data: true },
        },
        {
          label: 'Make Cyclic',
          op: 'anim.extrapolation_set',
          params: { type: 'CYCLIC', include_data: true },
        },
      ],
    },
    sep,
    { label: 'Camera Turntable', op: 'anim.turntable', params: orbit },
    { label: 'Bake Action', op: 'anim.bake_transforms' },
  ];
};

export const OBJECT_MENU = (): MenuItem[] => [
  { label: 'Transform', submenu: TRANSFORM_MENU },
  { label: 'Apply', submenu: APPLY_MENU, shortcut: 'Ctrl A' },
  {
    label: 'Clear',
    submenu: [
      { label: 'Location', op: 'object.location_clear', shortcut: 'Alt G' },
      { label: 'Rotation', op: 'object.rotation_clear', shortcut: 'Alt R' },
      { label: 'Scale', op: 'object.scale_clear', shortcut: 'Alt S' },
    ],
  },
  { label: 'Set Origin', submenu: SET_ORIGIN_MENU },
  { label: 'Snap', submenu: () => SNAP_MENU() },
  { label: 'Layout', submenu: LAYOUT_MENU },
  sep,
  { label: 'Duplicate Objects', op: 'object.duplicate_move', shortcut: 'Shift D' },
  { label: 'Duplicate Linked', op: 'object.duplicate_move', params: { linked: true }, shortcut: 'Alt D' },
  { label: 'Join', op: 'object.join', shortcut: 'Ctrl J' },
  sep,
  {
    label: 'Parent',
    submenu: () => [...PARENT_SET_MENU(), sep, ...PARENT_CLEAR_MENU()],
    shortcut: 'Ctrl P',
  },
  { label: 'Constraint', submenu: CONSTRAINT_MENU },
  { label: 'Track', submenu: TRACK_MENU, shortcut: 'Shift Ctrl T' },
  {
    label: 'Move to Collection',
    op: 'object.move_to_collection',
    params: { new_collection_name: 'Collection' },
    shortcut: 'M',
  },
  sep,
  { label: 'Rigid Body', submenu: RIGID_BODY_MENU },
  { label: 'Convert', submenu: CONVERT_MENU },
  sep,
  { label: 'Shade Smooth', op: 'object.shade_smooth' },
  { label: 'Shade Auto Smooth', op: 'object.shade_auto_smooth' },
  { label: 'Shade Flat', op: 'object.shade_flat' },
  sep,
  { label: 'Animation', submenu: ANIMATION_MENU },
  {
    label: 'Show/Hide',
    submenu: [
      { label: 'Show Hidden Objects', op: 'object.hide_view_clear', shortcut: 'Alt H' },
      { label: 'Hide Selected', op: 'object.hide_view_set', shortcut: 'H' },
      {
        label: 'Hide Unselected',
        op: 'object.hide_view_set',
        params: { unselected: true },
        shortcut: 'Shift H',
      },
    ],
  },
  sep,
  { label: 'Delete', op: 'object.delete', shortcut: 'X' },
];

export const SNAP_MENU = (): MenuItem[] => [
  { title: 'Snap' },
  { label: 'Selection to Cursor', op: 'view3d.snap_selected_to_cursor' },
  {
    label: 'Selection to Cursor (Keep Offset)',
    op: 'view3d.snap_selected_to_cursor',
    params: { use_offset: true },
  },
  { label: 'Selection to Grid', op: 'view3d.snap_selected_to_grid' },
  sep,
  { label: 'Cursor to Selected', op: 'view3d.snap_cursor_to_selected' },
  { label: 'Cursor to World Origin', op: 'view3d.snap_cursor_to_center' },
  { label: 'Cursor to Active', op: 'view3d.snap_cursor_to_active' },
];

export const MESH_MENU = (): MenuItem[] => [
  {
    label: 'Transform',
    submenu: [
      { label: 'Move', op: 'view3d.transform_modal', params: { mode: 'translate' }, shortcut: 'G' },
      { label: 'Rotate', op: 'view3d.transform_modal', params: { mode: 'rotate' }, shortcut: 'R' },
      { label: 'Scale', op: 'view3d.transform_modal', params: { mode: 'resize' }, shortcut: 'S' },
      { label: 'Smooth Vertices', op: 'mesh.vertices_smooth' },
    ],
  },
  { label: 'Snap', submenu: () => SNAP_MENU() },
  sep,
  { label: 'Duplicate', op: 'mesh.duplicate_move', shortcut: 'Shift D' },
  { label: 'Extrude Region', op: 'mesh.extrude_region_shrink_fatten', params: { value: 0.5 }, shortcut: 'E' },
  { label: 'Extrude Individual Faces', op: 'mesh.extrude_faces_move', params: { value: 0.5 } },
  { label: 'Inset Faces', op: 'mesh.inset', shortcut: 'I' },
  { label: 'Bevel', op: 'mesh.bevel', shortcut: 'Ctrl B' },
  { label: 'Loop Cut', op: 'mesh.loopcut_pick', shortcut: 'Ctrl R' },
  { label: 'Subdivide', op: 'mesh.subdivide' },
  { label: 'Poke Faces', op: 'mesh.poke' },
  { label: 'Solidify', op: 'mesh.solidify' },
  { label: 'Spin', op: 'mesh.spin' },
  { label: 'Bridge Edge Loops', op: 'mesh.bridge_edge_loops' },
  { label: 'Symmetrize', op: 'mesh.symmetrize' },
  sep,
  { label: 'Fill (New Face/Edge)', op: 'mesh.edge_face_add', shortcut: 'F' },
  { label: 'Fill Holes', op: 'mesh.fill' },
  { label: 'Merge', submenu: () => MERGE_MENU() },
  { label: 'Split', op: 'mesh.split', shortcut: 'Y' },
  { label: 'Separate', submenu: () => SEPARATE_MENU() },
  sep,
  { label: 'Triangulate Faces', op: 'mesh.quads_convert_to_tris', shortcut: 'Ctrl T' },
  { label: 'Tris to Quads', op: 'mesh.tris_convert_to_quads', shortcut: 'Alt J' },
  {
    label: 'Normals',
    submenu: [
      { label: 'Flip', op: 'mesh.flip_normals' },
      {
        label: 'Recalculate Outside',
        op: 'mesh.normals_make_consistent',
        params: { inside: false },
        shortcut: 'Shift N',
      },
      { label: 'Recalculate Inside', op: 'mesh.normals_make_consistent', params: { inside: true } },
    ],
  },
  {
    label: 'Edges',
    submenu: [
      { label: 'Mark Seam', op: 'mesh.mark_seam' },
      { label: 'Clear Seam', op: 'mesh.mark_seam', params: { clear: true } },
      { label: 'Mark Sharp', op: 'mesh.mark_sharp' },
      { label: 'Clear Sharp', op: 'mesh.mark_sharp', params: { clear: true } },
      { label: 'Edge Crease 1.0', op: 'transform.edge_crease', params: { value: 1 } },
      { label: 'Clear Crease', op: 'transform.edge_crease', params: { value: 0 } },
    ],
  },
  { label: 'UV', submenu: () => UV_MENU() },
  sep,
  { label: 'Delete', submenu: () => DELETE_MENU() },
];

export const UV_MENU = (): MenuItem[] => [
  { title: 'UV' },
  { label: 'Unwrap', op: 'uv.unwrap' },
  { label: 'Smart UV Project', op: 'uv.smart_project' },
  { label: 'Cube Projection', op: 'uv.cube_project' },
  { label: 'Cylinder Projection', op: 'uv.cylinder_project' },
  { label: 'Sphere Projection', op: 'uv.sphere_project' },
  { label: 'Reset', op: 'uv.reset' },
];

export const DELETE_MENU = (): MenuItem[] => [
  { title: 'Delete' },
  { label: 'Vertices', op: 'mesh.delete', params: { type: 'VERT' } },
  { label: 'Edges', op: 'mesh.delete', params: { type: 'EDGE' } },
  { label: 'Faces', op: 'mesh.delete', params: { type: 'FACE' } },
  { label: 'Only Edges & Faces', op: 'mesh.delete', params: { type: 'EDGE_FACE' } },
  { label: 'Only Faces', op: 'mesh.delete', params: { type: 'ONLY_FACE' } },
  sep,
  { label: 'Dissolve Vertices', op: 'mesh.dissolve_verts' },
  { label: 'Dissolve Edges', op: 'mesh.dissolve_edges' },
  { label: 'Dissolve Faces', op: 'mesh.dissolve_faces' },
];

export const MERGE_MENU = (): MenuItem[] => [
  { title: 'Merge' },
  { label: 'At Center', op: 'mesh.merge', params: { type: 'CENTER' } },
  { label: 'At Cursor', op: 'mesh.merge', params: { type: 'CURSOR' } },
  { label: 'Collapse', op: 'mesh.merge', params: { type: 'COLLAPSE' } },
  { label: 'At First', op: 'mesh.merge', params: { type: 'FIRST' } },
  { label: 'At Last', op: 'mesh.merge', params: { type: 'LAST' } },
  sep,
  { label: 'By Distance', op: 'mesh.remove_doubles' },
];

export const SEPARATE_MENU = (): MenuItem[] => [
  { title: 'Separate' },
  { label: 'Selection', op: 'mesh.separate', params: { type: 'SELECTED' } },
  { label: 'By Material', op: 'mesh.separate', params: { type: 'MATERIAL' } },
  { label: 'By Loose Parts', op: 'mesh.separate', params: { type: 'LOOSE' } },
];

export const SHADING_MENU = (): MenuItem[] => [
  { title: 'Shading' },
  {
    label: 'Wireframe',
    op: 'view3d.toggle_shading',
    params: { type: 'WIREFRAME' },
    checked: () => session.value?.view.shading.value === 'WIREFRAME',
  },
  {
    label: 'Solid',
    op: 'view3d.toggle_shading',
    params: { type: 'SOLID' },
    checked: () => session.value?.view.shading.value === 'SOLID',
  },
  {
    label: 'Material Preview',
    op: 'view3d.toggle_shading',
    params: { type: 'MATERIAL' },
    checked: () => session.value?.view.shading.value === 'MATERIAL',
  },
  {
    label: 'Rendered',
    op: 'view3d.toggle_shading',
    params: { type: 'RENDERED' },
    checked: () => session.value?.view.shading.value === 'RENDERED',
  },
];

export const VIEW_PIE = (): MenuItem[] => [
  { title: 'View' },
  { label: 'Top', op: 'view3d.view_axis', params: { type: 'TOP' } },
  { label: 'Bottom', op: 'view3d.view_axis', params: { type: 'BOTTOM' } },
  { label: 'Front', op: 'view3d.view_axis', params: { type: 'FRONT' } },
  { label: 'Back', op: 'view3d.view_axis', params: { type: 'BACK' } },
  { label: 'Right', op: 'view3d.view_axis', params: { type: 'RIGHT' } },
  { label: 'Left', op: 'view3d.view_axis', params: { type: 'LEFT' } },
  sep,
  { label: 'Camera', op: 'view3d.view_camera' },
  { label: 'View Selected', op: 'view3d.view_selected' },
];

export const OBJECT_CONTEXT = (): MenuItem[] => [
  { title: 'Object' },
  { label: 'Shade Smooth', op: 'object.shade_smooth' },
  { label: 'Shade Auto Smooth', op: 'object.shade_auto_smooth' },
  { label: 'Shade Flat', op: 'object.shade_flat' },
  { label: 'Convert To', submenu: CONVERT_MENU },
  sep,
  { label: 'Set Origin', submenu: SET_ORIGIN_MENU },
  { label: 'Snap', submenu: () => SNAP_MENU() },
  sep,
  { label: 'Duplicate Objects', op: 'object.duplicate_move' },
  { label: 'Duplicate Linked', op: 'object.duplicate_move', params: { linked: true } },
  { label: 'Copy Share Link', op: 'wm.share' },
  sep,
  { label: 'Parent', submenu: () => [...PARENT_SET_MENU(), sep, ...PARENT_CLEAR_MENU()] },
  { label: 'Rigid Body', submenu: RIGID_BODY_MENU },
  sep,
  { label: 'Insert Keyframe', op: 'anim.keyframe_insert' },
  { label: 'Delete', op: 'object.delete' },
];

export const MESH_CONTEXT = (): MenuItem[] => {
  const mode = session.value?.state.selectMode;
  const base: MenuItem[] = [{ title: mode === 'VERT' ? 'Vertex' : mode === 'EDGE' ? 'Edge' : 'Face' }];
  if (mode === 'FACE')
    base.push(
      { label: 'Extrude Faces', op: 'mesh.extrude_region_shrink_fatten', params: { value: 0.5 } },
      { label: 'Extrude Individual', op: 'mesh.extrude_faces_move', params: { value: 0.5 } },
      { label: 'Inset Faces', op: 'mesh.inset' },
      { label: 'Poke Faces', op: 'mesh.poke' },
      { label: 'Triangulate', op: 'mesh.quads_convert_to_tris' },
    );
  else if (mode === 'EDGE')
    base.push(
      { label: 'Subdivide', op: 'mesh.subdivide' },
      { label: 'Bevel Edges', op: 'mesh.bevel' },
      { label: 'Bridge Edge Loops', op: 'mesh.bridge_edge_loops' },
      { label: 'Mark Seam', op: 'mesh.mark_seam' },
      { label: 'Mark Sharp', op: 'mesh.mark_sharp' },
    );
  else
    base.push(
      { label: 'Extrude Vertices', op: 'mesh.extrude_vertices_move', params: { value: [0, 0, 0.5] } },
      { label: 'Bevel Vertices', op: 'mesh.bevel', params: { affect: 'VERTICES' } },
      { label: 'New Edge/Face from Vertices', op: 'mesh.edge_face_add' },
      { label: 'Merge Vertices', submenu: () => MERGE_MENU() },
      { label: 'Smooth Vertices', op: 'mesh.vertices_smooth' },
    );
  base.push(sep, { label: 'Delete', submenu: () => DELETE_MENU() });
  return base;
};

/** Popup menus opened by name (`wm.call_menu`: Shift+A, Ctrl+P, Shift+Ctrl+C, RMB …). */
export function menuByName(name: string): MenuItem[] {
  const s = session.value;
  switch (name) {
    case 'add':
      return ADD_MENU;
    case 'snap':
      return SNAP_MENU();
    case 'delete':
      return DELETE_MENU();
    case 'merge':
      return MERGE_MENU();
    case 'separate':
      return SEPARATE_MENU();
    case 'uv':
      return UV_MENU();
    case 'shading':
      return SHADING_MENU();
    case 'view':
      return VIEW_PIE();
    case 'context':
      return s?.state.mode === 'EDIT' ? MESH_CONTEXT() : OBJECT_CONTEXT();
    case 'apply':
      return [{ title: 'Apply' }, ...APPLY_MENU()];
    case 'parent':
      return [{ title: 'Set Parent To' }, ...PARENT_SET_MENU()];
    case 'parent_clear':
      return [{ title: 'Clear Parent' }, ...PARENT_CLEAR_MENU()];
    case 'constraint_add_targets':
      return [{ title: 'Add Constraint (with Targets)' }, ...CONSTRAINT_WITH_TARGETS_MENU()];
    case 'track':
      return [{ title: 'Track' }, ...TRACK_MENU()];
    case 'generators':
      return [{ title: 'Generators' }, ...GENERATORS_MENU()];
    default:
      return [];
  }
}

/** Hides menu entries for operators that are not registered (keeps menus honest). */
export function availableItems(items: MenuItem[]): MenuItem[] {
  return items.filter((i) => !i.op || registry.has(i.op));
}

export { modeIs };
