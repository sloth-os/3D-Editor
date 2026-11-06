import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  decodeFloat32,
  defaultBone,
  defaultRigidBody,
  emptySelection,
  fcurveKey,
  rigidBodyCacheInfo,
  type MaterialData,
} from '@3d-editor/core';
import { closeDialog, openDialog, session as sessionSignal, toasts } from '../src/app/store';
import { registry, runResult, viewport } from '../src/editor/editor';
import { registerUiOperators } from '../src/editor/ui-operators';
import { infoLog } from '../src/editor/runner';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { ViewportEngine } from '../src/viewport/engine';
import { Properties, activePropertiesTab } from '../src/ui/properties/Properties';
import {
  DataTab,
  activeEntryIndex,
  boneTree,
  cameraFieldOfView,
  curveFieldOperator,
  lensForFieldOfView,
  shapeKeyPath,
  splinePointInput,
} from '../src/ui/properties/DataTab';
import {
  filterPresets,
  materialSwatchPixels,
  paramLabel,
  patchProcedural,
  proceduralPatch,
  restoreProcedural,
  textureSource,
} from '../src/ui/properties/MaterialTab';
import {
  rpcRenderEngineOptions,
  rpcRenderShading,
  uiBooleanParam,
  uiCommand,
  uiEnumParam,
} from '../src/editor/rpc';
import {
  bakeRigidBodyWorld,
  frameRateOption,
  frameRateOptions,
  mistDensityForDistance,
} from '../src/ui/properties/SceneTabs';
import { DialogHost, formatRenderTime } from '../src/ui/dialogs/Dialogs';
import { InProcessWorker, RenderPool, startPathTrace } from '../src/render';

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
    id: 'test-project',
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

let s: ProjectSession;
beforeEach(() => {
  localStorage.clear();
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  cleanup();
  closeDialog();
  viewport.engine = null;
  sessionSignal.value = null;
});

describe('Object Data tab: curves', () => {
  it('edits shape, geometry, mapping, path animation and the active spline through operators', () => {
    const r = ok('curve.primitive_bezier_curve_add', { name: 'Wire' });
    select(s, 'Wire');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const curve = () => s.doc.getCurve(s.doc.findObjectByName('Wire')!.data!)!;
    expect(byTestId(container, 'prop-content-data')).not.toBeNull();

    typeNumber(byTestId(container, 'curve-bevel-depth')!, '0.1');
    expect(curve().bevel_depth).toBeCloseTo(0.1);
    typeNumber(byTestId(container, 'curve-bevel-resolution')!, '6');
    expect(curve().bevel_resolution).toBe(6);
    typeNumber(byTestId(container, 'curve-extrude')!, '0.2');
    expect(curve().extrude).toBeCloseTo(0.2);
    typeNumber(byTestId(container, 'curve-factor-end')!, '0.5');
    expect(curve().bevel_factor_end).toBeCloseTo(0.5);
    fireEvent.click(byTestId(container, 'curve-fill-caps')!);
    expect(curve().use_fill_caps).toBe(true);
    fireEvent.change(byTestId(container, 'curve-twist')!, { target: { value: 'Z_UP' } });
    expect(curve().twist_mode).toBe('Z_UP');
    expect(byTestId(container, 'curve-taper-note')?.textContent).toMatch(/radius/i);

    // 2D curves offer the 2D fill modes and no twist method
    fireEvent.click(byTestId(container, 'curve-dimensions-2D')!);
    expect(curve().dimensions).toBe('2D');
    expect(byTestId(container, 'curve-twist')).toBeNull();
    const fills = [...(byTestId(container, 'curve-fill-mode') as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(fills.slice(0, 4)).toEqual(['BOTH', 'FRONT', 'BACK', 'NONE']);

    // bevel object: other curve objects only
    ok('curve.primitive_bezier_circle_add', { name: 'Profile' });
    select(s, 'Wire');
    act(() => void (activePropertiesTab.value = 'data'));
    fireEvent.click(byTestId(container, 'curve-bevel-mode-OBJECT')!);
    expect(curve().bevel_mode).toBe('OBJECT');
    const objects = [...(byTestId(container, 'curve-bevel-object') as HTMLSelectElement).options];
    expect(objects.map((o) => o.textContent)).toEqual(['— none —', 'Profile']);
    fireEvent.change(byTestId(container, 'curve-bevel-object')!, {
      target: { value: s.doc.findObjectByName('Profile')!.id },
    });
    expect(curve().bevel_object).toBe(s.doc.findObjectByName('Profile')!.id);

    // path animation (panel closed by default: open it)
    fireEvent.click(
      [...container.querySelectorAll('.panel-header')].find((h) =>
        h.textContent?.includes('Path Animation'),
      )!,
    );
    typeNumber(byTestId(container, 'curve-path-frames')!, '48');
    expect(curve().path_duration).toBe(48);
    typeNumber(byTestId(container, 'curve-eval-time')!, '12');
    expect(curve().eval_time).toBe(12);

    // active spline: cyclic, type and resolution keep the points
    const points = curve().splines[0].points.map((p) => p.co);
    fireEvent.click(byTestId(container, 'spline-cyclic')!);
    expect(curve().splines[0].use_cyclic_u).toBe(true);
    fireEvent.click(byTestId(container, 'spline-type-NURBS')!);
    expect(curve().splines[0].type).toBe('NURBS');
    expect(curve().splines[0].points.map((p) => p.co)).toEqual(points);
    typeNumber(byTestId(container, 'spline-order')!, '3');
    expect(curve().splines[0].order_u).toBe(3);
    typeNumber(byTestId(container, 'spline-resolution')!, '20');
    expect(curve().splines[0].resolution_u).toBe(20);
    fireEvent.click(byTestId(container, 'spline-smooth')!);
    expect(curve().splines[0].use_smooth).toBe(false);
    expect(r.object).toBeTruthy();
  });

  it('shows curve evaluation errors and animated values', () => {
    ok('curve.primitive_bezier_curve_add', { name: 'Wire', bevel_depth: 0.1 });
    const wire = s.doc.findObjectByName('Wire')!;
    ok('curve.keyframe_insert', { object: wire.id, path: 'bevel_depth', frame: 1, value: 0.1 });
    ok('curve.keyframe_insert', { object: wire.id, path: 'bevel_depth', frame: 11, value: 0.3 });
    s.state.frame = 6;
    select(s, 'Wire');
    const { container } = render(<DataTab s={s} o={s.doc.getObject(wire.id)!} />);
    const depth = byTestId(container, 'curve-bevel-depth')!;
    expect(depth.className).toContain('animated');
    expect(parseFloat(depth.textContent!)).toBeGreaterThan(0.15);
    expect(parseFloat(depth.textContent!)).toBeLessThan(0.25);
  });
});

describe('Object Data tab: text', () => {
  it('edits the body, font, spacing, alignment and offsets', () => {
    ok('object.text_add', { body: 'Hello', name: 'Title' });
    select(s, 'Title');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const curve = () => s.doc.getCurve(s.doc.findObjectByName('Title')!.data!)!;
    const body = byTestId(container, 'font-body') as HTMLTextAreaElement;
    expect(body.value).toBe('Hello');
    fireEvent.input(body, { target: { value: 'Hello\nWorld' } });
    fireEvent.blur(body);
    expect(curve().body).toBe('Hello\nWorld');
    typeNumber(byTestId(container, 'font-size')!, '0.5');
    expect(curve().size).toBeCloseTo(0.5);
    typeNumber(byTestId(container, 'font-shear')!, '0.2');
    expect(curve().shear).toBeCloseTo(0.2);
    typeNumber(byTestId(container, 'font-space-line')!, '1.5');
    expect(curve().space_line).toBeCloseTo(1.5);
    fireEvent.change(byTestId(container, 'font-align-x')!, { target: { value: 'CENTER' } });
    expect(curve().align_x).toBe('CENTER');
    fireEvent.change(byTestId(container, 'font-align-y')!, { target: { value: 'CENTER' } });
    expect(curve().align_y).toBe('CENTER');
    typeNumber(byTestId(container, 'font-offset-x')!, '0.25');
    expect(curve().offset_x).toBeCloseTo(0.25);
    // text shares the geometry panel (extrude gives thickness)
    typeNumber(byTestId(container, 'curve-extrude')!, '0.05');
    expect(curve().extrude).toBeCloseTo(0.05);
    expect(byTestId(container, 'curve-dimensions')).toBeNull();
    expect(byTestId(container, 'spline-type')).toBeNull();
  });
});

describe('Object Data tab: armatures', () => {
  it('edits the skeleton, bones, pose and adds IK', () => {
    ok('object.armature_add', { name: 'Rig' });
    select(s, 'Rig');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const rig = () => s.doc.findObjectByName('Rig')!;
    const arm = () => s.doc.getArmature(rig().data!)!;

    fireEvent.click(byTestId(container, 'armature-pose-position-REST')!);
    expect(arm().pose_position).toBe('REST');
    fireEvent.change(byTestId(container, 'armature-display-type')!, { target: { value: 'STICK' } });
    expect(arm().display_type).toBe('STICK');
    fireEvent.click(byTestId(container, 'armature-show-names')!);
    expect(arm().show_names).toBe(true);

    // add a child of the active bone, then another one
    fireEvent.click(byTestId(container, 'bone-add')!);
    fireEvent.click(byTestId(container, 'bone-add')!);
    expect(arm().bones.map((b) => [b.name, b.parent])).toEqual([
      ['Bone', null],
      ['Bone.001', 'Bone'],
      ['Bone.002', 'Bone.001'],
    ]);
    // the list shows the hierarchy; the new bone is active
    expect(byTestId(container, 'bone-Bone.002')?.getAttribute('aria-selected')).toBe('true');
    typeText(byTestId(container, 'bone-name')!, 'Hand');
    expect(arm().bones[2].name).toBe('Hand');
    expect(byTestId(container, 'bone-Hand')?.getAttribute('aria-selected')).toBe('true');
    typeNumber(byTestId(container, 'bone-tail-2')!, '4');
    expect(arm().bones[2].tail[2]).toBeCloseTo(4);
    fireEvent.click(byTestId(container, 'bone-deform')!);
    expect(arm().bones[2].use_deform).toBe(false);

    // pose: rotation in degrees, keyframes and clear
    typeNumber(byTestId(container, 'pose-rotation-0')!, '45');
    expect(rig().pose.bones.Hand.rotation_euler[0]).toBeCloseTo(Math.PI / 4);
    fireEvent.click(byTestId(container, 'pose-keyframe')!);
    expect(
      s.doc.getFCurve(
        fcurveKey({
          target_type: 'object',
          target_id: rig().id,
          path: 'pose.bones["Hand"].rotation_euler',
          index: 0,
        }),
      ),
    ).not.toBeNull();
    fireEvent.click(byTestId(container, 'pose-clear')!);
    expect(rig().pose.bones.Hand.rotation_euler).toEqual([0, 0, 0]);

    // IK on Bone.001 targeting the Hand bone of this armature is refused (Hand is in its chain children)…
    fireEvent.click(byTestId(container, 'bone-Bone.001')!);
    expect(byTestId(container, 'pose-ik-add')?.hasAttribute('disabled')).toBe(true);
    // …so add a free control bone and target it
    act(
      () =>
        void ok('armature.bone_add', {
          object: rig().id,
          name: 'Target',
          head: [1, 0, 1],
          tail: [1, 0, 1.5],
        }),
    );
    fireEvent.change(byTestId(container, 'pose-ik-bone')!, { target: { value: 'Target' } });
    typeNumber(byTestId(container, 'pose-ik-chain')!, '2');
    fireEvent.click(byTestId(container, 'pose-ik-add')!);
    const ik = rig().pose.bones['Bone.001'].constraints!;
    expect(ik.map((c) => [c.type, c.subtarget, c.params.chain_count])).toEqual([['IK', 'Target', 2]]);
    typeNumber(byTestId(container, 'bone-constraint-IK-influence')!, '0.5');
    expect(rig().pose.bones['Bone.001'].constraints![0].influence).toBeCloseTo(0.5);
    fireEvent.click(byTestId(container, 'bone-constraint-IK-remove')!);
    expect(rig().pose.bones['Bone.001'].constraints ?? []).toHaveLength(0);

    fireEvent.click(byTestId(container, 'bone-Hand')!);
    fireEvent.click(byTestId(container, 'bone-remove')!);
    expect(arm().bones.map((b) => b.name)).toEqual(['Bone', 'Bone.001', 'Target']);
  });

  it('renames a bone with Enter without renaming it again when the old name field loses focus', () => {
    // regression: the fields of the renamed bone are rebuilt; the old name field (removed while
    // focused) committed the rename again on blur and failed: "Bone 'Bone.001' not found"
    ok('object.armature_add', { name: 'Rig' });
    select(s, 'Rig');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    fireEvent.click(byTestId(container, 'bone-add')!);
    const errors = () => infoLog.value.filter((l) => l.level === 'ERROR').map((l) => l.message);
    const before = errors().length;
    const field = byTestId(container, 'bone-name') as HTMLInputElement;
    fireEvent.input(field, { target: { value: 'Hand' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    const rig = s.doc.findObjectByName('Rig')!;
    expect(s.doc.getArmature(rig.data!)!.bones.map((b) => b.name)).toEqual(['Bone', 'Hand']);
    expect(errors().slice(before)).toEqual([]);
    expect(byTestId(container, 'bone-Hand')?.getAttribute('aria-selected')).toBe('true');
    // typing the same text again after a failed or undone rename still commits
    const again = byTestId(container, 'bone-name') as HTMLInputElement;
    fireEvent.input(again, { target: { value: 'Wrist' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(s.doc.getArmature(rig.data!)!.bones.map((b) => b.name)).toEqual(['Bone', 'Wrist']);
  });

  it('orders bones as a tree', () => {
    const bones = [
      { ...defaultBone('C'), parent: 'B' },
      defaultBone('A'),
      { ...defaultBone('B'), parent: 'A' },
      { ...defaultBone('X'), parent: 'Y' },
      { ...defaultBone('Y'), parent: 'X' },
    ];
    expect(boneTree(bones).map((t) => `${t.bone.name}${t.depth}`)).toEqual(['A0', 'B1', 'C2', 'X0', 'Y0']);
  });
});

describe('Object Data tab: vertex groups and shape keys', () => {
  it('adds, renames, assigns in Edit Mode, normalizes and removes vertex groups', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const meshId = s.doc.findObjectByName('Cube')!.data!;
    fireEvent.click(byTestId(container, 'vgroup-add')!);
    fireEvent.click(byTestId(container, 'vgroup-add')!);
    expect(s.doc.getVertexGroups(meshId).map((g) => g.name)).toEqual(['Group', 'Group.001']);
    typeText(byTestId(container, 'vgroup-name')!, 'Arm');
    expect(s.doc.getVertexGroups(meshId).map((g) => g.name)).toEqual(['Group', 'Arm']);
    expect(byTestId(container, 'vgroup-Arm')?.getAttribute('aria-selected')).toBe('true');

    // Edit Mode: assign the selected vertices with the weight field
    act(() => {
      ok('object.mode_set', { mode: 'EDIT' });
      const sel = emptySelection();
      sel.verts.add(0);
      sel.verts.add(1);
      s.state.meshSelection = sel;
    });
    typeNumber(byTestId(container, 'vgroup-weight')!, '0.5');
    fireEvent.click(byTestId(container, 'vgroup-assign')!);
    const weights = () => [...decodeFloat32(s.doc.getVertexGroups(meshId)[1].weights)];
    expect(weights().slice(0, 3)).toEqual([0.5, 0.5, 0]);
    expect(byTestId(container, 'vgroup-Arm')?.textContent).toContain('2');
    fireEvent.click(byTestId(container, 'vgroup-remove-from')!);
    expect(weights().slice(0, 2)).toEqual([0, 0]);
    act(() => void ok('object.mode_set', { mode: 'OBJECT' }));
    expect(byTestId(container, 'vgroup-assign')).toBeNull();
    fireEvent.click(byTestId(container, 'vgroup-normalize-all')!);
    fireEvent.click(byTestId(container, 'vgroup-remove')!);
    expect(s.doc.getVertexGroups(meshId).map((g) => g.name)).toEqual(['Group']);
  });

  it('lists the basis and edits key values, ranges, mute and relative keys', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const meshId = s.doc.findObjectByName('Cube')!.data!;
    const keys = () => s.doc.getShapeKeys(meshId);
    expect(byTestId(container, 'shape-key-Basis')).toBeNull();
    fireEvent.click(byTestId(container, 'shape-key-add')!);
    fireEvent.click(byTestId(container, 'shape-key-add')!);
    expect(keys().map((k) => k.name)).toEqual(['Key 1', 'Key 2']);
    expect(byTestId(container, 'shape-key-Basis')).not.toBeNull();
    typeNumber(byTestId(container, 'shape-key-value')!, '0.75');
    expect(keys()[1].value).toBeCloseTo(0.75);
    typeNumber(byTestId(container, 'shape-key-max')!, '2');
    expect(keys()[1].slider_max).toBe(2);
    fireEvent.change(byTestId(container, 'shape-key-relative')!, { target: { value: 'Key 1' } });
    expect(keys()[1].relative_key).toBe('Key 1');
    fireEvent.click(byTestId(container, 'shape-key-Key 1-mute')!);
    expect(keys()[0].mute).toBe(true);
    fireEvent.click(byTestId(container, 'shape-key-keyframe')!);
    expect(
      s.doc.getFCurve(
        fcurveKey({ target_type: 'mesh', target_id: meshId, path: shapeKeyPath('Key 2'), index: 0 }),
      ),
    ).not.toBeNull();
    typeText(byTestId(container, 'shape-key-name')!, 'Smile');
    expect(keys().map((k) => k.name)).toEqual(['Key 1', 'Smile']);
    fireEvent.click(byTestId(container, 'shape-key-clear')!);
    expect(keys().map((k) => k.value)).toEqual([0, 0]);
    fireEvent.click(byTestId(container, 'shape-key-remove')!);
    expect(keys().map((k) => k.name)).toEqual(['Key 1']);
    fireEvent.click(byTestId(container, 'shape-key-add-mix')!);
    expect(keys()).toHaveLength(2);
    fireEvent.click(byTestId(container, 'shape-key-apply-all')!);
    expect(keys()).toHaveLength(0);
  });
});

describe('Object Data tab: active list entries', () => {
  // regression: the active bone, vertex group and shape key were remembered by name only, so a
  // rename made elsewhere (undo, redo, an MCP agent, a collaborator) jumped to the root bone, the
  // first group or the Basis (Blender keeps the active index)
  const selected = (container: ParentNode, id: string) =>
    byTestId(container, id)?.getAttribute('aria-selected') === 'true';
  const inputValue = (container: ParentNode, id: string) => {
    const el = byTestId(container, id)!;
    return ((el.tagName === 'INPUT' ? el : el.querySelector('input')) as HTMLInputElement).value;
  };

  it('keep the active bone across undo, redo and renames made elsewhere', () => {
    ok('object.armature_add', { name: 'Rig' });
    select(s, 'Rig');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const rig = s.doc.findObjectByName('Rig')!;
    const names = () => s.doc.getArmature(rig.data!)!.bones.map((b) => b.name);
    fireEvent.click(byTestId(container, 'bone-add')!);
    fireEvent.click(byTestId(container, 'bone-add')!);
    typeText(byTestId(container, 'bone-name')!, 'Hand');
    expect(selected(container, 'bone-Hand')).toBe(true);
    act(() => void s.undo.undo());
    expect(names()).toEqual(['Bone', 'Bone.001', 'Bone.002']);
    expect(selected(container, 'bone-Bone.002')).toBe(true);
    expect(inputValue(container, 'bone-name')).toBe('Bone.002');
    act(() => void s.undo.redo());
    expect(selected(container, 'bone-Hand')).toBe(true);
    // an agent renames it
    act(() => void ok('armature.bone_update', { object: rig.id, bone: 'Hand', name: 'Wrist' }));
    expect(selected(container, 'bone-Wrist')).toBe(true);
    expect(byTestId(container, 'bone-Bone')?.getAttribute('aria-selected')).toBe('false');
  });

  it('keep the active vertex group and shape key across undo and renames made elsewhere', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const cube = s.doc.findObjectByName('Cube')!;
    fireEvent.click(byTestId(container, 'vgroup-add')!);
    fireEvent.click(byTestId(container, 'vgroup-add')!);
    typeText(byTestId(container, 'vgroup-name')!, 'Arm');
    expect(selected(container, 'vgroup-Arm')).toBe(true);
    act(() => void s.undo.undo());
    expect(s.doc.getVertexGroups(cube.data!).map((g) => g.name)).toEqual(['Group', 'Group.001']);
    expect(selected(container, 'vgroup-Group.001')).toBe(true);
    expect(inputValue(container, 'vgroup-name')).toBe('Group.001');

    fireEvent.click(byTestId(container, 'shape-key-add')!);
    fireEvent.click(byTestId(container, 'shape-key-add')!);
    fireEvent.click(byTestId(container, 'shape-key-Key 1')!);
    typeText(byTestId(container, 'shape-key-name')!, 'Smile');
    expect(selected(container, 'shape-key-Smile')).toBe(true);
    act(() => void s.undo.undo());
    expect(s.doc.getShapeKeys(cube.data!).map((k) => k.name)).toEqual(['Key 1', 'Key 2']);
    expect(selected(container, 'shape-key-Key 1')).toBe(true);
    expect(inputValue(container, 'shape-key-name')).toBe('Key 1');
    // a collaborator renames it
    act(() =>
      s.doc.transact(
        () =>
          s.doc.setShapeKeys(
            cube.data!,
            s.doc.getShapeKeys(cube.data!).map((k) => (k.name === 'Key 1' ? { ...k, name: 'Frown' } : k)),
          ),
        'remote-peer',
      ),
    );
    expect(selected(container, 'shape-key-Frown')).toBe(true);
    // the Basis stays the active row when it was
    fireEvent.click(byTestId(container, 'shape-key-Basis')!);
    act(() => void ok('object.shape_key_set', { object: cube.id, key: 'Key 2', name: 'Wink' }));
    expect(selected(container, 'shape-key-Basis')).toBe(true);
    expect(byTestId(container, 'shape-key-name')).toBeNull();
    expect(activeEntryIndex(['A', 'B'], { name: 'C', index: 5 })).toBe(1);
    expect(activeEntryIndex(['A', 'B'], { name: 'B', index: 0 })).toBe(1);
    expect(activeEntryIndex([], { name: 'B', index: 0 })).toBe(-1);
  });
});

describe('Material tab', () => {
  it('applies presets as new materials or onto the current material', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    activePropertiesTab.value = 'material';
    const { container } = render(<Properties session={s} />);
    const cube = () => s.doc.findObjectByName('Cube')!;
    typeText(byTestId(container, 'material-preset-search')!, 'gold');
    expect(
      [...byTestId(container, 'material-presets')!.querySelectorAll('[role=option]')].map((e) =>
        e.getAttribute('data-testid'),
      ),
    ).toEqual(['material-preset-gold']);
    fireEvent.click(byTestId(container, 'material-preset-gold')!);
    expect(byTestId(container, 'material-preset-description')?.textContent).toContain('Gold');
    fireEvent.click(byTestId(container, 'material-preset-new')!);
    const gold = s.doc.getMaterial(cube().material_slots[0]!)!;
    expect(gold.name).toBe('Gold');
    expect(gold.metallic).toBe(1);
    // overwrite the material in place with another preset
    typeText(byTestId(container, 'material-preset-search')!, 'brick');
    fireEvent.click(byTestId(container, 'material-preset-brick')!);
    fireEvent.click(byTestId(container, 'material-preset-apply')!);
    const after = s.doc.getMaterial(gold.id)!;
    expect(after.name).toBe('Gold');
    expect(after.textures.base_color?.procedural?.type).toBe('BRICK');
    expect(filterPresets('', 'METAL').every((p) => p.category === 'METAL')).toBe(true);
    expect(filterPresets('glass clear', 'ALL').map((p) => p.id)).toEqual(['clear_glass']);
  });

  it('switches channels between none, image and procedural and edits procedural parameters', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('material.new', { name: 'Paint' });
    activePropertiesTab.value = 'material';
    const { container } = render(<Properties session={s} />);
    const mat = () => s.doc.getMaterial(s.doc.findObjectByName('Cube')!.material_slots[0]!)!;
    fireEvent.click(byTestId(container, 'tex-base_color-source-PROCEDURAL')!);
    expect(mat().textures.base_color?.procedural?.type).toBe('NOISE');
    fireEvent.change(byTestId(container, 'tex-base_color-type')!, { target: { value: 'VORONOI' } });
    expect(mat().textures.base_color?.procedural?.type).toBe('VORONOI');
    // type parameters come from the core spec; detail is not used by Voronoi
    expect(byTestId(container, 'tex-base_color-feature')).not.toBeNull();
    expect(byTestId(container, 'tex-base_color-detail')).toBeNull();
    fireEvent.change(byTestId(container, 'tex-base_color-feature')!, {
      target: { value: 'DISTANCE_TO_EDGE' },
    });
    expect(mat().textures.base_color?.procedural?.params.feature).toBe('DISTANCE_TO_EDGE');
    typeNumber(byTestId(container, 'tex-base_color-scale')!, '12');
    expect(mat().textures.base_color?.procedural?.scale).toBe(12);
    fireEvent.change(byTestId(container, 'tex-base_color-mapping')!, { target: { value: 'OBJECT' } });
    expect(mat().textures.base_color?.procedural?.mapping).toBe('OBJECT');
    typeNumber(byTestId(container, 'tex-base_color-offset-2')!, '0.5');
    expect(mat().textures.base_color?.procedural?.params.offset_z).toBe(0.5);

    // scalar channels edit grey ramp values; normal adds the bump distance
    fireEvent.click(byTestId(container, 'tex-roughness-source-PROCEDURAL')!);
    typeNumber(byTestId(container, 'tex-roughness-value-b')!, '0.8');
    expect(mat().textures.roughness?.procedural?.color_b).toEqual([0.8, 0.8, 0.8, 1]);
    fireEvent.click(byTestId(container, 'tex-normal-source-PROCEDURAL')!);
    typeNumber(byTestId(container, 'tex-normal-bump-distance')!, '0.02');
    expect(mat().textures.normal?.procedural?.params.bump_distance).toBeCloseTo(0.02);

    // None clears the channel (one undo step)
    fireEvent.click(byTestId(container, 'tex-roughness-source-NONE')!);
    expect(mat().textures.roughness ?? null).toBeNull();
    expect(textureSource(mat(), 'base_color')).toBe('PROCEDURAL');
    expect(textureSource(mat(), 'roughness')).toBe('NONE');
    expect(
      textureSource({ textures: { alpha: { image: 'x', scale: [1, 1], offset: [0, 0] } } }, 'alpha'),
    ).toBe('IMAGE');
  });

  it('builds procedural patches and preview swatches', () => {
    const tex = {
      type: 'NOISE' as const,
      mapping: 'GENERATED' as const,
      scale: 5,
      detail: 2,
      roughness: 0.5,
      distortion: 0,
      color_a: [0, 0, 0, 1] as [number, number, number, number],
      color_b: [1, 1, 1, 1] as [number, number, number, number],
      ramp_low: 0,
      ramp_high: 1,
      seed: 0,
      params: { noise_type: 'FBM' },
    };
    expect(patchProcedural(tex, 'params.lacunarity', 3).params).toEqual({ noise_type: 'FBM', lacunarity: 3 });
    expect(patchProcedural(tex, 'scale', 2).scale).toBe(2);
    expect(proceduralPatch('params.lacunarity', 3)).toEqual({ params: { lacunarity: 3 } });
    expect(proceduralPatch('scale', 2)).toEqual({ scale: 2 });
    const m: MaterialData = s.doc.getMaterial(s.doc.addMaterial({ name: 'M', base_color: [1, 0, 0, 1] }))!;
    const px = materialSwatchPixels(m, 16);
    const at = (x: number, y: number) => [...px.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(at(0, 0)[3]).toBe(0);
    const centre = at(8, 8);
    expect(centre[3]).toBe(255);
    expect(centre[0]).toBeGreaterThan(centre[1] + 40);
  });
});

describe('Scene, World and Render tabs', () => {
  it('switches the render engine and edits path tracer settings', () => {
    activePropertiesTab.value = 'render';
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'render-samples')).toBeNull();
    fireEvent.change(byTestId(container, 'render-engine')!, { target: { value: 'PATHTRACER' } });
    expect(s.doc.getRender().engine).toBe('PATHTRACER');
    typeNumber(byTestId(container, 'render-samples')!, '128');
    expect(s.doc.getRender().samples).toBe(128);
    typeNumber(byTestId(container, 'render-max-bounces')!, '8');
    expect(s.doc.getRender().max_bounces).toBe(8);
    fireEvent.click(byTestId(container, 'render-denoise')!);
    expect(s.doc.getRender().use_denoising).toBe(false);
    expect(byTestId(container, 'render-engine-hint')?.textContent).toMatch(/thread/);
  });

  it('edits the sky and the mist of the world', () => {
    activePropertiesTab.value = 'world';
    const { container } = render(<Properties session={s} />);
    expect(byTestId(container, 'world-sun-elevation')).toBeNull();
    fireEvent.change(byTestId(container, 'world-environment')!, { target: { value: 'SKY' } });
    const w = () => s.doc.getWorld();
    expect(w().environment).toBe('SKY');
    expect(w().show_environment_background).toBe(true);
    typeNumber(byTestId(container, 'world-sun-elevation')!, '10');
    expect(w().sun_elevation).toBeCloseTo((10 * Math.PI) / 180);
    typeNumber(byTestId(container, 'world-sun-intensity')!, '5');
    expect(w().sun_intensity).toBe(5);
    fireEvent.change(byTestId(container, 'world-sky-preset')!, { target: { value: 'SUNSET' } });
    expect(w().sun_elevation).toBeCloseTo((2 * Math.PI) / 180);
    // the Mist panel starts closed while there is no mist
    expect(byTestId(container, 'world-mist-distance')).toBeNull();
    fireEvent.click([...container.querySelectorAll('.panel-header')].find((h) => h.textContent === '▸Mist')!);
    expect(byTestId(container, 'world-mist-distance')?.textContent).toBe('Off');
    typeNumber(byTestId(container, 'world-mist-distance')!, '50');
    expect(w().mist_density).toBeCloseTo(mistDensityForDistance(50));
    expect(byTestId(container, 'world-mist-distance')?.textContent).toContain('50');
    fireEvent.change(byTestId(container, 'world-environment')!, { target: { value: 'NONE' } });
    expect(w().environment).toBe('NONE');
  });

  it('edits the rigid body world and bakes or frees its cache', async () => {
    ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 });
    ok('mesh.primitive_cube_add', { name: 'Box', location: [0, 0, 3] });
    ok('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE' });
    ok('rigidbody.object_add', { objects: ['Box'], type: 'ACTIVE' });
    activePropertiesTab.value = 'scene';
    const { container } = render(<Properties session={s} />);
    typeNumber(byTestId(container, 'scene-rigidbody-world-frame_end')!, '20');
    expect(s.doc.getScene().rigidbody_world.frame_end).toBe(20);
    typeNumber(byTestId(container, 'scene-rigidbody-world-substeps_per_frame')!, '5');
    expect(s.doc.getScene().rigidbody_world.substeps_per_frame).toBe(5);
    // the bake runs in slices between event loop turns, with progress and a Cancel button
    fireEvent.click(byTestId(container, 'scene-rigidbody-bake')!);
    expect(byTestId(container, 'scene-rigidbody-bake-cancel')).not.toBeNull();
    await waitFor(() => expect(byTestId(container, 'scene-rigidbody-bake')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(rigidBodyCacheInfo(s.doc)?.simulated_to).toBe(20);
    expect(byTestId(container, 'scene-rigidbody-cache')?.textContent).toContain('Cached frames 1–20');
    fireEvent.click(byTestId(container, 'scene-rigidbody-free')!);
    expect(rigidBodyCacheInfo(s.doc)).toBeNull();
    fireEvent.click(byTestId(container, 'scene-rigidbody-bake-keyframes')!);
    expect(s.doc.findObjectByName('Box')!.rigid_body).toBeNull();
  });

  it('redraws the rigid body world on document changes: its own edits, agents and undo', () => {
    // regression: the panels read the frame signal, so @preact/signals skipped them whenever the
    // Properties editor redrew with the same props: a typed value snapped back to the old one, and
    // bodies added by an agent left "No rigid bodies" and a disabled Bake button
    ok('mesh.primitive_cube_add', { name: 'Box', location: [0, 0, 3] });
    activePropertiesTab.value = 'scene';
    const { container } = render(<Properties session={s} />);
    const shown = (key: string) =>
      parseFloat(byTestId(container, `scene-rigidbody-world-${key}`)!.textContent!);
    const cache = () => byTestId(container, 'scene-rigidbody-cache')!.textContent!;
    const bake = () => byTestId(container, 'scene-rigidbody-bake') as HTMLButtonElement;
    typeNumber(byTestId(container, 'scene-rigidbody-world-substeps_per_frame')!, '25');
    expect(s.doc.getScene().rigidbody_world.substeps_per_frame).toBe(25);
    expect(shown('substeps_per_frame')).toBe(25);
    typeNumber(byTestId(container, 'scene-rigidbody-world-frame_end')!, '100');
    expect(s.doc.getScene().rigidbody_world.frame_end).toBe(100);
    expect(shown('frame_end')).toBe(100);
    expect(cache()).toContain('No rigid bodies');
    expect(bake().disabled).toBe(true);
    // an MCP agent (another replica) adds a body
    act(() =>
      remote(() => {
        const box = s.doc.findObjectByName('Box')!;
        s.doc.updateObject(box.id, { rigid_body: defaultRigidBody('ACTIVE') });
      }),
    );
    expect(cache()).toContain('1 rigid body (1 active)');
    expect(bake().disabled).toBe(false);
    // undo of the panel's own edit shows the value before it
    act(() => void s.undo.undo());
    expect(s.doc.getScene().rigidbody_world.frame_end).toBe(250);
    expect(shown('frame_end')).toBe(250);
  });

  it('shows any frame rate in the Output tab (custom rates set by agents)', () => {
    // regression: a rate outside the eight presets (15, 29.97 …) left an empty Frame Rate box
    activePropertiesTab.value = 'output';
    const { container } = render(<Properties session={s} />);
    const select = () => byTestId(container, 'output-fps') as HTMLSelectElement;
    const label = () => select().options[select().selectedIndex]?.textContent;
    act(() => s.doc.updateScene({ fps: 15 }));
    expect(select().selectedIndex).toBeGreaterThanOrEqual(0);
    expect(label()).toBe('Custom (15 fps)');
    act(() => s.doc.updateScene({ fps: 29.97 }));
    expect(label()).toBe('29.97 fps');
    act(() => s.doc.updateScene({ fps: 30000 / 1001 }));
    expect(label()).toBe('29.97 fps');
    // picking a preset sets it
    fireEvent.change(select(), { target: { value: frameRateOption(24) } });
    expect(s.doc.getScene().fps).toBe(24);
    expect(label()).toBe('24 fps');
    expect(frameRateOptions(24).some((o) => o.label.startsWith('Custom'))).toBe(false);
    expect(frameRateOptions(23.976).find((o) => o.value === frameRateOption(23.976))?.label).toBe(
      '23.98 fps',
    );
  });
});

describe('rigid body bake', () => {
  it('simulates in slices with progress, and stops when cancelled', async () => {
    ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 });
    ok('mesh.primitive_cube_add', { name: 'Box', location: [0, 0, 3] });
    ok('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE' });
    ok('rigidbody.object_add', { objects: ['Box'], type: 'ACTIVE' });
    ok('rigidbody.world_set', { frame_end: 60 });
    const progress: number[] = [];
    const done = await new Promise<boolean>((resolve) =>
      bakeRigidBodyWorld(s.doc, (p) => progress.push(p.frame), resolve, 2),
    );
    expect(done).toBe(true);
    expect(rigidBodyCacheInfo(s.doc)?.simulated_to).toBe(60);
    expect(progress.length).toBeGreaterThan(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    // cancelled: the frames simulated so far stay cached
    ok('rigidbody.cache_free');
    let result: boolean | null = null;
    const cancel = bakeRigidBodyWorld(
      s.doc,
      () => cancel(),
      (completed) => (result = completed),
      1,
    );
    await waitFor(() => expect(result).toBe(false));
    const partial = rigidBodyCacheInfo(s.doc)?.simulated_to ?? 0;
    expect(partial).toBeGreaterThan(1);
    expect(partial).toBeLessThan(60);
    // nothing simulates any more (world disabled, a partial cache left): stops at once
    ok('rigidbody.world_set', { enabled: false });
    expect(await new Promise((resolve) => bakeRigidBodyWorld(s.doc, () => undefined, resolve))).toBe(false);
    expect(rigidBodyCacheInfo(s.doc)?.simulated_to).toBe(partial);
  }, 30_000);
});

describe('render window', () => {
  const pools: RenderPool[] = [];
  afterEach(() => {
    for (const p of pools.splice(0)) p.dispose();
  });
  function fakeEngine(samples: number): ViewportEngine {
    const pool = new RenderPool({ size: 2, factory: () => new InProcessWorker(), idleMs: 0 });
    pools.push(pool);
    return {
      pathTraces: () => true,
      startPathTrace: () => startPathTrace(pool, s.doc, { width: 16, height: 12, frame: 1, samples }),
    } as unknown as ViewportEngine;
  }

  it('path traces progressively and shows the result with its render info', async () => {
    s.doc.populateDefaultScene();
    viewport.engine = fakeEngine(3);
    openDialog('render');
    const { container } = render(<DialogHost />);
    await waitFor(() => expect(byTestId(container, 'render-image')).not.toBeNull(), { timeout: 10_000 });
    expect(byTestId(container, 'render-image')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    const status = byTestId(container, 'render-status')!.textContent!;
    expect(status).toContain('Finished');
    expect(status).toContain('Sample 3/3');
    expect(byTestId(container, 'render-save')).not.toBeNull();
    expect(byTestId(container, 'render-cancel')).toBeNull();
    // Render Again starts a new render of the scene as it is now
    const first = byTestId(container, 'render-image')!.getAttribute('src');
    s.doc.updateObject(s.doc.findObjectByName('Cube')!.id, { location: [0.6, 0, 0] });
    fireEvent.click(byTestId(container, 'render-again')!);
    await waitFor(() => expect(byTestId(container, 'render-image')).toBeNull());
    await waitFor(() => expect(byTestId(container, 'render-image')).not.toBeNull(), { timeout: 10_000 });
    expect(byTestId(container, 'render-image')!.getAttribute('src')).not.toBe(first);
  });

  it('cancels with Escape and keeps the image', async () => {
    s.doc.populateDefaultScene();
    viewport.engine = fakeEngine(100_000);
    openDialog('render');
    const { container } = render(<DialogHost />);
    await waitFor(() => expect(byTestId(container, 'render-status')?.textContent).toContain('Path Tracing'), {
      timeout: 10_000,
    });
    expect(byTestId(container, 'render-cancel')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(byTestId(container, 'render-status')?.textContent).toContain('Cancelled'), {
      timeout: 10_000,
    });
    await waitFor(() => expect(byTestId(container, 'render-image')).not.toBeNull());
  });

  it('renders an animation into a file with progress', async () => {
    s.doc.populateDefaultScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 3 });
    s.doc.updateRender({ resolution_x: 40, resolution_y: 20, resolution_percentage: 50 });
    const frames: number[] = [];
    viewport.engine = {
      renderPixels: (o: { frame: number; width: number; height: number }) => {
        frames.push(o.frame);
        return {
          width: o.width,
          height: o.height,
          data: new Uint8ClampedArray(o.width * o.height * 4).fill(200),
        };
      },
    } as unknown as ViewportEngine;
    openDialog('render', { animation: true });
    const { container } = render(<DialogHost />);
    // 40×20 at 50 %: the aspect ratio is kept (it used to be stretched to at least 16 px per side)
    expect(byTestId(container, 'render-animation-settings')?.textContent).toContain('3 frames · 20×10 px');
    fireEvent.change(byTestId(container, 'render-animation-format')!, { target: { value: 'GIF' } });
    fireEvent.click(byTestId(container, 'render-animation-start')!);
    await waitFor(() => expect(byTestId(container, 'render-animation-result')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(frames).toEqual([1, 2, 3]);
    expect(byTestId(container, 'render-animation-info')?.textContent).toMatch(/3 frames \(1–3\) · 20×10/);
    expect(byTestId(container, 'render-animation-save')).not.toBeNull();
    expect(formatRenderTime(83_456)).toBe('01:23.46');
  });

  it('follows render settings changed while the Render Animation window is open', async () => {
    // regression: the window kept the engine, size and samples it opened with (an MCP agent or a
    // collaborator changing them was ignored) and rendered with them
    s.doc.populateDefaultScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 2 });
    s.doc.updateRender({ resolution_x: 40, resolution_y: 20, resolution_percentage: 50 });
    const pool = new RenderPool({ size: 1, factory: () => new InProcessWorker(), idleMs: 0 });
    pools.push(pool);
    const calls: string[] = [];
    viewport.engine = {
      renderPixels: (o: { frame: number; width: number; height: number }) => {
        calls.push(`raster ${o.frame} ${o.width}×${o.height}`);
        return { width: o.width, height: o.height, data: new Uint8ClampedArray(o.width * o.height * 4) };
      },
      startPathTrace: (o: { frame: number; width: number; height: number; samples: number }) => {
        calls.push(`path ${o.frame} ${o.width}×${o.height} ${o.samples} spp`);
        return startPathTrace(pool, s.doc, { width: o.width, height: o.height, frame: o.frame, samples: 1 });
      },
    } as unknown as ViewportEngine;
    openDialog('render', { animation: true });
    const { container } = render(<DialogHost />);
    const settings = () => byTestId(container, 'render-animation-settings')!.textContent!;
    expect(settings()).toContain('2 frames · 20×10 px');
    expect(settings()).toContain('Rasterized (WebGL)');
    expect(byTestId(container, 'render-animation-samples')).toBeNull();
    // an agent switches to the path tracer at full size with 3 samples and a longer range
    act(() =>
      s.doc.transact(() => {
        s.doc.updateRender({ engine: 'PATHTRACER', samples: 3, resolution_percentage: 100 });
        s.doc.updateScene({ frame_end: 3 });
      }, 'remote-peer'),
    );
    expect(settings()).toContain('3 frames · 40×20 px');
    expect(settings()).toContain('Path Tracer');
    expect(parseFloat(byTestId(container, 'render-animation-samples')!.textContent!)).toBe(3);
    // a value changed in the window is kept when the scene's changes
    typeNumber(byTestId(container, 'render-animation-end-frame')!, '2');
    act(() => s.doc.updateScene({ frame_end: 5 }));
    expect(settings()).toContain('2 frames · 40×20 px');
    fireEvent.click(byTestId(container, 'render-animation-start')!);
    await waitFor(() => expect(byTestId(container, 'render-animation-result')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(calls).toEqual(['path 1 40×20 3 spp', 'path 2 40×20 3 spp']);
  });

  it('updates the samples and time of the frame being path traced while it renders', async () => {
    // regression: the status line kept "Sample 0/…" and the frame's start time for the whole frame
    s.doc.populateDefaultScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 2 });
    s.doc.updateRender({
      engine: 'PATHTRACER',
      resolution_x: 32,
      resolution_y: 16,
      resolution_percentage: 50,
    });
    const pool = new RenderPool({ size: 1, factory: () => new InProcessWorker(), idleMs: 0 });
    pools.push(pool);
    viewport.engine = {
      startPathTrace: (o: { frame: number; width: number; height: number }) =>
        startPathTrace(pool, s.doc, { width: o.width, height: o.height, frame: o.frame, samples: 100_000 }),
    } as unknown as ViewportEngine;
    openDialog('render', { animation: true });
    const { container } = render(<DialogHost />);
    fireEvent.click(byTestId(container, 'render-animation-start')!);
    const status = () => byTestId(container, 'render-animation-status')?.textContent ?? '';
    await waitFor(() => expect(status()).toMatch(/Frame 1 \(1\/2\).*Sample [1-9]\d*\/100000/), {
      timeout: 10_000,
    });
    const first = status();
    // later samples of the same frame show up (and the clock keeps running) without a new frame
    await waitFor(() => expect(status()).not.toBe(first), { timeout: 10_000 });
    expect(status()).toMatch(/Frame 1 \(1\/2\)/);
    const time = (t: string) => {
      const [m, sec] = /Time (\d\d):(\d\d\.\d\d)/.exec(t)!.slice(1).map(Number);
      return m * 60 + sec;
    };
    await waitFor(() => expect(time(status())).toBeGreaterThan(time(first)), { timeout: 10_000 });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(byTestId(container, 'render-animation-start')).not.toBeNull(), {
      timeout: 10_000,
    });
    // regression: cancelled before the first frame, the window kept saying "Rendering frame 1…"
    expect(byTestId(container, 'render-animation-status')).toBeNull();
    expect(byTestId(container, 'render-animation-progress')).toBeNull();
    expect(container.textContent).not.toContain('Rendering frame');
    expect(byTestId(container, 'render-animation-cancelled')?.textContent).toContain('Cancelled');
    expect(byTestId(container, 'render-animation-settings')).not.toBeNull();
  }, 30_000);

  it('refuses frame ranges longer than it renders instead of cutting them short', () => {
    // regression: frames 1–12000 offered "Render 10000 frames" and silently rendered 1–10000
    s.doc.populateDefaultScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 12_000 });
    s.doc.updateRender({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 1 });
    viewport.engine = { renderPixels: () => null } as unknown as ViewportEngine;
    openDialog('render', { animation: true });
    const { container } = render(<DialogHost />);
    const settings = byTestId(container, 'render-animation-settings')!.textContent!;
    expect(settings).toContain('12000 frames · 19×11 px');
    expect(settings).toContain('The range has 12000 frames: at most 10000 can be rendered at once');
    expect((byTestId(container, 'render-animation-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the framing of outputs larger than the browser renders and says so', async () => {
    // regression: each side was clamped to 4096 px on its own (8000×2000 rendered 4096×2000)
    s.doc.populateDefaultScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 2 });
    s.doc.updateRender({ resolution_x: 8000, resolution_y: 2000, resolution_percentage: 100 });
    viewport.engine = {
      pathTraces: () => false,
      renderImage: async () => ({ dataUrl: 'data:image/png;base64,AAAA', width: 4096, height: 1024 }),
    } as unknown as ViewportEngine;
    openDialog('render', { animation: true });
    const anim = render(<DialogHost />);
    expect(byTestId(anim.container, 'render-animation-settings')?.textContent).toContain(
      '2 frames · 4096×1024 px',
    );
    expect(byTestId(anim.container, 'render-animation-size-note')?.textContent).toBe(
      'Scaled down from 8000×2000 px (the browser renders at most 4096 px per side; the framing is the same)',
    );
    anim.unmount();
    closeDialog();
    openDialog('render');
    const still = render(<DialogHost />);
    await waitFor(() => expect(byTestId(still.container, 'render-image')).not.toBeNull());
    expect(byTestId(still.container, 'render-size-note')?.textContent).toContain(
      'Scaled down from 8000×2000 px',
    );
    expect(still.container.textContent).toContain('4096×1024');
  });

  it('does not call a finished animation cancelled when Cancel is pressed while it is encoded', async () => {
    // regression: Cancel stayed enabled while encoding and the complete file was labelled "Cancelled"
    s.doc.populateDefaultScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 3 });
    s.doc.updateRender({ resolution_x: 40, resolution_y: 20, resolution_percentage: 50 });
    viewport.engine = {
      renderPixels: (o: { width: number; height: number }) => ({
        width: o.width,
        height: o.height,
        data: new Uint8ClampedArray(o.width * o.height * 4).fill(90),
      }),
    } as unknown as ViewportEngine;
    openDialog('render', { animation: true });
    const { container } = render(<DialogHost />);
    fireEvent.click(byTestId(container, 'render-animation-start')!);
    const status = () => byTestId(container, 'render-animation-status')?.textContent ?? '';
    await waitFor(() => expect(status()).toContain('Encoding'), { timeout: 10_000 });
    const cancel = byTestId(container, 'render-animation-cancel') as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(byTestId(container, 'render-animation-result')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(byTestId(container, 'render-animation-info')?.textContent).toMatch(/^3 frames \(1–3\)/);
  });
});

/** Drags a number field by `dx` pixels; `during` runs while the button is still down. */
function dragNumber(el: HTMLElement, dx: number, during?: () => void): void {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 10 + dx / 2, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 10 + dx, pointerId: 1 });
  if (during) act(during);
  fireEvent.pointerUp(el, { button: 0, clientX: 10 + dx, pointerId: 1 });
}

/** A change made by another device or an MCP agent (not this editor's undo history). */
const remote = (fn: () => void) => s.doc.transact(fn, 'remote-peer');

describe('slider drags', () => {
  it('preview live and commit once; edits made elsewhere during a drag survive the release', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.shape_key_add', { object: 'Cube', name: 'A' });
    select(s, 'Cube');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const meshId = s.doc.findObjectByName('Cube')!.data!;
    fireEvent.click(byTestId(container, 'shape-key-A')!);
    const steps = s.undo.undoStack.length;
    let previewed = -1;
    dragNumber(byTestId(container, 'shape-key-value')!, 40, () => {
      previewed = s.doc.getShapeKeys(meshId)[0].value;
      // an agent adds a key while the slider is held
      remote(() =>
        s.doc.setShapeKeys(meshId, [
          ...s.doc.getShapeKeys(meshId),
          { ...s.doc.getShapeKeys(meshId)[0], name: 'B', value: 0 },
        ]),
      );
    });
    // previewed live (40 px at 0.01 per pixel), committed once on release
    expect(previewed).toBeCloseTo(0.4);
    const keys = s.doc.getShapeKeys(meshId);
    expect(keys.map((k) => k.name)).toEqual(['A', 'B']);
    expect(keys[0].value).toBeCloseTo(0.4);
    expect(s.undo.undoStack.length).toBe(steps + 1);
    act(() => void s.undo.undo());
    expect(s.doc.getShapeKeys(meshId).map((k) => [k.name, k.value])).toEqual([
      ['A', 0],
      ['B', 0],
    ]);
  });

  it('restores only the dragged procedural parameter and rigid body world setting', () => {
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    select(s, 'Cube');
    ok('material.new', { name: 'Paint' });
    const matId = s.doc.findObjectByName('Cube')!.material_slots[0]!;
    ok('material.procedural_set', { material: matId, channel: 'base_color', procedural: { type: 'NOISE' } });
    activePropertiesTab.value = 'material';
    const view = render(<Properties session={s} />);
    const scale0 = s.doc.getMaterial(matId)!.textures.base_color!.procedural!.scale;
    dragNumber(byTestId(view.container, 'tex-base_color-scale')!, 30, () =>
      remote(() => {
        const m = s.doc.getMaterial(matId)!;
        const roughness = {
          image: '',
          scale: [1, 1] as [number, number],
          offset: [0, 0] as [number, number],
        };
        s.doc.updateMaterial(matId, { roughness: 0.25, textures: { ...m.textures, roughness } });
      }),
    );
    const m = s.doc.getMaterial(matId)!;
    expect(m.textures.base_color!.procedural!.scale).toBeCloseTo(scale0 + 3);
    expect(m.textures.roughness).toBeTruthy();
    expect(m.roughness).toBe(0.25);
    view.unmount();

    activePropertiesTab.value = 'scene';
    const { container } = render(<Properties session={s} />);
    dragNumber(byTestId(container, 'scene-rigidbody-world-substeps_per_frame')!, 20, () =>
      remote(() => s.doc.updateScene({ gravity: [0, 0, -3] })),
    );
    expect(s.doc.getScene().gravity).toEqual([0, 0, -3]);
    expect(s.doc.getScene().rigidbody_world.substeps_per_frame).toBeGreaterThan(10);
  });
});

describe('animated fields', () => {
  /** Keys `path` of a datablock linearly: `a` at frame 1, `b` at frame 11. */
  const key = (target_type: string, target: string, path: string, a: number, b: number, index = -1) => {
    for (const [frame, value] of [
      [1, a],
      [11, b],
    ])
      ok('anim.keyframe_insert_property', {
        target_type,
        target,
        path,
        frame,
        value,
        index,
        interpolation: 'LINEAR',
      });
  };
  const shown = (container: ParentNode, id: string) => parseFloat(byTestId(container, id)!.textContent!);

  it('show the value at the current frame in the Material, World, Light and Camera panels', () => {
    // regression: they showed the stored value, not what the viewport and the renderers use
    s.doc.populateDefaultScene();
    select(s, 'Cube');
    ok('material.procedural_set', { channel: 'roughness', procedural: { type: 'NOISE', scale: 5 } });
    key('material', 'Cube', 'metallic', 0, 1);
    key('material', 'Cube', 'emission_strength', 0, 10);
    key('material', 'Cube', 'textures.roughness.procedural.scale', 5, 25, 0);
    ok('world.sky_set', { enable: true });
    key('world', 'world', 'strength', 1, 3);
    key('world', 'world', 'sun_elevation', 0.1, 1.1);
    key('world', 'world', 'mist_density', 0.01, 0.11);
    key('light', 'Light', 'energy', 100, 1100);
    key('camera', 'Camera', 'lens', 50, 100);
    key('camera', 'Camera', 'shift_x', 0, 0.4);
    // a driven field (no keyframes) shows the driven value too
    ok('anim.driver_add', {
      target_type: 'light',
      target: 'Light',
      path: 'shadow_soft_size',
      expression: 'frame / 10',
    });
    s.state.frame = 6;

    activePropertiesTab.value = 'material';
    const { container } = render(<Properties session={s} />);
    expect(shown(container, 'material-metallic')).toBeCloseTo(0.5, 3);
    expect(shown(container, 'material-emission-strength')).toBeCloseTo(5, 3);
    expect(shown(container, 'tex-roughness-scale')).toBeCloseTo(15, 3);
    expect(byTestId(container, 'tex-roughness-scale')!.className).toContain('animated');
    // not the stored value (which edits change and the animation overrides)
    const mat = s.doc.getMaterial(s.doc.findObjectByName('Cube')!.material_slots[0]!)!;
    expect(mat.metallic).toBe(0);
    // scrubbing updates the fields
    act(() => void (s.state.frame = 11));
    expect(shown(container, 'material-metallic')).toBeCloseTo(1, 3);
    expect(byTestId(container, 'material-metallic')!.className).toContain('keyed');
    act(() => void (s.state.frame = 6));

    act(() => void (activePropertiesTab.value = 'world'));
    expect(shown(container, 'world-strength')).toBeCloseTo(2, 3);
    expect(shown(container, 'world-sun-elevation')).toBeCloseTo((0.6 * 180) / Math.PI, 1);
    expect(shown(container, 'world-mist-density')).toBeCloseTo(0.06, 3);
    expect(shown(container, 'world-mist-distance')).toBeCloseTo(mistDensityForDistance(1) / 0.06, 1);

    act(() => {
      select(s, 'Light');
      activePropertiesTab.value = 'data';
    });
    expect(shown(container, 'light-energy')).toBeCloseTo(600, 3);
    expect(shown(container, 'light-radius')).toBeCloseTo(0.6, 3);
    act(() => select(s, 'Camera'));
    expect(shown(container, 'camera-lens')).toBeCloseTo(75, 3);
    expect(shown(container, 'camera-shift-x')).toBeCloseTo(0.2, 3);
    expect(byTestId(container, 'camera-fov')!.className).toContain('animated');
  });
});

describe('Object Data tab: cameras', () => {
  it('edits the depth of field the path tracer renders', () => {
    s.doc.populateDefaultScene();
    select(s, 'Camera');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const cam = () => s.doc.getCamera(s.doc.findObjectByName('Camera')!.data!)!;
    // the panel starts closed while depth of field is off
    expect(byTestId(container, 'camera-dof')).toBeNull();
    fireEvent.click(
      [...container.querySelectorAll('.panel-header')].find((h) => h.textContent === '▸Depth of Field')!,
    );
    fireEvent.click(
      byTestId(container, 'camera-dof')!.querySelector('input') ?? byTestId(container, 'camera-dof')!,
    );
    expect(cam().dof_use).toBe(true);
    typeNumber(byTestId(container, 'camera-dof-distance')!, '4.5');
    expect(cam().dof_focus_distance).toBeCloseTo(4.5);
    typeNumber(byTestId(container, 'camera-dof-fstop')!, '1.4');
    expect(cam().dof_aperture_fstop).toBeCloseTo(1.4);
  });

  it("shows Blender's Field of View (across the sensor) and keeps a typed angle with any Sensor Fit", () => {
    // regression: the field showed the vertical angle of the output (22.9° for 50 mm at 16:9,
    // Blender shows 39.6°) and converted a typed angle as if Sensor Fit were Auto
    s.doc.populateDefaultScene();
    s.doc.updateRender({ resolution_x: 1920, resolution_y: 1080 });
    select(s, 'Camera');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const camObj = s.doc.findObjectByName('Camera')!;
    const cam = () => s.doc.getCamera(camObj.data!)!;
    const fov = () => parseFloat(byTestId(container, 'camera-fov')!.textContent!);
    expect(cam().lens).toBe(50);
    expect(fov()).toBeCloseTo(39.598, 2);
    // the same angle camera.properties_set {angle} takes: setting it there keeps the lens
    ok('camera.properties_set', { object: 'Camera', angle: cameraFieldOfView(cam()) });
    expect(cam().lens).toBeCloseTo(50, 3);
    for (const [fit, w, h] of [
      ['AUTO', 1920, 1080],
      ['VERTICAL', 1920, 1080],
      ['HORIZONTAL', 1080, 1920],
    ] as const) {
      act(() => {
        s.doc.updateRender({ resolution_x: w, resolution_y: h });
        s.doc.updateBlockByKind('cameras', camObj.data!, { sensor_fit: fit, lens: 50 });
      });
      expect(fov()).toBeCloseTo(39.598, 2);
      typeNumber(byTestId(container, 'camera-fov')!, '40');
      expect(fov()).toBeCloseTo(40, 3);
      expect(cam().lens).toBeCloseTo(lensForFieldOfView((40 * Math.PI) / 180, 36), 6);
      expect(cam().lens).toBeCloseTo(49.452, 2);
    }
  });
});

describe('helpers', () => {
  it('maps the engine options of RPC renders (rasterized unless PATHTRACER is asked for)', () => {
    expect(rpcRenderEngineOptions({})).toEqual({ engine: 'RASTER' });
    expect(rpcRenderEngineOptions({ engine: 'RASTER', samples: 64 })).toEqual({ engine: 'RASTER' });
    expect(
      rpcRenderEngineOptions({
        engine: 'PATHTRACER',
        samples: 31.6,
        max_bounces: -2,
        denoise: false,
        time_limit: 5,
        seed: 'x',
      }),
    ).toEqual({ engine: 'PATHTRACER', samples: 32, max_bounces: 0, denoise: false, time_limit: 5 });
  });

  it('reads UI command parameters under the names MCP documents (view.set_view {view})', () => {
    // regression: `view.set_view {view: 'TOP'}` (as the editor_command tool documents it) went to FRONT
    const views = ['FRONT', 'TOP', 'CAMERA'] as const;
    expect(uiEnumParam({ view: 'TOP' }, ['view', 'type'], views, 'FRONT')).toBe('TOP');
    expect(uiEnumParam({ type: 'camera' }, ['view', 'type'], views, 'FRONT')).toBe('CAMERA');
    expect(uiEnumParam({}, ['view', 'type'], views, 'FRONT')).toBe('FRONT');
    expect(uiEnumParam({ view: null, type: 'top' }, ['view', 'type'], views, 'FRONT')).toBe('TOP');
    expect(() => uiEnumParam({ view: 'SIDE' }, ['view', 'type'], views, 'FRONT')).toThrow(
      "Unknown view 'SIDE': use one of FRONT, TOP, CAMERA",
    );
  });

  it('validates the frame of set_frame and the objects of select (MCP editor_command)', async () => {
    // regression: set_frame {frame: 'ten'} put the editor at frame NaN (animated objects vanished)
    // and reported {frame: null}; select silently skipped unknown names
    s.doc.populateDefaultScene();
    await expect(uiCommand('set_frame', { frame: 12 })).resolves.toEqual({ frame: 12 });
    await expect(uiCommand('set_frame', { frame: '24' })).resolves.toEqual({ frame: 24 });
    await expect(uiCommand('set_frame', { frame: 'ten' })).rejects.toThrow(
      `'frame' must be a number, got "ten"`,
    );
    await expect(uiCommand('set_frame', { frame: { at: 3 } })).rejects.toThrow(`'frame' must be a number`);
    await expect(uiCommand('set_frame', {})).rejects.toThrow(`'frame' is required: a number`);
    expect(s.state.frame).toBe(24);
    const cube = s.doc.findObjectByName('Cube')!;
    await expect(uiCommand('select', { objects: ['Cube'] })).resolves.toEqual({
      selected: [cube.id],
      names: ['Cube'],
    });
    await expect(uiCommand('select', { objects: ['Nope', 'Cube'] })).rejects.toThrow(
      /^Object not found: Nope \(selection unchanged\)\. Objects: .*Cube/,
    );
    await expect(uiCommand('select', { objects: [3] })).rejects.toThrow(`'objects' must be a list`);
    expect(s.state.selectedIds).toEqual([cube.id]);
    await expect(uiCommand('select', { objects: 'Light' })).resolves.toMatchObject({ names: ['Light'] });
    await expect(uiCommand('select', { objects: [] })).resolves.toEqual({ selected: [], names: [] });
    expect(s.state.activeId).toBeNull();
    await expect(uiCommand('set_frames', {})).rejects.toThrow(/set_frame \{frame: number\}/);
  });

  it('returns why a UI command failed to the agent instead of toasting it in the editor', async () => {
    // regression: set_mode / view.set_view / view.shading answered a bare {ok: false} and the reason
    // showed up as an error toast for the person at the browser; an invalid mode was not rejected
    // with the valid ones, and play {playing: 'false'} started playback
    if (!registry.has('view3d.view_camera')) registerUiOperators(registry);
    s.doc.populateDefaultScene();
    const errorToasts = () => toasts.value.filter((t) => t.level === 'error').map((t) => t.message);
    const before = errorToasts().length;
    await expect(uiCommand('set_mode', { mode: 'EDIT' })).resolves.toEqual({
      ok: false,
      mode: 'OBJECT',
      error: 'EDIT mode requires an active mesh object',
    });
    await expect(uiCommand('set_mode', { mode: 'BOGUS' })).rejects.toThrow(
      "Unknown mode 'BOGUS': use one of OBJECT, EDIT, SCULPT, VERTEX_PAINT",
    );
    select(s, 'Cube');
    await expect(uiCommand('set_mode', { mode: 'edit' })).resolves.toEqual({ ok: true, mode: 'EDIT' });
    await expect(uiCommand('set_mode', {})).resolves.toEqual({ ok: true, mode: 'OBJECT' });
    // the camera view, also when asked twice (view3d.view_camera toggles)
    viewport.engine = { requestRender: () => undefined } as unknown as ViewportEngine;
    await expect(uiCommand('view.set_view', { view: 'CAMERA' })).resolves.toEqual({
      ok: true,
      view: 'CAMERA',
    });
    await expect(uiCommand('view.set_view', { view: 'CAMERA' })).resolves.toEqual({
      ok: true,
      view: 'CAMERA',
    });
    expect(s.view.cameraView.value).toBe(true);
    s.view.cameraView.value = false;
    ok('object.delete', { objects: ['Camera'] });
    await expect(uiCommand('view.set_view', { view: 'CAMERA' })).resolves.toEqual({
      ok: false,
      view: 'CAMERA',
      error: 'No active camera in scene',
    });
    // a shading asked for twice stays (view3d.toggle_shading switches WIREFRAME back to SOLID)
    await expect(uiCommand('view.shading', { shading: 'WIREFRAME' })).resolves.toEqual({
      ok: true,
      shading: 'WIREFRAME',
    });
    await expect(uiCommand('view.shading', { shading: 'wireframe' })).resolves.toEqual({
      ok: true,
      shading: 'WIREFRAME',
    });
    // an operator run by the agent: its error goes back, not into a toast
    s.state.selectedIds = [];
    s.state.activeId = null;
    await expect(
      uiCommand('run_operator', { operator: 'object.mode_set', params: { mode: 'SCULPT' } }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'SCULPT mode requires an active mesh object',
    });
    expect(errorToasts().length).toBe(before);
    // play reads booleans, also as strings
    await expect(uiCommand('play', { playing: 'false' })).resolves.toEqual({ playing: false });
    await expect(uiCommand('play', {})).resolves.toEqual({ playing: true });
    await expect(uiCommand('play', { playing: false })).resolves.toEqual({ playing: false });
    await expect(uiCommand('play', { playing: 'maybe' })).rejects.toThrow(
      `'playing' must be true or false, got "maybe"`,
    );
    expect(s.view.playing.value).toBe(false);
    expect(uiBooleanParam({ x: 'TRUE' }, 'x', false)).toBe(true);
    expect(uiBooleanParam({ x: 0 }, 'x', true)).toBe(false);
  });

  it('renders MCP shading MATERIAL as a final render (materials, lights and the world)', () => {
    // regression: MATERIAL became the viewport's Material Preview (studio HDRI instead of the world)
    expect(rpcRenderShading(undefined)).toBeNull();
    expect(rpcRenderShading('MATERIAL')).toBe('RENDERED');
    expect(rpcRenderShading('material')).toBe('RENDERED');
    expect(rpcRenderShading('SOLID')).toBe('SOLID');
    expect(() => rpcRenderShading('TOON')).toThrow("Unknown shading 'TOON': use MATERIAL");
  });

  it('labels procedural parameters and values like Blender', () => {
    expect(paramLabel('mortar_size')).toBe('Mortar Size');
    expect(paramLabel('mortar_r')).toBe('Mortar R');
    expect(paramLabel('DISTANCE_TO_EDGE')).toBe('Distance to Edge');
    expect(paramLabel('QUADRATIC_SPHERE')).toBe('Quadratic Sphere');
    expect(paramLabel('SIN')).toBe('Sine');
    expect(paramLabel('color_randomness')).toBe('Random Color');
  });

  it('restores the dragged field of a procedural texture', () => {
    const tex = {
      type: 'NOISE' as const,
      mapping: 'GENERATED' as const,
      scale: 5,
      detail: 2,
      roughness: 0.5,
      distortion: 0,
      color_a: [0, 0, 0, 1] as [number, number, number, number],
      color_b: [1, 1, 1, 1] as [number, number, number, number],
      ramp_low: 0,
      ramp_high: 1,
      seed: 0,
      params: { noise_type: 'FBM', offset_x: 1 },
    };
    const now = { ...tex, scale: 9, seed: 4, params: { noise_type: 'RIDGED', offset_x: 3, offset_y: 2 } };
    expect(restoreProcedural(now, tex, 'scale', 9)).toEqual({ ...now, scale: 5 });
    expect(restoreProcedural(now, tex, 'params.noise_type', 'RIDGED').params).toEqual({
      noise_type: 'FBM',
      offset_x: 3,
      offset_y: 2,
    });
    expect(restoreProcedural(now, tex, 'params', { offset_x: 3, offset_y: 2 }).params).toEqual({
      noise_type: 'RIDGED',
      offset_x: 1,
    });
  });

  it('maps curve fields to their operators and keeps spline points', () => {
    expect(curveFieldOperator('o', 'bevel_depth', 1)).toEqual({
      id: 'curve.properties_set',
      params: { object: 'o', bevel_depth: 1 },
    });
    expect(curveFieldOperator('o', 'align_x', 'CENTER').id).toBe('font.text_set');
    const p = splinePointInput({
      co: [1, 2, 3],
      handle_left: null,
      handle_right: [0, 0, 1],
      handle_left_type: 'AUTO',
      handle_right_type: 'FREE',
      radius: 0.5,
      tilt: 0.1,
      weight: 2,
    });
    expect(p).toEqual({
      co: [1, 2, 3],
      handle_left: null,
      handle_right: [0, 0, 1],
      handle_left_type: 'AUTO',
      handle_right_type: 'FREE',
      radius: 0.5,
      tilt: 0.1,
      weight: 2,
    });
  });
});
