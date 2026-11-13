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
import { removalLikeChromium, settle } from './removal';

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

it('the Enter of an Android keyboard that still composes the typed word renames', () => {
  // regression: the box ignored the Enter Gboard sends while the typed word is still its composition
  const { container } = render(<Outliner session={s} />);
  const box = typeInRenameBox(container, 'Cube', 'Box');
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 13, isComposing: true });
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

it("an agent's rename that also takes the row away is not undone by the untouched box (Chromium)", async () => {
  // regression: Chromium blurs the box it removes; leaving it compared the name the box still showed
  // with the object's new name and renamed the object back
  const { container } = render(<Outliner session={s} />);
  const filter = container.querySelector<HTMLInputElement>('[aria-label="Filter objects by name"]')!;
  fireEvent.input(filter, { target: { value: 'cu' } });
  fireEvent.dblClick(container.querySelector('[data-testid="outliner-Cube"]')!);
  const box = container.querySelector<HTMLInputElement>('[data-testid="outliner-Cube"] input')!;
  box.focus();
  const restore = removalLikeChromium();
  try {
    // the new name is not found by the filter: the row goes away in the same change
    act(() => void s.doc.rename('objects', s.doc.findObjectByName('Cube')!.id, 'Zebra'));
    expect(box.isConnected).toBe(false);
    await settle();
  } finally {
    restore();
  }
  expect(names()).toEqual(['Light', 'Zebra']);
});

it('a click on a row that the rename committed by its press moved away selects that row', () => {
  // regression: the press on another row took the focus from the name box, the rename it committed
  // re-sorted the list under the pointer, and the browser sent the click to the list: no selection
  const cube = s.doc.findObjectByName('Cube')!.id;
  s.state.selectedIds = [cube];
  s.state.activeId = cube;
  const { container } = render(<Outliner session={s} />);
  const box = typeInRenameBox(container, 'Cube', 'Zed');
  fireEvent.mouseDown(container.querySelector('[data-testid="outliner-Light"]')!, { button: 0 });
  act(() => box.blur());
  expect(names()).toEqual(['Light', 'Zed']);
  // the click goes to the list: the rows pressed and released on are not the same now
  fireEvent.click(container.querySelector('[data-testid="outliner"]')!);
  expect(s.state.activeId).toBe(s.doc.findObjectByName('Light')!.id);
  expect(s.state.selectedIds).toEqual([s.doc.findObjectByName('Light')!.id]);
});

it('a press on one row and a release on another (nothing moved) selects neither', () => {
  const cube = s.doc.findObjectByName('Cube')!.id;
  s.state.selectedIds = [cube];
  s.state.activeId = cube;
  const { container } = render(<Outliner session={s} />);
  fireEvent.mouseDown(container.querySelector('[data-testid="outliner-Light"]')!, { button: 0 });
  fireEvent.click(container.querySelector('[data-testid="outliner"]')!);
  expect(s.state.activeId).toBe(cube);
});

/** A press and its click, as a browser sends them for a click on `el`. */
function clickOn(el: Element): void {
  fireEvent.mouseDown(el, { button: 0 });
  fireEvent.click(el);
}

/** An agent adds an object whose row comes first (Light's row moves down) and makes Cube active. */
function agentMovesRows(): string {
  act(() => add('mesh.primitive_cube_add', 'Abc'));
  const cube = s.doc.findObjectByName('Cube')!.id;
  act(() => {
    s.state.selectedIds = [cube];
    s.state.activeId = cube;
  });
  return cube;
}

// regression: such a press stayed recorded, and once the list had moved, a click on its empty part
// selected the object pressed long before
for (const [how, testId, clicked] of [
  ['released off the list', 'outliner-Light', false],
  ['on its eye, whose click the eye keeps', 'outliner-vis-Light', true],
  ['followed by a click on it', 'outliner-Light', true],
] as const)
  it(`a press on a row ${how} is not taken up by a later click on the list`, () => {
    const { container } = render(<Outliner session={s} />);
    const at = container.querySelector(`[data-testid="${testId}"]`)!;
    fireEvent.mouseDown(at, { button: 0 });
    if (clicked) fireEvent.click(at);
    const cube = agentMovesRows();
    // a click below the rows
    clickOn(container.querySelector('[data-testid="outliner"]')!);
    expect(s.state.activeId).toBe(cube);
    expect(s.state.selectedIds).toEqual([cube]);
  });

it("a click on a row of another object's items after a press released off the list selects that object", () => {
  expect(runResult('object.modifier_add', { object: 'Cube', type: 'SUBSURF' }, 'test')?.ok).toBe(true);
  const { container } = render(<Outliner session={s} />);
  fireEvent.click(container.querySelector('[data-testid="outl-twisty-Cube"]')!);
  fireEvent.mouseDown(container.querySelector('[data-testid="outliner-Light"]')!, { button: 0 });
  const light = s.doc.findObjectByName('Light')!.id;
  act(() => {
    s.state.selectedIds = [light];
    s.state.activeId = light;
  });
  act(() => add('mesh.primitive_cube_add', 'Abc'));
  clickOn(container.querySelector('[data-testid="outl-group-Cube-modifiers"]')!);
  const cube = s.doc.findObjectByName('Cube')!.id;
  expect(s.state.activeId).toBe(cube);
  expect(s.state.selectedIds).toEqual([cube]);
});

it('a click sent to the list for a pressed row whose object was deleted meanwhile selects nothing', () => {
  const { container } = render(<Outliner session={s} />);
  fireEvent.mouseDown(container.querySelector('[data-testid="outliner-Light"]')!, { button: 0 });
  // during the press: the list moves, and an agent deletes Light before the list is drawn again (its
  // row is still there)
  act(() => add('mesh.primitive_cube_add', 'Abc'));
  const light = s.doc.findObjectByName('Light')!.id;
  s.doc.removeObject(light);
  expect(container.querySelector('[data-testid="outliner-Light"]')!.isConnected).toBe(true);
  // the release lands on another row: the click goes to the list
  fireEvent.click(container.querySelector('[data-testid="outliner"]')!);
  expect(s.state.activeId).not.toBe(light);
  expect(s.state.selectedIds).not.toContain(light);
});
