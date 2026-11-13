import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator, selectionFromFaces } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { hoveredArea, registry, run, runResult, viewport } from '../src/editor/editor';
import {
  continueRepeat,
  lastOperator,
  lastRepeat,
  redoLast,
  repeatLast,
  type RepeatAction,
} from '../src/editor/runner';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { registerUiOperators } from '../src/editor/ui-operators';
import { TYPING_PAUSE_MS, installKeymap } from '../src/editor/keymap';
import { EDIT_MENU } from '../src/editor/menus';
import { ViewportInteraction } from '../src/viewport/interaction';
import { ProjectSession } from '../src/project/session';
import { closeProject, createProject, openProject } from '../src/project/manager';

/** A project session backed by a real document, evaluator, undo manager and operator registry. */
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
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

function ok(id: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
  return (r.result ?? {}) as Record<string, unknown>;
}

function select(s: ProjectSession, ...names: string[]): void {
  const ids = names.map((n) => s.doc.findObjectByName(n)!.id);
  s.state.selectedIds = ids;
  s.state.activeId = ids[ids.length - 1];
}

const press = (key: string, mods: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ...mods }));
const shiftR = () => press('R', { shiftKey: true });

/** Stands in for the viewport: records the interactive transforms the operators start. */
function fakeViewport(): { modals: { kind: string; continues: RepeatAction | null }[] } {
  const modals: { kind: string; continues: RepeatAction | null }[] = [];
  viewport.interaction = {
    modal: null,
    startModal: (kind: string, continues: RepeatAction | null = null) => modals.push({ kind, continues }),
  } as unknown as ViewportInteraction;
  return { modals };
}

/** Confirms an interactive move the way ViewportInteraction.finishModal does. */
function confirmMove(continues: RepeatAction | null, value: number[]): void {
  continueRepeat(continues);
  expect(run('transform.translate', { value }, 'hotkey')).toBe(true);
}

const names = (s: ProjectSession) => s.doc.listObjects().map((o) => o.name);
const x = (s: ProjectSession, name: string) => s.doc.findObjectByName(name)!.location[0];

let s: ProjectSession;
let uninstall: () => void;
beforeAll(() => {
  if (!registry.has('wm.call_menu')) registerUiOperators(registry);
});
beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  lastOperator.value = null;
  lastRepeat.value = null;
  hoveredArea.value = 'viewport';
  uninstall = installKeymap();
});
afterEach(() => {
  uninstall();
  viewport.interaction = null;
  sessionSignal.value = null;
  lastOperator.value = null;
  lastRepeat.value = null;
});

describe('Repeat Last (Shift+R)', () => {
  it('after Duplicate and Move, duplicates the copy and moves it by the same offset, as new steps', async () => {
    // regression: Shift+R re-ran the last operation in place (redoLast), so no second copy appeared
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    const { modals } = fakeViewport();
    press('D', { shiftKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(modals).toHaveLength(1);
    expect(modals[0].continues?.steps.map((st) => st.id)).toEqual(['object.duplicate']);
    confirmMove(modals[0].continues, [3, 0, 0]);
    expect(names(s)).toEqual(['Cube', 'Cube.001']);
    expect(lastRepeat.value).toMatchObject({
      label: 'Duplicate Objects',
      steps: [
        { id: 'object.duplicate', params: { linked: false } },
        { id: 'transform.translate', params: { value: [3, 0, 0] } },
      ],
    });
    const depth = s.undo.undoStack.length;

    shiftR();
    expect(names(s)).toEqual(['Cube', 'Cube.001', 'Cube.002']);
    expect(x(s, 'Cube')).toBeCloseTo(0);
    expect(x(s, 'Cube.001')).toBeCloseTo(3);
    expect(x(s, 'Cube.002')).toBeCloseTo(6);
    // the new copy is the selection, and no modal transform was started again
    expect(s.state.selectedIds).toEqual([s.doc.findObjectByName('Cube.002')!.id]);
    expect(modals).toHaveLength(1);
    // new undo steps: the repeat is undone without touching the original duplicate
    expect(s.undo.undoStack.length).toBeGreaterThan(depth);
    shiftR();
    expect(x(s, 'Cube.003')).toBeCloseTo(9);
    while (s.undo.undoStack.length > depth) s.undo.undo();
    expect(names(s)).toEqual(['Cube', 'Cube.001']);
    expect(x(s, 'Cube.001')).toBeCloseTo(3);
  });

  it('repeats an added primitive with the settings it was added with', () => {
    ok('mesh.primitive_cube_add', { name: 'Box', size: 0.5, location: [1, 2, 3] });
    expect(lastRepeat.value?.label).toBe(registry.get('mesh.primitive_cube_add')!.label);
    shiftR();
    const added = s.doc.listObjects().filter((o) => o.name !== 'Box');
    expect(added).toHaveLength(1);
    expect(added[0].location).toEqual([1, 2, 3]);
    expect(s.doc.getMesh(added[0].data!)!.positions.slice(0, 3).map(Math.abs)).toEqual([0.25, 0.25, 0.25]);
  });

  it('a property edit or a selection change in between does not replace what it repeats', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    // the Properties editor (data.set_property), the outliner (rename) and selection operators
    expect(run('data.set_property', { kind: 'objects', target: 'Cube', values: { scale: [2, 2, 2] } })).toBe(
      true,
    );
    expect(run('object.rename', { object: 'Cube', name: 'Big' })).toBe(true);
    expect(run('object.select_all', { action: 'DESELECT' })).toBe(true);
    shiftR();
    expect(s.doc.listObjects()).toHaveLength(2);
    expect(lastRepeat.value?.steps.map((st) => st.id)).toEqual(['mesh.primitive_cube_add']);
  });

  it('repeats the parameters set in Adjust Last Operation, keeping the duplicate before the move', async () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    const { modals } = fakeViewport();
    expect(run('object.duplicate_move', {}, 'menu')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    confirmMove(modals[0].continues, [3, 0, 0]);
    expect(lastOperator.value?.id).toBe('transform.translate');
    expect(redoLast(s, registry, { value: [0, 2, 0] })?.ok).toBe(true);
    expect(s.doc.findObjectByName('Cube.001')!.location).toEqual([0, 2, 0]);
    expect(lastRepeat.value?.steps.map((st) => [st.id, (st.params as { value?: number[] }).value])).toEqual([
      ['object.duplicate', undefined],
      ['transform.translate', [0, 2, 0]],
    ]);
    shiftR();
    expect(s.doc.findObjectByName('Cube.002')!.location).toEqual([0, 4, 0]);
  });

  it('in Edit Mode, E then a move repeats as extrude and move', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('object.mode_set', { mode: 'EDIT' });
    const mesh = () => s.doc.getMesh(s.doc.findObjectByName('Cube')!.data!)!;
    // the face whose vertices all lie at z = +1
    const top = mesh().faces.findIndex((f) => f.every((v) => mesh().positions[v * 3 + 2] > 0.9));
    expect(top).toBeGreaterThanOrEqual(0);
    s.state.meshSelection = selectionFromFaces(mesh(), [top]);
    const { modals } = fakeViewport();
    press('e');
    expect(modals).toHaveLength(1);
    expect(modals[0].continues?.steps.map((st) => st.id)).toEqual(['mesh.extrude_region_move']);
    confirmMove(modals[0].continues, [0, 0, 1]);
    const maxZ = () => Math.max(...Array.from(mesh().positions).filter((_, i) => i % 3 === 2));
    const verts = () => mesh().positions.length / 3;
    expect(maxZ()).toBeCloseTo(2);
    expect(verts()).toBe(12);
    shiftR();
    expect(verts()).toBe(16);
    expect(maxZ()).toBeCloseTo(3);
  });

  it('ViewportInteraction.finishModal makes the confirmed transform continue the operation it completes', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('object.duplicate', {});
    const action = lastRepeat.value;
    const host = { run: vi.fn((id: string, params?: unknown) => run(id, params, 'hotkey')) };
    const modal = {
      kind: 'translate',
      finish: () => ({ operator: 'transform.translate', params: { value: [0, 0, 5] } }),
    };
    const finish = (continues: RepeatAction | null) =>
      ViewportInteraction.prototype.finishModal.call(
        { modal, modalContinues: continues, host } as unknown as ViewportInteraction,
        true,
      );
    finish(action);
    expect(host.run).toHaveBeenCalledOnce();
    expect(lastRepeat.value?.steps.map((st) => st.id)).toEqual(['object.duplicate', 'transform.translate']);
    // a plain G (no operation to continue) is repeated on its own
    finish(null);
    expect(lastRepeat.value?.steps.map((st) => st.id)).toEqual(['transform.translate']);
  });

  it('says there is nothing to repeat, and the Edit menu offers it only when there is', () => {
    const repeatItem = () => EDIT_MENU().find((i) => i.op === 'screen.repeat_last')!;
    expect(repeatItem().enabled?.()).toBe(false);
    const r = runResult('screen.repeat_last', {}, 'menu');
    expect(r?.ok).toBe(false);
    expect(r?.error).toBe('Nothing to repeat');
    expect(repeatLast(s, registry)).toBeNull();
    ok('mesh.primitive_plane_add', { name: 'Plane' });
    expect(repeatItem().enabled?.()).toBe(true);
    expect(runResult('screen.repeat_last', {}, 'menu')?.result).toEqual({
      repeated: registry.get('mesh.primitive_plane_add')!.label,
      ok: true,
    });
    expect(s.doc.listObjects()).toHaveLength(2);
  });

  it('another project opened in the tab (File > New, Open) starts without the previous one’s history', async () => {
    // regression: the history outlived its project, so after File > New (no page reload) Edit >
    // Repeat Last was enabled and Shift+R re-ran the previous project's last operation in the new one
    sessionSignal.value = null;
    const a = await createProject('Repeat A', { empty: true });
    const b = { id: '' };
    try {
      ok('mesh.primitive_cone_add', { name: 'ConeA', location: [3, 0, 0] });
      expect(lastRepeat.value?.steps.map((st) => st.id)).toEqual(['mesh.primitive_cone_add']);
      expect(lastOperator.value?.id).toBe('mesh.primitive_cone_add');
      const repeatItem = () => EDIT_MENU().find((i) => i.op === 'screen.repeat_last')!;
      expect(repeatItem().enabled?.()).toBe(true);

      const sb = await createProject('Repeat B');
      b.id = sb.id;
      expect(sessionSignal.value).toBe(sb);
      expect(lastRepeat.value).toBeNull();
      // Adjust Last Operation has nothing to adjust either (its undo depth check alone would let the
      // old operation through once the new project's undo stack reached the same depth)
      expect(lastOperator.value).toBeNull();
      expect(repeatItem().enabled?.()).toBe(false);
      shiftR();
      expect(runResult('screen.repeat_last', {}, 'menu')?.error).toBe('Nothing to repeat');
      expect(names(sb).sort()).toEqual(['Camera', 'Cube', 'Light']);
      // what is done in the new project is what repeats there
      ok('mesh.primitive_plane_add', { name: 'Plane' });
      shiftR();
      expect(names(sb).filter((n) => n.startsWith('Plane'))).toHaveLength(2);
      expect(names(sb).some((n) => n.startsWith('Cone'))).toBe(false);

      // opening the first project again does not bring the second one's history along
      const reopened = await openProject(a.id);
      expect(lastRepeat.value).toBeNull();
      expect(lastOperator.value).toBeNull();
      const before = names(reopened);
      shiftR();
      expect(names(reopened)).toEqual(before);
    } finally {
      closeProject();
      await ProjectSession.deleteLocal(a.id);
      if (b.id) await ProjectSession.deleteLocal(b.id);
    }
    expect(lastRepeat.value).toBeNull();
  });

  it('agents’ editor commands do not become the user’s Repeat Last', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    expect(runResult('mesh.primitive_uv_sphere_add', { name: 'Ball' }, 'mcp')?.ok).toBe(true);
    shiftR();
    expect(s.doc.listObjects().filter((o) => o.name.startsWith('Cube'))).toHaveLength(2);
    expect(s.doc.listObjects().filter((o) => o.name.startsWith('Ball'))).toHaveLength(1);
  });
});

describe('keys typed on after the field they were typed into was taken away', () => {
  /** A text field typed into, then taken away under the typing (an agent removed what it edits). */
  function typeInRemovedField(): HTMLInputElement {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
    field.remove();
    return field;
  }
  beforeEach(() => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('are not shortcuts while the typing goes on (X does not delete, Space does not play)', () => {
    // regression: the letters typed on reached the viewport keymap: X deleted the selected objects
    typeInRemovedField();
    press('x');
    press(' ');
    press('x');
    expect(names(s)).toEqual(['Cube']);
    expect(s.view.playing.value).toBe(false);
  });

  it.each([['Enter'], ['Escape'], ['Tab']])('%s ends the typing: the next shortcut works', (key) => {
    typeInRemovedField();
    press(key);
    press('x');
    expect(names(s)).toEqual([]);
  });

  it('a click ends the typing', () => {
    typeInRemovedField();
    window.dispatchEvent(new Event('pointerdown'));
    press('x');
    expect(names(s)).toEqual([]);
  });

  it('a pause in the typing ends it', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    typeInRemovedField();
    now += TYPING_PAUSE_MS - 1;
    press('a');
    // each key typed on extends the typing
    now += TYPING_PAUSE_MS - 1;
    press('x');
    expect(names(s)).toEqual(['Cube']);
    now += TYPING_PAUSE_MS + 1;
    press('x');
    expect(names(s)).toEqual([]);
  });

  it('are not shortcuts after the field lost the focus to no element, staying in the page', () => {
    // regression: an agent reordered the list the field is in; Chromium took the focus from the field
    // it moved, which stayed in the page, and the keys typed on played the animation and deleted
    const field = document.createElement('input');
    document.body.appendChild(field);
    try {
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
      field.blur();
      expect(field.isConnected).toBe(true);
      press(' ');
      press('x');
      expect(names(s)).toEqual(['Cube']);
      expect(s.view.playing.value).toBe(false);
    } finally {
      field.remove();
    }
  });

  it('keys after the page moves the focus on from the field to another element are shortcuts', () => {
    const field = document.createElement('input');
    const item = document.createElement('button');
    document.body.append(field, item);
    try {
      field.focus();
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
      item.focus();
      press('x');
      expect(names(s)).toEqual([]);
    } finally {
      field.remove();
      item.remove();
    }
  });
});
