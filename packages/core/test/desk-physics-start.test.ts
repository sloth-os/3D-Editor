import { describe, expect, it } from 'vitest';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { Mat4 } from '../src/math/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import { FrameState } from '../src/eval/frame-state';
import { createConstraint } from '../src/constraints/catalogue';
import {
  RigidBodySimulator,
  animationInputsKey,
  freeRigidBodyCache,
  rigidBodyCacheBytes,
  rigidBodyCacheInfo,
  type RigidBodyHost,
} from '../src/physics/rigid-body';
import { SIMULATION_BYTES_PER_KINEMATIC_FRAME, documentSimulationBytes } from '../src/physics/memory';
import { RELEASE_TRACKED_STEPS, delayedStartFrame, newRigidBody } from '../src/physics/settings';
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

/** A rigid body host that counts how often the simulation reads the scene's transforms. */
function countingHost(doc: SceneDoc): RigidBodyHost & { calls: number } {
  const host = {
    calls: 0,
    transformsAt: (f: number) => {
      host.calls++;
      return new FrameState(doc, f).allWorldMatrices();
    },
    meshOf: (id: string) => {
      const o = doc.getObject(id);
      return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    },
  };
  return host;
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

  it('counts the matrices it records before its release in the cache bytes: its last steps only', () => {
    const scene = (start: number | null) => {
      const s = physicsScene();
      s.ground();
      s.add('Box', s.cube(0.5), rb('ACTIVE', { start_frame: start }), { location: [0, 0, 1] });
      s.setWorld({ frame_start: 1, frame_end: 100 });
      simulate(s.doc, range(1, 100));
      return rigidBodyCacheBytes(s.doc);
    };
    // dormant before, then placed at its pose of frame start − 2 and stepped into the next two frames
    expect(scene(50) - scene(null)).toBe(SIMULATION_BYTES_PER_KINEMATIC_FRAME * (RELEASE_TRACKED_STEPS + 1));
    // however late the release
    expect(scene(90)).toBe(scene(50));
  });

  it('estimates the matrices a delayed body records before its release as its cache counts them', () => {
    /** The estimate before simulating (to frame 100 and to 40), and the cache after simulating to 100. */
    const run = (start: number | null) => {
      const s = physicsScene();
      s.ground();
      s.add('Box', s.cube(0.5), rb('ACTIVE', { start_frame: start }), { location: [0, 0, 1] });
      s.add('Ball', s.cube(0.3), rb('ACTIVE', { start_frame: start === null ? null : start + 1 }), {
        location: [2, 0, 1],
      });
      s.setWorld({ frame_start: 1, frame_end: 100 });
      const estimate = documentSimulationBytes(s.doc, 100);
      const early = documentSimulationBytes(s.doc, 40);
      simulate(s.doc, range(1, 100));
      return { estimate, early, cache: rigidBodyCacheBytes(s.doc) };
    };
    const none = run(null);
    expect(none.estimate).toBe(none.cache);
    for (const start of [2, 3, 50, 99]) {
      const r = run(start);
      // what the cache keeps once simulated, however near frame_start the releases are
      expect(r.estimate, `start ${start}`).toBe(r.cache);
      expect(r.estimate, `start ${start}`).toBeGreaterThan(none.estimate);
    }
    // to a frame before the releases: none of their records yet
    expect(run(50).early).toBe(none.early);
  });

  it('reads the scene on a few frames for a release late in a long world, cold and after edits of its holder', () => {
    const s = physicsScene();
    s.ground({}, 200);
    // a crate let go at frame 3: the world starts at frame 1
    s.add('Crate', s.cube(0.5), rb('ACTIVE', { start_frame: 3 }), { location: [-3, 0, 1] });
    // a ball carried by a walking holder (a key every 10 frames) and let go at frame 2990
    const holder = s.doc.addObject({ type: 'EMPTY', name: 'Holder', location: [0, 0, 1.2] });
    const walk = (shift: (i: number) => number) =>
      key(
        s.doc,
        holder,
        'location',
        0,
        range(0, 299).map((i): [number, number] => [1 + 10 * i, 0.01 * i + shift(i)]),
      );
    walk(() => 0);
    const ball = s.add('Ball', s.cube(0.2), rb('ACTIVE', { start_frame: 2990 }), { parent: holder });
    s.setWorld({ frame_start: 1, frame_end: 3100 });
    const host = countingHost(s.doc);
    const sim = new RigidBodySimulator();
    freeRigidBodyCache(s.doc);
    const at = () => loc(sim.evaluate(s.doc, 3020, host)!.get(ball)!);
    const cold = at();
    // the frame_start transforms, the crate's two animated steps and the ball's (not one per frame)
    expect(host.calls).toBeLessThanOrEqual(2 + 2 * (RELEASE_TRACKED_STEPS + 1));
    // it was let go from the hand (x ≈ 2.99) and fell to the ground
    expect(cold[0]).toBeGreaterThan(2.9);
    expect(cold[2]).toBeCloseTo(0.1, 2);
    // renaming the holder changes nothing it moves by: nothing is checked again
    host.calls = 0;
    s.doc.updateObject(holder, { name: 'Holder (left hand)' });
    expect(at()).toEqual(cold);
    expect(host.calls).toBeLessThanOrEqual(1);
    // an early key of the holder is checked on the few frames that drive the bodies, and kept
    host.calls = 0;
    walk((i) => (i === 10 ? 0.5 : 0));
    expect(at()).toEqual(cold);
    expect(host.calls).toBeLessThanOrEqual(2 + 2 * (RELEASE_TRACKED_STEPS + 1));
    // a key that moves the hand at the release re-simulates, as cheaply, as a fresh simulation would
    host.calls = 0;
    walk((i) => (i >= 298 ? 0.5 : 0));
    const moved = at();
    expect(host.calls).toBeLessThanOrEqual(4 + 4 * (RELEASE_TRACKED_STEPS + 1));
    expect(moved[0] - cold[0]).toBeGreaterThan(0.4);
    freeRigidBodyCache(s.doc);
    expect(at()).toEqual(moved);
  });

  it("is released when its start frame is at or after the world's frame_end, and comes to rest", () => {
    const s = physicsScene();
    s.ground();
    s.add('Crate', s.cube(0.5), rb('ACTIVE'), { location: [3, 0, 2] });
    // a hold let go at frame 200 after the presets fitted the world to the crate's fall (1–40)
    const ball = s.add('Ball', s.cube(0.2), rb('ACTIVE', { start_frame: 200 }), { location: [0, 0, 1.5] });
    s.setWorld({ frame_start: 1, frame_end: 40 });
    const ev = new SceneEvaluator(s.doc);
    const z = (f: number) => loc(ev.evaluate(f).byId.get(ball)!.worldMatrix)[2];
    expect(z(150)).toBeCloseTo(1.5, 9);
    expect(z(200)).toBeCloseTo(1.5, 9);
    expect(z(215)).toBeLessThan(1.2);
    expect(z(400)).toBeCloseTo(0.1, 2);
    // the world ran on until it came to rest, and says why
    const info = rigidBodyCacheInfo(s.doc)!;
    expect(info.frame_end).toBeGreaterThan(200);
    expect(info.frame_end).toBeLessThan(400);
    expect(z(info.frame_end + 50)).toBe(z(info.frame_end));
    const issue = info.issues.find((i) => i.objectId === ball)!;
    expect(issue.level).toBe('WARNING');
    expect(issue.message).toMatch(/start_frame 200 is at or after the rigid body world's frame_end 40/);
    expect(issue.message).toMatch(/rigidbody\.world_set/);
  });

  it("warns when its start frame is before the world's frame_start (it starts with the world)", () => {
    const s = physicsScene();
    s.ground();
    const box = s.add('Box', s.cube(0.5), rb('ACTIVE', { start_frame: 3 }), { location: [0, 0, 2] });
    s.setWorld({ frame_start: 10, frame_end: 60 });
    simulate(s.doc, range(10, 30));
    const issue = rigidBodyCacheInfo(s.doc)!.issues.find((i) => i.objectId === box)!;
    expect(issue.message).toMatch(/start_frame 3 is before the rigid body world's frame_start 10/);
  });

  it('keeps the slower of its last two animated steps when its animation jumps at the release', () => {
    const run = (keys: [number, number][]) => {
      const s = physicsScene();
      const box = s.add('Box', s.cube(0.3), rb('ACTIVE', { start_frame: 30, inherit_velocity: true }), {
        location: [0, 0, 30],
      });
      key(s.doc, box, 'location', 0, keys);
      s.setWorld({ frame_start: 1, frame_end: 60 });
      const m = track(s.doc, box, range(1, 40));
      const issues = rigidBodyCacheInfo(s.doc)!.issues.filter((i) => i.objectId === box);
      return { dx: loc(m.get(40)!)[0] - loc(m.get(30)!)[0], issues };
    };
    // carried at 0.1 m a frame (2.4 m/s), its release pose keyed 3.2 m away (a stale hold)
    const late = run([
      [1, 0],
      [29, 2.8],
      [30, 6],
    ]);
    expect(late.dx).toBeGreaterThan(0.9);
    expect(late.dx).toBeLessThan(1.1);
    expect(late.issues.map((i) => i.message).join()).toMatch(/jumps at its release \(frame 30\)/);
    // the jump a frame earlier (let go a frame early), then 0.1 m a frame again
    const early = run([
      [1, 0],
      [28, 2.7],
      [29, 6],
      [30, 6.1],
    ]);
    expect(early.dx).toBeGreaterThan(0.9);
    expect(early.dx).toBeLessThan(1.1);
    expect(early.issues).toHaveLength(1);
    // a hand speeding up to 4.8 m/s (1.2 m/s more a frame) keeps its last step's velocity, silently
    const swing = run([
      [1, 0],
      [26, 0],
      [27, 0.05],
      [28, 0.15],
      [29, 0.3],
      [30, 0.5],
    ]);
    expect(swing.dx).toBeGreaterThan(1.9);
    expect(swing.dx).toBeLessThan(2.1);
    expect(swing.issues).toEqual([]);
  });

  it('is simulated again when what moves it before the release changes: a parent, a hold target', () => {
    const s = physicsScene();
    s.ground();
    const arm = s.doc.addObject({ type: 'EMPTY', name: 'Arm', location: [0, 0, 2] });
    key(s.doc, arm, 'location', 0, [
      [1, 0],
      [30, 1],
    ]);
    const hand = s.doc.addObject({ type: 'EMPTY', name: 'Hand', location: [0, 3, 2] });
    key(s.doc, hand, 'location', 0, [
      [1, 0],
      [30, 1],
    ]);
    const carried = s.add('Carried', s.cube(0.3), rb('ACTIVE', { start_frame: 30 }), { parent: arm });
    const held = s.add('Held', s.cube(0.3), rb('ACTIVE', { start_frame: 30 }));
    s.doc.updateObject(held, { constraints: [createConstraint('CHILD_OF', { name: 'Hold', target: hand })] });
    s.setWorld({ frame_start: 1, frame_end: 90 });
    const ev = new SceneEvaluator(s.doc);
    const at = (id: string) => loc(ev.evaluate(80).byId.get(id)!.worldMatrix);
    const farther = (id: string) =>
      key(s.doc, id, 'location', 0, [
        [1, 0],
        [30, 3],
      ]);
    // one at a time (either change alone re-simulates the whole world): the parent's motion…
    const carried0 = at(carried);
    const held0 = at(held);
    farther(arm);
    const carried1 = at(carried);
    expect(carried1[0] - carried0[0]).toBeGreaterThan(1.9);
    expect(at(held)).toEqual(held0);
    // …then the hold target's
    farther(hand);
    const held1 = at(held);
    expect(held1[0] - held0[0]).toBeGreaterThan(1.9);
    expect(at(carried)).toEqual(carried1);
    // what a fresh simulation gives
    expect(carried1).toEqual(loc(track(s.doc, carried, [80]).get(80)!));
    expect(held1).toEqual(loc(track(s.doc, held, [80]).get(80)!));
  });

  it('is simulated again when a value a driver reads into its pose changes (not only transforms)', () => {
    const s = physicsScene();
    s.ground();
    // a dial whose colour drives where the box is carried to before its release (none of it at frame 1)
    const dial = s.doc.addObject({ type: 'EMPTY', name: 'Dial', color: [0.5, 0, 0, 1] });
    const box = s.add('Box', s.cube(0.3), rb('ACTIVE', { start_frame: 30, inherit_velocity: false }), {
      location: [0, 0, 2],
    });
    s.doc.setDriver({
      target_type: 'object',
      target_id: box,
      path: 'location',
      index: 0,
      expression: 'max(0, frame - 20) * c * 0.2',
      variables: [{ name: 'c', target_type: 'object', target_id: dial, path: 'color', index: 0 }],
      mute: false,
    });
    s.setWorld({ frame_start: 1, frame_end: 90 });
    const key0 = animationInputsKey(s.doc, [box], new Map([[box, 30]]));
    const ev = new SceneEvaluator(s.doc);
    const x = () => loc(ev.evaluate(80).byId.get(box)!.worldMatrix)[0];
    expect(x()).toBeCloseTo(1, 1);
    s.doc.updateObject(dial, { color: [1, 0, 0, 1] });
    expect(animationInputsKey(s.doc, [box], new Map([[box, 30]]))).not.toBe(key0);
    expect(x()).toBeCloseTo(2, 1);
    expect(x()).toBe(loc(track(s.doc, box, [80]).get(80)!)[0]);
    // a field nothing reads (its name) keeps the key
    const key1 = animationInputsKey(s.doc, [box], new Map([[box, 30]]));
    s.doc.updateObject(dial, { name: 'Dial (big)' });
    s.doc.updateObject(box, { name: 'Box (red)' });
    expect(animationInputsKey(s.doc, [box], new Map([[box, 30]]))).toBe(key1);
  });
});
