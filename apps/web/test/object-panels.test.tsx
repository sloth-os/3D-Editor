import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  defaultBone,
  fcurveKey,
  type OperatorContext,
} from '@3d-editor/core';
import { session as sessionSignal, toasts } from '../src/app/store';
import { registry, run, runResult } from '../src/editor/editor';
import { PARENT_SET_MENU } from '../src/editor/menus';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Properties, activePropertiesTab, availableTabs } from '../src/ui/properties/Properties';
import { Outliner } from '../src/ui/Outliner';
import { Sidebar } from '../src/ui/Viewport';
import { layoutConstraintParams, constraintEnumLabel } from '../src/ui/properties/ConstraintsTab';
import { channelLabel } from '../src/ui/properties/ObjectTab';
import { PRESS_GRACE_MS } from '../src/ui/properties/shown-object';
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

function select(s: ProjectSession, ...names: string[]): void {
  const ids = names.map((n) => s.doc.findObjectByName(n)!.id);
  s.state.selectedIds = ids;
  s.state.activeId = ids[ids.length - 1];
}

const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.menu .menu-item')].find(
    (el) => el.querySelector('.label')?.textContent === label,
  );

/** Types into a Blender-style number field (click, type, Enter). */
function typeNumber(el: HTMLElement, value: string): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
  fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
  const input = el.querySelector('input')!;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

function typeText(el: HTMLElement, value: string): void {
  const input = (el.tagName === 'INPUT' ? el : el.querySelector('input')) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Drags a number field horizontally by `dx` pixels; `during` runs while the button is still down. */
function dragNumber(el: HTMLElement, dx: number, during?: () => void): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 100 + dx / 2, pointerId: 1 });
  if (during) act(during);
  fireEvent.pointerMove(el, { clientX: 100 + dx, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 100 + dx, pointerId: 1 });
}

/**
 * A second replica of the project (another device or an MCP agent) synced both ways like the sync
 * hub; `run` executes an operator there, outside this session's undo history.
 */
function peerReplica(s: ProjectSession): {
  run: (id: string, params: Record<string, unknown>) => void;
  /** The peer's own selection (operators such as object.convert work on it). */
  state: OperatorContext['state'];
} {
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
    state: ctx.state,
  };
}

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

describe('constraint parameter layout', () => {
  it('groups axis toggles and limit rows like Blender', () => {
    const props = {
      use_x: { type: 'boolean' },
      use_y: { type: 'boolean' },
      use_z: { type: 'boolean' },
      invert_x: { type: 'boolean' },
      invert_y: { type: 'boolean' },
      invert_z: { type: 'boolean' },
      use_offset: { type: 'boolean' },
      use_min_x: { type: 'boolean' },
      min_x: { type: 'number' },
      use_limit_z: { type: 'boolean' },
      min_z: { type: 'number' },
      max_z: { type: 'number' },
      owner_space: { type: 'string' },
      inverse_matrix: { type: 'array' },
    };
    const layout = layoutConstraintParams(props);
    expect(layout).toEqual([
      { kind: 'axes', label: 'Axis', keys: ['use_x', 'use_y', 'use_z'] },
      { kind: 'axes', label: 'Invert', keys: ['invert_x', 'invert_y', 'invert_z'] },
      { kind: 'fields', keys: ['use_offset'] },
      { kind: 'limit', label: 'Minimum X', flag: 'use_min_x', keys: ['min_x'] },
      { kind: 'limit', label: 'Limit Z', flag: 'use_limit_z', keys: ['min_z', 'max_z'] },
      { kind: 'fields', keys: ['owner_space'] },
    ]);
    expect(constraintEnumLabel('track_axis', 'TRACK_NEGATIVE_Z')).toBe('-Z');
    expect(constraintEnumLabel('up_axis', 'UP_Y')).toBe('Y');
    expect(constraintEnumLabel('owner_space', 'LOCAL')).toBe('Local Space');
    expect(channelLabel('location', 2, 3)).toBe('Z Location');
    expect(channelLabel('constraints["Track To"].influence', 0)).toBe('Influence (Track To)');
    expect(channelLabel('custom_props["amount"]', 0)).toBe('amount (Custom Property)');
    expect(channelLabel('color', 3, 4)).toBe('Color A');
  });
});

describe('Object Constraints tab', () => {
  it('adds, edits, mutes, reorders, applies and deletes constraints through operators', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Target', location: [0, 5, 0] });
    const rig = ok('object.armature_add', { name: 'Rig', location: [3, 0, 0] }).object as string;
    ok('armature.bone_add', { object: rig, name: 'Hand', head: [0, 0, 1], tail: [0, 0, 2] });
    select(s, 'Cube');
    activePropertiesTab.value = 'constraints';
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'prop-content-constraints')).not.toBeNull();

    // add a Track To from the Add Object Constraint menu
    fireEvent.pointerDown(byTestId(container, 'add-constraint-button')!);
    expect(menuItem('Inverse Kinematics')).toBeUndefined();
    fireEvent.click(menuItem('Track To')!);
    const cube = () => s.doc.findObjectByName('Cube')!;
    expect(cube().constraints.map((c) => c.type)).toEqual(['TRACK_TO']);
    // without a target the evaluation error is shown
    expect(byTestId(container, 'constraint-Track To-error')?.textContent).toMatch(/target/i);

    // pick the target: the error disappears
    const target = s.doc.findObjectByName('Target')!.id;
    fireEvent.change(byTestId(container, 'constraint-Track To-target')!, { target: { value: target } });
    expect(cube().constraints[0].target).toBe(target);
    expect(byTestId(container, 'constraint-Track To-error')).toBeNull();

    // axis enums are button rows with Blender labels
    const yButton = byTestId(container, 'constraint-Track To-track_axis-TRACK_Y')!;
    expect(yButton.textContent).toBe('Y');
    fireEvent.click(yButton);
    expect(cube().constraints[0].params.track_axis).toBe('TRACK_Y');

    // influence (typed), mute
    typeNumber(byTestId(container, 'constraint-Track To-influence')!, '0.25');
    expect(cube().constraints[0].influence).toBeCloseTo(0.25);
    fireEvent.click(byTestId(container, 'constraint-Track To-mute')!);
    expect(cube().constraints[0].mute).toBe(true);

    // a Copy Location targeting a bone of the armature
    fireEvent.pointerDown(byTestId(container, 'add-constraint-button')!);
    fireEvent.click(menuItem('Copy Location')!);
    fireEvent.change(byTestId(container, 'constraint-Copy Location-target')!, { target: { value: rig } });
    const bone = byTestId(container, 'constraint-Copy Location-bone') as HTMLSelectElement;
    expect([...bone.options].map((o) => o.value)).toEqual(['', 'Bone', 'Hand']);
    fireEvent.change(bone, { target: { value: 'Hand' } });
    expect(cube().constraints[1].subtarget).toBe('Hand');
    // Head/Tail appears with a bone; the axis toggles write booleans
    expect(byTestId(container, 'constraint-Copy Location-head_tail')).not.toBeNull();
    fireEvent.click(byTestId(container, 'constraint-Copy Location-use-1')!);
    expect(cube().constraints[1].params.use_y).toBe(false);

    // reorder, rename, delete
    fireEvent.pointerDown(byTestId(container, 'constraint-Copy Location-menu')!);
    fireEvent.click(menuItem('Move Up')!);
    expect(cube().constraints.map((c) => c.name)).toEqual(['Copy Location', 'Track To']);
    typeText(byTestId(container, 'constraint-Copy Location-name')!, 'Grab');
    expect(cube().constraints[0].name).toBe('Grab');
    fireEvent.click(byTestId(container, 'constraint-Track To-delete')!);
    expect(cube().constraints.map((c) => c.name)).toEqual(['Grab']);

    // apply bakes the result into the transform and removes the constraint
    fireEvent.pointerDown(byTestId(container, 'constraint-Grab-menu')!);
    fireEvent.click(menuItem('Apply')!);
    expect(cube().constraints).toHaveLength(0);
    expect(cube().location[0]).toBeCloseTo(3);
    // every edit was one undo step
    expect(s.undo.undoStack.length).toBeGreaterThan(8);
  });

  it('shows Set/Clear Inverse for Child Of, Animate Path for Follow Path and limit rows', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Parent', location: [1, 0, 0] });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    select(s, 'Cube');
    activePropertiesTab.value = 'constraints';
    const { container } = render(<Properties session={s} />);
    const cube = () => s.doc.findObjectByName('Cube')!;
    act(() => {
      ok('object.constraint_add', { object: 'Cube', type: 'CHILD_OF', target: 'Parent' });
      ok('object.constraint_add', { object: 'Cube', type: 'FOLLOW_PATH', target: 'Path' });
      ok('object.constraint_add', { object: 'Cube', type: 'LIMIT_ROTATION' });
    });

    // Child Of starts with an inverse (set when the target was assigned)
    expect(byTestId(container, 'constraint-Child Of')?.textContent).toContain('inverse set');
    fireEvent.click(byTestId(container, 'constraint-Child Of-clear-inverse')!);
    expect(cube().constraints[0].params.inverse_matrix).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    fireEvent.click(byTestId(container, 'constraint-Child Of-set-inverse')!);
    expect(byTestId(container, 'constraint-Child Of')?.textContent).toContain('inverse set');

    // Follow Path only lists curve targets; Animate Path keys the curve's eval_time
    const targets = [...(byTestId(container, 'constraint-Follow Path-target') as HTMLSelectElement).options];
    expect(targets.map((o) => o.textContent)).toEqual(['— none —', 'Path']);
    fireEvent.click(byTestId(container, 'constraint-Follow Path-animate-path')!);
    const path = s.doc.findObjectByName('Path')!;
    expect(
      s.doc.getFCurve(
        fcurveKey({ target_type: 'curve', target_id: path.data!, path: 'eval_time', index: 0 }),
      ),
    ).not.toBeNull();

    // Limit Rotation: checkbox + Min/Max in degrees per axis
    fireEvent.click(byTestId(container, 'constraint-Limit Rotation-use_limit_z')!);
    typeNumber(byTestId(container, 'constraint-Limit Rotation-max_z')!, '90');
    const lim = cube().constraints[2].params;
    expect(lim.use_limit_z).toBe(true);
    expect(lim.max_z as number).toBeCloseTo(Math.PI / 2);
  });
});

describe('Particles tab', () => {
  it('adds a system, picks the instance object, edits settings and shows instance counts', () => {
    ok('mesh.primitive_plane_add', { name: 'Ground', size: 4 });
    ok('mesh.primitive_cube_add', { name: 'Pebble', size: 0.1, location: [0, 0, 5] });
    select(s, 'Ground');
    activePropertiesTab.value = 'particles';
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'prop-tab-particles')).not.toBeNull();
    fireEvent.click(byTestId(container, 'psys-add')!);
    const ground = () => s.doc.findObjectByName('Ground')!;
    expect(ground().particle_systems).toHaveLength(1);
    // no instance object yet: the evaluation problem is shown
    expect(byTestId(container, 'psys-ParticleSystem-errors')?.textContent).toMatch(/instance_object/);

    const pebble = s.doc.findObjectByName('Pebble')!.id;
    fireEvent.change(byTestId(container, 'psys-ParticleSystem-instance_object')!, {
      target: { value: pebble },
    });
    expect(ground().particle_systems[0].settings.instance_object).toBe(pebble);
    typeNumber(byTestId(container, 'psys-ParticleSystem-count')!, '25');
    expect(ground().particle_systems[0].settings.count).toBe(25);
    expect(byTestId(container, 'psys-ParticleSystem-stats')?.textContent).toContain('25 instances');
    expect(byTestId(container, 'psys-ParticleSystem-errors')).toBeNull();

    // enum button rows and conditional fields (grid settings only for GRID)
    expect(byTestId(container, 'psys-ParticleSystem-grid_resolution')).toBeNull();
    fireEvent.click(byTestId(container, 'psys-ParticleSystem-distribution-GRID')!);
    expect(ground().particle_systems[0].settings.distribution).toBe('GRID');
    expect(byTestId(container, 'psys-ParticleSystem-grid_resolution')).not.toBeNull();

    // rename, hide in viewport, make real, remove
    typeText(byTestId(container, 'psys-ParticleSystem-name')!, 'Pebbles');
    expect(ground().particle_systems[0].name).toBe('Pebbles');
    fireEvent.click(byTestId(container, 'psys-Pebbles-viewport')!);
    expect(ground().particle_systems[0].show_viewport).toBe(false);
    const before = s.doc.listObjects().length;
    fireEvent.click(byTestId(container, 'psys-Pebbles-make-real')!);
    expect(s.doc.listObjects().length).toBeGreaterThan(before);
    // making instances real selects the new objects; back to the emitter
    act(() => select(s, 'Ground'));
    fireEvent.click(byTestId(container, 'psys-remove')!);
    expect(ground().particle_systems).toHaveLength(0);
  });

  it('particles and physics are not offered for objects that cannot use them', () => {
    ok('object.empty_add', { name: 'Empty' });
    select(s, 'Empty');
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'prop-tab-particles')).toBeNull();
    expect(byTestId(container, 'prop-tab-physics')).toBeNull();
    expect(byTestId(container, 'prop-tab-constraints')).not.toBeNull();
  });
});

describe('Physics tab', () => {
  it('adds a rigid body, edits its settings and the world, and removes it', () => {
    ok('mesh.primitive_cube_add', { name: 'Box', location: [0, 0, 3] });
    select(s, 'Box');
    activePropertiesTab.value = 'physics';
    const { container } = render(<Properties session={s} />);
    const box = () => s.doc.findObjectByName('Box')!;
    fireEvent.click(byTestId(container, 'physics-rigid-body')!);
    expect(box().rigid_body?.type).toBe('ACTIVE');
    typeNumber(byTestId(container, 'rigidbody-mass')!, '2.5');
    expect(box().rigid_body?.mass).toBeCloseTo(2.5);
    expect(byTestId(container, 'rigidbody-restitution')).not.toBeNull();
    fireEvent.change(byTestId(container, 'rigidbody-collision_shape')!, { target: { value: 'SPHERE' } });
    expect(box().rigid_body?.collision_shape).toBe('SPHERE');
    fireEvent.click(byTestId(container, 'rigidbody-type-PASSIVE')!);
    expect(box().rigid_body?.type).toBe('PASSIVE');
    // passive bodies have no mass field
    expect(byTestId(container, 'rigidbody-mass')).toBeNull();
    expect(byTestId(container, 'rigidbody-status')?.textContent).toBeTruthy();

    // world settings (panel is collapsed by default)
    fireEvent.click(
      [...container.querySelectorAll('.panel-header')].find((h) =>
        h.textContent?.includes('Rigid Body World'),
      )!,
    );
    typeNumber(byTestId(container, 'rigidbody-world-substeps_per_frame')!, '20');
    expect(s.doc.getScene().rigidbody_world.substeps_per_frame).toBe(20);

    fireEvent.click(byTestId(container, 'physics-rigid-body-remove')!);
    expect(box().rigid_body).toBeNull();
  });
});

describe('Drivers and F-curve modifiers in the Object tab', () => {
  it('adds a driver, edits its expression and variables, and removes it', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Ctrl', location: [2, 0, 0] });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const { container } = render(<Properties session={s} />);
    const channel = byTestId(container, 'driver-add-channel') as HTMLSelectElement;
    const z = [...channel.options].find((o) => o.textContent === 'Z Location')!;
    fireEvent.change(channel, { target: { value: z.value } });
    fireEvent.click(byTestId(container, 'driver-add')!);
    const cube = s.doc.findObjectByName('Cube')!;
    const key = fcurveKey({ target_type: 'object', target_id: cube.id, path: 'location', index: 2 });
    expect(s.doc.getDriver(key)?.expression).toBe('0');

    // an invalid expression is reported live and not committed
    const expr = byTestId(container, 'driver-location-2-expression') as HTMLInputElement;
    fireEvent.input(expr, { target: { value: 'sin(' } });
    expect(container.textContent).toMatch(/expected|unexpected|end/i);
    fireEvent.keyDown(expr, { key: 'Escape' });
    fireEvent.input(expr, { target: { value: 'frame / 10' } });
    fireEvent.keyDown(expr, { key: 'Enter' });
    expect(s.doc.getDriver(key)?.expression).toBe('frame / 10');
    // the panels re-evaluate at the new frame
    act(() => {
      s.state.frame = 20;
    });
    expect(byTestId(container, 'driver-location-2-value')?.textContent).toBe('2');

    // a variable reading another object, used in the expression
    fireEvent.click(byTestId(container, 'driver-location-2-add-variable')!);
    let d = s.doc.getDriver(key)!;
    expect(d.variables).toEqual([
      { name: 'var', target_type: 'object', target_id: cube.id, path: 'location', index: 0 },
    ]);
    const ctrl = s.doc.findObjectByName('Ctrl')!.id;
    fireEvent.change(byTestId(container, 'driver-location-2-var-0-target')!, { target: { value: ctrl } });
    typeText(byTestId(container, 'driver-location-2-expression')!, 'var * 2');
    d = s.doc.getDriver(key)!;
    expect(d.variables[0].target_id).toBe(ctrl);
    expect(byTestId(container, 'driver-location-2-value')?.textContent).toBe('4');

    fireEvent.click(byTestId(container, 'driver-location-2-mute')!);
    expect(s.doc.getDriver(key)?.mute).toBe(true);
    fireEvent.click(byTestId(container, 'driver-location-2-remove')!);
    expect(s.doc.getDriver(key)).toBeNull();
  });

  it('the expression field leaves composition keys to the IME and commits text typed before it renders', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('anim.driver_add', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 2,
      expression: '0',
    });
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const { container } = render(<Properties session={s} />);
    const cube = s.doc.findObjectByName('Cube')!;
    const key = fcurveKey({ target_type: 'object', target_id: cube.id, path: 'location', index: 2 });
    const expr = byTestId(container, 'driver-location-2-expression') as HTMLInputElement;
    // regression: the Enter that ends an IME conversion committed the expression typed so far
    fireEvent.input(expr, { target: { value: 'frame / 2' } });
    fireEvent.keyDown(expr, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.keyDown(expr, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(expr, { key: 'Escape', keyCode: 229 });
    expect(s.doc.getDriver(key)?.expression).toBe('0');
    expect(expr.value).toBe('frame / 2');
    fireEvent.keyDown(expr, { key: 'Enter' });
    expect(s.doc.getDriver(key)?.expression).toBe('frame / 2');
    // regression: a script that types and presses Enter before the field renders committed nothing
    expr.value = 'frame / 4';
    expr.dispatchEvent(new Event('input', { bubbles: true }));
    expr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(s.doc.getDriver(key)?.expression).toBe('frame / 4');
    // regression: the Enter of an Android keyboard that still composes the typed word (Gboard: key
    // code 13, marked isComposing) was ignored
    fireEvent.input(expr, { target: { value: 'frame / 8' } });
    fireEvent.keyDown(expr, { key: 'Enter', keyCode: 13, isComposing: true });
    expect(s.doc.getDriver(key)?.expression).toBe('frame / 8');
    // regression: an invalid expression typed and committed in one go (a script) stayed in the field
    // without its problems while the driver kept its expression
    act(() => {
      expr.value = 'frame *';
      expr.dispatchEvent(new Event('input', { bubbles: true }));
      expr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(s.doc.getDriver(key)?.expression).toBe('frame / 8');
    expect(expr.value).toBe('frame / 8');
  });

  it('lists animated channels with extrapolation and F-curve modifiers', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 0,
    });
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-fcurves', '1');
    const { container } = render(<Properties session={s} />);
    const cube = s.doc.findObjectByName('Cube')!;
    const key = fcurveKey({ target_type: 'object', target_id: cube.id, path: 'location', index: 0 });
    expect(byTestId(container, 'fcurve-location-0')?.textContent).toContain('X Location');
    fireEvent.change(byTestId(container, 'fcurve-location-0-extrapolation')!, {
      target: { value: 'LINEAR' },
    });
    expect(s.doc.getFCurve(key)?.extrapolation).toBe('LINEAR');

    fireEvent.pointerDown(byTestId(container, 'fcurve-location-0-add-modifier')!);
    fireEvent.click(menuItem('Noise')!);
    expect(s.doc.getFCurve(key)?.modifiers?.map((m) => m.type)).toEqual(['NOISE']);
    typeNumber(byTestId(container, 'fcurve-location-0-mod-0-strength')!, '3');
    expect(s.doc.getFCurve(key)?.modifiers?.[0].params.strength).toBe(3);
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-mute')!);
    expect(s.doc.getFCurve(key)?.modifiers?.[0].mute).toBe(true);

    fireEvent.pointerDown(byTestId(container, 'fcurve-location-0-add-modifier')!);
    fireEvent.click(menuItem('Generator')!);
    typeText(byTestId(container, 'fcurve-location-0-mod-1-coefficients')!, '1, 0.5, 0.25');
    expect(s.doc.getFCurve(key)?.modifiers?.[1].params.coefficients).toEqual([1, 0.5, 0.25]);
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-remove')!);
    expect(s.doc.getFCurve(key)?.modifiers?.map((m) => m.type)).toEqual(['GENERATOR']);
  });

  it('edits the collection an empty instances', () => {
    ok('collection.create', { name: 'Props' });
    ok('object.empty_add', { name: 'Holder' });
    select(s, 'Holder');
    activePropertiesTab.value = 'object';
    const { container } = render(<Properties session={s} />);
    const props = s.doc.listCollections().find((c) => c.name === 'Props')!;
    fireEvent.change(byTestId(container, 'instance-collection')!, { target: { value: props.id } });
    const holder = s.doc.findObjectByName('Holder')!;
    expect(holder.instance_type).toBe('COLLECTION');
    expect(holder.instance_collection).toBe(props.id);
    expect(byTestId(container, 'instance-count')?.textContent).toBe('0 instances');
  });
});

describe('Outliner sub-items', () => {
  it('shows type icons, badges and Blender-style children rows that open their Properties tab', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Target' });
    ok('object.modifier_add', { object: 'Cube', type: 'SUBSURF' });
    ok('object.constraint_add', { object: 'Cube', type: 'TRACK_TO', target: 'Target' });
    ok('object.particle_system_add', { object: 'Cube' });
    select(s, 'Cube');
    ok('rigidbody.object_add', { objects: ['Cube'] });
    ok('object.text_add', { name: 'Label' });
    ok('object.armature_add', { name: 'Rig' });
    ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
    const { container } = render(<Outliner session={s} />);
    // collapsed: one badge per kind of sub-item
    for (const k of ['modifiers', 'constraints', 'particles', 'rigid_body'])
      expect(byTestId(container, `outl-badge-Cube-${k}`)).not.toBeNull();
    expect(byTestId(container, 'outl-group-Cube-modifiers')).toBeNull();
    // the object rows keep their test ids (and nothing else starts with 'outliner-')
    const names = [...container.querySelectorAll<HTMLElement>('[data-testid^="outliner-"]')]
      .map((e) => e.dataset.testid!)
      .filter((t) => t !== 'outliner' && !t.startsWith('outliner-vis-'));
    expect(names.sort()).toEqual([
      'outliner-Cube',
      'outliner-Label',
      'outliner-Rig',
      'outliner-Target',
      'outliner-Wire',
    ]);

    fireEvent.click(byTestId(container, 'outl-twisty-Cube')!);
    expect(byTestId(container, 'outl-modifier-Cube-Subdivision')).not.toBeNull();
    expect(byTestId(container, 'outl-constraint-Cube-Track To')).not.toBeNull();
    expect(byTestId(container, 'outl-particles-Cube-ParticleSystem')).not.toBeNull();
    expect(byTestId(container, 'outl-physics-Cube-rigid_body')?.textContent).toContain('Rigid Body (Active)');

    // clicking a constraint selects the object and opens the constraints tab
    select(s, 'Target');
    activePropertiesTab.value = 'object';
    fireEvent.click(byTestId(container, 'outl-constraint-Cube-Track To')!);
    expect(s.state.activeId).toBe(s.doc.findObjectByName('Cube')!.id);
    expect(activePropertiesTab.value).toBe('constraints');

    // the eye toggle of a sub-item mutes the constraint
    const row = byTestId(container, 'outl-constraint-Cube-Track To')!;
    fireEvent.click(row.querySelector('.vis')!);
    expect(s.doc.findObjectByName('Cube')!.constraints[0].mute).toBe(true);
  });
});

describe('malformed stored data', () => {
  it('skips malformed constraint and particle entries instead of crashing', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.constraint_add', { object: 'Cube', type: 'LIMIT_SCALE' });
    const cube = s.doc.findObjectByName('Cube')!;
    s.doc.updateObject(cube.id, {
      constraints: [null, ...cube.constraints, 'junk'] as unknown as typeof cube.constraints,
      particle_systems: [7] as unknown as typeof cube.particle_systems,
    });
    select(s, 'Cube');
    activePropertiesTab.value = 'constraints';
    const { container } = render(<Properties session={s} />);
    expect(container.querySelectorAll('[data-testid="constraint-Limit Scale"]').length).toBe(1);
    act(() => {
      activePropertiesTab.value = 'particles';
    });
    expect(byTestId(container, 'particle-systems')?.textContent).toContain('No particle systems');
    const outliner = render(<Outliner session={s} />);
    expect(byTestId(outliner.container, 'outl-badge-Cube-constraints')).not.toBeNull();
  });

  // lists of an old or foreign file whose items are not all records: the panels show (and add to)
  // the items that are, instead of the tab failing to draw
  it('shows and adds to the variables of a driver whose list holds items that are none', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Ctrl' });
    const ctrl = s.doc.findObjectByName('Ctrl')!.id;
    ok('anim.driver_add', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 2,
      expression: 'a',
      variables: [{ name: 'a', target_type: 'object', target: ctrl, path: 'location', index: 0 }],
    });
    const cube = s.doc.findObjectByName('Cube')!.id;
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 2 });
    const d = s.doc.getDriver(key)!;
    s.doc.setDriver({ ...d, variables: [null, ...d.variables, 'junk'] as unknown as typeof d.variables });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'driver-location-2-var-0')).not.toBeNull();
    expect(byTestId(container, 'driver-location-2-var-1')).toBeNull();
    fireEvent.click(byTestId(container, 'driver-location-2-add-variable')!);
    expect(s.doc.getDriver(key)!.variables.map((v) => v.name)).toEqual(['a', 'var']);
  });

  it('shows and adds to the control points of an envelope whose list holds items that are none', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const cube = s.doc.findObjectByName('Cube')!.id;
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 0,
    });
    ok('anim.fmodifier_add', {
      target_type: 'object',
      target: cube,
      path: 'location',
      index: 0,
      type: 'ENVELOPE',
    });
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
    const setPoints = (points: unknown[]) => {
      const fc = s.doc.getFCurve(key)!;
      const m = fc.modifiers![0];
      const params = { ...m.params, control_points: points } as unknown as typeof m.params;
      s.doc.setFCurve({ ...fc, modifiers: [{ ...m, params }] });
    };
    const points = () => s.doc.getFCurve(key)!.modifiers![0].params.control_points as unknown as unknown[];
    setPoints([null, 7]);
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-fcurves', '1');
    const { container } = render(<Properties session={s} />);
    const labels = () =>
      byTestId(container, 'fcurve-location-0-mod-0')!.textContent!.split('Control Points').length - 1;
    // no point: the list's label is on its Add row
    expect(byTestId(container, 'fcurve-location-0-mod-0-point-0-min')).toBeNull();
    expect(labels()).toBe(1);
    act(() => {
      s.state.frame = 5;
    });
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-add-point')!);
    expect(points().filter((p) => p !== null && typeof p === 'object')).toEqual([
      { frame: 5, min: -1, max: 1 },
    ]);
    // a point behind the items that are none: its row has the label, and adding on its frame adds nothing
    act(() => setPoints([null, { frame: 5, min: -1, max: 1 }, 7]));
    expect(byTestId(container, 'fcurve-location-0-mod-0-point-1-min')).not.toBeNull();
    expect(labels()).toBe(1);
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-add-point')!);
    expect(points().filter((p) => p !== null && typeof p === 'object')).toEqual([
      { frame: 5, min: -1, max: 1 },
    ]);
  });

  it('shows the bones of an armature whose list holds items that are none, in its panels and pickers', () => {
    ok('object.armature_add', { name: 'Rig' });
    ok('armature.bone_add', { object: 'Rig', name: 'Hand', head: [0, 0, 1], tail: [0, 0, 2] });
    ok('object.armature_add', { name: 'Other', location: [3, 0, 0] });
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.parent_to', { objects: ['Cube'], parent: 'Rig', type: 'BONE', bone: 'Bone' });
    ok('object.constraint_add', { object: 'Cube', type: 'COPY_LOCATION', target: 'Rig', subtarget: 'Bone' });
    for (const name of ['Rig', 'Other']) {
      const arm = s.doc.getArmature(s.doc.findObjectByName(name)!.data!)!;
      s.doc.updateArmature(arm.id, { bones: [null, ...arm.bones, 'junk'] as unknown as typeof arm.bones });
    }
    select(s, 'Rig');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    expect((byTestId(container, 'bone-name') as HTMLInputElement).value).toBe('Bone');
    const options = (id: string) =>
      [...(byTestId(container, id) as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);
    // a bone chosen in the list
    fireEvent.click(byTestId(container, 'bone-Hand')!);
    expect((byTestId(container, 'bone-name') as HTMLInputElement).value).toBe('Hand');
    // the bones of another armature as the target of an IK chain
    fireEvent.change(byTestId(container, 'pose-ik-target')!, {
      target: { value: s.doc.findObjectByName('Other')!.id },
    });
    expect(options('pose-ik-bone')).toEqual(['Bone']);
    const boneMenu = PARENT_SET_MENU().find((i) => i.label === 'Bone')?.submenu;
    const boneItems = typeof boneMenu === 'function' ? boneMenu() : boneMenu;
    expect(boneItems?.map((i) => i.label)).toEqual(['Bone', 'Hand']);
    act(() => {
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
    });
    expect(options('object-parent-bone')).toEqual(['Bone', 'Hand']);
    act(() => {
      activePropertiesTab.value = 'constraints';
    });
    expect(options('constraint-Copy Location-bone')).toEqual(['Bone', 'Hand']);
  });
});

describe('registry wiring', () => {
  it('runs through the shared registry used by menus', () => {
    expect(registry.has('object.constraint_add')).toBe(true);
    expect(run('mesh.primitive_cube_add', {}, 'test')).toBe(true);
    const armature = ok('object.armature_add', { name: 'Arm' }).object as string;
    expect(s.doc.getArmature(s.doc.getObject(armature)!.data!)?.bones.map((b) => b.name)).toEqual(['Bone']);
    expect(defaultBone('X', [0, 0, 0], [0, 0, 1]).name).toBe('X');
  });
});

describe('slider drags next to concurrent edits (other devices, MCP agents)', () => {
  it('releasing a constraint drag keeps constraints an agent added meanwhile', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Target', location: [0, 5, 0] });
    ok('object.constraint_add', { object: 'Cube', type: 'TRACK_TO', target: 'Target' });
    select(s, 'Cube');
    const agent = peerReplica(s);
    activePropertiesTab.value = 'constraints';
    const { container } = render(<Properties session={s} />);
    const cube = () => s.doc.findObjectByName('Cube')!;
    const depth = s.undo.undoStack.length;
    dragNumber(byTestId(container, 'constraint-Track To-influence')!, -40, () =>
      agent.run('object.constraint_add', { object: 'Cube', type: 'LIMIT_LOCATION', name: 'AgentLimit' }),
    );
    expect(cube().constraints.map((c) => c.name)).toEqual(['Track To', 'AgentLimit']);
    expect(cube().constraints[0].influence).toBeCloseTo(0.6);
    // the drag is one undo step, and undoing it only reverts the influence
    expect(s.undo.undoStack.length).toBe(depth + 1);
    act(() => {
      s.undo.undo();
    });
    expect(cube().constraints.map((c) => c.name)).toEqual(['Track To', 'AgentLimit']);
    expect(cube().constraints[0].influence).toBe(1);
  });

  it('particle, rigid body, world and F-modifier drags keep what others changed meanwhile', () => {
    ok('mesh.primitive_plane_add', { name: 'Ground', size: 4 });
    ok('object.particle_system_add', { object: 'Ground' });
    select(s, 'Ground');
    ok('rigidbody.object_add', { objects: ['Ground'], type: 'ACTIVE' });
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Ground',
      path: 'location',
      index: 0,
    });
    ok('anim.fmodifier_add', { target: 'Ground', path: 'location', index: 0, type: 'NOISE' });
    const agent = peerReplica(s);
    const ground = () => s.doc.findObjectByName('Ground')!;
    activePropertiesTab.value = 'particles';
    localStorage.setItem('3d-editor:panel:object-fcurves', '1');
    const { container } = render(<Properties session={s} />);

    const count = Number(ground().particle_systems[0].settings.count);
    dragNumber(byTestId(container, 'psys-ParticleSystem-count')!, 50, () =>
      agent.run('object.particle_system_add', { object: 'Ground', name: 'AgentSystem' }),
    );
    expect(ground().particle_systems.map((p) => p.name)).toEqual(['ParticleSystem', 'AgentSystem']);
    expect(ground().particle_systems[0].settings.count).toBe(count + 50);

    act(() => {
      activePropertiesTab.value = 'physics';
    });
    dragNumber(byTestId(container, 'rigidbody-mass')!, 100, () =>
      agent.run('rigidbody.object_settings_set', { objects: ['Ground'], friction: 0.9 }),
    );
    expect(ground().rigid_body?.friction).toBeCloseTo(0.9);
    expect(ground().rigid_body?.mass).toBeCloseTo(2);

    fireEvent.click(
      [...container.querySelectorAll('.panel-header')].find((h) =>
        h.textContent?.includes('Rigid Body World'),
      )!,
    );
    const substeps = s.doc.getScene().rigidbody_world.substeps_per_frame;
    dragNumber(byTestId(container, 'rigidbody-world-substeps_per_frame')!, 10, () =>
      agent.run('rigidbody.world_set', { solver_iterations: 33 }),
    );
    expect(s.doc.getScene().rigidbody_world.solver_iterations).toBe(33);
    expect(s.doc.getScene().rigidbody_world.substeps_per_frame).toBe(substeps + 10);

    act(() => {
      activePropertiesTab.value = 'object';
    });
    dragNumber(byTestId(container, 'fcurve-location-0-mod-0-strength')!, 100, () =>
      agent.run('anim.keyframe_insert_property', {
        target_type: 'object',
        target: 'Ground',
        path: 'location',
        index: 0,
        frame: 20,
        value: 3,
      }),
    );
    const fc = s.doc.getFCurve(
      fcurveKey({ target_type: 'object', target_id: ground().id, path: 'location', index: 0 }),
    )!;
    expect(fc.keyframes.map((k) => k.frame)).toEqual([1, 20]);
    expect(fc.modifiers?.[0].params.strength).toBeCloseTo(2);
  });
});

describe('a slider drag whose field is taken away', () => {
  it('ends on the value it reached, for what it was dragging, as its own undo step', async () => {
    // regression: an agent put another material in the slot during a Roughness drag; the rebuilt
    // panel took the field away, the drag never ended, and the next drag of the field went on with
    // it (one undo step for both gestures)
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('material.new', { name: 'A' });
    ok('material.new', { name: 'B', assign: false });
    activePropertiesTab.value = 'material';
    const mat = (name: string) => s.doc.listMaterials().find((m) => m.name === name)!;
    const ids = { a: mat('A').id, b: mat('B').id };
    const before = { a: mat('A').roughness, b: mat('B').roughness };
    const agent = peerReplica(s);
    const cube = () => s.doc.findObjectByName('Cube')!.id;
    const { container } = render(<Properties session={s} />);
    const depth = s.undo.undoStack.length;
    const field = () => byTestId(container, 'material-roughness')!;
    fireEvent.pointerDown(field(), { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(field(), { clientX: 120, pointerId: 1 });
    const reached = mat('A').roughness;
    expect(reached).toBeCloseTo(before.a + 0.2);
    act(() => agent.run('object.material_assign', { material: ids.b, objects: [cube()], slot: 0 }));
    // the rest of the gesture reaches the field now there (Material B's), which has no drag
    fireEvent.pointerMove(field(), { clientX: 140, pointerId: 1 });
    fireEvent.pointerUp(field(), { clientX: 140, pointerId: 1 });
    await settle();
    expect(mat('A').roughness).toBeCloseTo(reached);
    expect(mat('B').roughness).toBe(before.b);
    expect(s.undo.undoStack.length).toBe(depth + 1);
    // Material A comes back, and a new drag of the field is a gesture (and an undo step) of its own
    act(() => agent.run('object.material_assign', { material: ids.a, objects: [cube()], slot: 0 }));
    dragNumber(field(), 20);
    expect(mat('A').roughness).toBeCloseTo(reached + 0.2);
    expect(s.undo.undoStack.length).toBe(depth + 2);
    act(() => void s.undo.undo());
    expect(mat('A').roughness).toBeCloseTo(reached);
    act(() => void s.undo.undo());
    expect(mat('A').roughness).toBe(before.a);
  });
});

describe('a press on a slider whose field is taken away before any drag', () => {
  it('writes nothing and leaves no undo step', async () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('material.new', { name: 'A' });
    ok('material.new', { name: 'B', assign: false });
    activePropertiesTab.value = 'material';
    const mat = (name: string) => s.doc.listMaterials().find((m) => m.name === name)!;
    const before = mat('A').roughness;
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const depth = s.undo.undoStack.length;
    fireEvent.pointerDown(byTestId(container, 'material-roughness')!, {
      button: 0,
      clientX: 100,
      pointerId: 1,
    });
    act(() =>
      agent.run('object.material_assign', {
        material: mat('B').id,
        objects: [s.doc.findObjectByName('Cube')!.id],
        slot: 0,
      }),
    );
    await settle();
    expect(mat('A').roughness).toBe(before);
    expect(s.undo.undoStack.length).toBe(depth);
  });
});

describe('undo of slider drags', () => {
  // regression: a drag's live values were written as if by someone else, so undo could not take the
  // field back past an earlier change of it: the step was skipped and Ctrl+Z undid an older one
  // instead (deleting the object), leaving the field as the first drag left it
  const cubeX = () => s.doc.findObjectByName('Cube')?.location[0];

  it('two drags of one field are undone one at a time', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    const { container } = render(<Properties session={s} />);
    const depth = s.undo.undoStack.length;
    dragNumber(byTestId(container, 'loc-0')!, 50);
    const first = cubeX();
    dragNumber(byTestId(container, 'loc-0')!, 50);
    expect(cubeX()).toBeGreaterThan(first!);
    expect(s.undo.undoStack.length).toBe(depth + 2);
    act(() => void s.undo.undo());
    expect(cubeX()).toBe(first);
    act(() => void s.undo.undo());
    expect(cubeX()).toBe(0);
    expect(s.undo.undoStack.length).toBe(depth);
    // and back again
    act(() => void s.undo.redo());
    act(() => void s.undo.redo());
    expect(cubeX()).toBeGreaterThan(first!);
  });

  it('a typed value and then a drag of the same field are undone one at a time', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    const { container } = render(<Properties session={s} />);
    typeNumber(byTestId(container, 'loc-0')!, '2');
    dragNumber(byTestId(container, 'loc-0')!, 50);
    expect(cubeX()).toBeGreaterThan(2);
    act(() => void s.undo.undo());
    expect(cubeX()).toBe(2);
    act(() => void s.undo.undo());
    expect(cubeX()).toBe(0);
  });

  it('two constraint drags are undone one at a time', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Target', location: [0, 5, 0] });
    ok('object.constraint_add', { object: 'Cube', type: 'TRACK_TO', target: 'Target' });
    select(s, 'Cube');
    activePropertiesTab.value = 'constraints';
    const { container } = render(<Properties session={s} />);
    const influence = () => s.doc.findObjectByName('Cube')?.constraints[0]?.influence;
    const depth = s.undo.undoStack.length;
    dragNumber(byTestId(container, 'constraint-Track To-influence')!, -20);
    const first = influence();
    dragNumber(byTestId(container, 'constraint-Track To-influence')!, -20);
    expect(influence()).toBeLessThan(first!);
    act(() => void s.undo.undo());
    expect(influence()).toBe(first);
    act(() => void s.undo.undo());
    expect(influence()).toBe(1);
    expect(s.undo.undoStack.length).toBe(depth);
    expect(s.doc.findObjectByName('Target')).not.toBeNull();
  });

  it('a drag of a light an agent deletes meanwhile leaves no step', () => {
    ok('object.light_add', { name: 'Lamp', type: 'POINT' });
    select(s, 'Lamp');
    activePropertiesTab.value = 'data';
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const depth = s.undo.undoStack.length;
    dragNumber(byTestId(container, 'light-energy')!, 50, () =>
      agent.run('object.delete', { objects: [s.doc.findObjectByName('Lamp')!.id] }),
    );
    expect(s.doc.listObjects()).toEqual([]);
    // the live values went with the light: no step that undoes nothing (Yjs would undo the step
    // before it on that Ctrl+Z)
    expect(s.undo.undoStack.length).toBe(depth);
  });

  it('a drag of a modifier an agent removes meanwhile leaves no step and undoes nothing else', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.modifier_add', { object: 'Cube', type: 'SUBSURF' });
    select(s, 'Cube');
    activePropertiesTab.value = 'modifiers';
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const cube = () => s.doc.findObjectByName('Cube');
    const depth = s.undo.undoStack.length;
    dragNumber(byTestId(container, 'mod-subsurf-render_levels')!, 30, () =>
      agent.run('object.modifier_remove', { object: cube()!.id, modifier: cube()!.modifiers[0].id }),
    );
    expect(cube()!.modifiers).toEqual([]);
    expect(s.undo.undoStack.length).toBe(depth);
    // the live values' step, undone at the release, changed nothing: no earlier step undone instead
    expect(cube()).not.toBeNull();
  });
});

describe('review regressions', () => {
  it('offers the Material tab for curve and text objects (they have material slots)', () => {
    ok('object.text_add', { name: 'Logo' });
    ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
    ok('object.empty_add', { name: 'Empty' });
    expect(availableTabs(s.doc.findObjectByName('Wire'))).toContain('material');
    expect(availableTabs(s.doc.findObjectByName('Empty'))).not.toContain('material');
    select(s, 'Logo');
    activePropertiesTab.value = 'material';
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'prop-tab-material')).not.toBeNull();
    expect(byTestId(container, 'prop-content-material')).not.toBeNull();
    fireEvent.click(container.querySelector('button[title="Add slot"]')!);
    expect(s.doc.findObjectByName('Logo')!.material_slots).toHaveLength(1);
  });

  it('Add Driver drives the chosen property even when the channel list changed meanwhile', () => {
    ok('mesh.primitive_plane_add', { name: 'Ground' });
    ok('object.particle_system_add', { object: 'Ground' });
    select(s, 'Ground');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const { container } = render(<Properties session={s} />);
    const channel = byTestId(container, 'driver-add-channel') as HTMLSelectElement;
    const count = [...channel.options].find((o) => o.textContent === 'Count (ParticleSystem)')!;
    fireEvent.change(channel, { target: { value: count.value } });
    // a constraint added before the click inserts channels in front of the particle settings
    act(() => {
      ok('object.constraint_add', { object: 'Ground', type: 'LIMIT_LOCATION' });
    });
    fireEvent.click(byTestId(container, 'driver-add')!);
    const ground = s.doc.findObjectByName('Ground')!;
    expect(s.doc.listDrivers(ground.id).map((d) => d.path)).toEqual([
      'particle_systems["ParticleSystem"].count',
    ]);
  });

  it('lists the curves of the object data (Animate Path) with extrapolation and F-modifiers', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    ok('object.constraint_add', { object: 'Cube', type: 'FOLLOW_PATH', target: 'Path' });
    const cube = s.doc.findObjectByName('Cube')!;
    ok('constraint.followpath_path_animate', { object: cube.id, constraint: cube.constraints[0].id });
    select(s, 'Path');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-fcurves', '1');
    const { container } = render(<Properties session={s} />);
    const path = s.doc.findObjectByName('Path')!;
    const key = fcurveKey({ target_type: 'curve', target_id: path.data!, path: 'eval_time', index: 0 });
    const box = byTestId(container, 'fcurve-curve-eval_time-0')!;
    expect(box.textContent).toContain('Evaluation Time');
    fireEvent.change(byTestId(container, 'fcurve-curve-eval_time-0-extrapolation')!, {
      target: { value: 'CYCLIC' },
    });
    expect(s.doc.getFCurve(key)?.extrapolation).toBe('CYCLIC');
    fireEvent.pointerDown(byTestId(container, 'fcurve-curve-eval_time-0-add-modifier')!);
    fireEvent.click(menuItem('Noise')!);
    expect(s.doc.getFCurve(key)?.modifiers?.map((m) => m.type)).toEqual(['NOISE']);
    typeNumber(byTestId(container, 'fcurve-curve-eval_time-0-mod-0-strength')!, '4');
    expect(s.doc.getFCurve(key)?.modifiers?.[0].params.strength).toBe(4);
    fireEvent.click(byTestId(container, 'fcurve-curve-eval_time-0-mod-0-remove')!);
    expect(s.doc.getFCurve(key)?.modifiers ?? []).toEqual([]);
  });

  it('range limits show Min and Max as their own full-width rows', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.constraint_add', { object: 'Cube', type: 'LIMIT_ROTATION' });
    select(s, 'Cube');
    activePropertiesTab.value = 'constraints';
    const { container } = render(<Properties session={s} />);
    for (const [id, label] of [
      ['constraint-Limit Rotation-min_z', 'Min'],
      ['constraint-Limit Rotation-max_z', 'Max'],
    ]) {
      const field = byTestId(container, id)!;
      // no inner label overlapping the value
      expect(field.querySelector('.nf-label')).toBeNull();
      expect(field.closest('.prop-row')?.querySelector(':scope > label')?.textContent).toBe(label);
    }
    expect(
      byTestId(container, 'constraint-Limit Rotation-use_limit_z')!
        .closest('.prop-row')
        ?.querySelector('label')?.textContent,
    ).toBe('Limit Z');
  });
});

describe('text fields of the panels', () => {
  it('show the stored name again when a rename is refused (an empty name)', () => {
    // regression: the name field kept the empty text while the object kept its name
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    const { container } = render(<Properties session={s} />);
    const name = byTestId(container, 'object-name') as HTMLInputElement;
    name.focus();
    fireEvent.input(name, { target: { value: '' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(s.doc.findObjectByName('Cube')).not.toBeNull();
    expect(name.value).toBe('Cube');
    fireEvent.input(name, { target: { value: 'Crate' } });
    fireEvent.blur(name);
    expect(s.doc.findObjectByName('Crate')).not.toBeNull();
    expect(name.value).toBe('Crate');
  });
});

describe('fields taken away while they hold typed text, as others edit what they show', () => {
  // a field commits the text it holds also when it goes away (in Chromium through the change event
  // and blur it sends then): with what it rendered, after an agent or another person changed it
  const browsers = [
    ['Chromium', removalLikeChromium],
    ['Firefox and Safari', () => () => {}],
  ] as const;

  it.each(browsers)(
    '%s: a driver variable an agent removed is not written back, and the agent keeps its other edits',
    async (_browser, removal) => {
      // regression: the typed name was committed with the variables the panel rendered, which brought
      // the removed variable back and undid the agent's change of the other one
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Ctrl' });
      const ctrl = s.doc.findObjectByName('Ctrl')!.id;
      const variable = (name: string, path: string, index: number) => ({
        name,
        target_type: 'object',
        target: ctrl,
        path,
        index,
      });
      ok('anim.driver_add', {
        target_type: 'object',
        target: 'Cube',
        path: 'location',
        index: 2,
        expression: 'a + b',
        variables: [variable('a', 'location', 0), variable('b', 'location', 1)],
      });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      localStorage.setItem('3d-editor:panel:object-drivers', '1');
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const cube = s.doc.findObjectByName('Cube')!.id;
      const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 2 });
      const steps = s.undo.undoStack.length;
      const name = byTestId(container, 'driver-location-2-var-1-name') as HTMLInputElement;
      name.focus();
      fireEvent.input(name, { target: { value: 'zz' } });
      const restore = removal();
      try {
        act(() =>
          agent.run('anim.driver_update', {
            target_type: 'object',
            target: cube,
            path: 'location',
            index: 2,
            expression: 'a * 2',
            variables: [variable('a', 'scale', 0)],
          }),
        );
        expect(byTestId(container, 'driver-location-2-var-1-name')).toBeNull();
        await settle();
      } finally {
        restore();
      }
      const d = s.doc.getDriver(key)!;
      expect(d.expression).toBe('a * 2');
      expect(d.variables.map((v) => `${v.name}:${v.path}[${v.index}]`)).toEqual(['a:scale[0]']);
      expect(s.undo.undoStack.length).toBe(steps);
    },
  );

  it('a variable renamed while an agent edits another one keeps the agent edit', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Ctrl' });
    const ctrl = s.doc.findObjectByName('Ctrl')!.id;
    const variable = (name: string, path: string, index: number) => ({
      name,
      target_type: 'object',
      target: ctrl,
      path,
      index,
    });
    ok('anim.driver_add', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 2,
      // b is not in the expression: renaming a variable the expression uses is refused
      expression: 'a',
      variables: [variable('a', 'location', 0), variable('b', 'location', 1)],
    });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const cube = s.doc.findObjectByName('Cube')!.id;
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 2 });
    const name = byTestId(container, 'driver-location-2-var-1-name') as HTMLInputElement;
    name.focus();
    fireEvent.input(name, { target: { value: 'zz' } });
    act(() =>
      agent.run('anim.driver_update', {
        target_type: 'object',
        target: cube,
        path: 'location',
        index: 2,
        variables: [variable('a', 'scale', 0), variable('b', 'location', 1)],
      }),
    );
    fireEvent.keyDown(name, { key: 'Enter' });
    const d = s.doc.getDriver(key)!;
    expect(d.variables.map((v) => `${v.name}:${v.path}[${v.index}]`)).toEqual([
      'a:scale[0]',
      'zz:location[1]',
    ]);
  });

  it.each(browsers)(
    '%s: a custom property an agent removed is not written back, and the agent keeps its other edits',
    async (_browser, removal) => {
      // regression: the typed value was committed with the properties the panel rendered, which
      // brought the removed property back and undid the agent's change of the other one
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      const cube = s.doc.findObjectByName('Cube')!.id;
      ok('data.set_property', {
        kind: 'objects',
        target: cube,
        values: { custom_props: { k1: 1, k2: 'x' } },
      });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      localStorage.setItem('3d-editor:panel:Custom Properties', '1');
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const steps = s.undo.undoStack.length;
      const field = byTestId(container, 'custom-prop-k2') as HTMLInputElement;
      field.focus();
      fireEvent.input(field, { target: { value: 'typed' } });
      const restore = removal();
      try {
        act(() =>
          agent.run('data.set_property', {
            kind: 'objects',
            target: cube,
            values: { custom_props: { k1: 100 } },
          }),
        );
        expect(byTestId(container, 'custom-prop-k2')).toBeNull();
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.getObject(cube)!.custom_props).toEqual({ k1: 100 });
      expect(s.undo.undoStack.length).toBe(steps);
    },
  );

  it('the project name shows the stored name again when a rename is refused (an empty name)', () => {
    // regression: the Scene tab's name field kept the empty text while the project kept its name
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'scene';
    const { container } = render(<Properties session={s} />);
    const stored = s.doc.name;
    const field = byTestId(container, 'project-name') as HTMLInputElement;
    field.focus();
    fireEvent.input(field, { target: { value: '  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(s.doc.name).toBe(stored);
    expect(field.value).toBe(stored);
    fireEvent.input(field, { target: { value: ' Bridge ' } });
    fireEvent.blur(field);
    expect(s.doc.name).toBe('Bridge');
    expect(field.value).toBe('Bridge');
  });
});

describe('fields that outlive what they were typed for (another object shown, rows that others change)', () => {
  // the commit made as a field goes away comes from the field as it was (in Chromium through the
  // change event and blur it sends then, in all browsers for text fields as their last props)
  const browsers = [
    ['Chromium', removalLikeChromium],
    ['Firefox and Safari', () => () => {}],
  ] as const;
  const errorToasts = () => toasts.value.filter((t) => t.level === 'error').map((t) => t.message);
  /** Presses Enter in the field that has the keyboard focus, as the person would after a change. */
  const enterOnFocused = (root: Element) => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.isConnected && root.contains(el))
      fireEvent.keyDown(el, { key: 'Enter' });
  };
  /** Opens a number field's entry and types into it, without confirming. */
  const typeInEntry = (el: HTMLElement, value: string): HTMLInputElement => {
    fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
    const input = el.querySelector('input')!;
    input.focus();
    fireEvent.input(input, { target: { value } });
    return input;
  };
  beforeEach(() => {
    toasts.value = [];
  });

  /** The name of the object the Properties editor shows. */
  const shownName = (root: ParentNode) => (byTestId(root, 'object-name') as HTMLInputElement | null)?.value;

  it.each(browsers)(
    '%s: a number being typed keeps its object shown when an agent makes another one active, and goes to it',
    async (_browser, removal) => {
      // regression: the tab showed the other object at once: the entry was taken away under the
      // typing (Firefox and Safari lost the number) or, kept for the other object, wrote the number
      // typed for the Cube into it on Enter
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      const { container } = render(<Properties session={s} />);
      const input = typeInEntry(byTestId(container, 'loc-0')!, '-7');
      const restore = removal();
      try {
        act(() => select(s, 'Other'));
        // the typing goes on in the Cube's field
        expect(input.isConnected).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(shownName(container)).toBe('Cube');
        fireEvent.keyDown(input, { key: 'Enter' });
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.findObjectByName('Cube')!.location[0]).toBe(-7);
      expect(s.doc.findObjectByName('Other')!.location).toEqual([3, 0, 0]);
      // the entry is closed: the active object is shown
      expect(shownName(container)).toBe('Other');
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: text typed for one object is committed to it when an agent makes another one with the same value active',
    async (_browser, removal) => {
      // regression: the field was kept for the other object with the typed text (same value, so
      // nothing reset it) and Enter wrote it into the other object's property
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('mesh.primitive_cube_add', { name: 'B' });
      for (const name of ['Cube', 'B'])
        ok('data.set_property', {
          kind: 'objects',
          target: s.doc.findObjectByName(name)!.id,
          values: { custom_props: { weight: 1 } },
        });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      localStorage.setItem('3d-editor:panel:Custom Properties', '1');
      const { container } = render(<Properties session={s} />);
      const field = byTestId(container, 'custom-prop-weight') as HTMLInputElement;
      field.focus();
      fireEvent.input(field, { target: { value: '5' } });
      const restore = removal();
      try {
        act(() => select(s, 'B'));
        expect(field.isConnected).toBe(true);
        expect(shownName(container)).toBe('Cube');
        fireEvent.keyDown(field, { key: 'Enter' });
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.findObjectByName('B')!.custom_props).toEqual({ weight: 1 });
      expect(s.doc.findObjectByName('Cube')!.custom_props).toEqual({ weight: 5 });
      // the field keeps the keyboard focus after Enter, and with it the Cube; leaving it shows B
      expect(shownName(container)).toBe('Cube');
      act(() => field.blur());
      await settle();
      expect(shownName(container)).toBe('B');
      expect((byTestId(container, 'custom-prop-weight') as HTMLInputElement).value).toBe('1');
      expect(errorToasts()).toEqual([]);
    },
  );

  it('going from one text field of the kept object to another keeps it shown', async () => {
    // as in a browser: the focus leaves the first field (focusout names the next one), the page's
    // microtasks run, and only then does the next field get the focus
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Other' });
    ok('data.set_property', {
      kind: 'objects',
      target: s.doc.findObjectByName('Cube')!.id,
      values: { custom_props: { weight: 1 } },
    });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:Custom Properties', '1');
    const { container } = render(<Properties session={s} />);
    const name = byTestId(container, 'object-name') as HTMLInputElement;
    name.focus();
    fireEvent.input(name, { target: { value: 'Box' } });
    act(() => select(s, 'Other'));
    expect(shownName(container)).toBe('Box');
    const weight = byTestId(container, 'custom-prop-weight') as HTMLInputElement;
    // the focus leaves the name field (happy-dom's own blur and focusout name no next field: they
    // are held back, and sent again as a browser sends them, with the page's microtasks between)
    const hold = (e: Event) => e.stopImmediatePropagation();
    container.addEventListener('blur', hold, true);
    container.addEventListener('focusout', hold, true);
    act(() => name.blur());
    container.removeEventListener('blur', hold, true);
    container.removeEventListener('focusout', hold, true);
    act(() => void name.dispatchEvent(new FocusEvent('blur', { relatedTarget: weight })));
    await settle();
    act(() => void name.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: weight })));
    await settle();
    expect(weight.isConnected).toBe(true);
    act(() => weight.focus());
    expect(s.doc.findObjectByName('Box')).not.toBeNull();
    expect(shownName(container)).toBe('Box');
    fireEvent.input(weight, { target: { value: '4' } });
    fireEvent.keyDown(weight, { key: 'Enter' });
    expect(s.doc.findObjectByName('Box')!.custom_props).toEqual({ weight: 4 });
    act(() => weight.blur());
    await settle();
    expect(shownName(container)).toBe('Other');
  });

  it('a field left before the next frame shows the active object', async () => {
    // regression: what notices the focus leaving was set up a frame after the agent's change was
    // drawn; a field left before then (with nothing typed, so nothing committed and drew the panel
    // again) kept the other object shown until something else changed
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Other' });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    const { container } = render(<Properties session={s} />);
    const name = byTestId(container, 'object-name') as HTMLInputElement;
    name.focus();
    // the agent's change is drawn as in the page, with no frame after it yet
    select(s, 'Other');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(shownName(container)).toBe('Cube');
    name.blur();
    await new Promise((r) => setTimeout(r, 200));
    expect(shownName(container)).toBe('Other');
  });

  describe('a panel held for the person working in it while an agent makes another object active', () => {
    /**
     * Moves the focus from one element to another (or to none) in the order browsers use: no element
     * has the focus while the element left gets its change event (when its text changed), then its
     * blur and focusout, which name the next element; the page's microtasks run between them.
     * (happy-dom's own blur and focusout name no next element: they are held back.)
     */
    const moveFocus = async (from: HTMLElement, to: HTMLElement | null, changed: boolean) => {
      const hold = (e: Event) => e.stopImmediatePropagation();
      document.addEventListener('blur', hold, true);
      document.addEventListener('focusout', hold, true);
      act(() => from.blur());
      document.removeEventListener('blur', hold, true);
      document.removeEventListener('focusout', hold, true);
      if (changed) {
        act(() => void from.dispatchEvent(new Event('change', { bubbles: true })));
        await settle();
      }
      act(() => void from.dispatchEvent(new FocusEvent('blur', { relatedTarget: to })));
      await settle();
      act(() => void from.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to })));
      await settle();
      if (to?.isConnected) act(() => to.focus());
    };
    const wait = (ms: number) => act(async () => await new Promise((r) => setTimeout(r, ms)));
    const press = (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
    const release = (el: HTMLElement) => fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
    const box = () => s.doc.findObjectByName('Box');
    const other = () => s.doc.findObjectByName('Other')!;
    /** The Cube's Object tab with "Box" typed into its name, held as an agent makes Other active. */
    function typedThenAgentSelects() {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      ok('data.set_property', {
        kind: 'objects',
        target: s.doc.findObjectByName('Cube')!.id,
        values: { custom_props: { weight: 1 } },
      });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      localStorage.setItem('3d-editor:panel:Custom Properties', '1');
      const { container } = render(<Properties session={s} />);
      const name = byTestId(container, 'object-name') as HTMLInputElement;
      name.focus();
      fireEvent.input(name, { target: { value: 'Box' } });
      act(() => select(s, 'Other'));
      expect(shownName(container)).toBe('Box');
      return { container, name };
    }

    it('going on to another text field of it keeps it, also when the change event comes first', async () => {
      // regression: browsers send the field left its change event while no element has the focus; the
      // rename it commits drew the panel for the active object, which took the next field away (and
      // the keys typed on reached the editor)
      const { container, name } = typedThenAgentSelects();
      const weight = byTestId(container, 'custom-prop-weight') as HTMLInputElement;
      await moveFocus(name, weight, true);
      expect(box()).not.toBeNull();
      expect(weight.isConnected).toBe(true);
      expect(document.activeElement).toBe(weight);
      expect(shownName(container)).toBe('Box');
      fireEvent.input(weight, { target: { value: '4' } });
      fireEvent.keyDown(weight, { key: 'Enter' });
      expect(box()!.custom_props).toEqual({ weight: 4 });
      expect(other().custom_props?.weight).toBeUndefined();
      // the focus leaving the panel shows the active object
      await moveFocus(weight, null, false);
      expect(shownName(container)).toBe('Other');
    });

    it('Tab from a number entry of it to a text field keeps it (the entry closes as the focus leaves it)', async () => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      const { container } = render(<Properties session={s} />);
      const input = typeInEntry(byTestId(container, 'loc-0')!, '-7');
      act(() => select(s, 'Other'));
      const name = byTestId(container, 'object-name') as HTMLInputElement;
      await moveFocus(input, name, false);
      // the entry's blur committed the number and closed the entry
      expect(input.isConnected).toBe(false);
      expect(s.doc.findObjectByName('Cube')!.location).toEqual([-7, 0, 0]);
      expect(name.isConnected).toBe(true);
      expect(document.activeElement).toBe(name);
      fireEvent.input(name, { target: { value: 'Box' } });
      fireEvent.keyDown(name, { key: 'Enter' });
      expect(box()!.location).toEqual([-7, 0, 0]);
      expect(other().location).toEqual([3, 0, 0]);
    });

    it('a click on a checkbox of it sets the held object, and the active object is shown after it', async () => {
      // regression: the press moved the focus out of the text field and the panel was drawn for the
      // active object under the pointer: the click was lost, or went to the other object
      const { container, name } = typedThenAgentSelects();
      const label = () =>
        [...container.querySelectorAll<HTMLElement>('.checkbox')].find((el) =>
          el.textContent?.includes('Show in Viewports'),
        )!;
      // the label takes no focus: none has it after the press
      press(label());
      await moveFocus(name, null, true);
      release(label());
      fireEvent.click(label());
      expect(box()!.hide_viewport).toBe(true);
      expect(other().hide_viewport).toBeFalsy();
      expect(shownName(container)).toBe('Box');
      await wait(PRESS_GRACE_MS + 50);
      expect(shownName(container)).toBe('Other');
    });

    it('a click on a number field of it opens the entry for the held object', async () => {
      const { container, name } = typedThenAgentSelects();
      press(byTestId(container, 'loc-1')!);
      await moveFocus(name, null, true);
      release(byTestId(container, 'loc-1')!);
      const entry = byTestId(container, 'loc-1')!.querySelector('input')!;
      act(() => entry.focus());
      fireEvent.input(entry, { target: { value: '5' } });
      fireEvent.keyDown(entry, { key: 'Enter' });
      await settle();
      expect(box()!.location).toEqual([0, 5, 0]);
      expect(other().location).toEqual([3, 0, 0]);
      // the entry closed: the active object is shown at once
      expect(shownName(container)).toBe('Other');
    });

    it('a button of it that takes the focus keeps it until the focus leaves the panel', async () => {
      const { container, name } = typedThenAgentSelects();
      const key = byTestId(container, 'key-location')!;
      press(key);
      await moveFocus(name, key, true);
      release(key);
      fireEvent.click(key);
      const keyed = (id: string) =>
        !!s.doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 }));
      expect(keyed(box()!.id)).toBe(true);
      expect(keyed(other().id)).toBe(false);
      await wait(PRESS_GRACE_MS + 50);
      expect(shownName(container)).toBe('Box');
      await moveFocus(key, null, false);
      expect(shownName(container)).toBe('Other');
    });

    it('a slider drag an agent makes another object active during ends on its object, as one undo step', async () => {
      // regression: the panel was drawn for the active object under the pointer: the drag stopped
      // with its live value left in the document and no undo step
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      const { container } = render(<Properties session={s} />);
      const depth = s.undo.undoStack.length;
      const field = () => byTestId(container, 'loc-0')!;
      fireEvent.pointerDown(field(), { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(field(), { clientX: 120, pointerId: 1 });
      act(() => select(s, 'Other'));
      fireEvent.pointerMove(field(), { clientX: 140, pointerId: 1 });
      fireEvent.pointerUp(field(), { clientX: 140, pointerId: 1 });
      const cube = () => s.doc.findObjectByName('Cube')!;
      expect(cube().location[0]).toBeCloseTo(0.4);
      expect(other().location).toEqual([3, 0, 0]);
      expect(s.undo.undoStack.length).toBe(depth + 1);
      await wait(PRESS_GRACE_MS + 50);
      expect(shownName(container)).toBe('Other');
      act(() => void s.undo.undo());
      expect(cube().location).toEqual([0, 0, 0]);
    });

    it('a double click on a material preset of it applies the preset to the held material', async () => {
      // regression: the first press moved the focus out of the preset search, and the second click
      // landed on the tab drawn for the active object: the preset was applied to its material
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('mesh.primitive_cube_add', { name: 'B' });
      select(s, 'Cube');
      ok('material.new', { name: 'CubeMat' });
      select(s, 'B');
      ok('material.new', { name: 'BMat' });
      select(s, 'Cube');
      activePropertiesTab.value = 'material';
      localStorage.setItem('3d-editor:panel:material-presets', '1');
      const { container } = render(<Properties session={s} />);
      const search = byTestId(container, 'material-preset-search') as HTMLInputElement;
      search.focus();
      fireEvent.input(search, { target: { value: 'gold' } });
      act(() => select(s, 'B'));
      // Safari and Firefox on macOS give a pressed button no focus
      const tile = () => byTestId(container, 'material-preset-gold')!;
      press(tile());
      await moveFocus(search, null, false);
      release(tile());
      fireEvent.click(tile());
      await wait(150);
      press(tile());
      release(tile());
      fireEvent.click(tile());
      fireEvent.dblClick(tile());
      const metallic = (name: string) => s.doc.listMaterials().find((m) => m.name === name)!.metallic;
      expect(metallic('CubeMat')).toBe(1);
      expect(metallic('BMat')).toBe(0);
    });

    it('the window losing the focus keeps it (the field keeps the focus)', async () => {
      const { container, name } = typedThenAgentSelects();
      act(() => void name.dispatchEvent(new FocusEvent('blur', { relatedTarget: null })));
      act(() => void name.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })));
      await settle();
      expect(document.activeElement).toBe(name);
      expect(name.isConnected).toBe(true);
      expect(shownName(container)).toBe('Box');
    });

    it('the window losing the focus while a button of it has the focus keeps it', async () => {
      // no typing holds the object then, only the focus staying in the panel (the window gives it
      // back to the button)
      const { container, name } = typedThenAgentSelects();
      const key = byTestId(container, 'key-location')!;
      await moveFocus(name, key, true);
      expect(document.activeElement).toBe(key);
      expect(shownName(container)).toBe('Box');
      act(() => void key.dispatchEvent(new FocusEvent('blur', { relatedTarget: null })));
      act(() => void key.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })));
      await settle();
      expect(document.activeElement).toBe(key);
      expect(shownName(container)).toBe('Box');
      // the focus leaving the panel shows the active object
      await moveFocus(key, null, false);
      expect(shownName(container)).toBe('Other');
    });

    it('the focus going on outside the panel shows the active object', async () => {
      const { container, name } = typedThenAgentSelects();
      const outside = document.body.appendChild(document.createElement('button'));
      try {
        await moveFocus(name, outside, true);
        expect(box()).not.toBeNull();
        expect(shownName(container)).toBe('Other');
      } finally {
        outside.remove();
      }
    });

    it('a press released outside the window ends as the window loses the focus', async () => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      const { container } = render(<Properties session={s} />);
      // a press where nothing takes the focus, released outside the window: no release reaches the page
      press(container.querySelector<HTMLElement>('.prop-context')!);
      act(() => select(s, 'Other'));
      expect(shownName(container)).toBe('Cube');
      act(() => void window.dispatchEvent(new Event('blur')));
      await wait(PRESS_GRACE_MS + 50);
      expect(shownName(container)).toBe('Other');
    });

    it('a button of it that keeps the focus after its click does not hold it', async () => {
      // the focus on a button or checkbox is no typing: once the press is over, the panel follows the
      // object an agent makes active
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      const { container } = render(<Properties session={s} />);
      const key = byTestId(container, 'key-location')!;
      press(key);
      act(() => key.focus());
      release(key);
      fireEvent.click(key);
      await wait(PRESS_GRACE_MS + 50);
      expect(document.activeElement).toBe(key);
      act(() => select(s, 'Other'));
      expect(shownName(container)).toBe('Other');
    });
  });

  it.each(browsers)(
    '%s: typing for an object an agent deletes shows the active object, writes nothing and shows no error',
    async (_browser, removal) => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      activePropertiesTab.value = 'object';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const input = typeInEntry(byTestId(container, 'loc-0')!, '-7');
      act(() => select(s, 'Other'));
      expect(shownName(container)).toBe('Cube');
      const restore = removal();
      try {
        act(() => agent.run('object.delete', { objects: [s.doc.findObjectByName('Cube')!.id] }));
        expect(input.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(shownName(container)).toBe('Other');
      expect(s.doc.findObjectByName('Other')!.location).toEqual([3, 0, 0]);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('the material preset search is kept when another object is shown', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('mesh.primitive_cube_add', { name: 'B' });
    select(s, 'Cube');
    activePropertiesTab.value = 'material';
    localStorage.setItem('3d-editor:panel:material-presets', '1');
    const { container } = render(<Properties session={s} />);
    const shown = () => container.querySelectorAll('[data-testid="material-presets"] [role="option"]').length;
    const all = shown();
    const search = byTestId(container, 'material-preset-search') as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'gold' } });
    const found = shown();
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThan(all);
    expect(byTestId(container, 'material-preset-gold')).not.toBeNull();
    act(() => select(s, 'B'));
    expect((byTestId(container, 'material-preset-search') as HTMLInputElement).value).toBe('gold');
    expect(shown()).toBe(found);
    fireEvent.input(byTestId(container, 'material-preset-search')!, { target: { value: '' } });
    expect(shown()).toBe(all);
  });

  /** Cube with a driver on location[2] reading Ctrl's location (variables a, b, …). */
  function driven(expression: string, names: string[]) {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Ctrl' });
    const ctrl = s.doc.findObjectByName('Ctrl')!.id;
    const variable = (name: string, path: string, index: number) => ({
      name,
      target_type: 'object',
      target: ctrl,
      path,
      index,
    });
    ok('anim.driver_add', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 2,
      expression,
      variables: names.map((n, i) => variable(n, 'location', i)),
    });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const cube = s.doc.findObjectByName('Cube')!.id;
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 2 });
    const ref = { target_type: 'object', target: cube, path: 'location', index: 2 };
    const listed = () => s.doc.getDriver(key)!.variables.map((v) => `${v.name}:${v.path}[${v.index}]`);
    return { cube, key, ref, variable, listed };
  }

  it.each(browsers)(
    '%s: text typed for a driver variable never goes to the variable an agent moved into its row',
    async (_browser, removal) => {
      // regression: rows were keyed by position: after the agent removed the variable, its row
      // showed the next one with the typed path (the same 'location' before), and Enter wrote it there
      const d = driven('a + b', ['a', 'b']);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const path = byTestId(container, 'driver-location-2-var-0-path') as HTMLInputElement;
      path.focus();
      fireEvent.input(path, { target: { value: 'scale' } });
      const restore = removal();
      try {
        act(() =>
          agent.run('anim.driver_update', {
            ...d.ref,
            expression: 'b',
            variables: [d.variable('b', 'location', 1)],
          }),
        );
        expect(path.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(d.listed()).toEqual(['b:location[1]']);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('a driver variable row stays with its variable when an agent adds one before it', () => {
    // regression: the row kept its position and the typed path went to the agent's new variable
    const d = driven('a + b', ['a', 'b']);
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const path = byTestId(container, 'driver-location-2-var-0-path') as HTMLInputElement;
    path.focus();
    fireEvent.input(path, { target: { value: 'scale' } });
    act(() =>
      agent.run('anim.driver_update', {
        ...d.ref,
        expression: 'a + b + c',
        variables: [
          d.variable('c', 'location', 2),
          d.variable('a', 'location', 0),
          d.variable('b', 'location', 1),
        ],
      }),
    );
    expect(path.isConnected).toBe(true);
    expect(path.value).toBe('scale');
    fireEvent.keyDown(path, { key: 'Enter' });
    expect(d.listed()).toEqual(['c:location[2]', 'a:scale[0]', 'b:location[1]']);
  });

  it('renaming a driver variable keeps its row and the keyboard focus', () => {
    const d = driven('a', ['a', 'b']);
    const { container } = render(<Properties session={s} />);
    const name = byTestId(container, 'driver-location-2-var-1-name') as HTMLInputElement;
    name.focus();
    fireEvent.input(name, { target: { value: 'zz' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(d.listed()).toEqual(['a:location[0]', 'zz:location[1]']);
    expect(byTestId(container, 'driver-location-2-var-1-name')).toBe(name);
    expect(document.activeElement).toBe(name);
  });

  it.each(browsers)(
    '%s: a driver expression typed when an agent removes the driver is dropped without an error',
    async (_browser, removal) => {
      // regression: Chromium committed it through the removed driver: "No driver on 'location' …"
      const d = driven('a', ['a']);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const field = byTestId(container, 'driver-location-2-expression') as HTMLInputElement;
      field.focus();
      fireEvent.input(field, { target: { value: 'a * 3' } });
      const restore = removal();
      try {
        act(() => agent.run('anim.driver_remove', d.ref));
        expect(field.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.getDriver(d.key)).toBeNull();
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: a driver expression being typed keeps its object shown when another one is made active',
    async (_browser, removal) => {
      // regression: the tab showed the other object at once; only Chromium committed the expression
      // (through its blur as the field went away), Firefox and Safari lost it
      const d = driven('a', ['a']);
      const { container } = render(<Properties session={s} />);
      const field = byTestId(container, 'driver-location-2-expression') as HTMLInputElement;
      field.focus();
      fireEvent.input(field, { target: { value: 'a * 3' } });
      const restore = removal();
      try {
        act(() => select(s, 'Ctrl'));
        expect(field.isConnected).toBe(true);
        expect(shownName(container)).toBe('Cube');
        act(() => field.blur());
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.getDriver(d.key)!.expression).toBe('a * 3');
      expect(shownName(container)).toBe('Ctrl');
      expect(errorToasts()).toEqual([]);
    },
  );

  it('a driver expression left in a field that goes away is committed to its driver', async () => {
    // Firefox and Safari send no blur to a field they take away: the text is committed as it goes
    const d = driven('a', ['a']);
    const { container, unmount } = render(<Properties session={s} />);
    const field = byTestId(container, 'driver-location-2-expression') as HTMLInputElement;
    field.focus();
    fireEvent.input(field, { target: { value: 'a * 4' } });
    unmount();
    await settle();
    expect(s.doc.getDriver(d.key)!.expression).toBe('a * 4');
    expect(errorToasts()).toEqual([]);
  });

  /** Cube's location[0] curve with F-curve modifiers; `ref` addresses it in anim.fmodifier_*. */
  function curveWith(modifiers: { type: string; params?: Record<string, unknown> }[]) {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const cube = s.doc.findObjectByName('Cube')!.id;
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 0,
    });
    const ref = { target_type: 'object', target: cube, path: 'location', index: 0 };
    for (const m of modifiers) ok('anim.fmodifier_add', { ...ref, ...m });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-fcurves', '1');
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
    const mods = () => s.doc.getFCurve(key)!.modifiers ?? [];
    return { cube, ref, mods };
  }
  const envelope = (points: [number, number, number][]) => ({
    control_points: points.map(([frame, min, max]) => ({ frame, min, max })),
  });

  it.each(browsers)(
    '%s: a control point an agent removed is not written back from its open entry',
    async (_browser, removal) => {
      // regression: Chromium's blur committed the panel's list as rendered: the removed point came
      // back (and with it the old values of the others)
      const c = curveWith([
        {
          type: 'ENVELOPE',
          params: envelope([
            [1, -1, 1],
            [10, -2, 2],
          ]),
        },
      ]);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const input = typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-1-min')!, '-5');
      const restore = removal();
      try {
        act(() =>
          agent.run('anim.fmodifier_update', {
            ...c.ref,
            modifier_index: 0,
            params: envelope([[1, -0.5, 0.5]]),
          }),
        );
        expect(input.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(c.mods()[0].params.control_points).toEqual(envelope([[1, -0.5, 0.5]]).control_points);
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: a value typed for a control point never goes to the point an agent moved into its row',
    async (_browser, removal) => {
      // regression: rows were keyed by position: the open entry of the first row was given the next
      // point, and Enter wrote the frame typed for the removed point into it
      const c = curveWith([
        {
          type: 'ENVELOPE',
          params: envelope([
            [1, -1, 1],
            [10, -2, 2],
          ]),
        },
      ]);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-0-frame')!, '20');
      const restore = removal();
      try {
        act(() =>
          agent.run('anim.fmodifier_update', {
            ...c.ref,
            modifier_index: 0,
            params: envelope([[10, -2, 2]]),
          }),
        );
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(c.mods()[0].params.control_points).toEqual(envelope([[10, -2, 2]]).control_points);
    },
  );

  it('a control point edit goes to the point as it is now, keeping what an agent changed in the others', () => {
    const c = curveWith([
      {
        type: 'ENVELOPE',
        params: envelope([
          [1, -1, 1],
          [10, -2, 2],
        ]),
      },
    ]);
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const input = typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-1-min')!, '-5');
    act(() =>
      agent.run('anim.fmodifier_update', {
        ...c.ref,
        modifier_index: 0,
        params: envelope([
          [0, -3, 3],
          [1, -0.5, 0.5],
          [10, -2, 4],
        ]),
      }),
    );
    // the entry stays open on its point (now the third row)
    expect(input.isConnected).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(c.mods()[0].params.control_points).toEqual(
      envelope([
        [0, -3, 3],
        [1, -0.5, 0.5],
        [10, -5, 4],
      ]).control_points,
    );
    // removing and adding points work on the points as they are now too
    act(() =>
      agent.run('anim.fmodifier_update', {
        ...c.ref,
        modifier_index: 0,
        params: envelope([
          [0, -3, 3],
          [10, -5, 4],
        ]),
      }),
    );
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-point-0-remove')!);
    expect(c.mods()[0].params.control_points).toEqual(envelope([[10, -5, 4]]).control_points);
  });

  it.each(browsers)(
    '%s: coefficients typed for a modifier an agent removed never go to the modifier moved into its place',
    async (_browser, removal) => {
      // regression: modifier boxes were keyed by position: the box showed the next modifier (with the
      // same coefficients, so the typed text stayed) and Enter wrote the text into it
      // the same coefficients (the typed text stayed in the reused field); modifiers that are the
      // same in every way cannot be told apart, and either being removed leaves the same stack
      const c = curveWith([
        { type: 'GENERATOR', params: { coefficients: [0, 1] } },
        { type: 'GENERATOR', params: { coefficients: [0, 1], use_additive: true } },
      ]);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const field = byTestId(container, 'fcurve-location-0-mod-0-coefficients') as HTMLInputElement;
      field.focus();
      fireEvent.input(field, { target: { value: '5, 6' } });
      const restore = removal();
      try {
        act(() => agent.run('anim.fmodifier_remove', { ...c.ref, modifier_index: 0 }));
        expect(field.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(c.mods().map((m) => [m.params.coefficients, m.params.use_additive])).toEqual([[[0, 1], true]]);
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: an envelope edit of a modifier an agent removed changes no other modifier',
    async (_browser, removal) => {
      // regression: Chromium's blur wrote the removed modifier's points into the modifier that moved
      // to its index
      const c = curveWith([
        {
          type: 'ENVELOPE',
          params: envelope([
            [1, -1, 1],
            [10, -2, 2],
          ]),
        },
        { type: 'ENVELOPE', params: envelope([[5, -3, 3]]) },
      ]);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-1-min')!, '-5');
      const restore = removal();
      try {
        act(() => agent.run('anim.fmodifier_remove', { ...c.ref, modifier_index: 0 }));
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(c.mods().map((m) => m.params.control_points)).toEqual([envelope([[5, -3, 3]]).control_points]);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('an envelope edit goes to its modifier where it is now, after an agent removed one before it', () => {
    const c = curveWith([
      { type: 'ENVELOPE', params: envelope([[1, -1, 1]]) },
      { type: 'ENVELOPE', params: envelope([[5, -3, 3]]) },
    ]);
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    const input = typeInEntry(byTestId(container, 'fcurve-location-0-mod-1-point-0-min')!, '-7');
    act(() => agent.run('anim.fmodifier_remove', { ...c.ref, modifier_index: 0 }));
    expect(input.isConnected).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(c.mods().map((m) => m.params.control_points)).toEqual([envelope([[5, -7, 3]]).control_points]);
  });

  it.each(browsers)(
    '%s: names typed for what an agent then deleted are dropped without an error',
    async (_browser, removal) => {
      // regression: the commit as the field went away renamed the deleted object, constraint, vertex
      // group, particle system, shape key or bone, and failed with an error naming an internal id
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other' });
      const cube = s.doc.findObjectByName('Cube')!.id;
      ok('object.constraint_add', { object: 'Cube', type: 'COPY_LOCATION', target: 'Other' });
      ok('object.vertex_group_add', { object: 'Cube', name: 'Group' });
      ok('object.particle_system_add', { object: 'Cube' });
      const agent = peerReplica(s);
      const cases: [string, string, string, () => void][] = [
        [
          'constraints',
          'constraint-Copy Location-name',
          'Grab',
          () => {
            const c = s.doc.getObject(cube)!.constraints[0];
            agent.run('constraint.delete', { object: cube, constraint: c.id });
          },
        ],
        [
          'particles',
          'psys-ParticleSystem-name',
          'Pebbles',
          () => {
            const ps = s.doc.getObject(cube)!.particle_systems[0];
            agent.run('object.particle_system_remove', { object: cube, particle_system: ps.id });
          },
        ],
        [
          'data',
          'vgroup-name',
          'Arm',
          () => agent.run('object.vertex_group_remove', { object: cube, group: 'Group' }),
        ],
        ['object', 'object-name', 'Typed', () => agent.run('object.delete', { objects: [cube] })],
      ];
      select(s, 'Cube');
      for (const [tab, testId, text, remove] of cases) {
        activePropertiesTab.value = tab as typeof activePropertiesTab.value;
        const { container, unmount } = render(<Properties session={s} />);
        const field = byTestId(container, testId) as HTMLInputElement;
        expect(field, testId).not.toBeNull();
        field.focus();
        fireEvent.input(field, { target: { value: text } });
        const restore = removal();
        try {
          act(remove);
          expect(field.isConnected, testId).toBe(false);
          await settle();
        } finally {
          restore();
        }
        expect(errorToasts(), testId).toEqual([]);
        unmount();
      }
    },
  );

  it.each(browsers)(
    '%s: a shape key or bone name typed when an agent removes it is dropped without an error',
    async (_browser, removal) => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      const cube = s.doc.findObjectByName('Cube')!.id;
      ok('object.shape_key_add', { object: 'Cube', name: 'Basis' });
      ok('object.shape_key_add', { object: 'Cube', name: 'Key 1' });
      ok('object.armature_add', { name: 'Rig' });
      const rig = s.doc.findObjectByName('Rig')!.id;
      const agent = peerReplica(s);
      activePropertiesTab.value = 'data';
      select(s, 'Cube');
      const first = render(<Properties session={s} />);
      fireEvent.click(byTestId(first.container, 'shape-key-Key 1')!);
      const key = byTestId(first.container, 'shape-key-name') as HTMLInputElement;
      key.focus();
      fireEvent.input(key, { target: { value: 'Smile' } });
      let restore = removal();
      try {
        act(() => agent.run('object.shape_key_remove', { object: cube, all: true }));
        await settle();
      } finally {
        restore();
      }
      expect(errorToasts()).toEqual([]);
      first.unmount();
      select(s, 'Rig');
      const second = render(<Properties session={s} />);
      const bone = byTestId(second.container, 'bone-name') as HTMLInputElement;
      bone.focus();
      fireEvent.input(bone, { target: { value: 'Spine' } });
      restore = removal();
      try {
        act(() => agent.run('object.delete', { objects: [rig] }));
        await settle();
      } finally {
        restore();
      }
      expect(errorToasts()).toEqual([]);
    },
  );

  it('renaming a bone keeps its fields and the keyboard focus (Enter and Tab)', () => {
    // regression: the bone's fields were keyed by its name: a rename rebuilt them and the focus went
    // to the page
    ok('object.armature_add', { name: 'Rig' });
    select(s, 'Rig');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const field = byTestId(container, 'bone-name') as HTMLInputElement;
    field.focus();
    fireEvent.input(field, { target: { value: 'Spine' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    const rig = s.doc.findObjectByName('Rig')!;
    expect(s.doc.getArmature(rig.data!)!.bones.map((b) => b.name)).toEqual(['Spine']);
    expect(byTestId(container, 'bone-name')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Spine');
    // another bone gets its own fields
    fireEvent.click(byTestId(container, 'bone-add')!);
    expect(byTestId(container, 'bone-name')).not.toBe(field);
  });
});

describe('settings typed for what an agent then removes or replaces (no error, nothing written elsewhere)', () => {
  const browsers = [
    ['Chromium', removalLikeChromium],
    ['Firefox and Safari', () => () => {}],
  ] as const;
  const errorToasts = () => toasts.value.filter((t) => t.level === 'error').map((t) => t.message);
  const enterOnFocused = (root: Element) => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.isConnected && root.contains(el))
      fireEvent.keyDown(el, { key: 'Enter' });
  };
  const typeInEntry = (el: HTMLElement, value: string): HTMLInputElement => {
    fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
    const input = el.querySelector('input')!;
    input.focus();
    fireEvent.input(input, { target: { value } });
    return input;
  };
  beforeEach(() => {
    toasts.value = [];
  });

  /** A field of a tab typed into, the agent's removal, and what the document must then hold. */
  interface Case {
    name: string;
    tab: string;
    setup: () => void;
    field: string;
    /** A text field (committed as it goes away in every browser), not a number entry. */
    text?: boolean;
    /** What the person does in the tab before typing (choosing the row whose field is typed). */
    prepare?: (container: HTMLElement) => void;
    remove: (agent: ReturnType<typeof peerReplica>) => void;
    check: () => void;
  }
  const cube = () => s.doc.findObjectByName('Cube')!;
  const rig = () => s.doc.findObjectByName('Rig')!;
  const wire = () => s.doc.findObjectByName('Wire')!;
  /** A linked duplicate of the object (sharing its data, which outlives the object), the object shown. */
  const linkedDuplicate = (name: string) => {
    select(s, name);
    ok('object.duplicate', { linked: true });
    select(s, name);
  };
  /** The data of the object left, the linked duplicate. */
  const keptData = () => s.doc.listObjects()[0].data!;
  /** The stored resolution of the first spline of the curve object left (of a CURVE type). */
  const resolution = () => {
    const curve = s.doc.listObjects().find((o) => o.type === 'CURVE')!;
    return s.doc.getCurve(curve.data!)!.splines[0].resolution_u;
  };
  let resolutionBefore: number | undefined;
  const deleteShown = (name: string) => (agent: ReturnType<typeof peerReplica>) =>
    agent.run('object.delete', { objects: [s.doc.findObjectByName(name)!.id] });
  const cases: Case[] = [
    {
      name: 'a modifier setting',
      tab: 'modifiers',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        ok('object.modifier_add', { object: 'Cube', type: 'SUBSURF' });
        select(s, 'Cube');
      },
      field: 'mod-subsurf-levels',
      remove: (agent) =>
        agent.run('object.modifier_remove', { object: cube().id, modifier: cube().modifiers[0].id }),
      check: () => expect(cube().modifiers).toEqual([]),
    },
    {
      name: 'a material setting',
      tab: 'material',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        select(s, 'Cube');
        ok('material.new', { name: 'Mat' });
      },
      field: 'material-roughness',
      remove: (agent) => agent.run('material.delete', { material: 'Mat' }),
      check: () => expect(s.doc.listMaterials().map((m) => m.name)).toEqual([]),
    },
    {
      name: 'a procedural texture setting',
      tab: 'material',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        select(s, 'Cube');
        ok('material.new', { name: 'Mat' });
        ok('material.procedural_set', {
          material: 'Mat',
          channel: 'base_color',
          procedural: { type: 'NOISE' },
        });
        localStorage.setItem('3d-editor:panel:material-textures', '1');
      },
      field: 'tex-base_color-ramp-low',
      remove: (agent) =>
        agent.run('material.procedural_set', { material: 'Mat', channel: 'base_color', procedural: null }),
      // no texture is made for the one field typed
      check: () => expect(s.doc.listMaterials()[0].textures?.base_color?.procedural ?? null).toBeNull(),
    },
    {
      name: 'a pose bone channel',
      tab: 'data',
      setup: () => {
        ok('object.armature_add', { name: 'Rig' });
        select(s, 'Rig');
      },
      field: 'pose-location-0',
      remove: (agent) => agent.run('armature.bone_remove', { object: rig().id, bones: ['Bone'] }),
      check: () => expect(rig().pose?.bones?.Bone).toBeUndefined(),
    },
    {
      name: 'a bone IK setting',
      tab: 'data',
      setup: () => {
        ok('object.armature_add', { name: 'Rig' });
        select(s, 'Rig');
        localStorage.setItem('3d-editor:panel:bone-ik', '1');
      },
      field: 'pose-ik-stiffness-x',
      remove: (agent) => agent.run('armature.bone_remove', { object: rig().id, bones: ['Bone'] }),
      check: () => expect(rig().pose?.bones?.Bone).toBeUndefined(),
    },
    {
      name: 'a bone constraint influence',
      tab: 'data',
      setup: () => {
        ok('object.armature_add', { name: 'Rig' });
        ok('pose.constraint_add', { object: 'Rig', bone: 'Bone', type: 'LIMIT_ROTATION' });
        select(s, 'Rig');
      },
      field: 'bone-constraint-Limit Rotation-influence',
      remove: (agent) => agent.run('pose.constraint_remove', { object: rig().id, bone: 'Bone', all: true }),
      check: () => expect(rig().pose.bones.Bone.constraints ?? []).toEqual([]),
    },
    {
      name: 'a light setting',
      tab: 'data',
      setup: () => {
        ok('object.light_add', { name: 'Lamp', type: 'POINT' });
        select(s, 'Lamp');
      },
      field: 'light-energy',
      remove: (agent) => agent.run('object.delete', { objects: [s.doc.findObjectByName('Lamp')!.id] }),
      check: () => expect(s.doc.listObjects()).toEqual([]),
    },
    {
      name: 'a modifier text setting',
      tab: 'modifiers',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        ok('object.modifier_add', { object: 'Cube', type: 'ARMATURE' });
        select(s, 'Cube');
      },
      field: 'mod-armature-vertex_group',
      text: true,
      remove: (agent) =>
        agent.run('object.modifier_remove', { object: cube().id, modifier: cube().modifiers[0].id }),
      check: () => expect(cube().modifiers).toEqual([]),
    },
    {
      name: 'a rigid body setting',
      tab: 'physics',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        ok('rigidbody.object_add', { objects: ['Cube'] });
        select(s, 'Cube');
      },
      field: 'rigidbody-mass',
      remove: (agent) => agent.run('rigidbody.object_remove', { objects: [cube().id] }),
      check: () => expect(cube().rigid_body ?? null).toBeNull(),
    },
    // the object an agent deletes, its data kept by a linked duplicate: the operators are addressed
    // by the object, so the commit as the field goes away has nothing to change
    {
      name: 'a shape key value of a mesh a linked duplicate keeps',
      tab: 'data',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        for (const name of ['Basis', 'Smile']) ok('object.shape_key_add', { object: 'Cube', name });
        linkedDuplicate('Cube');
      },
      prepare: (c) => fireEvent.click(byTestId(c, 'shape-key-Smile')!),
      field: 'shape-key-value',
      remove: deleteShown('Cube'),
      check: () =>
        expect(s.doc.getShapeKeys(keptData()).map((k) => [k.name, k.value])).toEqual([
          ['Basis', 0],
          ['Smile', 0],
        ]),
    },
    {
      name: 'a shape key name of a mesh a linked duplicate keeps',
      tab: 'data',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        for (const name of ['Basis', 'Smile']) ok('object.shape_key_add', { object: 'Cube', name });
        linkedDuplicate('Cube');
      },
      prepare: (c) => fireEvent.click(byTestId(c, 'shape-key-Smile')!),
      field: 'shape-key-name',
      text: true,
      remove: deleteShown('Cube'),
      check: () => expect(s.doc.getShapeKeys(keptData()).map((k) => k.name)).toEqual(['Basis', 'Smile']),
    },
    {
      name: 'a vertex group name of a mesh a linked duplicate keeps',
      tab: 'data',
      setup: () => {
        ok('mesh.primitive_cube_add', { name: 'Cube' });
        ok('object.vertex_group_add', { object: 'Cube', name: 'Group' });
        linkedDuplicate('Cube');
      },
      field: 'vgroup-name',
      text: true,
      remove: deleteShown('Cube'),
      check: () => expect(s.doc.getVertexGroups(keptData()).map((g) => g.name)).toEqual(['Group']),
    },
    {
      name: 'a spline resolution of a curve a linked duplicate keeps',
      tab: 'data',
      setup: () => {
        ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
        linkedDuplicate('Wire');
        resolutionBefore = resolution();
      },
      field: 'spline-resolution',
      remove: deleteShown('Wire'),
      check: () => expect(resolution()).toBe(resolutionBefore),
    },
    {
      name: 'a bone name of an armature a linked duplicate keeps',
      tab: 'data',
      setup: () => {
        ok('object.armature_add', { name: 'Rig' });
        linkedDuplicate('Rig');
      },
      field: 'bone-name',
      text: true,
      remove: deleteShown('Rig'),
      check: () => expect(s.doc.getArmature(keptData())!.bones.map((b) => b.name)).toEqual(['Bone']),
    },
    {
      name: 'a spline resolution of a curve (kept by a linked duplicate) an agent converts to a mesh',
      tab: 'data',
      setup: () => {
        ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
        linkedDuplicate('Wire');
        resolutionBefore = resolution();
      },
      field: 'spline-resolution',
      remove: (agent) => {
        agent.state.selectedIds = [wire().id];
        agent.state.activeId = wire().id;
        agent.run('object.convert', { target: 'MESH' });
      },
      check: () => {
        expect(wire().type).toBe('MESH');
        expect(resolution()).toBe(resolutionBefore);
      },
    },
    {
      name: 'a curve setting of a curve object an agent deletes',
      tab: 'data',
      setup: () => {
        ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
        select(s, 'Wire');
      },
      field: 'curve-extrude',
      remove: deleteShown('Wire'),
      check: () => expect(s.doc.listObjects()).toEqual([]),
    },
    {
      name: 'a text setting of a text object an agent deletes',
      tab: 'data',
      setup: () => {
        ok('object.text_add', { body: 'Hello', name: 'Title' });
        select(s, 'Title');
      },
      field: 'font-size',
      remove: deleteShown('Title'),
      check: () => expect(s.doc.listObjects()).toEqual([]),
    },
  ];

  for (const [browser, removal] of browsers)
    it.each(cases.map((c) => [c.name, c] as const))(`${browser}: %s`, async (_name, c) => {
      c.setup();
      activePropertiesTab.value = c.tab as typeof activePropertiesTab.value;
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      c.prepare?.(container as HTMLElement);
      const el = byTestId(container, c.field);
      expect(el, c.field).not.toBeNull();
      let input: HTMLInputElement;
      if (c.text) {
        input = el as HTMLInputElement;
        input.focus();
        fireEvent.input(input, { target: { value: 'Typed' } });
      } else input = typeInEntry(el!, '0.5');
      const restore = removal();
      try {
        act(() => c.remove(agent));
        expect(input.isConnected, c.field).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      c.check();
      expect(errorToasts()).toEqual([]);
    });
});

describe('fields that follow what they edit (agents switch objects, replace, remove or reassign it)', () => {
  const browsers = [
    ['Chromium', removalLikeChromium],
    ['Firefox and Safari', () => () => {}],
  ] as const;
  const errorToasts = () => toasts.value.filter((t) => t.level === 'error').map((t) => t.message);
  const enterOnFocused = (root: Element) => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.isConnected && root.contains(el))
      fireEvent.keyDown(el, { key: 'Enter' });
  };
  const typeInEntry = (el: HTMLElement, value: string): HTMLInputElement => {
    fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
    fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
    const input = el.querySelector('input')!;
    input.focus();
    fireEvent.input(input, { target: { value } });
    return input;
  };
  beforeEach(() => {
    toasts.value = [];
  });
  const isChromium = (removal: unknown) => removal === removalLikeChromium;

  it.each(browsers)(
    '%s: a location typed in the N panel keeps its object shown when an agent makes another one active',
    async (_browser, removal) => {
      // regression: the panel showed the other object at once (Firefox and Safari lost the typing,
      // a kept entry wrote it into the other object)
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      ok('object.empty_add', { name: 'Other', location: [3, 0, 0] });
      select(s, 'Cube');
      const { container } = render(<Sidebar s={s} />);
      const input = typeInEntry(byTestId(container, 'loc-0')!, '-7');
      const restore = removal();
      try {
        act(() => select(s, 'Other'));
        expect(input.isConnected).toBe(true);
        expect(document.activeElement).toBe(input);
        fireEvent.keyDown(input, { key: 'Enter' });
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.findObjectByName('Cube')!.location[0]).toBe(-7);
      expect(s.doc.findObjectByName('Other')!.location).toEqual([3, 0, 0]);
      // the entry is closed: the active object is shown
      expect(byTestId(container, 'loc-0')!.textContent).toContain('3');
      expect(errorToasts()).toEqual([]);
    },
  );

  /** Cube with a driver on location[2] reading Ctrl's location (variables named as given). */
  function driven(names: string[]) {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Ctrl' });
    const ctrl = s.doc.findObjectByName('Ctrl')!.id;
    const variable = (name: string, path: string, index: number) => ({
      name,
      target_type: 'object',
      target: ctrl,
      path,
      index,
    });
    ok('anim.driver_add', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 2,
      expression: names.join(' + '),
      variables: names.map((n, i) => variable(n, 'location', i)),
    });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const cube = s.doc.findObjectByName('Cube')!.id;
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 2 });
    const ref = { target_type: 'object', target: cube, path: 'location', index: 2 };
    const listed = () => s.doc.getDriver(key)!.variables.map((v) => `${v.name}:${v.path}[${v.index}]`);
    return { ref, variable, listed };
  }

  it.each(browsers)(
    '%s: text typed for a driver variable an agent replaced by another one goes to neither',
    async (_browser, removal) => {
      // regression: the new variable took the replaced one's row (as many before as after) with the
      // typed path, and Enter wrote it into the new variable
      const d = driven(['a']);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const path = byTestId(container, 'driver-location-2-var-0-path') as HTMLInputElement;
      path.focus();
      fireEvent.input(path, { target: { value: 'scale' } });
      const restore = removal();
      try {
        act(() =>
          agent.run('anim.driver_update', {
            ...d.ref,
            expression: 'c',
            variables: [d.variable('c', 'location', 2)],
          }),
        );
        expect(path.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(d.listed()).toEqual(['c:location[2]']);
      expect(errorToasts()).toEqual([]);
    },
  );

  /** Cube's location[0] curve with F-curve modifiers. */
  function curveWith(modifiers: { type: string; params?: Record<string, unknown> }[]) {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const cube = s.doc.findObjectByName('Cube')!.id;
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Cube',
      path: 'location',
      index: 0,
    });
    const ref = { target_type: 'object', target: cube, path: 'location', index: 0 };
    for (const m of modifiers) ok('anim.fmodifier_add', { ...ref, ...m });
    select(s, 'Cube');
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-fcurves', '1');
    const key = fcurveKey({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
    const mods = () => s.doc.getFCurve(key)!.modifiers ?? [];
    return { ref, key, mods };
  }
  const envelope = (points: [number, number, number][]) => ({
    control_points: points.map(([frame, min, max]) => ({ frame, min, max })),
  });

  it.each(browsers)(
    '%s: a value typed for a control point an agent replaced by another one goes to neither',
    async (_browser, removal) => {
      const c = curveWith([{ type: 'ENVELOPE', params: envelope([[1, -1, 1]]) }]);
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const input = typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-0-min')!, '-5');
      const restore = removal();
      try {
        act(() =>
          agent.run('anim.fmodifier_update', { ...c.ref, modifier_index: 0, params: envelope([[5, -2, 2]]) }),
        );
        expect(input.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(c.mods()[0].params.control_points).toEqual(envelope([[5, -2, 2]]).control_points);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('a frame typed for a control point keeps its row and the keyboard focus', () => {
    const c = curveWith([{ type: 'ENVELOPE', params: envelope([[1, -1, 1]]) }]);
    const { container } = render(<Properties session={s} />);
    const input = typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-0-min')!, '-3');
    fireEvent.keyDown(input, { key: 'Enter' });
    const minField = byTestId(container, 'fcurve-location-0-mod-0-point-0-min');
    const frame = typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-0-frame')!, '4');
    fireEvent.keyDown(frame, { key: 'Enter' });
    expect(c.mods()[0].params.control_points).toEqual(envelope([[4, -3, 1]]).control_points);
    // the row (with the min field) is the same
    expect(byTestId(container, 'fcurve-location-0-mod-0-point-0-min')).toBe(minField);
    const again = typeInEntry(byTestId(container, 'fcurve-location-0-mod-0-point-0-max')!, '6');
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(c.mods()[0].params.control_points).toEqual(envelope([[4, -3, 6]]).control_points);
  });

  it('Add Control Point on a frame that has a point adds nothing (the point keeps its values)', () => {
    // regression: the point of that frame was replaced by a new one (min -1, max 1)
    const c = curveWith([{ type: 'ENVELOPE', params: envelope([[1, -3, 3]]) }]);
    s.state.frame = 1;
    const { container } = render(<Properties session={s} />);
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-add-point')!);
    expect(c.mods()[0].params.control_points).toEqual(envelope([[1, -3, 3]]).control_points);
    s.state.frame = 7;
    act(() => void 0);
    fireEvent.click(byTestId(container, 'fcurve-location-0-mod-0-add-point')!);
    expect(c.mods()[0].params.control_points).toEqual(
      envelope([
        [1, -3, 3],
        [7, -1, 1],
      ]).control_points,
    );
    expect(errorToasts()).toEqual([]);
  });

  it('a drag of an F-curve modifier setting undoes to its value before the drag when an agent removes a modifier before it meanwhile', () => {
    // regression: the drag was keyed by the modifier's index: when it moved up, the drag started again
    // from the dragged value, and undo went back to that instead of the value before the drag
    const c = curveWith([
      { type: 'NOISE', params: { strength: 1 } },
      { type: 'NOISE', params: { strength: 2 } },
    ]);
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    dragNumber(byTestId(container, 'fcurve-location-0-mod-1-strength')!, 40, () =>
      agent.run('anim.fmodifier_remove', { ...c.ref, modifier_index: 0 }),
    );
    const dragged = c.mods()[0].params.strength as number;
    expect(c.mods()).toHaveLength(1);
    expect(dragged).toBeGreaterThan(2);
    act(() => void s.undo.undo());
    expect(c.mods()[0].params.strength).toBe(2);
  });

  it('F-curve modifiers holding values no JSON can hold (bigints from another replica) are shown', () => {
    const c = curveWith([{ type: 'NOISE', params: { strength: 1 } }]);
    const fc = s.doc.getFCurve(c.key)!;
    // a bigint is what no panel writes, but a replica (another client of the sync hub) can
    const params = { strength: 1, seed: 5n } as unknown as Record<string, number>;
    s.doc.setFCurve({ ...fc, modifiers: [{ ...fc.modifiers![0], params }] });
    expect(typeof s.doc.getFCurve(c.key)!.modifiers![0].params.seed).toBe('bigint');
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'fcurve-location-0-mod-0-strength')).not.toBeNull();
  });

  it.each(browsers)(
    '%s: a shape key value typed when an agent removes the key goes to no other key',
    async (_browser, removal) => {
      // regression: the key shown in its place (the next one) got the open entry and the typed value
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      for (const name of ['Basis', 'Smile', 'Frown']) ok('object.shape_key_add', { object: 'Cube', name });
      const cube = s.doc.findObjectByName('Cube')!;
      select(s, 'Cube');
      activePropertiesTab.value = 'data';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      fireEvent.click(byTestId(container, 'shape-key-Smile')!);
      const input = typeInEntry(byTestId(container, 'shape-key-min')!, '-0.5');
      const restore = removal();
      try {
        act(() => agent.run('object.shape_key_remove', { object: cube.id, key: 'Smile' }));
        expect(input.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      const keys = s.doc.getShapeKeys(cube.data!);
      expect(keys.map((k) => k.name)).toEqual(['Basis', 'Frown']);
      expect(keys[1].slider_min).toBe(0);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('a shape key renamed here keeps its fields and the keyboard focus', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    for (const name of ['Basis', 'Smile']) ok('object.shape_key_add', { object: 'Cube', name });
    select(s, 'Cube');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    fireEvent.click(byTestId(container, 'shape-key-Smile')!);
    const name = byTestId(container, 'shape-key-name') as HTMLInputElement;
    name.focus();
    fireEvent.input(name, { target: { value: 'Grin' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(s.doc.getShapeKeys(s.doc.findObjectByName('Cube')!.data!).map((k) => k.name)).toEqual([
      'Basis',
      'Grin',
    ]);
    expect(byTestId(container, 'shape-key-name')).toBe(name);
    expect(document.activeElement).toBe(name);
  });

  it.each(browsers)(
    '%s: a vertex group name typed when an agent removes the group goes to no other group',
    async (_browser, removal) => {
      // regression: the name field stayed (with the keyboard focus) and showed the next group: the
      // keys typed on and Enter renamed that group
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      for (const name of ['Arm', 'Leg']) ok('object.vertex_group_add', { object: 'Cube', name });
      const cube = s.doc.findObjectByName('Cube')!;
      select(s, 'Cube');
      activePropertiesTab.value = 'data';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      fireEvent.click(byTestId(container, 'vgroup-Arm')!);
      const name = byTestId(container, 'vgroup-name') as HTMLInputElement;
      name.focus();
      fireEvent.input(name, { target: { value: 'ArmLeft' } });
      const restore = removal();
      try {
        act(() => agent.run('object.vertex_group_remove', { object: cube.id, group: 'Arm' }));
        expect(name.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      // the person types on and presses Enter where the keyboard focus is
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement && container.contains(focused)) {
        fireEvent.input(focused, { target: { value: `${focused.value}_x` } });
        fireEvent.keyDown(focused, { key: 'Enter' });
      }
      expect(s.doc.getVertexGroups(cube.data!).map((g) => g.name)).toEqual(['Leg']);
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: a vertex group name typed when an agent renames the group goes nowhere',
    async (_browser, removal) => {
      // the field is made anew for the renamed group (as for a shape key): what was typed for the
      // name the group had is not committed over the agent's name
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      for (const name of ['Arm', 'Leg']) ok('object.vertex_group_add', { object: 'Cube', name });
      const cube = s.doc.findObjectByName('Cube')!;
      select(s, 'Cube');
      activePropertiesTab.value = 'data';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      fireEvent.click(byTestId(container, 'vgroup-Arm')!);
      const name = byTestId(container, 'vgroup-name') as HTMLInputElement;
      name.focus();
      fireEvent.input(name, { target: { value: 'ArmLeft' } });
      const restore = removal();
      try {
        act(() => agent.run('object.vertex_group_rename', { object: cube.id, group: 'Arm', name: 'Arms' }));
        expect(name.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement && container.contains(focused)) {
        fireEvent.input(focused, { target: { value: `${focused.value}_x` } });
        fireEvent.keyDown(focused, { key: 'Enter' });
      }
      expect(s.doc.getVertexGroups(cube.data!).map((g) => g.name)).toEqual(['Arms', 'Leg']);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('a vertex group renamed here keeps its fields and the keyboard focus', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    for (const name of ['Arm', 'Leg']) ok('object.vertex_group_add', { object: 'Cube', name });
    select(s, 'Cube');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    fireEvent.click(byTestId(container, 'vgroup-Arm')!);
    const name = byTestId(container, 'vgroup-name') as HTMLInputElement;
    name.focus();
    fireEvent.input(name, { target: { value: 'Arms' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(s.doc.getVertexGroups(s.doc.findObjectByName('Cube')!.data!).map((g) => g.name)).toEqual([
      'Arms',
      'Leg',
    ]);
    expect(byTestId(container, 'vgroup-name')).toBe(name);
    expect(document.activeElement).toBe(name);
  });

  it('an image chosen for a texture of a material an agent deleted meanwhile is stored nowhere', async () => {
    // regression: the image was stored (for no material, synced and saved) and an error named the
    // material's id
    const g = globalThis as unknown as { createImageBitmap?: unknown };
    const had = g.createImageBitmap;
    g.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
    try {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      select(s, 'Cube');
      ok('material.new', { name: 'Mat' });
      localStorage.setItem('3d-editor:panel:material-textures', '1');
      activePropertiesTab.value = 'material';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const choose = async (input: HTMLInputElement) => {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = new File([bytes], 'wood.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        fireEvent.change(input);
        for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 1)));
      };
      // the file dialog is open while the agent deletes the material
      const input = byTestId(container, 'tex-base_color-file') as HTMLInputElement;
      act(() => agent.run('material.delete', { material: 'Mat' }));
      await choose(input);
      expect(s.doc.listImages()).toEqual([]);
      expect(errorToasts()).toEqual([]);
      // a material that is there gets the image
      act(() => void ok('material.new', { name: 'Wood' }));
      await choose(byTestId(container, 'tex-base_color-file') as HTMLInputElement);
      const images = s.doc.listImages();
      expect(images.map((i) => i.name)).toEqual(['wood.png']);
      const wood = s.doc.listMaterials().find((m) => m.name === 'Wood')!;
      expect(wood.textures?.base_color?.image).toBe(images[0].id);
    } finally {
      g.createImageBitmap = had;
    }
  });

  it.each(browsers)(
    '%s: a spline setting typed when an agent removes a spline before it goes to its spline (or nowhere)',
    async (_browser, removal) => {
      // regression: the panel kept the index: the open entry was given the next spline, and the
      // commit as it went away wrote the old spline's points into that spline
      ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
      ok('curve.spline_add', {
        object: 'Wire',
        type: 'POLY',
        points: [{ co: [0, 1, 0] }, { co: [1, 1, 0] }],
      });
      ok('curve.spline_add', {
        object: 'Wire',
        type: 'POLY',
        points: [{ co: [0, 2, 0] }, { co: [1, 2, 0] }, { co: [2, 2, 0] }],
      });
      const wire = s.doc.findObjectByName('Wire')!;
      select(s, 'Wire');
      activePropertiesTab.value = 'data';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      fireEvent.change(byTestId(container, 'spline-select')!, { target: { value: '1' } });
      const input = typeInEntry(byTestId(container, 'spline-resolution')!, '7');
      const restore = removal();
      try {
        // the agent reshapes the spline and removes one before it at once
        act(() => {
          agent.run('curve.spline_set_points', {
            object: wire.id,
            spline_index: 1,
            type: 'POLY',
            points: [{ co: [0, 5, 0] }, { co: [1, 5, 0] }],
          });
          agent.run('curve.spline_remove', { object: wire.id, spline_index: 0 });
        });
        expect(input.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      const splines = s.doc.getCurve(wire.data!)!.splines;
      // the reshaped points stay (not the points the panel had rendered)
      expect(splines.map((x) => x.points.map((p) => p.co[1]))).toEqual([
        [5, 5],
        [2, 2, 2],
      ]);
      expect(splines.map((x) => x.resolution_u)).toEqual([isChromium(removal) ? 7 : 0, 0]);
      expect(errorToasts()).toEqual([]);
    },
  );

  it('a spline setting keeps the points an agent gave the spline meanwhile', () => {
    ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
    ok('curve.spline_add', { object: 'Wire', type: 'POLY', points: [{ co: [0, 1, 0] }, { co: [1, 1, 0] }] });
    const wire = s.doc.findObjectByName('Wire')!;
    select(s, 'Wire');
    activePropertiesTab.value = 'data';
    const agent = peerReplica(s);
    const { container } = render(<Properties session={s} />);
    fireEvent.change(byTestId(container, 'spline-select')!, { target: { value: '1' } });
    const input = typeInEntry(byTestId(container, 'spline-resolution')!, '5');
    act(() =>
      agent.run('curve.spline_set_points', {
        object: wire.id,
        spline_index: 1,
        points: [{ co: [0, 3, 0] }, { co: [1, 3, 0] }],
      }),
    );
    expect(input.isConnected).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    const sp = s.doc.getCurve(wire.data!)!.splines[1];
    expect(sp.points.map((p) => p.co[1])).toEqual([3, 3]);
    expect(sp.resolution_u).toBe(5);
  });

  it.each(browsers)(
    '%s: material settings typed when an agent puts another material in the slot never go to it',
    async (_browser, removal) => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      select(s, 'Cube');
      ok('material.new', { name: 'A' });
      ok('material.new', { name: 'B', assign: false });
      activePropertiesTab.value = 'material';
      const mat = (name: string) => s.doc.listMaterials().find((m) => m.name === name)!;
      const roughness = mat('B').roughness;
      const ids = { a: mat('A').id, b: mat('B').id };
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const name = byTestId(container, 'material-name') as HTMLInputElement;
      name.focus();
      fireEvent.input(name, { target: { value: 'Renamed' } });
      const input = typeInEntry(byTestId(container, 'material-roughness')!, '0.9');
      const restore = removal();
      try {
        act(() =>
          agent.run('object.material_assign', {
            material: ids.b,
            objects: [s.doc.findObjectByName('Cube')!.id],
            slot: 0,
          }),
        );
        expect(input.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      const b = s.doc.getMaterial(ids.b)!;
      expect([b.name, b.roughness]).toEqual(['B', roughness]);
      const a = s.doc.getMaterial(ids.a)!;
      expect(a.roughness).toBe(isChromium(removal) ? 0.9 : roughness);
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: a material name typed when an agent puts another material in the slot goes to the material it was typed for',
    async (_browser, removal) => {
      // regression: the name field was kept for the other material and its typed text was lost
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      select(s, 'Cube');
      ok('material.new', { name: 'A' });
      ok('material.new', { name: 'B', assign: false });
      activePropertiesTab.value = 'material';
      const ids = Object.fromEntries(s.doc.listMaterials().map((m) => [m.name, m.id]));
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const name = byTestId(container, 'material-name') as HTMLInputElement;
      name.focus();
      fireEvent.input(name, { target: { value: 'Renamed' } });
      const restore = removal();
      try {
        act(() =>
          agent.run('object.material_assign', {
            material: ids.B,
            objects: [s.doc.findObjectByName('Cube')!.id],
            slot: 0,
          }),
        );
        expect(name.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      enterOnFocused(container);
      expect(s.doc.getMaterial(ids.B)!.name).toBe('B');
      expect(s.doc.getMaterial(ids.A)!.name).toBe('Renamed');
      expect(errorToasts()).toEqual([]);
    },
  );

  it('another project in the page opens the preset browser with nothing chosen or searched', () => {
    // regression: the chosen preset (with its Apply button) and the search were the page's, not
    // the project's
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'material';
    localStorage.setItem('3d-editor:panel:material-presets', '1');
    const first = render(<Properties session={s} />);
    fireEvent.click(byTestId(first.container, 'material-preset-gold')!);
    fireEvent.input(byTestId(first.container, 'material-preset-search')!, { target: { value: 'gold' } });
    expect(byTestId(first.container, 'material-preset-gold')!.getAttribute('aria-selected')).toBe('true');
    first.unmount();
    s = fakeSession();
    sessionSignal.value = s;
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'material-preset-gold')!.getAttribute('aria-selected')).toBe('false');
    expect((byTestId(container, 'material-preset-search') as HTMLInputElement).value).toBe('');
  });

  it('the selected material preset and the grid scroll are kept when another object is shown', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('mesh.primitive_cube_add', { name: 'B' });
    select(s, 'Cube');
    activePropertiesTab.value = 'material';
    localStorage.setItem('3d-editor:panel:material-presets', '1');
    const { container } = render(<Properties session={s} />);
    fireEvent.click(byTestId(container, 'material-preset-gold')!);
    expect(byTestId(container, 'material-preset-gold')!.getAttribute('aria-selected')).toBe('true');
    const grid = byTestId(container, 'material-presets')!;
    grid.scrollTop = 40;
    fireEvent.scroll(grid);
    act(() => select(s, 'B'));
    expect(byTestId(container, 'material-preset-gold')!.getAttribute('aria-selected')).toBe('true');
    expect(byTestId(container, 'material-presets')!.scrollTop).toBe(40);
  });

  it.each(browsers)(
    '%s: an Outliner name typed for an object an agent deletes is dropped without an error',
    async (_browser, removal) => {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      const agent = peerReplica(s);
      const { container } = render(<Outliner session={s} />);
      fireEvent.dblClick(byTestId(container, 'outliner-Cube')!);
      const box = container.querySelector<HTMLInputElement>('.outliner-row input')!;
      box.focus();
      fireEvent.input(box, { target: { value: 'Typed' } });
      const restore = removal();
      try {
        act(() => agent.run('object.delete', { objects: [s.doc.findObjectByName('Cube')!.id] }));
        expect(box.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.listObjects()).toEqual([]);
      expect(errorToasts()).toEqual([]);
    },
  );

  it.each(browsers)(
    '%s: text typed for a text object an agent deletes is dropped without an error',
    async (_browser, removal) => {
      ok('object.text_add', { name: 'Label', body: 'Hi' });
      select(s, 'Label');
      activePropertiesTab.value = 'data';
      const agent = peerReplica(s);
      const { container } = render(<Properties session={s} />);
      const body = byTestId(container, 'font-body') as HTMLTextAreaElement;
      body.focus();
      fireEvent.input(body, { target: { value: 'Typed' } });
      const restore = removal();
      try {
        act(() => agent.run('object.delete', { objects: [s.doc.findObjectByName('Label')!.id] }));
        expect(body.isConnected).toBe(false);
        await settle();
      } finally {
        restore();
      }
      expect(s.doc.listObjects()).toEqual([]);
      expect(errorToasts()).toEqual([]);
    },
  );
});
