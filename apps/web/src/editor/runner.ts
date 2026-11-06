import { signal } from '@preact/signals';
import type {
  OperatorContext,
  OperatorDef,
  OperatorRegistry,
  OperatorSource,
  ReportLevel,
  RunResult,
} from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { telemetry } from '../telemetry/telemetry';
import { session as openSession, toast } from '../app/store';

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

/** One operator call of a {@link RepeatAction}. */
export interface RepeatStep {
  id: string;
  /** The parameters it ran with (validated, defaults filled in). */
  params: unknown;
}

/**
 * What Repeat Last (Shift+R, Blender's screen.repeat_last) runs again: the last operation that
 * changed the document, with the parameters it ran with (as adjusted in the Adjust Last Operation
 * panel). An interactive move that completes an operation (Duplicate and Move, Extrude and Move:
 * Blender's macros) is part of it, so repeating duplicates or extrudes again and moves by the same
 * offset.
 */
export interface RepeatAction {
  /** The label of its first operator, e.g. "Duplicate Objects". */
  label: string;
  steps: RepeatStep[];
}

export const lastRepeat = signal<RepeatAction | null>(null);

/**
 * Operators the Properties editor and the outliner run to change values of something that exists
 * (a typed or dragged field, a rename). In Blender these are property edits, not operators, so
 * they never replace what Repeat Last repeats.
 */
const PROPERTY_EDITS = new Set([
  'data.set_property',
  'object.rename',
  'object.vertex_group_rename',
  'object.modifier_set',
  'object.shape_key_set',
  'object.particle_system_update',
  'constraint.update',
  'pose.constraint_set',
  'pose.bone_transform_set',
  'pose.ik_settings_set',
  'armature.bone_update',
  'armature.properties_set',
  'curve.properties_set',
  'light.properties_set',
  'camera.properties_set',
  'material.update',
  'material.procedural_set',
  'world.sky_set',
  'world.mist_set',
  'rigidbody.world_set',
  'rigidbody.object_settings_set',
  'anim.driver_update',
  'anim.fmodifier_update',
]);

/** Operators run for agents (MCP editor commands, the API) are not the user's to repeat. */
const AGENT_SOURCES: ReadonlySet<OperatorSource> = new Set(['mcp', 'api']);

/** Set right before an operator runs that continues an action (see {@link continueRepeat}). */
let continuation: RepeatAction | null = null;

/**
 * Forgets the operator history: what Adjust Last Operation adjusts ({@link lastOperator}) and what
 * Repeat Last repeats ({@link lastRepeat}). The history belongs to the project it was recorded in,
 * so it is cleared whenever another project is opened, created or closed in this tab (File > New,
 * Open, Close switch projects without reloading the page), like Blender, which clears its operator
 * history when it loads a file or starts a new one.
 */
export function clearOperatorHistory(): void {
  lastOperator.value = null;
  lastRepeat.value = null;
  continuation = null;
}

// the project open in this tab; its operator history is cleared when another one takes its place
let historyProject: ProjectSession | null = openSession.peek();
openSession.subscribe((s) => {
  if (s === historyProject) return;
  historyProject = s;
  clearOperatorHistory();
});

/**
 * Makes the next operator run part of `action`: an interactive transform that completes the
 * operation before it (the move of Duplicate and Move). Repeat Last then runs the action's
 * operators followed by that one. Call it right before the run, which consumes it.
 */
export function continueRepeat(action: RepeatAction | null): void {
  continuation = action;
}

/** Records what Repeat Last repeats after a successful run of `id`. */
function recordRepeat(
  def: OperatorDef,
  id: string,
  params: unknown,
  source: OperatorSource,
  continues: RepeatAction | null,
  before: RepeatAction | null,
): void {
  if (AGENT_SOURCES.has(source) || def.undo === false || PROPERTY_EDITS.has(id)) return;
  if (def.uiOnly) {
    // an editor operation that changed the document without running a repeatable operator (a
    // brush stroke, a loop cut placed with the mouse) cannot be repeated: Shift+R must not run an
    // older operation instead
    if (lastRepeat.value === before) lastRepeat.value = null;
    return;
  }
  const step = { id, params };
  lastRepeat.value = continues
    ? { label: continues.label, steps: [...continues.steps, step] }
    : { label: def.label, steps: [step] };
}

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
  const continues = continuation;
  continuation = null;
  const repeatBefore = lastRepeat.value;
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
  if (res.ok && def) recordRepeat(def, id, res.params, source, continues, repeatBefore);
  return res;
}

/**
 * Repeat Last (Shift+R, Blender's screen.repeat_last): runs {@link lastRepeat} again as new undo
 * steps with the same parameters, on the current selection (after Duplicate and Move it duplicates
 * the copy and moves that by the same offset, after Add Cube it adds another cube). It stops at
 * the first operator that fails (which reports why) and returns the result of the last operator it
 * ran, or null when there is nothing to repeat. The action stays the one Repeat Last repeats.
 */
export function repeatLast(
  session: ProjectSession,
  registry: OperatorRegistry,
  source: OperatorSource = 'hotkey',
): RunResult | null {
  const action = lastRepeat.value;
  if (!action) return null;
  let res: RunResult | null = null;
  try {
    for (const step of action.steps) {
      res = runOperator(session, registry, step.id, step.params, source);
      if (!res.ok) break;
    }
  } finally {
    // each step recorded itself as the action: the whole action is what repeats next
    lastRepeat.value = action;
  }
  return res;
}

/**
 * After Adjust Last Operation re-ran the last step of a repeat action (the Move of Duplicate and
 * Move), Repeat Last repeats the action with the step's parameters now in effect, still after the
 * operators it continues.
 */
function keepRepeatChain(repeat: RepeatAction | null, id: string): void {
  const now = lastOperator.value;
  const tail = repeat?.steps[repeat.steps.length - 1];
  if (!repeat || repeat.steps.length < 2 || tail?.id !== id || now?.id !== id) return;
  lastRepeat.value = {
    label: repeat.label,
    steps: [...repeat.steps.slice(0, -1), { id, params: now.params }],
  };
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
  const repeat = lastRepeat.value;
  try {
    return redoLastOperation(session, registry, last, params);
  } finally {
    keepRepeatChain(repeat, last.id);
  }
}

function redoLastOperation(
  session: ProjectSession,
  registry: OperatorRegistry,
  last: LastOperator,
  params: unknown,
): RunResult {
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
