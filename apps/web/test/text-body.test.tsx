import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { run, runResult } from '../src/editor/editor';
import { registerUiOperators } from '../src/editor/ui-operators';
import { registry } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Properties, activePropertiesTab } from '../src/ui/properties/Properties';
import { TextBody } from '../src/ui/properties/DataTab';

/*
 * The body of a text object in the Object Data tab. Regression: after Ctrl+Enter the focus stayed in
 * the text box, so Ctrl+Z was the browser's undo of the text box (the document kept the new text,
 * the box showed the old one, and leaving the box applied that stale text as a new edit).
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

function ok(id: string, params: Record<string, unknown> = {}): void {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
}

let s: ProjectSession;
beforeEach(() => {
  if (!registry.has('ed.undo')) registerUiOperators(registry);
  localStorage.clear();
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  cleanup();
  sessionSignal.value = null;
});

/** The text object 'Title' (body 'Hello') with its Object Data tab open. */
function textPanel() {
  ok('object.text_add', { body: 'Hello', name: 'Title' });
  const id = s.doc.findObjectByName('Title')!.id;
  s.state.selectedIds = [id];
  s.state.activeId = id;
  activePropertiesTab.value = 'data';
  const { container } = render(<Properties session={s} />);
  const box = () => container.querySelector<HTMLTextAreaElement>('[data-testid="font-body"]')!;
  const body = () => s.doc.getCurve(s.doc.findObjectByName('Title')!.data!)!.body;
  return { box, body };
}

describe('text body field', () => {
  it('Ctrl+Enter applies the text and leaves the field, so Ctrl+Z undoes it in the editor', () => {
    const { box, body } = textPanel();
    box().focus();
    expect(document.activeElement).toBe(box());
    fireEvent.input(box(), { target: { value: 'Hello World' } });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(body()).toBe('Hello World');
    // the focus left the box: the editor's keymap gets Ctrl+Z again
    expect(document.activeElement).not.toBe(box());
    // and the blur did not apply the text a second time (one undo step)
    act(() => {
      run('ed.undo', {}, 'hotkey');
    });
    expect(body()).toBe('Hello');
    // the box shows the document's text after the undo
    expect(box().value).toBe('Hello');
    act(() => {
      run('ed.redo', {}, 'hotkey');
    });
    expect(box().value).toBe('Hello World');
  });

  it('Escape cancels the edit and leaves the field without applying it', () => {
    const { box, body } = textPanel();
    box().focus();
    fireEvent.input(box(), { target: { value: 'Typo' } });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(document.activeElement).not.toBe(box());
    expect(body()).toBe('Hello');
    expect(box().value).toBe('Hello');
    // a later edit of the same text still applies (the cancel is forgotten on focus)
    box().focus();
    fireEvent.input(box(), { target: { value: 'Typo' } });
    fireEvent.blur(box());
    expect(body()).toBe('Typo');
  });

  it('shows the document’s text again when applying it failed', () => {
    const { container } = render(<TextBody value="Hello" onCommit={() => false} />);
    const box = container.querySelector('textarea')!;
    box.focus();
    fireEvent.input(box, { target: { value: 'Rejected' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(box.value).toBe('Hello');
  });
});
