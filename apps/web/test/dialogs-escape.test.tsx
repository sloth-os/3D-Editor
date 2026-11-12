import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { closeDialog, dialog, openDialog, session as sessionSignal, type DialogKind } from '../src/app/store';
import { viewport } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { RenderImageOptions, ViewportEngine } from '../src/viewport/engine';
import { DialogHost, Modal } from '../src/ui/dialogs/Dialogs';

/*
 * Escape closes the editor's windows (Projects, Preferences, Export, Render, About, Shortcuts) as a
 * click outside them does, wherever the focus is in them; an Escape that a field or a running render
 * uses first (to cancel the typing or stop the render) keeps the window open.
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
    id: 'dialogs-escape-test',
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

const escape = (target: Element | Document = document.body) => fireEvent.keyDown(target, { key: 'Escape' });

/** Opens a window as the menus and shortcuts do (the host is already rendered) and runs its effects. */
const open = (kind: Exclude<DialogKind, null>, props?: Record<string, unknown>) =>
  act(() => openDialog(kind, props));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  closeDialog();
  viewport.engine = null;
  sessionSignal.value = null;
});

it('Escape closes the Projects window (Ctrl+O), also after a click inside it', async () => {
  // regression: no window closed on Escape (only a click outside closed them)
  const { container } = render(<DialogHost />);
  await open('projects');
  expect(container.querySelector('[data-testid="projects-dialog"]')).not.toBeNull();
  escape();
  expect(dialog.value).toBeNull();
  expect(container.querySelector('.modal')).toBeNull();

  await open('projects');
  const header = container.querySelector('.modal-header')!;
  fireEvent.pointerDown(header);
  fireEvent.click(header);
  expect(dialog.value).toBe('projects');
  escape(header);
  expect(dialog.value).toBeNull();

  // focus in the window's name field, nothing typed: the Escape closes the window
  await open('projects');
  const name = container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!;
  fireEvent.pointerDown(name);
  name.focus();
  escape(name);
  expect(dialog.value).toBeNull();
});

it('an Escape pressed as soon as a window appears closes it', async () => {
  // regression: the window's Escape handler was added by an effect, which runs after the next frame, so
  // an Escape pressed right after the window was shown (an e2e test on a busy machine) left it open. A
  // mutation observer runs after the window's elements are added and before any frame.
  const { container } = render(<DialogHost />);
  const shown = new Promise<boolean>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!container.querySelector('[data-testid="projects-dialog"]')) return;
      observer.disconnect();
      escape();
      resolve(dialog.value === null);
    });
    observer.observe(container, { childList: true, subtree: true });
  });
  // not in act(): its effects run as in the browser, after the next frame
  openDialog('projects');
  expect(await shown).toBe(true);
  expect(dialog.value).toBeNull();
});

it('Escape in a text field of a window cancels the typing first, the next one closes the window', async () => {
  const { container } = render(<DialogHost />);
  await open('projects');
  const name = container.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!;
  name.focus();
  fireEvent.input(name, { target: { value: 'Typed' } });
  escape(name);
  expect(dialog.value).toBe('projects');
  expect(name.value).toBe('Untitled');
  escape(name);
  expect(dialog.value).toBeNull();
});

it('text typed as soon as a window appears stays, and Escape then cancels it', async () => {
  // regression: the field copied the text it shows from its props in an effect, which runs after the
  // next frame or, sooner, when the field renders again: text typed before then (an e2e test filling the
  // name field right after Ctrl+O) was replaced, so the Escape meant to cancel it found nothing typed
  // and closed the window
  const { container } = render(<DialogHost />);
  const typed = new Promise<HTMLInputElement>((resolve) => {
    const observer = new MutationObserver(() => {
      const name = container.querySelector<HTMLInputElement>('input[placeholder="Project name"]');
      if (!name) return;
      observer.disconnect();
      name.focus();
      fireEvent.input(name, { target: { value: 'Typed' } });
      resolve(name);
    });
    observer.observe(container, { childList: true, subtree: true });
  });
  // not in act(): its effects run as in the browser
  openDialog('projects');
  const name = await typed;
  expect(name.value).toBe('Typed');
  escape(name);
  expect(dialog.value).toBe('projects');
  expect(name.value).toBe('Untitled');
  escape(name);
  expect(dialog.value).toBeNull();
});

it('Escape in a number entry of a window ends the entry first, the next one closes the window', async () => {
  const { container } = render(<DialogHost />);
  await open('preferences');
  const field = container.querySelector('[data-testid="preferences-dialog"] .numfield')!;
  fireEvent.pointerDown(field, { button: 0, clientX: 10, pointerId: 1 });
  fireEvent.pointerUp(field, { button: 0, clientX: 10, pointerId: 1 });
  const entry = field.querySelector('input')!;
  expect(entry).not.toBeNull();
  escape(entry);
  expect(dialog.value).toBe('preferences');
  expect(field.querySelector('input')).toBeNull();
  escape();
  expect(dialog.value).toBeNull();
});

it('an Escape used before it reaches the window, or one that ends a composition, keeps the window open', async () => {
  const { container } = render(<DialogHost />);
  await open('about');
  const header = container.querySelector('.modal-header')!;
  const used = (e: Event) => e.preventDefault();
  header.addEventListener('keydown', used);
  escape(header);
  header.removeEventListener('keydown', used);
  expect(dialog.value).toBe('about');
  fireEvent.keyDown(header, { key: 'Escape', isComposing: true });
  expect(dialog.value).toBe('about');
  escape(header);
  expect(dialog.value).toBeNull();
});

it('a window that cannot be dismissed (a render runs in it) stays open on Escape', async () => {
  await open('about');
  render(
    <Modal title="Rendering" dismissible={false}>
      busy
    </Modal>,
  );
  escape();
  expect(dialog.value).toBe('about');
});

it('every window closes on Escape', async () => {
  sessionSignal.value = fakeSession();
  const { container } = render(<DialogHost />);
  const windows: [Exclude<DialogKind, null>, Record<string, unknown>, string][] = [
    ['projects', {}, '[data-testid="projects-dialog"]'],
    ['preferences', {}, '[data-testid="preferences-dialog"]'],
    ['export', { format: 'glb' }, '[data-testid="export-dialog"]'],
    ['render', {}, '[data-testid="render-dialog"]'],
    ['render', { animation: true }, '[data-testid="render-animation-dialog"]'],
    ['about', {}, '.modal'],
    ['shortcuts', {}, '.modal'],
  ];
  for (const [kind, props, selector] of windows) {
    await open(kind, props);
    expect(container.querySelector(selector), kind).not.toBeNull();
    escape();
    expect(dialog.value, kind).toBeNull();
    expect(container.querySelector('.modal'), kind).toBeNull();
  }
});

it('Escape stops a running Render Animation and keeps the window open; the next one closes it', async () => {
  const s = fakeSession();
  sessionSignal.value = s;
  s.doc.updateScene({ frame_start: 1, frame_end: 200 });
  s.doc.updateRender({ engine: 'RASTER', resolution_x: 8, resolution_y: 8, resolution_percentage: 100 });
  viewport.engine = {
    renderPixels: (o: RenderImageOptions) => ({
      width: o.width!,
      height: o.height!,
      data: new Uint8ClampedArray(o.width! * o.height! * 4),
    }),
  } as unknown as ViewportEngine;
  const { container } = render(<DialogHost />);
  await open('render', { animation: true });
  fireEvent.click(container.querySelector('[data-testid="render-animation-start"]')!);
  expect(container.querySelector('[data-testid="render-animation-cancel"]')).not.toBeNull();
  escape();
  expect(dialog.value).toBe('render');
  await waitFor(() => expect(container.querySelector('[data-testid="render-animation-cancel"]')).toBeNull());
  // regression: the window took Escape again only after the next frame, as its handler was added by an
  // effect; now the commit that shows the render stopped adds it
  expect(dialog.value).toBe('render');
  escape();
  expect(dialog.value).toBeNull();
});
