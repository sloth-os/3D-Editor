import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator, createEditorState, type OperatorContext } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { registry, runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Properties, activePropertiesTab } from '../src/ui/properties/Properties';
import { ikChainsWith } from '../src/ui/properties/DataTab';

/*
 * Per-bone IK locks, limits and stiffness (pose.ik_settings_set) in the bone's panels of the Object
 * Data tab, like Blender's Bone > Inverse Kinematics. Regression: they could only be set and seen
 * through MCP (armature.describe), so a robot arm whose base may only yaw showed no reason for it.
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

function ok(id: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
  return (r.result ?? {}) as Record<string, unknown>;
}

/** An MCP agent's replica of the project, synced both ways like the sync hub. */
function agentReplica(s: ProjectSession): (id: string, params: Record<string, unknown>) => void {
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
  return (id, params) => {
    const r = registry.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed on the agent: ${r.error}`);
  };
}

/** Drags a number field horizontally by `dx` pixels. */
function dragNumber(el: HTMLElement, dx: number): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 100 + dx / 2, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 100 + dx, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 100 + dx, pointerId: 1 });
}

/** Types into a number field (click, type, Enter). */
function typeNumber(el: HTMLElement, value: string): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
  fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
  const input = el.querySelector('input')!;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
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

/** A three-bone arm (Base, Upper, Lower) with an IK constraint on Lower, Data tab open on `bone`. */
function arm(bone: string) {
  ok('object.armature_add', { name: 'Rig', bone_name: 'Base', radius: 0.5 });
  ok('armature.chain_add', {
    object: 'Rig',
    points: [
      [0, 0, 0.5],
      [0, 0, 1.2],
      [0, 0.6, 1.2],
    ],
    names: ['Upper', 'Lower'],
    parent: 'Base',
    use_connect: true,
  });
  ok('object.empty_add', { name: 'Goal', location: [0.5, 0.5, 1] });
  ok('pose.ik_add', { object: 'Rig', bone: 'Lower', target: 'Goal', chain_count: 3 });
  const rig = s.doc.findObjectByName('Rig')!;
  s.state.selectedIds = [rig.id];
  s.state.activeId = rig.id;
  activePropertiesTab.value = 'data';
  const view = render(<Properties session={s} />);
  fireEvent.click(byTestId(view.container, `bone-${bone}`)!);
  const pb = () => s.doc.findObjectByName('Rig')!.pose.bones[bone];
  return { container: view.container, pb };
}

describe('bone IK settings panel', () => {
  it('shows and edits the locks, limits and stiffness through pose.ik_settings_set', () => {
    const { container, pb } = arm('Base');
    const panel = () => container.textContent ?? '';
    expect(panel()).toContain('Inverse Kinematics: Base');
    // the chain that uses the settings
    expect(byTestId(container, 'pose-ik-chains')?.textContent).toContain('IK (Lower)');
    // a yaw-only base: locks about X and Z
    fireEvent.click(byTestId(container, 'pose-ik-lock-x')!);
    fireEvent.click(byTestId(container, 'pose-ik-lock-z')!);
    expect(pb().lock_ik_x).toBe(true);
    expect(pb().lock_ik_z).toBe(true);
    expect(pb().lock_ik_y ?? false).toBe(false);
    expect(byTestId(container, 'pose-ik-lock-x')!.classList.contains('on')).toBe(true);
    // a limit about Y, typed in degrees
    fireEvent.click(byTestId(container, 'pose-ik-limit-y')!);
    expect(pb().use_ik_limit_y).toBe(true);
    typeNumber(byTestId(container, 'pose-ik-min-y')!, '-45');
    typeNumber(byTestId(container, 'pose-ik-max-y')!, '90');
    expect(pb().ik_min_y as number).toBeCloseTo(-Math.PI / 4, 9);
    expect(pb().ik_max_y as number).toBeCloseTo(Math.PI / 2, 9);
    expect(byTestId(container, 'pose-ik-max-y')?.textContent).toContain('90');
    // Min and Max are stacked at the row's full width (side by side in the ~330 px editor, a
    // 70 px field's "Min" label ran into its value)
    const minField = byTestId(container, 'pose-ik-min-y')!;
    expect(minField.parentElement?.classList.contains('vector')).toBe(true);
    expect(byTestId(container, 'pose-ik-max-y')!.parentElement).toBe(minField.parentElement);
    // a slider drag previews live and commits one undo step
    const steps = (s.undo as Y.UndoManager).undoStack.length;
    dragNumber(byTestId(container, 'pose-ik-stiffness-y')!, 30);
    expect(pb().ik_stiffness_y as number).toBeCloseTo(0.3, 9);
    expect((s.undo as Y.UndoManager).undoStack.length).toBe(steps + 1);
    // the solver sees them (armature.describe reports what the panel shows)
    const described = ok('armature.describe', { object: 'Rig' }) as {
      bones: { name: string; ik_settings: Record<string, unknown> | null }[];
    };
    expect(described.bones.find((b) => b.name === 'Base')?.ik_settings).toMatchObject({
      lock_ik_x: true,
      lock_ik_y: false,
      lock_ik_z: true,
      use_ik_limit_y: true,
      ik_stiffness_y: 0.3,
    });
  });

  it('follows changes an MCP agent makes', () => {
    const { container } = arm('Upper');
    const agent = agentReplica(s);
    expect(byTestId(container, 'pose-ik-lock-x')!.classList.contains('on')).toBe(false);
    act(() =>
      agent('pose.ik_settings_set', {
        object: 'Rig',
        bone: 'Upper',
        lock_ik_x: true,
        use_ik_limit_z: true,
        ik_min_z: -Math.PI / 6,
        ik_max_z: Math.PI / 3,
        ik_stiffness_z: 0.5,
      }),
    );
    expect(byTestId(container, 'pose-ik-lock-x')!.classList.contains('on')).toBe(true);
    expect(byTestId(container, 'pose-ik-limit-z')!.classList.contains('on')).toBe(true);
    expect(byTestId(container, 'pose-ik-min-z')?.textContent).toContain('-30');
    expect(byTestId(container, 'pose-ik-max-z')?.textContent).toContain('60');
    expect(byTestId(container, 'pose-ik-stiffness-z')?.textContent).toContain('0.5');
  });

  it('says when no IK chain contains the bone', () => {
    const { container } = arm('Base');
    fireEvent.click(byTestId(container, 'bone-Lower')!);
    // Lower owns the IK constraint: it is part of its own chain
    expect(byTestId(container, 'pose-ik-chains')?.textContent).toContain('IK (Lower)');
    const rig = s.doc.findObjectByName('Rig')!;
    const bones = s.doc.getArmature(rig.data!)!.bones;
    // a chain of 1 bone holds only its owner
    ok('pose.constraint_set', {
      object: 'Rig',
      bone: 'Lower',
      constraint: rig.pose.bones.Lower.constraints![0].id,
      params: { chain_count: 1 },
    });
    expect(ikChainsWith(s.doc.findObjectByName('Rig')!, bones, 'Base')).toEqual([]);
    fireEvent.click(byTestId(container, 'bone-Base')!);
    expect(byTestId(container, 'pose-ik-chains')?.textContent).toContain('No IK chain contains this bone');
  });
});
