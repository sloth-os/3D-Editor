import { signal } from '@preact/signals';
import type { OperatorContext, OperatorRegistry, OperatorSource, ReportLevel, RunResult } from '@3d-editor/core';
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

export interface LastOperator {
  id: string;
  label: string;
  params: unknown;
  /** Undo stack depth right after it ran; redo is only valid while unchanged. */
  undoDepth: number;
  /** Editor selection state captured right before the operator ran. */
  before: { selectedIds: string[]; activeId: string | null; meshSelection: ProjectSession['state']['meshSelection'] };
}

export const lastOperator = signal<LastOperator | null>(null);

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
  const span = telemetry.startSpan(`operator ${id}`, {
    'operator.id': id,
    'operator.source': source,
    'operator.mode': session.state.mode,
    'operator.category': def?.category,
    'scene.objects': session.doc.objectIds().length,
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
  const before = { selectedIds: session.state.selectedIds, activeId: session.state.activeId, meshSelection: session.state.meshSelection };
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
    lastOperator.value = { id, label: def.label, params: res.params, undoDepth: session.undo.undoStack.length, before };
  } else if (res.ok && def && def.undo !== false && !def.uiOnly) {
    lastOperator.value = null;
  }
  return res;
}

/** Re-runs the last redoable operator with new parameters (Adjust Last Operation). */
export function redoLast(session: ProjectSession, registry: OperatorRegistry, params: unknown): RunResult | null {
  const last = lastOperator.value;
  if (!last) return null;
  if (session.undo.undoStack.length !== last.undoDepth) {
    lastOperator.value = null;
    return null;
  }
  if (last.undoDepth > 0) session.undo.undo();
  // restore the selection the operator originally ran with (operators may change it)
  session.state.selectedIds = last.before.selectedIds.filter((id) => session.doc.getObject(id));
  session.state.activeId = last.before.activeId && session.doc.getObject(last.before.activeId) ? last.before.activeId : null;
  session.state.meshSelection = last.before.meshSelection;
  const res = runOperator(session, registry, last.id, params, 'redo');
  if (res.ok) session.undo.redoStack.length = 0;
  return res;
}
