import { signal } from '@preact/signals';
import type { DeskCheckResult } from '@3d-editor/core';
import { session as sessionSignal } from '../../app/store';
import type { ProjectSession } from '../../project/session';

/*
 * Local UI state of the Director workspace (never in the document; nothing here is undoable): the
 * tab of its column, the shot selected in the shot list and the last continuity check.
 */

export type DirectorTab = 'shots' | 'actor' | 'assets';

/** The Director column's tab. */
export const directorTab = signal<DirectorTab>('shots');

/** The shot selected in the shot list (its id), shown in the shot inspector. */
export const selectedShot = signal<string | null>(null);

/** The result of the last Check (desk.check) and the document revision it was made at. */
export interface CheckState {
  session: ProjectSession;
  revision: number;
  result: DeskCheckResult;
}

export const lastCheck = signal<CheckState | null>(null);

/**
 * The object the Director panel itself made active last (an issue's objects, a subject): a
 * selection made there does not switch the panel's tab the way a click in the viewport does.
 */
export const panelSelection = { id: null as string | null };

/**
 * The active object the panel followed last (per session): the panel follows changes of the
 * selection, so building it again (another workspace and back) keeps the shot and tab chosen in it.
 */
export const followedSelection = { session: null as ProjectSession | null, id: null as string | null };

/**
 * Forgets what belongs to a project that is no longer open: the last check and the followed
 * selection hold its session, which would otherwise keep the closed project's document, undo
 * history and evaluator caches reachable until the next check or selection (File > New, Open and
 * Close switch projects without reloading the page).
 */
export function forgetClosedSession(open: ProjectSession | null): void {
  const check = lastCheck.peek();
  if (check && check.session !== open) lastCheck.value = null;
  if (followedSelection.session && followedSelection.session !== open) {
    followedSelection.session = null;
    followedSelection.id = null;
  }
}

sessionSignal.subscribe(forgetClosedSession);
