import { session, openDialog, dialog } from '../app/store';
import { hoveredArea, paletteOpen, popupMenu, run, viewport } from './editor';
import { lastOperator, redoLast } from './runner';
import { registry } from './editor';

/**
 * Blender-style keymap. Keys are resolved per hovered area; viewport keys depend on the mode.
 * Numpad keys work directly; on keyboards without a numpad the number row emulates it in
 * Object Mode (in Edit Mode 1/2/3 switch vertex/edge/face select mode, like Blender).
 */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

type Handler = (e: KeyboardEvent) => boolean | void;

function combo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.code.startsWith('Numpad') ? e.code : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (k === ' ') k = 'Space';
  if (e.code === 'Space') k = 'Space';
  parts.push(k);
  return parts.join('+');
}

const NUMPAD_VIEWS: Record<string, () => void> = {
  Numpad1: () => run('view3d.view_axis', { type: 'FRONT' }, 'hotkey'),
  'Ctrl+Numpad1': () => run('view3d.view_axis', { type: 'BACK' }, 'hotkey'),
  Numpad3: () => run('view3d.view_axis', { type: 'RIGHT' }, 'hotkey'),
  'Ctrl+Numpad3': () => run('view3d.view_axis', { type: 'LEFT' }, 'hotkey'),
  Numpad7: () => run('view3d.view_axis', { type: 'TOP' }, 'hotkey'),
  'Ctrl+Numpad7': () => run('view3d.view_axis', { type: 'BOTTOM' }, 'hotkey'),
  Numpad5: () => run('view3d.view_persportho', {}, 'hotkey'),
  Numpad0: () => run('view3d.view_camera', {}, 'hotkey'),
  'Ctrl+Numpad0': () => run('view3d.object_as_camera', {}, 'hotkey'),
  'Ctrl+Alt+Numpad0': () => run('view3d.camera_to_view', {}, 'hotkey'),
  NumpadDecimal: () => run('view3d.view_selected', {}, 'hotkey'),
  Numpad4: () => run('view3d.view_orbit', { type: 'ORBITLEFT' }, 'hotkey'),
  Numpad6: () => run('view3d.view_orbit', { type: 'ORBITRIGHT' }, 'hotkey'),
  Numpad8: () => run('view3d.view_orbit', { type: 'ORBITUP' }, 'hotkey'),
  Numpad2: () => run('view3d.view_orbit', { type: 'ORBITDOWN' }, 'hotkey'),
  NumpadAdd: () => run('view3d.zoom', { delta: 1 }, 'hotkey'),
  NumpadSubtract: () => run('view3d.zoom', { delta: -1 }, 'hotkey'),
};

const EMULATED_NUMPAD: Record<string, string> = {
  '1': 'Numpad1',
  'Ctrl+1': 'Ctrl+Numpad1',
  '3': 'Numpad3',
  'Ctrl+3': 'Ctrl+Numpad3',
  '7': 'Numpad7',
  'Ctrl+7': 'Ctrl+Numpad7',
  '5': 'Numpad5',
  '0': 'Numpad0',
  'Ctrl+0': 'Ctrl+Numpad0',
  'Ctrl+Alt+0': 'Ctrl+Alt+Numpad0',
};

const GLOBAL: Record<string, Handler> = {
  'Ctrl+Z': () => run('ed.undo', {}, 'hotkey'),
  'Ctrl+Shift+Z': () => run('ed.redo', {}, 'hotkey'),
  'Ctrl+Y': () => run('ed.redo', {}, 'hotkey'),
  'Ctrl+S': () => run('wm.save_mainfile', {}, 'hotkey'),
  'Ctrl+N': () => run('wm.read_homefile', {}, 'hotkey'),
  'Ctrl+O': () => run('wm.open_mainfile', {}, 'hotkey'),
  'Ctrl+,': () => run('wm.preferences', {}, 'hotkey'),
  F3: () => run('wm.search_menu', {}, 'hotkey'),
  F12: () => run('render.render', {}, 'hotkey'),
  F1: () => openDialog('shortcuts'),
  'Shift+R': () => {
    const last = lastOperator.value;
    if (last && session.value) redoLast(session.value, registry, last.params);
  },
  Space: () => run('screen.animation_play', {}, 'hotkey'),
  'Shift+ArrowLeft': () => run('screen.frame_jump', { end: false }, 'hotkey'),
  'Shift+ArrowRight': () => run('screen.frame_jump', { end: true }, 'hotkey'),
  ArrowLeft: () => run('screen.frame_offset', { delta: -1 }, 'hotkey'),
  ArrowRight: () => run('screen.frame_offset', { delta: 1 }, 'hotkey'),
  ArrowUp: () => run('screen.keyframe_jump', { next: true }, 'hotkey'),
  ArrowDown: () => run('screen.keyframe_jump', { next: false }, 'hotkey'),
};

const VIEWPORT_COMMON: Record<string, Handler> = {
  G: () => run('view3d.transform_modal', { mode: 'translate' }, 'hotkey'),
  R: () => run('view3d.transform_modal', { mode: 'rotate' }, 'hotkey'),
  S: () => run('view3d.transform_modal', { mode: 'resize' }, 'hotkey'),
  Home: () => run('view3d.view_all', {}, 'hotkey'),
  N: () => run('view3d.toggle_sidebar', {}, 'hotkey'),
  T: () => run('view3d.toggle_toolbar', {}, 'hotkey'),
  'Alt+Z': () => run('view3d.toggle_xray', {}, 'hotkey'),
  'Shift+Z': () => run('view3d.toggle_shading', { type: 'WIREFRAME' }, 'hotkey'),
  Z: () => run('wm.call_menu', { name: 'shading' }, 'hotkey'),
  '`': () => run('wm.call_menu', { name: 'view' }, 'hotkey'),
  'Shift+S': () => run('wm.call_menu', { name: 'snap' }, 'hotkey'),
  'Shift+A': () => run('wm.call_menu', { name: 'add' }, 'hotkey'),
  'Shift+C': () => {
    run('view3d.snap_cursor_to_center', {}, 'hotkey');
    run('view3d.view_all', {}, 'hotkey');
  },
  'Shift+Tab': () => run('view3d.toggle_snapping', {}, 'hotkey'),
  Tab: () => run('object.mode_set', { mode: 'EDIT', toggle: true }, 'hotkey'),
  'Ctrl+Tab': () => {
    const m = session.value?.state.mode;
    run('object.mode_set', { mode: m === 'SCULPT' ? 'OBJECT' : 'SCULPT' }, 'hotkey');
  },
  W: () => {
    const v = session.value?.view;
    if (!v) return;
    const order = ['select', 'move', 'rotate', 'scale', 'cursor'] as const;
    const i = order.indexOf(v.tool.value as (typeof order)[number]);
    v.tool.value = order[(i + 1) % order.length];
  },
};

const OBJECT_MODE: Record<string, Handler> = {
  A: () => run('object.select_all', { action: 'SELECT' }, 'hotkey'),
  'Alt+A': () => run('object.select_all', { action: 'DESELECT' }, 'hotkey'),
  'Ctrl+I': () => run('object.select_all', { action: 'INVERT' }, 'hotkey'),
  X: () => run('object.delete', {}, 'hotkey'),
  Delete: () => run('object.delete', {}, 'hotkey'),
  'Shift+D': () => run('object.duplicate_move', {}, 'hotkey'),
  'Alt+D': () => run('object.duplicate_move', { linked: true }, 'hotkey'),
  H: () => run('object.hide_view_set', {}, 'hotkey'),
  'Shift+H': () => run('object.hide_view_set', { unselected: true }, 'hotkey'),
  'Alt+H': () => run('object.hide_view_clear', {}, 'hotkey'),
  'Ctrl+P': () => run('object.parent_set', {}, 'hotkey'),
  'Alt+P': () => run('object.parent_clear', { type: 'CLEAR_KEEP_TRANSFORM' }, 'hotkey'),
  'Alt+G': () => run('object.location_clear', {}, 'hotkey'),
  'Alt+R': () => run('object.rotation_clear', {}, 'hotkey'),
  'Alt+S': () => run('object.scale_clear', {}, 'hotkey'),
  'Ctrl+A': () => run('wm.call_menu', { name: 'apply' }, 'hotkey'),
  'Ctrl+J': () => run('object.join', {}, 'hotkey'),
  M: () => run('object.move_to_collection', { new_collection_name: 'Collection' }, 'hotkey'),
  I: () => run('anim.keyframe_insert', {}, 'hotkey'),
  'Alt+I': () => run('anim.keyframe_delete', {}, 'hotkey'),
};

const EDIT_MODE: Record<string, Handler> = {
  '1': () => run('mesh.select_mode', { type: 'VERT' }, 'hotkey'),
  '2': () => run('mesh.select_mode', { type: 'EDGE' }, 'hotkey'),
  '3': () => run('mesh.select_mode', { type: 'FACE' }, 'hotkey'),
  A: () => run('mesh.select_all', { action: 'SELECT' }, 'hotkey'),
  'Alt+A': () => run('mesh.select_all', { action: 'DESELECT' }, 'hotkey'),
  'Ctrl+I': () => run('mesh.select_all', { action: 'INVERT' }, 'hotkey'),
  'Ctrl+L': () => run('mesh.select_linked', {}, 'hotkey'),
  'Ctrl+=': () => run('mesh.select_more', {}, 'hotkey'),
  'Ctrl++': () => run('mesh.select_more', {}, 'hotkey'),
  'Ctrl+-': () => run('mesh.select_less', {}, 'hotkey'),
  'Ctrl+NumpadAdd': () => run('mesh.select_more', {}, 'hotkey'),
  'Ctrl+NumpadSubtract': () => run('mesh.select_less', {}, 'hotkey'),
  X: () => run('wm.call_menu', { name: 'delete' }, 'hotkey'),
  Delete: () => run('wm.call_menu', { name: 'delete' }, 'hotkey'),
  E: () => {
    if (run('mesh.extrude_region_move', { value: [0, 0, 0] }, 'hotkey'))
      run('view3d.transform_modal', { mode: 'translate' }, 'hotkey');
  },
  I: () => run('mesh.inset', {}, 'hotkey'),
  'Ctrl+B': () => run('mesh.bevel', {}, 'hotkey'),
  'Ctrl+R': () => run('mesh.loopcut_pick', {}, 'hotkey'),
  F: () => run('mesh.edge_face_add', {}, 'hotkey'),
  M: () => run('wm.call_menu', { name: 'merge' }, 'hotkey'),
  P: () => run('wm.call_menu', { name: 'separate' }, 'hotkey'),
  U: () => run('wm.call_menu', { name: 'uv' }, 'hotkey'),
  Y: () => run('mesh.split', {}, 'hotkey'),
  'Shift+D': () => {
    if (run('mesh.duplicate_move', {}, 'hotkey'))
      run('view3d.transform_modal', { mode: 'translate' }, 'hotkey');
  },
  'Ctrl+T': () => run('mesh.quads_convert_to_tris', {}, 'hotkey'),
  'Alt+J': () => run('mesh.tris_convert_to_quads', {}, 'hotkey'),
  'Shift+N': () => run('mesh.normals_make_consistent', { inside: false }, 'hotkey'),
  O: () => {
    const st = session.value?.state;
    if (st) st.proportionalEditing = !st.proportionalEditing;
  },
};

function handle(map: Record<string, Handler>, key: string, e: KeyboardEvent): boolean {
  const h = map[key];
  if (!h) return false;
  const r = h(e);
  return r !== false;
}

export function installKeymap(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e) || (e.repeat && !['ArrowLeft', 'ArrowRight'].includes(e.key))) return;
    // modal transform swallows keys
    if (viewport.interaction?.modal) {
      if (viewport.interaction.modalKey(e)) e.preventDefault();
      return;
    }
    if (paletteOpen.value || popupMenu.value) {
      if (e.key === 'Escape') {
        paletteOpen.value = false;
        popupMenu.value = null;
      }
      return;
    }
    if (dialog.value) return;
    const key = combo(e);
    if (handle(GLOBAL, key, e)) {
      e.preventDefault();
      return;
    }
    const s = session.value;
    if (!s) return;
    if (hoveredArea.value !== 'viewport') return;
    if (NUMPAD_VIEWS[key]) {
      NUMPAD_VIEWS[key]();
      e.preventDefault();
      return;
    }
    const mode = s.state.mode;
    if (mode === 'EDIT' && handle(EDIT_MODE, key, e)) {
      e.preventDefault();
      return;
    }
    if (mode === 'OBJECT') {
      const emu = EMULATED_NUMPAD[key];
      if (emu && NUMPAD_VIEWS[emu]) {
        NUMPAD_VIEWS[emu]();
        e.preventDefault();
        return;
      }
      if (handle(OBJECT_MODE, key, e)) {
        e.preventDefault();
        return;
      }
    }
    if (handle(VIEWPORT_COMMON, key, e)) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/** Shortcut reference shown in the Help dialog. */
export const SHORTCUT_HELP: [string, string][] = [
  [
    'Navigation',
    'MMB drag orbit · Shift+MMB pan · Wheel/Ctrl+MMB zoom · Alt+LMB emulates MMB · touch: 1 finger orbit, 2 fingers pan/zoom',
  ],
  [
    'Views',
    'Numpad 1/3/7 (Ctrl = opposite) · 5 persp/ortho · 0 camera · . frame selected · Home frame all · ` view menu',
  ],
  [
    'Select',
    'LMB click/drag box · Shift extend · Ctrl subtract · A all · Alt+A none · Ctrl+I invert · Alt+click edge loop',
  ],
  [
    'Transform',
    'G move · R rotate · S scale · then X/Y/Z axis (Shift = plane) · type numbers · Ctrl snap · Shift precision',
  ],
  [
    'Object',
    'Shift+A add · X delete · Shift+D duplicate · Alt+D linked · Ctrl+J join · Ctrl+P parent · H hide · Ctrl+A apply',
  ],
  [
    'Edit Mode',
    'Tab toggle · 1/2/3 vert/edge/face · E extrude · I inset · Ctrl+B bevel · Ctrl+R loop cut · F fill · M merge · X delete',
  ],
  [
    'Animation',
    'I insert keyframe · Alt+I delete · Space play · ←/→ frame · ↑/↓ keyframes · Shift+←/→ start/end',
  ],
  [
    'General',
    'Ctrl+Z undo · Ctrl+Shift+Z redo · F3 search · F12 render · Ctrl+S save · Shift+R repeat last · N sidebar · T toolbar',
  ],
];
