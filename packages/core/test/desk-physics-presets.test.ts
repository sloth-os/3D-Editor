import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import {
  RELEASE_TRACKED_STEPS,
  newRigidBody,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
} from '../src/physics/settings';
import { deskBallisticVelocity, deskFlightCoefficients, deskIsBallLike } from '../src/desk/physics';
import { channelsAt, deskScene, dist, originOf, worldAt } from './desk-physics-helpers';

/*
 * The release presets of the director's desk (spec §4): desk.physics_setup, _drop, _throw and _push.
 * They give objects rigid bodies released at a frame (start_frame) with the velocity the shot needs,
 * and fit the rigid body world to the frames the bodies need (review finding 3a).
 */

const body = (s: ReturnType<typeof deskScene>, id: string) =>
  sanitizeRigidBody(s.doc.getObject(id)!.rigid_body);
const world = (s: ReturnType<typeof deskScene>) => sanitizeRigidBodyWorld(s.doc.getScene().rigidbody_world);

describe('desk.physics_setup', () => {
  it('gives balls spheres and other props boxes, with a ground set under them', () => {
    const s = deskScene();
    const ball = s.ball('Ball.001', [0, 0, 2]);
    const named = s.ball('Bowl', [2, 0, 2], 0.2, { custom_props: { desk_label: 'beach ball' } });
    const crate = s.box('Crate', [4, 0, 2]);
    const balloon = s.ball('Balloon', [6, 0, 2]);
    const r = s.run('desk.physics_setup', { objects: ['Ball.001', 'Bowl', 'Crate', 'Balloon'] });
    expect(r.bodies.map((b: { collision_shape: string }) => b.collision_shape)).toEqual([
      'SPHERE',
      'SPHERE',
      'BOX',
      'BOX',
    ]);
    expect(body(s, ball)).toMatchObject({ type: 'ACTIVE', restitution: 0.6, friction: 0.6 });
    expect(body(s, named)!.collision_shape).toBe('SPHERE');
    expect(body(s, crate)).toMatchObject({ collision_shape: 'BOX', restitution: 0 });
    expect(body(s, balloon)!.collision_shape).toBe('BOX');
    // a passive ground plane at z = 0, part of the set
    const ground = s.doc.getObject(r.ground.object)!;
    expect(ground.custom_props?.desk_role).toBe('set');
    expect(sanitizeRigidBody(ground.rigid_body)).toMatchObject({ type: 'PASSIVE', collision_shape: 'MESH' });
    expect(world(s).enabled).toBe(true);
    expect(r.world.settled).toBe(true);
    // a second setup reuses it
    s.box('Crate 2', [8, 0, 2]);
    expect(s.run('desk.physics_setup', { objects: ['Crate 2'] }).ground.object).toBe(ground.id);
    expect(s.doc.listObjects().filter((o) => o.custom_props?.desk_role === 'set')).toHaveLength(1);
  });

  it('gives SPHERE bodies to balls only: not to things named after balls or marble columns', () => {
    const s = deskScene();
    const isBall = (name: string, label?: string) =>
      deskIsBallLike(
        s.doc,
        s.doc.getObject(s.box(name, [0, 0, 1], 0.5, label ? { custom_props: { desk_label: label } } : {}))!,
      );
    for (const name of [
      'Football',
      'Beach ball',
      'SoccerBall.001',
      'tennis_ball',
      'Glass marble',
      'Globe',
      'Sphere',
    ])
      expect(isBall(name), name).toBe(true);
    for (const name of [
      'Football goal',
      'Baseball bat',
      'Ballpoint pen',
      'Ball gown',
      'Marble column',
      'Pinball machine',
    ])
      expect(isBall(name), name).toBe(false);
    expect(isBall('Prop', 'basketball hoop')).toBe(false);
    expect(isBall('Prop', 'bowling ball')).toBe(true);
    // catalog models: the marble column (tagged 'marble') is a box, the tennis ball (tagged 'ball') a sphere
    const column = s.run('store.add', { model: 'column', location: [4, 0, 0] }).root as string;
    const ball = s.run('store.add', { model: 'tennis_ball', location: [8, 0, 1] }).root as string;
    const shapes = s
      .run('desk.physics_setup', { objects: [column, ball] })
      .bodies.map((b: { collision_shape: string }) => b.collision_shape);
    expect(shapes).toEqual(['BOX', 'SPHERE']);
  });

  it('makes a flat set floor the ground collider instead of adding one', () => {
    const s = deskScene();
    const floor = s.plane('Floor', 30, { custom_props: { desk_role: 'set' } });
    s.box('Crate', [0, 0, 1]);
    const r = s.run('desk.physics_setup', { objects: ['Crate'] });
    expect(r.ground.object).toBe(floor);
    expect(sanitizeRigidBody(s.doc.getObject(floor)!.rigid_body)).toMatchObject({ type: 'PASSIVE' });
    expect(s.doc.listObjects()).toHaveLength(2);
  });

  it('takes the shape, mass and kind it is given; passive bodies need no ground', () => {
    const s = deskScene();
    const rock = s.box('Rock', [0, 0, 1]);
    const wall = s.box('Wall', [3, 0, 1]);
    s.run('desk.physics_setup', { objects: ['Rock'], shape: 'CONVEX_HULL', mass: 40 });
    expect(body(s, rock)).toMatchObject({ collision_shape: 'CONVEX_HULL', mass: 40 });
    const r = s.run('desk.physics_setup', { objects: ['Wall'], kind: 'passive' });
    expect(body(s, wall)).toMatchObject({ type: 'PASSIVE', collision_shape: 'MESH' });
    expect(r.ground).toBeNull();
    const cart = s.box('Cart', [6, 0, 0.3]);
    s.run('desk.physics_setup', { objects: ['Cart'], kind: 'animated', ground: false });
    // an animated collider: Blender's passive body with Animated on
    expect(body(s, cart)).toMatchObject({ type: 'PASSIVE', kinematic: true });
  });
});

describe('the ground of a release', () => {
  /** A set floor without a body (as desk.set_build makes it), a passive table on it and a mug on the table. */
  function tableScene(setSize: number, mugX: number) {
    const s = deskScene();
    const floor = s.plane('Set floor', setSize, { custom_props: { desk_role: 'set' } });
    const table = s.box('Table', [0, 0, 0.375], 1, { scale: [1.6, 0.9, 0.75] });
    s.run('desk.physics_setup', { objects: ['Table'], kind: 'passive' });
    const mug = s.box('Mug', [mugX, 0, 0.8], 0.1);
    return { s, floor, table, mug };
  }

  it('is the floor, not the table a prop stands on: a mug pushed off the table lands on the set floor', () => {
    const { s, floor, mug } = tableScene(30, 0.6);
    const r = s.run('desk.physics_push', { object: 'Mug', direction: [1, 0, 0], speed_mps: 2, frame: 20 });
    // the set's floor became the static ground (no second plane over it)
    expect(sanitizeRigidBody(s.doc.getObject(floor)!.rigid_body)).toMatchObject({ type: 'PASSIVE' });
    expect(s.doc.listObjects().filter((o) => o.custom_props?.desk_role === 'set')).toHaveLength(1);
    expect(r.world.settled).toBe(true);
    // off the table's edge (x 0.8), resting on the floor (a 0.1 m box)
    const end = originOf(worldAt(s.doc, mug, r.world.frame_end));
    expect(end[0]).toBeGreaterThan(0.8);
    expect(end[2]).toBeCloseTo(0.05, 2);
  });

  it('keeps a set floor the bodies come down beyond, naming where they fall off its edge', () => {
    // a 4 m set: the mug flies off the table at x 1.6 and comes down past the floor's edge at x 2
    const { s, floor } = tableScene(4, 0.6);
    s.doc.updateObject(s.doc.resolveObject('Table')!.id, { location: [1, 0, 0.375] });
    s.doc.updateObject(s.doc.resolveObject('Mug')!.id, { location: [1.6, 0, 0.8] });
    s.run('desk.physics_push', { object: 'Mug', direction: [1, 0, 0], speed_mps: 3, frame: 20 });
    expect(sanitizeRigidBody(s.doc.getObject(floor)!.rigid_body)).toMatchObject({ type: 'PASSIVE' });
    // no plane at z = 0 added under (and through) the set's floor
    expect(s.doc.listObjects().map((o) => o.name)).not.toContain('Ground');
    expect(
      s.warnings.some((w) => w.includes("'Set floor' is the ground") && w.includes('beyond its edge')),
    ).toBe(true);
  });

  it('is added for bodies that already had one: thrown, dropped and pushed props come to rest', () => {
    for (const [op, params] of [
      ['desk.physics_throw', { object: 'Ball', target: [4, 0, 1], frame: 10, flight_s: 1 }],
      ['desk.physics_drop', { objects: ['Ball'], frame: 10, height: 1 }],
      ['desk.physics_push', { object: 'Ball', direction: [1, 0, 0], speed_mps: 2, frame: 10 }],
    ] as const) {
      const s = deskScene();
      // a body from rigidbody.object_add (or an actor, a rideo import): no ground yet
      const ball = s.ball('Ball', [0, 0, 1.5], 0.11, { rigid_body: newRigidBody('ACTIVE') });
      const r = s.run(op, params);
      const ground = s.doc.listObjects().find((o) => o.custom_props?.desk_role === 'set');
      expect(ground, op).toBeDefined();
      expect(sanitizeRigidBody(ground!.rigid_body), op).toMatchObject({ type: 'PASSIVE' });
      expect(r.world.settled, op).toBe(true);
      expect(originOf(worldAt(s.doc, ball, r.world.frame_end))[2], op).toBeCloseTo(0.11, 1);
    }
  });

  it('names the bodies still moving when the settling stops, and how to slow a rolling ball down', () => {
    for (const [op, params, fell] of [
      // rolls on along the ground
      ['desk.physics_push', { object: 'Ball', direction: [1, 0, 0], speed_mps: 3, frame: 10 }, false],
      // caught in the air, comes down after it and rolls off the ground's edge
      ['desk.physics_throw', { object: 'Ball', target: [5, 3, 2.5], frame: 10, flight_s: 1 }, true],
    ] as const) {
      const s = deskScene();
      // a ball body of rigidbody.object_add: Blender's damping, so it rolls on
      s.ball('Ball', [0, 0, 1.4], 0.1, {
        rigid_body: { ...newRigidBody('ACTIVE'), collision_shape: 'SPHERE' },
      });
      const r = s.run(op, params);
      expect(r.world.settled, op).toBe(false);
      const warning = s.warnings.find((w) => w.startsWith('some bodies are still moving'));
      expect(warning, op).toContain("'Ball'");
      expect(warning, op).toContain('angular_damping');
      expect(warning!.includes('fallen off the ground'), op).toBe(fell);
    }
  });
});

describe('desk.physics_drop', () => {
  it('lifts the objects, holds them until the frame and lets them fall and settle', () => {
    const s = deskScene();
    const crate = s.box('Crate', [0, 0, 1]);
    const r = s.run('desk.physics_drop', { objects: ['Crate'], frame: 30, height: 2 });
    expect(body(s, crate)).toMatchObject({ start_frame: 30, inherit_velocity: true });
    expect(s.doc.getObject(crate)!.location).toEqual([0, 0, 3]);
    // the world runs from the frames that track the release until the crate has come to rest
    expect(r.world.frame_start).toBe(30 - RELEASE_TRACKED_STEPS);
    expect(r.world.settled).toBe(true);
    expect(r.world.frame_end).toBeLessThan(30 + 5 * 24);
    const ev = new SceneEvaluator(s.doc);
    for (const f of [1, 15, 30]) expect(originOf(worldAt(s.doc, crate, f, ev))[2]).toBeCloseTo(3, 9);
    expect(originOf(worldAt(s.doc, crate, 35, ev))[2]).toBeLessThan(3);
    // on the ground (a 0.5 m box) at the end of the world and after it
    for (const f of [r.world.frame_end, r.world.frame_end + 100])
      expect(originOf(worldAt(s.doc, crate, f, ev))[2]).toBeCloseTo(0.25, 2);
  });

  it('lifts an animated object by moving its location keys', () => {
    const s = deskScene();
    const crate = s.box('Crate', [0, 0, 1]);
    s.doc.setFCurve({
      target_type: 'object',
      target_id: crate,
      path: 'location',
      index: 2,
      keyframes: [
        { frame: 1, value: 1, interpolation: 'LINEAR' },
        { frame: 20, value: 1.5, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    s.run('desk.physics_drop', { objects: ['Crate'], frame: 20, height: 1 });
    expect(channelsAt(s.doc, crate, 1).location[2]).toBeCloseTo(2, 9);
    expect(channelsAt(s.doc, crate, 20).location[2]).toBeCloseTo(2.5, 9);
  });

  it('fits the world to a late release instead of the whole film', () => {
    const s = deskScene();
    s.doc.updateScene({ frame_start: 1, frame_end: 5000 });
    s.box('Crate', [0, 0, 1]);
    const r = s.run('desk.physics_drop', { objects: ['Crate'], frame: 4000 });
    expect(r.world.frame_start).toBe(4000 - RELEASE_TRACKED_STEPS);
    expect(r.world.frame_end).toBeLessThan(4100);
    // a second, earlier release moves the start back and keeps both settled
    s.box('Crate 2', [3, 0, 1]);
    const again = s.run('desk.physics_drop', { objects: ['Crate 2'], frame: 100 });
    expect(again.world.frame_start).toBe(100 - RELEASE_TRACKED_STEPS);
    expect(again.world.frame_end).toBeGreaterThanOrEqual(4000);
  });
});

describe('desk.physics_throw', () => {
  const fps = 24;

  it('lands the origin within 5 cm of a point after flight_s', () => {
    const s = deskScene();
    const ball = s.ball('Ball', [1, 0, 1.5]);
    // caught 0.8 m above the ground
    const target: Vec3 = [6, 2, 0.8];
    const r = s.run('desk.physics_throw', { object: 'Ball', target, frame: 10, flight_s: 1.2 });
    expect(r.landing_frame).toBeCloseTo(10 + 1.2 * fps, 6);
    expect(body(s, ball)).toMatchObject({ start_frame: 10, inherit_velocity: false });
    expect(dist(originOf(worldAt(s.doc, ball, r.landing_frame)), target)).toBeLessThan(0.005);
    // still in the hand before the release
    expect(originOf(worldAt(s.doc, ball, 5))).toEqual([1, 0, 1.5]);
  });

  it('lands on a point of the ground: it touches down there and bounces', () => {
    const s = deskScene();
    const ball = s.ball('Ball', [1, 0, 1.5]);
    // the origin of a ball of 0.11 m on the ground
    const target: Vec3 = [6, 2, 0.11];
    const r = s.run('desk.physics_throw', { object: 'Ball', target, frame: 10, flight_s: 1.2 });
    const ev = new SceneEvaluator(s.doc);
    const at = (f: number) => originOf(worldAt(s.doc, ball, f, ev));
    // the frame after the touch-down: next to the target, on its way up again
    const after = Math.ceil(r.landing_frame);
    expect(Math.hypot(at(after)[0] - 6, at(after)[1] - 2)).toBeLessThan(0.05);
    expect(at(after)[2]).toBeLessThan(0.11 + 0.05);
    expect(at(after + 2)[2]).toBeGreaterThan(at(after)[2]);
  });

  it('lands on a moving object where it is at the landing frame', () => {
    const s = deskScene();
    const ball = s.ball('Ball', [0, 0, 1.2]);
    const bucket = s.empty('Bucket', [4, 0, 0.11]);
    s.doc.setFCurve({
      target_type: 'object',
      target_id: bucket,
      path: 'location',
      index: 1,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 61, value: 6, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const r = s.run('desk.physics_throw', { object: 'Ball', target: 'Bucket', frame: 12, flight_s: 1.5 });
    const landing = r.landing_frame as number;
    expect(landing).toBeCloseTo(48, 6);
    expect(
      dist(originOf(worldAt(s.doc, ball, landing)), originOf(worldAt(s.doc, bucket, landing))),
    ).toBeLessThan(0.05);
  });

  it('spins the body and refuses a throw no hand could make', () => {
    const s = deskScene();
    const ball = s.ball('Ball', [0, 0, 1]);
    s.run('desk.physics_throw', {
      object: 'Ball',
      target: [3, 0, 0.11],
      frame: 1,
      flight_s: 1,
      spin: [0, 0, 10],
    });
    expect(body(s, ball)!.initial_angular_velocity).toEqual([0, 0, 10]);
    const far = s.reg.run(s.ctx, 'desk.physics_throw', {
      object: 'Ball',
      target: [5000, 0, 0],
      frame: 1,
      flight_s: 0.1,
    });
    expect(far).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(far.error).toMatch(/flight_s/);
    expect(
      s.reg.run(s.ctx, 'desk.physics_throw', { object: 'Ball', target: 'Ball', frame: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    });
  });

  it('solves the launch for the integrator exactly (no air, no damping)', () => {
    const dt = 1 / 24 / 10;
    const g: Vec3 = [0, 0, -9.81];
    const v = deskBallisticVelocity([3, -1, 0.5], 30, { gravity: g, substeps: 10, dt, linearDamping: 0 });
    // step the same semi-implicit Euler: v += g·dt, p += v·dt
    const p: Vec3 = [0, 0, 0];
    const vel = [...v];
    for (let i = 0; i < 300; i++)
      for (let k = 0; k < 3; k++) {
        vel[k] += g[k] * dt;
        p[k] += vel[k] * dt;
      }
    expect(dist(p, [3, -1, 0.5])).toBeLessThan(1e-9);
    const { A, B } = deskFlightCoefficients(300, dt, 0);
    expect(A).toBeCloseTo(300 * dt, 12);
    expect(B).toBeCloseTo((dt * dt * 300 * 301) / 2, 12);
  });
});

describe('desk.physics_push', () => {
  it('starts the body moving along the direction at the speed from the frame', () => {
    const s = deskScene();
    const crate = s.box('Crate', [0, 0, 0.25]);
    const r = s.run('desk.physics_push', { object: 'Crate', direction: [2, 2, 0], speed_mps: 3, frame: 20 });
    const v = 3 / Math.SQRT2;
    expect(r.velocity).toEqual([Math.round(v * 1000) / 1000, Math.round(v * 1000) / 1000, 0]);
    expect(body(s, crate)).toMatchObject({ start_frame: 20, inherit_velocity: true });
    const ev = new SceneEvaluator(s.doc);
    const at = (f: number) => originOf(worldAt(s.doc, crate, f, ev));
    expect(at(20)).toEqual([0, 0, 0.25]);
    const step = [at(21)[0] - at(20)[0], at(21)[1] - at(20)[1]];
    expect(step[0]).toBeCloseTo(step[1], 3);
    expect(Math.hypot(step[0], step[1]) * 24).toBeGreaterThan(2.5);
    expect(Math.hypot(step[0], step[1]) * 24).toBeLessThan(3.05);
    // friction stops it a little way along the diagonal
    const end = at(r.world.frame_end);
    expect(end[0]).toBeGreaterThan(0.2);
    expect(end[0]).toBeCloseTo(end[1], 2);
    expect(r.world.settled).toBe(true);
  });

  it('refuses a direction of zero length', () => {
    const s = deskScene();
    s.box('Crate', [0, 0, 0.25]);
    expect(
      s.reg.run(s.ctx, 'desk.physics_push', {
        object: 'Crate',
        direction: [0, 0, 0],
        speed_mps: 3,
        frame: 2,
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });
});
