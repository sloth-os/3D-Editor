import { describe, expect, it } from 'vitest';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { Mat4 } from '../src/math/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import { freeRigidBodyCache, rigidBodyCacheBytes } from '../src/physics/rigid-body';
import { SIMULATION_BYTES_PER_KINEMATIC_FRAME } from '../src/physics/memory';
import { delayedStartFrame, newRigidBody } from '../src/physics/settings';
import { G, loc, physicsScene, range, rb, simulate } from './physics-helpers';

/*
 * Rigid bodies released at their start_frame (spec §4, review finding 3b): animated until then (they
 * follow their keys, parents and constraints as KINEMATIC bodies), simulated from there with the
 * velocity they had (inherit_velocity) plus their initial velocities; unchanged without a start frame.
 */

function key(doc: SceneDoc, id: string, path: string, index: number, keys: [number, number][]): void {
  doc.setFCurve({
    target_type: 'object',
    target_id: id,
    path,
    index,
    keyframes: keys.map(([frame, value]) => ({ frame, value, interpolation: 'LINEAR' as const })),
    extrapolation: 'CONSTANT',
    mute: false,
  });
}

/** World matrices of `id` at `frames`, evaluated in order with one evaluator (the simulation cached). */
function track(doc: SceneDoc, id: string, frames: number[]): Map<number, Mat4> {
  freeRigidBodyCache(doc);
  const ev = new SceneEvaluator(doc);
  return new Map(frames.map((f) => [f, ev.evaluate(f).byId.get(id)!.worldMatrix]));
}

describe('a rigid body with a start frame', () => {
  it('is left out of the simulation (at its own transform) until then, and falls from there', () => {
    const s = physicsScene();
    s.ground();
    const box = s.add('Box', s.cube(1), rb('ACTIVE', { start_frame: 20 }), { location: [0, 0, 5] });
    s.setWorld({ frame_start: 1, frame_end: 120 });
    const out = simulate(s.doc, range(1, 120));
    for (const f of range(1, 20)) expect(out.get(f)?.get(box), `frame ${f}`).toBeUndefined();
    expect(out.get(21)?.get(box)).toBeDefined();
    const z = track(s.doc, box, range(1, 120));
    for (const f of range(1, 20)) expect(loc(z.get(f)!)).toEqual([0, 0, 5]);
    // a free fall from rest at frame 20: ½·g·t² after 10 frames (a few millimetres of integration)
    expect(5 - loc(z.get(30)!)[2]).toBeCloseTo(0.5 * G * (10 / 24) ** 2, 1);
    expect(loc(z.get(120)!)[2]).toBeCloseTo(0.5, 2);
  });

  it('moves exactly like a body of a world that starts at its release (frame − 1)', () => {
    const late = physicsScene();
    late.ground();
    const a = late.add('Box', late.cube(1), rb('ACTIVE', { start_frame: 40 }), {
      location: [0, 0, 3],
      rotation_euler: [0.3, 0.2, 0.1],
    });
    late.setWorld({ frame_start: 1, frame_end: 140 });
    const early = physicsScene();
    early.ground();
    const b = early.add('Box', early.cube(1), rb('ACTIVE'), {
      location: [0, 0, 3],
      rotation_euler: [0.3, 0.2, 0.1],
    });
    early.setWorld({ frame_start: 40, frame_end: 140 });
    const ma = simulate(late.doc, range(1, 140));
    const mb = simulate(early.doc, range(40, 140));
    for (const f of range(41, 140)) {
      const x = ma.get(f)!.get(a)!;
      const y = mb.get(f)!.get(b)!;
      for (let k = 0; k < 16; k++) expect(x[k], `frame ${f}`).toBeCloseTo(y[k], 9);
    }
  });

  it('follows its animation until the release, then flies on with its velocity (inherit_velocity)', () => {
    const s = physicsScene();
    const box = s.add('Box', s.cube(0.3), rb('ACTIVE', { start_frame: 20, inherit_velocity: true }), {
      location: [0, 0, 1],
    });
    // a toss: 0.1 m a frame along +X and up (2.4 m/s each at 24 fps)
    key(s.doc, box, 'location', 0, [
      [1, 0],
      [20, 1.9],
    ]);
    key(s.doc, box, 'location', 2, [
      [1, 1],
      [20, 2.9],
    ]);
    s.setWorld({ frame_start: 1, frame_end: 80 });
    const m = track(s.doc, box, range(1, 60));
    expect(loc(m.get(10)!)[0]).toBeCloseTo(0.9, 9);
    expect(loc(m.get(10)!)[2]).toBeCloseTo(1.9, 9);
    // after the release it goes on along +X at 0.1 m a frame and keeps rising for a while
    const dx = loc(m.get(30)!)[0] - loc(m.get(20)!)[0];
    expect(dx).toBeGreaterThan(0.98);
    expect(dx).toBeLessThan(1.0);
    expect(loc(m.get(21)!)[2] - loc(m.get(20)!)[2]).toBeGreaterThan(0.08);
    const peak = Math.max(...range(20, 60).map((f) => loc(m.get(f)!)[2]));
    // v²/2g above the release: 2.4² / (2·9.81) ≈ 0.29 m
    expect(peak - 2.9).toBeGreaterThan(0.25);
    expect(peak - 2.9).toBeLessThan(0.32);
  });

  it('flies with its initial velocity alone without inherit_velocity, and adds it to the inherited one', () => {
    const run = (inherit: boolean) => {
      const s = physicsScene();
      const box = s.add(
        'Box',
        s.cube(0.3),
        rb('ACTIVE', { start_frame: 20, inherit_velocity: inherit, initial_linear_velocity: [0, 1.2, 0] }),
        { location: [0, 0, 20] },
      );
      key(s.doc, box, 'location', 0, [
        [1, 0],
        [20, 1.9],
      ]);
      s.setWorld({ frame_start: 1, frame_end: 60 });
      const m = track(s.doc, box, range(1, 44));
      return [0, 1].map((k) => loc(m.get(44)!)[k] - loc(m.get(20)!)[k]);
    };
    const [x0, y0] = run(false);
    expect(Math.abs(x0)).toBeLessThan(1e-9);
    expect(y0).toBeCloseTo(1.2, 1);
    const [x1, y1] = run(true);
    expect(x1).toBeCloseTo(2.4, 1);
    expect(y1).toBeCloseTo(1.2, 1);
  });

  it('spins with its initial angular velocity', () => {
    const s = physicsScene();
    const box = s.add(
      'Box',
      s.cube(0.3),
      rb('ACTIVE', { start_frame: 10, initial_angular_velocity: [0, 0, Math.PI], angular_damping: 0 }),
      { location: [0, 0, 30] },
    );
    s.setWorld({ frame_start: 1, frame_end: 40 });
    const m = track(s.doc, box, range(1, 34));
    // half a turn a second: a quarter after 12 frames, half after 24 (X axis from +X to +Y to −X)
    expect(m.get(10)![0]).toBeCloseTo(1, 9);
    expect(m.get(22)![0]).toBeCloseTo(0, 6);
    expect(m.get(22)![1]).toBeCloseTo(1, 6);
    expect(m.get(34)![0]).toBeCloseTo(-1, 6);
  });

  it('starts with the world when its start frame is not after the world start (as without one)', () => {
    const scene = (start: number | null) => {
      const s = physicsScene();
      s.ground();
      const box = s.add('Box', s.cube(1), rb('ACTIVE', { start_frame: start }), {
        location: [0.2, 0, 2],
        rotation_euler: [0.4, 0, 0],
      });
      s.setWorld({ frame_start: 5, frame_end: 60 });
      return { doc: s.doc, box };
    };
    expect(delayedStartFrame({ ...newRigidBody('ACTIVE'), start_frame: 5 }, 5)).toBeNull();
    expect(delayedStartFrame({ ...newRigidBody('ACTIVE'), start_frame: 6 }, 5)).toBe(6);
    expect(delayedStartFrame({ ...newRigidBody('ACTIVE'), start_frame: 9, kinematic: true }, 5)).toBeNull();
    const ref = scene(null);
    const expected = simulate(ref.doc, range(5, 60));
    for (const start of [1, 5]) {
      const t = scene(start);
      const got = simulate(t.doc, range(5, 60));
      for (const f of range(5, 60)) expect(got.get(f)?.get(t.box)).toEqual(expected.get(f)?.get(ref.box));
    }
  });

  it('is simulated again when its animation before the release changes', () => {
    const s = physicsScene();
    s.ground();
    const box = s.add('Box', s.cube(0.5), rb('ACTIVE', { start_frame: 30 }), { location: [0, 0, 2] });
    key(s.doc, box, 'location', 0, [
      [1, 0],
      [30, 1],
    ]);
    s.setWorld({ frame_start: 1, frame_end: 90 });
    const ev = new SceneEvaluator(s.doc);
    const before = loc(ev.evaluate(80).byId.get(box)!.worldMatrix);
    key(s.doc, box, 'location', 0, [
      [1, 0],
      [30, 3],
    ]);
    const after = loc(ev.evaluate(80).byId.get(box)!.worldMatrix);
    expect(after[0] - before[0]).toBeGreaterThan(1.9);
    // the same as a fresh simulation of the changed scene
    expect(after).toEqual(loc(track(s.doc, box, [80]).get(80)!));
  });

  it('counts the matrices it records before its release in the cache bytes', () => {
    const scene = (start: number | null) => {
      const s = physicsScene();
      s.ground();
      s.add('Box', s.cube(0.5), rb('ACTIVE', { start_frame: start }), { location: [0, 0, 1] });
      s.setWorld({ frame_start: 1, frame_end: 100 });
      simulate(s.doc, range(1, 100));
      return rigidBodyCacheBytes(s.doc);
    };
    // stepped into frames 2 … 50 as an animated body
    expect(scene(50) - scene(null)).toBe(SIMULATION_BYTES_PER_KINEMATIC_FRAME * 49);
  });
});
