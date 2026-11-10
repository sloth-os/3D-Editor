import { describe, expect, it } from 'vitest';
import {
  ObjectTransform,
  SceneDoc,
  axisAngle4,
  compose4,
  createEditorState,
  createOperatorRegistry,
  evaluateScene,
  identity4,
  multiply4,
  transformFrameState,
  translation4,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';
import { matrixToEuler } from '../src/constraints/math';

/*
 * Move, Rotate and Scale of a rigid body while the simulation runs (after the rigid body world's
 * frame_start), as Blender does it:
 * - ObjectToTransData (transform_convert_object.cc) reads the location and rotation from the
 *   simulated world matrix ("Update object's loc/rot to get current rigid body transform"), so the
 *   transform starts where the viewport shows the body;
 * - while it is transformed the body follows its channels (rigidbody.cc sync_transforms leaves out
 *   selected objects while G.moving is set), so the preview moves it on from there;
 * - confirming keeps those channels: the stored location and rotation are the simulated ones plus
 *   the transform; cancelling restores the channels held before (BKE_rigidbody_aftertrans_update).
 * At or before frame_start the simulation does not run and the transform reads the channels.
 */

const reg = createOperatorRegistry();
const deg = Math.PI / 180;

const maxDiff = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const translationOf = (m: Mat4): Vec3 => [m[12], m[13], m[14]];

/**
 * A cube dropped (tilted 0.3 rad about X) from z = 5 onto a passive plane, with an empty parented
 * to it; `patch` changes the cube before the simulation (its scale, its parent).
 */
function fallingCube(patch: (doc: SceneDoc, cube: string) => void = () => undefined) {
  const doc = SceneDoc.create({ empty: true });
  const state = createEditorState();
  const ctx: OperatorContext = { doc, state, origin: doc.origin, source: 'test', report: () => undefined };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
  };
  run('mesh.primitive_plane_add', { size: 20 });
  run('rigidbody.object_add', { type: 'PASSIVE' });
  run('mesh.primitive_cube_add', { location: [0, 0, 5], rotation: [0.3, 0, 0] });
  const cube = state.activeId!;
  run('rigidbody.object_add', { type: 'ACTIVE' });
  patch(doc, cube);
  const child = doc.addObject({ type: 'EMPTY', name: 'Child', parent: cube, location: [0, 0, 2] });
  const select = () => {
    state.selectedIds = [cube];
    state.activeId = cube;
  };
  return { doc, state, run, cube, child, select };
}

describe('Move, Rotate and Scale of a rigid body while the simulation runs', () => {
  it('Move starts where the simulation shows the body, previews it moved on from there and stores that', () => {
    const { doc, state, run, cube, child, select } = fallingCube();
    state.frame = 30;
    const ev = evaluateScene(doc, 30).byId.get(cube)!;
    expect(ev.simulated).toBe(true);
    const shown = ev.worldMatrix;
    // the cube lies on the plane (z ≈ 1), far from its channels (z = 5, tilted 0.3 rad)
    expect(Math.abs(shown[14] - 1)).toBeLessThan(1e-2);
    const xf = new ObjectTransform(transformFrameState(doc, 30), [cube], 'MEDIAN_POINT', 'TRANSLATE');
    const t = xf.targets[0];
    expect(maxDiff(t.channels.location, translationOf(shown))).toBeLessThan(1e-12);
    expect(
      maxDiff(compose4(t.channels.location, t.channels.rotation_euler, t.channels.scale), shown),
    ).toBeLessThan(1e-12);
    // what the channels hold until the transform writes them
    expect(t.held.location).toEqual([0, 0, 5]);
    expect(maxDiff(xf.pivot(state), translationOf(shown))).toBeLessThan(1e-12);

    const still = xf.worlds(xf.channels(identity4(), [0, 0, 0]));
    expect(maxDiff(still.get(cube)!, shown)).toBeLessThan(1e-12);
    const moved = xf.worlds(xf.channels(translation4([1, 0, 0]), [0, 0, 0]));
    const expected = multiply4(translation4([1, 0, 0]), shown);
    expect(maxDiff(moved.get(cube)!, expected)).toBeLessThan(1e-12);
    // its child follows it
    expect(maxDiff(moved.get(child)!, multiply4(expected, translation4([0, 0, 2])))).toBeLessThan(1e-12);

    select();
    run('transform.translate', { value: [1, 0, 0] });
    const stored = doc.getObject(cube)!;
    expect(maxDiff(stored.location, translationOf(expected))).toBeLessThan(1e-12);
    expect(maxDiff(stored.rotation_euler, matrixToEuler(shown))).toBeLessThan(1e-12);
    expect(stored.scale).toEqual([1, 1, 1]);
    expect(maxDiff(compose4(stored.location, stored.rotation_euler, stored.scale), expected)).toBeLessThan(
      1e-12,
    );
  });

  it('Rotate turns the body about where the simulation shows it', () => {
    const { doc, state, run, cube, select } = fallingCube();
    state.frame = 30;
    const shown = evaluateScene(doc, 30).byId.get(cube)!.worldMatrix;
    select();
    run('transform.rotate', { value: 90 * deg, orient_axis: 'Z' });
    const stored = doc.getObject(cube)!;
    // the pivot (median point) is the body's simulated origin: it stays there
    expect(maxDiff(stored.location, translationOf(shown))).toBeLessThan(1e-12);
    const turned = multiply4(axisAngle4([0, 0, 1], 90 * deg), shown);
    turned[12] = shown[12];
    turned[13] = shown[13];
    turned[14] = shown[14];
    expect(maxDiff(compose4(stored.location, stored.rotation_euler, stored.scale), turned)).toBeLessThan(
      1e-12,
    );
  });

  it('Move along LOCAL axes moves along the axes the simulation shows', () => {
    const { doc, state, run, cube, select } = fallingCube();
    state.frame = 30;
    const shown = evaluateScene(doc, 30).byId.get(cube)!.worldMatrix;
    select();
    run('transform.translate', { value: [0, 0, 1], orient_type: 'LOCAL' });
    const z: Vec3 = [shown[8], shown[9], shown[10]];
    const len = Math.hypot(...z);
    const expected = translationOf(shown).map((v, i) => v + z[i] / len);
    expect(maxDiff(doc.getObject(cube)!.location, expected)).toBeLessThan(1e-12);
  });

  it('the Snap menu reads where the simulation shows the body, as Blender’s snapping reads its matrix', () => {
    const { doc, state, run, cube, select } = fallingCube();
    state.frame = 30;
    const shown = evaluateScene(doc, 30).byId.get(cube)!.worldMatrix;
    select();
    run('view3d.snap_cursor_to_selected');
    expect(maxDiff(state.cursorLocation, translationOf(shown))).toBeLessThan(1e-12);
    run('view3d.snap_cursor_to_active');
    expect(maxDiff(state.cursorLocation, translationOf(shown))).toBeLessThan(1e-12);
    // snap_selected_to_location adds the offset from where the object shows to its channels
    state.cursorLocation = [3, 0, 1];
    run('view3d.snap_selected_to_cursor');
    const offset = [3 - shown[12], -shown[13], 1 - shown[14]];
    expect(maxDiff(doc.getObject(cube)!.location, [offset[0], offset[1], 5 + offset[2]])).toBeLessThan(1e-12);
  });

  it('at the frame_start of the rigid body world the transform reads the channels', () => {
    const { doc, state, run, cube, select } = fallingCube();
    state.frame = 1;
    expect(evaluateScene(doc, 1).byId.get(cube)!.simulated).toBe(false);
    const xf = new ObjectTransform(transformFrameState(doc, 1), [cube], 'MEDIAN_POINT', 'TRANSLATE');
    expect(xf.targets[0].channels.location).toEqual([0, 0, 5]);
    select();
    run('transform.translate', { value: [1, 0, 0] });
    const stored = doc.getObject(cube)!;
    expect(stored.location).toEqual([1, 0, 5]);
    expect(stored.rotation_euler).toEqual([0.3, 0, 0]);
  });
  it('a simulation starting before frame 1 runs at frame 1: the transform reads where it shows the body', () => {
    const { doc, state, run, cube } = fallingCube();
    run('rigidbody.world_set', { frame_start: -20 });
    state.frame = 1;
    const ev = evaluateScene(doc, 1).byId.get(cube)!;
    expect(ev.simulated).toBe(true);
    expect(ev.worldMatrix[14]).toBeLessThan(4);
    const xf = new ObjectTransform(transformFrameState(doc, 1), [cube], 'MEDIAN_POINT', 'TRANSLATE');
    expect(maxDiff(xf.targets[0].channels.location, translationOf(ev.worldMatrix))).toBeLessThan(1e-12);
  });

  it('a mirrored body keeps its scale: the rotation is read without the mirror', () => {
    const { doc, state, run, cube, select } = fallingCube((d, id) =>
      d.updateObject(id, { scale: [1, -1, 1] }),
    );
    // at frame 12 it is still falling, turned 0.3 rad about X as it started
    state.frame = 12;
    const shown = evaluateScene(doc, 12).byId.get(cube)!.worldMatrix;
    expect(shown[14]).toBeLessThan(4.5);
    const xf = new ObjectTransform(transformFrameState(doc, 12), [cube], 'MEDIAN_POINT', 'TRANSLATE');
    const t = xf.targets[0];
    expect(t.channels.scale).toEqual([1, -1, 1]);
    expect(maxDiff(t.channels.rotation_euler, [0.3, 0, 0])).toBeLessThan(1e-9);
    expect(
      maxDiff(compose4(t.channels.location, t.channels.rotation_euler, t.channels.scale), shown),
    ).toBeLessThan(1e-12);
    select();
    run('transform.translate', { value: [0, 1, 0] });
    const stored = doc.getObject(cube)!;
    expect(
      maxDiff(
        compose4(stored.location, stored.rotation_euler, stored.scale),
        multiply4(translation4([0, 1, 0]), shown),
      ),
    ).toBeLessThan(1e-12);
  });

  it('a parented body: the simulated matrix is taken into its parent’s space', () => {
    let parent = '';
    const { doc, state, run, cube, select } = fallingCube((d, id) => {
      parent = d.addObject({
        type: 'EMPTY',
        name: 'Parent',
        location: [2, 0, 0],
        rotation_euler: [0, 0, 90 * deg],
      });
      d.updateObject(id, { parent });
    });
    state.frame = 30;
    const ev = evaluateScene(doc, 30);
    expect(ev.byId.get(cube)!.simulated).toBe(true);
    const shown = ev.byId.get(cube)!.worldMatrix;
    const parentWorld = ev.byId.get(parent)!.worldMatrix;
    const xf = new ObjectTransform(transformFrameState(doc, 30), [cube], 'MEDIAN_POINT', 'TRANSLATE');
    const t = xf.targets[0];
    const local = (c: typeof t.channels) =>
      multiply4(parentWorld, compose4(c.location, c.rotation_euler, c.scale));
    expect(maxDiff(local(t.channels), shown)).toBeLessThan(1e-12);
    select();
    run('transform.translate', { value: [1, 0, 0] });
    expect(maxDiff(local(doc.getObject(cube)!), multiply4(translation4([1, 0, 0]), shown))).toBeLessThan(
      1e-12,
    );
  });
});
