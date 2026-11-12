import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { closeDialog, dialog, openDialog, session as sessionSignal } from '../src/app/store';
import { paletteOpen, popupMenu } from '../src/editor/editor';
import { installKeymap } from '../src/editor/keymap';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { DialogHost } from '../src/ui/dialogs/Dialogs';
import { CommandPalette, MenuButton, PopupMenuHost } from '../src/ui/Menu';

/*
 * A popup menu (Shift+A, X, right click; or an agent's wm.call_menu) or the operator search above a
 * window: one Escape closes the menu and leaves the window, and a press outside the menu closes it,
 * also a press that the pressed element keeps for itself (a top-bar menu, a window).
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create();
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'popup-menu-test',
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

let uninstall: () => void;
beforeAll(() => {
  // as main.tsx: the keymap is installed before the app renders, so it runs before a window's handler
  uninstall = installKeymap();
});
afterAll(() => uninstall());
beforeEach(() => {
  sessionSignal.value = fakeSession();
});
afterEach(() => {
  cleanup();
  closeDialog();
  popupMenu.value = null;
  paletteOpen.value = false;
  sessionSignal.value = null;
});

const escape = (target: Element | Document = document.body) => fireEvent.keyDown(target, { key: 'Escape' });
/** Shows the Add menu as Shift+A does, and lets its outside-press listener be added. */
async function showAddMenu(): Promise<void> {
  await act(async () => {
    popupMenu.value = { name: 'add', x: 40, y: 40 };
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.querySelector('.menu')).not.toBeNull();
}

it('one Escape closes a popup menu above a window and leaves the window open', async () => {
  // regression: the keymap closed the menu without using up the Escape, so the window's own handler
  // closed the window under it too
  render(
    <>
      <PopupMenuHost />
      <DialogHost />
    </>,
  );
  await act(() => openDialog('about'));
  await showAddMenu();
  escape();
  expect(popupMenu.value).toBeNull();
  expect(dialog.value).toBe('about');
  escape();
  expect(dialog.value).toBeNull();
});

it('Escape in a field of the window (nothing typed) closes the menu above it first', async () => {
  // regression: the keymap ignored keys typed in fields, so the window under the menu closed and the
  // menu stayed above the editor
  const { container } = render(
    <>
      <PopupMenuHost />
      <DialogHost />
    </>,
  );
  await act(() => openDialog('preferences'));
  await showAddMenu();
  const name = container.querySelector<HTMLInputElement>('[data-testid="user-name"]')!;
  name.focus();
  escape(name);
  expect(popupMenu.value).toBeNull();
  expect(dialog.value).toBe('preferences');
  escape(name);
  expect(dialog.value).toBeNull();
});

it('the repeats of a held Escape close only the menu', async () => {
  render(
    <>
      <PopupMenuHost />
      <DialogHost />
    </>,
  );
  await act(() => openDialog('about'));
  await showAddMenu();
  // a key held since before the menu appeared does not close it
  fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
  expect(popupMenu.value).not.toBeNull();
  escape();
  fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
  fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
  expect(popupMenu.value).toBeNull();
  expect(dialog.value).toBe('about');
});

it('one Escape closes the operator search above a window and leaves the window open', async () => {
  render(
    <>
      <CommandPalette />
      <DialogHost />
    </>,
  );
  await act(() => openDialog('about'));
  await act(async () => {
    paletteOpen.value = true;
  });
  // focus outside the search field (in it, the field closes the search itself)
  (document.activeElement as HTMLElement | null)?.blur();
  escape();
  expect(paletteOpen.value).toBe(false);
  expect(dialog.value).toBe('about');
});

it('a press on a top-bar menu or in a window closes the popup menu; a press in the menu does not', async () => {
  // regression: the top-bar menus and the windows keep their presses for themselves, so a popup menu
  // stayed open, drawn above a window opened from the top bar
  const { container } = render(
    <>
      <MenuButton
        label="File"
        items={() => [{ label: 'Preferences…', action: () => openDialog('preferences') }]}
      />
      <PopupMenuHost />
      <DialogHost />
    </>,
  );
  await showAddMenu();
  fireEvent.pointerDown(document.querySelector('.menu .menu-item')!);
  expect(popupMenu.value).not.toBeNull();

  fireEvent.pointerDown(container.querySelector('[data-testid="menu-button-file"]')!);
  expect(popupMenu.value).toBeNull();

  await act(() => openDialog('about'));
  await showAddMenu();
  fireEvent.pointerDown(container.querySelector('.modal-header')!);
  expect(popupMenu.value).toBeNull();
  expect(dialog.value).toBe('about');
});
