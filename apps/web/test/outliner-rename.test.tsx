import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Outliner } from '../src/ui/Outliner';

/*
 * The outliner's rename box (double-click a row): what is typed stays while the project changes
 * (an agent or another person editing), Enter renames, Escape cancels.
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

let s: ProjectSession;
const add = (id: string, name: string) => {
  const r = runResult(id, { name }, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
};
const names = () =>
  s.doc
    .listObjects()
    .map((o) => o.name)
    .sort();

beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  add('mesh.primitive_cube_add', 'Cube');
  add('object.light_add', 'Light');
});
afterEach(() => {
  cleanup();
  sessionSignal.value = null;
});

/** Opens the rename box of `name`'s row and types `text` key by key, as a browser does. */
function typeInRenameBox(container: Element, name: string, text: string): HTMLInputElement {
  fireEvent.dblClick(container.querySelector(`[data-testid="outliner-${name}"]`)!);
  const box = container.querySelector<HTMLInputElement>(`[data-testid="outliner-${name}"] input`)!;
  expect(box).not.toBeNull();
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, name.length]);
  box.focus();
  for (const ch of text) {
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? box.value.length;
    box.value = box.value.slice(0, start) + ch + box.value.slice(end);
    box.setSelectionRange(start + 1, start + 1);
    fireEvent.input(box);
  }
  return box;
}

it('keeps the typed name while the project changes, and Enter renames to it', () => {
  // regression: the box showed the stored name, so a redraw of the outliner (here an agent renaming
  // another object) put the stored name back over the typing and selected it all again
  const { container } = render(<Outliner session={s} />);
  const box = typeInRenameBox(container, 'Cube', 'Crate');
  expect(box.value).toBe('Crate');
  act(() => {
    s.doc.rename('objects', s.doc.findObjectByName('Light')!.id, 'Lamp');
  });
  expect(container.querySelector('[data-testid="outliner-Lamp"]')).not.toBeNull();
  expect(box.isConnected).toBe(true);
  expect(box.value).toBe('Crate');
  expect([box.selectionStart, box.selectionEnd]).toEqual([5, 5]);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(names()).toEqual(['Crate', 'Lamp']);
  // the blur that Chromium fires when it removes the focused box renames nothing more
  const steps = s.undo.undoStack.length;
  fireEvent.blur(box);
  expect(s.undo.undoStack.length).toBe(steps);
  expect(container.querySelector('[data-testid="outliner-Crate"] input')).toBeNull();
});

it('Escape cancels the rename, also with the blur of the removed box', () => {
  // regression: the box was removed on Escape, and the blur that Chromium fires for it renamed the
  // object to the typed name
  const { container } = render(<Outliner session={s} />);
  const box = typeInRenameBox(container, 'Cube', 'Crate');
  fireEvent.keyDown(box, { key: 'Escape' });
  fireEvent.blur(box);
  expect(names()).toEqual(['Cube', 'Light']);
  expect(container.querySelector('[data-testid="outliner-Cube"] input')).toBeNull();
});

it('leaving the box renames to a changed name; a key that ends an IME composition does nothing', () => {
  const { container } = render(<Outliner session={s} />);
  const box = typeInRenameBox(container, 'Cube', 'Box');
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 });
  expect(box.isConnected).toBe(true);
  expect(names()).toEqual(['Cube', 'Light']);
  fireEvent.blur(box);
  expect(names()).toEqual(['Box', 'Light']);
});

it('a rename of the object while typing replaces the text, as in the other text fields', () => {
  const { container } = render(<Outliner session={s} />);
  const box = typeInRenameBox(container, 'Cube', 'Crate');
  act(() => {
    s.doc.rename('objects', s.doc.findObjectByName('Cube')!.id, 'Block');
  });
  const now = container.querySelector<HTMLInputElement>('[data-testid="outliner-Block"] input');
  expect(now).toBe(box);
  expect(box.value).toBe('Block');
});
