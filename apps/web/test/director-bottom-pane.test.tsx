import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { BottomPane, NARROW_PANEL_SHARE, NARROW_SCREEN, type BottomEditor } from '../src/ui/App';
import { stopSequence } from '../src/ui/director/playback';

// (the service worker's registration is a module of the production build)
vi.mock('../src/pwa/register', () => ({ pwaUpdate: { value: false }, applyPwaUpdate: () => undefined }));

/*
 * The bottom area on narrow screens (phones, tablets held upright), where the right column is hidden
 * and the Director panel is the bottom "Shots" tab: the Shots and Assets tabs open it to about half
 * the window, so the shot inspector shows under the shot list; and once the window is wide (a tablet
 * turned, a window widened) the phone-only Shots tab, whose button is hidden then, gives way to the
 * workspace's own tab.
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

/** The narrow-screen media query, whose matching the test sets (it tells its listeners, as browsers do). */
const narrowQuery = {
  matches: false,
  listeners: new Set<() => void>(),
  set(matches: boolean) {
    this.matches = matches;
    for (const l of [...this.listeners]) l();
  },
};

const WINDOW_H = 844;
let s: ProjectSession;
let ui: ReturnType<typeof render>;
const q = (id: string) => (ui.container as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
const tab = (id: BottomEditor) => q(`bottom-tab-${id}`)!;
const height = () => (ui.container.querySelector('.area') as HTMLElement).style.height;
const mount = (initial: BottomEditor = 'sequence') =>
  (ui = render(<BottomPane s={s} initial={initial} size={150} setSize={() => undefined} />));

beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  narrowQuery.matches = false;
  narrowQuery.listeners.clear();
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    expect(query).toBe(NARROW_SCREEN);
    return {
      get matches() {
        return narrowQuery.matches;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => narrowQuery.listeners.add(l),
      removeEventListener: (_: string, l: () => void) => narrowQuery.listeners.delete(l),
    } as unknown as MediaQueryList;
  });
  Object.defineProperty(window, 'innerHeight', { value: WINDOW_H, configurable: true, writable: true });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  stopSequence();
  vi.restoreAllMocks();
  sessionSignal.value = null;
  localStorage.clear();
});

describe('bottom area on narrow screens', () => {
  it('leaves the phone-only Shots tab for the workspace’s tab once the window is wide', () => {
    narrowQuery.matches = true;
    mount('sequence');
    act(() => void fireEvent.click(tab('shots')));
    expect(tab('shots').classList.contains('open')).toBe(true);
    expect(q('director-panel')).not.toBeNull();
    // turned to landscape: the Shots tab's button is hidden now, and the Director panel belongs in
    // the right column
    act(() => narrowQuery.set(false));
    expect(tab('shots').classList.contains('open')).toBe(false);
    expect(tab('sequence').classList.contains('open')).toBe(true);
    expect(q('director-panel')).toBeNull();
    expect(q('sequence-strip')).not.toBeNull();
    // the other tabs stay what they are
    act(() => void fireEvent.click(tab('assets')));
    act(() => narrowQuery.set(true));
    act(() => narrowQuery.set(false));
    expect(tab('assets').classList.contains('open')).toBe(true);
    // narrow again, the Shots tab opens as before
    act(() => narrowQuery.set(true));
    act(() => void fireEvent.click(tab('shots')));
    expect(q('director-panel')).not.toBeNull();
  });

  it('opens the Shots and Assets tabs to about half the window on a narrow screen', () => {
    narrowQuery.matches = true;
    mount('sequence');
    expect(height()).toBe('150px');
    const half = `${Math.round(WINDOW_H * NARROW_PANEL_SHARE)}px`;
    act(() => void fireEvent.click(tab('shots')));
    expect(height()).toBe(half);
    act(() => void fireEvent.click(tab('assets')));
    expect(height()).toBe(half);
    act(() => void fireEvent.click(tab('sequence')));
    expect(height()).toBe('150px');
    // the window's height followed while such a tab shows
    act(() => void fireEvent.click(tab('assets')));
    act(() => {
      window.innerHeight = 600;
      window.dispatchEvent(new Event('resize'));
    });
    expect(height()).toBe(`${Math.round(600 * NARROW_PANEL_SHARE)}px`);
    // on a wide screen the right column holds them: the bottom area keeps its size
    act(() => narrowQuery.set(false));
    expect(tab('assets').classList.contains('open')).toBe(true);
    expect(height()).toBe('150px');
  });

  it('keeps the workspace’s minimum height on wide screens', () => {
    ui = render(<BottomPane s={s} initial="sequence" size={150} setSize={() => undefined} minHeight={260} />);
    expect(height()).toBe('260px');
  });
});
