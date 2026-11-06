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
import { installKeymap } from '../src/editor/keymap';
import { EDIT_MENU } from '../src/editor/menus';
import { ViewportInteraction } from '../src/viewport/interaction';
import type { ProjectSession } from '../src/project/session';

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

  it('agents’ editor commands do not become the user’s Repeat Last', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    expect(runResult('mesh.primitive_uv_sphere_add', { name: 'Ball' }, 'mcp')?.ok).toBe(true);
    shiftR();
    expect(s.doc.listObjects().filter((o) => o.name.startsWith('Cube'))).toHaveLength(2);
    expect(s.doc.listObjects().filter((o) => o.name.startsWith('Ball'))).toHaveLength(1);
  });
});
