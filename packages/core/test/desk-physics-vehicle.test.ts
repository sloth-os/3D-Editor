import { describe, expect, it } from 'vitest';
import { SceneEvaluator } from '../src/eval/evaluate';
import { VEHICLE_EASE_SECONDS, VEHICLE_MAX_STEER, deskDrivenDistance } from '../src/desk/physics';
import { channelsAt, deskScene, dist, originOf, syntheticCar, worldAt } from './desk-physics-helpers';

/*
 * desk.vehicle_drive (spec §4, §10 vehicle contract, phase 2): the vehicle's EMPTY root keyed along a
 * smooth path facing along it, each wheel.* spun about its local X by the distance over its radius,
 * the steer.* pivots turned toward the curvature (at most ±35°). A synthetic vehicle stands in for the
 * catalog's.
 */

const R = 0.35;

describe('desk.vehicle_drive', () => {
  it('drives the root along the path, facing along it, and stops on the last point', () => {
    const s = deskScene();
    const car = syntheticCar(s);
    const r = s.run('desk.vehicle_drive', {
      vehicle: 'Car',
      points: [[0, -20, 0]],
      frame_start: 1,
      speed_mps: 5,
    });
    // 20 m at 5 m/s, eased over 1.5 s at both ends: 5.5 s at 24 fps
    expect(r.length_m).toBeCloseTo(20, 6);
    expect(r.frame_end).toBe(1 + Math.ceil((20 / 5 + VEHICLE_EASE_SECONDS) * 24));
    expect(r.speed_mps).toBeCloseTo(5, 6);
    const ev = new SceneEvaluator(s.doc);
    const end = worldAt(s.doc, car.root, r.frame_end, ev);
    expect(dist(originOf(end), [0, -20, 0])).toBeLessThan(1e-6);
    // its front (its −Y axis) along the path, toward −Y
    const front = [-end[4], -end[5], -end[6]];
    expect(front[1]).toBeCloseTo(-1, 6);
    // and stays there after the drive
    expect(originOf(worldAt(s.doc, car.root, r.frame_end + 20, ev))).toEqual(originOf(end));
  });

  it('spins every wheel by the distance driven over its radius about its local X', () => {
    const s = deskScene();
    const car = syntheticCar(s);
    const r = s.run('desk.vehicle_drive', {
      vehicle: 'Car',
      points: [[0, -30, 0]],
      frame_start: 10,
      speed_mps: 6,
    });
    expect(r.wheels.map((w: { radius_m: number }) => w.radius_m)).toEqual([R, R, R, R]);
    const ev = new SceneEvaluator(s.doc);
    for (const f of [10, 30, 60, r.frame_end]) {
      const d = -originOf(worldAt(s.doc, car.root, f, ev))[1];
      // the left wheels turn forward with a positive angle, the mirrored right ones with a negative one
      expect(channelsAt(s.doc, car['wheel.FL'], f).rotation_euler[0]).toBeCloseTo(d / R, 4);
      expect(channelsAt(s.doc, car['wheel.BL'], f).rotation_euler[0]).toBeCloseTo(d / R, 4);
      expect(channelsAt(s.doc, car['wheel.FR'], f).rotation_euler[0]).toBeCloseTo(-d / R, 4);
      expect(channelsAt(s.doc, car['wheel.BR'], f).rotation_euler[0]).toBeCloseTo(-d / R, 4);
    }
    // rolling without slipping: the point of the tyre on the ground stands still for a moment
    for (const f of [40, 70]) {
      const w0 = worldAt(s.doc, car['wheel.BL'], f, ev);
      const w1 = worldAt(s.doc, car['wheel.BL'], f + 0.05, ev);
      const ground = [w0[12], w0[13], w0[14] - R];
      // the same material point a twentieth of a frame later (w1 · w0⁻¹ · ground)
      const local = invertApply(w0, ground);
      const moved = [0, 1, 2].map(
        (k) => w1[k] * local[0] + w1[4 + k] * local[1] + w1[8 + k] * local[2] + w1[12 + k],
      );
      const hub = dist(originOf(w1), originOf(w0));
      expect(dist(moved, ground)).toBeLessThan(hub / 10);
    }
  });

  it('steers into the turns, at most 35°, and keys nothing before the drive', () => {
    const s = deskScene();
    const car = syntheticCar(s);
    // left, then right
    const r = s.run('desk.vehicle_drive', {
      vehicle: 'Car',
      points: [
        [0, -10, 0],
        [6, -14, 0],
        [6, -24, 0],
        [0, -28, 0],
      ],
      frame_start: 20,
      speed_mps: 4,
    });
    const steer = (f: number) => channelsAt(s.doc, car['steer.FL'], f).rotation_euler[2];
    const angles = Array.from({ length: r.frame_end - 20 + 1 }, (_, i) => steer(20 + i));
    expect(Math.max(...angles)).toBeGreaterThan(0.1);
    expect(Math.min(...angles)).toBeLessThan(-0.1);
    for (const a of angles) expect(Math.abs(a)).toBeLessThanOrEqual(VEHICLE_MAX_STEER + 1e-9);
    // both pivots turn together; the rear wheels do not steer
    expect(channelsAt(s.doc, car['steer.FR'], 60).rotation_euler[2]).toBeCloseTo(steer(60), 9);
    // where it stood, and how, until frame_start
    expect(channelsAt(s.doc, car.root, 5).location).toEqual([0, 0, 0]);
    expect(channelsAt(s.doc, car['wheel.FL'], 5).rotation_euler[0]).toBe(0);
    expect(steer(5)).toBe(0);
  });

  it('ends at frame_end when given one, and refuses both speed_mps and frame_end', () => {
    const s = deskScene();
    const car = syntheticCar(s);
    const r = s.run('desk.vehicle_drive', {
      vehicle: 'Car',
      points: [[10, -10, 0]],
      frame_start: 1,
      frame_end: 73,
    });
    expect(r.frame_end).toBe(73);
    const length = r.length_m as number;
    expect(dist(originOf(worldAt(s.doc, car.root, 73)), [10, -10, 0])).toBeLessThan(1e-6);
    // (both reported to three decimals)
    expect(r.speed_mps).toBeCloseTo(length / (72 / 24 - VEHICLE_EASE_SECONDS), 3);
    expect(
      s.reg.run(s.ctx, 'desk.vehicle_drive', {
        vehicle: 'Car',
        points: [[0, -5, 0]],
        frame_start: 1,
        frame_end: 50,
        speed_mps: 3,
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(
      s.reg.run(s.ctx, 'desk.vehicle_drive', {
        vehicle: 'Car',
        points: [[0, 0, 0]],
        frame_start: 1,
        speed_mps: 3,
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('drives a vehicle without wheels, warning that only it moves', () => {
    const s = deskScene();
    const crate = s.box('Crate', [0, 0, 0.25]);
    const r = s.run('desk.vehicle_drive', {
      vehicle: 'Crate',
      points: [[0, -5, 0.25]],
      frame_start: 1,
      speed_mps: 5,
    });
    expect(r.wheels).toEqual([]);
    expect(s.warnings.some((w) => /no wheel/.test(w))).toBe(true);
    expect(dist(originOf(worldAt(s.doc, crate, r.frame_end)), [0, -5, 0.25])).toBeLessThan(1e-6);
  });

  it('speeds up and slows down over the ease time, cruising between', () => {
    const d = (t: number) => deskDrivenDistance(t, 10, 40, 1.5);
    expect(d(0)).toBe(0);
    expect(d(10)).toBe(40);
    // cruise: 40 m over 10 − 1.5 s
    const cruise = 40 / 8.5;
    expect(d(5) - d(4)).toBeCloseTo(cruise, 9);
    expect(d(0.75)).toBeCloseTo((0.5 * cruise * 0.75 ** 2) / 1.5, 9);
    expect(d(10) - d(9.25)).toBeCloseTo((0.5 * cruise * 0.75 ** 2) / 1.5, 9);
    for (let t = 0; t < 10; t += 0.25) expect(d(t + 0.25)).toBeGreaterThanOrEqual(d(t));
  });
});

/** `m⁻¹ · p` for a rigid matrix with uniform columns (rotation and translation, scale 1). */
function invertApply(m: number[] | Float64Array, p: number[]): number[] {
  const q = [p[0] - m[12], p[1] - m[13], p[2] - m[14]];
  return [0, 1, 2].map((c) => m[c * 4] * q[0] + m[c * 4 + 1] * q[1] + m[c * 4 + 2] * q[2]);
}
