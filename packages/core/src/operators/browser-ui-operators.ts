/**
 * Ids of the operators the browser editor registers for its user interface only
 * (apps/web/src/editor/ui-operators.ts, `uiOnly: true`): viewport navigation, playback, tools,
 * windows and dialogs, the editor's own undo history. Registries without a UI (the server's, made
 * by `createOperatorRegistry`) do not have them, so the MCP server recognises these ids and
 * tells agents to run them in a live editor (editor_command `run_operator`) instead of answering
 * "unknown operator". apps/web/test/browser-ui-operators.test.ts fails when the web app registers
 * a different set: keep the two in sync.
 */
export const BROWSER_UI_OPERATORS: readonly string[] = [
  'ed.redo',
  'ed.undo',
  'mesh.loopcut_pick',
  'object.duplicate_move',
  'render.render',
  'screen.animation_play',
  'screen.frame_offset',
  'screen.keyframe_jump',
  'screen.repeat_last',
  'screen.workspace_set',
  'sculpt.commit_stroke',
  'view3d.camera_to_view',
  'view3d.object_as_camera',
  'view3d.toggle_overlays',
  'view3d.toggle_shading',
  'view3d.toggle_sidebar',
  'view3d.toggle_snapping',
  'view3d.toggle_toolbar',
  'view3d.toggle_wireframe_overlay',
  'view3d.toggle_xray',
  'view3d.transform_modal',
  'view3d.view_all',
  'view3d.view_axis',
  'view3d.view_camera',
  'view3d.view_orbit',
  'view3d.view_persportho',
  'view3d.view_selected',
  'view3d.zoom',
  'wm.call_menu',
  'wm.export',
  'wm.import',
  'wm.open_mainfile',
  'wm.preferences',
  'wm.read_homefile',
  'wm.save_mainfile',
  'wm.search_menu',
  'wm.share',
  'wm.tool_set',
];
