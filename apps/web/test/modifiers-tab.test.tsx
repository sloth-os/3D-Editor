import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator, createEditorState, type OperatorContext } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { registry, runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Properties, activePropertiesTab, availableTabs } from '../src/ui/properties/Properties';

/** A project session backed by a real document, evaluator, undo manager and operator registry. */
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

function ok(id: string, params: Record<string, unknown> = {}): void {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
}

/**
 * A second replica of the project (another device or an MCP agent) synced both ways like the sync
 * hub; `run` executes an operator there, outside this session's undo history.
 */
function peerReplica(s: ProjectSession): { run: (id: string, params: Record<string, unknown>) => void } {
  const peer = SceneDoc.fromUpdate(s.doc.encodeState(), { type: 'agent' });
  s.doc.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'from-peer') Y.applyUpdate(peer.ydoc, u, 'from-main');
  });
  peer.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'from-main') Y.applyUpdate(s.doc.ydoc, u, 'from-peer');
  });
  const ctx: OperatorContext = {
    doc: peer,
    state: createEditorState(),
    origin: peer.origin,
    source: 'mcp',
    report: () => undefined,
  };
  return {
    run: (id, params) => {
      const r = registry.run(ctx, id, params);
      if (!r.ok) throw new Error(`${id} failed on the peer: ${r.error}`);
    },
  };
}

/** Drags a number field horizontally by `dx` pixels; `during` runs while the button is still down. */
function dragNumber(el: HTMLElement, dx: number, during?: () => void): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 100 + dx / 2, pointerId: 1 });
  if (during) act(during);
  fireEvent.pointerMove(el, { clientX: 100 + dx, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 100 + dx, pointerId: 1 });
}

const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

let s: ProjectSession;
beforeEach(() => {
  localStorage.clear();
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  cleanup();
  sessionSignal.value = null;
});

/** A cube with a Subdivision Surface modifier, shown in the Modifiers tab. */
function cubeWithSubsurf() {
  ok('mesh.primitive_cube_add', { name: 'Cube' });
  ok('object.modifier_add', { object: 'Cube', type: 'SUBSURF' });
  const cube = s.doc.findObjectByName('Cube')!;
  s.state.selectedIds = [cube.id];
  s.state.activeId = cube.id;
  activePropertiesTab.value = 'modifiers';
  const { container } = render(<Properties session={s} />);
  return {
    container,
    modifiers: () => s.doc.findObjectByName('Cube')?.modifiers ?? [],
    field: () => byTestId(container, 'mod-subsurf-render_levels')!,
  };
}

describe('Modifiers tab slider drags next to concurrent edits (other devices, MCP agents)', () => {
  it('previews live and commits one undo step', () => {
    const { modifiers, field } = cubeWithSubsurf();
    const depth = s.undo.undoStack.length;
    let during: number | undefined;
    dragNumber(field(), 8, () => (during = Number(modifiers()[0].params.render_levels)));
    // the preview reached the document while the button was down
    expect(during).toBe(6);
    expect(modifiers()[0].params.render_levels).toBe(6);
    expect(s.undo.undoStack.length).toBe(depth + 1);
    act(() => {
      s.undo.undo();
    });
    expect(modifiers()[0].params.render_levels).toBe(2);
  });

  it('keeps a modifier an agent adds during the drag', () => {
    const { modifiers, field } = cubeWithSubsurf();
    const agent = peerReplica(s);
    dragNumber(field(), 8, () => agent.run('object.modifier_add', { object: 'Cube', type: 'BEVEL' }));
    expect(modifiers().map((m) => m.type)).toEqual(['SUBSURF', 'BEVEL']);
    expect(modifiers()[0].params.render_levels).toBe(6);
    // undoing the drag reverts only the dragged value
    act(() => {
      s.undo.undo();
    });
    expect(modifiers().map((m) => m.type)).toEqual(['SUBSURF', 'BEVEL']);
    expect(modifiers()[0].params.render_levels).toBe(2);
  });

  it('keeps other values of the dragged modifier that an agent changes during the drag', () => {
    const { modifiers, field } = cubeWithSubsurf();
    const agent = peerReplica(s);
    const id = modifiers()[0].id;
    dragNumber(field(), 8, () =>
      agent.run('object.modifier_set', {
        object: 'Cube',
        modifier: id,
        params: { levels: 3 },
        show_render: false,
      }),
    );
    expect(modifiers()[0].params).toMatchObject({ levels: 3, render_levels: 6 });
    expect(modifiers()[0].show_render).toBe(false);
  });

  it('does not bring back a modifier an agent removes during the drag', () => {
    const { modifiers, field } = cubeWithSubsurf();
    const agent = peerReplica(s);
    const id = modifiers()[0].id;
    dragNumber(field(), 8, () => agent.run('object.modifier_remove', { object: 'Cube', modifier: id }));
    expect(modifiers()).toEqual([]);
  });
});

describe('Modifiers tab of curve and text objects', () => {
  it('is shown for curves and text and edits their modifier stack', () => {
    // regression: the tab was only offered for meshes, so the modifiers of a lathe curve (SCREW,
    // SMOOTH_BY_ANGLE) could not be seen or changed in the Properties editor
    ok('curve.add_from_points', {
      name: 'Profile',
      points: [
        [0.1, 0, 0],
        [0.12, 0, 0.1],
        [0.05, 0, 0.2],
      ],
      type: 'POLY',
    });
    ok('object.text_add', { body: 'Hi', name: 'Label' });
    ok('object.modifier_add', { object: 'Profile', type: 'SCREW' });
    ok('object.modifier_add', { object: 'Label', type: 'SOLIDIFY' });
    for (const name of ['Profile', 'Label']) expect(availableTabsOf(name)).toContain('modifiers');
    ok('object.empty_add', { name: 'Marker' });
    expect(availableTabsOf('Marker')).not.toContain('modifiers');

    const profile = s.doc.findObjectByName('Profile')!;
    s.state.selectedIds = [profile.id];
    s.state.activeId = profile.id;
    activePropertiesTab.value = 'modifiers';
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'prop-tab-modifiers')).not.toBeNull();
    expect(byTestId(container, 'prop-content-modifiers')).not.toBeNull();
    expect(container.textContent).toContain('Screw');
    // a parameter edit goes through object.modifier_set
    const steps = byTestId(container, 'mod-screw-steps')!;
    fireEvent.pointerDown(steps, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(steps, { clientX: 100, pointerId: 1 });
    const input = byTestId(container, 'mod-screw-steps')!.querySelector('input')!;
    fireEvent.input(input, { target: { value: '24' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(s.doc.findObjectByName('Profile')!.modifiers[0].params.steps).toBe(24);
    // modifiers of curves bake only as a whole (convert to mesh): Apply says so instead of failing
    const apply = byTestId(container, 'modifier-apply-Screw') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(apply.title).toContain('Object > Convert > Mesh');
    expect(byTestId(container, 'modifier-curve-hint')?.textContent).toContain('wire');
  });
});

function availableTabsOf(name: string) {
  return availableTabs(s.doc.findObjectByName(name));
}
