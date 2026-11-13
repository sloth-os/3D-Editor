import * as Y from 'yjs';
import type { AnimTargetType, DatablockKind } from '@3d-editor/core';
import { evaluateFCurve, hasKeyframeAt, readChannel } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { run } from '../../editor/editor';
import { foldStep, replacedNewer, undoAlone } from '../../editor/runner';
import type { FieldState } from '../fields/fields';
import { animatedBlock } from './animated';

type Kind = DatablockKind | 'scene' | 'render' | 'world';
type Step = Y.UndoManager['undoStack'][number];

/**
 * A slider drag in progress: the field it is for, how to put the field back as it was before the
 * drag, the undo step its live values make, and the document's state when it started.
 */
interface Drag {
  key: string;
  session: ProjectSession;
  restore: () => void;
  step: Step | null;
  start: Map<number, number>;
}

let drag: Drag | null = null;

function readField(s: ProjectSession, kind: Kind, target: string | null, field: string): unknown {
  if (kind === 'scene') return (s.doc.getScene() as unknown as Record<string, unknown>)[field];
  if (kind === 'render') return (s.doc.getRender() as unknown as Record<string, unknown>)[field];
  if (kind === 'world') return (s.doc.getWorld() as unknown as Record<string, unknown>)[field];
  return s.doc.getBlock(kind, target!)?.[field];
}

function writeField(
  s: ProjectSession,
  kind: Kind,
  target: string | null,
  field: string,
  value: unknown,
): void {
  const patch = { [field]: value };
  if (kind === 'scene') s.doc.updateScene(patch);
  else if (kind === 'render') s.doc.updateRender(patch);
  else if (kind === 'world') s.doc.updateWorld(patch);
  else s.doc.updateBlockByKind(kind, target!, patch);
}

/**
 * Makes `write` (a drag's live value, or putting its field back) the person's own change: part of
 * the drag's undo step `step` while that is the last step of the history, a new step otherwise.
 * Returns the step it went to (null when it changed nothing).
 */
function ownChange(s: ProjectSession, step: Step | null, write: () => void): Step | null {
  const undo = s.undo;
  const last = (): Step | null => undo.undoStack[undo.undoStack.length - 1] ?? null;
  const into = step !== null && last() === step;
  if (!into) undo.stopCapturing();
  const length = undo.undoStack.length;
  const timeout = undo.captureTimeout;
  // Yjs adds a change to the last step when it comes within the capture timeout
  if (into) undo.captureTimeout = Number.POSITIVE_INFINITY;
  try {
    s.doc.transact(write);
  } finally {
    undo.captureTimeout = timeout;
  }
  if (undo.undoStack.length > length) return last();
  return into ? step : null;
}

/**
 * A value dragged in a field. While `final` is false, `preview` writes the live value (synced to
 * peers) as the person's own change; the final value puts back the state captured before the drag
 * (`capture` returns the function that does it) and runs `commit`, normally an operator. The drag
 * is one undo step, the operator's, with the live values in it: undoing it brings back the value
 * from before the drag, after which an earlier step that set the field can be undone too.
 *
 * The restore must put back only the dragged field, written into the document state as it is at
 * release time (see captureField): a drag lasts seconds, and other devices or MCP agents may change
 * other entries of the same list (constraints, particle systems, keyframes) meanwhile. When they
 * wrote the dragged entry itself meanwhile, the operator's step alone is the drag's step: undoing it
 * brings back what the restore wrote, their change included.
 */
export function dragEdit(
  s: ProjectSession,
  key: string,
  final: boolean,
  preview: () => void,
  capture: () => () => void,
  commit: () => void,
): void {
  if (!final) {
    if (!drag || drag.key !== key || drag.session !== s) {
      const start = Y.decodeStateVector(Y.encodeStateVector(s.doc.ydoc));
      drag = { key, session: s, restore: capture(), step: null, start };
    }
    drag.step = ownChange(s, drag.step, preview);
    return;
  }
  const d = drag?.key === key && drag.session === s ? drag : null;
  if (!d) {
    commit();
    return;
  }
  drag = null;
  const undo = s.undo;
  // the field goes back to its value from before the drag, in the drag's step, which then leaves
  // the history: the operation that stores the value the drag ends with makes the drag's one step
  const step = ownChange(s, d.step, d.restore);
  const detached = step !== null && undo.undoStack[undo.undoStack.length - 1] === step;
  if (detached) undo.undoStack.pop();
  const depth = undo.undoStack.length;
  commit();
  if (!detached || replacedNewer(step, d.start)) return;
  if (undo.undoStack.length > depth) foldStep(undo, undo.undoStack[undo.undoStack.length - 1], step);
  // the operation stored nothing (it refused the value, or the target is gone): the drag leaves no
  // step, and its live values go as an undone step would
  else undoAlone(undo, step);
}

/** Ends a drag whose target is gone: its live values went with it, and its step undoes nothing. */
function dropDrag(s: ProjectSession, key: string): void {
  if (drag?.key !== key || drag.session !== s) return;
  const undo = s.undo;
  if (drag.step && undo.undoStack[undo.undoStack.length - 1] === drag.step) undo.undoStack.pop();
  drag = null;
}

/**
 * Sets a datablock property from the UI. Non-final values (while dragging) are written live, as
 * {@link dragEdit} does; the final value runs `data.set_property`, and the whole drag is one undo
 * step.
 */
export function setProp(
  s: ProjectSession,
  kind: Kind,
  target: string | null,
  field: string,
  value: unknown,
  final = true,
): void {
  const key = `${kind}:${target}:${field}`;
  // a datablock an agent (or another device) deleted meanwhile takes nothing: no preview that would
  // write a stray entry, and no error toast at the end of the drag or typing
  if (!hasTarget(s, kind, target)) {
    dropDrag(s, key);
    return;
  }
  dragEdit(
    s,
    key,
    final,
    () => writeField(s, kind, target, field, value),
    () => {
      const original = readField(s, kind, target, field);
      return () => writeField(s, kind, target, field, original);
    },
    () => run('data.set_property', { kind, target: target ?? undefined, values: { [field]: value } }, 'ui'),
  );
}

/** Whether the datablock a field edits is stored (the scene, render settings and world always are). */
function hasTarget(s: ProjectSession, kind: Kind, target: string | null): boolean {
  if (kind === 'scene' || kind === 'render' || kind === 'world') return true;
  return target !== null && !!s.doc.getBlock(kind, target);
}

export type FieldAnimState = FieldState | null;

/**
 * Animation state of a property channel at the current frame, for field colouring like Blender:
 * 'driven' when a driver sets the channel (also without keyframes; the driver overrides them),
 * 'keyed' on a keyframe of its F-curve, 'animated' between keyframes, else null.
 */
export function animState(
  s: ProjectSession,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
): FieldAnimState {
  const key = `${type}:${id}:${path}:${index}`;
  if (s.doc.getDriver(key)) return 'driven';
  const fc = s.doc.getFCurve(key);
  if (!fc || fc.keyframes.length === 0) return null;
  return hasKeyframeAt(fc, s.state.frame) ? 'keyed' : 'animated';
}

/**
 * Value of a property channel at the current frame, as the viewport and the renderers use it: the
 * value its driver gives (drivers override keyframes), else its F-curve's value, else `base` (the
 * stored value).
 */
export function animatedValue(
  s: ProjectSession,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
  base: number,
): number {
  const key = `${type}:${id}:${path}:${index}`;
  const driver = s.doc.getDriver(key);
  if (driver && !driver.mute) {
    const block = animatedBlock<Record<string, unknown>>(s, type, id);
    const v = block ? readChannel(block, path, index) : undefined;
    if (v !== undefined && Number.isFinite(v)) return v;
  }
  const fc = s.doc.getFCurve(key);
  if (!fc || fc.mute) return base;
  return evaluateFCurve(fc, s.state.frame) ?? base;
}
