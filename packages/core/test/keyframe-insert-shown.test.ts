import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  defaultSpline,
  defaultSplinePoint,
  fcurveKey,
  insertKeyframe,
  type AnimTargetType,
  type OperatorContext,
} from '../src';

/*
 * Inserting a keyframe without a value keys what the property shows at the current frame, as
 * Blender keys a property's current value (the value its animation and drivers give it there),
 * also into another frame: anim.keyframe_insert (I, the keying sets), anim.keyframe_insert_property
 * (any animatable property, which the MCP insert_keyframe tool runs) and curve.keyframe_insert.
 */

const reg = createOperatorRegistry();

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const state = createEditorState();
  const ctx: OperatorContext = { doc, state, origin: doc.origin, source: 'test', report: () => undefined };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
  };
  /** Keys `path`[`index`] of a datablock `from` at frame 1 and `to` at frame 11 (linear). */
  const animate = (
    type: AnimTargetType,
    id: string,
    path: string,
    index: number,
    from: number,
    to: number,
  ) => {
    let fc = createFCurve({ target_type: type, target_id: id, path, index });
    fc = insertKeyframe(fc, 1, from, 'LINEAR');
    fc = insertKeyframe(fc, 11, to, 'LINEAR');
    doc.setFCurve(fc);
  };
  /** The keys of an F-curve as [frame, value] pairs. */
  const keys = (type: AnimTargetType, id: string, path: string, index: number) =>
    doc
      .getFCurve(fcurveKey({ target_type: type, target_id: id, path, index }))
      ?.keyframes.map((k) => [k.frame, k.value]);
  return { doc, state, run, animate, keys };
}

describe('keyframes inserted without a value get the value shown at the current frame', () => {
  it('anim.keyframe_insert keys an animated channel’s value and a driven channel’s value', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [7, 0, 0] });
    t.animate('object', id, 'location', 0, 0, 10);
    t.doc.setDriver({
      target_type: 'object',
      target_id: id,
      path: 'rotation_euler',
      index: 2,
      expression: '0.5',
      variables: [],
      mute: false,
    });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    t.state.frame = 6;
    t.run('anim.keyframe_insert', { type: 'LocRotScale' });
    expect(t.keys('object', id, 'location', 0)).toEqual([
      [1, 0],
      [6, 5],
      [11, 10],
    ]);
    expect(t.keys('object', id, 'rotation_euler', 2)).toEqual([[6, 0.5]]);
    // channels with neither keep their stored values
    expect(t.keys('object', id, 'location', 1)).toEqual([[6, 0]]);
    expect(t.keys('object', id, 'scale', 0)).toEqual([[6, 1]]);
  });

  it('a key at another frame gets the value shown at the current one; Available keys the animated channels', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    t.animate('object', id, 'location', 0, 0, 10);
    t.state.selectedIds = [id];
    t.state.activeId = id;
    t.state.frame = 6;
    t.run('anim.keyframe_insert', { type: 'Available', frame: 11 });
    expect(t.keys('object', id, 'location', 0)).toEqual([
      [1, 0],
      [11, 5],
    ]);
    expect(t.keys('object', id, 'location', 1)).toBeUndefined();
  });

  it('anim.keyframe_insert_property keys a pose bone’s and a light’s animated values', () => {
    const t = setup();
    t.run('object.armature_add', { name: 'Rig' });
    const rig = t.state.activeId!;
    const bone = t.doc.getArmature(t.doc.getObject(rig)!.data!)!.bones[0].name;
    const path = `pose.bones["${bone}"].location`;
    t.run('pose.bone_transform_set', { object: rig, bone, location: [0, 0, 0] });
    t.animate('object', rig, path, 1, 0, 10);
    t.run('object.light_add', { type: 'POINT', name: 'Lamp' });
    const lamp = t.state.activeId!;
    const light = t.doc.getObject(lamp)!.data!;
    t.animate('light', light, 'energy', 0, 100, 200);
    t.state.frame = 6;
    t.run('anim.keyframe_insert_property', { target_type: 'object', target: rig, path, index: 1 });
    expect(t.keys('object', rig, path, 1)).toEqual([
      [1, 0],
      [6, 5],
      [11, 10],
    ]);
    t.run('anim.keyframe_insert_property', { target_type: 'light', target: lamp, path: 'energy', frame: 3 });
    expect(t.keys('light', light, 'energy', 0)).toEqual([
      [1, 100],
      [3, 150],
      [11, 200],
    ]);
  });

  it('curve.keyframe_insert keys a curve’s animated value', () => {
    const t = setup();
    const data = t.doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([1, 0, 0])] },
      ],
    });
    const id = t.doc.addObject({ type: 'CURVE', name: 'Path', data });
    t.animate('curve', data, 'bevel_depth', 0, 0, 1);
    t.state.frame = 6;
    t.run('curve.keyframe_insert', { object: id, path: 'bevel_depth' });
    expect(t.keys('curve', data, 'bevel_depth', 0)).toEqual([
      [1, 0],
      [6, 0.5],
      [11, 1],
    ]);
  });
});
