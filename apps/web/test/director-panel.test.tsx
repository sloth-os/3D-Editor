import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  DESK_PROPS,
  SceneDoc,
  SceneEvaluator,
  base64Encode,
  deskAspect,
  deskProp,
  exportScene,
  getShots,
  type DeskCheckResult,
  type ShotData,
} from '@3d-editor/core';
import { session as sessionSignal, toasts } from '../src/app/store';
import { registry, runResult, viewport } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { ViewportEngine } from '../src/viewport/engine';
import { DEFAULT_POSE, posePosition } from '../src/viewport/navigation';
import { shotPin } from '../src/viewport/follow-shots';
import { DirectorPanel } from '../src/ui/director/DirectorPanel';
import {
  directorTab,
  followedSelection,
  lastCheck,
  panelSelection,
  selectedShot,
} from '../src/ui/director/state';
import { playSequence, sequencePlaying, stopSequence } from '../src/ui/director/playback';
import { gaitsFor, posesFor } from '../src/ui/director/ActorPanel';
import { copyName, duplicateParams, subjectCandidates, viewFromPose } from '../src/ui/director/shots';

/*
 * The Director workspace's column: the shot list (add from the view, duplicate, delete, reorder,
 * solve, check and its issues), the shot inspector (every field edits the shot through
 * desk.shot_update, one undo step each) and the actor panel (pose, walk or run to the 3D cursor,
 * look at, face). Each button and field is checked against the operator it runs and what that
 * operator left in the document.
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

function ok(id: string, params: Record<string, unknown>): Record<string, unknown> {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
  return (r.result ?? {}) as Record<string, unknown>;
}

/**
 * A shot over scene frames start..end, its own camera at x looking along +Y. The selection stays as
 * it was (desk.shot_add makes the new camera active).
 */
function addShot(name: string, start: number, end: number, extra: Record<string, unknown> = {}): string {
  const x = Number(extra.x ?? 0);
  delete extra.x;
  const [selected, active] = [s.state.selectedIds, s.state.activeId];
  const r = ok('desk.shot_add', {
    name,
    frame_start: start,
    frame_end: end,
    from_view: { position: [x, -8, 1.6], target: [x, 0, 1], lens_mm: 35 },
    solve: false,
    ...extra,
  });
  s.state.selectedIds = selected;
  s.state.activeId = active;
  return (r.shot as { id: string }).id;
}

/** An actor at `location`; the selection stays as it was (desk.actor_add makes the actor active). */
function addActor(name: string, kind = 'adult', location = [0, 0, 0]): string {
  const [selected, active] = [s.state.selectedIds, s.state.activeId];
  const id = ok('desk.actor_add', { kind, name, location }).actor as string;
  s.state.selectedIds = selected;
  s.state.activeId = active;
  return id;
}

const shotNamed = (name: string): ShotData => getShots(s.doc).find((x) => x.name === name)!;
const shotById = (id: string): ShotData => getShots(s.doc).find((x) => x.id === id)!;

/** A viewport stand-in: what addShotFromView reads of it. */
function fakeEngine(viewCamera: () => { id: string } | null = () => null): ViewportEngine {
  const pose = DEFAULT_POSE();
  pose.target.set(1, 2, 1);
  return { pose, width: 1600, height: 900, viewCamera } as unknown as ViewportEngine;
}

let s: ProjectSession;
let ui: ReturnType<typeof render>;
const q = (id: string) => (ui.container as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) =>
  act(() => {
    const el = q(id);
    if (!el) throw new Error(`no ${id}`);
    fireEvent.click(el);
  });

/** Opens the text entry of a number field (a click without dragging), types `text` and confirms it. */
function typeNumber(id: string, text: string): void {
  const el = q(id)!;
  act(() => {
    fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 10, pointerId: 1 });
  });
  const input = q(id)!.querySelector('input')!;
  act(() => {
    fireEvent.input(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
}

function choose(id: string, value: string): void {
  act(() => {
    fireEvent.change(q(id)!, { target: { value } });
  });
}

beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  viewport.engine = fakeEngine();
  directorTab.value = 'shots';
  selectedShot.value = null;
  lastCheck.value = null;
  panelSelection.id = null;
  followedSelection.session = null;
  followedSelection.id = null;
});
afterEach(() => {
  cleanup();
  stopSequence();
  vi.restoreAllMocks();
  viewport.engine = null;
  sessionSignal.value = null;
  localStorage.clear();
});

const mount = () => (ui = render(<DirectorPanel s={s} />));

describe('shot list', () => {
  it('adds a shot from the viewport view, with its lens framing everything the viewport shows', () => {
    mount();
    expect(q('shot-list')?.textContent).toContain('No shots yet');
    click('shot-add');
    const [shot] = getShots(s.doc);
    expect(shot.name).toBe('Shot 1');
    expect(selectedShot.value).toBe(shot.id);
    expect(q('shot-row-Shot 1')?.getAttribute('aria-selected')).toBe('true');
    expect(q('shot-inspector')?.dataset.shot).toBe(shot.id);
    const cam = s.doc.getObject(shot.camera!)!;
    const pose = viewport.engine!.pose;
    const eye = posePosition(pose);
    expect(cam.location[0]).toBeCloseTo(eye.x, 4);
    expect(cam.location[1]).toBeCloseTo(eye.y, 4);
    expect(cam.location[2]).toBeCloseTo(eye.z, 4);
    // the wider of the viewport (16:9 here) and the shots' frame decides the lens
    const widest = Math.max(1600 / 900, deskAspect(s.doc));
    expect(s.doc.getCamera(cam.data!)!.lens).toBeCloseTo(18 / (Math.tan(pose.fovY / 2) * widest), 1);
  });

  it('adds the shot from the camera the viewport looks through in camera view', () => {
    const first = addShot('A', 1, 24, { x: 4 });
    const camera = shotById(first).camera!;
    viewport.engine = fakeEngine(() => ({ id: camera }));
    s.view.cameraView.value = true;
    mount();
    click('shot-add');
    const added = getShots(s.doc)[1];
    const a = s.doc.getObject(camera)!;
    const b = s.doc.getObject(added.camera!)!;
    expect(b.id).not.toBe(a.id);
    for (let i = 0; i < 3; i++) expect(b.location[i]).toBeCloseTo(a.location[i], 4);
    expect(s.doc.getCamera(b.data!)!.lens).toBeCloseTo(35, 3);
  });

  it('makes the selected actors and props (a part counts as its actor) the subjects of a new shot', () => {
    const ada = addActor('Ada');
    const part = s.doc.listObjects().find((o) => deskProp(o, DESK_PROPS.actor) === ada)!;
    s.state.selectedIds = [part.id, ada];
    s.state.activeId = ada;
    mount();
    // the selected actor shows the Actor tab; the shot list is a click away
    expect(directorTab.value).toBe('actor');
    click('director-tab-shots');
    click('shot-add');
    expect(getShots(s.doc)[0].subjects).toEqual([ada]);
  });

  it('duplicates, reorders and deletes shots, each as one step', () => {
    addShot('A', 1, 48, { x: 2, framing: 'medium', notes: 'Ada enters' });
    addShot('B', 49, 96);
    mount();
    click('shot-row-A');
    click('shot-duplicate');
    let shots = getShots(s.doc);
    expect(shots.map((x) => x.name)).toEqual(['A', 'A copy', 'B']);
    const copy = shots[1];
    expect(selectedShot.value).toBe(copy.id);
    expect([copy.frame_start, copy.frame_end, copy.framing, copy.notes]).toEqual([
      1,
      48,
      'medium',
      'Ada enters',
    ]);
    // a camera of its own, standing where the original's does
    expect(copy.camera).not.toBe(shots[0].camera);
    const a = s.doc.getObject(shots[0].camera!)!.location;
    const c = s.doc.getObject(copy.camera!)!.location;
    for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(a[i], 4);

    click('shot-up');
    expect(getShots(s.doc).map((x) => x.name)).toEqual(['A copy', 'A', 'B']);
    expect((q('shot-up') as HTMLButtonElement).disabled).toBe(true);
    click('shot-down');
    click('shot-down');
    expect(getShots(s.doc).map((x) => x.name)).toEqual(['A', 'B', 'A copy']);
    expect((q('shot-down') as HTMLButtonElement).disabled).toBe(true);

    // the camera made for the shot goes with it; the neighbour is selected
    const cam = copy.camera!;
    click('shot-delete');
    shots = getShots(s.doc);
    expect(shots.map((x) => x.name)).toEqual(['A', 'B']);
    expect(s.doc.getObject(cam)).toBeNull();
    expect(selectedShot.value).toBe(shots[1].id);
    // undo brings the shot and its camera back in one step
    act(() => void s.undo.undo());
    expect(getShots(s.doc).map((x) => x.name)).toEqual(['A', 'B', 'A copy']);
    expect(s.doc.getObject(cam)).not.toBeNull();
  });

  it('keeps a camera another shot shoots with when a shot is deleted', () => {
    const a = addShot('A', 1, 24);
    const cam = shotById(a).camera!;
    addShot('B', 25, 48, { camera: cam, from_view: undefined });
    mount();
    click('shot-row-B');
    click('shot-delete');
    expect(getShots(s.doc).map((x) => x.name)).toEqual(['A']);
    expect(s.doc.getObject(cam)).not.toBeNull();
  });

  it('solves the selected shot or all of them', () => {
    addActor('Ada');
    const a = addShot('A', 1, 24, { subjects: ['Ada'], framing: 'medium' });
    mount();
    const spy = vi.spyOn(registry, 'run');
    expect((q('shot-solve') as HTMLButtonElement).disabled).toBe(true);
    click('shot-row-A');
    click('shot-solve');
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'desk.shot_solve', { shots: [a] });
    expect(spy.mock.results.at(-1)?.value.ok).toBe(true);
    click('shot-solve-all');
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'desk.shot_solve', {});
  });

  it('checks the shots, lists the issues and selects an issue’s shot and objects', () => {
    const ada = addActor('Ada');
    addShot('Empty', 1, 24);
    // a camera looking away from its subject
    addShot('Away', 25, 48, {
      subjects: [ada],
      from_view: { position: [0, -8, 1.6], target: [0, -20, 1.6], lens_mm: 35 },
    });
    mount();
    click('shot-check');
    const result = lastCheck.value!.result as DeskCheckResult;
    expect(q('check-summary')?.textContent).toBe(result.summary);
    expect(result.issues.some((i) => i.code === 'empty_shot')).toBe(true);
    const rows = ui.container.querySelectorAll('[data-testid^="check-issue-"]');
    expect(rows.length).toBe(result.issues.length);
    // the shots list how many issues the check found in them
    const awayIssues = result.issues.filter((i) => i.shot === shotNamed('Away').id).length;
    expect(awayIssues).toBeGreaterThan(0);
    expect(q('shot-row-Away')?.querySelector('.issues')?.textContent?.trim()).toBe(`⚠${awayIssues}`);

    const i = result.issues.findIndex((x) => x.shot === shotNamed('Away').id && x.objects.includes(ada));
    expect(i).toBeGreaterThanOrEqual(0);
    click(`check-issue-${i}`);
    const away = shotNamed('Away');
    expect(selectedShot.value).toBe(away.id);
    expect(s.state.selectedIds).toEqual(result.issues[i].objects.filter((id) => s.doc.getObject(id)));
    expect(s.state.activeId).toBe(result.issues[i].objects[0]);
    // the viewport looks through the shot at its first frame
    expect(s.view.cameraView.value).toBe(true);
    expect(s.view.followShots.value).toBe(true);
    expect(shotPin(s.view).value).toBe(away.id);
    expect(s.state.frame).toBe(25);
    // selecting the issue's actor from the panel keeps the Shots tab
    expect(directorTab.value).toBe('shots');

    // a change makes the check out of date
    act(() => void ok('desk.shot_update', { shot: 'Empty', notes: 'later' }));
    expect(q('check-summary')?.textContent).toContain('check again');
    expect(q('shot-row-Away')?.querySelector('.issues')).toBeNull();
  });

  it('moves the selection with the arrow keys and looks through the shot with Enter', () => {
    addShot('A', 1, 24);
    addShot('B', 25, 48);
    mount();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      const list = q('shot-list')!;
      act(() => void fireEvent.keyDown(list, { key: 'ArrowDown' }));
      expect(selectedShot.value).toBe(shotNamed('A').id);
      act(() => void fireEvent.keyDown(list, { key: 'ArrowDown' }));
      act(() => void fireEvent.keyDown(list, { key: 'ArrowDown' }));
      expect(selectedShot.value).toBe(shotNamed('B').id);
      act(() => void fireEvent.keyDown(list, { key: 'Enter' }));
      expect(s.state.frame).toBe(25);
      expect(s.view.cameraView.value).toBe(true);
      act(() => void fireEvent.keyDown(list, { key: 'ArrowUp' }));
      expect(selectedShot.value).toBe(shotNamed('A').id);
      // the editor's frame keys never see them
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outside);
    }
  });

  it('looks through a shot on double-click', () => {
    addShot('A', 1, 24);
    addShot('B', 31, 48);
    mount();
    act(() => void fireEvent.dblClick(q('shot-row-B')!));
    expect(s.state.frame).toBe(31);
    expect(shotPin(s.view).value).toBe(shotNamed('B').id);
  });
});

describe('shot inspector', () => {
  it('edits every field through desk.shot_update, one undo step each', () => {
    const id = addShot('A', 1, 48);
    const other = addShot('B', 49, 72);
    const otherCamera = shotById(other).camera!;
    selectedShot.value = id;
    mount();
    const spy = vi.spyOn(registry, 'run');

    act(() => {
      const input = q('shot-name') as HTMLInputElement;
      fireEvent.input(input, { target: { value: '  Opening  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'desk.shot_update', {
      shot: id,
      name: 'Opening',
    });
    expect(shotById(id).name).toBe('Opening');
    expect(q('shot-row-Opening')).not.toBeNull();

    choose('shot-framing', 'close_up');
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'desk.shot_update', {
      shot: id,
      framing: 'close_up',
    });
    expect(shotById(id).framing).toBe('close_up');
    choose('shot-framing', '');
    expect(shotById(id).framing).toBeNull();
    choose('shot-angle', 'profile_left');
    choose('shot-height', 'low');
    choose('shot-move', 'push_in');
    expect([shotById(id).angle, shotById(id).height, shotById(id).move]).toEqual([
      'profile_left',
      'low',
      'push_in',
    ]);

    choose('shot-camera', otherCamera);
    expect(shotById(id).camera).toBe(otherCamera);
    choose('shot-camera', '');
    expect(shotById(id).camera).toBeNull();

    typeNumber('shot-start', '10');
    expect(shotById(id).frame_start).toBe(10);
    typeNumber('shot-end', '30');
    expect(shotById(id).frame_end).toBe(30);
    // two seconds at 24 fps from frame 10
    typeNumber('shot-duration', '2');
    expect([shotById(id).frame_start, shotById(id).frame_end]).toEqual([10, 57]);

    typeNumber('shot-lens', '50');
    expect(shotById(id).lens_mm).toBe(50);
    click('shot-lens-clear');
    expect(shotById(id).lens_mm).toBeNull();
    expect(q('shot-lens-clear')).toBeNull();

    choose('shot-continuity', 'continuous');
    expect(shotById(id).continuity).toBe('continuous');
    typeNumber('shot-pre-roll', '12');
    expect(shotById(id).pre_roll).toBe(12);

    click('shot-enabled');
    expect(shotById(id).enabled).toBe(false);
    expect(q('shot-row-Opening')?.textContent).toContain('(off)');

    // each edit is one step: undo puts back the shot as it was before the last edit only
    act(() => void s.undo.undo());
    expect(shotById(id).enabled).toBe(true);
    expect(shotById(id).pre_roll).toBe(12);
    act(() => void s.undo.undo());
    expect(shotById(id).pre_roll).toBe(0);
    expect(shotById(id).continuity).toBe('continuous');
  });

  it('does not run an operator for an unchanged value', () => {
    const id = addShot('A', 1, 48);
    selectedShot.value = id;
    mount();
    const spy = vi.spyOn(registry, 'run');
    typeNumber('shot-start', '1');
    act(() => {
      const input = q('shot-name') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'A' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    // an emptied name is not a name
    act(() => {
      const input = q('shot-name') as HTMLInputElement;
      fireEvent.input(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(spy).not.toHaveBeenCalled();
    expect(shotById(id).name).toBe('A');
  });

  it('commits notes on blur or Ctrl+Enter, and Escape puts the stored text back', () => {
    const id = addShot('A', 1, 48);
    selectedShot.value = id;
    mount();
    const notes = () => q('shot-notes') as HTMLTextAreaElement;
    act(() => {
      fireEvent.input(notes(), { target: { value: 'Ada waves' } });
      fireEvent.blur(notes());
    });
    expect(shotById(id).notes).toBe('Ada waves');
    act(() => {
      fireEvent.input(notes(), { target: { value: 'Ada runs' } });
      fireEvent.keyDown(notes(), { key: 'Enter', ctrlKey: true });
    });
    expect(shotById(id).notes).toBe('Ada runs');
    act(() => {
      fireEvent.input(notes(), { target: { value: 'scrap this' } });
      fireEvent.keyDown(notes(), { key: 'Escape' });
    });
    expect(notes().value).toBe('Ada runs');
    act(() => void fireEvent.blur(notes()));
    expect(shotById(id).notes).toBe('Ada runs');
  });

  it('lists actors and props as subjects; an unplanned subject leaves the plan too', () => {
    const ada = addActor('Ada', 'adult', [-1, 0, 0]);
    const ben = addActor('Ben', 'adult', [1, 0, 0]);
    const id = addShot('A', 1, 48, { subjects: [ada] });
    localStorage.setItem('3d-editor:panel:director-shot-layout', '1');
    selectedShot.value = id;
    mount();
    // actors first; their parts and the cameras are not subjects
    expect(subjectCandidates(s.doc).map((c) => c.name)).toEqual(['Ada', 'Ben']);
    expect(q('shot-subject-Ada')?.textContent).toContain('(lead)');
    click('shot-subject-Ben');
    expect(shotById(id).subjects).toEqual([ada, ben]);

    click('shot-layout-add');
    expect(shotById(id).layout).toEqual([{ subject: ada, side: 'left', facing: 'camera' }]);
    click('shot-layout-add');
    expect(shotById(id).layout.map((e) => [e.subject, e.side])).toEqual([
      [ada, 'left'],
      [ben, 'right'],
    ]);
    expect((q('shot-layout-add') as HTMLButtonElement).disabled).toBe(true);
    choose('shot-layout-0-facing', 'right');
    expect(shotById(id).layout[0].facing).toBe('right');

    // Ada stops being a subject: her row of the plan goes with her
    click('shot-subject-Ada');
    expect(shotById(id).subjects).toEqual([ben]);
    expect(shotById(id).layout.map((e) => e.subject)).toEqual([ben]);
    click('shot-layout-0-remove');
    expect(shotById(id).layout).toEqual([]);
  });

  it('names the shot and quotes the notes typed when the shot was removed meanwhile', () => {
    const id = addShot('Close', 1, 48);
    selectedShot.value = id;
    mount();
    const notes = q('shot-notes') as HTMLTextAreaElement;
    act(() => void fireEvent.input(notes, { target: { value: 'Ada walks in from the left' } }));
    // an agent (or another device) removes the shot while the notes are typed
    act(() => void ok('desk.shot_remove', { shots: [id] }));
    toasts.value = [];
    const spy = vi.spyOn(registry, 'run');
    // the field loses the focus: its commit comes after the shot is gone
    act(() => void fireEvent.blur(notes));
    expect(spy).not.toHaveBeenCalled();
    expect(toasts.value).toHaveLength(1);
    const [t] = toasts.value;
    expect(t.level).toBe('warning');
    expect(t.message).toContain("Shot 'Close' was removed meanwhile");
    expect(t.message).toContain('“Ada walks in from the left”');
    expect(t.message).not.toContain(id);
  });

  it('says a name typed for a shot removed meanwhile was not saved', () => {
    const id = addShot('Wide', 1, 48);
    selectedShot.value = id;
    mount();
    const name = q('shot-name') as HTMLInputElement;
    const spy = vi.spyOn(registry, 'run');
    // removed by another device, and the panel not built again yet when the name is confirmed
    ok('desk.shot_remove', { shots: [id] });
    spy.mockClear();
    toasts.value = [];
    act(() => {
      fireEvent.input(name, { target: { value: 'Establishing' } });
      fireEvent.keyDown(name, { key: 'Enter' });
    });
    expect(spy).not.toHaveBeenCalledWith(expect.anything(), 'desk.shot_update', expect.anything());
    expect(toasts.value.map((x) => x.message)).toEqual([
      "Shot 'Wide' was removed meanwhile (by an agent or on another device): what you typed was not saved: “Establishing”",
    ]);
  });

  it('shows the blocking line of the last check for the shot', () => {
    const ada = addActor('Ada');
    const id = addShot('A', 1, 48, { subjects: [ada], framing: 'medium', solve: true });
    selectedShot.value = id;
    mount();
    click('shot-check');
    const line = lastCheck.value!.result.lines.find((l) => l.shot === id)?.line ?? '';
    expect(line).not.toBe('');
    expect(q('shot-blocking-line')?.textContent).toBe(line);
  });
});

describe('store models as subjects', () => {
  /** The objects under `root` (its parts). */
  const partsOf = (root: string) =>
    s.doc.listObjects().filter((o) => {
      for (let p = o.parent; p; p = s.doc.getObject(p)?.parent ?? null) if (p === root) return true;
      return false;
    });
  /** Runs an add operator and puts the selection back (store adds select the new root). */
  function keepSelection<T>(fn: () => T): T {
    const [selected, active] = [s.state.selectedIds, s.state.activeId];
    const r = fn();
    s.state.selectedIds = selected;
    s.state.activeId = active;
    return r;
  }
  /** A built-in model placed with store.add (as the Asset Browser's Add does): its root. */
  const storeAdd = (model: string, location: number[]) =>
    keepSelection(() => ok('store.add', { model, location }).root as string);
  /** A downloaded model inserted with store.insert_files (the cube as a GLB file): its root. */
  function insertModel(id: string, name: string, location: number[]): string {
    const src = SceneDoc.create();
    const cube = src.listObjects().find((o) => o.name === 'Cube')!;
    const glb = exportScene(src, 'glb', { objectIds: [cube.id] }).data;
    return keepSelection(
      () =>
        ok('store.insert_files', {
          entry: {
            id,
            name,
            provider: 'khronos',
            license: { spdx: 'CC-BY-4.0', url: null, attribution: null },
            author: null,
            source_url: null,
          },
          format: 'glb',
          files: { 'model.glb': base64Encode(glb) },
          main: 'model.glb',
          location,
        }).root as string,
    );
  }

  it('frames a placed model as a whole: its root is the subject, its parts are never listed', () => {
    const ada = addActor('Ada', 'adult', [0, 0, 0]);
    const chair = storeAdd('builtin:chair', [2, 0, 0]);
    const box = insertModel('khronos:Box', 'Box', [-2, 0, 0]);
    const chairPart = partsOf(chair)[0];
    const boxPart = partsOf(box)[0];
    // the models' parts: the chair's carries store_part, the downloaded box's nothing of the store
    expect(deskProp(chairPart, 'store_part')).not.toBe('');
    expect(boxPart.custom_props ?? {}).not.toHaveProperty('store_part');
    // the models count as props; none of their parts is offered
    expect(subjectCandidates(s.doc).map((c) => `${c.name} · ${c.role}`)).toEqual([
      'Ada · actor',
      'Box · prop',
      'Wooden chair · prop',
    ]);
    // a click in the viewport selects a part: the shot added frames the whole model
    s.state.selectedIds = [chairPart.id, boxPart.id, box, ada];
    s.state.activeId = chairPart.id;
    mount();
    click('shot-add');
    const [shot] = getShots(s.doc);
    expect(shot.subjects).toEqual([chair, box, ada]);
    expect(q('shot-subject-Wooden chair')?.classList.contains('on')).toBe(true);
    expect(q('shot-subject-Wooden chair')?.textContent).toContain('(lead) · prop');
    expect(q('shot-subject-Box')?.textContent).toContain('prop');
    expect(q(`shot-subject-${chairPart.name}`)).toBeNull();
    expect(q(`shot-subject-${boxPart.name}`)).toBeNull();
  });

  it('keeps a model or a prop placed on another model a subject of its own', () => {
    const chair = storeAdd('builtin:chair', [0, 0, 0]);
    const stacked = storeAdd('builtin:chair', [0, 0, 1]);
    s.doc.updateObject(stacked, { parent: chair });
    const cup = s.doc.addObject({
      type: 'MESH',
      name: 'Cup',
      data: null,
      parent: chair,
      custom_props: { desk_role: 'prop' },
    });
    const [chairName, stackedName] = [chair, stacked].map((id) => s.doc.getObject(id)!.name);
    expect(stackedName).not.toBe(chairName);
    // both chairs and the cup are offered; no part of either chair is
    expect(subjectCandidates(s.doc).map((c) => `${c.name} · ${c.role}`)).toEqual([
      'Cup · prop',
      `${chairName} · prop`,
      `${stackedName} · prop`,
    ]);
    // a part of the stacked chair stands for the stacked chair (not the chair under it)
    const stackedPart = partsOf(stacked)[0];
    s.state.selectedIds = [stackedPart.id, cup];
    s.state.activeId = stackedPart.id;
    mount();
    click('shot-add');
    expect(getShots(s.doc)[0].subjects).toEqual([stacked, cup]);
    expect(q(`shot-subject-${stackedName}`)?.classList.contains('on')).toBe(true);
    expect(q('shot-subject-Cup')?.classList.contains('on')).toBe(true);
    expect(q(`shot-subject-${chairName}`)?.classList.contains('on')).toBe(false);
  });

  it('leaves out models used as set pieces and plain objects', () => {
    const house = storeAdd('builtin:house', [0, 6, 0]);
    s.doc.updateObject(house, {
      custom_props: { ...s.doc.getObject(house)!.custom_props, desk_role: 'set' },
    });
    const plain = s.doc.addObject({ type: 'MESH', name: 'Plain', data: null });
    s.state.selectedIds = [partsOf(house)[0].id, plain];
    s.state.activeId = plain;
    mount();
    click('shot-add');
    expect(getShots(s.doc)[0].subjects).toEqual([]);
    expect(subjectCandidates(s.doc).map((c) => c.name)).toEqual(['Plain']);
  });
});

describe('another project opened', () => {
  it('forgets the check, the followed selection and the playback of the project that closed', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    try {
      const ada = addActor('Ada');
      addShot('A', 1, 24, { subjects: [ada] });
      mount();
      click('shot-check');
      act(() => {
        s.state.activeId = ada;
      });
      playSequence(s);
      expect(lastCheck.value?.session).toBe(s);
      expect(followedSelection.session).toBe(s);
      expect(sequencePlaying.value).toBe(true);
      // the same project again (a re-render, another workspace): kept
      sessionSignal.value = s;
      expect(lastCheck.value?.session).toBe(s);
      cleanup();
      const next = fakeSession();
      sessionSignal.value = next;
      expect(lastCheck.value).toBeNull();
      expect(followedSelection).toEqual({ session: null, id: null });
      expect(sequencePlaying.value).toBe(false);
      // closing every project forgets them too
      lastCheck.value = {
        session: next,
        revision: 0,
        result: { issues: [], lines: [], layouts: [], summary: '' },
      };
      sessionSignal.value = null;
      expect(lastCheck.value).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('duplicate parameters', () => {
  it('copies the description over the same frames, right after the shot', () => {
    const id = addShot('A', 5, 20, { framing: 'wide', notes: 'n', pre_roll: 4 });
    const p = duplicateParams(s.doc, shotById(id), 0);
    expect(p).toMatchObject({
      name: 'A copy',
      frame_start: 5,
      frame_end: 20,
      framing: 'wide',
      notes: 'n',
      pre_roll: 4,
      index: 1,
      solve: false,
    });
    expect(p).not.toHaveProperty('angle');
    expect(p.from_view).toBeDefined();
    // without a camera to stand where, the copy is solved
    ok('desk.shot_update', { shot: id, camera: null });
    const q2 = duplicateParams(s.doc, shotById(id), 3);
    expect(q2.from_view).toBeUndefined();
    expect(q2.solve).toBe(true);
    expect(q2.index).toBe(4);
  });

  it('keeps copy names within 64 characters', () => {
    const long = 'x'.repeat(64);
    expect(copyName(long)).toHaveLength(64);
    expect(copyName(long).endsWith(' copy')).toBe(true);
    expect(copyName('Shot 1')).toBe('Shot 1 copy');
  });

  it('frames everything the viewport shows', () => {
    const pose = DEFAULT_POSE();
    const tall = viewFromPose(pose, 1, 16 / 9);
    const wide = viewFromPose(pose, 3, 16 / 9);
    // a wider viewport needs a wider (shorter) lens
    expect(wide.lens_mm).toBeLessThan(tall.lens_mm);
    expect(tall.lens_mm).toBeCloseTo(18 / (Math.tan(pose.fovY / 2) * (16 / 9)), 1);
    // clamped to the lenses shots take
    pose.fovY = 3.1;
    expect(viewFromPose(pose, 1, 1).lens_mm).toBeGreaterThanOrEqual(8);
    pose.fovY = 0.0001;
    expect(viewFromPose(pose, 1, 1).lens_mm).toBeLessThanOrEqual(800);
  });
});

describe('actor panel', () => {
  it('follows the selection: an actor shows the Actor tab, a shot camera its shot', () => {
    const ada = addActor('Ada');
    const id = addShot('A', 1, 48);
    mount();
    act(() => {
      s.state.selectedIds = [ada];
      s.state.activeId = ada;
    });
    expect(directorTab.value).toBe('actor');
    expect(q('actor-panel')?.dataset.actor).toBe(ada);
    expect(q('actor-kind')?.textContent).toBe('Adult');
    expect(q('actor-height')?.textContent).toMatch(/^\d\.\d\d m$/);
    // a part of the actor shows the same actor
    const part = s.doc.listObjects().find((o) => deskProp(o, DESK_PROPS.actor) === ada)!;
    act(() => {
      s.state.activeId = part.id;
    });
    expect(q('actor-panel')?.dataset.actor).toBe(ada);
    // the shot's camera selects the shot and shows the Shots tab
    act(() => {
      s.state.activeId = shotById(id).camera;
    });
    expect(selectedShot.value).toBe(id);
    expect(directorTab.value).toBe('shots');
  });

  it('never leaves the Assets tab for a selection', () => {
    const ada = addActor('Ada');
    directorTab.value = 'assets';
    mount();
    expect(q('asset-browser')).not.toBeNull();
    act(() => {
      s.state.activeId = ada;
    });
    expect(directorTab.value).toBe('assets');
  });

  it('directs the actor at the current frame', () => {
    const ada = addActor('Ada', 'adult', [0, 0, 0]);
    const ben = addActor('Ben', 'adult', [3, 0, 0]);
    s.state.activeId = ada;
    s.state.frame = 20;
    s.state.cursorLocation = [2, 4, 0.5];
    directorTab.value = 'actor';
    mount();
    const spy = vi.spyOn(registry, 'run');
    const last = () => spy.mock.calls.at(-1)!.slice(1);
    const lastOk = () => spy.mock.results.at(-1)?.value.ok;

    choose('actor-pose', 'wave');
    expect(last()).toEqual(['desk.actor_pose', { actor: ada, pose: 'wave', frame: 20 }]);
    expect(lastOk()).toBe(true);
    // the dropdown shows its prompt again
    expect((q('actor-pose') as HTMLSelectElement).value).toBe('');

    // the feet stay on the level they stand on
    click('actor-walk');
    expect(last()).toEqual([
      'desk.actor_move',
      { actor: ada, points: [[2, 4, 0]], frame_start: 20, gait: 'walk' },
    ]);
    expect(lastOk()).toBe(true);
    click('actor-run');
    expect((last()[1] as { gait: string }).gait).toBe('run');

    choose('actor-look-at', ben);
    expect(last()).toEqual(['desk.actor_look_at', { actor: ada, target: ben, frame: 20 }]);
    expect(lastOk()).toBe(true);
    choose('actor-look-at', '-');
    expect(last()).toEqual(['desk.actor_look_at', { actor: ada, target: null, frame: 20 }]);

    click('actor-face-cursor');
    expect(last()).toEqual(['desk.actor_face', { actor: ada, target: [2, 4, 0.5], frame: 20 }]);
    expect(lastOk()).toBe(true);
  });

  it('offers the gaits and poses of the kind', () => {
    expect(gaitsFor('adult')).toEqual(['walk', 'run']);
    expect(gaitsFor('dog')).toEqual(['walk', 'trot', 'gallop']);
    expect(posesFor('child')).toContain('wave');
    expect(posesFor('horse')).not.toContain('wave');
    const dog = addActor('Rex', 'dog');
    s.state.activeId = dog;
    directorTab.value = 'actor';
    mount();
    expect(q('actor-gallop')).not.toBeNull();
    expect(q('actor-run')).toBeNull();
  });

  it('adds an actor of a kind when none is selected', () => {
    directorTab.value = 'actor';
    mount();
    expect(q('actor-panel-empty')).not.toBeNull();
    click('actor-add-adult');
    const actors = s.doc.listObjects().filter((o) => deskProp(o, DESK_PROPS.role) === 'actor');
    expect(actors).toHaveLength(1);
    expect(deskProp(actors[0], DESK_PROPS.kind)).toBe('adult');
  });
});
