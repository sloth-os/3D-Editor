import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createConstraint,
  createCube,
  createFCurve,
  defaultRigidBody,
  defaultRigidBodyWorld,
  getShots,
  insertKeyframe,
  newShotId,
  setShots,
  type ShotData,
} from '@3d-editor/core';
import {
  DEFAULT_PASS,
  defaultMode,
  needsReference,
  sampleFrames,
  shotFeatures,
  type ShotFeatures,
} from '../../src/rideo/shots';

/*
 * Which shots of an export get a reference video by default, and in which mode (SPEC §0(d), §11):
 * shots with physics, tethers, held props or a camera move, read from the project at five frames of
 * the shot (an object counts when it projects into the shot camera's frame).
 */

const ASPECT = 16 / 9;

/** A scene with a camera at (0, −8, 1) looking along +Y at the origin. */
function scene() {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ fps: 24, frame_start: 1, frame_end: 48 });
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ lens: 35, sensor_fit: 'HORIZONTAL', sensor_width: 36 }),
    location: [0, -8, 1],
    rotation_euler: [Math.PI / 2, 0, 0],
  });
  return { doc, cam };
}

function shot(
  doc: SceneDoc,
  cam: string,
  start: number,
  end: number,
  extra: Partial<ShotData> = {},
): ShotData {
  const [s] = setShots(doc, [
    {
      id: newShotId(),
      name: 'S',
      enabled: true,
      camera: cam,
      frame_start: start,
      frame_end: end,
      subjects: [],
      ...extra,
    },
  ]);
  return s;
}

function key(
  doc: SceneDoc,
  id: string,
  path: string,
  index: number,
  keys: [number, number][],
  interp: 'LINEAR' | 'CONSTANT' = 'LINEAR',
) {
  let fc = createFCurve({ target_type: 'object', target_id: id, path, index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, interp);
  doc.setFCurve(fc);
}

const cube = (doc: SceneDoc, name: string) => doc.addMesh(name, createCube({ size: 0.3 }));

describe('sampled frames', () => {
  it('samples the first, the last and three frames between, without repeats', () => {
    expect(sampleFrames(1, 25)).toEqual([1, 7, 13, 19, 25]);
    expect(sampleFrames(1, 3)).toEqual([1, 2, 3]);
    expect(sampleFrames(5, 5)).toEqual([5]);
  });
});

describe('shot features', () => {
  it('an actor in view makes a character shot that needs no reference; out of view it does not count', () => {
    const { doc, cam } = scene();
    const ada = doc.addObject({
      type: 'EMPTY',
      name: 'Ada',
      location: [0, 0, 0],
      custom_props: { desk_role: 'actor', desk_height_m: 1.7 },
    });
    const s = shot(doc, cam, 1, 24);
    const f = shotFeatures(doc, s, ASPECT);
    expect(f).toMatchObject({
      characters: true,
      camera_move: false,
      physics: false,
      tether: false,
      held: false,
    });
    expect(needsReference(f)).toBe(false);
    doc.updateObject(ada, { location: [40, 0, 0] });
    expect(shotFeatures(doc, getShots(doc)[0], ASPECT).characters).toBe(false);
    // behind the camera does not count either
    doc.updateObject(ada, { location: [0, -20, 0] });
    expect(shotFeatures(doc, getShots(doc)[0], ASPECT).characters).toBe(false);
    // a subject actor counts wherever it is
    const withSubject = shot(doc, cam, 1, 24, { subjects: [ada] });
    expect(shotFeatures(doc, withSubject, ASPECT).characters).toBe(true);
  });

  it('a camera move counts from the shot (not locked_off) or from the camera moving or turning over the shot', () => {
    const { doc, cam } = scene();
    expect(shotFeatures(doc, shot(doc, cam, 1, 24, { move: 'locked_off' }), ASPECT).camera_move).toBe(false);
    expect(shotFeatures(doc, shot(doc, cam, 1, 24, { move: 'push_in' }), ASPECT).camera_move).toBe(true);
    key(doc, cam, 'location', 1, [
      [1, -8],
      [24, -6],
    ]);
    expect(shotFeatures(doc, shot(doc, cam, 1, 24), ASPECT).camera_move).toBe(true);
    // keys outside the shot do not move it during the shot
    expect(shotFeatures(doc, shot(doc, cam, 30, 40), ASPECT).camera_move).toBe(false);
    const { doc: d2, cam: c2 } = scene();
    key(d2, c2, 'rotation_euler', 2, [
      [1, 0],
      [24, 0.2],
    ]);
    expect(shotFeatures(d2, shot(d2, c2, 1, 24), ASPECT).camera_move).toBe(true);
  });

  it('simulated rigid bodies count in view while the rigid body world runs over the shot', () => {
    const { doc, cam } = scene();
    doc.updateScene({
      rigidbody_world: { ...defaultRigidBodyWorld(), enabled: true, frame_start: 1, frame_end: 30 },
    });
    const ball = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: cube(doc, 'Ball'),
      location: [0.5, 0, 2],
      rigid_body: defaultRigidBody(),
    });
    const f = shotFeatures(doc, shot(doc, cam, 1, 24), ASPECT);
    expect(f.physics).toBe(true);
    expect(f.found).toEqual(['Ball (physics)']);
    expect(needsReference(f)).toBe(true);
    // after the world's last frame, or out of view, or a passive body: nothing moves in the shot
    expect(shotFeatures(doc, shot(doc, cam, 31, 48), ASPECT).physics).toBe(false);
    doc.updateObject(ball, { location: [60, 0, 2] });
    expect(shotFeatures(doc, getShots(doc)[0], ASPECT).physics).toBe(false);
    doc.updateObject(ball, { location: [0.5, 0, 2], rigid_body: defaultRigidBody('PASSIVE') });
    expect(shotFeatures(doc, getShots(doc)[0], ASPECT).physics).toBe(false);
    // a body that starts after the shot ends does not move in it
    doc.updateObject(ball, { rigid_body: { ...defaultRigidBody(), start_frame: 40 } });
    expect(shotFeatures(doc, getShots(doc)[0], ASPECT).physics).toBe(false);
  });

  it('baked bodies count where their keys move them during the shot', () => {
    const { doc, cam } = scene();
    const ball = doc.addObject({
      type: 'MESH',
      name: 'Thrown ball',
      data: cube(doc, 'Ball'),
      location: [0, 0, 2],
      custom_props: { rigid_body_baked: 'frames 10-30 step 1' },
    });
    key(doc, ball, 'location', 2, [
      [10, 2],
      [30, 0.15],
    ]);
    expect(shotFeatures(doc, shot(doc, cam, 12, 24), ASPECT)).toMatchObject({
      physics: true,
      found: ['Thrown ball (physics)'],
    });
    // before the bake starts the ball rests: nothing moves
    expect(shotFeatures(doc, shot(doc, cam, 1, 9), ASPECT).physics).toBe(false);
  });

  it('a tether counts while its string is out (not shrunk away) and the flyer or string is in view', () => {
    const { doc, cam } = scene();
    const kite = doc.addObject({
      type: 'MESH',
      name: 'Kite',
      data: cube(doc, 'Kite'),
      location: [1, 2, 4],
      custom_props: { desk_role: 'prop' },
    });
    const str = doc.addObject({
      type: 'MESH',
      name: 'Kite string',
      data: cube(doc, 'String'),
      location: [0, 0, 1],
      custom_props: { desk_role: 'string', desk_string_to: kite },
    });
    for (let i = 0; i < 3; i++)
      key(
        doc,
        str,
        'scale',
        i,
        [
          [1, 1e-8],
          [29, 1e-8],
          [30, 1],
        ],
        'CONSTANT',
      );
    expect(shotFeatures(doc, shot(doc, cam, 1, 24), ASPECT).tether).toBe(false);
    const f = shotFeatures(doc, shot(doc, cam, 25, 48), ASPECT);
    expect(f.tether).toBe(true);
    expect(f.found).toEqual(['Kite (tether)']);
  });

  it('a prop counts as held while its hold constraint on an actor acts, in view', () => {
    const { doc, cam } = scene();
    const ada = doc.addObject({
      type: 'ARMATURE',
      name: 'Ada',
      location: [0, 0, 0],
      custom_props: { desk_role: 'actor' },
    });
    const cup = doc.addObject({
      type: 'MESH',
      name: 'Cup',
      data: cube(doc, 'Cup'),
      location: [0.3, 0, 1],
      constraints: [createConstraint('CHILD_OF', { name: 'Hold Ada', target: ada, influence: 0 })],
    });
    key(
      doc,
      cup,
      'constraints["Hold Ada"].influence',
      0,
      [
        [1, 0],
        [20, 1],
      ],
      'CONSTANT',
    );
    expect(shotFeatures(doc, shot(doc, cam, 1, 12), ASPECT).held).toBe(false);
    const f = shotFeatures(doc, shot(doc, cam, 15, 30), ASPECT);
    expect(f).toMatchObject({ held: true, characters: true, found: ['Cup (held)'] });
    // a muted hold never acts
    doc.updateObject(cup, {
      constraints: [createConstraint('CHILD_OF', { name: 'Hold Ada', target: ada, mute: true })],
    });
    expect(shotFeatures(doc, getShots(doc)[0], ASPECT).held).toBe(false);
  });

  it('a shot without a camera reads the scene camera', () => {
    const { doc, cam } = scene();
    doc.updateScene({ camera: cam });
    doc.addObject({ type: 'EMPTY', name: 'Ada', location: [0, 0, 0], custom_props: { desk_role: 'actor' } });
    const [s] = setShots(doc, [
      { id: newShotId(), name: 'S', enabled: true, camera: null, frame_start: 1, frame_end: 10 },
    ]);
    expect(shotFeatures(doc, s, ASPECT).characters).toBe(true);
  });
});

describe('default modes and passes', () => {
  const f = (o: Partial<ShotFeatures>): ShotFeatures => ({
    camera_move: false,
    physics: false,
    tether: false,
    held: false,
    characters: false,
    found: [],
    ...o,
  });

  it('props in motion → motion, actors → pose, a move alone → camera; camera whenever the first frame cannot match', () => {
    expect(defaultMode(f({ physics: true, characters: true }), true)).toBe('motion');
    expect(defaultMode(f({ tether: true }), true)).toBe('motion');
    expect(defaultMode(f({ held: true, characters: true }), true)).toBe('motion');
    expect(defaultMode(f({ characters: true, camera_move: true }), true)).toBe('pose');
    expect(defaultMode(f({ camera_move: true }), true)).toBe('camera');
    expect(defaultMode(f({ physics: true }), false)).toBe('camera');
    expect(DEFAULT_PASS).toEqual({ motion: 'beauty', pose: 'pose', camera: 'depth' });
  });

  it('needs a reference for physics, tethers, held props and camera moves only', () => {
    expect(needsReference(f({ characters: true }))).toBe(false);
    for (const k of ['physics', 'tether', 'held', 'camera_move'] as const)
      expect(needsReference(f({ [k]: true })), k).toBe(true);
  });
});
