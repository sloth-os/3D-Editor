import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { dragEdit } from '../src/ui/properties/prop-edit';

/** A project session with a real document and undo manager (the drag helper needs no more). */
function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return {
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision: signal(0),
    undoRevision: signal(0),
  } as unknown as ProjectSession;
}

let s: ProjectSession;
let id: string;
const x = () => s.doc.getObject(id)?.location[0];
const setX = (v: number) => {
  const o = s.doc.getObject(id)!;
  s.doc.updateObject(id, { location: [v, o.location[1], o.location[2]] });
};
/** A drag of the location's X: live values, then the release, whose operation `commit` is. */
const drag = (values: number[], commit: (v: number) => void) => {
  const key = `objects:${id}:location`;
  const capture = () => {
    const before = x()!;
    return () => setX(before);
  };
  for (const v of values)
    dragEdit(
      s,
      key,
      false,
      () => setX(v),
      capture,
      () => commit(v),
    );
  const end = values[values.length - 1];
  dragEdit(
    s,
    key,
    true,
    () => setX(end),
    capture,
    () => commit(end),
  );
};

beforeEach(() => {
  s = fakeSession();
  id = s.doc.transact(() => s.doc.addObject({ name: 'Cube', type: 'EMPTY' }));
  s.undo.stopCapturing();
  // the person's own step that set the field before the drags
  s.doc.transact(() => setX(2));
  s.undo.stopCapturing();
});

describe('slider drag undo steps', () => {
  it('a drag whose operation stores nothing leaves no step, and the step before it still undoes', () => {
    const depth = s.undo.undoStack.length;
    // the operation refuses the value (or its target is gone): it stores nothing
    drag([3, 4], () => undefined);
    expect(x()).toBe(2);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(s.undo.redoStack.length).toBe(0);
    s.undo.undo();
    // regression: the drag's live values hid the step that set 2, so undo skipped it and removed
    // the object instead
    expect(x()).toBe(0);
    expect(s.doc.getObject(id)).not.toBeNull();
  });

  it('a drag is one step with the operation that stores its value', () => {
    const depth = s.undo.undoStack.length;
    drag([3, 4, 5], (v) => s.doc.transact(() => setX(v)));
    expect(x()).toBe(5);
    expect(s.undo.undoStack.length).toBe(depth + 1);
    s.undo.undo();
    expect(x()).toBe(2);
    s.undo.undo();
    expect(x()).toBe(0);
    s.undo.redo();
    s.undo.redo();
    expect(x()).toBe(5);
  });
});
