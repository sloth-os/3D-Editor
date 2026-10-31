import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import { defaultBone, defaultSpline, defaultSplinePoint } from '../src/doc/defaults';
import type { ConstraintData } from '../src/doc/types';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { OperatorRegistry } from '../src/operators/registry';
import { registerConstraintOperators } from '../src/operators/constraint';
import { FrameState } from '../src/eval/frame-state';
import { compose4, decompose4, invert4, lookAt4, multiply4, type Mat4, type Vec3 } from '../src/math';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = new OperatorRegistry();
  registerConstraintOperators(reg);
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push(`${level}: ${message}`),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const fs = () => new FrameState(doc, ctx.state.frame);
  const world = (id: string): Mat4 => fs().world(id)!;
  const constraints = (id: string): ConstraintData[] => doc.getObject(id)!.constraints;
  const select = (ids: string[], active = ids[ids.length - 1]) => {
    ctx.state.selectedIds = ids;
    ctx.state.activeId = active;
  };
  return { doc, reg, ctx, run, reports, world, fs, constraints, select };
}

const loc = (m: Mat4): Vec3 => [m[12], m[13], m[14]];

function expectVec(a: readonly number[], b: readonly number[], digits = 5) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
}

function addCircle(doc: SceneDoc, name: string, radius: number, cyclic = true, n = 64): string {
  const points = Array.from({ length: n }, (_, i) =>
    defaultSplinePoint([
      radius * Math.cos((2 * Math.PI * i) / n),
      radius * Math.sin((2 * Math.PI * i) / n),
      0,
    ]),
  );
  const data = doc.addCurve({ name, splines: [{ ...defaultSpline('POLY'), use_cyclic_u: cyclic, points }] });
  return doc.addObject({ type: 'CURVE', name, data });
}

describe('object.constraint_add', () => {
  it('adds constraints with Blender names, resolves types and targets by name', () => {
    const { doc, run, world, constraints } = setup();
    const cam = doc.addObject({ type: 'CAMERA', name: 'Camera', location: [6, -6, 4] });
    const target = doc.addObject({ type: 'EMPTY', name: 'Focus', location: [1, 1, 0] });
    const r = run('object.constraint_add', { object: 'Camera', type: 'TRACK_TO', target: 'Focus' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({
      name: 'Track To',
      type: 'TRACK_TO',
      object: cam,
      index: 0,
      target,
      errors: [],
    });
    expect(constraints(cam)[0]).toMatchObject({
      id: r.result.constraint,
      target,
      influence: 1,
      mute: false,
      params: { track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y', target_space: 'WORLD' },
    });
    expectVec(world(cam), invert4(lookAt4([6, -6, 4], [1, 1, 0], [0, 0, 1])));
    expect(run('object.constraint_add', { object: cam, type: 'track to', target }).result.name).toBe(
      'Track To.001',
    );
    expect(
      run('object.constraint_add', { object: cam, type: 'Damped Track', target, name: 'Aim' }).result.name,
    ).toBe('Aim');
    expect(constraints(cam).map((c) => c.type)).toEqual(['TRACK_TO', 'TRACK_TO', 'DAMPED_TRACK']);
  });

  it('validates types, parameters, targets and bone sub-targets', () => {
    const { doc, run, constraints } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    doc.addObject({ type: 'EMPTY', name: 'T' });
    const armData = doc.addArmature({
      bones: [defaultBone('Spine'), defaultBone('Head', [0, 0, 1], [0, 0, 2])],
    });
    doc.addObject({ type: 'ARMATURE', name: 'Rig', data: armData });
    const err = (params: Record<string, unknown>) =>
      run('object.constraint_add', { object: 'O', ...params }).error;
    expect(err({ type: 'FLUFFY' })).toMatch(/Unknown constraint type 'FLUFFY'. Valid types: .*TRACK_TO/);
    expect(err({ type: 'IK', target: 'T' })).toMatch(/pose bones/);
    expect(err({ type: 'TRACK_TO', target: 'T', params: { track: 'TRACK_X' } })).toMatch(
      /Unknown parameter 'track'.*Valid parameters: track_axis, up_axis/,
    );
    expect(err({ type: 'TRACK_TO', target: 'T', params: { track_axis: 'SIDEWAYS' } })).toMatch(/track_axis/);
    expect(err({ type: 'COPY_LOCATION', target: 'Nope' })).toMatch(/Target object 'Nope' not found/);
    expect(err({ type: 'COPY_LOCATION', target: 'O' })).toMatch(/own constraint/);
    expect(err({ type: 'FOLLOW_PATH', target: 'T' })).toMatch(/needs a CURVE target/);
    expect(err({ type: 'LIMIT_LOCATION', target: 'T' })).toMatch(/do not use a target/);
    expect(err({ type: 'COPY_LOCATION', target: 'T', subtarget: 'Bone' })).toMatch(
      /needs an armature target/,
    );
    expect(err({ type: 'COPY_LOCATION', target: 'Rig', subtarget: 'Tail' })).toMatch(
      /Bone 'Tail' not found.*'Spine', 'Head'/,
    );
    expect(err({ type: 'FOLLOW_PATH', target: 'Rig', subtarget: 'Head' })).toMatch(/needs a CURVE/);
    expect(err({ type: 'COPY_LOCATION', influence: 2 })).toMatch(/influence/);
    expect(constraints(o)).toHaveLength(0);
    const ok = run('object.constraint_add', {
      object: 'O',
      type: 'COPY_LOCATION',
      target: 'Rig',
      subtarget: 'Head',
    });
    expect(ok.ok).toBe(true);
    expect(constraints(o)[0]).toMatchObject({ subtarget: 'Head' });
  });

  it('reports evaluation problems of new constraints', () => {
    const { doc, run, reports } = setup();
    doc.addObject({ type: 'EMPTY', name: 'O' });
    const r = run('object.constraint_add', { object: 'O', type: 'COPY_ROTATION' });
    expect(r.ok).toBe(true);
    expect(r.result.errors).toEqual(['No target object set']);
    expect(reports.some((m) => m.startsWith('WARNING') && /No target/.test(m))).toBe(true);
  });

  it('uses the active object by default', () => {
    const { doc, run, ctx, constraints } = setup();
    expect(run('object.constraint_add', { type: 'LIMIT_SCALE' }).error).toMatch(/No active object/);
    const o = doc.addObject({ type: 'MESH', name: 'Box' });
    ctx.state.activeId = o;
    expect(
      run('object.constraint_add', { type: 'LIMIT_SCALE', params: { use_min_x: true, min_x: 0.5 } }).ok,
    ).toBe(true);
    expect(constraints(o)[0].params).toMatchObject({ use_min_x: true, min_x: 0.5 });
  });
});

describe('Child Of operators', () => {
  it('sets the inverse on creation so the child keeps its place, and follows the parent afterwards', () => {
    const { doc, run, world, constraints } = setup();
    const parent = doc.addObject({
      type: 'EMPTY',
      name: 'Parent',
      location: [3, 0, 0],
      rotation_euler: [0, 0, 0.5],
    });
    const child = doc.addObject({ type: 'EMPTY', name: 'Child', location: [0, 2, 1] });
    const before = world(child);
    expect(
      run('object.constraint_add', { object: 'Child', type: 'CHILD_OF', target: 'Parent' }).result.errors,
    ).toEqual([]);
    expect(constraints(child)[0].params.set_inverse_pending).toBe(false);
    expectVec(world(child), before);
    doc.updateObject(parent, { location: [5, 0, 0] });
    expectVec(loc(world(child)), [2, 2, 1]);
    // clear inverse: plain parenting (child local transform in the parent's space)
    run('constraint.childof_clear_inverse', { object: 'Child', constraint: 'Child Of' });
    expectVec(
      world(child),
      multiply4(compose4([5, 0, 0], [0, 0, 0.5], [1, 1, 1]), compose4([0, 2, 1], [0, 0, 0], [1, 1, 1])),
    );
    const r = run('constraint.childof_set_inverse', { object: 'Child', constraint: 'Child Of' });
    expect(r.result.inverse_matrix).toHaveLength(16);
    expectVec(loc(world(child)), [0, 2, 1]);
    expect(run('constraint.childof_set_inverse', { object: 'Parent', constraint: 'Child Of' }).ok).toBe(
      false,
    );
  });

  it('computes a pending inverse when the target is assigned later', () => {
    const { doc, run, world } = setup();
    doc.addObject({ type: 'EMPTY', name: 'P', location: [0, 0, 4], scale: [2, 2, 2] });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', location: [1, 0, 0] });
    expect(run('object.constraint_add', { object: 'C', type: 'CHILD_OF' }).result.errors).toEqual([
      'No target object set',
    ]);
    const r = run('constraint.update', { object: 'C', constraint: 'Child Of', target: 'P' });
    expect(r.result.params.set_inverse_pending).toBe(false);
    expectVec(loc(world(c)), [1, 0, 0]);
    expect(run('constraint.childof_set_inverse', { object: 'C', constraint: 'Missing' }).error).toMatch(
      /not found/,
    );
  });
});

describe('constraint.update / delete / move / apply', () => {
  it('patches parameters, influence, mute, target and name (animation follows renames)', () => {
    const { doc, run, world, constraints } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    doc.addObject({ type: 'EMPTY', name: 'A', location: [4, 0, 0] });
    doc.addObject({ type: 'EMPTY', name: 'B', location: [0, 8, 0] });
    run('object.constraint_add', { object: 'O', type: 'COPY_LOCATION', target: 'A' });
    let fc = createFCurve({
      target_type: 'object',
      target_id: o,
      path: 'constraints["Copy Location"].influence',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 1);
    doc.setFCurve(fc);
    const r = run('constraint.update', {
      object: 'O',
      constraint: 'Copy Location',
      params: { use_y: false },
      influence: 0.5,
      name: 'Follow',
    });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ name: 'Follow', influence: 0.5, params: { use_y: false, use_x: true } });
    expect(doc.listFCurves(o).map((f) => f.path)).toEqual(['constraints["Follow"].influence']);
    expectVec(loc(world(o)), [4, 0, 0]); // the animated influence (1) wins over the stored 0.5
    doc.removeFCurve(`object:${o}:constraints["Follow"].influence:0`);
    expectVec(loc(world(o)), [2, 0, 0]);
    run('constraint.update', {
      object: 'O',
      constraint: 'Follow',
      target: 'B',
      influence: 1,
      params: { use_y: true },
    });
    expectVec(loc(world(o)), [0, 8, 0]);
    run('constraint.update', { object: 'O', constraint: 'Follow', mute: true });
    expectVec(loc(world(o)), [0, 0, 0]);
    expect(
      run('constraint.update', { object: 'O', constraint: 'Follow', params: { use_w: true } }).error,
    ).toMatch(/Unknown parameter 'use_w'/);
    expect(
      run('constraint.update', { object: 'O', constraint: 'Follow', target: '' }).result.target,
    ).toBeNull();
    expect(constraints(o)[0].name).toBe('Follow');
  });

  it('keeps bone sub-targets only while the target has the bone', () => {
    const { doc, run, constraints } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    const arm = doc.addArmature({ bones: [defaultBone('Bone')] });
    doc.addObject({ type: 'ARMATURE', name: 'Rig', data: arm });
    doc.addObject({ type: 'EMPTY', name: 'E' });
    run('object.constraint_add', { object: 'O', type: 'COPY_ROTATION', target: 'Rig', subtarget: 'Bone' });
    run('constraint.update', { object: 'O', constraint: 'Copy Rotation', target: 'E' });
    expect(constraints(o)[0]).toMatchObject({ subtarget: '' });
  });

  it('deletes, reorders and clears constraints', () => {
    const { doc, run, constraints, select } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    const p = doc.addObject({ type: 'EMPTY', name: 'P' });
    for (const type of ['LIMIT_LOCATION', 'LIMIT_ROTATION', 'LIMIT_SCALE'])
      run('object.constraint_add', { object: 'O', type });
    let fc = createFCurve({
      target_type: 'object',
      target_id: o,
      path: 'constraints["Limit Rotation"].influence',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0.5);
    doc.setFCurve(fc);
    expect(
      run('constraint.move_to_index', { object: 'O', constraint: 'Limit Scale', index: 0 }).result.index,
    ).toBe(0);
    expect(constraints(o).map((c) => c.name)).toEqual(['Limit Scale', 'Limit Location', 'Limit Rotation']);
    expect(
      run('constraint.move_to_index', { object: 'O', constraint: 'Limit Scale', index: 99 }).result.index,
    ).toBe(2);
    expect(run('constraint.delete', { object: 'O', constraint: 'Limit Rotation' }).result.name).toBe(
      'Limit Rotation',
    );
    expect(doc.listFCurves(o)).toHaveLength(0);
    expect(run('constraint.delete', { object: 'O', constraint: 'Limit Rotation' }).error).toMatch(
      /not found on 'O' \(constraints: 'Limit Location', 'Limit Scale'\)/,
    );
    run('object.constraint_add', { object: 'P', type: 'LIMIT_LOCATION' });
    select([o, p]);
    expect(run('object.constraints_clear').result).toEqual({ cleared: 3, objects: [o, p] });
    expect(constraints(o)).toHaveLength(0);
    expect(constraints(p)).toHaveLength(0);
  });

  it('applies a constraint into the transform and removes it', () => {
    const { doc, run, world, constraints, reports } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O', location: [0, -5, 0], scale: [2, 2, 2] });
    doc.addObject({ type: 'EMPTY', name: 'T', location: [3, 0, 0] });
    run('object.constraint_add', { object: 'O', type: 'DAMPED_TRACK', target: 'T' });
    run('object.constraint_add', {
      object: 'O',
      type: 'LIMIT_LOCATION',
      params: { use_max_y: true, max_y: -2 },
    });
    const visual = world(o);
    const r = run('constraint.apply', { object: 'O', constraint: 'Damped Track' });
    expect(r.ok).toBe(true);
    expect(constraints(o).map((c) => c.type)).toEqual(['LIMIT_LOCATION']);
    expectVec(world(o), visual);
    expectVec(doc.getObject(o)!.scale, [2, 2, 2]);
    expect(reports).toContain('INFO: Applied constraint: Damped Track');
    // a constraint below others bakes the whole stack up to it (and warns)
    run('object.constraint_add', {
      object: 'O',
      type: 'COPY_LOCATION',
      target: 'T',
      params: { use_y: false, use_z: false },
    });
    const r2 = run('constraint.apply', { object: 'O', constraint: 'Copy Location' });
    expect(r2.result.location[0]).toBeCloseTo(3);
    expect(reports.some((m) => /not first/.test(m))).toBe(true);
    // failing constraints are not applied
    run('object.constraint_add', { object: 'O', type: 'TRACK_TO' });
    const bad = run('constraint.apply', { object: 'O', constraint: 'Track To' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/No target object set/);
    expect(constraints(o)).toHaveLength(2);
  });

  it('applies relative to the parent and keeps animated channels in sync', () => {
    const { doc, run, world } = setup();
    const parent = doc.addObject({
      type: 'EMPTY',
      name: 'P',
      location: [10, 0, 0],
      rotation_euler: [0, 0, Math.PI / 2],
    });
    const o = doc.addObject({ type: 'EMPTY', name: 'O', parent, location: [1, 0, 0] });
    doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 0, 7] });
    for (const index of [0, 1, 2]) {
      let fc = createFCurve({ target_type: 'object', target_id: o, path: 'location', index });
      fc = insertKeyframe(fc, 1, index === 0 ? 1 : 0);
      doc.setFCurve(fc);
    }
    run('object.constraint_add', { object: 'O', type: 'COPY_LOCATION', target: 'T' });
    run('constraint.apply', { object: 'O', constraint: 'Copy Location' });
    expectVec(loc(world(o)), [0, 0, 7]);
    expectVec(doc.getObject(o)!.location, [0, 10, 7]);
  });
});

describe('Limit Distance operators', () => {
  it('initialises the distance on creation and resets it on demand', () => {
    const { doc, run, world, constraints } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O', location: [3, 4, 0] });
    doc.addObject({ type: 'EMPTY', name: 'T' });
    run('object.constraint_add', { object: 'O', type: 'LIMIT_DISTANCE', target: 'T' });
    expect(constraints(o)[0].params.distance).toBeCloseTo(5);
    doc.updateObject(o, { location: [30, 40, 0] });
    expectVec(loc(world(o)), [3, 4, 0]);
    expect(
      run('constraint.limitdistance_reset', { object: 'O', constraint: 'Limit Distance' }).result.distance,
    ).toBeCloseTo(50);
    expectVec(loc(world(o)), [30, 40, 0]);
    run('constraint.update', { object: 'O', constraint: 'Limit Distance', params: { distance: 10 } });
    expectVec(loc(world(o)), [6, 8, 0]);
  });
});

describe('Follow Path operators', () => {
  it('animates the curve eval_time so the owner travels a circle', () => {
    const { doc, run, world, ctx } = setup();
    addCircle(doc, 'Circle', 2);
    const o = doc.addObject({ type: 'EMPTY', name: 'Rider' });
    run('object.constraint_add', {
      object: 'Rider',
      type: 'FOLLOW_PATH',
      target: 'Circle',
      params: { use_curve_follow: true },
    });
    const r = run('constraint.followpath_path_animate', {
      object: 'Rider',
      constraint: 'Follow Path',
      frame_start: 1,
      length: 100,
    });
    expect(r.result).toMatchObject({
      target_type: 'curve',
      path: 'eval_time',
      frame_start: 1,
      frame_end: 101,
      value_end: 100,
      extrapolation: 'LINEAR',
    });
    const at = (frame: number) => {
      ctx.state.frame = frame;
      return world(o);
    };
    expectVec(loc(at(1)), [2, 0, 0]);
    expectVec(loc(at(26)), [0, 2, 0]);
    expectVec(loc(at(51)), [-2, 0, 0]);
    expectVec(loc(at(126)), [0, 2, 0]); // cyclic: keeps looping after the animated range
    const m = at(26);
    // forward (+Y) follows the tangent (moving towards -X at the top of the circle), +Z stays up
    expect(m[4]).toBeLessThan(-0.99);
    expect(m[10]).toBeGreaterThan(0.99);
  });

  it('stops at the end of open paths and animates offset_factor without a target', () => {
    const { doc, run, world, ctx, constraints } = setup();
    addCircle(doc, 'Arc', 1, false, 9);
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    run('object.constraint_add', { object: 'O', type: 'FOLLOW_PATH', target: 'Arc' });
    const r = run('constraint.followpath_path_animate', {
      object: 'O',
      constraint: 'Follow Path',
      frame_start: 10,
      length: 20,
    });
    expect(r.result.extrapolation).toBe('CONSTANT');
    ctx.state.frame = 500;
    const end = loc(world(o));
    expectVec(end, [Math.cos((2 * Math.PI * 8) / 9), Math.sin((2 * Math.PI * 8) / 9), 0]);
    const free = doc.addObject({ type: 'EMPTY', name: 'Free' });
    run('object.constraint_add', { object: 'Free', type: 'FOLLOW_PATH' });
    const r2 = run('constraint.followpath_path_animate', { object: 'Free', constraint: 'Follow Path' });
    expect(r2.result).toMatchObject({
      target_type: 'object',
      path: 'constraints["Follow Path"].offset_factor',
      value_end: 1,
    });
    expect(constraints(free)[0].params.use_fixed_location).toBe(true);
    expect(run('constraint.followpath_path_animate', { object: 'O', constraint: 'Nope' }).ok).toBe(false);
  });
});

describe('object.track_set and object.visual_transform_apply', () => {
  it('adds AutoTrack constraints to the selection aiming at the active object', () => {
    const { doc, run, select, constraints, world } = setup();
    const cam = doc.addObject({ type: 'CAMERA', name: 'Cam', location: [0, -10, 0] });
    const lamp = doc.addObject({ type: 'LIGHT', name: 'Lamp', location: [5, 0, 5] });
    const box = doc.addObject({ type: 'MESH', name: 'Box', location: [0, 0, 0] });
    const goal = doc.addObject({ type: 'EMPTY', name: 'Goal', location: [0, 0, 0] });
    select([cam, lamp, box, goal], goal);
    const r = run('object.track_set', { type: 'DAMPTRACK' });
    expect(r.result.constraints).toHaveLength(3);
    expect(constraints(cam)[0]).toMatchObject({
      name: 'AutoTrack',
      type: 'DAMPED_TRACK',
      target: goal,
      params: { track_axis: 'TRACK_NEGATIVE_Z' },
    });
    expect(constraints(box)[0].params.track_axis).toBe('TRACK_Y');
    expect(world(cam)[9]).toBeCloseTo(-1); // camera -Z (column 2 = 0,-1,0 negated) now points at the goal
    run('object.track_set', { type: 'LOCKTRACK', objects: ['Lamp'], target: 'Goal' });
    expect(constraints(lamp)[1]).toMatchObject({
      name: 'AutoTrack.001',
      type: 'LOCKED_TRACK',
      params: { track_axis: 'TRACK_NEGATIVE_Z', lock_axis: 'LOCK_Y' },
    });
    run('object.track_set', { objects: ['Box'], target: 'Goal' });
    expect(constraints(box)[1]).toMatchObject({
      type: 'TRACK_TO',
      params: { track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y' },
    });
    select([goal], goal);
    expect(run('object.track_set').error).toMatch(/No objects to add tracking to/);
  });

  it('copies the visual transform into the object properties', () => {
    const { doc, run, world, select } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O', location: [0, 0, 0], rotation_euler: [0, 0, 6.2] });
    doc.addObject({
      type: 'EMPTY',
      name: 'T',
      location: [2, 3, 4],
      rotation_euler: [0.1, 0.2, 0.3],
      scale: [1, 2, 3],
    });
    run('object.constraint_add', { object: 'O', type: 'COPY_TRANSFORMS', target: 'T' });
    const visual = world(o);
    select([o]);
    const r = run('object.visual_transform_apply');
    expect(r.ok).toBe(true);
    const d = doc.getObject(o)!;
    expectVec(d.location, [2, 3, 4]);
    expectVec(d.scale, [1, 2, 3]);
    // eulers stay compatible with the previous rotation (6.2 rad): 0.3 + 2π instead of 0.3
    expectVec(d.rotation_euler, [0.1, 0.2, 0.3 + 2 * Math.PI]);
    run('constraint.delete', { object: 'O', constraint: 'Copy Transforms' });
    expectVec(world(o), visual);
    expect(decompose4(world(o)).rotation[2]).toBeCloseTo(0.3);
  });
});

describe('undo, description and persistence', () => {
  it('makes every operator one undo step', () => {
    const { doc, run, constraints } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const o = doc.transact(() => doc.addObject({ type: 'EMPTY', name: 'O' }), 'setup');
    doc.transact(() => doc.addObject({ type: 'EMPTY', name: 'T', location: [1, 2, 3] }), 'setup');
    run('object.constraint_add', { object: 'O', type: 'CHILD_OF', target: 'T' });
    run('constraint.update', { object: 'O', constraint: 'Child Of', influence: 0.25 });
    run('constraint.apply', { object: 'O', constraint: 'Child Of' });
    expect(constraints(o)).toHaveLength(0);
    um.undo();
    expect(constraints(o)[0].influence).toBe(0.25);
    um.undo();
    expect(constraints(o)[0].influence).toBe(1);
    expect(constraints(o)[0].params.set_inverse_pending).toBe(false);
    um.undo();
    expect(constraints(o)).toHaveLength(0);
    um.redo();
    expect(constraints(o)[0].params.set_inverse_pending).toBe(false);
  });

  it('survives snapshot round trips and evaluates identically', () => {
    const { doc, run, world } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O', location: [1, 0, 0] });
    doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 5, 0] });
    run('object.constraint_add', { object: 'O', type: 'TRACK_TO', target: 'T', influence: 0.7 });
    run('object.constraint_add', {
      object: 'O',
      type: 'LIMIT_LOCATION',
      params: { use_max_x: true, max_x: 0.5 },
    });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(copy.getObject(o)!.constraints).toEqual(doc.getObject(o)!.constraints);
    expectVec(new FrameState(copy, 1).world(o)!, world(o));
  });

  it('describes the operators for UIs and agents', () => {
    const { reg } = setup();
    const ids = reg.describe().map((d) => d.id);
    for (const id of [
      'object.constraint_add',
      'constraint.update',
      'constraint.delete',
      'constraint.move_to_index',
      'constraint.apply',
      'constraint.childof_set_inverse',
      'constraint.childof_clear_inverse',
      'constraint.followpath_path_animate',
      'constraint.limitdistance_reset',
      'object.constraints_clear',
      'object.track_set',
      'object.visual_transform_apply',
      'constraint.type_list',
      'constraint.describe',
    ])
      expect(ids).toContain(id);
    const add = reg.describe().find((d) => d.id === 'object.constraint_add')!;
    expect(add.description).toMatch(/FOLLOW_PATH/);
    expect(JSON.stringify(add.parameters)).toMatch(/subtarget/);
    for (const d of reg.describe()) {
      const props =
        (d.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [k, v] of Object.entries(props)) expect(v.description, `${d.id}.${k}`).toBeTruthy();
    }
  });
});

describe('read-only constraint info operators', () => {
  it('lists constraint types with defaults and parameter schemas', () => {
    const { run, doc } = setup();
    const all = run('constraint.type_list');
    expect(all.ok).toBe(true);
    expect(all.result.types.map((t: { type: string }) => t.type)).toContain('FOLLOW_PATH');
    const one = run('constraint.type_list', { type: 'track to' }).result.types;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      type: 'TRACK_TO',
      label: 'Track To',
      target: 'REQUIRED',
      bone_subtarget: true,
      bone_only: false,
      defaults: { track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y' },
    });
    expect(JSON.stringify(one[0].parameters)).toMatch(/TRACK_NEGATIVE_Z/);
    expect(run('constraint.type_list', { type: 'IK' }).result.types[0].bone_only).toBe(true);
    expect(run('constraint.type_list', { type: 'nope' }).error).toMatch(/Unknown constraint type/);
    expect(doc.listObjects()).toHaveLength(0);
  });

  it('describes a stack with evaluation errors and the evaluated transform', () => {
    const { doc, run } = setup();
    doc.addObject({ type: 'EMPTY', name: 'O', location: [1, 1, 1] });
    doc.addObject({ type: 'EMPTY', name: 'T', location: [4, 5, 6] });
    run('object.constraint_add', {
      object: 'O',
      type: 'COPY_LOCATION',
      target: 'T',
      params: { use_z: false },
    });
    run('object.constraint_add', { object: 'O', type: 'DAMPED_TRACK' });
    const r = run('constraint.describe', { object: 'O' });
    expect(r.ok).toBe(true);
    expect(r.result.world_location).toEqual([4, 5, 1]);
    expect(r.result.constraints).toMatchObject([
      { index: 0, name: 'Copy Location', type: 'COPY_LOCATION', target_name: 'T', error: null },
      { index: 1, name: 'Damped Track', error: 'No target object set' },
    ]);
  });

  it('ignores malformed stored constraint data instead of failing', () => {
    const { doc, run, reports, constraints } = setup();
    const o = doc.addObject({ type: 'EMPTY', name: 'O' });
    doc.updateObject(o, { constraints: [null, 7] as unknown as ConstraintData[] });
    const r = run('object.constraint_add', { object: 'O', type: 'LIMIT_LOCATION' });
    expect(r.ok).toBe(true);
    expect(reports.some((m) => /malformed constraint data/.test(m))).toBe(true);
    expect(constraints(o).map((c) => c.type)).toEqual(['LIMIT_LOCATION']);
    doc.updateObject(o, { constraints: 'oops' as unknown as ConstraintData[] });
    expect(run('object.constraints_clear', { objects: ['O'] }).ok).toBe(true);
    expect(constraints(o)).toEqual([]);
  });
});
