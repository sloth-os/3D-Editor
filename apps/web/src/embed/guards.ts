import type { OperatorContext, OperatorRegistry } from '@3d-editor/core';

/*
 * What the embedded desk does not run (docs/embedding.md, "Starting" and "Read-only"): the
 * operators of the editor chrome it hides (new and open project, preferences, search, share,
 * workspaces, the render and export windows, import), and, in a read-only open, every operator
 * that changes the scene. The registry's poll refuses them, so menus grey them out and every way
 * of running them (keys, buttons, menus, the viewport's tools) fails with the reason: the
 * operators themselves are off, not only their buttons.
 */

/** Operators of chrome the desk hides: never run in the desk. */
export const DESK_HIDDEN_OPERATORS: ReadonlySet<string> = new Set([
  'wm.read_homefile',
  'wm.open_mainfile',
  'wm.save_mainfile',
  'wm.preferences',
  'wm.search_menu',
  'wm.share',
  'wm.export',
  'wm.import',
  'wm.export_video',
  'screen.workspace_set',
  'render.render',
  'render.render_animation',
  'render.render_software',
]);

/**
 * Operators that do not change the scene themselves (undo: false) but start a change (a modal move,
 * a loop cut, a repeat) or step its history: off in a read-only open, like every operator that
 * changes the scene.
 */
export const READ_ONLY_EXTRA: ReadonlySet<string> = new Set([
  'view3d.transform_modal',
  'mesh.loopcut_pick',
  'sculpt.commit_stroke',
  'screen.repeat_last',
  'ed.undo',
  'ed.redo',
]);

export const HIDDEN_REASON = 'not available in the embedded desk';
export const READ_ONLY_REASON = 'the scene is read-only here: view, play and export only';

/** Why the desk refuses operator `id` now (null: it may run). */
export function deskRefusal(
  registry: Pick<OperatorRegistry, 'get'>,
  id: string,
  readOnly: boolean,
): string | null {
  if (DESK_HIDDEN_OPERATORS.has(id)) return `${id} is ${HIDDEN_REASON}`;
  if (!readOnly) return null;
  const def = registry.get(id);
  if (!def) return null;
  if (def.undo !== false || READ_ONLY_EXTRA.has(id)) return `${def.label}: ${READ_ONLY_REASON}`;
  return null;
}

/**
 * Makes `registry` refuse, in its poll, what the desk does not run (see deskRefusal); `readOnly`
 * is read at every poll. Returns the undo of the guard.
 */
export function guardRegistry(registry: OperatorRegistry, readOnly: () => boolean): () => void {
  const own = Object.prototype.hasOwnProperty.call(registry, 'poll');
  const base = registry.poll;
  const poll = (ctx: OperatorContext, id: string): true | string =>
    deskRefusal(registry, id, readOnly()) ?? base.call(registry, ctx, id);
  (registry as { poll: typeof poll }).poll = poll;
  return () => {
    if (own) (registry as { poll: typeof poll }).poll = base;
    else delete (registry as { poll?: typeof poll }).poll;
  };
}

/** Keys of the editor that open chrome the desk hides: the desk's keymap ignores them. */
export const DESK_IGNORED_KEYS: ReadonlySet<string> = new Set([
  'Ctrl+N',
  'Ctrl+O',
  'Ctrl+S',
  'Ctrl+,',
  'F1',
  'F3',
  'F12',
  'Ctrl+F12',
  'Ctrl+Shift+F12',
]);
