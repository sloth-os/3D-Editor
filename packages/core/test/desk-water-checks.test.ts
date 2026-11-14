import { describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../src/math/types';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ShotData } from '../src/doc/types';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { createConstraint } from '../src/constraints/catalogue';
import { createCube, createPlane, createUVSphere } from '../src/mesh/primitives';
import { newRigidBody } from '../src/physics/settings';
import { DeskScene } from '../src/desk/layout';
import { DESK_PROPS } from '../src/desk/props';
import { getShots, setShots } from '../src/desk/shots';
import { checkShots, type DeskIssue } from '../src/desk/checks';
import { inWaterSpans, waterAt } from '../src/desk/water';
import { RIGID_BODY_BAKED_PROP } from '../src/desk/physics/common';
import { deskDoc, rideoCamera, standIn } from './desk-fixtures';
import { dialogueClip, importClip } from './desk-rideo-fixtures';

/*
 * desk.check's water checks (checks.ts): walks_on_water (error) for an actor whose mark is on water
 * in the picture, with the frames merged into ranges, also for a dash across a ditch between two
 * samples, and not for a rider (her mount is checked), a rower her boat carries, an actor put away
 * by a hide key or not drawn by renders, one jumping clear of the water, one on a bridge over it or
 * under water raised far above it, nor at the frames it belongs in the water (desk_in_water: a
 * swimmer, rideo's cast in its water); body_in_water (warning) for a physics body in water it does
 * not float on, baked or simulated, and not from the frame desk.physics_bake let it float
 * (desk_floats), its bounds measured only where water is within its reach.
 */

/** A flat square of water `size` m wide centred at `at` (editor coordinates). */
function pond(doc: SceneDoc, at: Vec3, size = 4): string {
  return doc.addObject({
    type: 'MESH',
    name: 'Pond',
    data: doc.addMesh('Pond', createPlane({ size })),
    location: at,
    custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: 'Pond', desk_shape: 'water' },
  });
}

/** Keys channel `path` of `id` at frames (linear). */
function key(doc: SceneDoc, id: string, path: string, keys: [number, Vec3][]) {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path, index: i });
    for (const [f, v] of keys) fc = insertKeyframe(fc, f, v[i], 'LINEAR');
    doc.setFCurve(fc);
  }
}

/**
 * A scene: the pond 4 m wide at x 2–6, y −2–2 (its water 3 cm up), a wide camera from the front
 * (y −10) that sees all of it, and one shot of frames 1–48 on it.
 */
function scene() {
  const doc = deskDoc();
  const water = pond(doc, [4, 0, 0.03]);
  const cam = rideoCamera(doc, 'Wide', [3, 1.6, 10], [3, 0.6, 0], 24);
  const shot = (subjects: string[], camera = cam): ShotData => {
    setShots(doc, [{ name: 'S1', camera, frame_start: 1, frame_end: 48, subjects }]);
    return getShots(doc)[0];
  };
  return { doc, water, cam, shot };
}

const water = (issues: DeskIssue[]) =>
  issues.filter((i) => i.code === 'walks_on_water' || i.code === 'body_in_water');

describe('walks_on_water', () => {
  it('reports an actor walking across the water, its frames merged into a range', () => {
    const { doc, water: pondId, shot } = scene();
    const A = standIn(doc, 'Ada', 0, 0);
    // 8 m to the right over frames 1–48: on the water from x 2 (frame 13) to x 6 (frame 36)
    key(doc, A, 'location', [
      [1, [0, 0, 0]],
      [48, [8, 0, 0]],
    ]);
    const s = shot([A]);
    expect(water(checkShots(doc).issues)).toEqual([
      {
        code: 'walks_on_water',
        severity: 'error',
        shot: s.id,
        objects: [A, pondId],
        message:
          "Ada stands on the water of Pond in shot 'S1' (frames 13–36) as if it were solid ground: route the " +
          "move around it with desk.actor_move points (or raise them onto a bridge's deck), or move the mark; " +
          'for a swimmer or a wader, key the move with in_water: true (desk.actor_move, or desk.actor_add for ' +
          'one that stays in the water)',
      },
    ]);
  });

  it('sees a dash across the water between two samples a second apart', () => {
    const { doc, shot } = scene();
    const A = standIn(doc, 'Pip', 0, 0);
    // 9 m in 16 frames from frame 26: on the water from x 2 (frame 30) to x 6 (frame 36)
    key(doc, A, 'location', [
      [26, [0, 0, 0]],
      [42, [9, 0, 0]],
    ]);
    shot([A]);
    expect(water(checkShots(doc).issues).map((i) => i.message.match(/\(([^)]*)\)/)![1])).toEqual([
      'frames 30–36',
    ]);
  });

  it('counts every actor in the picture, and none the camera does not see', () => {
    const { doc, cam, shot } = scene();
    const A = standIn(doc, 'Ada', 0, 0);
    // Ben stands in the pond the whole shot; Ada, the subject, stays dry
    const B = standIn(doc, 'Ben', 4, 0);
    shot([A]);
    expect(
      water(checkShots(doc).issues).map((i) => [i.objects[0], i.message.match(/\(([^)]*)\)/)![1]]),
    ).toEqual([[B, 'frames 1–48']]);
    // a camera turned away from the pond sees nobody on it
    const away = rideoCamera(doc, 'Away', [3, 1.6, 10], [-12, 1.6, 10], 50);
    shot([A], away);
    expect(water(checkShots(doc).issues)).toEqual([]);
    shot([A], cam);
    expect(water(checkShots(doc).issues)).toHaveLength(1);
  });

  it('leaves a rider to her mount', () => {
    const { doc, shot } = scene();
    const M = standIn(doc, 'Maple', 4, 0, 90, 1.6);
    const A = standIn(doc, 'Ada', 4, 0, 90);
    // seated with her origin at her mount's (a low saddle), on the water as Maple's is
    doc.updateObject(A, {
      location: [0, 0, 0],
      rotation_euler: [0, 0, 0],
      constraints: [createConstraint('CHILD_OF', { name: 'Ride Maple', target: M })],
    });
    shot([A, M]);
    const issues = water(checkShots(doc).issues);
    expect(issues.map((i) => i.objects[0])).toEqual([M]);
    // off the horse (the ride's influence keyed to 0 from frame 25), she stands in the water herself
    let fc = createFCurve({
      target_type: 'object',
      target_id: A,
      path: 'constraints["Ride Maple"].influence',
      index: 0,
    });
    fc = insertKeyframe(fc, 24, 1, 'CONSTANT');
    fc = insertKeyframe(fc, 25, 0, 'CONSTANT');
    doc.setFCurve(fc);
    doc.updateObject(A, { location: [4, 0.5, 0] });
    const after = water(checkShots(doc).issues);
    expect(after.map((i) => [i.objects[0], i.message.match(/\(([^)]*)\)/)![1]])).toEqual(
      expect.arrayContaining([
        [M, 'frames 1–48'],
        [A, 'frames 25–48'],
      ]),
    );
    expect(after).toHaveLength(2);
  });

  it('leaves out an actor put away by a hide key, one jumping clear of the water, and one on a bridge', () => {
    const { doc, shot } = scene();
    // put away (scaled to nothing) in the pond
    const hidden = standIn(doc, 'Hidden', 3, 0);
    doc.updateObject(hidden, { scale: [1e-8, 1e-8, 1e-8] });
    // her mark on the water, her body (the box) half a metre up: a jump
    const jumper = standIn(doc, 'Jumper', 4, 0);
    const body = doc.listObjects().find((o) => o.parent === jumper)!;
    doc.updateObject(body.id, { location: [0, 0, 0.7] });
    // on a footbridge deck 0.3 m over the water
    const deck = doc.addObject({
      type: 'MESH',
      name: 'Footbridge',
      data: doc.addMesh('deck', createCube({ size: 1 })),
      location: [5, 0, 0.25],
      scale: [1, 5, 0.1],
      custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: 'Footbridge' },
    });
    const walker = standIn(doc, 'Walker', 5, 0);
    doc.updateObject(walker, { location: [5, 0, 0.3] });
    shot([hidden, jumper, walker]);
    expect(deck).toBeTruthy();
    expect(water(checkShots(doc).issues)).toEqual([]);
    // the jumper landing back in the water is on it again
    doc.updateObject(body.id, { location: [0, 0, 0.2] });
    expect(water(checkShots(doc).issues).map((i) => i.objects[0])).toEqual([jumper]);
  });
});

describe('walks_on_water: who belongs in the water, and what an actor stands on', () => {
  /** The frames of each walks_on_water issue. */
  const frames = (doc: SceneDoc) =>
    water(checkShots(doc).issues).map((i) => i.message.match(/\(([^)]*)\)/)![1]);

  it('leaves an actor alone at the frames its desk_in_water says it belongs in the water (a swimmer)', () => {
    const { doc, shot } = scene();
    // Ben in the pond the whole shot
    const B = standIn(doc, 'Ben', 4, 0);
    shot([B]);
    expect(frames(doc)).toEqual(['frames 1–48']);
    const inWater = (v: string | boolean) =>
      doc.updateObject(B, { custom_props: { ...doc.getObject(B)!.custom_props, [DESK_PROPS.inWater]: v } });
    inWater(true);
    expect(frames(doc)).toEqual([]);
    // swimming until frame 12 and from 30 to 40: standing on the water between and after
    inWater('..12, 30..40');
    expect(frames(doc)).toEqual(['frames 13–29, 41–48']);
  });

  it('leaves a rower to the boat that carries her, not an actor hung from a plain empty', () => {
    const { doc, shot } = scene();
    // a rowboat on the pond (a store model's root carries what hangs from it), its rower seated in it
    const boat = doc.addObject({
      type: 'EMPTY',
      name: 'Rowboat',
      location: [4, 0, 0.03],
      custom_props: { [DESK_PROPS.role]: 'prop', [DESK_PROPS.storeId]: 'builtin:rowboat' },
    });
    const rower = standIn(doc, 'Rower', 0, 0);
    doc.updateObject(rower, { parent: boat, location: [0, 0, 0.05] });
    // one held to the boat by a constraint (a child on the carrier's shoulders, as it were)
    const held = standIn(doc, 'Held', 0, 0);
    doc.updateObject(held, {
      constraints: [createConstraint('COPY_LOCATION', { name: 'On the boat', target: boat })],
    });
    // a plain empty only moves what hangs from it: the actor under it stands on the water herself
    const handle = doc.addObject({ type: 'EMPTY', name: 'Handle', location: [3, 1, 0] });
    const hung = standIn(doc, 'Hung', 0, 0);
    doc.updateObject(hung, { parent: handle });
    shot([rower, held, hung]);
    expect(water(checkShots(doc).issues).map((i) => i.objects[0])).toEqual([hung]);
    // out of the boat, where she sat, the rower stands on the water
    doc.updateObject(rower, { parent: null, location: [4, 0, 0.08] });
    expect(
      water(checkShots(doc).issues)
        .map((i) => i.objects[0])
        .sort(),
    ).toEqual([rower, hung].sort());
  });

  it('leaves out an actor renders do not draw, not one with a part they draw', () => {
    const { doc, shot } = scene();
    // a stand-in whose body renders do not draw
    const ghost = standIn(doc, 'Ghost', 3, 0);
    const body = doc.listObjects().find((o) => o.parent === ghost)!;
    doc.updateObject(body.id, { hide_render: true });
    // Ben: a hat renders do not draw, his body they do, and his own empty hidden (renders do not
    // inherit it)
    const ben = standIn(doc, 'Ben', 5, 0);
    doc.addObject({
      type: 'MESH',
      name: 'Ben hat',
      data: doc.addMesh('hat', createCube({ size: 0.2 })),
      parent: ben,
      location: [0, 0, 1.7],
      hide_render: true,
    });
    doc.updateObject(ben, { hide_render: true });
    shot([ghost, ben]);
    expect(water(checkShots(doc).issues).map((i) => i.objects[0])).toEqual([ben]);
  });

  it('sees a dash across a ditch narrower than the samples are apart, whatever frame it starts at', () => {
    const doc = deskDoc();
    // a ditch 0.8 m wide across the path, at x 3.6–4.4
    doc.addObject({
      type: 'MESH',
      name: 'Ditch',
      data: doc.addMesh('Ditch', createPlane({ size: 1 })),
      location: [4, 0, 0.02],
      scale: [0.8, 10, 1],
      custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: 'Ditch', desk_shape: 'water' },
    });
    const cam = rideoCamera(doc, 'Wide', [4, 1.6, 10], [4, 0.6, 0], 24);
    const A = standIn(doc, 'Pip', 0, 0);
    setShots(doc, [{ name: 'S1', camera: cam, frame_start: 1, frame_end: 48, subjects: [A] }]);
    // 8 m in 32 frames from frame `start`: over the ditch (x 3.75, 4 and 4.25) for three frames only,
    // between two of the samples (6 frames apart) or on one
    for (let start = 1; start <= 6; start++) {
      key(doc, A, 'location', [
        [start, [0, 0, 0]],
        [start + 32, [8, 0, 0]],
      ]);
      expect(frames(doc)).toEqual([`frames ${start + 15}–${start + 17}`]);
    }
  });

  it('an actor under water raised far above her feet (an aqueduct) does not stand on it', () => {
    const { doc, shot } = scene();
    // the aqueduct's water 2 m up, over Ada's mark
    doc.addObject({
      type: 'MESH',
      name: 'Aqueduct',
      data: doc.addMesh('Aqueduct', createPlane({ size: 2 })),
      location: [-3, 0, 2],
      custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: 'Aqueduct', desk_shape: 'water' },
    });
    const A = standIn(doc, 'Ada', -3, 0);
    shot([A]);
    expect(waterAt(doc, [-3, 0, 0], 1)?.label).toBe('Aqueduct');
    expect(water(checkShots(doc).issues)).toEqual([]);
  });
});

describe('body_in_water', () => {
  /** A ball of radius 0.11 baked (its keys) from dry ground into the pond by frame 20. */
  function bakedBall(doc: SceneDoc, props: Record<string, string | number> = {}) {
    const ball = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('ball', createUVSphere({ radius: 0.11, segments: 16, ring_count: 8 })),
      location: [0, 0, 0.11],
      custom_props: { [RIGID_BODY_BAKED_PROP]: 'frames 1-48 step 1', ...props },
    });
    key(doc, ball, 'location', [
      [1, [0, 0, 0.11]],
      [20, [4, 0, 0.11]],
    ]);
    return ball;
  }

  it('reports a baked body that rolls into the water and stays there', () => {
    const { doc, water: pondId, shot } = scene();
    const ball = bakedBall(doc);
    const s = shot([ball]);
    expect(water(checkShots(doc).issues)).toEqual([
      {
        code: 'body_in_water',
        severity: 'warning',
        shot: s.id,
        objects: [ball, pondId],
        message:
          "Ball is in the water of Pond in shot 'S1' (frames 11–48) and does not float: re-aim " +
          'desk.physics_throw (or the push or drop) so that it comes down on dry ground, or release it again ' +
          "and bake it with desk.physics_bake {water: 'float'} so that it floats",
      },
    ]);
  });

  it('not from the frame desk.physics_bake let it float (desk_floats)', () => {
    const { doc, shot } = scene();
    const ball = bakedBall(doc, { [DESK_PROPS.floats]: 15 });
    shot([ball]);
    expect(water(checkShots(doc).issues).map((i) => i.message.match(/\(([^)]*)\)/)![1])).toEqual([
      'frames 11–14',
    ]);
    doc.updateObject(ball, {
      custom_props: { [RIGID_BODY_BAKED_PROP]: 'frames 1-48 step 1', [DESK_PROPS.floats]: 10 },
    });
    expect(water(checkShots(doc).issues)).toEqual([]);
  });

  it('reads a body its model root carries into the water (a baked store model: keys on the root)', () => {
    const { doc, water: pondId, shot } = scene();
    // the root keyed 8 m to the right over frames 1–48, the ball a part of it with no keys of its own
    const root = doc.addObject({
      type: 'EMPTY',
      name: 'Soccer Ball',
      custom_props: { store_id: 'builtin:soccer_ball' },
    });
    const ball = doc.addObject({
      type: 'MESH',
      name: 'ball',
      parent: root,
      data: doc.addMesh('ball', createUVSphere({ radius: 0.11, segments: 16, ring_count: 8 })),
      location: [0, 0, 0.11],
      custom_props: { [RIGID_BODY_BAKED_PROP]: 'frames 1-48 step 1' },
    });
    key(doc, root, 'location', [
      [1, [0, 0, 0]],
      [48, [8, 0, 0]],
    ]);
    const s = shot([root]);
    expect(
      water(checkShots(doc).issues).map((i) => [i.shot, i.objects, i.message.split(' and does')[0]]),
    ).toEqual([[s.id, [root, pondId], "Soccer Ball is in the water of Pond in shot 'S1' (frames 13–36)"]]);
    expect(ball).toBeTruthy();
  });

  it('reads a body by its geometry wherever its origin is (a part modelled away from its origin)', () => {
    const { doc, water: pondId, shot } = scene();
    // the ball's geometry 3 m to the right of its origin, which is keyed on the bank
    const mesh = createUVSphere({ radius: 0.11, segments: 16, ring_count: 8 });
    const ball = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('ball', {
        ...mesh,
        positions: mesh.positions.map((v, i) => (i % 3 === 0 ? v + 3 : v)),
      }),
      location: [0, 0, 0.11],
      custom_props: { [RIGID_BODY_BAKED_PROP]: 'frames 1-48 step 1' },
    });
    key(doc, ball, 'location', [
      [1, [0, -0.5, 0.11]],
      [48, [0, 0.5, 0.11]],
    ]);
    shot([ball]);
    expect(water(checkShots(doc).issues).map((i) => [i.objects, i.message.match(/\(([^)]*)\)/)![1]])).toEqual(
      [[[ball, pondId], 'frames 1–48']],
    );
  });

  it('a body flying over the water, or under a basin raised far above it, is not in it', () => {
    const { doc, shot } = scene();
    const ball = bakedBall(doc);
    // 1 m up all the way
    key(doc, ball, 'location', [
      [1, [0, 0, 1]],
      [20, [4, 0, 1]],
    ]);
    shot([ball]);
    expect(water(checkShots(doc).issues)).toEqual([]);
    // a basin's water 1.5 m over the ball's top
    const basin = pond(doc, [4, 0, 1.5 + 1.22], 1);
    key(doc, ball, 'location', [
      [1, [0, 0, 0.11]],
      [20, [4, 0, 0.11]],
    ]);
    doc.updateObject(basin, { name: 'Basin' });
    expect(water(checkShots(doc).issues).map((i) => i.message.split(' in shot')[0])).toEqual([
      'Ball is in the water of Pond',
    ]);
  });

  it('measures a body only at frames water is within its reach of its origin', () => {
    const { doc, shot } = scene();
    // a dry subject, and a ball baked 30 m along into the pond: in it from frame 45 (x 2.09)
    const A = standIn(doc, 'Ada', -6, 0);
    const ball = bakedBall(doc);
    key(doc, ball, 'location', [
      [1, [-26, 0, 0.11]],
      [48, [4, 0, 0.11]],
    ]);
    shot([A]);
    const bounds = vi.spyOn(DeskScene.prototype, 'bounds');
    let issues: DeskIssue[];
    let measured: number[];
    try {
      issues = water(checkShots(doc).issues);
      measured = [...new Set(bounds.mock.calls.filter(([id]) => id === ball).map(([, f]) => f))];
    } finally {
      bounds.mockRestore();
    }
    expect(issues.map((i) => [i.objects[0], i.message.match(/\(([^)]*)\)/)![1]])).toEqual([
      [ball, 'frames 45–48'],
    ]);
    // its bounds read where the pond is within its radius (x 1.89 on: frame 45), not at the 44 before
    expect(measured.sort((a, b) => a - b)).toEqual([45, 46, 47, 48]);
  });

  it('reports a body the simulation leaves in the water (not baked yet)', () => {
    const { doc, shot } = scene();
    doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: doc.addMesh('ground', createPlane({ size: 40 })),
      rigid_body: { ...newRigidBody('PASSIVE'), collision_shape: 'BOX' },
    });
    const ball = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('ball', createUVSphere({ radius: 0.11, segments: 16, ring_count: 8 })),
      location: [4, 0, 0.3],
      rigid_body: { ...newRigidBody('ACTIVE'), collision_shape: 'SPHERE' },
    });
    doc.updateScene({
      rigidbody_world: { ...doc.getScene().rigidbody_world, enabled: true, frame_start: 1, frame_end: 48 },
    });
    shot([ball]);
    const [issue] = water(checkShots(doc).issues);
    expect(issue.code).toBe('body_in_water');
    expect(issue.objects[0]).toBe(ball);
    expect(issue.message).toMatch(/or bake it with desk\.physics_bake \{water: 'float'\} so that it floats$/);
  });
});

describe("rideo's scenes in the water", () => {
  /** rideo's dialogue clip with a water landmark `size` m square at rideo (x, 0), imported. */
  function swimClip(x: number, size: number) {
    const input = dialogueClip();
    (input.blocking as { set: { landmarks: object[] } }).set.landmarks.push({
      id: 'pool',
      label: 'pool',
      shape: 'water',
      x,
      z: 0,
      width: size,
      depth: size,
      height: 0.05,
    });
    const doc = SceneDoc.create({ empty: true });
    importClip(doc, input);
    const actor = (name: string) => doc.listObjects().find((o) => o.name === name)!.id;
    return { doc, maya: actor('Maya'), leo: actor('Leo') };
  }
  const walks = (doc: SceneDoc) => checkShots(doc).issues.filter((i) => i.code === 'walks_on_water');

  it("imports rideo's two swimmers in its lake as in the water: no walks_on_water", () => {
    // a lake 14 m across under every mark of the clip
    const { doc, maya, leo } = swimClip(0, 14);
    for (const id of [maya, leo]) expect(inWaterSpans(doc.getObject(id)).length).toBeGreaterThan(0);
    expect(walks(doc)).toEqual([]);
  });

  it('leaves the cast rideo puts on dry ground to the check: water the desk adds under them is reported', () => {
    // a pool round Leo's mark only (rideo draws it blue: he stands in it), Maya's mark beside it dry
    const { doc, maya, leo } = swimClip(0.9, 1.6);
    expect(inWaterSpans(doc.getObject(leo)).length).toBeGreaterThan(0);
    expect(inWaterSpans(doc.getObject(maya))).toEqual([]);
    expect(walks(doc)).toEqual([]);
    // a puddle the desk puts under Maya's mark: she stands on it
    doc.addObject({
      type: 'MESH',
      name: 'Puddle',
      data: doc.addMesh('Puddle', createPlane({ size: 1 })),
      location: [-0.9, 0, 0.01],
      custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: 'Puddle', desk_shape: 'water' },
    });
    const found = walks(doc);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((i) => i.severity === 'error' && i.objects[0] === maya)).toBe(true);
  });
});
