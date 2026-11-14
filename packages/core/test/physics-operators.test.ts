import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import type { RigidBodyData } from '../src/doc/types';
import { createCube, createPlane } from '../src/mesh/primitives';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { OperatorRegistry } from '../src/operators/registry';
import { createOperatorRegistry } from '../src/operators';
import { registerPhysicsOperators } from '../src/operators/physics';
import { freeRigidBodyCache, rigidBodyCacheInfo } from '../src/physics/rigid-body';
import { MAX_SIMULATED_FRAMES } from '../src/physics/settings';
import { loc, rotationAngle, simulate } from './physics-helpers';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = new OperatorRegistry();
  registerPhysicsOperators(reg);
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push(`${level}: ${message}`),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const cube = doc.addMesh('Cube', createCube({ size: 1 }));
  const plane = doc.addMesh('Plane', createPlane({ size: 20 }));
  const ground = doc.addObject({ type: 'MESH', name: 'Ground', data: plane });
  const box = doc.addObject({
    type: 'MESH',
    name: 'Box',
    data: cube,
    location: [0, 0, 3],
    rotation_euler: [0.3, 0.2, 0.1],
  });
  const select = (ids: string[]) => {
    ctx.state.selectedIds = ids;
    ctx.state.activeId = ids[ids.length - 1] ?? null;
  };
  const body = (id: string): RigidBodyData | null => doc.getObject(id)!.rigid_body;
  return { doc, reg, ctx, run, reports, cube, plane, ground, box, select, body };
}

describe('rigidbody.object_add / object_remove', () => {
  it("adds bodies with Blender's per-type defaults to the selection", () => {
    const t = setup();
    t.select([t.ground]);
    const r = t.run('rigidbody.object_add', { type: 'PASSIVE' });
    expect(r.ok).toBe(true);
    expect(t.body(t.ground)).toEqual({
      type: 'PASSIVE',
      enabled: true,
      kinematic: false,
      mass: 1,
      friction: 0.5,
      restitution: 0,
      collision_shape: 'MESH',
      collision_margin: 0.04,
      linear_damping: 0.04,
      angular_damping: 0.1,
      start_frame: null,
      initial_linear_velocity: [0, 0, 0],
      initial_angular_velocity: [0, 0, 0],
      inherit_velocity: true,
    });
    expect(r.result).toMatchObject({
      created: 1,
      objects: [{ object: t.ground, name: 'Ground', type: 'PASSIVE' }],
    });
    const a = t.run('rigidbody.object_add', { objects: ['Box'], mass: 2.5, friction: 0.9, restitution: 0.4 });
    expect(a.ok).toBe(true);
    expect(t.body(t.box)).toMatchObject({
      type: 'ACTIVE',
      collision_shape: 'CONVEX_HULL',
      mass: 2.5,
      friction: 0.9,
      restitution: 0.4,
    });
    // the box now falls in the evaluated scene and lands on the ground
    const ev = new SceneEvaluator(t.doc).evaluate(80);
    expect(ev.byId.get(t.box)!.simulated).toBe(true);
    expect(loc(ev.byId.get(t.box)!.worldMatrix)[2]).toBeCloseTo(0.5, 1);
  });

  it('skips non-mesh objects, warns about MESH on ACTIVE bodies and a disabled world', () => {
    const t = setup();
    const empty = t.doc.addObject({ type: 'EMPTY', name: 'Empty' });
    t.doc.updateScene({ rigidbody_world: { ...t.doc.getScene().rigidbody_world, enabled: false } });
    const r = t.run('rigidbody.object_add', { objects: ['Empty', 'Box'], collision_shape: 'MESH' });
    expect(r.ok).toBe(true);
    expect(r.result.skipped).toEqual([
      { object: empty, name: 'Empty', reason: expect.stringMatching(/only meshes/) },
    ]);
    expect(t.doc.getObject(empty)!.rigid_body).toBeNull();
    expect(t.reports.some((m) => /WARNING: .*MESH shape.*CONVEX_HULL/.test(m))).toBe(true);
    expect(t.reports.some((m) => /WARNING: The rigid body world is disabled/.test(m))).toBe(true);
    const fail = t.run('rigidbody.object_add', { objects: ['Empty'] });
    expect(fail.ok).toBe(false);
    expect(fail.error).toMatch(/No mesh objects/);
    expect(t.run('rigidbody.object_add', { objects: ['Nope'] }).error).toMatch(/'Nope' not found/);
    expect(t.run('rigidbody.object_add', {}).error).toMatch(/No objects selected/);
    expect(t.run('rigidbody.object_add', { objects: ['Box'], mass: 0 }).error).toMatch(/mass/);
    expect(t.run('rigidbody.object_add', { objects: ['Box'], collision_shape: 'BLOB' }).ok).toBe(false);
  });

  it('keeps the settings of existing bodies, switching type (and Dynamic on for ACTIVE)', () => {
    const t = setup();
    // stored before rigid bodies had start frames and initial velocities: the defaults fill them in
    t.doc.updateObject(t.box, {
      rigid_body: {
        type: 'PASSIVE',
        enabled: false,
        kinematic: false,
        mass: 7,
        friction: 0.1,
        restitution: 0.2,
        collision_shape: 'BOX',
        collision_margin: 0.01,
        linear_damping: 0.2,
        angular_damping: 0.3,
      } as unknown as RigidBodyData,
    });
    const r = t.run('rigidbody.object_add', { objects: ['Box'], type: 'ACTIVE', restitution: 0.6 });
    expect(r.result.created).toBe(0);
    expect(t.body(t.box)).toEqual({
      type: 'ACTIVE',
      enabled: true,
      kinematic: false,
      mass: 7,
      friction: 0.1,
      restitution: 0.6,
      collision_shape: 'BOX',
      collision_margin: 0.01,
      linear_damping: 0.2,
      angular_damping: 0.3,
      start_frame: null,
      initial_linear_velocity: [0, 0, 0],
      initial_angular_velocity: [0, 0, 0],
      inherit_velocity: true,
    });
  });

  it('removes bodies and fails when none has one', () => {
    const t = setup();
    t.run('rigidbody.object_add', { objects: ['Box', 'Ground'] });
    const r = t.run('rigidbody.object_remove', { objects: ['Box', 'Ground'] });
    expect(r.result.removed.map((x: { name: string }) => x.name)).toEqual(['Box', 'Ground']);
    expect(t.body(t.box)).toBeNull();
    expect(t.run('rigidbody.object_remove', { objects: ['Box'] }).error).toMatch(/has a rigid body/);
  });
});

describe('rigidbody.object_settings_set / world_set', () => {
  it('patches only the given settings and validates ranges', () => {
    const t = setup();
    t.run('rigidbody.object_add', { objects: ['Box'] });
    const r = t.run('rigidbody.object_settings_set', {
      objects: ['Box'],
      friction: 0.75,
      collision_shape: 'SPHERE',
    });
    expect(r.ok).toBe(true);
    expect(t.body(t.box)).toMatchObject({
      type: 'ACTIVE',
      mass: 1,
      friction: 0.75,
      collision_shape: 'SPHERE',
    });
    t.run('rigidbody.object_settings_set', { objects: ['Box'], type: 'PASSIVE', enabled: false });
    expect(t.body(t.box)).toMatchObject({ type: 'PASSIVE', enabled: false });
    t.run('rigidbody.object_settings_set', { objects: ['Box'], type: 'ACTIVE' });
    expect(t.body(t.box)).toMatchObject({ type: 'ACTIVE', enabled: true });
    expect(t.run('rigidbody.object_settings_set', { objects: ['Box'], linear_damping: 2 }).ok).toBe(false);
    expect(t.run('rigidbody.object_settings_set', { objects: ['Ground'], mass: 2 }).error).toMatch(
      /'Ground' has no rigid body/,
    );
  });

  it('changes the world, gravity and simulation range', () => {
    const t = setup();
    const r = t.run('rigidbody.world_set', {
      frame_start: 10,
      frame_end: 90,
      substeps_per_frame: 4,
      gravity: [0, 0, -3],
    });
    expect(r.ok).toBe(true);
    expect(t.doc.getScene().rigidbody_world).toEqual({
      enabled: true,
      frame_start: 10,
      frame_end: 90,
      substeps_per_frame: 4,
      solver_iterations: 10,
      time_scale: 1,
    });
    expect(t.doc.getScene().gravity).toEqual([0, 0, -3]);
    expect(r.result.step_seconds).toBeCloseTo(1 / 24 / 4, 12);
    t.run('rigidbody.world_set', { use_gravity: false, time_scale: 0.5 });
    expect(t.doc.getScene()).toMatchObject({
      use_gravity: false,
      rigidbody_world: { time_scale: 0.5, frame_start: 10 },
    });
    expect(t.run('rigidbody.world_set', { frame_end: 5 }).error).toMatch(
      /frame_end \(5\) must not be before/,
    );
    expect(t.run('rigidbody.world_set', { substeps_per_frame: 0 }).ok).toBe(false);
    expect(t.run('rigidbody.world_set', { gravity: [0, 0] }).ok).toBe(false);
  });

  it('reports the simulated frame cap instead of silently freezing bodies after it', () => {
    const t = setup();
    const ok = t.run('rigidbody.world_set', { frame_end: 20000 });
    expect(ok.result.simulated_frame_end).toBe(20000);
    expect(t.reports).toEqual([]);
    const r = t.run('rigidbody.world_set', { frame_end: 25000 });
    expect(r.ok).toBe(true);
    // stored as asked (Blender range), but the agent learns where the simulation stops
    expect(r.result.rigidbody_world.frame_end).toBe(25000);
    expect(r.result.simulated_frame_end).toBe(20001);
    expect(t.reports).toEqual([
      `WARNING: Only ${MAX_SIMULATED_FRAMES} frames after frame_start are simulated: frames 20002–25000 ` +
        'hold the state of frame 20001',
    ]);
    t.run('rigidbody.world_set', { frame_start: 10000 });
    expect(t.run('rigidbody.describe').result).toMatchObject({
      world: { frame_start: 10000, frame_end: 25000 },
      simulated_frame_end: 25000,
    });
    const info = t.reg.describe().find((d) => d.id === 'rigidbody.world_set')!;
    expect(info.description).toContain(`At most ${MAX_SIMULATED_FRAMES} frames`);
    const props = (info.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(props.frame_end.description).toContain(`${MAX_SIMULATED_FRAMES}`);
  });
});

describe('rigidbody.bake_to_keyframes', () => {
  function bakeScene() {
    const t = setup();
    t.run('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE' });
    t.run('rigidbody.object_add', { objects: ['Box'], restitution: 0.2 });
    t.doc.updateObject(t.ground, { rigid_body: { ...t.body(t.ground)!, restitution: 1 } });
    const pivot = t.doc.addObject({
      type: 'EMPTY',
      name: 'Pivot',
      location: [2, 1, 0],
      rotation_euler: [0, 0, 0.7],
    });
    const child = t.doc.addObject({
      type: 'MESH',
      name: 'Child',
      data: t.cube,
      parent: pivot,
      location: [1, -1, 5],
      rotation_euler: [0.5, 0, 0.2],
    });
    t.run('rigidbody.object_add', { objects: ['Child'] });
    return { ...t, pivot, child };
  }

  it('reproduces the simulation with keys, then removes the bodies (Blender)', () => {
    const t = bakeScene();
    const frames = Array.from({ length: 100 }, (_, i) => i + 1);
    const sim = simulate(t.doc, frames);
    const r = t.run('rigidbody.bake_to_keyframes', { objects: ['Box', 'Child', 'Ground'], frame_end: 100 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ frame_start: 1, frame_end: 100, step: 1, frames: 100 });
    expect(t.reports.some((m) => /Skipped 'Ground': not an ACTIVE rigid body/.test(m))).toBe(true);
    expect(t.body(t.box)).toBeNull();
    expect(t.body(t.child)).toBeNull();
    expect(t.body(t.ground)).not.toBeNull();
    const fcurves = t.doc.listFCurves(t.box);
    expect(fcurves.map((f) => `${f.path}:${f.index}`).sort()).toEqual([
      'location:0',
      'location:1',
      'location:2',
      'rotation_euler:0',
      'rotation_euler:1',
      'rotation_euler:2',
    ]);
    for (const fc of fcurves) expect(fc.keyframes.every((k) => k.interpolation === 'LINEAR')).toBe(true);
    // redundant keys of the resting phase were dropped
    expect(Math.min(...fcurves.map((f) => f.keyframes.length))).toBeLessThan(100);
    for (const f of frames) {
      const fs = new FrameState(t.doc, f);
      for (const id of [t.box, t.child]) {
        const expected = sim.get(f)?.get(id) ?? new FrameState(t.doc, 1).world(id)!;
        const got = fs.world(id)!;
        const d = loc(got).map((v, k) => v - loc(expected)[k]);
        expect(Math.hypot(...d), `frame ${f}`).toBeLessThan(5e-4);
        expect(rotationAngle(got, expected)).toBeLessThan(5e-4);
      }
    }
    // the parented body is keyed relative to its parent
    expect(t.doc.getObject(t.child)!.parent).toBe(t.pivot);
  });

  it('keeps mirrored bodies (negative scale components) oriented as simulated', () => {
    const scales: [number, number, number][] = [
      [-1, 1, 1],
      [-1, -1, 1],
      [1, 1, -1],
      [2, -0.5, 1],
      [-1, -1, -1],
    ];
    for (const scale of scales) {
      const t = setup();
      t.doc.updateObject(t.box, { scale });
      t.run('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE' });
      t.run('rigidbody.object_add', { objects: ['Box'] });
      // expected matrices are taken before the bake: frame 1 is unsimulated, later frames simulated
      const before = new FrameState(t.doc, 1).world(t.box)!;
      const frames = Array.from({ length: 40 }, (_, i) => i + 1);
      const sim = simulate(t.doc, frames);
      expect(t.run('rigidbody.bake_to_keyframes', { objects: ['Box'], frame_end: 40 }).ok).toBe(true);
      expect(t.doc.getObject(t.box)!.scale).toEqual(scale);
      for (const f of [1, 2, 15, 40]) {
        const expected = sim.get(f)?.get(t.box) ?? before;
        const got = new FrameState(t.doc, f).world(t.box)!;
        expect(rotationAngle(got, expected), `scale ${scale} frame ${f}`).toBeLessThan(5e-4);
        for (let k = 0; k < 16; k++) expect(got[k]).toBeCloseTo(expected[k], 3);
      }
      // the inspection reports the object's own rotation for the unsimulated frame
      const box = t.run('rigidbody.describe', { frame: 1, objects: ['Box'] }).result.objects[0];
      box.world_rotation_euler.forEach((v: number, k: number) =>
        expect(v).toBeCloseTo([0.3, 0.2, 0.1][k], 9),
      );
    }
  });

  it('bakes every `step` frames inside the range and keeps keys outside it', () => {
    const t = bakeScene();
    t.doc.setFCurve({
      target_type: 'object',
      target_id: t.box,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: -10, value: 7, interpolation: 'BEZIER' },
        { frame: 5, value: 1, interpolation: 'BEZIER' },
        { frame: 300, value: 9, interpolation: 'BEZIER' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
      // would add noise on top of the baked motion
      modifiers: [{ type: 'NOISE', params: { scale: 2, strength: 3 } }],
    });
    t.doc.setDriver({
      target_type: 'object',
      target_id: t.box,
      path: 'location',
      index: 1,
      expression: 'frame * 0',
      variables: [],
      mute: false,
    });
    const r = t.run('rigidbody.bake_to_keyframes', {
      objects: ['Box'],
      frame_start: 1,
      frame_end: 31,
      step: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.result.frames).toBe(4);
    expect(r.result.removed_drivers).toBe(1);
    expect(r.result.removed_modifiers).toBe(1);
    expect(t.reports.some((m) => /Removed 1 F-curve modifier/.test(m))).toBe(true);
    const fx = t.doc.getFCurve(`object:${t.box}:location:0`)!;
    expect(fx.keyframes.map((k) => k.frame)).toEqual([-10, 1, 11, 21, 31, 300]);
    expect(fx.modifiers ?? []).toEqual([]);
    expect(t.doc.getDriver(`object:${t.box}:location:1`)).toBeNull();
    // the keys alone give the object's transform inside the baked range
    expect(new FrameState(t.doc, 21).world(t.box)![12]).toBeCloseTo(fx.keyframes[3].value, 9);
  });

  it('rejects bad ranges, missing bodies and a disabled world', () => {
    const t = bakeScene();
    expect(
      t.run('rigidbody.bake_to_keyframes', { objects: ['Box'], frame_start: 50, frame_end: 10 }).error,
    ).toMatch(/must not be before/);
    expect(t.run('rigidbody.bake_to_keyframes', { objects: ['Box'], frame_end: 1e6 }).error).toMatch(
      /Too many frames/,
    );
    expect(t.run('rigidbody.bake_to_keyframes', { objects: ['Ground'] }).error).toMatch(
      /No ACTIVE rigid bodies/,
    );
    expect(t.run('rigidbody.bake_to_keyframes', { objects: ['Box'], step: 0 }).ok).toBe(false);
    t.run('rigidbody.world_set', { enabled: false });
    expect(t.run('rigidbody.bake_to_keyframes', { objects: ['Box'] }).error).toMatch(/world is disabled/);
    expect(t.body(t.box)).not.toBeNull();
  });
});

describe('rigidbody.cache_free / describe', () => {
  it('frees the shared cache without touching the document', () => {
    const t = setup();
    t.run('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE' });
    t.run('rigidbody.object_add', { objects: ['Box'] });
    new SceneEvaluator(t.doc).evaluate(30);
    const state = t.doc.encodeState();
    const r = t.run('rigidbody.cache_free');
    expect(r.result).toMatchObject({ freed: true, frame_start: 1, simulated_to: 30, bodies: 2 });
    expect(rigidBodyCacheInfo(t.doc)).toBeNull();
    expect(t.run('rigidbody.cache_free').result).toEqual({ freed: false });
    expect(t.doc.encodeState()).toEqual(state);
  });

  it('describes bodies, their simulated shapes, motion and transforms', () => {
    const t = setup();
    t.run('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE' });
    t.run('rigidbody.object_add', { objects: ['Box'], collision_shape: 'MESH' });
    t.doc.addObject({ type: 'EMPTY', name: 'Ghost', rigid_body: { ...t.body(t.box)! } });
    freeRigidBodyCache(t.doc);
    const at1 = t.run('rigidbody.describe', { frame: 1 });
    expect(at1.ok).toBe(true);
    expect(at1.result.simulation_running).toBe(false);
    const box1 = at1.result.objects.find((o: { name: string }) => o.name === 'Box');
    expect(box1).toMatchObject({
      simulated_shape: 'CONVEX_HULL',
      motion: 'DYNAMIC',
      simulated: false,
      world_location: [0, 0, 3],
    });
    expect(box1.issues[0]).toMatch(/WARNING: .*CONVEX_HULL/);
    const ghost = at1.result.objects.find((o: { name: string }) => o.name === 'Ghost');
    expect(ghost.issues[0]).toMatch(/ERROR: rigid bodies need a mesh object/);
    const at90 = t.run('rigidbody.describe', { frame: 90, objects: ['Box', 'Ground'] });
    expect(at90.result.simulation_running).toBe(true);
    expect(at90.result.cache.simulated_to).toBe(90);
    const [box, ground] = at90.result.objects;
    expect(box).toMatchObject({ name: 'Box', simulated: true, sleeping: true });
    expect(box.world_location[2]).toBeCloseTo(0.5, 1);
    expect(ground).toMatchObject({
      name: 'Ground',
      motion: 'STATIC',
      simulated_shape: 'MESH',
      simulated: false,
    });
    expect(t.run('rigidbody.describe', { objects: ['Nope'] }).error).toMatch(/'Nope' not found/);
  });
});

describe('undo, persistence and descriptions', () => {
  it('makes every document-changing operator one undo step', () => {
    const t = setup();
    const um = new Y.UndoManager(t.doc.sharedTypes(), {
      trackedOrigins: new Set([t.doc.origin]),
      captureTimeout: 0,
    });
    t.run('rigidbody.object_add', { objects: ['Box', 'Ground'] });
    t.run('rigidbody.object_settings_set', { objects: ['Box'], mass: 4 });
    t.run('rigidbody.world_set', { frame_end: 60, gravity: [0, 0, -1] });
    t.run('rigidbody.bake_to_keyframes', { objects: ['Box'] });
    expect(t.body(t.box)).toBeNull();
    expect(t.doc.listFCurves(t.box)).toHaveLength(6);
    um.undo();
    expect(t.body(t.box)).toMatchObject({ mass: 4 });
    expect(t.doc.listFCurves(t.box)).toHaveLength(0);
    um.undo();
    expect(t.doc.getScene().rigidbody_world.frame_end).toBe(250);
    expect(t.doc.getScene().gravity).toEqual([0, 0, -9.81]);
    um.undo();
    expect(t.body(t.box)).toMatchObject({ mass: 1 });
    um.undo();
    expect(t.body(t.box)).toBeNull();
    expect(t.body(t.ground)).toBeNull();
    um.redo();
    expect(t.body(t.ground)).toMatchObject({ type: 'ACTIVE' });
  });

  it('survives snapshot round trips and simulates identically', () => {
    const t = setup();
    t.run('rigidbody.object_add', { objects: ['Ground'], type: 'PASSIVE', friction: 0.8 });
    t.run('rigidbody.object_add', { objects: ['Box'], collision_shape: 'BOX', restitution: 0.3 });
    t.run('rigidbody.world_set', { substeps_per_frame: 6, solver_iterations: 12, gravity: [0.5, 0, -9] });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(t.doc.toSnapshot())));
    expect(copy.getObject(t.box)!.rigid_body).toEqual(t.body(t.box));
    expect(copy.getScene().rigidbody_world).toEqual(t.doc.getScene().rigidbody_world);
    expect(copy.getScene().gravity).toEqual([0.5, 0, -9]);
    const a = simulate(t.doc, [60]).get(60)!.get(t.box);
    const b = simulate(copy, [60]).get(60)!.get(t.box);
    expect(b).toEqual(a);
  });

  it('registers every operator with fully described parameters', () => {
    const reg = createOperatorRegistry();
    const ids = [
      'rigidbody.object_add',
      'rigidbody.object_remove',
      'rigidbody.object_settings_set',
      'rigidbody.world_set',
      'rigidbody.bake_to_keyframes',
      'rigidbody.cache_free',
      'rigidbody.describe',
    ];
    const infos = reg.describe().filter((d) => d.id.startsWith('rigidbody.'));
    expect(infos.map((d) => d.id).sort()).toEqual([...ids].sort());
    for (const d of infos) {
      expect(d.category).toBe('Physics');
      expect(d.description.length).toBeGreaterThan(80);
      const props =
        (d.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [k, v] of Object.entries(props)) expect(v.description, `${d.id}.${k}`).toBeTruthy();
    }
    for (const id of ids) expect(() => reg.parseParams(id, {})).not.toThrow();
  });
});
