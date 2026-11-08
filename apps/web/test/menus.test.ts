import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { h } from 'preact';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { SceneDoc, SceneEvaluator, fcurveKey, safeJsonSchema } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { hoveredArea, popupMenu, registry, run, runResult } from '../src/editor/editor';
import { lastOperator, redoLast } from '../src/editor/runner';
import { SchemaForm } from '../src/ui/SchemaForm';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { registerUiOperators } from '../src/editor/ui-operators';
import { installKeymap } from '../src/editor/keymap';
import {
  ADD_MENU,
  APPLY_MENU,
  OBJECT_CONTEXT,
  OBJECT_MENU,
  REDO_PANEL_OPERATORS,
  VIEW_MENU,
  availableItems,
  constraintAddItems,
  menuByName,
  xrayInactiveReason,
  type MenuItem,
} from '../src/editor/menus';
import type { ProjectSession } from '../src/project/session';

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

const resolve = (items: MenuItem['submenu']): MenuItem[] =>
  !items ? [] : typeof items === 'function' ? items() : items;

/** Every entry of a menu tree (submenus resolved), with its label path. */
function walk(items: MenuItem[], path: string[] = []): { item: MenuItem; path: string[] }[] {
  return availableItems(items).flatMap((item) => {
    const here = item.label ? [...path, item.label] : path;
    return [{ item, path: here }, ...(item.submenu ? walk(resolve(item.submenu), here) : [])];
  });
}

/** Finds an entry by its label path, e.g. ['Curve', 'Bezier']. */
function entry(items: MenuItem[], path: string[]): MenuItem {
  const hit = walk(items).find((e) => e.path.join(' > ') === path.join(' > '));
  if (!hit) throw new Error(`menu entry ${path.join(' > ')} not found`);
  return hit.item;
}

/** Runs a menu entry the way MenuList does. */
function click(item: MenuItem): boolean {
  if (item.action) {
    item.action();
    return true;
  }
  return run(item.op!, item.params, 'menu');
}

/** Name of the popup menu requested by the keymap (read through a function: no stale narrowing). */
const openMenu = (): string | undefined => popupMenu.value?.name;

let s: ProjectSession;
beforeAll(() => {
  if (!registry.has('wm.call_menu')) registerUiOperators(registry);
});
beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  sessionSignal.value = null;
  popupMenu.value = null;
});

describe('menus', () => {
  it('only reference registered operators with valid parameters', () => {
    ok('collection.create', { name: 'Trees' });
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    const rig = ok('object.armature_add', { name: 'Rig' }).object as string;
    ok('armature.bone_add', { object: rig, name: 'Spine' });
    select(s, 'Cube', 'Rig');
    const names = [
      'add',
      'apply',
      'parent',
      'parent_clear',
      'constraint_add_targets',
      'track',
      'generators',
      'context',
    ];
    const menus = [ADD_MENU, OBJECT_MENU(), OBJECT_CONTEXT(), ...names.map((n) => menuByName(n))];
    let checked = 0;
    for (const menu of menus)
      for (const { item, path } of walk(menu)) {
        if (!item.op) continue;
        expect(registry.has(item.op), path.join(' > ')).toBe(true);
        expect(() => registry.parseParams(item.op!, item.params ?? {}), path.join(' > ')).not.toThrow();
        checked++;
      }
    expect(checked).toBeGreaterThan(150);
  });

  it('Add menu offers curves, text, armatures, collection instances and every generator', () => {
    ok('collection.create', { name: 'Trees' });
    expect(walk(resolve(entry(ADD_MENU, ['Curve']).submenu)).map((e) => e.item.op)).toEqual([
      'curve.primitive_bezier_curve_add',
      'curve.primitive_bezier_circle_add',
      undefined,
      'curve.primitive_nurbs_curve_add',
      'curve.primitive_nurbs_circle_add',
      'curve.primitive_nurbs_path_add',
    ]);
    expect(entry(ADD_MENU, ['Text']).op).toBe('object.text_add');
    expect(entry(ADD_MENU, ['Armature']).op).toBe('object.armature_add');
    const trees = s.doc.listCollections().find((c) => c.name === 'Trees')!;
    expect(entry(ADD_MENU, ['Empty', 'Collection Instance', 'Trees']).params).toEqual({
      collection: trees.id,
    });
    expect(entry(ADD_MENU, ['Collection Instance', 'Trees']).op).toBe('object.collection_instance_add');
    const generators = walk(resolve(entry(ADD_MENU, ['Generators']).submenu))
      .map((e) => e.item.op)
      .filter(Boolean)
      .sort();
    const all = registry
      .list()
      .map((d) => d.id)
      .filter((id) => id.startsWith('object.generate_'))
      .sort();
    expect(all.length).toBeGreaterThanOrEqual(21);
    expect(generators).toEqual(all);

    // the entries create objects (and redoable ones feed the Adjust Last Operation panel)
    expect(click(entry(ADD_MENU, ['Curve', 'Bezier']))).toBe(true);
    expect(s.doc.listObjects().map((o) => o.type)).toEqual(['CURVE']);
    expect(lastOperator.value?.id).toBe('curve.primitive_bezier_curve_add');
    expect(click(entry(ADD_MENU, ['Text']))).toBe(true);
    expect(click(entry(ADD_MENU, ['Generators', 'Rock']))).toBe(true);
    expect(click(entry(ADD_MENU, ['Empty', 'Collection Instance', 'Trees']))).toBe(true);
    const types = s.doc.listObjects().map((o) => o.type);
    expect(types).toEqual(expect.arrayContaining(['CURVE', 'FONT', 'MESH', 'EMPTY']));
    expect(s.doc.listObjects().find((o) => o.type === 'EMPTY')?.instance_collection).toBe(trees.id);
  });

  it('Object menu: parenting with armature types, constraints, track, rigid body, convert, apply', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube', size: 1, location: [0, 0, 1] });
    const rig = ok('object.armature_add', { name: 'Rig' }).object as string;
    ok('armature.bone_add', { object: rig, name: 'Upper', head: [0, 0, 1], tail: [0, 0, 2] });
    select(s, 'Cube', 'Rig');
    const menu = OBJECT_MENU();
    expect(walk(resolve(entry(menu, ['Parent', 'Bone']).submenu)).map((e) => e.item.label)).toEqual([
      'Bone',
      'Upper',
    ]);
    expect(click(entry(menu, ['Parent', 'With Automatic Weights']))).toBe(true);
    const cube = () => s.doc.findObjectByName('Cube')!;
    expect(cube().parent).toBe(rig);
    expect(cube().modifiers.map((m) => m.type)).toContain('ARMATURE');
    // parent_set is redoable in the web UI (Adjust Last Operation)
    expect(lastOperator.value?.id).toBe('object.parent_set');

    // constraints with targets: the other selected object becomes the target where it fits
    ok('object.empty_add', { name: 'Goal', location: [0, 4, 0] });
    select(s, 'Goal', 'Cube');
    const items = menuByName('constraint_add_targets');
    const params = (label: string) => items.find((i) => i.label === label)?.params;
    const goal = s.doc.findObjectByName('Goal')!.id;
    expect(params('Track To')).toEqual({ type: 'TRACK_TO', object: cube().id, target: goal });
    expect(params('Limit Location')).toEqual({ type: 'LIMIT_LOCATION', object: cube().id });
    expect(params('Follow Path')).toEqual({ type: 'FOLLOW_PATH', object: cube().id });
    expect(items.some((i) => i.label === 'Inverse Kinematics')).toBe(false);
    expect(click(items.find((i) => i.label === 'Damped Track')!)).toBe(true);
    expect(cube().constraints[0]).toMatchObject({ type: 'DAMPED_TRACK', target: goal });
    expect(click(entry(menu, ['Constraint', 'Clear Object Constraints']))).toBe(true);
    expect(cube().constraints).toHaveLength(0);

    // Track: the selected objects track the active one
    select(s, 'Cube', 'Goal');
    expect(click(entry(OBJECT_MENU(), ['Track', 'Track To Constraint']))).toBe(true);
    expect(cube().constraints[0]).toMatchObject({ type: 'TRACK_TO', target: goal, name: 'AutoTrack' });
    expect(click(entry(APPLY_MENU(), ['Visual Transform']))).toBe(true);

    // rigid bodies
    select(s, 'Cube');
    expect(click(entry(OBJECT_MENU(), ['Rigid Body', 'Add Passive']))).toBe(true);
    expect(cube().rigid_body?.type).toBe('PASSIVE');
    expect(click(entry(OBJECT_MENU(), ['Rigid Body', 'Remove']))).toBe(true);
    expect(cube().rigid_body).toBeNull();

    // convert a curve to a mesh
    ok('curve.primitive_bezier_circle_add', { name: 'Ring' });
    select(s, 'Ring');
    expect(click(entry(OBJECT_MENU(), ['Convert', 'Mesh']))).toBe(true);
    expect(s.doc.findObjectByName('Ring')?.type).toBe('MESH');
    expect(lastOperator.value?.id).toBe('object.convert');
  });

  it('Layout and Animation entries run on the selection', () => {
    ok('mesh.primitive_cube_add', { name: 'A', location: [0, 0, 0] });
    ok('mesh.primitive_cube_add', { name: 'B', location: [3, 0, 2] });
    select(s, 'A', 'B');
    s.state.cursorLocation = [0, 10, 0];
    const layout = (label: string) => entry(OBJECT_MENU(), ['Layout', label]);
    expect(click(layout('Look At 3D Cursor'))).toBe(true);
    expect(layout('Look At Active').params).toEqual({
      objects: [s.doc.findObjectByName('A')!.id],
      target: s.doc.findObjectByName('B')!.id,
    });
    expect(click(layout('Drop to Ground'))).toBe(true);
    expect(click(layout('Distribute'))).toBe(true);
    expect(click(entry(OBJECT_MENU(), ['Animation', 'Camera Turntable']))).toBe(true);
    expect(s.doc.listObjects().some((o) => o.type === 'CAMERA')).toBe(true);
    expect(lastOperator.value?.id).toBe('anim.turntable');
  });

  it('makes the parameterised menu operators redoable', () => {
    for (const id of REDO_PANEL_OPERATORS) expect(registry.get(id)?.redoable, id).toBe(true);
    expect(constraintAddItems().filter((i) => i.op).length).toBe(16);
  });

  it('View > X-Ray is greyed out where X-ray changes nothing: Wireframe, Material Preview and Rendered outside Edit Mode', () => {
    // regression: its checkmark said X-ray was on in Material Preview and Rendered shading, which draw
    // objects as they are with it on or off outside Edit Mode (Blender greys its button out there),
    // and in Wireframe shading, which always sees through objects (selecting objects ignores X-ray)
    const xray = entry(VIEW_MENU(), ['X-Ray']);
    s.view.xray.value = true;
    const seen: Record<string, [boolean, boolean]> = {};
    for (const shading of ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'] as const)
      for (const mode of ['OBJECT', 'EDIT'] as const) {
        s.view.shading.value = shading;
        s.state.mode = mode;
        seen[`${shading} ${mode}`] = [xray.enabled!(), xray.checked!()];
      }
    // enabled, checked
    expect(seen).toEqual({
      'WIREFRAME OBJECT': [false, true],
      'WIREFRAME EDIT': [true, true],
      'SOLID OBJECT': [true, true],
      'SOLID EDIT': [true, true],
      'MATERIAL OBJECT': [false, true],
      'MATERIAL EDIT': [true, true],
      'RENDERED OBJECT': [false, true],
      'RENDERED EDIT': [true, true],
    });
    // and says why (the header button's tooltip)
    expect(xrayInactiveReason('RENDERED', 'OBJECT')).toBe(
      'no effect in Rendered shading outside Edit Mode, as in Blender: it sees through objects in Solid ' +
        'shading (Wireframe always does) and through the mesh in Edit Mode',
    );
    expect(xrayInactiveReason('WIREFRAME', 'OBJECT')).toBe(
      'no effect in Wireframe shading outside Edit Mode: Wireframe always sees through objects here ' +
        "(Blender's has an X-ray setting of its own); it sees through objects in Solid shading and " +
        'through the mesh in Edit Mode',
    );
    expect(xrayInactiveReason('SOLID', 'OBJECT')).toBeNull();
    expect(xrayInactiveReason('MATERIAL', 'EDIT')).toBeNull();
    expect(xrayInactiveReason('WIREFRAME', 'EDIT')).toBeNull();
  });
});

describe('keymap', () => {
  it('opens Blender popup menus for Ctrl+P, Alt+P, Shift+Ctrl+C and Shift+Ctrl+T', () => {
    const uninstall = installKeymap();
    try {
      ok('mesh.primitive_cube_add', { name: 'Cube' });
      select(s, 'Cube');
      hoveredArea.value = 'viewport';
      const press = (key: string, mods: KeyboardEventInit) =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ...mods }));
      press('p', { ctrlKey: true });
      expect(openMenu()).toBe('parent');
      popupMenu.value = null;
      press('p', { altKey: true });
      expect(openMenu()).toBe('parent_clear');
      popupMenu.value = null;
      press('C', { ctrlKey: true, shiftKey: true });
      expect(openMenu()).toBe('constraint_add_targets');
      popupMenu.value = null;
      press('T', { ctrlKey: true, shiftKey: true });
      expect(openMenu()).toBe('track');
      popupMenu.value = null;
      // Ctrl+Alt+C clears the constraints of the selection
      ok('object.constraint_add', { object: 'Cube', type: 'LIMIT_LOCATION' });
      press('c', { ctrlKey: true, altKey: true });
      expect(s.doc.findObjectByName('Cube')!.constraints).toHaveLength(0);
    } finally {
      uninstall();
    }
  });
});

/**
 * The Adjust Last Operation form of the last operator, wired like the viewport's redo panel:
 * every change re-runs the operator with the new parameters.
 */
function redoPanel(): HTMLElement {
  cleanup();
  const last = lastOperator.value!;
  const def = registry.get(last.id)!;
  const params = (last.params ?? {}) as Record<string, unknown>;
  return render(
    h(SchemaForm, {
      schema: safeJsonSchema(def.schema),
      values: params,
      doc: s.doc,
      exclude: ['enter_editmode', 'name', 'objects', 'object'],
      testIdPrefix: 'redo',
      onChange: (k: string, v: unknown, final: boolean) => {
        if (final) expect(redoLast(s, registry, { ...params, [k]: v })?.ok, `redo ${k}`).toBe(true);
      },
    }),
  ).container as HTMLElement;
}

const field = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

/** Types into a Blender-style number field (click, type, Enter). */
function typeNumber(el: HTMLElement, value: string): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 5, pointerId: 1 });
  fireEvent.pointerUp(el, { button: 0, clientX: 5, pointerId: 1 });
  const input = el.querySelector('input')!;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Adjust Last Operation after the menu operators', () => {
  afterEach(cleanup);

  it('Camera Turntable: the camera picker lists cameras and "none" creates a new camera again', () => {
    ok('object.camera_add', { name: 'Camera' });
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    expect(click(entry(OBJECT_MENU(), ['Animation', 'Camera Turntable']))).toBe(true);
    let panel = redoPanel();
    const camera = field(panel, 'redo-camera') as HTMLSelectElement;
    expect([...camera.options].map((o) => o.textContent)).toEqual(['— none —', 'Camera', 'Turntable Camera']);
    fireEvent.change(camera, { target: { value: s.doc.findObjectByName('Camera')!.id } });
    expect(s.doc.findObjectByName('Turntable Camera')).toBeNull();
    panel = redoPanel();
    fireEvent.change(field(panel, 'redo-camera'), { target: { value: '' } });
    expect(lastOperator.value?.id).toBe('anim.turntable');
    expect(s.doc.findObjectByName('Turntable Camera')?.type).toBe('CAMERA');
  });

  it('Align Objects keeps at least one axis', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('mesh.primitive_uv_sphere_add', { name: 'Sphere', location: [4, 0, 0] });
    select(s, 'Sphere', 'Cube');
    expect(click(entry(OBJECT_MENU(), ['Transform', 'Align Objects']))).toBe(true);
    const sphere = () => s.doc.findObjectByName('Sphere')!;
    expect(sphere().location[0]).toBeCloseTo(0);
    let panel = redoPanel();
    fireEvent.click(field(panel, 'redo-axis-0'));
    // nothing was re-run: the alignment stays
    expect(sphere().location[0]).toBeCloseTo(0);
    expect(lastOperator.value?.params).toMatchObject({ axis: ['X'] });
    fireEvent.click(field(panel, 'redo-axis-1'));
    expect(lastOperator.value?.params).toMatchObject({ axis: ['X', 'Y'] });
    panel = redoPanel();
    fireEvent.click(field(panel, 'redo-axis-0'));
    expect(lastOperator.value?.params).toMatchObject({ axis: ['Y'] });
    expect(sphere().location[0]).toBeCloseTo(4);
  });

  it('Convert shows its Mesh/Curve target as a choice, not an object picker', () => {
    ok('object.text_add', { name: 'Label' });
    select(s, 'Label');
    expect(click(entry(OBJECT_MENU(), ['Convert', 'Mesh']))).toBe(true);
    const target = field(redoPanel(), 'redo-target') as HTMLSelectElement;
    expect([...target.options].map((o) => o.value)).toEqual(['MESH', 'CURVE']);
    expect(target.value).toBe('MESH');
  });

  it('Add Bezier: unset location, rotation and scale show their effective values', () => {
    s.state.cursorLocation = [1, 2, 3];
    expect(click(entry(ADD_MENU, ['Curve', 'Bezier']))).toBe(true);
    const panel = redoPanel();
    const shown = (key: string) =>
      [0, 1, 2].map((i) => field(panel, `redo-${key}-${i}`).querySelector('.nf-value')?.textContent);
    expect(shown('location')).toEqual(['1', '2', '3']);
    expect(shown('scale')).toEqual(['1', '1', '1']);
    typeNumber(field(panel, 'redo-scale-0'), '2');
    const curve = s.doc.listObjects().find((o) => o.type === 'CURVE')!;
    expect(curve.scale).toEqual([2, 1, 1]);
    expect(curve.location).toEqual([1, 2, 3]);
  });

  it('Make Cyclic also loops the curves of the object data (a path animated by Follow Path)', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('curve.primitive_bezier_circle_add', { name: 'Path' });
    ok('object.constraint_add', { object: 'Cube', type: 'FOLLOW_PATH', target: 'Path' });
    const cube = s.doc.findObjectByName('Cube')!;
    ok('constraint.followpath_path_animate', { object: cube.id, constraint: cube.constraints[0].id });
    select(s, 'Path');
    expect(click(entry(OBJECT_MENU(), ['Animation', 'Extrapolation', 'Make Cyclic']))).toBe(true);
    const path = s.doc.findObjectByName('Path')!;
    const key = fcurveKey({ target_type: 'curve', target_id: path.data!, path: 'eval_time', index: 0 });
    expect(s.doc.getFCurve(key)?.extrapolation).toBe('CYCLIC');
  });
});
