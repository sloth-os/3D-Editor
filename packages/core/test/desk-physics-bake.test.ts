import { describe, expect, it } from 'vitest';
import type { Mat4 } from '../src/math/types';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createConstraint } from '../src/constraints/catalogue';
import { newRigidBody } from '../src/physics/settings';
import { DESK_BAKE_MAX_BODY_FRAMES, deskBakePlan } from '../src/desk/physics';
import { deskScene, originOf } from './desk-physics-helpers';

/*
 * desk.physics_bake (review finding 3c): the simulated motion written as keyframes that reproduce the
 * bodies' world-space motion (location and compatible eulers, redundant keys dropped), the rigid
 * bodies removed, a held prop's hold constraint and its influence keys removed with the hand's motion
 * baked into the keys; refused over the budget of 2,000,000 body frames.
 */

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** World matrices of `ids` at `frames`, evaluated in order. */
function worlds(doc: ReturnType<typeof deskScene>['doc'], ids: string[], frames: number[]) {
  const ev = new SceneEvaluator(doc);
  const out = new Map<string, Mat4[]>(ids.map((id) => [id, []]));
  for (const f of frames) {
    const e = ev.evaluate(f);
    for (const id of ids) out.get(id)!.push(e.byId.get(id)!.worldMatrix);
  }
  return out;
}

function expectSameMotion(a: Map<string, Mat4[]>, b: Map<string, Mat4[]>, frames: number[]) {
  for (const [id, ms] of a)
    ms.forEach((m, i) => {
      const n = b.get(id)![i];
      for (let k = 0; k < 16; k++) {
        const tol = k >= 12 ? 1e-3 : 2e-3;
        expect(Math.abs(m[k] - n[k]), `${id} frame ${frames[i]} [${k}]`).toBeLessThan(tol);
      }
    });
}

describe('desk.physics_bake', () => {
  it('reproduces the simulation within a millimetre and removes the rigid bodies', () => {
    const s = deskScene();
    const a = s.box('Crate', [0, 0, 2], 0.5, { rotation_euler: [0.4, 0.3, 0.2] });
    const b = s.ball('Ball', [0.1, 0.05, 3.5]);
    s.run('desk.physics_drop', { objects: ['Crate', 'Ball'], frame: 12 });
    s.run('desk.physics_push', { object: 'Ball', direction: [1, 0, 0], speed_mps: 2, frame: 12 });
    const range0 = s.doc.getScene().rigidbody_world;
    const frames = range(1, range0.frame_end + 10);
    const live = worlds(s.doc, [a, b], frames);
    const r = s.run('desk.physics_bake', {});
    expect(r.objects.map((o: { object: string }) => o.object).sort()).toEqual([a, b].sort());
    expect(r.frame_start).toBe(11);
    expect(r.frame_end).toBe(range0.frame_end);
    for (const id of [a, b]) {
      const o = s.doc.getObject(id)!;
      expect(o.rigid_body).toBeNull();
      expect(o.custom_props?.rigid_body_baked).toBe(`frames 11-${range0.frame_end} step 1`);
    }
    expectSameMotion(live, worlds(s.doc, [a, b], frames), frames);
    // redundant keys dropped: a body at rest keeps no key per frame
    const keys = s.doc.getFCurve(`object:${a}:location:2`)!.keyframes.length;
    expect(keys).toBeLessThan(range0.frame_end - 11);
    expect(r.keyframes).toBeGreaterThan(0);
  });

  it('bakes a held prop from where its hold starts and removes the hold and its influence keys', () => {
    const s = deskScene();
    const hand = s.empty('Hand', [0, 0, 1.4]);
    const keyed = (
      id: string,
      path: string,
      index: number,
      keys: [number, number][],
      interpolation = 'LINEAR',
    ) =>
      s.doc.setFCurve({
        target_type: 'object',
        target_id: id,
        path,
        index,
        keyframes: keys.map(([frame, value]) => ({
          frame,
          value,
          interpolation: interpolation as 'LINEAR' | 'CONSTANT',
        })),
        extrapolation: 'CONSTANT',
        mute: false,
      });
    // the hand swings forward and up until frame 30, where the prop leaves it
    keyed(hand, 'location', 0, [
      [1, 0],
      [30, 2.9],
    ]);
    keyed(hand, 'location', 2, [
      [1, 1.4],
      [30, 2.0],
    ]);
    const prop = s.box('Prop', [0, 0, 0], 0.2);
    s.doc.updateObject(prop, {
      constraints: [createConstraint('CHILD_OF', { name: 'Hold', target: hand })],
      rigid_body: { ...newRigidBody('ACTIVE'), start_frame: 30, inherit_velocity: true },
    });
    keyed(
      prop,
      'constraints["Hold"].influence',
      0,
      [
        [1, 1],
        [30, 0],
      ],
      'CONSTANT',
    );
    // where the hand leaves it (its own channels take over at the release)
    keyed(
      prop,
      'location',
      0,
      [
        [29, 0],
        [30, 2.9],
      ],
      'CONSTANT',
    );
    keyed(
      prop,
      'location',
      2,
      [
        [29, 0],
        [30, 2.0],
      ],
      'CONSTANT',
    );
    s.run('desk.physics_setup', { objects: ['Prop'] });
    s.doc.updateScene({ rigidbody_world: { ...s.doc.getScene().rigidbody_world, frame_start: 29 } });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end);
    const live = worlds(s.doc, [prop], frames);
    // in the hand before the release, then flying on with the hand's velocity
    expect(originOf(live.get(prop)![9])[0]).toBeCloseTo(0.9, 6);
    expect(originOf(live.get(prop)![35])[0]).toBeGreaterThan(2.9 + 0.5);
    const plan = deskBakePlan(s.doc, {});
    expect(plan.bodies).toEqual([{ id: prop, from: 1, holds: ['Hold'] }]);
    const r = s.run('desk.physics_bake', {});
    expect(r.removed_constraints).toEqual([{ object: prop, name: 'Prop', constraints: ['Hold'] }]);
    expect(s.doc.getObject(prop)!.constraints).toEqual([]);
    expect(s.doc.listFCurves().some((fc) => fc.path.startsWith('constraints['))).toBe(false);
    expectSameMotion(live, worlds(s.doc, [prop], frames), frames);
  });

  it('refuses a bake over the budget, naming what to lower', () => {
    const s = deskScene();
    s.doc.updateScene({
      rigidbody_world: {
        ...s.doc.getScene().rigidbody_world,
        enabled: true,
        frame_start: 1,
        frame_end: 20000,
      },
    });
    for (let i = 0; i < 101; i++) s.box(`Crate ${i}`, [i, 0, 1], 0.5, { rigid_body: newRigidBody('ACTIVE') });
    const r = s.reg.run(s.ctx, 'desk.physics_bake', {});
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(r.error).toContain(`${101 * 20000} body frames`);
    expect(r.error).toContain(String(DESK_BAKE_MAX_BODY_FRAMES));
    expect(r.error).toMatch(/objects/);
    expect(r.error).toMatch(/frame_start, frame_end/);
    // a part of it fits
    expect(deskBakePlan(s.doc, { frame_end: 19_000 }).body_frames).toBe(101 * 19_000);
  });

  it('refuses without a world or simulated bodies, and skips bodies that are not simulated', () => {
    const s = deskScene();
    s.box('Crate', [0, 0, 1]);
    expect(s.reg.run(s.ctx, 'desk.physics_bake', {})).toMatchObject({ ok: false, code: 'POLL_FAILED' });
    s.run('desk.physics_setup', { objects: ['Crate'] });
    const wall = s.box('Wall', [3, 0, 1]);
    s.run('desk.physics_setup', { objects: ['Wall'], kind: 'passive' });
    const r = s.run('desk.physics_bake', { objects: ['Crate', 'Wall'] });
    expect(r.objects).toHaveLength(1);
    expect(s.warnings.some((w) => w.includes("Skipped 'Wall'"))).toBe(true);
    expect(s.doc.getObject(wall)!.rigid_body).not.toBeNull();
  });
});
