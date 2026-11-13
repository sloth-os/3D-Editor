// memory-desk.ts first: it must load before (and without) operators/memory.ts (desk-operators.test.ts)
import { DESK_MOTION_ESTIMATES } from '../src/operators/memory-desk';
import { describe, expect, it } from 'vitest';
import { OPERATOR_ESTIMATES, OPERATOR_FIXED_BYTES, estimateOperator } from '../src/operators';
import { rigidBodyCacheBytes } from '../src/physics/rigid-body';
import { RELEASE_TRACKED_STEPS, newRigidBody } from '../src/physics/settings';
import {
  DESK_SETTLE_BYTES_PER_BODY_FRAME,
  deskSettleSimulation,
  deskTetherObjects,
  deskVehicleFrames,
} from '../src/desk/physics/estimate';
import { DESK_SETTLE_MAX_SECONDS, TETHER_TAIL_SEGMENTS } from '../src/desk/physics';
import { deskScene, kiteMesh, syntheticCar } from './desk-physics-helpers';

/*
 * Memory estimates of the motion presets (desk/physics/estimate.ts through memory-desk.ts
 * DESK_MOTION_ESTIMATES): what each simulates, keys and adds, counted from the document and the
 * parameters; upper bounds of what the operators then do. Their peaks were measured with --trace-gc
 * (estimate.ts); here the counts.
 */

const MOTION = Object.keys(DESK_MOTION_ESTIMATES);

describe('desk motion memory estimates', () => {
  it('are the operators estimates', () => {
    expect(MOTION.sort()).toEqual(
      [
        'desk.physics_setup',
        'desk.physics_drop',
        'desk.physics_throw',
        'desk.physics_push',
        'desk.physics_bake',
        'desk.tether_fly',
        'desk.vehicle_drive',
      ].sort(),
    );
    for (const id of MOTION) expect(OPERATOR_ESTIMATES[id], id).toBe(DESK_MOTION_ESTIMATES[id]);
  });

  it('count the settling run of a release: its frames, the cache it keeps, the ground it adds', () => {
    const s = deskScene();
    s.box('Crate', [0, 0, 1]);
    s.box('Crate 2', [2, 0, 1]);
    const est = (p: Record<string, unknown>) =>
      estimateOperator('desk.physics_drop', s.ctx, s.reg.parseParams('desk.physics_drop', p))!;
    const one = est({ objects: ['Crate'], frame: 100 });
    const two = est({ objects: ['Crate', 'Crate 2'], frame: 100 });
    expect(two.bytes).toBeGreaterThan(one.bytes);
    expect(two.simulationBytes!).toBeGreaterThan(one.simulationBytes!);
    expect(one.objects).toBe(1);
    // the world steps from the frames that track the release (98, 99) until 20 s after the bodies'
    // first move (101)
    const sim = deskSettleSimulation(s.doc, { count: 2, kind: 'active', start: 100 });
    expect(sim.frames).toBe(1 + RELEASE_TRACKED_STEPS + Math.ceil(DESK_SETTLE_MAX_SECONDS * 24));
    expect(sim.bodies).toBe(2);
    expect(two.bytes).toBeGreaterThanOrEqual(
      OPERATOR_FIXED_BYTES + DESK_SETTLE_BYTES_PER_BODY_FRAME * 2 * sim.frames,
    );
    // no estimate without an object (the operator refuses)
    expect(
      estimateOperator('desk.physics_push', s.ctx, {
        object: 'Nothing',
        direction: [1, 0, 0],
        speed_mps: 1,
        frame: 1,
      }),
    ).toBeNull();
    // what the run keeps stays within the estimate
    s.run('desk.physics_drop', { objects: ['Crate', 'Crate 2'], frame: 100 });
    expect(rigidBodyCacheBytes(s.doc)).toBeLessThanOrEqual(two.simulationBytes!);
  });

  it('count the location keys a lift rewrites', () => {
    const s = deskScene();
    const crate = s.box('Crate', [0, 0, 1]);
    s.doc.setFCurve({
      target_type: 'object',
      target_id: crate,
      path: 'location',
      index: 2,
      keyframes: Array.from({ length: 500 }, (_, i) => ({
        frame: i + 1,
        value: 1,
        interpolation: 'LINEAR' as const,
      })),
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const est = (height?: number) =>
      estimateOperator(
        'desk.physics_drop',
        s.ctx,
        s.reg.parseParams('desk.physics_drop', {
          objects: ['Crate'],
          frame: 10,
          ...(height ? { height } : {}),
        }),
      )!.bytes;
    expect(est(2) - est()).toBeGreaterThanOrEqual(500 * 180);
  });

  it('count six keys per baked body and frame, and none for a bake that fails by itself', () => {
    const s = deskScene();
    s.box('Crate', [0, 0, 1]);
    s.box('Crate 2', [2, 0, 1]);
    expect(estimateOperator('desk.physics_bake', s.ctx, {})).toBeNull();
    s.run('desk.physics_drop', { objects: ['Crate', 'Crate 2'], frame: 10 });
    const world = s.doc.getScene().rigidbody_world;
    const e = estimateOperator('desk.physics_bake', s.ctx, {})!;
    expect(e.keyframes).toBe(6 * 2 * (world.frame_end - world.frame_start + 1));
    const r = s.run('desk.physics_bake', {});
    expect(r.keyframes).toBeLessThanOrEqual(e.keyframes!);
    // over the budget: refused before it runs
    s.doc.updateScene({
      rigidbody_world: { ...s.doc.getScene().rigidbody_world, frame_start: 1, frame_end: 20000 },
    });
    for (let i = 0; i < 101; i++) s.box(`More ${i}`, [i, 5, 1], 0.5, { rigid_body: newRigidBody('ACTIVE') });
    expect(estimateOperator('desk.physics_bake', s.ctx, {})).toBeNull();
  });

  it('count nine keys per frame for a body the bake unparents (its world scale too)', () => {
    const s = deskScene();
    const root = s.empty('Crate', [0, 0, 1], { scale: [1.6, 1, 0.6] });
    s.box('Crate body', [0, 0, 0.2], 0.4, { parent: root });
    s.box('Loose', [3, 0, 1]);
    s.run('desk.physics_drop', { objects: ['Crate', 'Loose'], frame: 10 });
    const world = s.doc.getScene().rigidbody_world;
    const frames = world.frame_end - world.frame_start + 1;
    const e = estimateOperator('desk.physics_bake', s.ctx, {})!;
    // the part: location, rotation and scale; the loose box: location and rotation
    expect(e.keyframes).toBe((9 + 6) * frames);
    expect(s.run('desk.physics_bake', {}).keyframes).toBeLessThanOrEqual(e.keyframes!);
  });

  it('count every channel of a flight on every frame, and the objects it adds', () => {
    const s = deskScene();
    s.doc.addObject({ type: 'MESH', name: 'Kite', data: s.mesh('kite', kiteMesh), location: [0.5, 0, 1.3] });
    s.empty('Hand', [0, 0, 1.2]);
    const p = {
      flyer: 'Kite',
      anchor: 'Hand',
      length_m: 10,
      wind_dir_deg: 90,
      wind_mps: 6,
      frame_start: 1,
      frame_end: 200,
    };
    const parsed = s.reg.parseParams('desk.tether_fly', p) as Record<string, unknown>;
    const t = deskTetherObjects(s.doc, parsed)!;
    // the kite (6), the string (9) and five new segments (9 each)
    expect(t.channels).toBe(6 + 9 + 9 * TETHER_TAIL_SEGMENTS);
    expect(t.added).toBe(1 + TETHER_TAIL_SEGMENTS);
    const e = estimateOperator('desk.tether_fly', s.ctx, parsed)!;
    expect(e.objects).toBe(1 + TETHER_TAIL_SEGMENTS);
    expect(e.keyframes).toBe(t.channels * 201);
    const noTail = estimateOperator(
      'desk.tether_fly',
      s.ctx,
      s.reg.parseParams('desk.tether_fly', { ...p, tail: false }),
    )!;
    expect(noTail.keyframes).toBe((6 + 9) * 201);
    const longer = estimateOperator(
      'desk.tether_fly',
      s.ctx,
      s.reg.parseParams('desk.tether_fly', { ...p, frame_end: 2000 }),
    )!;
    expect(longer.bytes).toBeGreaterThan(e.bytes);
    const r = s.run('desk.tether_fly', p);
    expect(r.keyframes).toBeLessThanOrEqual(e.keyframes!);
    // a second flight adds nothing, and rewrites what the first keyed
    const again = estimateOperator('desk.tether_fly', s.ctx, parsed)!;
    expect(again.objects ?? 0).toBe(0);
    expect(again.bytes).toBeGreaterThan(e.bytes - 18_000 * (1 + TETHER_TAIL_SEGMENTS));
  });

  it("count a drive's frames from its path at its speed, and its wheels and pivots", () => {
    const s = deskScene();
    const car = syntheticCar(s);
    const p = { vehicle: 'Car', points: [[0, -40, 0]], frame_start: 1, speed_mps: 8 };
    const frames = deskVehicleFrames(s.doc, s.doc.getObject(car.root)!, p)!;
    // 40 m at 8 m/s, eased over 1.5 s
    expect(frames).toBe(Math.ceil((40 / 8 + 1.5) * 24) + 1);
    const e = estimateOperator('desk.vehicle_drive', s.ctx, s.reg.parseParams('desk.vehicle_drive', p))!;
    // the root (6 channels), four wheels and two pivots (one channel each)
    expect(e.keyframes).toBe(12 * (frames + 1));
    const r = s.run('desk.vehicle_drive', p);
    expect(r.frame_end).toBe(frames);
    expect(r.keyframes).toBeLessThanOrEqual(e.keyframes!);
    expect(
      deskVehicleFrames(s.doc, s.doc.getObject(car.root)!, { ...p, speed_mps: undefined, frame_end: 300 }),
    ).toBe(300);
    expect(deskVehicleFrames(s.doc, s.doc.getObject(car.root)!, { ...p, points: [[0, 0, 0]] })).toBeNull();
  });
});
