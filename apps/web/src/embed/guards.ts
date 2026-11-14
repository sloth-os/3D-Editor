import type { OperatorContext, OperatorRegistry } from '@3d-editor/core';
import { pageGuard } from '../editor/page-guard';

/*
 * What the embedded desk does not run (docs/embedding.md, "Starting" and "Read-only"): the
 * operators of the editor chrome it hides (new and open project, preferences, search, share,
 * workspaces, the render and export windows, import), and, in a read-only open, every operator
 * that changes the scene. The registry's poll refuses them, so every way of running them (keys,
 * buttons, menus, the viewport's tools, a file dropped on the viewport) fails with the reason: the
 * operators themselves are off, not only their buttons. The guard tells the editor's UI too
 * (editor/page-guard.ts): menus grey them out with the reason, a slider drag writes no live value,
 * and a dropped model file is refused before it is read.
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
 * a duplicate and move, a loop cut, a repeat) or step its history: off in a read-only open, like
 * every operator that changes the scene.
 */
export const READ_ONLY_EXTRA: ReadonlySet<string> = new Set([
  'view3d.transform_modal',
  'object.duplicate_move',
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
 * Makes `registry` refuse, in its poll, what the desk does not run (see deskRefusal), and says so
 * to the editor's UI (editor/page-guard.ts); `readOnly` is read at every poll. Returns the undo of
 * the guard.
 */
export function guardRegistry(registry: OperatorRegistry, readOnly: () => boolean): () => void {
  const own = Object.prototype.hasOwnProperty.call(registry, 'poll');
  const base = registry.poll;
  const refusal = (id: string): string | null => deskRefusal(registry, id, readOnly());
  const poll = (ctx: OperatorContext, id: string): true | string =>
    refusal(id) ?? base.call(registry, ctx, id);
  (registry as { poll: typeof poll }).poll = poll;
  const before = pageGuard.refusal;
  pageGuard.refusal = refusal;
  return () => {
    if (own) (registry as { poll: typeof poll }).poll = base;
    else delete (registry as { poll?: typeof poll }).poll;
    if (pageGuard.refusal === refusal) pageGuard.refusal = before;
  };
}

/**
 * Keys of the editor that open chrome the desk hides: the desk's keymap ignores them. Those the
 * browser would act on in place of the page (Ctrl/Cmd+S saves the page, Ctrl/Cmd+O opens a file in
 * its place) the keymap keeps from the browser too (editor/keymap.ts KEPT_FROM_BROWSER); the others
 * keep what the browser does with them (F3 finds in the page, F12 opens its developer tools).
 */
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
