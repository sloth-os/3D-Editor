import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator, getShots } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { runResult } from '../src/editor/editor';
import { installKeymap } from '../src/editor/keymap';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { shotPin } from '../src/viewport/follow-shots';
import { SequenceStrip } from '../src/ui/director/SequenceStrip';
import { selectedShot } from '../src/ui/director/state';
import { sequencePlaying, stopSequence } from '../src/ui/director/playback';

/*
 * The sequence strip: blocks as long as the shots, in cut order; clicking, dragging and the keys scrub
 * the cut, showing each sequence frame at its shot's scene frame through its camera.
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

function addShot(name: string, start: number, end: number, x = 0): string {
  const r = runResult(
    'desk.shot_add',
    {
      name,
      frame_start: start,
      frame_end: end,
      from_view: { position: [x, -8, 1.6], target: [x, 0, 1], lens_mm: 35 },
      solve: false,
    },
    'test',
  );
  if (!r?.ok) throw new Error(r?.error);
  return (r.result as { shot: { id: string } }).shot.id;
}

let s: ProjectSession;
let ui: ReturnType<typeof render>;
const q = (id: string) => (ui.container as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
const LEFT = 100;
const WIDTH = 800;

/** Renders the strip with its track laid out WIDTH pixels wide, LEFT pixels from the left. */
function mount(): HTMLElement {
  ui = render(<SequenceStrip s={s} />);
  const track = q('sequence-track')!;
  track.getBoundingClientRect = () =>
    ({
      left: LEFT,
      top: 0,
      width: WIDTH,
      height: 40,
      right: LEFT + WIDTH,
      bottom: 40,
      x: LEFT,
      y: 0,
    }) as DOMRect;
  return track;
}

const press = (el: HTMLElement, key: string, shiftKey = false) =>
  act(() => void fireEvent.keyDown(el, { key, shiftKey }));

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  s = fakeSession();
  sessionSignal.value = s;
  selectedShot.value = null;
});
afterEach(() => {
  cleanup();
  stopSequence();
  vi.unstubAllGlobals();
  sessionSignal.value = null;
});

describe('sequence strip', () => {
  it('shows the cut as blocks as long as the shots, in cut order, leaving disabled shots out', () => {
    addShot('A', 1, 48);
    addShot('B', 49, 168);
    addShot('C', 169, 192);
    addShot('D', 193, 240);
    runResult('desk.shot_update', { shot: 'D', enabled: false }, 'test');
    mount();
    const block = (n: string) => q(`sequence-block-${n}`)!;
    expect([block('A'), block('B'), block('C')].map((b) => [b.style.left, b.style.width])).toEqual([
      ['0.0000%', '25.0000%'],
      ['25.0000%', '62.5000%'],
      ['87.5000%', '12.5000%'],
    ]);
    expect(q('sequence-block-D')).toBeNull();
    expect(q('sequence-time')?.textContent).toBe('00:00:00 / 00:08:00');
    expect(ui.container.textContent).toContain('1 shot off');
  });

  it('scrubs with a click and a drag: frame, shot camera and selection follow', () => {
    addShot('A', 1, 48);
    const b = addShot('B', 49, 168);
    const c = addShot('C', 169, 192);
    const track = mount();
    // the middle of the cut: 96 frames in, 48 into B
    act(
      () => void fireEvent.pointerDown(track, { button: 0, buttons: 1, clientX: LEFT + 400, pointerId: 1 }),
    );
    expect(s.state.frame).toBe(97);
    expect(shotPin(s.view).value).toBe(b);
    expect(s.view.followShots.value).toBe(true);
    expect(s.view.cameraView.value).toBe(true);
    expect(selectedShot.value).toBe(b);
    expect(q('sequence-playhead')?.dataset.frame).toBe('96');
    expect(q('sequence-shot')?.textContent).toBe('2/3 B');
    expect(q('sequence-block-B')?.classList.contains('selected')).toBe(true);
    act(() => void fireEvent.pointerMove(track, { buttons: 1, clientX: LEFT + 790, pointerId: 1 }));
    expect(s.state.frame).toBe(190);
    expect(selectedShot.value).toBe(c);
    // moving without the button pressed does nothing; past the ends it stays in the cut
    act(() => void fireEvent.pointerMove(track, { buttons: 0, clientX: LEFT + 10, pointerId: 1 }));
    expect(s.state.frame).toBe(190);
    act(() => void fireEvent.pointerMove(track, { buttons: 1, clientX: LEFT + 5000, pointerId: 1 }));
    expect(s.state.frame).toBe(192);
    act(() => void fireEvent.pointerMove(track, { buttons: 1, clientX: LEFT - 50, pointerId: 1 }));
    expect(s.state.frame).toBe(1);
  });

  it('steps frames and shots with the keys and the buttons', () => {
    addShot('A', 1, 48);
    addShot('B', 49, 168);
    addShot('C', 169, 192);
    const track = mount();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      press(track, 'End');
      expect(s.state.frame).toBe(192);
      press(track, 'ArrowLeft');
      expect(s.state.frame).toBe(191);
      press(track, 'ArrowLeft', true);
      expect(s.state.frame).toBe(49);
      press(track, 'ArrowRight', true);
      expect(s.state.frame).toBe(169);
      press(track, 'Home');
      expect(s.state.frame).toBe(1);
      press(track, 'ArrowRight');
      expect(s.state.frame).toBe(2);
      // the timeline's frame keys never see them
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outside);
    }
    act(() => void fireEvent.click(q('sequence-next')!));
    expect(s.state.frame).toBe(49);
    act(() => void fireEvent.click(q('sequence-prev')!));
    expect(s.state.frame).toBe(1);
  });

  it('plays and stops with the button and Space', () => {
    addShot('A', 1, 48);
    const track = mount();
    act(() => void fireEvent.click(q('sequence-play')!));
    expect(sequencePlaying.value).toBe(true);
    expect(q('sequence-play')?.getAttribute('aria-pressed')).toBe('true');
    press(track, ' ');
    expect(sequencePlaying.value).toBe(false);
    press(track, ' ');
    expect(sequencePlaying.value).toBe(true);
    // scrubbing stops the playback
    act(
      () => void fireEvent.pointerDown(track, { button: 0, buttons: 1, clientX: LEFT + 100, pointerId: 1 }),
    );
    expect(sequencePlaying.value).toBe(false);
  });

  it('plays and stops with Space on its buttons, which never reaches the timeline', () => {
    addShot('A', 1, 48);
    addShot('B', 49, 96);
    mount();
    // the editor's keymap: Space plays the timeline (screen.animation_play), arrows step frames
    const uninstall = installKeymap();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      const play = q('sequence-play')!;
      act(() => void fireEvent.click(play));
      expect(play.getAttribute('aria-pressed')).toBe('true');
      // the click leaves the focus on Play: Space there stops the cut
      play.focus();
      act(() => void fireEvent.keyDown(play, { key: ' ', code: 'Space' }));
      expect(sequencePlaying.value).toBe(false);
      expect(q('sequence-play')?.getAttribute('aria-pressed')).toBe('false');
      expect(s.view.playing.value).toBe(false);
      // and plays it again; a held Space does not stop and start it over and over
      act(() => void fireEvent.keyDown(play, { key: ' ', code: 'Space' }));
      expect(sequencePlaying.value).toBe(true);
      act(() => void fireEvent.keyDown(play, { key: ' ', code: 'Space', repeat: true }));
      expect(sequencePlaying.value).toBe(true);
      expect(s.view.playing.value).toBe(false);
      // the arrows and Home/End work from the other buttons too
      const next = q('sequence-next')!;
      act(() => void fireEvent.keyDown(next, { key: 'End' }));
      expect(s.state.frame).toBe(96);
      expect(sequencePlaying.value).toBe(false);
      act(() => void fireEvent.keyDown(next, { key: 'ArrowLeft', shiftKey: true }));
      expect(s.state.frame).toBe(1);
      act(() => void fireEvent.keyDown(q('sequence-prev')!, { key: 'ArrowRight' }));
      expect(s.state.frame).toBe(2);
      // none of them reached the editor's keys
      expect(outside).not.toHaveBeenCalled();
      expect(s.view.playing.value).toBe(false);
      // keys with Ctrl, Alt or Meta are the editor's (and the browser's)
      act(() => void fireEvent.keyDown(next, { key: 'ArrowLeft', altKey: true }));
      expect(outside).toHaveBeenCalledTimes(1);
      expect(s.state.frame).toBe(2);
    } finally {
      window.removeEventListener('keydown', outside);
      uninstall();
    }
  });

  it('shows coverage of one action from two cameras one after the other', () => {
    const wide = addShot('Wide', 1, 48);
    const close = addShot('Close', 1, 48, 3);
    const track = mount();
    act(
      () => void fireEvent.pointerDown(track, { button: 0, buttons: 1, clientX: LEFT + 600, pointerId: 1 }),
    );
    // 72 frames in: the close-up's 25th frame, shown through the close-up's camera
    expect(s.state.frame).toBe(25);
    expect(shotPin(s.view).value).toBe(close);
    expect(q('sequence-playhead')?.dataset.frame).toBe('72');
    act(
      () => void fireEvent.pointerDown(track, { button: 0, buttons: 1, clientX: LEFT + 200, pointerId: 1 }),
    );
    expect(s.state.frame).toBe(25);
    expect(shotPin(s.view).value).toBe(wide);
    expect(q('sequence-playhead')?.dataset.frame).toBe('24');
  });

  it('says so when there are no shots, and its buttons do nothing', () => {
    mount();
    expect(q('sequence-track')?.textContent).toContain('No shots in the cut yet');
    expect((q('sequence-play') as HTMLButtonElement).disabled).toBe(true);
    expect(q('sequence-time')?.textContent).toBe('00:00:00 / 00:00:00');
    expect(q('sequence-shot')?.textContent).toBe('No shots');
    const frame = s.state.frame;
    act(() => void fireEvent.pointerDown(q('sequence-track')!, { button: 0, clientX: LEFT + 10 }));
    expect(s.state.frame).toBe(frame);
    expect(getShots(s.doc)).toEqual([]);
  });

  it('marks a frame outside the cut', () => {
    addShot('A', 10, 20);
    mount();
    act(() => {
      s.state.frame = 50;
    });
    expect(q('sequence-shot')?.textContent).toBe('Frame outside the cut');
    expect(q('sequence-playhead')).toBeNull();
  });
});
