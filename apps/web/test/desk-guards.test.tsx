import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator, type Vec3 } from '@3d-editor/core';
import { session as sessionSignal, toasts } from '../src/app/store';
import { registry } from '../src/editor/editor';
import { installKeymap } from '../src/editor/keymap';
import { ADD_MENU, OBJECT_MENU, VIEW_MENU, type MenuItem } from '../src/editor/menus';
import { pageGuard } from '../src/editor/page-guard';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { registerUiOperators } from '../src/editor/ui-operators';
import { DESK_IGNORED_KEYS, guardRegistry } from '../src/embed/guards';
import { importFiles } from '../src/io/import-export';
import type { ProjectSession } from '../src/project/session';
import { Panel } from '../src/ui/fields/fields';
import { MenuList } from '../src/ui/Menu';
import { dragEdit, setProp } from '../src/ui/properties/prop-edit';

/*
 * What the embedded desk's guards (embed/guards.ts) keep from the editor's UI, and that the editor
 * (index.html, no guard) behaves as before: in a read-only open a model file dropped on the viewport
 * is refused (nothing is written past the import operator), a slider drag writes no live value, the
 * menus grey out what the desk refuses with the reason, the ignored Ctrl/Cmd+S and Ctrl/Cmd+O do not
 * reach the browser (Save Page, Open File), and the desk keeps its panels' open state apart from the
 * editor's.
 */

/** A project session with a real document, undo manager and evaluator (what the runner needs). */
function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return {
    id: 'desk-guards-test',
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision: signal(0),
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

const OBJ = 'o Tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const objFile = (name = 'tri.obj') => new File([OBJ], name);

let s: ProjectSession;
let readOnly = false;
/** The desk's guard while a test runs it (null: the editor, no guard). */
let unguard: (() => void) | null = null;
const desk = (ro: boolean) => {
  readOnly = ro;
  unguard ??= guardRegistry(registry, () => readOnly);
};
/** Document updates from now on. */
const updates = () => {
  const seen = { n: 0 };
  s.doc.ydoc.on('update', () => seen.n++);
  return seen;
};
const messages = () => toasts.value.map((t) => `${t.level}: ${t.message}`);

beforeAll(() => {
  if (!registry.has('wm.call_menu')) registerUiOperators(registry);
});
beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  toasts.value = [];
});
afterEach(() => {
  cleanup();
  unguard?.();
  unguard = null;
  readOnly = false;
  sessionSignal.value = null;
  localStorage.clear();
  delete document.documentElement.dataset.runtime;
});

describe('the page guard', () => {
  it('tells the UI what the desk refuses, and nothing once the guard is undone (the editor)', () => {
    expect(pageGuard.refusal('wm.import')).toBeNull();
    desk(false);
    expect(pageGuard.refusal('wm.import')).toMatch(/not available in the embedded desk/);
    expect(pageGuard.refusal('data.set_property')).toBeNull();
    readOnly = true;
    expect(pageGuard.refusal('data.set_property')).toMatch(/read-only/);
    expect(pageGuard.refusal('view3d.view_axis')).toBeNull();
    unguard!();
    unguard = null;
    expect(pageGuard.refusal('wm.import')).toBeNull();
    expect(pageGuard.refusal('data.set_property')).toBeNull();
  });
});

describe('a model file dropped on the viewport', () => {
  it('is refused in a read-only desk: nothing is written, and the file is not even read', async () => {
    desk(true);
    const before = s.doc.objectIds().length;
    const seen = updates();
    const file = objFile();
    const read = vi.spyOn(file, 'arrayBuffer');
    await importFiles([file]);
    expect(s.doc.objectIds().length).toBe(before);
    expect(seen.n).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(messages()).toEqual([
      'error: Import Wavefront OBJ: the scene is read-only here: view, play and export only',
    ]);
  });

  it('says the refusal once for all the files of a drop', async () => {
    desk(true);
    await importFiles([objFile('a.obj'), objFile('b.obj'), objFile('c.obj')]);
    expect(messages()).toHaveLength(1);
    expect(s.doc.objectIds()).toHaveLength(0);
  });

  it('is imported in a desk that is not read-only, as in the editor', async () => {
    desk(false);
    await importFiles([objFile()]);
    expect(s.doc.objectIds()).toHaveLength(1);
    expect(messages()).toContain('info: Imported tri.obj');
  });

  it('is imported in the editor, through the operator (one undo step)', async () => {
    const seen = updates();
    await importFiles([objFile()]);
    expect(s.doc.objectIds()).toHaveLength(1);
    expect(s.doc.getObject(s.doc.objectIds()[0])?.name).toBe('Tri');
    expect(seen.n).toBeGreaterThan(0);
    expect(s.undo.undoStack).toHaveLength(1);
    expect(messages()).toEqual(['info: Imported tri.obj']);
  });

  it('is never written past an import operator that refuses it, in the editor either', async () => {
    // the import operators run in Object Mode only: the refusal stands (an earlier fallback wrote
    // the file into the document anyway, and said it was imported)
    s.state.mode = 'EDIT';
    const seen = updates();
    await importFiles([objFile()]);
    expect(s.doc.objectIds()).toHaveLength(0);
    expect(seen.n).toBe(0);
    const said = messages();
    expect(said.some((m) => m.startsWith('error:') && /Object Mode/.test(m))).toBe(true);
    expect(said.some((m) => m.includes('Imported'))).toBe(false);
  });
});

describe('a slider drag in a field (the viewport sidebar)', () => {
  let id: string;
  const location = () => s.doc.getObject(id)!.location;
  /** A drag of the location's X to `xs`, released on the last value. */
  const dragX = (xs: number[]) => {
    for (const x of xs) setProp(s, 'objects', id, 'location', [x, 0, 0] as Vec3, false);
    setProp(s, 'objects', id, 'location', [xs[xs.length - 1], 0, 0] as Vec3, true);
  };
  beforeEach(() => {
    id = s.doc.transact(() => s.doc.addObject({ name: 'Actor', type: 'EMPTY' }));
    s.undo.stopCapturing();
  });

  it('writes no live value in a read-only desk, and its release is refused', () => {
    desk(true);
    const seen = updates();
    const live: number[] = [];
    s.doc.ydoc.on('update', () => live.push(location()[0]));
    setProp(s, 'objects', id, 'location', [2, 0, 0] as Vec3, false);
    setProp(s, 'objects', id, 'location', [5, 0, 0] as Vec3, false);
    expect(location()).toEqual([0, 0, 0]);
    setProp(s, 'objects', id, 'location', [5, 0, 0] as Vec3, true);
    expect(location()).toEqual([0, 0, 0]);
    expect(seen.n).toBe(0);
    expect(live).toEqual([]);
    expect(messages()).toEqual([
      'error: Set Property: the scene is read-only here: view, play and export only',
    ]);
    expect(s.undo.undoStack).toHaveLength(1);
  });

  it('writes no live value of any field in a read-only desk (every drag of a value)', () => {
    desk(true);
    const preview = vi.fn();
    const commit = vi.fn();
    const capture = vi.fn(() => () => {});
    dragEdit(s, 'objects:x:anything', false, preview, capture, commit);
    expect(preview).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    dragEdit(s, 'objects:x:anything', true, preview, capture, commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('writes live values in a desk that is not read-only, as in the editor', () => {
    desk(false);
    setProp(s, 'objects', id, 'location', [5, 0, 0] as Vec3, false);
    expect(location()).toEqual([5, 0, 0]);
    setProp(s, 'objects', id, 'location', [5, 0, 0] as Vec3, true);
    expect(location()).toEqual([5, 0, 0]);
  });

  it('writes live values in the editor and stores the last one as one undo step', () => {
    const live: number[] = [];
    s.doc.ydoc.on('update', () => live.push(location()[0]));
    dragX([2, 5]);
    expect(live.slice(0, 2)).toEqual([2, 5]);
    expect(location()).toEqual([5, 0, 0]);
    expect(s.undo.undoStack).toHaveLength(2);
    s.undo.undo();
    expect(location()).toEqual([0, 0, 0]);
    expect(messages()).toEqual([]);
  });
});

describe('the menus', () => {
  /** The menu's items by test id: whether each is greyed out, and its tooltip. */
  const show = (items: MenuItem[]) => {
    const r = render(<MenuList items={items} x={0} y={0} onClose={() => {}} />);
    return (testId: string) => {
      const el = r.getByTestId(testId);
      return { el, disabled: el.classList.contains('disabled'), title: el.getAttribute('title') };
    };
  };
  beforeEach(() => {
    const cube = s.doc.transact(() => s.doc.addObject({ name: 'Cube', type: 'EMPTY' }));
    s.state.selectedIds = [cube];
    s.state.activeId = cube;
  });

  it('grey out in the desk what it hides, with the reason, and a click runs nothing', () => {
    desk(false);
    const item = show(ADD_MENU)('menu-import-');
    expect(item.disabled).toBe(true);
    expect(item.title).toBe('wm.import is not available in the embedded desk');
    fireEvent.click(item.el);
    expect(messages()).toEqual([]);
  });

  it('grey out in a read-only desk the UI operators that start a change', () => {
    desk(true);
    const view = show(VIEW_MENU());
    expect(view('menu-align-active-camera-to-view').disabled).toBe(true);
    expect(view('menu-align-active-camera-to-view').title).toMatch(/read-only/);
    // looking around is not an edit
    expect(view('menu-frame-all').disabled).toBe(false);
    cleanup();
    const object = show(OBJECT_MENU());
    expect(object('menu-duplicate-objects').disabled).toBe(true);
    expect(object('menu-duplicate-objects').title).toMatch(/read-only/);
  });

  it('keep the UI operators a desk that is not read-only runs enabled', () => {
    desk(false);
    expect(show(VIEW_MENU())('menu-align-active-camera-to-view').disabled).toBe(false);
    cleanup();
    expect(show(OBJECT_MENU())('menu-duplicate-objects').disabled).toBe(false);
  });

  it('are as before in the editor: UI operators enabled, their description as the tooltip', () => {
    const add = show(ADD_MENU)('menu-import-');
    expect(add.disabled).toBe(false);
    expect(add.title).toBe(registry.get('wm.import')!.description);
    cleanup();
    expect(show(VIEW_MENU())('menu-align-active-camera-to-view').disabled).toBe(false);
    cleanup();
    expect(show(OBJECT_MENU())('menu-duplicate-objects').disabled).toBe(false);
  });
});

describe('the keys the desk ignores', () => {
  /** Presses a key on `target`; whether the page kept it from the browser. */
  const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const ctrlS = { key: 's', code: 'KeyS', ctrlKey: true };
  const cmdS = { key: 's', code: 'KeyS', metaKey: true };
  const ctrlO = { key: 'o', code: 'KeyO', ctrlKey: true };
  const cmdO = { key: 'o', code: 'KeyO', metaKey: true };
  let off: (() => void) | null = null;
  let input: HTMLInputElement;
  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
  });
  afterEach(() => {
    off?.();
    off = null;
    input.remove();
  });

  it('keeps Ctrl/Cmd+S and Ctrl/Cmd+O from the browser (Save Page, Open File), wherever the focus is', () => {
    desk(false);
    off = installKeymap({ ignore: DESK_IGNORED_KEYS });
    for (const k of [ctrlS, cmdS, ctrlO, cmdO]) {
      expect(press(k)).toBe(true);
      expect(press(k, input)).toBe(true);
    }
    // and runs nothing
    expect(messages()).toEqual([]);
  });

  it('keeps them by the key pressed on a layout without Latin letters, and only there', () => {
    desk(false);
    off = installKeymap({ ignore: DESK_IGNORED_KEYS });
    // with Alt (AltGr is Ctrl+Alt) or Shift they are other keys
    expect(press({ key: 'ы', code: 'KeyS', ctrlKey: true, altKey: true })).toBe(false);
    expect(press({ key: 'Ы', code: 'KeyS', ctrlKey: true, shiftKey: true })).toBe(false);
    // a Latin layout names the shortcut by its letter: Dvorak's O key types r (Ctrl+R reloads) and
    // its S key types o (Ctrl+O, kept)
    expect(press({ key: 'r', code: 'KeyO', ctrlKey: true })).toBe(false);
    expect(press({ key: 'o', code: 'KeyS', ctrlKey: true })).toBe(true);
    // Russian: Ctrl/Cmd and the S or O key type ы and щ; the browser takes them as Ctrl+S, Ctrl+O
    for (const k of [
      { key: 'ы', code: 'KeyS', ctrlKey: true },
      { key: 'ы', code: 'KeyS', metaKey: true },
      { key: 'щ', code: 'KeyO', ctrlKey: true },
      { key: 'щ', code: 'KeyO', metaKey: true },
      // Greek
      { key: 'σ', code: 'KeyS', ctrlKey: true },
    ]) {
      expect(press(k)).toBe(true);
      expect(press(k, input)).toBe(true);
    }
    // the same keys without Ctrl/Cmd are typing
    expect(press({ key: 'ы', code: 'KeyS' }, input)).toBe(false);
    expect(messages()).toEqual([]);
  });

  it('leaves the browser its own keys the desk ignores (find, developer tools)', () => {
    desk(false);
    off = installKeymap({ ignore: DESK_IGNORED_KEYS });
    expect(press({ key: 'F3', code: 'F3' })).toBe(false);
    expect(press({ key: 'F12', code: 'F12' })).toBe(false);
    expect(messages()).toEqual([]);
  });

  it('takes a keydown without a key (browsers’ autofill sends some) without failing', () => {
    desk(false);
    off = installKeymap({ ignore: DESK_IGNORED_KEYS });
    const autofill = new Event('keydown', { bubbles: true, cancelable: true });
    expect(() => input.dispatchEvent(autofill)).not.toThrow();
    expect(autofill.defaultPrevented).toBe(false);
  });

  it('stops keeping them once the keymap is removed', () => {
    off = installKeymap({ ignore: DESK_IGNORED_KEYS });
    off();
    off = null;
    expect(press(ctrlS, input)).toBe(false);
  });

  it('are the editor’s own keys in the editor: typed into a field, they are left alone as before', () => {
    off = installKeymap();
    expect(press(ctrlS, input)).toBe(false);
    expect(press(ctrlO, input)).toBe(false);
    expect(press({ key: 'ы', code: 'KeyS', ctrlKey: true }, input)).toBe(false);
  });
});

describe('the panels’ open state', () => {
  const panel = () =>
    render(
      <Panel title="Camera" id="director-shot-camera">
        <div data-testid="panel-body">shot camera</div>
      </Panel>,
    );
  const toggle = (r: ReturnType<typeof panel>) =>
    act(() => {
      fireEvent.click(r.container.querySelector('.panel-header')!);
    });

  it('is the desk’s own in the desk: it never reads or writes the editor’s', async () => {
    document.documentElement.dataset.runtime = 'desk';
    localStorage.setItem('3d-editor:panel:director-shot-camera', '0');
    const r = panel();
    // the editor's closed panel does not close the desk's
    expect(r.queryByTestId('panel-body')).not.toBeNull();
    await toggle(r);
    expect(r.queryByTestId('panel-body')).toBeNull();
    expect(localStorage.getItem('3d-editor:desk:panel:director-shot-camera')).toBe('0');
    expect(localStorage.getItem('3d-editor:panel:director-shot-camera')).toBe('0');
    await toggle(r);
    expect(localStorage.getItem('3d-editor:desk:panel:director-shot-camera')).toBe('1');
    expect(localStorage.getItem('3d-editor:panel:director-shot-camera')).toBe('0');
    cleanup();
    localStorage.setItem('3d-editor:desk:panel:director-shot-camera', '0');
    expect(panel().queryByTestId('panel-body')).toBeNull();
  });

  it('is kept under the editor’s keys in the editor, as before', async () => {
    const r = panel();
    await toggle(r);
    expect(localStorage.getItem('3d-editor:panel:director-shot-camera')).toBe('0');
    expect(localStorage.getItem('3d-editor:desk:panel:director-shot-camera')).toBeNull();
    cleanup();
    expect(panel().queryByTestId('panel-body')).toBeNull();
  });
});
