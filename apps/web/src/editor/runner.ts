import { signal } from '@preact/signals';
import type {
  OperatorContext,
  OperatorRegistry,
  OperatorSource,
  ReportLevel,
  RunResult,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { telemetry } from '../telemetry/telemetry';
import { toast } from '../app/store';

export interface InfoLine {
  id: number;
  at: number;
  level: ReportLevel;
  message: string;
  source?: string;
}

/** Info editor log (operator reports, like Blender's Info editor). */
export const infoLog = signal<InfoLine[]>([]);
let infoId = 0;
export function logInfo(level: ReportLevel, message: string, source?: string): void {
  infoLog.value = [...infoLog.value.slice(-499), { id: ++infoId, at: Date.now(), level, message, source }];
}

/** The editor selection (objects and Edit Mode elements) around an operator run. */
export interface SelectionSnapshot {
  selectedIds: string[];
  activeId: string | null;
  meshSelection: ProjectSession['state']['meshSelection'];
}

export interface LastOperator {
  id: string;
  label: string;
  params: unknown;
  /** Undo stack depth right after it ran; redo is only valid while unchanged. */
  undoDepth: number;
  /**
   * Whether the run added an undo step. An operator that changed nothing added none, so adjusting
   * it must not undo anything (that would revert the operation before it).
   */
  undoStep: boolean;
  /**
   * Ids of the objects the run created. Adjusting the operation first undoes it, which deletes
   * them, so its parameters cannot refer to them.
   */
  created: string[];
  /** Editor selection state captured right before the operator ran. */
  before: SelectionSnapshot;
}

export const lastOperator = signal<LastOperator | null>(null);

function selectionSnapshot(session: ProjectSession): SelectionSnapshot {
  return {
    selectedIds: session.state.selectedIds,
    activeId: session.state.activeId,
    meshSelection: session.state.meshSelection,
  };
}

/** Restores a selection snapshot, leaving out objects that no longer exist. */
function restoreSelection(session: ProjectSession, sel: SelectionSnapshot): void {
  session.state.selectedIds = sel.selectedIds.filter((id) => session.doc.getObject(id));
  session.state.activeId = sel.activeId && session.doc.getObject(sel.activeId) ? sel.activeId : null;
  session.state.meshSelection = sel.meshSelection;
}

/** Services the UI layer exposes to UI-only operators. */
export interface UiServices {
  [key: string]: unknown;
}

let uiServices: UiServices = {};
export function setUiServices(s: UiServices): void {
  uiServices = s;
}

/**
 * Executes operators for the current session: one undo step per operator, info-log reports,
 * telemetry spans, and bookkeeping for the "Adjust Last Operation" panel.
 */
export function runOperator(
  session: ProjectSession,
  registry: OperatorRegistry,
  id: string,
  params?: unknown,
  source: OperatorSource = 'ui',
): RunResult {
  const def = registry.get(id);
  const objectIds = session.doc.objectIds();
  const span = telemetry.startSpan(`operator ${id}`, {
    'operator.id': id,
    'operator.source': source,
    'operator.mode': session.state.mode,
    'operator.category': def?.category,
    'scene.objects': objectIds.length,
  });
  const ctx: OperatorContext = {
    doc: session.doc,
    state: session.state,
    origin: session.doc.origin,
    source,
    ui: uiServices,
    report: (level, message) => {
      logInfo(level, message, id);
      if (level === 'ERROR') toast(message, 'error');
      else if (level === 'WARNING') toast(message, 'warning');
    },
  };
  const before = selectionSnapshot(session);
  const depthBefore = session.undo.undoStack.length;
  session.undo.stopCapturing();
  session.currentOperator = id;
  const res = registry.run(ctx, id, params);
  session.currentOperator = null;
  session.undo.stopCapturing();
  span.setAttribute('operator.status', res.ok ? 'ok' : 'error');
  if (res.ok) {
    span.setOk();
    if (def && def.undo !== false && !def.uiOnly) logInfo('INFO', `${def.label}`, id);
  } else span.setError(res.error ?? 'failed');
  span.end();
  if (res.ok && def?.redoable) {
    const existed = new Set(objectIds);
    const depth = session.undo.undoStack.length;
    lastOperator.value = {
      id,
      label: def.label,
      params: res.params,
      undoDepth: depth,
      undoStep: depth > depthBefore,
      created: session.doc.objectIds().filter((o) => !existed.has(o)),
      before,
    };
  } else if (res.ok && def && def.undo !== false && !def.uiOnly) {
    lastOperator.value = null;
  }
  return res;
}

/** Undoes or redoes one step of the session's own history on behalf of an operator. */
function stepHistory(session: ProjectSession, operator: string, direction: 'undo' | 'redo'): boolean {
  session.currentOperator = operator;
  try {
    return (direction === 'undo' ? session.undo.undo() : session.undo.redo()) !== null;
  } finally {
    session.currentOperator = null;
  }
}

/**
 * Re-runs the last redoable operator with new parameters (Adjust Last Operation): undoes it and
 * runs it again, from the selection it started with, as one undo step. When the re-run fails (the
 * operator rejects a value, e.g. a constraint target of the wrong type) the original result is
 * brought back with the selection it left, and the operation stays adjustable with its previous
 * parameters: a rejected value changes nothing. Returns null when the last operation can no
 * longer be adjusted (something else was done or undone since).
 */
export function redoLast(
  session: ProjectSession,
  registry: OperatorRegistry,
  params: unknown,
): RunResult | null {
  const last = lastOperator.value;
  if (!last) return null;
  if (session.undo.undoStack.length !== last.undoDepth) {
    lastOperator.value = null;
    return null;
  }
  const after = selectionSnapshot(session);
  // an operation that changed nothing has no undo step of its own: undoing would revert the one before
  if (last.undoStep) stepHistory(session, last.id, 'undo');
  const depth = session.undo.undoStack.length;
  // restore the selection the operator originally ran with (operators may change it)
  restoreSelection(session, last.before);
  const res = runOperator(session, registry, last.id, params, 'redo');
  if (res.ok) {
    // the undone original must not come back with Redo (it stays on the redo stack when the re-run
    // changed nothing)
    session.undo.clear(false, true);
    return res;
  }
  // The re-run failed. Operators validate before they change anything, but a late failure can
  // leave partial changes: revert them (recording them also dropped the original's redo step).
  const partial = session.undo.undoStack.length > depth;
  if (partial) {
    stepHistory(session, last.id, 'undo');
    session.undo.clear(false, true);
  }
  if (!last.undoStep || (!partial && stepHistory(session, last.id, 'redo'))) {
    // the original step is redone as it was (or it changed nothing): same objects, same ids
    restoreSelection(session, after);
    return res;
  }
  // the original's redo step is gone: run it again with its parameters from its starting selection
  restoreSelection(session, last.before);
  if (!runOperator(session, registry, last.id, last.params, 'redo').ok) lastOperator.value = null;
  return res;
}
