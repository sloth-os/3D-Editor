import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';
import { h } from 'preact';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { OperatorError, OperatorRegistry, SceneDoc, SceneEvaluator, defineOperator } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { registry, runResult } from '../src/editor/editor';
import { lastOperator, redoLast, runOperator } from '../src/editor/runner';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { registerUiOperators } from '../src/editor/ui-operators';
import { enableRedoPanelOperators } from '../src/editor/menus';
import type { ProjectSession } from '../src/project/session';
import { RedoPanel } from '../src/ui/RedoPanel';

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
    ok('armature.bone_add', { object: rig, name: 'Lower', head: [0, 0, 1], tail: [0, 0, 2], parent: 'Upper' });
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
