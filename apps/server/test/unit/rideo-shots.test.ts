import { describe, expect, it } from 'vitest';
import {
  FrameState,
  SceneDoc,
  createConstraint,
  createCube,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  defaultRigidBody,
  defaultRigidBodyWorld,
  getShots,
  hiddenScale,
  insertKeyframe,
  newShotId,
  setShots,
  type OperatorContext,
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
 * the shot (an object counts when it projects into the shot camera's frame and a hide key has not put
 * it away there; a store model shown at a tiny world scale counts as any other).
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

/** An OBJ cube `units` native units across, standing on its base. */
function cubeObj(units: number): string {
  const h = units / 2;
  const v = [
    [-h, -h, 0],
    [h, -h, 0],
    [h, h, 0],
    [-h, h, 0],
    [-h, -h, units],
    [h, -h, units],
    [h, h, units],
    [-h, h, units],
  ];
  return (
    v.map((p) => `v ${p.join(' ')}`).join('\n') +
    '\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n'
  );
}

/** Runs core operators on `doc` (as agents run them); throws with the error of one that fails. */
function operators(doc: SceneDoc) {
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => {},
  };
  return <T = Record<string, unknown>>(id: string, params: Record<string, unknown>): T => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r.result as T;
  };
}

describe('objects put away by a hide key', () => {
  it.each([
    ['in micrometres shown 30 cm wide (1e-6)', 1e-6],
    ["in very large units shown 30 cm wide (5e-8, below hiddenByScale's 1e-7)", 5e-8],
  ])(
    'a body shown at a tiny world scale counts in view until a hide key puts it away: %s',
    (_label, scale) => {
      const { doc, cam } = scene();
      doc.updateScene({
        rigidbody_world: { ...defaultRigidBodyWorld(), enabled: true, frame_start: 1, frame_end: 48 },
      });
      const ball = doc.addObject({
        type: 'MESH',
        name: 'Ball',
        data: doc.addMesh('Ball', createCube({ size: 0.3 / scale })),
        location: [0.5, 0, 2],
        scale: [scale, scale, scale],
        rigid_body: defaultRigidBody(),
      });
      expect(shotFeatures(doc, shot(doc, cam, 1, 24), ASPECT)).toMatchObject({
        physics: true,
        found: ['Ball (physics)'],
      });
      // put away from frame 25 on (HIDE_SCALE times the scale it is shown at, as desk.tether_fly and
      // the rideo import key it): not in view in a shot after that
      for (let i = 0; i < 3; i++)
        key(
          doc,
          ball,
          'scale',
          i,
          [
            [24, scale],
            [25, hiddenScale(scale)],
          ],
          'CONSTANT',
        );
      expect(shotFeatures(doc, shot(doc, cam, 25, 48), ASPECT).physics).toBe(false);
      expect(shotFeatures(doc, shot(doc, cam, 1, 24), ASPECT).physics).toBe(true);
    },
  );

  it('a kite of a store model in micrometres on a 200 m string counts while it flies, not after after: hide', () => {
    const { doc, cam } = scene();
    const run = operators(doc);
    const kite = run<{ root: string }>('store.insert_files', {
      entry: {
        id: 'kite',
        name: 'Kite',
        provider: 'test',
        license: { spdx: 'CC0-1.0', url: null, attribution: null },
        author: 'test',
        source_url: 'https://example.invalid/kite',
        category: 'props',
      },
      format: 'obj',
      files: { 'kite.obj': Buffer.from(cubeObj(6e5)).toString('base64') },
      main: 'kite.obj',
      height_m: 0.6,
      location: [0.5, 0, 1.5],
    }).root;
    expect(doc.getObject(kite)!.scale[0]).toBeCloseTo(1e-6, 15);
    const hand = doc.addObject({ type: 'EMPTY', name: 'Hand', location: [0, 0, 1.2] });
    const fly = run<{ hidden_from: number; string: { object: string } }>('desk.tether_fly', {
      flyer: kite,
      anchor: hand,
      length_m: 200,
      wind_dir_deg: 90,
      wind_mps: 6,
      frame_start: 1,
      frame_end: 24,
      after: 'hide',
    });
    expect(fly.hidden_from).toBe(25);
    const name = doc.getObject(kite)!.name;
    expect(shotFeatures(doc, shot(doc, cam, 1, 24), ASPECT)).toMatchObject({
      tether: true,
      found: [`${name} (tether)`],
    });
    // put away, the string is still 2 µm long (200 m times HIDE_SCALE): its two thickness axes
    // tell that a hide key shrank it
    const m = new FrameState(doc, 40).world(fly.string.object)!;
    expect(Math.hypot(m[8], m[9], m[10])).toBeGreaterThan(1e-6);
    expect(shotFeatures(doc, shot(doc, cam, 30, 48), ASPECT)).toMatchObject({ tether: false, found: [] });
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
