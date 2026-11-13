import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';
import { h } from 'preact';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import {
  OperatorError,
  OperatorRegistry,
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createFCurve,
  defineOperator,
  fcurveKey,
  insertKeyframe,
  type EditorState,
  type OperatorContext,
} from '@3d-editor/core';
import { session as sessionSignal, toasts } from '../src/app/store';
import { registry, runResult } from '../src/editor/editor';
import { infoLog, lastOperator, redoLast, runOperator } from '../src/editor/runner';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { registerUiOperators } from '../src/editor/ui-operators';
import { enableRedoPanelOperators } from '../src/editor/menus';
import type { ProjectSession } from '../src/project/session';
import { RedoPanel } from '../src/ui/RedoPanel';
import { removalLikeChromium, settle } from './removal';

/** A project session backed by a real document, evaluator, undo manager and operator registry. */
function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  const undoRevision = signal(0);
  undo.on('stack-item-added', () => undoRevision.value++);
  undo.on('stack-item-popped', () => undoRevision.value++);
  return {
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision,
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

/**
 * Runs an operator as the agent; `doc` is the agent's replica (for edits without an operator) and
 * `state` its editor state (its selection, pivot point and 3D cursor). While paused, the replicas
 * keep their updates for each other, as on a slow connection: their edits are made at the same
 * time, neither seeing the other's.
 */
type Agent = ((id: string, params: Record<string, unknown>) => void) & {
  doc: SceneDoc;
  state: EditorState;
  pause: () => void;
  resume: () => void;
};
/**
 * An MCP agent's replica of the project, synced both ways like the sync hub: its edits reach the
 * session as remote updates, which are not on the session's undo stack. `clientID` fixes the
 * replica's Yjs client id (Yjs orders values set at the same time by client id).
 */
function agentReplica(s: ProjectSession, opts: { clientID?: number } = {}): Agent {
  const peer = SceneDoc.fromUpdate(s.doc.encodeState(), { type: 'agent' });
  if (opts.clientID !== undefined) peer.ydoc.clientID = opts.clientID;
  let paused = false;
  const toPeer: Uint8Array[] = [];
  const toSession: Uint8Array[] = [];
  s.doc.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'from-peer') return;
    if (paused) toPeer.push(u);
    else Y.applyUpdate(peer.ydoc, u, 'from-main');
  });
  peer.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'from-main') return;
    if (paused) toSession.push(u);
    else Y.applyUpdate(s.doc.ydoc, u, 'from-peer');
  });
  const pause = () => {
    paused = true;
  };
  const resume = () => {
    paused = false;
    for (const u of toSession.splice(0)) Y.applyUpdate(s.doc.ydoc, u, 'from-peer');
    for (const u of toPeer.splice(0)) Y.applyUpdate(peer.ydoc, u, 'from-main');
  };
  const ctx: OperatorContext = {
    doc: peer,
    state: createEditorState(),
    origin: peer.origin,
    source: 'mcp',
    report: () => undefined,
  };
  const run = (id: string, params: Record<string, unknown>) => {
    const r = registry.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed on the agent: ${r.error}`);
  };
  return Object.assign(run, { doc: peer, state: ctx.state, pause, resume });
}

/** Whether the Adjust Last Operation panel is still offered for the last operator. */
const panelOffered = (s: ProjectSession) =>
  !!lastOperator.value && s.undo.undoStack.length === lastOperator.value.undoDepth;

let s: ProjectSession;
beforeAll(() => {
  if (!registry.has('wm.call_menu')) registerUiOperators(registry);
  enableRedoPanelOperators();
});
beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  lastOperator.value = null;
});
afterEach(() => {
  cleanup();
  sessionSignal.value = null;
  lastOperator.value = null;
});

describe('redoLast keeps the original result when the re-run fails', () => {
  it('a rejected value leaves the constraint, the undo history, the selection and the panel as they were', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.light_add', { name: 'Light' });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    select(s, 'Cube');
    ok('object.constraint_add', { type: 'FOLLOW_PATH', target: 'Path' });
    const cube = () => s.doc.findObjectByName('Cube')!;
    const original = cube().constraints[0];
    expect(original.type).toBe('FOLLOW_PATH');
    const depth = s.undo.undoStack.length;
    const last = lastOperator.value!;
    expect(last.id).toBe('object.constraint_add');

    const light = s.doc.findObjectByName('Light')!.id;
    const res = redoLast(s, registry, { ...(last.params as object), target: light });
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/needs a CURVE target/);
    // the original constraint is back (same id: the undone step was redone, not re-run)
    expect(cube().constraints.map((c) => [c.id, c.type, c.target])).toEqual([
      [original.id, 'FOLLOW_PATH', s.doc.findObjectByName('Path')!.id],
    ]);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(lastOperator.value).toBe(last);
    expect(panelOffered(s)).toBe(true);
    expect(s.state.activeId).toBe(cube().id);
    // the panel keeps working: a valid value re-runs, and one undo step removes the constraint
    expect(redoLast(s, registry, { ...(last.params as object), influence: 0.5 })?.ok).toBe(true);
    expect(cube().constraints).toHaveLength(1);
    expect(cube().constraints[0].influence).toBe(0.5);
    expect(s.undo.undoStack.length).toBe(depth);
    s.undo.undo();
    expect(cube().constraints).toHaveLength(0);
  });

  it('restores the selection the operation left, not the one it started from', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('object.duplicate', { offset: [2, 0, 0] });
    const copy = s.doc.findObjectByName('Cube.001')!.id;
    expect(s.state.activeId).toBe(copy);
    // offset must be a 3-vector: the re-run fails parameter validation
    expect(redoLast(s, registry, { offset: [1, 2] })?.ok).toBe(false);
    expect(s.doc.listObjects().map((o) => o.name)).toEqual(['Cube', 'Cube.001']);
    expect(s.doc.getObject(copy)!.location[0]).toBeCloseTo(2);
    expect(s.state.activeId).toBe(copy);
    expect(s.state.selectedIds).toEqual([copy]);
    expect(panelOffered(s)).toBe(true);
  });

  it('a failed turntable re-run keeps the turntable it created', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('anim.turntable', { target: 'Cube' });
    const camera = s.doc.findObjectByName('Turntable Camera')!.id;
    const params = lastOperator.value!.params as Record<string, unknown>;
    // the camera the operation created is gone once it is undone: the re-run cannot use it
    const res = redoLast(s, registry, { ...params, camera });
    expect(res?.ok).toBe(false);
    expect(s.doc.getObject(camera)?.name).toBe('Turntable Camera');
    expect(s.doc.findObjectByName('Turntable Pivot')).not.toBeNull();
    expect(s.doc.getScene().camera).toBe(camera);
    expect(panelOffered(s)).toBe(true);
  });

  it('does not undo an earlier operation when the last one changed nothing', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('mesh.primitive_cube_add', { name: 'Other', location: [3, 0, 0] });
    select(s, 'Other', 'Cube');
    // aligning the Cube to itself: nothing moves, so the operator adds no undo step
    ok('object.align', { objects: [s.doc.findObjectByName('Cube')!.id], axis: ['X'] });
    expect(lastOperator.value?.id).toBe('object.align');
    expect(redoLast(s, registry, { ...(lastOperator.value!.params as object), mode: 'MIN' })?.ok).toBe(true);
    // the Other cube (the operation before) is still there
    expect(
      s.doc
        .listObjects()
        .map((o) => o.name)
        .sort(),
    ).toEqual(['Cube', 'Other']);
  });

  it('reverts partial changes of a late failure and brings the original result back', () => {
    // an operator that changes the document before it fails (a late failure)
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.set_range',
        label: 'Set Range',
        description: 'Sets the frame range; fail = true fails after changing frame_start',
        category: 'Test',
        redoable: true,
        schema: z.object({ start: z.number(), end: z.number(), fail: z.boolean().default(false) }),
        execute(ctx, p) {
          ctx.doc.updateScene({ frame_start: p.start });
          if (p.fail) throw new OperatorError('late failure', 'FAILED');
          ctx.doc.updateScene({ frame_end: p.end });
          return {};
        },
      }),
    );
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    expect(runOperator(s, reg, 'test.set_range', { start: 5, end: 50 }, 'test').ok).toBe(true);
    const depth = s.undo.undoStack.length;
    const range = () => [s.doc.getScene().frame_start, s.doc.getScene().frame_end];
    expect(range()).toEqual([5, 50]);
    expect(redoLast(s, reg, { start: 7, end: 70, fail: true })?.ok).toBe(false);
    expect(range()).toEqual([5, 50]);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(lastOperator.value).toMatchObject({ id: 'test.set_range', params: { start: 5, end: 50 } });
    expect(panelOffered(s)).toBe(true);
    // one undo removes the operation; the cube added before it stays
    s.undo.undo();
    expect(range()).not.toEqual([5, 50]);
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    // the failed variant does not come back with Redo
    s.undo.redo();
    expect(range()).toEqual([5, 50]);
  });
});

// ------------------------------------------------------------------ the panel itself

/** Renders the viewport's Adjust Last Operation panel for the last operator. */
function panel(): HTMLElement {
  cleanup();
  const root = render(h(RedoPanel, { s })).container as HTMLElement;
  return root;
}
const field = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const optionLabels = (el: HTMLElement | null) =>
  [...((el as HTMLSelectElement | null)?.options ?? [])].map((o) => o.textContent);
const shown = (root: HTMLElement, key: string) =>
  [0, 1, 2].map((i) => field(root, `redo-${key}-${i}`)?.querySelector('.nf-value')?.textContent);
const id = (name: string) => s.doc.findObjectByName(name)!.id;

/** Types into a text field and confirms with Enter. */
function typeText(el: HTMLElement, value: string): void {
  const input = (el.tagName === 'INPUT' ? el : el.querySelector('input')) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Types into a Blender-style number field (click, type, Enter). */
function typeNumber(el: HTMLElement, value: string): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
  fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
  const input = el.querySelector('input')!;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Adjust Last Operation only offers values the operator accepts', () => {
  it('Add Constraint: the target lists fitting objects without the owner, and the type is a choice', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.light_add', { name: 'Light' });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    ok('curve.primitive_bezier_curve_add', { name: 'Rail' });
    select(s, 'Cube');
    ok('object.constraint_add', { type: 'FOLLOW_PATH', target: 'Path' });
    let root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Add Constraint');
    // Follow Path needs a curve, and never the owner
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Path', 'Rail']);
    const type = field(root, 'redo-type') as HTMLSelectElement;
    expect(type.tagName).toBe('SELECT');
    expect(type.value).toBe('FOLLOW_PATH');
    expect(optionLabels(type)).toContain('Limit Location');
    expect(optionLabels(type)).not.toContain('IK');

    fireEvent.change(field(root, 'redo-target')!, { target: { value: id('Rail') } });
    const cube = () => s.doc.findObjectByName('Cube')!;
    expect(cube().constraints.map((c) => [c.type, c.target])).toEqual([['FOLLOW_PATH', id('Rail')]]);

    // Copy Location takes any object but the owner; the curve target stays
    root = panel();
    fireEvent.change(field(root, 'redo-type')!, { target: { value: 'COPY_LOCATION' } });
    expect(cube().constraints.map((c) => [c.type, c.target])).toEqual([['COPY_LOCATION', id('Rail')]]);
    root = panel();
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Light', 'Path', 'Rail']);
    fireEvent.change(field(root, 'redo-target')!, { target: { value: id('Light') } });
    expect(cube().constraints.map((c) => [c.type, c.target])).toEqual([['COPY_LOCATION', id('Light')]]);

    // switching to a type that needs a curve drops the light instead of failing
    root = panel();
    fireEvent.change(field(root, 'redo-type')!, { target: { value: 'CLAMP_TO' } });
    expect(cube().constraints.map((c) => [c.type, c.target])).toEqual([['CLAMP_TO', null]]);
    // and a type without targets hides the target
    root = panel();
    fireEvent.change(field(root, 'redo-type')!, { target: { value: 'LIMIT_LOCATION' } });
    expect(cube().constraints.map((c) => c.type)).toEqual(['LIMIT_LOCATION']);
    root = panel();
    expect(field(root, 'redo-target')).toBeNull();
    expect(field(root, 'redo-subtarget')).toBeNull();
    expect(s.undo.undoStack.length).toBe(lastOperator.value!.undoDepth);
  });

  it('Add Constraint: an armature target offers its bones, and only armatures with the chosen bone are listed', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.armature_add', { name: 'Rig', bone_name: 'Hand' });
    ok('object.armature_add', { name: 'Other Rig', bone_name: 'Foot' });
    select(s, 'Cube');
    ok('object.constraint_add', { type: 'COPY_LOCATION', target: 'Rig' });
    let root = panel();
    expect(optionLabels(field(root, 'redo-subtarget'))).toEqual(['— none —', 'Hand']);
    fireEvent.change(field(root, 'redo-subtarget')!, { target: { value: 'Hand' } });
    expect(s.doc.findObjectByName('Cube')!.constraints[0].subtarget).toBe('Hand');
    root = panel();
    // 'Other Rig' has no bone 'Hand'
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Rig']);
  });

  it('Add Constraint: the bones of an armature whose list holds items that are none (an old or foreign file)', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.armature_add', { name: 'Rig', bone_name: 'Hand' });
    select(s, 'Cube');
    ok('object.constraint_add', { type: 'COPY_LOCATION', target: 'Rig' });
    // the damaged list comes from elsewhere (a file another program wrote, synced in): no step of
    // this session
    const agent = agentReplica(s);
    const arm = agent.doc.getArmature(agent.doc.findObjectByName('Rig')!.data!)!;
    agent.doc.updateArmature(arm.id, { bones: [null, ...arm.bones, 'junk'] as unknown as typeof arm.bones });
    const root = panel();
    expect(optionLabels(field(root, 'redo-subtarget'))).toEqual(['— none —', 'Hand']);
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Rig']);
  });

  it('Set Constraint Properties: hides the constraint id, shows the current target and filters it', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.light_add', { name: 'Light' });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    ok('object.constraint_add', { object: 'Cube', type: 'FOLLOW_PATH', target: 'Path' });
    const c = s.doc.findObjectByName('Cube')!.constraints[0];
    // what the Constraints tab runs for an influence drag
    ok('constraint.update', { object: id('Cube'), constraint: c.id, influence: 0.5 });
    const root = panel();
    expect(field(root, 'redo-constraint')).toBeNull();
    expect(field(root, 'redo-show_expanded')).toBeNull();
    const target = field(root, 'redo-target') as HTMLSelectElement;
    expect(target.value).toBe(id('Path'));
    expect(optionLabels(target)).toEqual(['— none —', 'Path']);
  });

  it('Camera Turntable: the pickers leave out what the operation created and the other pick', () => {
    ok('object.camera_add', { name: 'Cam' });
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('anim.turntable', { target: 'Cube' });
    let root = panel();
    // the Turntable Camera and Pivot are deleted when the operation is adjusted
    expect(optionLabels(field(root, 'redo-camera'))).toEqual(['— none —', 'Cam']);
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Cam', 'Cube']);
    fireEvent.change(field(root, 'redo-camera')!, { target: { value: id('Cam') } });
    expect(s.doc.findObjectByName('Turntable Camera')).toBeNull();
    expect(s.doc.getScene().camera).toBe(id('Cam'));
    // the camera cannot orbit around itself
    root = panel();
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Cube']);
  });

  it('Align Objects: the reference object is a picker that shows the active object', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('mesh.primitive_cube_add', { name: 'Box', location: [4, 0, 0] });
    select(s, 'Box', 'Cube');
    ok('object.align', { axis: ['X'] });
    expect(s.doc.findObjectByName('Box')!.location[0]).toBeCloseTo(0);
    const root = panel();
    const active = field(root, 'redo-active') as HTMLSelectElement;
    expect(active.tagName).toBe('SELECT');
    expect(active.value).toBe(id('Cube'));
    expect(optionLabels(active)).toEqual(['— none —', 'Box', 'Cube']);
    // aligning to the Box instead moves the Cube to it
    fireEvent.change(active, { target: { value: id('Box') } });
    expect(s.doc.findObjectByName('Cube')!.location[0]).toBeCloseTo(4);
    expect(s.doc.findObjectByName('Box')!.location[0]).toBeCloseTo(4);
    expect(lastOperator.value?.params).toMatchObject({ active: id('Box') });
  });

  it('Make Track: the target cannot be the only tracking object', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.light_add', { name: 'Light' });
    ok('object.track_set', { objects: [id('Light')], target: id('Cube') });
    const root = panel();
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Cube']);
  });

  it('Add Bezier: the bevel object picker leaves out the new curve itself', () => {
    ok('curve.primitive_bezier_circle_add', { name: 'Profile' });
    ok('curve.primitive_bezier_curve_add', { name: 'Rail' });
    const root = panel();
    expect(optionLabels(field(root, 'redo-bevel_object'))).toEqual(['— none —', 'Profile']);
  });

  it('a rejected choice shows the kept value again, also when the operation changed nothing', () => {
    // an operator that changes nothing (no undo step of its own) and rejects one choice
    if (!registry.has('test.pick'))
      registry.register(
        defineOperator({
          id: 'test.pick',
          label: 'Pick',
          description: 'Test operator: rejects choice C',
          category: 'Test',
          redoable: true,
          schema: z.object({ choice: z.enum(['A', 'B', 'C']).default('A') }),
          execute(_ctx, p) {
            if (p.choice === 'C') throw new OperatorError('C is rejected', 'INVALID_PARAMS');
            return {};
          },
        }),
      );
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('test.pick', { choice: 'B' });
    expect(lastOperator.value?.undoStep).toBe(false);
    const root = panel();
    const choice = field(root, 'redo-choice') as HTMLSelectElement;
    expect(choice.value).toBe('B');
    fireEvent.change(choice, { target: { value: 'C' } });
    expect(lastOperator.value?.params).toEqual({ choice: 'B' });
    expect((field(root, 'redo-choice') as HTMLSelectElement).value).toBe('B');
    // the cube added before is untouched
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
  });

  it('a rejected value keeps the result and the panel (frame_end before frame_start)', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('anim.turntable', { target: 'Cube', frame_start: 1, frame_end: 100 });
    const camera = id('Turntable Camera');
    const root = panel();
    typeNumber(field(root, 'redo-frame_end')!, '-5');
    expect(s.doc.getObject(camera)?.name).toBe('Turntable Camera');
    expect(field(panel(), 'redo-panel')).not.toBeNull();
    expect(lastOperator.value?.params).toMatchObject({ frame_end: 100 });
  });
});

describe('Adjust Last Operation shows what "set" operators keep', () => {
  it('Set Bone Transform: unset channels show the pose; editing one scale component keeps the others', () => {
    ok('object.armature_add', { name: 'Rig' });
    const rig = id('Rig');
    ok('pose.bone_transform_set', {
      object: rig,
      bone: 'Bone',
      scale: [2, 2, 2],
      rotation_euler: [0.5, 0, 0],
    });
    // what the Object Data tab runs when only the location changes
    ok('pose.bone_transform_set', { object: rig, bone: 'Bone', location: [0, 0.5, 0] });
    const root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Set Bone Transform');
    expect(shown(root, 'scale')).toEqual(['2', '2', '2']);
    expect(shown(root, 'rotation_euler')).toEqual(['28.648°', '0°', '0°']);
    typeNumber(field(root, 'redo-scale-0')!, '3');
    const pb = s.doc.getObject(rig)!.pose!.bones.Bone;
    expect(pb.scale).toEqual([3, 2, 2]);
    expect(pb.location).toEqual([0, 0.5, 0]);
    expect(pb.rotation_euler[0]).toBeCloseTo(0.5);
  });

  it('Set Bone IK Settings: unset settings show the bone’s IK state; a re-run changes only the edited one', () => {
    // regression: after a click in the bone's Inverse Kinematics panel (one setting passed) every
    // other setting read unchecked or "Auto", contradicting the Properties editor
    ok('object.armature_add', { name: 'Rig', bone_name: 'Elbow' });
    const rig = id('Rig');
    // settings made earlier (e.g. by an MCP agent)
    ok('pose.ik_settings_set', {
      object: rig,
      bone: 'Elbow',
      lock_ik_x: true,
      use_ik_limit_z: true,
      ik_min_z: -Math.PI / 6,
      ik_max_z: Math.PI / 3,
      ik_stiffness_y: 0.4,
    });
    // what the bone IK panel runs for a click on Lock IK Z
    ok('pose.ik_settings_set', { object: rig, bone: 'Elbow', lock_ik_z: true });
    let root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Set Bone IK Settings');
    const on = (k: string) => field(root, `redo-${k}`)!.classList.contains('on');
    const value = (k: string) => field(root, `redo-${k}`)!.querySelector('.nf-value')?.textContent;
    expect(['x', 'y', 'z'].map((a) => on(`lock_ik_${a}`))).toEqual([true, false, true]);
    expect(['x', 'y', 'z'].map((a) => on(`use_ik_limit_${a}`))).toEqual([false, false, true]);
    expect(['x', 'y', 'z'].map((a) => value(`ik_min_${a}`))).toEqual(['-180°', '-180°', '-30°']);
    expect(['x', 'y', 'z'].map((a) => value(`ik_max_${a}`))).toEqual(['180°', '180°', '60°']);
    expect(['x', 'y', 'z'].map((a) => value(`ik_stiffness_${a}`))).toEqual(['0', '0.4', '0']);
    expect(root.textContent).not.toContain('Auto');

    // unchecking Lock IK Z in the panel re-runs with only that setting changed
    fireEvent.click(field(root, 'redo-lock_ik_z')!);
    const pb = () => s.doc.getObject(rig)!.pose!.bones.Elbow;
    expect(lastOperator.value?.params).toEqual({ object: rig, bone: 'Elbow', lock_ik_z: false });
    expect(pb()).toMatchObject({
      lock_ik_x: true,
      lock_ik_z: false,
      use_ik_limit_z: true,
      ik_stiffness_y: 0.4,
    });
    expect(pb().ik_min_z).toBeCloseTo(-Math.PI / 6, 9);
    expect(pb().ik_max_z).toBeCloseTo(Math.PI / 3, 9);
    // a kept setting edited in the panel joins the call; the others still show the bone
    root = panel();
    expect(on('lock_ik_x')).toBe(true);
    typeNumber(field(root, 'redo-ik_max_z')!, '45');
    expect(lastOperator.value?.params).toEqual({
      object: rig,
      bone: 'Elbow',
      lock_ik_z: false,
      ik_max_z: Math.PI / 4,
    });
    expect(pb().ik_max_z).toBeCloseTo(Math.PI / 4, 9);
    expect(pb().ik_min_z).toBeCloseTo(-Math.PI / 6, 9);
    expect(pb()).toMatchObject({ lock_ik_x: true, lock_ik_z: false, ik_stiffness_y: 0.4 });
    root = panel();
    expect(value('ik_min_z')).toBe('-30°');
    expect(value('ik_max_z')).toBe('45°');
    expect(on('lock_ik_x')).toBe(true);
    // the whole adjusted edit is one undo step: undoing it brings back the bone as it was before
    s.undo.undo();
    expect(pb().lock_ik_z ?? false).toBe(false);
    expect(pb().ik_max_z).toBeCloseTo(Math.PI / 3, 9);
  });

  it('Edit Bone: unset head and tail show the bone; editing one component keeps the others', () => {
    ok('object.armature_add', { name: 'Rig', bone_name: 'Arm' });
    const rig = id('Rig');
    ok('armature.bone_update', { object: rig, bone: 'Arm', tail: [0.5, 0, 2] });
    ok('armature.bone_update', { object: rig, bone: 'Arm', roll: 0.25 });
    const root = panel();
    expect(shown(root, 'head')).toEqual(['0', '0', '0']);
    expect(shown(root, 'tail')).toEqual(['0.5', '0', '2']);
    typeNumber(field(root, 'redo-tail-1')!, '1');
    const bone = s.doc.getArmature(s.doc.getObject(rig)!.data!)!.bones[0];
    expect(bone.tail).toEqual([0.5, 1, 2]);
    expect(bone.head).toEqual([0, 0, 0]);
    expect(bone.roll).toBeCloseTo(0.25);
  });

  it('Edit Bone: unset parent, Connected, Deform and envelope show the bone', () => {
    // regression: after a click in the Bone panel (one setting passed) Connected read unchecked,
    // the parent empty and the envelope settings "Auto", contradicting the Properties editor
    ok('object.armature_add', { name: 'Rig', bone_name: 'Upper' });
    const rig = id('Rig');
    ok('armature.bone_add', { object: rig, name: 'Lower', parent: 'Upper' });
    ok('armature.bone_update', {
      object: rig,
      bone: 'Lower',
      use_connect: true,
      envelope_distance: 0.4,
      envelope_weight: 2,
      head_radius: 0.2,
      tail_radius: 0.15,
    });
    // what the Bone panel runs for a click on Deform
    ok('armature.bone_update', { object: rig, bone: 'Lower', use_deform: false });
    let root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Edit Bone');
    const on = (k: string) => field(root, `redo-${k}`)!.classList.contains('on');
    const value = (k: string) => field(root, `redo-${k}`)!.querySelector('.nf-value')?.textContent;
    const parent = field(root, 'redo-parent')!;
    expect(
      ((parent.tagName === 'INPUT' ? parent : parent.querySelector('input')) as HTMLInputElement).value,
    ).toBe('Upper');
    expect([on('use_connect'), on('use_deform')]).toEqual([true, false]);
    expect(['envelope_distance', 'envelope_weight', 'head_radius', 'tail_radius'].map(value)).toEqual([
      '0.4',
      '2',
      '0.2',
      '0.15',
    ]);
    // a re-run passes the call's own parameters and the edited one: the rest stays as it is
    typeNumber(field(root, 'redo-tail_radius')!, '0.1');
    expect(lastOperator.value?.params).toMatchObject({ bone: 'Lower', use_deform: false, tail_radius: 0.1 });
    expect(Object.keys(lastOperator.value!.params as object)).not.toContain('use_connect');
    const bone = () => s.doc.getArmature(s.doc.getObject(rig)!.data!)!.bones.find((b) => b.name === 'Lower')!;
    expect(bone()).toMatchObject({
      parent: 'Upper',
      use_connect: true,
      use_deform: false,
      envelope_distance: 0.4,
      envelope_weight: 2,
      head_radius: 0.2,
      tail_radius: 0.1,
    });
    root = panel();
    expect([on('use_connect'), value('tail_radius')]).toEqual([true, '0.1']);
  });

  it('Set Shape Key: unset settings show the key; a re-run changes only the edited one', () => {
    // regression: after a value edit in the Shape Keys panel (only the value passed) Mute read
    // unchecked and Slider Min / Max "Auto", contradicting the Properties editor
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const cube = id('Cube');
    ok('object.shape_key_add', { object: cube });
    ok('object.shape_key_add', { object: cube });
    const keys = () => s.doc.getShapeKeys(s.doc.getObject(cube)!.data!);
    expect(keys().map((k) => k.name)).toEqual(['Key 1', 'Key 2']);
    ok('object.shape_key_set', { object: cube, key: 'Key 1', mute: true, slider_min: -1, slider_max: 2 });
    // what the Shape Keys panel runs for a value edit
    ok('object.shape_key_set', { object: cube, key: 'Key 1', value: 0.5 });
    let root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Set Shape Key');
    const on = (k: string) => field(root, `redo-${k}`)!.classList.contains('on');
    const value = (k: string) => field(root, `redo-${k}`)!.querySelector('.nf-value')?.textContent;
    expect(on('mute')).toBe(true);
    expect(['value', 'slider_min', 'slider_max'].map(value)).toEqual(['0.5', '-1', '2']);
    // Relative To as the Shape Keys panel offers it
    const relative = field(root, 'redo-relative_key') as HTMLSelectElement;
    expect(relative.value).toBe('');
    expect(optionLabels(relative)).toEqual(['Basis', 'Key 2']);

    // raising the maximum re-runs with only that setting changed
    typeNumber(field(root, 'redo-slider_max')!, '3');
    expect(lastOperator.value?.params).toMatchObject({ key: 'Key 1', value: 0.5, slider_max: 3 });
    expect(Object.keys(lastOperator.value!.params as object)).not.toContain('mute');
    expect(keys()[0]).toMatchObject({
      value: 0.5,
      mute: true,
      slider_min: -1,
      slider_max: 3,
      relative_key: '',
    });
    root = panel();
    expect([on('mute'), value('slider_min'), value('slider_max')]).toEqual([true, '-1', '3']);
    // after a mute click (the value left out) the value shows the key's
    ok('object.shape_key_set', { object: cube, key: 'Key 1', mute: false });
    root = panel();
    expect([on('mute'), value('value')]).toEqual([false, '0.5']);
    fireEvent.change(field(root, 'redo-relative_key')!, { target: { value: 'Key 2' } });
    expect(keys()[0]).toMatchObject({ mute: false, value: 0.5, relative_key: 'Key 2' });
  });

  it('Update Particle System: unset visibility shows the system’s; a re-run changes only the edited one', () => {
    // regression: after the Particles tab's viewport toggle (only show_viewport passed) Show Render
    // read unchecked, contradicting the Properties editor
    ok('mesh.primitive_plane_add', { name: 'Ground' });
    const ground = id('Ground');
    ok('object.particle_system_add', { object: ground });
    const ps = () => s.doc.getObject(ground)!.particle_systems[0];
    ok('object.particle_system_update', {
      object: ground,
      particle_system: ps().id,
      show_render: true,
      show_viewport: true,
    });
    // what the Particles tab (and the outliner) runs for a click on the viewport toggle
    ok('object.particle_system_update', { object: ground, particle_system: ps().id, show_viewport: false });
    let root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Update Particle System');
    const on = (k: string) => field(root, `redo-${k}`)!.classList.contains('on');
    expect([on('show_viewport'), on('show_render')]).toEqual([false, true]);
    // unchecking Show Render re-runs with only that setting changed
    fireEvent.click(field(root, 'redo-show_render')!);
    expect(lastOperator.value?.params).toEqual({
      object: ground,
      particle_system: ps().id,
      show_viewport: false,
      show_render: false,
    });
    expect(ps()).toMatchObject({ show_viewport: false, show_render: false });
    root = panel();
    expect([on('show_viewport'), on('show_render')]).toEqual([false, false]);
  });

  it('Edit Bone Constraint: shows the current target; with a bone set only armatures that have it', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.armature_add', { name: 'Rig', bone_name: 'Arm' });
    ok('object.armature_add', { name: 'Ctrl', bone_name: 'Handle', location: [2, 0, 0] });
    const rig = id('Rig');
    ok('pose.constraint_add', { object: rig, bone: 'Arm', type: 'COPY_LOCATION', target: 'Cube' });
    const constraint = () => s.doc.getObject(rig)!.pose!.bones.Arm.constraints![0];
    // what the Object Data tab runs for an influence drag
    ok('pose.constraint_set', { object: rig, bone: 'Arm', constraint: constraint().id, influence: 0.5 });
    let root = panel();
    expect(field(root, 'redo-constraint')).toBeNull();
    expect((field(root, 'redo-target') as HTMLSelectElement).value).toBe(id('Cube'));
    // "none" removes the target instead of keeping it
    fireEvent.change(field(root, 'redo-target')!, { target: { value: '' } });
    expect(constraint().target).toBeNull();
    expect(constraint().influence).toBe(0.5);
    // a bone of the Ctrl armature: only armatures with that bone are offered as the target
    ok('pose.constraint_set', {
      object: rig,
      bone: 'Arm',
      constraint: constraint().id,
      target: 'Ctrl',
      subtarget: 'Handle',
    });
    root = panel();
    expect(optionLabels(field(root, 'redo-target'))).toEqual(['— none —', 'Ctrl']);
  });

  it('Add IK: a bone of the same armature shows as "This armature", not "— none —"', () => {
    // regression: the Target picker read "— none —" for an IK targeting a bone of its own armature
    ok('object.armature_add', { name: 'Rig', bone_name: 'Upper' });
    const rig = id('Rig');
    ok('armature.bone_add', {
      object: rig,
      name: 'Lower',
      head: [0, 0, 1],
      tail: [0, 0, 2],
      parent: 'Upper',
    });
    ok('armature.bone_add', { object: rig, name: 'Hand.IK', head: [1, 0, 2], tail: [1, 0, 2.5] });
    ok('armature.bone_add', { object: rig, name: 'Pole', head: [0, -2, 1], tail: [0, -2, 1.5] });
    ok('pose.ik_add', { object: rig, bone: 'Lower', subtarget: 'Hand.IK', chain_count: 2 });
    let root = panel();
    expect(field(root, 'redo-panel')?.textContent).toContain('Add IK');
    const target = field(root, 'redo-target') as HTMLSelectElement;
    expect(target.value).toBe('');
    expect(target.selectedOptions[0].textContent).toBe('This armature (Rig)');
    expect(optionLabels(target)).not.toContain('— none —');
    // without a pole bone the pole picker is a plain "none"
    expect((field(root, 'redo-pole_target') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      '— none —',
    );
    // a pole bone of the same armature reads the same way
    typeText(field(root, 'redo-pole_subtarget')!, 'Pole');
    const ik = () => s.doc.getObject(rig)!.pose!.bones.Lower.constraints![0];
    expect(ik().params.pole_subtarget).toBe('Pole');
    expect(ik().target).toBe(rig);
    root = panel();
    expect((field(root, 'redo-pole_target') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      'This armature (Rig)',
    );
    // an object target shows the object
    ok('mesh.primitive_cube_add', { name: 'Goal' });
    ok('pose.ik_add', { object: rig, bone: 'Upper', target: 'Goal' });
    root = panel();
    expect((field(root, 'redo-target') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Goal');
    expect(optionLabels(field(root, 'redo-target'))).toContain('— none —');
  });

  it('Set Modifier Properties: hides the modifier id and shows its current visibility', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.modifier_add', { object: 'Cube', type: 'SUBSURF' });
    const m = s.doc.findObjectByName('Cube')!.modifiers[0];
    ok('object.modifier_set', { object: id('Cube'), modifier: m.id, params: { levels: 2 } });
    const root = panel();
    expect(field(root, 'redo-modifier')).toBeNull();
    expect(field(root, 'redo-show_expanded')).toBeNull();
    expect(field(root, 'redo-show_viewport')?.classList.contains('on')).toBe(true);
    // turning it off re-runs with the flag; the levels change stays
    fireEvent.click(field(root, 'redo-show_viewport')!);
    const mod = () => s.doc.findObjectByName('Cube')!.modifiers[0];
    expect(mod().show_viewport).toBe(false);
    expect(mod().params.levels).toBe(2);
  });
});

describe('Adjust Last Operation shows what the operation edited, however it was called', () => {
  const on = (root: HTMLElement, k: string) => field(root, `redo-${k}`)!.classList.contains('on');
  const value = (root: HTMLElement, k: string) =>
    field(root, `redo-${k}`)!.querySelector('.nf-value')?.textContent;

  it('Update Particle System without particle_system: the object’s only system', () => {
    // regression: run without `particle_system` (the operator then edits the object's only system;
    // the console, an agent's editor_command run_operator) Show Render read unchecked although on
    ok('mesh.primitive_plane_add', { name: 'Ground' });
    const ground = id('Ground');
    ok('object.particle_system_add', { object: ground });
    const ps = () => s.doc.getObject(ground)!.particle_systems[0];
    // the emitter named, or the active object
    for (const params of [{ object: ground }, {}]) {
      select(s, 'Ground');
      ok('object.particle_system_update', { ...params, show_viewport: false });
      expect([ps().show_viewport, ps().show_render]).toEqual([false, true]);
      let root = panel();
      expect([on(root, 'show_viewport'), on(root, 'show_render')]).toEqual([false, true]);
      // a re-run still passes only the call's own parameters and the edited one
      fireEvent.click(field(root, 'redo-show_render')!);
      expect(lastOperator.value?.params).toEqual({ ...params, show_viewport: false, show_render: false });
      expect([ps().show_viewport, ps().show_render]).toEqual([false, false]);
      root = panel();
      expect([on(root, 'show_viewport'), on(root, 'show_render')]).toEqual([false, false]);
      ok('object.particle_system_update', { object: ground, show_viewport: true, show_render: true });
    }
  });

  it('Set Shape Key renaming to a taken name: the renamed key, not the one that has the name', () => {
    // regression: the key was looked up under the name asked for, which the other key has ('Key 1'
    // renamed to 'Key 2' became 'Key 2.001'), so the panel showed the other key's settings
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const cube = id('Cube');
    ok('object.shape_key_add', { object: cube });
    ok('object.shape_key_add', { object: cube });
    ok('object.shape_key_add', { object: cube });
    const keys = () => s.doc.getShapeKeys(s.doc.getObject(cube)!.data!);
    ok('object.shape_key_set', { object: cube, key: 'Key 1', mute: true, slider_max: 3 });
    ok('object.shape_key_set', { object: cube, key: 'Key 1', name: 'Key 2' });
    expect(keys().map((k) => k.name)).toEqual(['Key 2.001', 'Key 2', 'Key 3']);
    let root = panel();
    expect([on(root, 'mute'), value(root, 'slider_max')]).toEqual([true, '3']);
    // Relative To offers the other keys, not the renamed key itself
    expect(optionLabels(field(root, 'redo-relative_key'))).toEqual(['Basis', 'Key 2', 'Key 3']);
    // adjusting renames it again, and the panel follows it
    typeNumber(field(root, 'redo-slider_min')!, '-2');
    expect(keys()[0]).toMatchObject({ name: 'Key 2.001', mute: true, slider_min: -2, slider_max: 3 });
    expect(keys()[1]).toMatchObject({ name: 'Key 2', mute: false, slider_min: 0, slider_max: 1 });
    root = panel();
    expect([on(root, 'mute'), value(root, 'slider_min'), value(root, 'slider_max')]).toEqual([
      true,
      '-2',
      '3',
    ]);
  });

  it('Edit Bone renaming to a taken name: the renamed bone, not the one that has the name', () => {
    ok('object.armature_add', { name: 'Rig', bone_name: 'Arm' });
    const rig = id('Rig');
    ok('armature.bone_add', { object: rig, name: 'Hand', head: [1, 0, 0], tail: [1, 0, 1] });
    ok('armature.bone_update', { object: rig, bone: 'Arm', use_deform: false, envelope_distance: 0.4 });
    ok('armature.bone_update', { object: rig, bone: 'Arm', name: 'Hand' });
    const bones = () => s.doc.getArmature(s.doc.getObject(rig)!.data!)!.bones;
    expect(bones().map((b) => b.name)).toEqual(['Hand.001', 'Hand']);
    const root = panel();
    expect(shown(root, 'tail')).toEqual(['0', '0', '1']);
    expect([on(root, 'use_deform'), value(root, 'envelope_distance')]).toEqual([false, '0.4']);
  });

  describe('animated numbers show their value at the current frame, as the Properties editor shows them', () => {
    // regression: kept values were the stored values, which an animation overrides: a shape key's
    // value, a pose bone's transform and a constraint's influence read otherwise than in the
    // Properties editor
    /** Keys a channel from 0 at frame 1 to `to` at frame 11 (linear), and goes to frame 6. */
    const animate = (type: 'object' | 'mesh', target: string, path: string, index: number, to: number) => {
      let fc = createFCurve({ target_type: type, target_id: target, path, index });
      fc = insertKeyframe(fc, 1, 0, 'LINEAR');
      s.doc.setFCurve(insertKeyframe(fc, 11, to, 'LINEAR'));
      s.state.frame = 6;
    };

    it('Edit Bone in world space: head and tail where the animated armature is at the frame', () => {
      // the operator converts world points with the armature's matrix at the current frame; the
      // panel shows the kept head and tail with the same matrix, so editing one component keeps
      // the others where they are
      ok('object.armature_add', { name: 'Rig', bone_name: 'Arm' });
      const rig = id('Rig');
      animate('object', rig, 'location', 0, 10);
      ok('armature.bone_update', { object: rig, bone: 'Arm', roll: 0.25, space: 'WORLD' });
      const root = panel();
      expect(shown(root, 'head')).toEqual(['5', '0', '0']);
      expect(shown(root, 'tail')).toEqual(['5', '0', '1']);
      typeNumber(field(root, 'redo-tail-1')!, '1');
      const bone = s.doc.getArmature(s.doc.getObject(rig)!.data!)!.bones[0];
      expect(bone.head).toEqual([0, 0, 0]);
      expect(bone.tail).toEqual([0, 1, 1]);
    });

    it('a shape key’s value, also when the frame changes', () => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      const cube = id('Cube');
      ok('object.shape_key_add', { object: cube });
      animate('mesh', s.doc.getObject(cube)!.data!, 'shape_keys["Key 1"].value', 0, 1);
      ok('object.shape_key_set', { object: cube, key: 'Key 1', mute: true });
      const root = panel();
      expect(value(root, 'value')).toBe('0.5');
      act(() => {
        s.state.frame = 11;
      });
      expect(value(root, 'value')).toBe('1');
    });

    it('a pose bone’s transform', () => {
      ok('object.armature_add', { name: 'Rig' });
      const rig = id('Rig');
      animate('object', rig, 'pose.bones["Bone"].location', 1, 2);
      ok('pose.bone_transform_set', { object: rig, bone: 'Bone', scale: [2, 2, 2] });
      const root = panel();
      expect(shown(root, 'location')).toEqual(['0', '1', '0']);
      expect(shown(root, 'scale')).toEqual(['2', '2', '2']);
    });

    it('an object constraint’s influence', () => {
      ok('mesh.primitive_cube_add', { name: 'Goal', location: [3, 0, 0] });
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      const cube = id('Cube');
      ok('object.constraint_add', { object: cube, type: 'COPY_LOCATION', target: 'Goal' });
      const c = s.doc.getObject(cube)!.constraints[0];
      animate('object', cube, `constraints["${c.name}"].influence`, 0, 1);
      ok('constraint.update', { object: cube, constraint: c.id, mute: false });
      expect(value(panel(), 'influence')).toBe('0.5');
    });

    it('a bone constraint’s influence; a re-run does not pass it', () => {
      ok('mesh.primitive_cube_add', { name: 'Goal', location: [3, 0, 0] });
      ok('object.armature_add', { name: 'Rig' });
      const rig = id('Rig');
      ok('pose.constraint_add', { object: rig, bone: 'Bone', type: 'COPY_LOCATION', target: 'Goal' });
      const c = () => s.doc.getObject(rig)!.pose!.bones.Bone.constraints![0];
      animate('object', rig, `pose.bones["Bone"].constraints["${c().name}"].influence`, 0, 1);
      ok('pose.constraint_set', { object: rig, bone: 'Bone', constraint: c().id, mute: false });
      const root = panel();
      expect(value(root, 'influence')).toBe('0.5');
      fireEvent.click(field(root, 'redo-mute')!);
      expect(lastOperator.value?.params).toMatchObject({ mute: true });
      expect(Object.keys(lastOperator.value!.params as object)).not.toContain('influence');
      expect(c()).toMatchObject({ mute: true, influence: 1 });
    });
  });
});

describe('Adjust Last Operation while others edit the same objects (MCP agents, other users)', () => {
  const pb = () => s.doc.findObjectByName('Rig')!.pose!.bones.Elbow;

  it('kept values follow what others change while the panel is open', () => {
    // regression: the panel only re-rendered on this session's own operations, so it kept showing
    // the values from before an agent's edit, contradicting the Properties editor
    ok('object.armature_add', { name: 'Rig', bone_name: 'Elbow' });
    const rig = id('Rig');
    ok('pose.ik_settings_set', { object: rig, bone: 'Elbow', ik_stiffness_x: 0.3 });
    // what the bone IK panel runs for a click on Lock IK Z
    ok('pose.ik_settings_set', { object: rig, bone: 'Elbow', lock_ik_z: true });
    // rendered once: only the agent's edit can update it
    const root = panel();
    const on = (k: string) => field(root, `redo-${k}`)!.classList.contains('on');
    const value = (k: string) => field(root, `redo-${k}`)!.querySelector('.nf-value')?.textContent;
    expect([value('ik_stiffness_x'), on('use_ik_limit_y'), value('ik_min_y')]).toEqual([
      '0.3',
      false,
      '-180°',
    ]);
    const agent = agentReplica(s);
    act(() =>
      agent('pose.ik_settings_set', {
        object: 'Rig',
        bone: 'Elbow',
        ik_stiffness_x: 0.5,
        use_ik_limit_y: true,
        ik_min_y: -Math.PI / 4,
      }),
    );
    // the agent's edit is not on this session's undo stack: the operation can still be adjusted
    expect(panelOffered(s)).toBe(true);
    expect(field(root, 'redo-panel')?.textContent).toContain('Set Bone IK Settings');
    expect([value('ik_stiffness_x'), on('use_ik_limit_y'), value('ik_min_y')]).toEqual(['0.5', true, '-45°']);
    expect(on('lock_ik_z')).toBe(true);

    // the same for the pose channels Set Bone Transform keeps
    ok('pose.bone_transform_set', { object: rig, bone: 'Elbow', location: [0, 0.5, 0] });
    const transform = panel();
    expect(shown(transform, 'scale')).toEqual(['1', '1', '1']);
    act(() => agent('pose.bone_transform_set', { object: 'Rig', bone: 'Elbow', scale: [2, 3, 4] }));
    expect(shown(transform, 'scale')).toEqual(['2', '3', '4']);
    expect(shown(transform, 'location')).toEqual(['0', '0.5', '0']);
  });

  it('a re-run after an agent overwrote the edit keeps its edit and undoes no earlier operation', () => {
    ok('object.armature_add', { name: 'Rig', bone_name: 'Elbow' });
    const rig = id('Rig');
    // an earlier operation that has nothing to do with the bone
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('pose.ik_settings_set', { object: rig, bone: 'Elbow', lock_ik_z: true });
    const depth = s.undo.undoStack.length;
    const root = panel();
    // the agent sets another IK setting of the bone, which stores the armature's whole pose again:
    // the click's change has nothing left to undo
    const agent = agentReplica(s);
    act(() => agent('pose.ik_settings_set', { object: 'Rig', bone: 'Elbow', ik_stiffness_x: 0.5 }));
    fireEvent.click(field(root, 'redo-lock_ik_z')!);
    expect(pb()).toMatchObject({ lock_ik_z: false, ik_stiffness_x: 0.5 });
    // regression: Yjs skipped the overwritten step and undid the cube's addition instead, which
    // the re-run then dropped from the history for good
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    expect(s.undo.undoStack.length).toBe(depth);
    expect(lastOperator.value?.params).toEqual({ object: rig, bone: 'Elbow', lock_ik_z: false });
    expect(field(root, 'redo-lock_ik_z')?.classList.contains('on')).toBe(false);
    // one undo step reverts the adjusted edit, keeping the agent's; the cube's addition is still undoable
    s.undo.undo();
    expect(pb().ik_stiffness_x).toBe(0.5);
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    s.undo.undo();
    expect(s.doc.findObjectByName('Cube')).toBeNull();
  });

  it('a rejected value after an agent overwrote the edit changes nothing and keeps the panel', () => {
    ok('object.armature_add', { name: 'Rig', bone_name: 'Elbow' });
    const rig = id('Rig');
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('pose.ik_settings_set', { object: rig, bone: 'Elbow', lock_ik_z: true });
    const agent = agentReplica(s);
    agent('pose.ik_settings_set', { object: 'Rig', bone: 'Elbow', ik_stiffness_x: 0.5 });
    const params = lastOperator.value!.params as Record<string, unknown>;
    // stiffness goes up to 0.99
    expect(redoLast(s, registry, { ...params, ik_stiffness_y: 2 })?.ok).toBe(false);
    expect(pb()).toMatchObject({ lock_ik_z: true, ik_stiffness_x: 0.5 });
    expect(pb().ik_stiffness_y).toBeUndefined();
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    expect(panelOffered(s)).toBe(true);
    // a valid value then runs again on top of the agent's edit
    expect(redoLast(s, registry, { ...params, ik_stiffness_y: 0.25 })?.ok).toBe(true);
    expect(pb()).toMatchObject({ lock_ik_z: true, ik_stiffness_x: 0.5, ik_stiffness_y: 0.25 });
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    expect(panelOffered(s)).toBe(true);
  });

  it('an added constraint an agent overwrote can no longer be adjusted (adding it again would make two)', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    // an earlier operation that has nothing to do with the constraint
    ok('object.light_add', { name: 'Light' });
    select(s, 'Cube');
    ok('object.constraint_add', { type: 'FOLLOW_PATH', target: 'Path' });
    const cube = () => s.doc.findObjectByName('Cube')!;
    const constraint = cube().constraints[0].id;
    const root = panel();
    // the agent changes the constraint, which stores the cube's whole constraint stack again
    const agent = agentReplica(s);
    act(() => agent('constraint.update', { object: 'Cube', constraint, influence: 0.5 }));
    typeNumber(field(root, 'redo-influence')!, '0.8');
    // nothing changes and the panel closes, saying why
    expect(cube().constraints.map((c) => [c.id, c.influence])).toEqual([[constraint, 0.5]]);
    expect(s.doc.findObjectByName('Light')).not.toBeNull();
    expect(lastOperator.value).toBeNull();
    expect(field(root, 'redo-panel')).toBeNull();
    expect(infoLog.value.at(-1)).toMatchObject({
      level: 'WARNING',
      message:
        'Add Constraint can no longer be adjusted: an agent or another user has changed what it did since',
    });
    // the light's addition is still the step Ctrl+Z undoes
    s.undo.undo();
    expect(s.doc.findObjectByName('Light')).toBeNull();
    expect(cube().constraints).toHaveLength(1);
  });

  /** Expects an object's location, component by component. */
  const expectLocation = (name: string, xyz: number[]) =>
    s.doc
      .findObjectByName(name)!
      .location.forEach((v, i) => expect(v, `${name}.location[${i}]`).toBeCloseTo(xyz[i], 9));
  const MOVE_WARNING =
    'Move can no longer be adjusted: an agent or another user has changed what it did since';

  it('a move an agent changed part of can no longer be adjusted (adjusting would move that part twice)', () => {
    // regression: only steps others had overwritten entirely were refused. Here Yjs undid the move
    // of B only (the agent had set A's location since) and the re-run moved both objects again:
    // A ended at 8 (the agent's 6 moved twice) and B at 2
    ok('mesh.primitive_cube_add', { name: 'A' });
    ok('mesh.primitive_cube_add', { name: 'B', location: [0, 5, 0] });
    select(s, 'A', 'B');
    ok('transform.translate', { value: [1, 0, 0] });
    const root = panel();
    const depth = s.undo.undoStack.length;
    const selection = [...s.state.selectedIds];
    const agent = agentReplica(s);
    act(() => agent('object.transform_set', { objects: ['A'], location: [6, 0, 0] }));
    // the agent's edit is not on this session's undo stack: the panel is still offered
    expect(panelOffered(s)).toBe(true);
    typeNumber(field(root, 'redo-value-0')!, '2');
    // nothing is undone or run again
    expectLocation('A', [6, 0, 0]);
    expectLocation('B', [1, 5, 0]);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(s.undo.redoStack).toHaveLength(0);
    expect(s.state.selectedIds).toEqual(selection);
    // the panel closes, saying why
    expect(lastOperator.value).toBeNull();
    expect(field(root, 'redo-panel')).toBeNull();
    expect(infoLog.value.at(-1)).toMatchObject({ level: 'WARNING', message: MOVE_WARNING });
    expect(toasts.value.at(-1)).toMatchObject({ level: 'warning', message: MOVE_WARNING });
    // Ctrl+Z still undoes the move where the agent left it
    s.undo.undo();
    expectLocation('A', [6, 0, 0]);
    expectLocation('B', [0, 5, 0]);
  });

  it('edits of other objects and of fields the operation did not write leave it adjustable', () => {
    ok('mesh.primitive_cube_add', { name: 'A' });
    ok('mesh.primitive_cube_add', { name: 'B', location: [0, 5, 0] });
    ok('mesh.primitive_cube_add', { name: 'C', location: [0, -5, 0] });
    select(s, 'A', 'B');
    ok('transform.translate', { value: [1, 0, 0] });
    const depth = s.undo.undoStack.length;
    const agent = agentReplica(s);
    // another object, and fields of a moved object that a move does not write: its name, its
    // modifier stack and its visibility in renders
    agent('object.transform_set', { objects: ['C'], location: [3, -5, 0] });
    agent('object.rename', { object: 'A', name: 'Alpha' });
    agent('object.modifier_add', { object: 'Alpha', type: 'SUBSURF' });
    agent('data.set_property', { kind: 'objects', target: 'Alpha', values: { hide_render: true } });
    const params = lastOperator.value!.params as Record<string, unknown>;
    expect(redoLast(s, registry, { ...params, value: [2, 0, 0] })?.ok).toBe(true);
    // the adjusted move, from where the objects were, with the agent's edits kept
    expectLocation('Alpha', [2, 0, 0]);
    expectLocation('B', [2, 5, 0]);
    expectLocation('C', [3, -5, 0]);
    const alpha = s.doc.findObjectByName('Alpha')!;
    expect(alpha.modifiers.map((m) => m.type)).toEqual(['SUBSURF']);
    expect(alpha.hide_render).toBe(true);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(panelOffered(s)).toBe(true);
    // one undo step reverts the adjusted move only
    s.undo.undo();
    expectLocation('Alpha', [0, 0, 0]);
    expectLocation('B', [0, 5, 0]);
    expectLocation('C', [3, -5, 0]);
    expect(s.doc.findObjectByName('Alpha')!.modifiers).toHaveLength(1);
  });

  /** Expects an object's vector field, component by component. */
  const expectVector = (name: string, field: 'rotation_euler' | 'scale', xyz: readonly number[]) => {
    const value = s.doc.findObjectByName(name)![field];
    value.forEach((v, i) => expect(v, `${name}.${field}[${i}]`).toBeCloseTo(xyz[i], 9));
  };

  it('others rotating or scaling an object a move moved keep the move adjustable, unless they move it', () => {
    // a move writes only the location of each object it moves. Setting the rotation or scale of a
    // moved object (an agent's transform_object, the Properties editor), or rotating or scaling it
    // about its own origin (R and S then write only its rotation or scale), edits other fields:
    // undoing the move keeps the edit and the re-run starts from it. Rotating or scaling it about
    // another point (the 3D cursor) moves it: that sets the location the move changed
    const own = (agent: Agent) => {
      agent.state.selectedIds = [id('A')];
      agent.state.activeId = id('A');
    };
    const aboutCursor = (agent: Agent) => {
      own(agent);
      agent.state.pivotPoint = 'CURSOR';
      agent.state.cursorLocation = [0, 3, 0];
    };
    const cases: {
      name: string;
      edit: (agent: Agent) => void;
      adjustable: boolean;
      field?: 'rotation_euler' | 'scale';
      value?: number[];
    }[] = [
      {
        name: 'setting the rotation with transform_object',
        edit: (a) => a('object.transform_set', { objects: ['A'], rotation_euler: [0, 0, 1] }),
        adjustable: true,
        field: 'rotation_euler',
        value: [0, 0, 1],
      },
      {
        name: 'setting the scale in the Properties editor',
        edit: (a) => a('data.set_property', { kind: 'objects', target: 'A', values: { scale: [2, 2, 2] } }),
        adjustable: true,
        field: 'scale',
        value: [2, 2, 2],
      },
      {
        name: 'rotating it about its own origin (an agent’s transform.rotate on its selection)',
        edit: (a) => {
          own(a);
          a('transform.rotate', { value: 1, orient_axis: 'Z' });
        },
        adjustable: true,
        field: 'rotation_euler',
        value: [0, 0, 1],
      },
      {
        name: 'rotating it about its own origin (another user’s R, which passes the pivot)',
        edit: (a) => {
          own(a);
          a('transform.rotate', { value: 1, axis: [0, 0, 1], center: [1, 0, 0] });
        },
        adjustable: true,
        field: 'rotation_euler',
        value: [0, 0, 1],
      },
      {
        name: 'scaling it about its own origin',
        edit: (a) => {
          own(a);
          a('transform.resize', { value: [2, 2, 2] });
        },
        adjustable: true,
        field: 'scale',
        value: [2, 2, 2],
      },
      {
        name: 'rotating it about the 3D cursor',
        edit: (a) => {
          aboutCursor(a);
          a('transform.rotate', { value: 1, orient_axis: 'Z' });
        },
        adjustable: false,
      },
      {
        name: 'scaling it about the 3D cursor',
        edit: (a) => {
          aboutCursor(a);
          a('transform.resize', { value: [2, 2, 2] });
        },
        adjustable: false,
      },
    ];
    for (const c of cases) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      cleanup();
      ok('mesh.primitive_cube_add', { name: 'A' });
      ok('mesh.primitive_cube_add', { name: 'B', location: [0, 5, 0] });
      select(s, 'A', 'B');
      ok('transform.translate', { value: [1, 0, 0] });
      const depth = s.undo.undoStack.length;
      const root = panel();
      const agent = agentReplica(s);
      act(() => c.edit(agent));
      const edited = s.doc.encodeState();
      typeNumber(field(root, 'redo-value-0')!, '2');
      if (c.adjustable) {
        // the adjusted move, from where the objects were, with the edit kept
        expectLocation('A', [2, 0, 0]);
        expectLocation('B', [2, 5, 0]);
        expectVector('A', c.field!, c.value!);
        expect(lastOperator.peek()?.params, c.name).toEqual({ value: [2, 0, 0], orient_type: 'GLOBAL' });
        expect(field(root, 'redo-panel'), c.name).not.toBeNull();
        expect(panelOffered(s), c.name).toBe(true);
        expect(s.undo.undoStack.length, c.name).toBe(depth);
        expect(infoLog.value.at(-1)?.level, c.name).not.toBe('WARNING');
        // one undo step reverts the adjusted move, keeping the edit
        s.undo.undo();
        expectLocation('A', [0, 0, 0]);
        expectLocation('B', [0, 5, 0]);
        expectVector('A', c.field!, c.value!);
      } else {
        // nothing is undone or run again, and the panel closes with a warning
        expect(s.doc.encodeState(), c.name).toEqual(edited);
        expect(lastOperator.value, c.name).toBeNull();
        expect(field(root, 'redo-panel'), c.name).toBeNull();
        expect(infoLog.value.at(-1), c.name).toMatchObject({ level: 'WARNING', message: MOVE_WARNING });
      }
    }
  });

  it('a rotation or scale about the object’s own origin stays adjustable after others edit its other fields', () => {
    // R and S about an object's own origin write only its rotation or its scale, also when the
    // other values are ones a matrix gives back differently (a negative Y scale, a Y angle above 90°)
    const deg = Math.PI / 180;
    const cases = [
      {
        op: 'transform.rotate',
        params: { value: 0.5, orient_axis: 'Z' },
        adjusted: { value: 0.25 },
        initial: { scale: [1, -1, 1] },
        edit: { location: [4, 0, 0], scale: [3, -3, 3] },
        field: 'rotation_euler',
        expected: [0, 0, 0.25],
      },
      {
        op: 'transform.resize',
        params: { value: [2, 2, 2] },
        adjusted: { value: [3, 3, 3] },
        initial: { rotation_euler: [0, 120 * deg, 0] },
        edit: { location: [4, 0, 0], rotation_euler: [0, 100 * deg, 0] },
        field: 'scale',
        expected: [3, 3, 3],
      },
    ] as const;
    for (const c of cases) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      ok('mesh.primitive_cube_add', { name: 'A' });
      ok('object.transform_set', { objects: ['A'], ...c.initial });
      select(s, 'A');
      ok(c.op, c.params);
      agentReplica(s)('object.transform_set', { objects: ['A'], ...c.edit });
      const last = lastOperator.value!.params as Record<string, unknown>;
      expect(redoLast(s, registry, { ...last, ...c.adjusted })?.ok, c.op).toBe(true);
      expectVector('A', c.field, c.expected);
      // the edits kept
      for (const [k, v] of Object.entries(c.edit))
        if (k === 'location') expectLocation('A', [...v]);
        else expectVector('A', k as 'rotation_euler' | 'scale', v);
      expect(panelOffered(s), c.op).toBe(true);
    }
  });

  it('rotating a moved child of an unevenly scaled parent about its own origin keeps the move adjustable', () => {
    // the rotation writes only the child's rotation, as Blender's Rotate does (the scale stays, also
    // under a parent scaled unevenly, where the child deforms as it turns), not its location: the
    // move stays adjustable, and the re-run keeps the rotation and the scale
    ok('object.empty_add', { name: 'P' });
    ok('object.transform_set', { objects: ['P'], scale: [2, 1, 1] });
    ok('mesh.primitive_cube_add', { name: 'A', location: [2, 0, 0] });
    ok('object.parent_to', { objects: ['A'], parent: 'P' });
    expectLocation('A', [1, 0, 0]);
    select(s, 'A');
    ok('transform.translate', { value: [2, 0, 0] });
    expectLocation('A', [2, 0, 0]);
    const scale = s.doc.findObjectByName('A')!.scale;
    const agent = agentReplica(s);
    agent.state.selectedIds = [id('A')];
    agent.state.activeId = id('A');
    agent('transform.rotate', { value: Math.PI / 4, orient_axis: 'Z' });
    const turned = s.doc.findObjectByName('A')!;
    expect(turned.scale).toEqual(scale);
    expect(turned.rotation_euler).not.toEqual([0, 0, 0]);
    expectLocation('A', [2, 0, 0]);
    expect(redoLast(s, registry, { value: [4, 0, 0] })?.ok).toBe(true);
    // 4 m along the world's X axis is 2 along the parent's
    expectLocation('A', [3, 0, 0]);
    expectVector('A', 'rotation_euler', turned.rotation_euler);
    expectVector('A', 'scale', turned.scale);
    expect(panelOffered(s)).toBe(true);
  });

  it('Randomize Transform stays adjustable after others edit the channels its ranges leave as they were', () => {
    // with its default ranges it changes only the scale, and stores the location and rotation again
    // unchanged: an agent's new location and rotation are edits of values it left as they were
    ok('mesh.primitive_cube_add', { name: 'A', location: [1, 2, 3] });
    select(s, 'A');
    ok('object.randomize_transform', { random_seed: 1 });
    const scale = s.doc.findObjectByName('A')!.scale;
    expect(scale).not.toEqual([1, 1, 1]);
    agentReplica(s)('object.transform_set', {
      objects: ['A'],
      location: [4, 0, 0],
      rotation_euler: [0, 0, 1],
    });
    const params = lastOperator.value!.params as Record<string, unknown>;
    expect(redoLast(s, registry, { ...params, random_seed: 2 })?.ok).toBe(true);
    expectLocation('A', [4, 0, 0]);
    expectVector('A', 'rotation_euler', [0, 0, 1]);
    // the scale randomized again from [1, 1, 1], with the other seed
    expect(s.doc.findObjectByName('A')!.scale).not.toEqual(scale);
    expect(lastOperator.value?.params).toMatchObject({ random_seed: 2 });
    expect(panelOffered(s)).toBe(true);
  });

  it('a value an operation recomputed with its last digits changed still counts as left as it was', () => {
    // Bake Transforms run again stores its keys with their last digits changed (SAME_NUMBER_TOLERANCE
    // in runner.ts); this operator moves an object and stores its scale again, a unit in the last
    // place off. An agent's later scale edit is an edit of a value it left as it was: undoing it
    // keeps the agent's scale, and the re-run moves the object with it
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.nudge',
        label: 'Nudge',
        description: 'Moves `object` to x, storing its scale again with its last digit changed',
        category: 'Test',
        redoable: true,
        schema: z.object({ object: z.string(), x: z.number() }),
        execute(ctx, p) {
          const o = ctx.doc.getObject(p.object)!;
          ctx.doc.updateObject(p.object, {
            location: [p.x, o.location[1], o.location[2]],
            scale: [o.scale[0] * (1 + Number.EPSILON), o.scale[1], o.scale[2] * (1 + Number.EPSILON)],
          });
          return {};
        },
      }),
    );
    ok('mesh.primitive_cube_add', { name: 'A' });
    const scale = [1.3, 0.8, 2.1];
    ok('object.transform_set', { objects: ['A'], scale });
    expect(runOperator(s, reg, 'test.nudge', { object: id('A'), x: 1 }, 'test').ok).toBe(true);
    const stored = s.doc.findObjectByName('A')!.scale;
    expect(stored).not.toEqual(scale);
    stored.forEach((v, i) => expect(Math.abs(v - scale[i])).toBeLessThan(1e-15));
    agentReplica(s)('object.transform_set', { objects: ['A'], scale: [3, 3, 3] });
    expect(redoLast(s, reg, { object: id('A'), x: 2 })?.ok).toBe(true);
    expectLocation('A', [2, 0, 0]);
    expectVector('A', 'scale', [3, 3, 3]);
    expect(panelOffered(s)).toBe(true);
  });

  it('a whole number the operation changed counts as changed, however large it is', () => {
    // seeds can be any whole number: 1e15 and 1e15 + 1 are different seeds, although they are closer
    // than the rounding of rewritten values is allowed to be (a 1e-12th of them)
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.reseed',
        label: 'Reseed',
        description: 'Sets the custom property `seed` of `object`',
        category: 'Test',
        redoable: true,
        schema: z.object({ object: z.string(), seed: z.number().int() }),
        execute(ctx, p) {
          ctx.doc.updateObject(p.object, { custom_props: { seed: p.seed } });
          return {};
        },
      }),
    );
    ok('mesh.primitive_cube_add', { name: 'A' });
    s.doc.updateObject(id('A'), { custom_props: { seed: 1e15 } });
    expect(runOperator(s, reg, 'test.reseed', { object: id('A'), seed: 1e15 + 1 }, 'test').ok).toBe(true);
    agentReplica(s).doc.updateObject(id('A'), { custom_props: { seed: 7 } });
    expect(redoLast(s, reg, { object: id('A'), seed: 1e15 + 2 })).toBeNull();
    expect(s.doc.findObjectByName('A')!.custom_props).toEqual({ seed: 7 });
    expect(infoLog.value.at(-1)?.message).toBe(
      'Reseed can no longer be adjusted: an agent or another user has changed what it did since',
    );
  });

  const RANDOM_WARNING =
    'Randomize Transform can no longer be adjusted: an agent or another user has changed what it did since';
  /**
   * Cube A at x = 1 (selected) given a random scale with Randomize Transform, which stores its
   * location and rotation again unchanged (their ranges default to 0).
   */
  const randomize = () => {
    ok('mesh.primitive_cube_add', { name: 'A', location: [1, 0, 0] });
    select(s, 'A');
    ok('object.randomize_transform', { random_seed: 1 });
  };
  /** Randomize Transform's parameters with another `random_seed`. */
  const randomParams = (random_seed: number) => ({ ...(lastOperator.value!.params as object), random_seed });

  it('a value others set at the same time as an unchanged rewrite that lost to it still counts', () => {
    // regression: the agent moved A while the user's Randomize Transform was on its way, so neither
    // replica had the other's edit. Randomize Transform stores A's location again, unchanged. Yjs
    // orders values of a field set at the same time by client id: with the smaller id the agent's
    // location came before the rewrite and lost to it. Undoing the randomize then removed its
    // location and could not bring back the one before it (the agent's value follows that one), so
    // the adjusted operation left A at the origin
    const cases: { name: string; agentClient: number; adjustable: boolean; session?: () => void }[] = [
      { name: "the agent's value lost", agentClient: 1, adjustable: false },
      { name: "the agent's value won", agentClient: 4_000_000_000, adjustable: true },
      {
        // A's location is the copy of the randomize's that the undo brought back
        name: "the agent's value lost, and the session set A's location and undid that",
        agentClient: 1,
        adjustable: false,
        session: () => {
          s.doc.updateObject(id('A'), { location: [5, 5, 5] });
          s.undo.undo();
        },
      },
      {
        // A is the copy the undo brought back, with a copy of the randomize's location
        name: "the agent's value lost, and the session deleted A and undid that",
        agentClient: 1,
        adjustable: false,
        session: () => {
          s.doc.removeObject(id('A'));
          s.undo.undo();
        },
      },
    ];
    for (const c of cases) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      s.doc.ydoc.clientID = 2_000_000_000;
      ok('mesh.primitive_cube_add', { name: 'A', location: [1, 0, 0] });
      const agent = agentReplica(s, { clientID: c.agentClient });
      select(s, 'A');
      agent.pause();
      ok('object.randomize_transform', { random_seed: 1 });
      agent('object.transform_set', { objects: ['A'], location: [3, 0, 0] });
      agent.resume();
      c.session?.();
      expect(panelOffered(s), c.name).toBe(true);
      // both replicas hold the value that won
      const location = c.adjustable ? [3, 0, 0] : [1, 0, 0];
      expect(s.doc.findObjectByName('A')!.location, c.name).toEqual(location);
      expect(agent.doc.findObjectByName('A')!.location, c.name).toEqual(location);
      const res = redoLast(s, registry, randomParams(2));
      if (c.adjustable) {
        // undoing keeps the agent's value: the adjusted randomize starts from it
        expect(res?.ok, c.name).toBe(true);
        expect(lastOperator.peek()?.params, c.name).toMatchObject({ random_seed: 2 });
      } else {
        expect(res, c.name).toBeNull();
        expect(infoLog.value.at(-1), c.name).toMatchObject({ level: 'WARNING', message: RANDOM_WARNING });
      }
      expect(s.doc.findObjectByName('A')!.location, c.name).toEqual(location);
    }
  });

  it('after the session undid and redid an operation, edits of what it only rewrote leave it adjustable', () => {
    // Yjs redoes a step as a new stack item with new copies of what it wrote, before or after the
    // agent's edit: the copy knows which of its values are unchanged too
    for (const agentFirst of [false, true]) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      randomize();
      const depth = s.undo.undoStack.length;
      const agent = agentReplica(s);
      const move = () => agent('object.transform_set', { objects: ['A'], location: [3, 0, 0] });
      if (agentFirst) move();
      ok('ed.undo');
      expectVector('A', 'scale', [1, 1, 1]);
      ok('ed.redo');
      if (!agentFirst) move();
      expect(panelOffered(s), `agent first: ${agentFirst}`).toBe(true);
      expect(redoLast(s, registry, randomParams(2))?.ok, `agent first: ${agentFirst}`).toBe(true);
      expectLocation('A', [3, 0, 0]);
      expect(s.undo.undoStack.length).toBe(depth);
    }
    // what a move changed still counts after the session undid and redid it (round 5's repro)
    s = fakeSession();
    sessionSignal.value = s;
    lastOperator.value = null;
    ok('mesh.primitive_cube_add', { name: 'A' });
    ok('mesh.primitive_cube_add', { name: 'B', location: [0, 5, 0] });
    select(s, 'A', 'B');
    ok('transform.translate', { value: [1, 0, 0] });
    ok('ed.undo');
    ok('ed.redo');
    agentReplica(s)('object.transform_set', { objects: ['A'], location: [6, 0, 0] });
    expect(redoLast(s, registry, { value: [2, 0, 0], orient_type: 'GLOBAL' })).toBeNull();
    expectLocation('A', [6, 0, 0]);
    expectLocation('B', [1, 5, 0]);
    expect(infoLog.value.at(-1)).toMatchObject({ level: 'WARNING', message: MOVE_WARNING });
  });

  it('the re-run of an adjusted operation knows which values it rewrote unchanged', () => {
    randomize();
    const agent = agentReplica(s);
    agent('object.transform_set', { objects: ['A'], location: [3, 0, 0] });
    expect(redoLast(s, registry, randomParams(2))?.ok).toBe(true);
    // the re-run is a step of its own: the agent moves A again, then the randomize is adjusted again
    agent('object.transform_set', { objects: ['A'], location: [4, 0, 0] });
    expect(redoLast(s, registry, randomParams(3))?.ok).toBe(true);
    expectLocation('A', [4, 0, 0]);
    // its scale is what the re-run changed
    agent('object.transform_set', { objects: ['A'], scale: [5, 5, 5] });
    expect(redoLast(s, registry, randomParams(2))).toBeNull();
    expectVector('A', 'scale', [5, 5, 5]);
    expect(infoLog.value.at(-1)).toMatchObject({ level: 'WARNING', message: RANDOM_WARNING });
  });

  it('a move by 0 changes nothing: it adds no undo step, and adjusting it moves from where others left the object', () => {
    ok('mesh.primitive_cube_add', { name: 'A' });
    ok('mesh.primitive_cube_add', { name: 'B', location: [0, 5, 0] });
    select(s, 'A');
    const depth = s.undo.undoStack.length;
    ok('transform.translate', { value: [0, 0, 0] });
    expect(s.undo.undoStack.length).toBe(depth);
    expect(lastOperator.value?.undoStep).toBe(false);
    agentReplica(s)('object.transform_set', {
      objects: ['A'],
      location: [3, 0, 0],
      rotation_euler: [0, 0, 1],
      scale: [2, 2, 2],
    });
    expect(redoLast(s, registry, { value: [1, 0, 0], orient_type: 'GLOBAL' })?.ok).toBe(true);
    expectLocation('A', [4, 0, 0]);
    expectVector('A', 'rotation_euler', [0, 0, 1]);
    expectVector('A', 'scale', [2, 2, 2]);
    // the adjusted move is one undo step after the earlier one (adding B), which is still there
    expect(s.undo.undoStack.length).toBe(depth + 1);
    expect(panelOffered(s)).toBe(true);
    s.undo.undo();
    expectLocation('A', [3, 0, 0]);
    expect(s.doc.findObjectByName('B')).not.toBeNull();
  });

  /** A cube A in Edit Mode with all its vertices selected, and the lowest x and z of its mesh. */
  const editCube = () => {
    ok('mesh.primitive_cube_add', { name: 'A' });
    select(s, 'A');
    ok('object.mode_set', { mode: 'EDIT' });
    ok('mesh.select_all', { action: 'SELECT' });
    const meshId = s.doc.findObjectByName('A')!.data!;
    const lowest = (axis: number) =>
      Math.min(...Array.from(s.doc.getMesh(meshId)!.positions).filter((_, i) => i % 3 === axis));
    return { meshId, minX: () => lowest(0), minZ: () => lowest(2) };
  };

  it('an operation that only rewrote values unchanged runs again on top of edits of all of them', () => {
    // an Edit Mode move by 0 stores the mesh's geometry again, unchanged (one blob of binary data).
    // Once others have stored it again too, Yjs has nothing of the move left to undo (it drops the
    // step), and the move runs on top of their mesh
    const { meshId, minX, minZ } = editCube();
    ok('transform.translate', { value: [0, 0, 0] });
    const depth = s.undo.undoStack.length;
    const agent = agentReplica(s);
    // the agent raises the mesh by 1
    const raised = agent.doc.getMeshCopy(meshId)!;
    for (let i = 2; i < raised.positions.length; i += 3) raised.positions[i] += 1;
    agent.doc.setMesh(meshId, raised);
    expect(redoLast(s, registry, { value: [1, 0, 0], orient_type: 'GLOBAL' })?.ok).toBe(true);
    expect([minX(), minZ()]).toEqual([0, 0]);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(panelOffered(s)).toBe(true);
  });

  it('an Edit Mode move others stored the mesh of again can no longer be adjusted (it would move twice)', () => {
    // the mesh's geometry is one entry holding binary data: the move changed it (other bytes of the
    // same length), and the agent's edit stores it again. Adjusting would undo nothing of the move
    // (the agent's mesh is the newer value) and move the vertices again: x from 0 to 2
    const { meshId, minX } = editCube();
    ok('transform.translate', { value: [1, 0, 0] });
    expect(minX()).toBe(0);
    const agent = agentReplica(s);
    agent.doc.setMesh(meshId, agent.doc.getMesh(meshId)!);
    const edited = s.doc.encodeState();
    expect(redoLast(s, registry, { value: [2, 0, 0], orient_type: 'GLOBAL' })).toBeNull();
    expect(minX()).toBe(0);
    expect(s.doc.encodeState()).toEqual(edited);
    expect(infoLog.value.at(-1)).toMatchObject({ level: 'WARNING', message: MOVE_WARNING });
  });

  it('a value that is not plain data (a Yjs type, a class instance) always counts as changed', () => {
    // an operator that replaces an entry with a new value equal to the one it had: a new empty Yjs
    // map, a new Date. Others then set the entry again: adjusting would replace their value again
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.reset',
        label: 'Reset',
        description: 'Replaces the project meta entry `key` with a new empty Yjs map or a new Date(0)',
        category: 'Test',
        redoable: true,
        schema: z.object({ key: z.enum(['layers', 'stamp']) }),
        execute(ctx, p) {
          ctx.doc.transact(() =>
            ctx.doc.map('meta').set(p.key, p.key === 'layers' ? new Y.Map() : new Date(0)),
          );
          return {};
        },
      }),
    );
    for (const key of ['layers', 'stamp'] as const) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      expect(runOperator(s, reg, 'test.reset', { key }, 'test').ok, key).toBe(true);
      expect(runOperator(s, reg, 'test.reset', { key }, 'test').ok, key).toBe(true);
      const depth = s.undo.undoStack.length;
      agentReplica(s).doc.map('meta').set(key, 'theirs');
      expect(redoLast(s, reg, { key }), key).toBeNull();
      expect(s.doc.map('meta').get(key), key).toBe('theirs');
      expect(s.undo.undoStack.length, key).toBe(depth);
      expect(infoLog.value.at(-1)?.message, key).toBe(
        'Reset can no longer be adjusted: an agent or another user has changed what it did since',
      );
    }
  });

  it('an entry the operation added again, with the value it had before it was removed, counts as changed', () => {
    // an operator that keys a channel: sets its F-curve to one keyframe
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.key_channel',
        label: 'Key Channel',
        description: 'Sets the F-curve of the x location of `object` to one keyframe',
        category: 'Test',
        redoable: true,
        schema: z.object({ object: z.string(), frame: z.number(), value: z.number() }),
        execute(ctx, p) {
          const channel = { target_type: 'object' as const, target_id: p.object, path: 'location', index: 0 };
          ctx.doc.setFCurve(insertKeyframe(createFCurve(channel), p.frame, p.value, 'LINEAR'));
          return {};
        },
      }),
    );
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const channel = { target_type: 'object' as const, target_id: id('Cube'), path: 'location', index: 0 };
    const key = fcurveKey(channel);
    const params = { object: id('Cube'), frame: 1, value: 0 };
    // keyed, undone, keyed again: the second run added the F-curve the undo had removed, with the
    // same keyframe (the undo manager keeps the removed value). It is not a value the run replaced
    expect(runOperator(s, reg, 'test.key_channel', params, 'test').ok).toBe(true);
    s.undo.undo();
    expect(s.doc.getFCurve(key)).toBeNull();
    expect(runOperator(s, reg, 'test.key_channel', params, 'test').ok).toBe(true);
    const depth = s.undo.undoStack.length;
    // the agent edits the F-curve the run added
    agentReplica(s).doc.setFCurve(insertKeyframe(createFCurve(channel), 10, 3, 'LINEAR'));
    expect(redoLast(s, reg, { ...params, value: 2 })).toBeNull();
    expect(s.doc.getFCurve(key)?.keyframes.map((k) => [k.frame, k.value])).toEqual([[10, 3]]);
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    expect(s.undo.undoStack.length).toBe(depth);
    expect(infoLog.value.at(-1)?.message).toBe(
      'Key Channel can no longer be adjusted: an agent or another user has changed what it did since',
    );
  });

  it('values an operation set twice that Yjs merged into one struct still count as rewritten unchanged', () => {
    // a document that keeps removed content (no garbage collection) merges removed neighbouring
    // values of an entry into one struct: here the operation's two values of K's location, the
    // second one back to where K was, once the agent has set K's location
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.nudge',
        label: 'Nudge',
        description: 'Sets the x of `object`, moving `keep` away and back',
        category: 'Test',
        redoable: true,
        schema: z.object({ object: z.string(), keep: z.string(), x: z.number() }),
        execute(ctx, p) {
          const keep = ctx.doc.getObject(p.keep);
          if (!keep) throw new OperatorError(`no object ${p.keep}`, 'NOT_FOUND');
          ctx.doc.updateObject(p.object, { location: [p.x, 0, 0] });
          ctx.doc.updateObject(keep.id, { location: [9, 9, 9] });
          ctx.doc.updateObject(keep.id, { location: keep.location });
          return {};
        },
      }),
    );
    s.doc.ydoc.gc = false;
    ok('mesh.primitive_cube_add', { name: 'A' });
    ok('mesh.primitive_cube_add', { name: 'K', location: [0, 5, 0] });
    const params = { object: id('A'), keep: id('K'), x: 1 };
    expect(runOperator(s, reg, 'test.nudge', params, 'test').ok).toBe(true);
    agentReplica(s)('object.transform_set', { objects: ['K'], location: [4, 4, 4] });
    const location = (s.doc.ydoc.getMap('objects').get(id('K')) as Y.Map<unknown>)._map.get('location')!;
    expect((location.left as Y.Item).length).toBe(2);
    expect(redoLast(s, reg, { ...params, x: 2 })?.ok).toBe(true);
    expectLocation('A', [2, 0, 0]);
    expectLocation('K', [4, 4, 4]);
  });

  it('removing an entry the operation rewrote unchanged, or its block, still counts', () => {
    // an operator that moves `object` and rewrites the location of `keep` and an F-curve unchanged
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.place',
        label: 'Place',
        description: 'Sets the x of `object`, rewriting the location of `keep` and the F-curve `fcurve`',
        category: 'Test',
        redoable: true,
        schema: z.object({ object: z.string(), keep: z.string(), fcurve: z.string(), x: z.number() }),
        execute(ctx, p) {
          const keep = ctx.doc.getObject(p.keep);
          if (!keep) throw new OperatorError(`no object ${p.keep}`, 'NOT_FOUND');
          ctx.doc.updateObject(p.object, { location: [p.x, 0, 0] });
          ctx.doc.updateObject(keep.id, { location: keep.location });
          const fc = ctx.doc.getFCurve(p.fcurve);
          if (fc) ctx.doc.setFCurve(fc);
          return {};
        },
      }),
    );
    const cases: {
      name: string;
      adjustable: boolean;
      /** Whether the operation rewrites the F-curve too (default). */
      fcurve?: false;
      /** What the session does before the agent's edits (its own steps, undone again). */
      session?: (keep: string) => void;
      agent: (run: Agent, key: string) => void;
    }[] = [
      {
        name: 'setting both again',
        adjustable: true,
        agent: (run, key) => {
          run('object.transform_set', { objects: ['K'], location: [9, 9, 9] });
          run.doc.setFCurve({ ...run.doc.getFCurve(key)!, keyframes: [] });
        },
      },
      {
        // undoing would bring the F-curve back
        name: 'removing the F-curve',
        adjustable: false,
        agent: (run, key) => run.doc.removeFCurve(key),
      },
      {
        name: 'setting the location again, then deleting the object',
        adjustable: false,
        agent: (run) => {
          run('object.transform_set', { objects: ['K'], location: [9, 9, 9] });
          run('object.delete', { objects: ['K'] });
        },
      },
      {
        // the object the operation's rewrite is in now is the copy the session's undo brought back
        name: 'setting the location again, then deleting the object the session had deleted and undone',
        adjustable: false,
        fcurve: false,
        session: (keep) => {
          s.doc.removeObject(keep);
          s.undo.undo();
        },
        agent: (run) => {
          run('object.transform_set', { objects: ['K'], location: [9, 9, 9] });
          run('object.delete', { objects: ['K'] });
        },
      },
    ];
    for (const c of cases) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      ok('mesh.primitive_cube_add', { name: 'A' });
      ok('mesh.primitive_cube_add', { name: 'K', location: [0, 5, 0] });
      const channel = { target_type: 'object' as const, target_id: id('K'), path: 'location', index: 0 };
      s.doc.setFCurve(insertKeyframe(createFCurve(channel), 1, 0, 'LINEAR'));
      const key = fcurveKey(channel);
      const params = { object: id('A'), keep: id('K'), fcurve: c.fcurve === false ? '' : key, x: 1 };
      expect(runOperator(s, reg, 'test.place', params, 'test').ok).toBe(true);
      c.session?.(id('K'));
      expect(panelOffered(s), c.name).toBe(true);
      c.agent(agentReplica(s), key);
      const changed = s.doc.encodeState();
      const res = redoLast(s, reg, { ...params, x: 2 });
      if (c.adjustable) {
        expect(res?.ok, c.name).toBe(true);
        expectLocation('A', [2, 0, 0]);
        expectLocation('K', [9, 9, 9]);
        expect(s.doc.getFCurve(key)?.keyframes, c.name).toEqual([]);
      } else {
        expect(res, c.name).toBeNull();
        expect(s.doc.encodeState(), c.name).toEqual(changed);
        expect(infoLog.value.at(-1)?.message, c.name).toBe(
          'Place can no longer be adjusted: an agent or another user has changed what it did since',
        );
      }
    }
  });

  it('an edit of a field the operation changed counts as changing it, whatever part of the field it edits', () => {
    // every field of an object is stored whole: a rotation writes the whole rotation (all three
    // angles) of each object it rotates, adding a modifier the object's whole modifier stack; setting
    // the value the operation set again counts too (undoing could not bring back the value from
    // before it); deleting an object removes what an operation wrote into it
    const cases: { name: string; label: string; setup: () => void; agent: (run: Agent) => void }[] = [
      {
        name: 'the rotation of a rotated object',
        label: 'Rotate',
        setup: () => {
          ok('mesh.primitive_cube_add', { name: 'A' });
          select(s, 'A');
          ok('transform.rotate', { value: 0.5 });
        },
        agent: (run) => run('object.transform_set', { objects: ['A'], rotation_euler: [0, 0, 1] }),
      },
      {
        // a change far smaller than any shown, but far above the rounding of rewritten values
        name: 'the rotation of an object rotated by a billionth of a radian',
        label: 'Rotate',
        setup: () => {
          ok('mesh.primitive_cube_add', { name: 'A' });
          select(s, 'A');
          ok('transform.rotate', { value: 1e-9 });
        },
        agent: (run) => run('object.transform_set', { objects: ['A'], rotation_euler: [0, 0, 1] }),
      },
      {
        name: 'the location a move set, set again to the same value',
        label: 'Move',
        setup: () => {
          ok('mesh.primitive_cube_add', { name: 'A' });
          select(s, 'A');
          ok('transform.translate', { value: [1, 0, 0] });
        },
        agent: (run) => run('object.transform_set', { objects: ['A'], location: [1, 0, 0] }),
      },
      {
        name: 'deleting the moved object',
        label: 'Move',
        setup: () => {
          ok('mesh.primitive_cube_add', { name: 'A' });
          select(s, 'A');
          ok('transform.translate', { value: [1, 0, 0] });
        },
        agent: (run) => run('object.delete', { objects: ['A'] }),
      },
      {
        name: 'another modifier of the object a modifier was added to',
        label: 'Add Modifier',
        setup: () => {
          ok('mesh.primitive_cube_add', { name: 'A' });
          ok('object.modifier_add', { object: 'A', type: 'BEVEL' });
          select(s, 'A');
          ok('object.modifier_add', { object: 'A', type: 'SUBSURF' });
        },
        agent: (run) => {
          const bevel = s.doc.findObjectByName('A')!.modifiers[0].id;
          run('object.modifier_set', { object: 'A', modifier: bevel, params: { width: 0.2 } });
        },
      },
      {
        name: 'deleting one of the moved objects',
        label: 'Move',
        setup: () => {
          ok('mesh.primitive_cube_add', { name: 'A' });
          ok('mesh.primitive_cube_add', { name: 'B', location: [0, 5, 0] });
          select(s, 'A', 'B');
          ok('transform.translate', { value: [1, 0, 0] });
        },
        agent: (run) => run('object.delete', { objects: ['B'] }),
      },
    ];
    for (const c of cases) {
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      c.setup();
      const before = s.doc.encodeState();
      const depth = s.undo.undoStack.length;
      expect(lastOperator.peek()?.label, c.name).toBe(c.label);
      const agent = agentReplica(s);
      c.agent(agent);
      const changed = s.doc.encodeState();
      expect(changed, c.name).not.toEqual(before);
      const params = lastOperator.peek()!.params as Record<string, unknown>;
      expect(redoLast(s, registry, params), c.name).toBeNull();
      // nothing changed: the document is as the agent left it
      expect(s.doc.encodeState(), c.name).toEqual(changed);
      expect(s.undo.undoStack.length, c.name).toBe(depth);
      expect(infoLog.value.at(-1)?.message, c.name).toBe(
        `${c.label} can no longer be adjusted: an agent or another user has changed what it did since`,
      );
    }
  });

  it('an operation that removed an entry others have set again can no longer be adjusted', () => {
    // an operator that removes a channel's F-curve and sets the frame range
    const reg = new OperatorRegistry();
    reg.register(
      defineOperator({
        id: 'test.clear_channel',
        label: 'Clear Channel',
        description: 'Removes the F-curve `fcurve` and sets frame_end',
        category: 'Test',
        redoable: true,
        schema: z.object({ fcurve: z.string(), end: z.number() }),
        execute(ctx, p) {
          ctx.doc.removeFCurve(p.fcurve);
          ctx.doc.updateScene({ frame_end: p.end });
          return {};
        },
      }),
    );
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const channel = { target_type: 'object' as const, target_id: id('Cube'), path: 'location', index: 0 };
    s.doc.setFCurve(insertKeyframe(createFCurve(channel), 1, 0, 'LINEAR'));
    const key = fcurveKey(channel);
    expect(runOperator(s, reg, 'test.clear_channel', { fcurve: key, end: 50 }, 'test').ok).toBe(true);
    const depth = s.undo.undoStack.length;
    // the agent keys the channel again, setting the F-curve entry the operation removed
    const agent = agentReplica(s);
    agent.doc.setFCurve(insertKeyframe(createFCurve(channel), 10, 3, 'LINEAR'));
    // regression: Yjs could not bring the removed F-curve back (the agent's is newer) but undid the
    // frame range, and the re-run removed the agent's F-curve
    expect(redoLast(s, reg, { fcurve: key, end: 60 })).toBeNull();
    expect(s.doc.getFCurve(key)?.keyframes.map((k) => [k.frame, k.value])).toEqual([[10, 3]]);
    expect(s.doc.getScene().frame_end).toBe(50);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(lastOperator.value).toBeNull();
    expect(infoLog.value.at(-1)?.message).toBe(
      'Clear Channel can no longer be adjusted: an agent or another user has changed what it did since',
    );
  });

  it('a property edit is not run again on a field undoing it would leave empty', () => {
    // regression: the agent set the bone's IK while the user's Set Bone Transform was on its way,
    // and lost to it (Yjs orders values set at the same time by client id). Undoing the edit left
    // the armature without a pose (the agent's value follows the one before the edit), and the
    // re-run rebuilt the pose from the one channel it sets: the bone's IK stiffness was gone
    for (const [agentClient, agentWins] of [
      [1, false],
      [4_000_000_000, true],
    ] as const) {
      const name = `the agent's value ${agentWins ? 'won' : 'lost'}`;
      s = fakeSession();
      sessionSignal.value = s;
      lastOperator.value = null;
      s.doc.ydoc.clientID = 2_000_000_000;
      ok('object.armature_add', { name: 'Rig', bone_name: 'Elbow' });
      const rig = id('Rig');
      ok('pose.ik_settings_set', { object: rig, bone: 'Elbow', ik_stiffness_x: 0.3 });
      const agent = agentReplica(s, { clientID: agentClient });
      agent.pause();
      ok('pose.bone_transform_set', { object: rig, bone: 'Elbow', location: [0, 0.5, 0] });
      agent('pose.ik_settings_set', { object: 'Rig', bone: 'Elbow', ik_stiffness_y: 0.7 });
      agent.resume();
      const params = lastOperator.value!.params as Record<string, unknown>;
      const res = redoLast(s, registry, { ...params, location: [0, 1, 0] });
      if (agentWins) {
        // the pose is the agent's (without the edit's location): the edit runs again on top of it
        expect(res?.ok, name).toBe(true);
        expect(pb(), name).toMatchObject({ location: [0, 1, 0], ik_stiffness_x: 0.3, ik_stiffness_y: 0.7 });
      } else {
        expect(res, name).toBeNull();
        expect(pb(), name).toMatchObject({ location: [0, 0.5, 0], ik_stiffness_x: 0.3 });
        expect(infoLog.value.at(-1)?.message, name).toBe(
          'Set Bone Transform can no longer be adjusted: an agent or another user has changed what it did since',
        );
      }
    }
  });

  it('a property edit others changed part of runs again on top of their change', () => {
    ok('object.armature_add', { name: 'Rig', bone_name: 'Elbow' });
    const rig = id('Rig');
    ok('pose.bone_transform_set', { object: rig, bone: 'Elbow', location: [0, 0.5, 0], keyframe: true });
    const depth = s.undo.undoStack.length;
    // the agent sets an IK setting of the bone, which stores the armature's whole pose again: the
    // pose is theirs now, the keyframes the edit inserted are still the edit's
    const agent = agentReplica(s);
    agent('pose.ik_settings_set', { object: 'Rig', bone: 'Elbow', ik_stiffness_x: 0.5 });
    const params = lastOperator.value!.params as Record<string, unknown>;
    expect(redoLast(s, registry, { ...params, location: [0, 1, 0] })?.ok).toBe(true);
    expect(pb()).toMatchObject({ location: [0, 1, 0], ik_stiffness_x: 0.5 });
    // the keyframes are the adjusted edit's, once
    const keys = s.doc
      .listFCurves(rig)
      .filter((fc) => fc.path === 'pose.bones["Elbow"].location')
      .sort((a, b) => a.index - b.index)
      .map((fc) => fc.keyframes.map((k) => k.value));
    expect(keys).toEqual([[0], [1], [0]]);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(panelOffered(s)).toBe(true);
  });
});

describe('a field of the panel taken away while it holds typed text', () => {
  // a field commits the text it holds also when it goes away (in Chromium through the change event
  // and blur it sends then), with what the panel rendered
  it.each([
    ['Chromium', removalLikeChromium],
    ['Firefox and Safari', () => () => {}],
  ] as const)(
    '%s: an operation another one replaced is not run again with the typed text',
    async (_b, removal) => {
      // regression: after an agent's operation replaced the panel's operation, the typed text was
      // committed with the old operation's parameters: the agent's operation was undone, run again with
      // them, refused (an error toast) and brought back
      ok('object.text_add', { body: 'Hello', name: 'Title' });
      const { container } = render(<RedoPanel s={s} />);
      const body = container.querySelector<HTMLInputElement>('[data-testid="redo-body"]')!;
      body.focus();
      fireEvent.input(body, { target: { value: 'Typed' } });
      const restore = removal();
      try {
        act(() => {
          expect(runResult('mesh.primitive_cube_add', { name: 'AgentCube' }, 'mcp')?.ok).toBe(true);
        });
        expect(container.querySelector('[data-testid="redo-body"]')).toBeNull();
        await settle();
      } finally {
        restore();
      }
      expect(lastOperator.value?.id).toBe('mesh.primitive_cube_add');
      expect(s.doc.findObjectByName('AgentCube')).not.toBeNull();
      expect(toasts.value.filter((t) => t.level === 'error')).toEqual([]);
      const title = s.doc.findObjectByName('Title')!;
      expect(s.doc.getCurve(title.data!)?.body).toBe('Hello');
    },
  );

  const browsers = [
    ['Chromium', removalLikeChromium],
    ['Firefox and Safari', () => () => {}],
  ] as const;
  /** Presses Enter in the field that has the keyboard focus, as the person would after a change. */
  const enterOnFocused = (root: Element) => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.isConnected && root.contains(el))
      fireEvent.keyDown(el, { key: 'Enter' });
  };

  it.each(browsers)(
    '%s: text typed for an operation goes to neither it nor the next one of the same operator',
    async (_b, removal) => {
      // regression: the panel kept its fields for the next operation when it had the same parameter
      // with the same value (an agent's Add Text after the person's), and the typed text, kept in the
      // field, re-ran the agent's operation with it
      toasts.value = [];
      ok('object.text_add', { body: 'Hello', name: 'Title' });
      const { container } = render(<RedoPanel s={s} />);
      const body = container.querySelector<HTMLInputElement>('[data-testid="redo-body"]')!;
      body.focus();
      fireEvent.input(body, { target: { value: 'Typed' } });
      const restore = removal();
      try {
        act(() => {
          const r = runResult(
            'object.text_add',
            { body: 'Hello', name: 'Agent', location: [4, 0, 0] },
            'mcp',
          );
          expect(r?.ok).toBe(true);
        });
        expect(body.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      const bodyOf = (name: string) => s.doc.getCurve(s.doc.findObjectByName(name)!.data!)?.body;
      expect(bodyOf('Title')).toBe('Hello');
      expect(bodyOf('Agent')).toBe('Hello');
      expect(s.doc.findObjectByName('Agent')!.location).toEqual([4, 0, 0]);
      expect(container.querySelector<HTMLInputElement>('[data-testid="redo-body"]')!.value).toBe('Hello');
      expect(toasts.value.filter((t) => t.level === 'error')).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: a number typed for an operation is not applied to the next operation with that parameter',
    async (_b, removal) => {
      // regression: the open entry of Location X stayed open for the agent's Add UV Sphere, and Enter
      // moved the agent's sphere
      ok('mesh.primitive_cube_add', { name: 'Mine' });
      const { container } = render(<RedoPanel s={s} />);
      const x = container.querySelector<HTMLElement>('[data-testid="redo-location-0"]')!;
      fireEvent.pointerDown(x, { button: 0, clientX: 5, pointerId: 1 });
      fireEvent.pointerUp(x, { button: 0, clientX: 5, pointerId: 1 });
      const entry = x.querySelector('input')!;
      entry.focus();
      fireEvent.input(entry, { target: { value: '2' } });
      const restore = removal();
      try {
        act(() => {
          const r = runResult('mesh.primitive_uv_sphere_add', { name: 'Sphere', location: [0, 5, 0] }, 'mcp');
          expect(r?.ok).toBe(true);
        });
        expect(entry.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(s.doc.findObjectByName('Sphere')!.location).toEqual([0, 5, 0]);
      expect(s.doc.findObjectByName('Mine')!.location).toEqual([0, 0, 0]);
      expect(lastOperator.value?.id).toBe('mesh.primitive_uv_sphere_add');
    },
  );

  it('an operation keeps its fields (and the keyboard focus) while it is adjusted', () => {
    ok('object.text_add', { body: 'Hello', name: 'Title' });
    const { container } = render(<RedoPanel s={s} />);
    const body = container.querySelector<HTMLInputElement>('[data-testid="redo-body"]')!;
    const serial = lastOperator.value!.serial;
    body.focus();
    fireEvent.input(body, { target: { value: 'Adjusted' } });
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(s.doc.getCurve(s.doc.findObjectByName('Title')!.data!)?.body).toBe('Adjusted');
    expect(lastOperator.value!.serial).toBe(serial);
    expect(container.querySelector('[data-testid="redo-body"]')).toBe(body);
    expect(document.activeElement).toBe(body);
    // the same operator run again is another operation
    act(() => void ok('object.text_add', { body: 'Hello', name: 'Second' }));
    expect(lastOperator.value!.serial).not.toBe(serial);
    expect(container.querySelector('[data-testid="redo-body"]')).not.toBe(body);
  });
});
