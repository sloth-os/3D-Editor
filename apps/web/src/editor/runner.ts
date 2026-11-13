import { signal } from '@preact/signals';
import * as Y from 'yjs';
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
  /**
   * What the run returned, e.g. which shape key, bone or particle system it edited, under the name
   * it ended up with (a rename makes names unique: 'Key 2' may become 'Key 2.001').
   */
  result?: unknown;
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
  /**
   * Which operation this is: the same for its re-runs with adjusted parameters, new for any other
   * run (also of the same operator). The Adjust Last Operation panel builds new fields for a new
   * operation, so text typed for one never goes to the next.
   */
  serial: number;
}

export const lastOperator = signal<LastOperator | null>(null);
let operationSerial = 0;

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
 * they never replace what Repeat Last repeats. They set the values they are given, so running one
 * again sets the same values (Adjust Last Operation relies on that, see {@link redoLast}).
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
  recordUnchanged(session.undo);
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
    const adjusted = source === 'redo' ? lastOperator.peek() : null;
    lastOperator.value = {
      id,
      label: def.label,
      params: res.params,
      result: res.result,
      undoDepth: depth,
      undoStep: depth > depthBefore,
      created: session.doc.objectIds().filter((o) => !existed.has(o)),
      before,
      serial: adjusted?.id === id ? adjusted.serial : ++operationSerial,
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

type StackItem = Y.UndoManager['undoStack'][number];
type DeleteSet = StackItem['deletions'];

/**
 * The end of the range of `ds` that holds the clock `clock` of `client`, or `clock` when none does.
 * The ranges of a stack item's sets are sorted and merged (Yjs's own lookups rely on that).
 */
function rangeEnd(ds: DeleteSet, client: number, clock: number): number {
  const ranges = ds.clients.get(client) ?? [];
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (clock < r.clock) hi = mid - 1;
    else if (clock >= r.clock + r.len) lo = mid + 1;
    else return r.clock + r.len;
  }
  return clock;
}

/** Whether the clocks `from` … `to` − 1 of `client` all lie in `ds` (or in one of several sets). */
function coveredBy(ds: DeleteSet | DeleteSet[], client: number, from: number, to: number): boolean {
  const sets = Array.isArray(ds) ? ds : [ds];
  for (let at = from; at < to;) {
    const next = Math.max(...sets.map((d) => rangeEnd(d, client, at)));
    if (next === at) return false;
    at = next;
  }
  return true;
}

/** The structs of the document's store that hold the clocks of `ds`, with each one's client. */
function* structsOf(
  doc: Y.Doc,
  ds: DeleteSet,
): Generator<{ client: number; s: Y.Item | Y.GC; from: number; to: number }> {
  for (const [client, ranges] of ds.clients) {
    const structs = doc.store.clients.get(client);
    if (!structs) continue;
    for (const { clock, len } of ranges) {
      const end = clock + len;
      for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < end; i++) {
        const s = structs[i];
        yield { client, s, from: Math.max(clock, s.id.clock), to: Math.min(end, s.id.clock + s.length) };
      }
    }
  }
}

/** Key of a step's {@link UnchangedWrites} in the meta of its undo stack item. */
const UNCHANGED_WRITES = 'unchanged-writes';

/**
 * The map entries an undo step set to the value they already had, up to rounding: its no-op writes.
 * The document stores every field of an object or data block as one entry of the block's map,
 * holding the field's whole value, and some operators store a field again that they leave as it
 * was. Running every redoable operator (and those the web UI makes redoable) with its default
 * parameters, then with parameters that change nothing or twice in a row where it can run again,
 * found these:
 * - Randomize Transform stores the location, rotation and scale of each object, also a channel it
 *   leaves as it was (switched off, or with a range of 0, the default for location and rotation).
 * - Set Dimensions stores the scale and Set Parent the parent, also when given the current ones.
 * - Set Interpolation, Move Keyframes and Bake Transforms store whole F-curves, also when the keys
 *   stay as they were (the interpolation the keys have, a move by 0 frames, a second bake, which
 *   recomputes the keys with their last digits changed, see {@link SAME_NUMBER_TOLERANCE}); auto
 *   keying keys every transform channel of every object a transform transforms, also of one it
 *   leaves as it was (a rotation by 0 keys all nine channels), which stores the F-curves of the
 *   channels it left as they were again when they have a key at the current frame.
 * - An Edit Mode operator, and Shade Auto Smooth, store the mesh's whole geometry as one blob, also
 *   when they change nothing (a move by 0, marking seams that are marked).
 * - A property edit stores the whole field it edits (every bone of a pose, every modifier of a
 *   stack), also when it sets the value the field has.
 * The operators that change objects' transforms store only the channels whose values change
 * (changedChannels and SceneDoc.setWorldMatrix in scene-doc.ts): a Move only the location; a rotation
 * only the rotation and a scale only the scale, and the location too about another point than the
 * object's own origin; a move by 0, a rotation by 0 or by whole turns and a scale by 1 nothing,
 * except that a rotation leaving an object in gimbal lock (Y at ±90°) with Z not 0 rewrites its
 * rotation with Z set to 0, as Blender's Rotate does (see transformTolerance in scene-doc.ts). So
 * do Look At (which turns objects), Drop to Ground and Snap to Surface (which move them, and with
 * Align to Normal turn them too), the Snap menu's Selection to Cursor and Selection to Grid,
 * parenting and clearing a parent with Keep Transform (also to and from armatures and bones) and
 * Apply Transform.
 */
interface UnchangedWrites {
  /** The step's values of those entries (its items, by id). */
  set: DeleteSet;
  /** The equal values they replaced. */
  replaced: DeleteSet;
  /** Whether the step changed anything else: set an entry to another value, added or removed one. */
  changed: boolean;
}

/**
 * How far apart two numbers that are not both whole may be and still count as the same stored
 * value: this fraction of the larger one, or this much for numbers below 1. An operator that
 * recomputes a value it leaves as it was can change its last digits: Bake Transforms run a second
 * time over the same frames stored the keys of an unparented object up to 4.3e-16 off, and those
 * of a child of a rotated, scaled parent up to 7.8e-14 off, as the parent's inverse amplifies
 * rounding (5,000 random objects each, keyed at two frames with random rotations and scales of 0.1
 * to 10, parents with random rotations and scales of 0.1 to 10; sample maxima, not bounds;
 * relative to the value, or to 1 below 1). Set Dimensions given the current dimensions stores the
 * scale it had exactly, and the operators that change transforms do not store a channel they leave
 * within this of its value (see {@link UnchangedWrites}). A value further off counts as changed
 * (see {@link changedByOthers}), which errs on the side of refusing to adjust. The viewport draws in
 * 32-bit floats, which are 1.2e-7 apart near 1. Whole numbers (frames, counts, seeds of any size)
 * count as the same only when equal.
 */
const SAME_NUMBER_TOLERANCE = 1e-12;

/**
 * Whether two stored values are the same plain data (JSON values, binary data): numbers within
 * {@link SAME_NUMBER_TOLERANCE} of each other count as the same.
 */
function samePlain(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number')
    return (
      (Number.isNaN(a) && Number.isNaN(b)) ||
      (!(Number.isInteger(a) && Number.isInteger(b)) &&
        Math.abs(a - b) <= SAME_NUMBER_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b)))
    );
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => samePlain(v, b[i]));
  }
  // other objects than plain ones (a Yjs type in a value, a class instance …) are never the same value
  const plain = (o: object) => [Object.prototype, null].includes(Object.getPrototypeOf(o));
  if (!plain(a) || !plain(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  return (
    keys.length === Object.keys(rb).length &&
    keys.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && samePlain(ra[k], rb[k]))
  );
}

/**
 * Whether two map entries hold the same plain value (an entry whose value is a Yjs type, such as a
 * whole block, never does).
 */
function sameValue(a: Y.Item, b: Y.Item): boolean {
  const ca = a.content;
  const cb = b.content;
  if (ca instanceof Y.ContentAny && cb instanceof Y.ContentAny)
    return ca.arr.length === 1 && cb.arr.length === 1 && samePlain(ca.arr[0], cb.arr[0]);
  return ca instanceof Y.ContentBinary && cb instanceof Y.ContentBinary && samePlain(ca.content, cb.content);
}

/**
 * Records a step's {@link UnchangedWrites} in its stack item. Runs when the step is added to the undo
 * stack, right after its transaction: the values it replaced are still there then (the undo manager
 * keeps what its steps removed), and its own values are too. Yjs may later drop the content of an
 * entry another origin removes, so this cannot be told afterwards.
 */
function recordUnchangedWrites(doc: Y.Doc, step: StackItem): void {
  const set = Y.createDeleteSet();
  const replaced = Y.createDeleteSet();
  const add = (ds: DeleteSet, id: Y.ID) => {
    const ranges = ds.clients.get(id.client) ?? [];
    ds.clients.set(id.client, ranges);
    ranges.push({ clock: id.clock, len: 1 });
  };
  let changed = false;
  // the entries the step set, with the value each held before the step
  for (const { s } of structsOf(doc, step.insertions)) {
    // a value the step replaced itself (it set the entry twice)
    if (s instanceof Y.Item && s.deleted) continue;
    let before = s instanceof Y.Item && s.parentSub !== null && s.length === 1 ? s.left : null;
    while (before && Y.isDeleted(step.insertions, before.id)) before = before.left;
    // the value it replaced was there until the step (the step did not add the entry)
    if (
      s instanceof Y.Item &&
      before?.length === 1 &&
      Y.isDeleted(step.deletions, before.id) &&
      sameValue(before, s)
    ) {
      add(set, s.id);
      add(replaced, before.id);
    } else changed = true;
  }
  const unchanged: UnchangedWrites = {
    set: Y.mergeDeleteSets([set]),
    replaced: Y.mergeDeleteSets([replaced]),
    changed,
  };
  // the entries (and blocks) the step removed, other than the values its writes replaced
  unchanged.changed ||= [...step.deletions.clients].some(([client, ranges]) =>
    ranges.some((r) => !coveredBy([step.insertions, unchanged.replaced], client, r.clock, r.clock + r.len)),
  );
  step.meta.set(UNCHANGED_WRITES, unchanged);
}

const recordingUnchanged = new WeakSet<Y.UndoManager>();

/**
 * Makes `undo` record the {@link UnchangedWrites} of every step it adds to its undo stack: an
 * operation's own step, and the new step (a new stack item with new copies of the entries) that
 * the session's undo and redo of a step make.
 */
function recordUnchanged(undo: Y.UndoManager): void {
  if (recordingUnchanged.has(undo)) return;
  recordingUnchanged.add(undo);
  const record = (e: { stackItem: StackItem; type: 'undo' | 'redo' }) => {
    if (e.type === 'undo') recordSafely(undo.doc, e.stackItem);
  };
  undo.on('stack-item-added', record);
  // a transaction merged into the last step (only with a capture timeout): record the whole step anew
  undo.on('stack-item-updated', record);
}

function recordSafely(doc: Y.Doc, step: StackItem): void {
  try {
    recordUnchangedWrites(doc, step);
  } catch (err) {
    // it runs inside the step's transaction, whose changes are made: never fail that. Without a
    // record every entry the step set counts as changed (see changedByOthers)
    step.meta.delete(UNCHANGED_WRITES);
    console.error('[runner] could not record the unchanged writes of an undo step', err);
  }
}

/**
 * Takes `extra`, a step taken out of the history, into `step`, the history's last step: undoing
 * `step` then undoes both. A slider drag's live values so become part of the operation that stores
 * the value the drag ends with (one step), and the value from before the drag is what that step
 * replaced: undoing it brings back that value itself, so an earlier step that set it can be undone
 * next (Yjs gives up on a value replaced by changes no step of the history holds).
 */
export function foldStep(undo: Y.UndoManager, step: StackItem, extra: StackItem): void {
  step.insertions = Y.mergeDeleteSets([extra.insertions, step.insertions]);
  step.deletions = Y.mergeDeleteSets([extra.deletions, step.deletions]);
  if (recordingUnchanged.has(undo)) recordSafely(undo.doc, step);
}

/**
 * Undoes `step`, a step taken out of the history, on its own: when undoing a step changes nothing,
 * Yjs undoes the one before it instead, so the history's steps are put aside meanwhile. Leaves
 * nothing to redo.
 */
export function undoAlone(undo: Y.UndoManager, step: StackItem): void {
  const steps = undo.undoStack;
  const redo = undo.redoStack.length;
  undo.undoStack = [step];
  try {
    undo.undo();
  } finally {
    undo.undoStack = steps;
    undo.redoStack.splice(redo);
  }
}

/**
 * Whether `step` replaced values that were written after the document was at `state` (a state
 * vector), other than its own: what another device, an MCP agent or another step wrote while the
 * step's changes were being made.
 */
export function replacedNewer(step: StackItem, state: Map<number, number>): boolean {
  for (const [client, ranges] of step.deletions.clients) {
    const since = state.get(client) ?? 0;
    for (const { clock, len } of ranges) {
      const from = Math.max(clock, since);
      if (from < clock + len && !coveredBy(step.insertions, client, from, clock + len)) return true;
    }
  }
  return false;
}

/**
 * What undoing an undo step of this session would do, read as Yjs's UndoManager does it (popStackItem
 * and redoItem) without undoing anything.
 */
function undoOutlook(undo: Y.UndoManager, step: StackItem) {
  const doc = undo.doc;
  const inScope = (item: Y.Item) =>
    undo.scope.some((t) => t === doc || Y.isParentOf(t as Y.AbstractType<unknown>, item));
  // what the session's other undo and redo steps removed (Yjs passes over those, see redoItem)
  const deletedByHistory = (id: Y.ID) =>
    [...undo.undoStack, ...undo.redoStack].some((s) => s !== step && Y.isDeleted(s.deletions, id));
  /**
   * Whether a value of `item`'s entry that someone else set follows it, past the step's own values
   * and the ones the session's undo and redo removed: undoing the step then leaves the entry as they
   * set it (Yjs's redoItem gives up on that conflict). Null when this cannot be told (the content
   * of a removed block is gone).
   */
  const setLater = (item: Y.Item): boolean | null => {
    let left: Y.Item | Y.GC = item;
    while (
      left instanceof Y.Item &&
      left.right &&
      (left.right.redone || Y.isDeleted(step.insertions, left.right.id) || deletedByHistory(left.right.id))
    ) {
      left = left.right;
      while (left instanceof Y.Item && left.redone) left = Y.getItem(doc.store, left.redone);
    }
    return left instanceof Y.Item ? left.right !== null : null;
  };
  /** The value `item`'s entry holds now, in the block that holds the entry now. */
  const currentValue = (item: Y.Item): Y.Item | undefined => {
    let block = (item.parent as Y.AbstractType<unknown>)._item;
    // a block the session's undo brought back is a copy (Yjs's redoItem follows it the same way)
    while (block?.deleted && block.redone) {
      const copy: Y.Item | Y.GC = Y.getItem(doc.store, block.redone);
      if (!(copy instanceof Y.Item)) return undefined;
      block = copy;
    }
    const type = block ? (block.content as Y.ContentType).type : (item.parent as Y.AbstractType<unknown>);
    return type._map.get(item.parentSub as string);
  };
  // the values undoing the step removes: the ones it set that are still there, or the copies of
  // them the session's undo and redo brought back (as Yjs's popStackItem finds them)
  let removedByUndo: Set<Y.Item | Y.GC> | undefined;
  const undoRemoves = (value: Y.Item | undefined): boolean => {
    if (!removedByUndo) {
      removedByUndo = new Set();
      for (const { s } of structsOf(doc, step.insertions)) {
        let cur: Y.Item | Y.GC = s;
        while (cur instanceof Y.Item && cur.redone) cur = Y.getItem(doc.store, cur.redone);
        if (!cur.deleted) removedByUndo.add(cur);
      }
    }
    return !!value && !value.deleted && removedByUndo.has(value);
  };
  return { inScope, setLater, currentValue, undoRemoves };
}

/**
 * Whether others (MCP agents, other users) have changed any part of what an undo step of this
 * session changed since it was made, so that undoing the step would not bring back what was there
 * before it with their edits applied. Undoing reverts what the step changed and leaves what others
 * set since as they left it (Yjs never overwrites a value another origin set). Every field of an
 * object or data block is one entry of the block's map holding the field's whole value: an
 * object's `location`, `rotation_euler` or `scale` (all three components), its `modifiers`,
 * `constraints` or `particle_systems` (the whole list), an armature's `pose` (every bone), a mesh's
 * geometry (`data`, one blob) and its `shape_keys` (every key) … Another origin's change counts
 * when it
 *  - set again or removed an entry the step changed (any edit of the same field of the same block,
 *    also of another list item, bone or vector component than the step's, and also to the value the
 *    step set: undoing can no longer bring back the value from before the step), or removed a block
 *    the step changed (deleting the object or data block),
 *  - set again an entry the step removed,
 *  - removed an entry the step rewrote unchanged (see {@link UnchangedWrites}; undoing would bring it
 *    back), or the block that holds one, or
 *  - set an entry the step rewrote unchanged at the same time as the step (neither had the other's
 *    change yet) to a value that lost to the step's: Yjs orders values set at the same time by client
 *    id, and undoing would remove the step's value without bringing back the one before it.
 * Others setting an entry the step rewrote unchanged otherwise do not count: undoing keeps their
 * value, which is what the entry would hold had they edited it before the step (the step only
 * rewrote it), e.g. moving an object whose location Randomize Transform stored again. Nor do
 * changes of other fields of the same block, and of other blocks: after a Move, which writes only
 * the location of each object it moves, setting the rotation or scale of a moved object, or
 * rotating or scaling it about its own origin (a rotation then writes only its rotation, a scale
 * only its scale, neither its location). Rotating or scaling it about another point (the 3D
 * cursor, the median of several objects) moves it, which sets the location the Move changed.
 * Reads the step's stack item (the entries it inserted and deleted, and the no-op writes recorded
 * in its meta; without that record every entry it set counts as changed) and changes nothing.
 */
function changedByOthers(undo: Y.UndoManager, step: StackItem): boolean {
  const doc = undo.doc;
  const unchanged = step.meta.get(UNCHANGED_WRITES) as UnchangedWrites | undefined;
  const { inScope, setLater, currentValue, undoRemoves } = undoOutlook(undo, step);
  // the entries the step set: removed or replaced since, other than by the step itself (a field it
  // set twice); an entry that an undo removed and brought back again counts as still there
  for (const { client, s, from, to } of structsOf(doc, step.insertions)) {
    let cur: Y.Item | Y.GC = s;
    while (cur instanceof Y.Item && cur.deleted && cur.redone) cur = Y.getItem(doc.store, cur.redone);
    if (!cur.deleted) continue;
    if (cur === s && coveredBy(step.deletions, client, from, to)) continue;
    // a removed child of a removed block may be left without its content (Y.GC): removed by others
    if (cur instanceof Y.Item && !inScope(cur)) continue;
    // an entry the step rewrote unchanged, set again by others in the block that still holds it
    if (
      unchanged &&
      cur instanceof Y.Item &&
      coveredBy([step.deletions, unchanged.set], client, from, to) &&
      !(cur.parent as Y.AbstractType<unknown>)._item?.deleted &&
      setLater(cur)
    )
      continue;
    return true;
  }
  // the entries the step removed (not ones it set itself): set again since, or their block removed
  // (Yjs's redo of a removed map entry gives up on the same conditions)
  for (const { client, s, from, to } of structsOf(doc, step.deletions)) {
    if (!(s instanceof Y.Item) || s.parentSub === null || coveredBy(step.insertions, client, from, to))
      continue;
    if (!inScope(s)) continue;
    const parent = (s.parent as Y.AbstractType<unknown>)._item;
    if (parent?.deleted && !parent.redone && !Y.isDeleted(step.deletions, parent.id)) return true;
    if (unchanged && coveredBy([step.insertions, unchanged.replaced], client, from, to)) {
      // the value an unchanged rewrite replaced. Undoing brings it back, or keeps the value others
      // set since (told above). Only a value of theirs set at the same time as the step's that lost
      // to it (Yjs orders such values by client id) lies between the two: undoing then removes the
      // step's value and cannot bring this one back, which leaves the entry empty (an object's scale
      // would read 1). Counted too when this cannot be told
      const later = setLater(s);
      if (later === null || (later && undoRemoves(currentValue(s)))) return true;
      continue;
    }
    if (setLater(s) !== false) return true;
  }
  return false;
}

/**
 * Whether undoing an undo step of this session would leave an entry it set empty: others set the
 * entry at the same time as the step (neither had the other's change yet) to a value that lost to
 * the step's (Yjs orders values set at the same time by client id). Their value lies between the
 * step's and the one the step replaced, so undoing removes the step's value and cannot bring the
 * replaced one back (see {@link changedByOthers}, which counts this for every other operation).
 */
function undoEmptiesEntry(undo: Y.UndoManager, step: StackItem): boolean {
  const { inScope, setLater, currentValue, undoRemoves } = undoOutlook(undo, step);
  for (const { client, s, from, to } of structsOf(undo.doc, step.deletions)) {
    if (!(s instanceof Y.Item) || s.parentSub === null || coveredBy(step.insertions, client, from, to))
      continue;
    if (inScope(s) && setLater(s) !== false && undoRemoves(currentValue(s))) return true;
  }
  return false;
}

/**
 * Undoes the last step of the session's history, the own step of the operation being adjusted.
 * Others (an MCP agent, another user) may since have overwritten everything the step wrote, e.g.
 * by setting the same object's pose: Yjs then drops the step, which has nothing left to undo, and
 * undoes the one before it instead. That one is redone at once, so adjusting an operation never
 * reverts an earlier one. Returns whether the step itself was undone.
 */
function undoOwnStep(session: ProjectSession, operator: string): boolean {
  const own = session.undo.undoStack[session.undo.undoStack.length - 1];
  session.currentOperator = operator;
  try {
    const undone = session.undo.undo();
    if (undone && undone !== own) session.undo.redo();
    return !!undone && undone === own;
  } finally {
    session.currentOperator = null;
  }
}

/**
 * Re-runs the last redoable operator with new parameters (Adjust Last Operation): undoes it and
 * runs it again, from the selection it started with, as one undo step. When the re-run fails (the
 * operator rejects a value, e.g. a constraint target of the wrong type) the original result is
 * brought back with the selection it left, and the operation stays adjustable with its previous
 * parameters: a rejected value changes nothing. Returns null when there is no operation to adjust
 * or it can no longer be adjusted: something else was done or undone since, or others changed what
 * it did (below).
 *
 * Others (MCP agents, other users) may since have edited what the operation wrote. Edits that leave
 * what it changed as it left it keep it adjustable: edits of other objects and fields (after a
 * Move, which writes only locations: setting the rotation or scale of a moved object, or rotating
 * or scaling it about its own origin), and new values of fields it rewrote unchanged (moving an
 * object whose location Randomize Transform stored again; see {@link UnchangedWrites}): undoing it
 * keeps their edits, and the re-run starts from them. Edits of part or all of what it changed (e.g.
 * moving one of the objects it moved, also by rotating or scaling it about another point than its
 * origin, editing a constraint of the object it added a constraint to) leave undoing it nothing or
 * only the rest to revert. A property edit (setting values of something that exists) then runs
 * again on top of the others' edits, which keeps those and changes only what the adjusted
 * parameters set. Any other operation would be applied again to what the others changed (a double
 * move, a second constraint, the keys they added removed again), so it can no longer be adjusted.
 * Neither can any operation after others set a field it wrote at the same time as it (neither had
 * the other's change yet) to a value that lost to its value: undoing would leave the field empty
 * (see {@link changedByOthers}), and a property edit would rebuild the field from what it sets (a
 * pose from the one bone channel it sets). This is decided before anything is undone: nothing is
 * undone or run again, and the panel closes with a warning (a toast and the Info log).
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

/**
 * Gives up adjusting an operation that others have changed (see {@link redoLast}): the panel
 * closes, and a warning toast and Info log line say why.
 */
function cannotAdjust(last: LastOperator): null {
  lastOperator.value = null;
  const message = `${last.label} can no longer be adjusted: an agent or another user has changed what it did since`;
  logInfo('WARNING', message, last.id);
  toast(message, 'warning');
  return null;
}

function redoLastOperation(
  session: ProjectSession,
  registry: OperatorRegistry,
  last: LastOperator,
  params: unknown,
): RunResult | null {
  const after = selectionSnapshot(session);
  // its own undo step (when it changed something), read before anything is undone
  const own = last.undoStep ? session.undo.undoStack[session.undo.undoStack.length - 1] : undefined;
  // a property edit runs again on top of others' edits, but not on an entry undoing it would empty:
  // it would lose the rest of the entry (the other bones and channels of a pose it sets one bone of)
  const propertyEdit = PROPERTY_EDITS.has(last.id);
  if (own && (propertyEdit ? undoEmptiesEntry(session.undo, own) : changedByOthers(session.undo, own)))
    return cannotAdjust(last);
  // an operation that changed nothing has no undo step of its own: undoing would revert the one before
  const undone = last.undoStep && undoOwnStep(session, last.id);
  // its step had nothing left to undo: others overwrote all of it (and Yjs dropped the step). When
  // all it did was rewrite values unchanged, it runs again on top of their edits, like a property edit
  const overwritten = last.undoStep && !undone;
  const rewroteOnly = (own?.meta.get(UNCHANGED_WRITES) as UnchangedWrites | undefined)?.changed === false;
  if (overwritten && !propertyEdit && !rewroteOnly) {
    restoreSelection(session, after);
    return cannotAdjust(last);
  }
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
  if (!undone || (!partial && stepHistory(session, last.id, 'redo'))) {
    // the original step is redone as it was (or it changed nothing, or others overwrote it, so
    // nothing of it was undone): same objects, same ids
    restoreSelection(session, after);
    // an overwritten step is gone from the history: adjusting again runs on top again
    if (overwritten)
      lastOperator.value = { ...last, undoDepth: session.undo.undoStack.length, undoStep: false };
    return res;
  }
  // the original's redo step is gone: run it again with its parameters from its starting selection
  restoreSelection(session, last.before);
  if (!runOperator(session, registry, last.id, last.params, 'redo').ok) lastOperator.value = null;
  return res;
}
