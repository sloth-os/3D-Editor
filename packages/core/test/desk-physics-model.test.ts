import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Mat4, Vec3 } from '../src/math/types';
import { invert4, multiply4 } from '../src/math/mat4';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createConstraint } from '../src/constraints/catalogue';
import { newRigidBody } from '../src/physics/settings';
import { deskBakePlan, deskModelRoot } from '../src/desk/physics';
import { rigidFrame } from '../src/desk/physics/common';
import { deskScene, dist, originOf, syntheticCar } from './desk-physics-helpers';

/*
 * Physics on store models (review F2 of the Kite Day film): the presets give the rigid body to the
 * model's mesh part, and the bake keys the motion on the model's ROOT (what store.add returned, which
 * shots, desk.check and agents follow), the parts staying in it; the root's hold goes like a held
 * prop's; a part simulated on its own (a wheel) and bodies outside store models keep their own keys.
 */

type Scene = ReturnType<typeof deskScene>;

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** World matrices of `ids` at `frames`, evaluated in order (rigid bodies simulated). */
function worlds(doc: Scene['doc'], ids: string[], frames: number[]): Map<string, Mat4[]> {
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

/** Largest deviation of the 3×3 part of `m` from a rotation (MᵀM − I), and its determinant. */
function rigidity(m: Readonly<Mat4>): { error: number; det: number } {
  const col = (c: number): Vec3 => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let error = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) error = Math.max(error, Math.abs(dot(col(i), col(j)) - (i === j ? 1 : 0)));
  const [a, b, c] = [col(0), col(1), col(2)];
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    b[0] * (a[1] * c[2] - a[2] * c[1]) +
    c[0] * (a[1] * b[2] - a[2] * b[1]);
  return { error, det };
}

/** The keyed location channels of object `id` (F-curves). */
const locationCurves = (s: Scene, id: string) =>
  s.doc.listFCurves(id).filter((fc) => fc.target_type === 'object' && fc.path === 'location');

/** A store model as store.insert_files makes one: an EMPTY root with a store_id over its mesh parts. */
function importedModel(s: Scene, name: string, location: Vec3, init: Record<string, unknown> = {}) {
  const root = s.empty(name, location, {
    custom_props: { store_id: 'polyhaven:test_crate', store_source: 'polyhaven', license: 'CC0-1.0' },
    ...init,
  });
  return root;
}

describe('physics on store models', () => {
  it("keys a ball's root with its simulated part: the model stays together and the results name the root", () => {
    const s = deskScene();
    const ball = s.run('store.add', { model: 'soccer_ball', location: [0, 0, 0], name: 'Soccer Ball' });
    const part = ball.objects[1] as string;
    const thrown = s.run('desk.physics_throw', {
      object: 'Soccer Ball',
      target: [3, -2, 0],
      frame: 12,
      flight_s: 0.8,
    });
    // the presets name the root (what store.add returned) and the part that carries the rigid body
    expect(thrown.body).toEqual({
      object: ball.root,
      name: 'Soccer Ball',
      part: { object: part, name: 'ball' },
    });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 10);
    const live = worlds(s.doc, [part], frames);
    // physics_bake takes the model's root (its name) for its body
    const r = s.run('desk.physics_bake', { objects: ['Soccer Ball'] });
    expect(r.objects).toEqual([
      { object: ball.root, name: 'Soccer Ball', part: { object: part, name: 'ball' } },
    ]);
    expect(s.doc.getObject(part)!.parent).toBe(ball.root);
    expect(s.doc.getObject(part)!.rigid_body).toBeNull();
    expect(s.warnings.some((w) => w.includes('unparented'))).toBe(false);
    // the ball moves exactly as it was simulated, carried by its root
    const after = worlds(s.doc, [part, ball.root], frames);
    expectSameMotion(live, new Map([[part, after.get(part)!]]), frames);
    const offset = dist(originOf(after.get(part)![0]), originOf(after.get(ball.root)![0]));
    frames.forEach((f, i) => {
      const gap = dist(originOf(after.get(part)![i]), originOf(after.get(ball.root)![i]));
      expect(Math.abs(gap - offset), `frame ${f}`).toBeLessThan(1e-6);
    });
    // it flew: the root (what shots follow) is near the target after the landing, not where it started
    const landing = Math.round(thrown.landing_frame);
    const rootAt = originOf(after.get(ball.root)![frames.indexOf(landing)]);
    expect(dist(rootAt, [3, -2, 0])).toBeLessThan(0.2);
    expect(locationCurves(s, ball.root).length).toBe(3);
    expect(locationCurves(s, part).length).toBe(0);
  });

  it('keeps a model of several parts together: the parts the presets hang from the main one follow it', () => {
    const s = deskScene();
    const basket = s.run('store.add', { model: 'picnic_basket', location: [0, 0, 0.6], name: 'Basket' });
    const [main, lid] = basket.objects.slice(1) as string[];
    const drop = s.run('desk.physics_drop', { objects: ['Basket'], frame: 10, height: 0.4 });
    expect(drop.bodies).toEqual([
      { object: basket.root, name: 'Basket', part: { object: main, name: 'basket' } },
    ]);
    // the lid hangs from the basket now, the basket from the root
    expect(s.doc.getObject(lid)!.parent).toBe(main);
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 5);
    const live = worlds(s.doc, [main, lid], frames);
    expect(deskBakePlan(s.doc, {}).bodies).toEqual([
      { id: main, carrier: basket.root, from: 8, holds: [], body_holds: [], unparent: false },
    ]);
    s.run('desk.physics_bake', {});
    expectSameMotion(live, worlds(s.doc, [main, lid], frames), frames);
    expect(s.doc.getObject(main)!.parent).toBe(basket.root);
    expect(s.doc.getObject(lid)!.parent).toBe(main);
    // the root came down with it: from 1 m (0.6 + the lift) to the ground
    const root = worlds(s.doc, [basket.root], [1, end]).get(basket.root)!;
    expect(originOf(root[0])[2]).toBeCloseTo(1, 6);
    expect(originOf(root[1])[2]).toBeLessThan(0.05);
  });

  it("bakes a model carried by a hand from the hold, and removes the root's hold and its influence keys", () => {
    const s = deskScene();
    const hand = s.empty('Hand', [0, 0, 1.4]);
    const key = (
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
    // the hand swings forward and up until frame 30, where it lets the model go
    key(hand, 'location', 0, [
      [1, 0],
      [30, 2.9],
    ]);
    key(hand, 'location', 2, [
      [1, 1.4],
      [30, 2.0],
    ]);
    const melon = s.run('store.add', { model: 'watermelon', location: [0, 0, 0], name: 'Melon' });
    const part = melon.objects[1] as string;
    // as desk.actor_hold holds a model: a CHILD_OF on its root, its own transform keyed at the release
    s.doc.updateObject(melon.root, {
      constraints: [createConstraint('CHILD_OF', { name: 'Hold', target: hand })],
    });
    key(
      melon.root,
      'constraints["Hold"].influence',
      0,
      [
        [1, 1],
        [30, 0],
      ],
      'CONSTANT',
    );
    key(
      melon.root,
      'location',
      0,
      [
        [29, 0],
        [30, 2.9],
      ],
      'CONSTANT',
    );
    key(
      melon.root,
      'location',
      2,
      [
        [29, 0],
        [30, 2.0],
      ],
      'CONSTANT',
    );
    s.run('desk.physics_drop', { objects: ['Melon'], frame: 30 });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 5);
    const live = worlds(s.doc, [part], frames);
    // carried before the release, falling after it
    expect(originOf(live.get(part)![9])[0]).toBeCloseTo(0.9, 2);
    expect(originOf(live.get(part)![40])[2]).toBeLessThan(1.5);
    const plan = deskBakePlan(s.doc, {});
    expect(plan.bodies).toEqual([
      { id: part, carrier: melon.root, from: 1, holds: ['Hold'], body_holds: [], unparent: false },
    ]);
    const r = s.run('desk.physics_bake', {});
    expect(r.removed_constraints).toEqual([{ object: melon.root, name: 'Melon', constraints: ['Hold'] }]);
    expect(s.doc.getObject(melon.root)!.constraints).toEqual([]);
    expect(s.doc.listFCurves().some((fc) => fc.path.startsWith('constraints['))).toBe(false);
    expectSameMotion(live, worlds(s.doc, [part], frames), frames);
  });

  /** Keys one channel of `id` (linear unless said). */
  const keyChannel = (
    s: Scene,
    id: string,
    path: string,
    index: number,
    keys: [number, number][],
    interpolation: 'LINEAR' | 'CONSTANT' = 'LINEAR',
  ) =>
    s.doc.setFCurve({
      target_type: 'object',
      target_id: id,
      path,
      index,
      keyframes: keys.map(([frame, value]) => ({ frame, value, interpolation })),
      extrapolation: 'CONSTANT',
      mute: false,
    });

  it("removes a hold on a model's mesh part when it bakes the model's root: the part stays in its model", () => {
    const s = deskScene();
    const hand = s.empty('Hand', [0, 0, 1.4]);
    keyChannel(s, hand, 'location', 0, [
      [1, 0],
      [30, 2.9],
    ]);
    const melon = s.run('store.add', { model: 'watermelon', location: [0, 0, 0], name: 'Melon' });
    const part = melon.objects[1] as string;
    const rest = s.doc.getObject(part)!;
    // the hold is on the mesh part (a CHILD_OF on what an agent picked), let go at frame 30 where the
    // part's own location is keyed to the hand's (so it does not jump)
    s.doc.updateObject(part, {
      constraints: [createConstraint('CHILD_OF', { name: 'Hold', target: hand })],
    });
    keyChannel(
      s,
      part,
      'constraints["Hold"].influence',
      0,
      [
        [1, 1],
        [30, 0],
      ],
      'CONSTANT',
    );
    keyChannel(
      s,
      part,
      'location',
      0,
      [
        [29, rest.location[0]],
        [30, 2.9],
      ],
      'CONSTANT',
    );
    keyChannel(
      s,
      part,
      'location',
      2,
      [
        [29, rest.location[2]],
        [30, 1.4],
      ],
      'CONSTANT',
    );
    s.run('desk.physics_drop', { objects: ['Melon'], frame: 30 });
    const plan = deskBakePlan(s.doc, {});
    expect(plan.bodies).toEqual([
      expect.objectContaining({ id: part, carrier: melon.root, from: 1, body_holds: ['Hold'] }),
    ]);
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 5);
    const live = worlds(s.doc, [part], frames);
    const r = s.run('desk.physics_bake', {});
    // the part's hold goes with the bake (it would act on top of the root's keys) ...
    expect(r.removed_constraints).toEqual([{ object: part, name: rest.name, constraints: ['Hold'] }]);
    expect(s.doc.getObject(part)!.constraints).toEqual([]);
    expect(s.doc.listFCurves(part).some((fc) => fc.path.startsWith('constraints['))).toBe(false);
    // ... the part stays where it sits in its model, the root carrying the whole motion
    const ev = new SceneEvaluator(s.doc);
    for (const f of [1, 15, 29, 30, 40, end]) {
      const e = ev.evaluate(f);
      const local = multiply4(invert4(e.byId.get(melon.root)!.worldMatrix), e.byId.get(part)!.worldMatrix);
      expect(dist(originOf(local), rest.location), `frame ${f}`).toBeLessThan(1e-9);
    }
    expectSameMotion(live, worlds(s.doc, [part], frames), frames);
  });

  it("keys the root's scale after a hold that scaled it, as the simulation shows it", () => {
    const s = deskScene();
    // a scaled hand (as a scaled armature's hand bone holds): what it holds is drawn 1.5 times as large
    const hand = s.empty('Hand', [0, 0, 1.4], { scale: [1.5, 1.5, 1.5] });
    keyChannel(s, hand, 'location', 0, [
      [1, 0],
      [30, 2.9],
    ]);
    const melon = s.run('store.add', { model: 'watermelon', location: [0, 0, 0], name: 'Melon' });
    const part = melon.objects[1] as string;
    s.doc.updateObject(melon.root, {
      constraints: [createConstraint('CHILD_OF', { name: 'Hold', target: hand })],
    });
    keyChannel(
      s,
      melon.root,
      'constraints["Hold"].influence',
      0,
      [
        [1, 1],
        [30, 0],
      ],
      'CONSTANT',
    );
    // let go at frame 30 where its own transform takes over where the hand held it (its scale too)
    for (const [index, value] of [
      [0, 2.9],
      [2, 1.4],
    ] as const)
      keyChannel(
        s,
        melon.root,
        'location',
        index,
        [
          [29, 0],
          [30, value],
        ],
        'CONSTANT',
      );
    for (let index = 0; index < 3; index++)
      keyChannel(
        s,
        melon.root,
        'scale',
        index,
        [
          [29, 1],
          [30, 1.5],
        ],
        'CONSTANT',
      );
    s.run('desk.physics_drop', { objects: ['Melon'], frame: 30 });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 5);
    const held = range(1, 29);
    const live = worlds(s.doc, [part], frames);
    const liveRoot = worlds(s.doc, [melon.root], held);
    // carried at the hand's scale, its own scale 1 while held
    const m = liveRoot.get(melon.root)![9];
    expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(1.5, 6);
    s.run('desk.physics_bake', {});
    // keyed in its own space with the scale the hold gave it: the root while held, and the part (and
    // so the model) as the simulation shows it on every frame
    const scale = s.doc.getFCurve(`object:${melon.root}:scale:0`)!;
    expect(scale.keyframes.some((k) => k.frame < 30 && Math.abs(k.value - 1.5) < 1e-6)).toBe(true);
    expectSameMotion(liveRoot, worlds(s.doc, [melon.root], held), held);
    expectSameMotion(live, worlds(s.doc, [part], frames), frames);
  });

  it('moves a root rigidly when its part is turned inside a non-uniformly scaled root: no shear', () => {
    const s = deskScene();
    // a model sized by width, depth and height (a non-uniform root scale) whose part is turned in it
    const root = importedModel(s, 'Crate', [0, 0, 1.2], { scale: [1.6, 1, 0.6] });
    const part = s.box('crate', [0, 0, 0.2], 0.4, { parent: root, rotation_euler: [0.4, 0.3, 0.2] });
    s.run('desk.physics_throw', {
      object: 'Crate',
      target: [2, 0, 1],
      frame: 10,
      flight_s: 0.8,
      spin: [3, 5, 1],
    });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 10);
    const live = worlds(s.doc, [part], frames);
    s.run('desk.physics_bake', {});
    const after = worlds(s.doc, [part, root], frames);
    const root0 = invert4(after.get(root)![0]);
    const part0 = invert4(after.get(part)![0]);
    frames.forEach((f, i) => {
      // the root and the part move rigidly from where they were: the crate keeps its shape
      for (const [m, inv] of [
        [after.get(root)![i], root0],
        [after.get(part)![i], part0],
      ] as const) {
        const { error, det } = rigidity(multiply4(m, inv));
        expect(error, `frame ${f}`).toBeLessThan(1e-6);
        expect(det, `frame ${f}`).toBeCloseTo(1, 6);
      }
      // where the simulation put it, turned as it turned it
      const a = rigidFrame(after.get(part)![i]);
      const b = rigidFrame(live.get(part)![i]);
      for (let k = 0; k < 16; k++) expect(Math.abs(a[k] - b[k]), `frame ${f} [${k}]`).toBeLessThan(2e-3);
    });
    // it flew, with its root
    expect(dist(originOf(after.get(root)![frames.length - 1]), [0, 0, 1.2])).toBeGreaterThan(1);
  });

  it('keys a part simulated on its own by itself: one wheel falls off, the car stays', () => {
    const s = deskScene();
    const car = syntheticCar(s, 'Car', [0, 0, 1]);
    s.doc.updateObject(car.root, { custom_props: { store_id: 'builtin:sedan' } });
    expect(deskModelRoot(s.doc, car['wheel.FL'])).toBeNull();
    s.run('desk.physics_drop', { objects: ['wheel.FL'], frame: 5 });
    const plan = deskBakePlan(s.doc, {});
    expect(plan.bodies.map((b) => [b.carrier, b.unparent])).toEqual([[car['wheel.FL'], true]]);
    s.run('desk.physics_bake', {});
    expect(s.doc.getObject(car['wheel.FL'])!.parent).toBeNull();
    expect(locationCurves(s, car.root)).toEqual([]);
  });

  it("keys the car's root when the car itself is simulated: its body carries it, the wheels stay on", () => {
    const s = deskScene();
    const car = syntheticCar(s, 'Car', [0, 0, 1]);
    s.doc.updateObject(car.root, { custom_props: { store_id: 'builtin:sedan' } });
    const drop = s.run('desk.physics_drop', { objects: ['Car'], frame: 5 });
    const body = s.doc.listObjects().find((o) => o.name === 'body')!.id;
    expect(drop.bodies).toEqual([{ object: car.root, name: 'Car', part: { object: body, name: 'body' } }]);
    expect(deskModelRoot(s.doc, body)?.id).toBe(car.root);
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 5);
    const ids = [body, car['wheel.FL'], car['wheel.BR']];
    const live = worlds(s.doc, ids, frames);
    s.run('desk.physics_bake', {});
    expectSameMotion(live, worlds(s.doc, ids, frames), frames);
    for (const w of ['wheel.FL', 'wheel.BR']) expect(s.doc.isAncestor(car.root, car[w]), w).toBe(true);
    expect(locationCurves(s, car.root).length).toBe(3);
  });

  it('takes an imported model (no store_part) and resolves any ancestor to the bodies under it', () => {
    const s = deskScene();
    const group = s.empty('Props', [0, 0, 0]);
    const a = importedModel(s, 'Crate A', [0, 0, 1], { parent: group });
    const partA = s.box('mesh_0', [0, 0, 0.25], 0.5, { parent: a });
    const b = importedModel(s, 'Crate B', [3, 0, 1], { parent: group });
    const partB = s.box('mesh_0.001', [0, 0, 0.25], 0.5, { parent: b });
    s.empty('Lamp', [5, 5, 0]);
    s.run('desk.physics_drop', { objects: ['Crate A', 'Crate B'], frame: 4 });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end);
    const live = worlds(s.doc, [partA, partB], frames);
    const r = s.run('desk.physics_bake', { objects: ['Props', 'Lamp'] });
    expect(r.objects.map((o: { object: string }) => o.object).sort()).toEqual([a, b].sort());
    expect(s.warnings.some((w) => w.includes("Skipped 'Lamp'") && w.includes('none is under it'))).toBe(true);
    expectSameMotion(live, worlds(s.doc, [partA, partB], frames), frames);
    // a root with a parent is keyed in world space, unparented as any carrier; its parts stay in it
    expect(s.doc.getObject(a)!.parent).toBeNull();
    expect(s.warnings.some((w) => w.includes("'Crate A' was unparented from 'Props'"))).toBe(true);
    expect(s.doc.getObject(partA)!.parent).toBe(a);
    expect(s.doc.getObject(partB)!.parent).toBe(b);
  });

  it('holds the part in its model where its own keys would move it, and undoes as one step', () => {
    const s = deskScene();
    const um = new Y.UndoManager(s.doc.sharedTypes(), {
      trackedOrigins: new Set([s.doc.origin]),
      captureTimeout: 0,
    });
    const root = importedModel(s, 'Crate', [0, 0, 1.5]);
    const part = s.box('mesh_0', [0, 0, 0.25], 0.5, { parent: root });
    // the part sways in the model before it is dropped (its own keys, relative to the root)
    s.doc.setFCurve({
      target_type: 'object',
      target_id: part,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 40, value: 0.6, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    s.run('desk.physics_drop', { objects: ['Crate'], frame: 10 });
    const end = s.doc.getScene().rigidbody_world.frame_end;
    const frames = range(1, end + 5);
    const live = worlds(s.doc, [part], frames);
    s.run('desk.physics_bake', {});
    // after its release the part's keys no longer move it: the root carries the whole motion
    expectSameMotion(live, worlds(s.doc, [part], frames), frames);
    const fc = s.doc.getFCurve(`object:${part}:location:0`)!;
    expect(fc.keyframes.every((k) => k.frame <= 8)).toBe(true);
    // one undo step takes the bake back: the rigid body, no keys on the root, the part's keys
    um.undo();
    expect(s.doc.getObject(part)!.rigid_body).not.toBeNull();
    expect(locationCurves(s, root)).toEqual([]);
    expect(s.doc.getFCurve(`object:${part}:location:0`)!.keyframes.map((k) => k.frame)).toEqual([1, 40]);
  });

  it('keeps bodies outside store models as they were: an EMPTY without a store_id is not a model', () => {
    const s = deskScene();
    const root = s.empty('Rig', [0, 0, 1]);
    const part = s.box('Rig body', [0, 0, 0.25], 0.5, { parent: root, rigid_body: newRigidBody('ACTIVE') });
    expect(deskModelRoot(s.doc, part)).toBeNull();
    s.run('desk.physics_drop', { objects: ['Rig body'], frame: 4 });
    const r = s.run('desk.physics_bake', {});
    expect(r.objects).toEqual([{ object: part, name: 'Rig body' }]);
    expect(s.doc.getObject(part)!.parent).toBeNull();
    expect(s.warnings.some((w) => w.includes("'Rig body' was unparented from 'Rig'"))).toBe(true);
  });
});
