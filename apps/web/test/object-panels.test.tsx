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
import { session as sessionSignal } from '../src/app/store';
import { registry, run, runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Properties, activePropertiesTab, availableTabs } from '../src/ui/properties/Properties';
import { Outliner } from '../src/ui/Outliner';
import { layoutConstraintParams, constraintEnumLabel } from '../src/ui/properties/ConstraintsTab';
import { channelLabel } from '../src/ui/properties/ObjectTab';
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
