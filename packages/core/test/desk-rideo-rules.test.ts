import { describe, expect, it } from 'vitest';
import { SceneDoc, fcurveKey } from '../src/doc/scene-doc';
import { evaluateFCurve } from '../src/anim/fcurve';
import { DESK_MOVES } from '../src/doc/types';
import { createCube } from '../src/mesh/primitives';
import {
  MOUNT_DISTANCE_M,
  RIDEO_BLOCKING_MOVES,
  RIDEO_BLOCKING_POSES,
  RIDEO_CAMERA_MOVE_IDS,
  RIDEO_ID_PATTERN,
  RIDEO_MOVEMENTS,
  RIDEO_POSE_HEIGHT,
  RideoImportInputSchema,
  RideoSceneBlockingSchema,
  editorPose,
  flyerKind,
  humanKindOf,
  inferActorKind,
  isRideoId,
  modelFor,
  moveOfMovement,
  panDirectionSaid,
  rideoLandmarkColor,
  rideoMarkFor,
  rideoPose,
  ridersByText,
  ridingDenied,
  speciesOf,
} from '../src/desk/rideo';
import { HIDDEN_SCALE, hideSpans, replaceKeys, setKey, truncateMotion } from '../src/desk/rideo/keys';
import { parseRideoBlocking } from '../src/desk/rideo/import';
import {
  DIALOGUE_SHOTS,
  LEO,
  MAYA,
  PEPPER,
  ROSIE,
  dialogueBlocking,
  dialogueClip,
  kiteClip,
  ridingClip,
} from './desk-rideo-fixtures';

/*
 * The rideo bridge's schema (rideo's SceneBlocking v1 mirrored field for field), its reading rules
 * (actor kinds, riders, camera moves, poses, models) and its keyframe helpers.
 */

const NONE = { holds: false, personPose: false, ridden: false, rides: false };
const kindOf = (name: string, summary = '', identity?: string | Record<string, string>) =>
  inferActorKind({ name, summary, identity }, NONE).kind;

describe('rideo SceneBlocking v1 schema', () => {
  it('parses the fixtures as rideo stores them and fills in its defaults', () => {
    for (const clip of [dialogueClip(), ridingClip(), kiteClip()]) {
      const r = RideoSceneBlockingSchema.safeParse(clip.blocking);
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
    const b = RideoSceneBlockingSchema.parse({ updatedAt: '2026-11-02T09:30:00.000Z' });
    expect(b).toMatchObject({
      version: 1,
      source: 'user',
      set: {
        width: 12,
        depth: 10,
        ground: 'ground',
        interior: false,
        sun: { azimuthDeg: 135, elevationDeg: 40 },
      },
      actors: [],
      props: [],
      shots: {},
    });
    const d = RideoSceneBlockingSchema.parse(dialogueBlocking());
    // a mark's defaults: no walk; a camera's: no end; a landmark's: box, no rotation, rideo's grey
    expect(d.shots[DIALOGUE_SHOTS[5]].marks[MAYA]).toEqual({
      x: -2.2,
      z: 1,
      facingDeg: 45,
      pose: 'point',
      toX: null,
      toZ: null,
    });
    expect(d.shots[DIALOGUE_SHOTS[0]].camera.end).toBeNull();
    expect(d.set.landmarks[1]).toMatchObject({
      shape: 'wall',
      rotationDeg: 0,
      color: '#8a8f98',
      elementId: null,
    });
    expect(d.props[0]).toMatchObject({ heldBy: LEO, size: 0.12 });
  });

  it('refuses what rideo refuses', () => {
    const base = dialogueBlocking();
    const bad: [string, unknown][] = [
      ['an id with a space', { ...base, actors: [{ ...base.actors![0], characterId: 'maya smith' }] }],
      ['a lens under 8 mm', { ...base, shots: { s: { camera: { ...cam(), lensMm: 4 } } } }],
      ['a colour name', { ...base, actors: [{ ...base.actors![0], color: 'orange' }] }],
      ['an unknown pose', { ...base, actors: [{ ...base.actors![0], pose: 'dance' }] }],
      ['a sun under 2°', { ...base, set: { ...base.set, sun: { azimuthDeg: 0, elevationDeg: 1 } } }],
      ['seventeen actors', { ...base, actors: Array.from({ length: 17 }, (_, i) => actor(i)) }],
      ['a coordinate beyond 500 m', { ...base, props: [{ id: 'p', x: 600, z: 0 }] }],
      ['version 2', { ...base, version: 2 }],
    ];
    for (const [what, value] of bad)
      expect(RideoSceneBlockingSchema.safeParse(value).success, what).toBe(false);
    expect(() => parseRideoBlocking({ actors: 'none' })).toThrow(/not a SceneBlocking v1: actors/);
    // rideo's draft has no updatedAt of its own: the import accepts it without one
    const { updatedAt: _, ...draft } = base;
    expect(parseRideoBlocking(draft).actors).toHaveLength(2);
  });

  it("keeps rideo's ids, moves and poses", () => {
    // rideo's ids, and any other host's (the desk embed protocol's Id pattern)
    expect(RIDEO_ID_PATTERN.test('chr_maya0000001a')).toBe(true);
    expect(isRideoId('chr_short')).toBe(true);
    expect(isRideoId('proj:42.shot-7')).toBe(true);
    expect(isRideoId('-leading-dash')).toBe(false);
    expect(isRideoId('a b')).toBe(false);
    expect(isRideoId('x'.repeat(101))).toBe(false);
    expect(RIDEO_CAMERA_MOVE_IDS).toEqual(DESK_MOVES);
    expect(RIDEO_CAMERA_MOVE_IDS).toHaveLength(20);
    for (const m of RIDEO_BLOCKING_MOVES.filter((x) => x !== 'none'))
      expect(DESK_MOVES as readonly string[]).toContain(m);
    for (const p of RIDEO_BLOCKING_POSES) expect(RIDEO_POSE_HEIGHT[p]).toBeGreaterThan(0);
    expect(RIDEO_POSE_HEIGHT.lie).toBeLessThan(RIDEO_POSE_HEIGHT.sit);
  });

  it("reads the import's input with rideo's defaults", () => {
    const input = RideoImportInputSchema.parse({
      blocking: {},
      shots: [{ id: 's', index: 0, durationSec: 2 }],
    });
    expect(input).toMatchObject({
      characters: [],
      elements: [],
      castOverrides: {},
      preRollFrames: 12,
      update: true,
    });
    expect(input.shots[0]).toMatchObject({
      description: '',
      camera: { framing: 'medium', movement: 'static' },
      characterIds: [],
      layout: [],
      continuity: 'cut',
    });
    expect(
      RideoImportInputSchema.safeParse({ blocking: {}, shots: [{ id: 's', index: 0, durationSec: 0 }] })
        .success,
    ).toBe(false);
  });

  it("finds a character's mark as rideo's markFor does", () => {
    const b = RideoSceneBlockingSchema.parse(dialogueBlocking());
    expect(rideoMarkFor(b, DIALOGUE_SHOTS[5], MAYA)).toMatchObject({ x: -2.2, z: 1, pose: 'point' });
    // no mark of its own in the shot: the opening mark
    expect(rideoMarkFor(b, DIALOGUE_SHOTS[5], LEO)).toEqual({
      x: 0.9,
      z: 0,
      facingDeg: 270,
      pose: 'stand',
      toX: null,
      toZ: null,
    });
    expect(rideoMarkFor(b, 'sht_unknown000001', LEO)).toMatchObject({ x: 0.9 });
    expect(rideoMarkFor(b, DIALOGUE_SHOTS[0], 'chr_nobody0000001')).toBeNull();
  });

  it("colours landmarks as rideo's landmarkColor does", () => {
    expect(rideoLandmarkColor('Old barn', 'box')).toBe('#b5413a');
    expect(rideoLandmarkColor('hay barn', 'box')).toBe('#d8b54a');
    expect(rideoLandmarkColor('duck pond', 'water')).toBe('#3f7fc0');
    expect(rideoLandmarkColor('', 'water')).toBe('#3f7fc0');
    expect(rideoLandmarkColor('mystery', 'cylinder')).toBe('#5e7f4a');
    expect(rideoLandmarkColor('mystery', 'box')).toBe('#8a8f98');
  });
});

describe('rideo reading rules', () => {
  it('reads people by default, and their age and gender', () => {
    expect(kindOf('Maya', 'A curious ten-year-old girl in a yellow raincoat.')).toBe('child');
    expect(kindOf('Rosie', 'A girl who loves her pony.')).toBe('child');
    expect(kindOf('Leo', "Maya's grandfather, a retired sailor.")).toBe('elder');
    expect(kindOf('Ben', '', { age: '2' })).toBe('toddler');
    expect(kindOf('Gran', 'She was a farm girl once.', { age: '78', gender: 'female' })).toBe('elder');
    expect(kindOf('Ana', '', { age: '35', gender: 'female' })).toBe('woman');
    expect(kindOf('Tom', '', { gender: 'male' })).toBe('man');
    expect(kindOf('Mum', "Sam's mother, patient and warm.")).toBe('woman');
    // a father's children are not what he is
    expect(kindOf('Dad', 'A father who plays with his kids.')).toBe('man');
    expect(kindOf('Alex')).toBe('adult');
    expect(humanKindOf({ name: 'Jo', summary: 'An eight-year-old.' })).toBe('child');
  });

  it('makes quadrupeds of the animals rideo keeps as mounts and pets, and people of the others', () => {
    expect(kindOf('Pepper', "Rosie's dappled grey pony with a white mane.")).toBe('pony');
    expect(kindOf('Biscuit', 'A golden retriever who chases seagulls.')).toBe('dog');
    expect(kindOf('Rex', 'A tiny puppy.')).toBe('small_dog');
    expect(kindOf('Milo', 'A tabby cat.')).toBe('cat');
    expect(kindOf('Daisy', 'A brown cow.')).toBe('cow');
    expect(kindOf('Clover', 'A pony that wears a red saddle.')).toBe('pony');
    // the animal named first, not the one it dreams of
    expect(speciesOf({ name: 'Scout', summary: 'A sheepdog who thinks he is a horse.' })).toBe('dog');
    // animals that act as people are people: rideo's leads talk, dress, hold kites and ride ponies
    expect(kindOf('Po', 'A panda who loves kites.')).toBe('adult');
    expect(kindOf('Bruno', 'A talking bear.')).toBe('adult');
    expect(kindOf('Clover', 'A pony that wears a hat.')).toBe('adult');
    expect(kindOf('Teddy', 'A teddy bear.')).toBe('adult');
    const pony = { name: 'Pepper', summary: 'A grey pony.' };
    expect(inferActorKind(pony, { ...NONE, holds: true }).kind).toBe('adult');
    expect(inferActorKind(pony, { ...NONE, personPose: true }).kind).toBe('adult');
    expect(inferActorKind({ name: 'Bruno', summary: 'A talking bear.' }, { ...NONE, ridden: true })).toEqual({
      kind: 'bear',
      reason: 'a bear another character rides',
    });
    // an animal that rides is a person (rideo's leads: a bear cub on a pony), unless it is ridden
    const cub = { name: 'Rosie', summary: 'A playful bear cub.' };
    expect(inferActorKind(cub, NONE)).toEqual({ kind: 'bear', reason: 'a bear' });
    expect(inferActorKind(cub, { ...NONE, rides: true })).toEqual({
      kind: 'child',
      reason: 'a bear that rides: a person',
    });
    expect(inferActorKind(pony, { ...NONE, rides: true, ridden: true }).kind).toBe('pony');
    // the character's own kind, and the cast override above it
    expect(inferActorKind({ ...pony, kind: 'horse' }, NONE).kind).toBe('horse');
    expect(inferActorKind({ ...pony, kind: 'horse' }, NONE, 'donkey')).toEqual({
      kind: 'donkey',
      reason: 'cast override',
    });
  });

  it('reads who rides whom from a shot’s words', () => {
    const rosie = { id: ROSIE, name: 'Rosie' };
    const sam = { id: 'chr_sam00000001e', name: 'Sam' };
    const pepper = { id: PEPPER, name: 'Pepper', kind: 'pony' as const };
    expect(ridersByText('Rosie rides Pepper along the fence.', [rosie], [pepper])).toEqual([
      { rider: ROSIE, mount: PEPPER },
    ]);
    // the mount by its kind's word, the other person not riding
    expect(ridersByText('Rosie rides her pony home. Sam waves.', [rosie, sam], [pepper])).toEqual([
      { rider: ROSIE, mount: PEPPER },
    ]);
    // one person and one mount: a rider verb whose subject is a pronoun, or none
    expect(ridersByText('They ride away.', [rosie], [pepper])).toEqual([{ rider: ROSIE, mount: PEPPER }]);
    expect(ridersByText('Riding along the fence at dusk.', [rosie], [pepper])).toEqual([
      { rider: ROSIE, mount: PEPPER },
    ]);
    expect(ridersByText('They ride away.', [rosie, sam], [pepper])).toEqual([]);
    expect(ridersByText('Rosie stands next to Pepper.', [rosie], [pepper])).toEqual([]);
    expect(MOUNT_DISTANCE_M).toBeCloseTo(0.6);
  });

  it('seats nobody on an animal that only trots, gallops or stands by: an animal’s gait is no rider', () => {
    const rosie = { id: ROSIE, name: 'Rosie' };
    const sam = { id: 'chr_sam00000001e', name: 'Sam' };
    const clover = { id: PEPPER, name: 'Clover', kind: 'pony' as const };
    const horse = { id: PEPPER, name: 'Pepper', kind: 'horse' as const };
    for (const text of [
      'Clover trots over to Rosie, who holds out an apple.',
      'Rosie watches Clover gallop around the paddock.',
      'Rosie brushes Clover while the pony trots in place.',
      'Rosie leads Clover by the reins. A horse gallops past in the distance.',
      'They gallop away.',
      'Rosie watches the farmer ride by on his pony.',
      'Rosie wants to ride Clover, but it is raining.',
      'Rosie never rides Clover.',
      'Rosie brushes Clover after the ride.',
      "Rosie walks beside Clover with her hand on Clover's neck.",
      'Rosie jumps on the spot as Clover trots up.',
      "Rosie's brother rides Clover round the paddock.",
      'Rosie rides past Clover on her bicycle.',
      'The farmer rides by.',
    ])
      expect(ridersByText(text, [rosie], [clover]), text).toEqual([]);
    expect(ridersByText('A horse gallops past.', [rosie, sam], [horse])).toEqual([]);
  });

  it('reads riders from rider verbs, getting on, "ridden by" and goings "on" a mount', () => {
    const rosie = { id: ROSIE, name: 'Rosie' };
    const sam = { id: 'chr_sam00000001e', name: 'Sam' };
    const pepper = { id: PEPPER, name: 'Pepper', kind: 'pony' as const };
    const rides = (text: string, people = [rosie, sam]) => ridersByText(text, people, [pepper]);
    const ROSIE_ON = [{ rider: ROSIE, mount: PEPPER }];
    const SAM_ON = [{ rider: sam.id, mount: PEPPER }];
    expect(rides('Rosie watches Sam ride Pepper across the field.')).toEqual(SAM_ON);
    expect(rides('Riding Pepper, Rosie waves to Sam.')).toEqual(ROSIE_ON);
    expect(rides('Pepper, ridden by Sam, trots along the fence.')).toEqual(SAM_ON);
    expect(rides('Rosie gallops across the meadow on her pony while Sam waves.')).toEqual(ROSIE_ON);
    expect(rides('Rosie brushes Pepper, then rides him to the gate.')).toEqual(ROSIE_ON);
    expect(rides("Sam climbs onto Pepper's back.")).toEqual(SAM_ON);
    expect(rides('Rosie walks up to Pepper and climbs onto him.')).toEqual(ROSIE_ON);
    expect(rides('Sam sits astride the pony.')).toEqual(SAM_ON);
    expect(rides('Sam takes a ride on Pepper.')).toEqual(SAM_ON);
    expect(rides('Rosie, on horseback, leads the parade.', [rosie])).toEqual(ROSIE_ON);
  });

  it('says when a shot’s words put a person to other work with a mount (their marks then seat nobody)', () => {
    const rosie = { name: 'Rosie' };
    const pepper = { name: 'Pepper', kind: 'pony' as const };
    expect(ridingDenied('Rosie brushes Pepper while the pony trots in place.', rosie, pepper)).toBe(true);
    expect(ridingDenied('Rosie stands next to her pony.', rosie, pepper)).toBe(true);
    expect(ridingDenied('Rosie rides Pepper. She waves.', rosie, pepper)).toBe(false);
    expect(ridingDenied('Rosie and Pepper go along the fence.', rosie, pepper)).toBe(false);
    expect(ridingDenied('Sam brushes Pepper.', rosie, pepper)).toBe(false);
  });

  it("maps rideo's planned movement to the move library (spec §11)", () => {
    const expected: Record<string, string> = {
      static: 'locked_off',
      dolly_in: 'push_in',
      dolly_out: 'pull_out',
      tracking: 'tracking_follow',
      handheld: 'handheld',
      crane: 'crane_up',
      orbit: 'orbit_left',
      pan: 'pan_right',
      tilt: 'tilt_up',
      zoom: 'push_in',
    };
    for (const m of RIDEO_MOVEMENTS) expect(moveOfMovement(m, ''), m).toBe(expected[m]);
    expect(moveOfMovement('pan', 'The camera pans left across the bay.')).toBe('pan_left');
    expect(moveOfMovement('tilt', 'It tilts down to the puddle.')).toBe('tilt_down');
    expect(moveOfMovement('zoom', 'The lens zooms out.')).toBe('pull_out');
    expect(moveOfMovement('crane', 'The camera cranes down to the bench.')).toBe('crane_down');
    expect(moveOfMovement('orbit', 'The camera orbits clockwise.')).toBe('orbit_right');
    expect(panDirectionSaid('It pans slowly to the right.')).toBe(true);
    expect(panDirectionSaid('The camera pans with him.')).toBe(false);
    // the way it goes is where it goes to, not the first direction said
    expect(moveOfMovement('pan', 'The camera pans from left to right across the bay.')).toBe('pan_right');
    expect(moveOfMovement('pan', 'The camera pans from right to left.')).toBe('pan_left');
    expect(moveOfMovement('pan', 'It pans from the left of the harbour.')).toBe('pan_right');
    expect(moveOfMovement('pan', 'It pans leftwards with the boat.')).toBe('pan_left');
    expect(moveOfMovement('pan', 'The camera pans to frame left.')).toBe('pan_left');
    expect(moveOfMovement('orbit', 'The camera orbits anti-clockwise around them.')).toBe('orbit_left');
    expect(moveOfMovement('orbit', 'The camera orbits counter-clockwise.')).toBe('orbit_left');
    expect(moveOfMovement('orbit', 'The camera orbits counterclockwise.')).toBe('orbit_left');
    expect(moveOfMovement('orbit', 'It orbits from right to left.')).toBe('orbit_left');
    expect(moveOfMovement('orbit', 'It orbits to the right of the table.')).toBe('orbit_right');
    expect(moveOfMovement('tilt', 'It tilts from his boots up to his face.')).toBe('tilt_up');
    expect(moveOfMovement('tilt', 'It tilts from the sky down to the puddle.')).toBe('tilt_down');
  });

  it("maps rideo's poses onto people's and animals' poses and back", () => {
    for (const p of RIDEO_BLOCKING_POSES) {
      expect(editorPose(p, 'adult')).toBe(p);
      expect(rideoPose(editorPose(p, 'child'))).toBe(p);
    }
    expect(editorPose('run', 'pony')).toBe('gallop');
    expect(editorPose('kneel', 'dog')).toBe('lie');
    expect(editorPose('wave', 'horse')).toBe('stand');
    expect(rideoPose('gallop')).toBe('run');
    expect(rideoPose('trot')).toBe('walk');
    expect(rideoPose('ride')).toBe('sit');
    expect(rideoPose('eat')).toBe('crouch');
    expect(rideoPose('something_else')).toBe('stand');
  });

  it('tells kites and balloons, and chooses built-in models by their words', () => {
    expect(flyerKind('Red diamond kite')).toBe('kite');
    expect(flyerKind('two party balloons')).toBe('balloon');
    expect(flyerKind('a kitten')).toBeNull();
    expect(modelFor(['kite'])?.entry.id).toBe('diamond_kite');
    // possessives and the cast's names are not what a prop is
    expect(modelFor(["Rosie's kite"], { exclude: ['Rosie'] })?.entry.id).toBe('diamond_kite');
    expect(modelFor(['park bench'])?.entry.id).toBe('park_bench');
    expect(modelFor(['bench'], { categories: ['nature'] })).toBeNull();
    expect(modelFor(['xyzzy', 'old photograph'])).toBeNull();
    // people and animals are actors, never props
    for (const q of ['horse', 'pony', 'dog']) expect(modelFor([q])?.entry.rig, q).not.toBe('actor');
  });
});

describe('rideo keyframe helpers', () => {
  const cube = () => {
    const doc = SceneDoc.create({ empty: true });
    const id = doc.addObject({
      type: 'MESH',
      name: 'Box',
      data: doc.addMesh('Box', createCube({ size: 1 })),
    });
    return { doc, id };
  };
  const at = (doc: SceneDoc, id: string, path: string, index: number, frame: number) => {
    const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index }));
    return fc ? evaluateFCurve(fc, frame) : undefined;
  };

  it('sets and replaces single CONSTANT keys', () => {
    const { doc, id } = cube();
    setKey(doc, id, 'location', 0, 10, 1);
    setKey(doc, id, 'location', 0, 20, 2);
    setKey(doc, id, 'location', 0, 10, 3);
    const fc = doc.getFCurve(
      fcurveKey({ target_type: 'object', target_id: id, path: 'location', index: 0 }),
    )!;
    expect(fc.keyframes.map((k) => [k.frame, k.value, k.interpolation])).toEqual([
      [10, 3, 'CONSTANT'],
      [20, 2, 'CONSTANT'],
    ]);
    expect(at(doc, id, 'location', 0, 19)).toBe(3);
    expect(at(doc, id, 'location', 0, 100)).toBe(2);
    replaceKeys(doc, id, 'location', 0, 15, 30, [{ frame: 25, value: 7, interpolation: 'CONSTANT' }]);
    expect(at(doc, id, 'location', 0, 26)).toBe(7);
    expect(at(doc, id, 'location', 0, 12)).toBe(3);
  });

  it('cuts motion keys from a frame on, keeping constraint influences', () => {
    const { doc, id } = cube();
    for (const f of [1, 10, 20]) setKey(doc, id, 'location', 1, f, f);
    setKey(doc, id, 'constraints["Hold Leo"].influence', 0, 15, 1);
    expect(truncateMotion(doc, id, 10)).toBe(2);
    expect(at(doc, id, 'location', 1, 30)).toBe(1);
    expect(at(doc, id, 'constraints["Hold Leo"].influence', 0, 30)).toBe(1);
  });

  it('hides an object over spans by its scale and shows it again', () => {
    const { doc, id } = cube();
    hideSpans(
      doc,
      id,
      [2, 2, 2],
      [
        { from: 1, to: 9 },
        { from: 30, to: null },
      ],
    );
    // shrunk to HIDDEN_SCALE of the scale it is shown at (2 here), shown again at that scale
    expect(at(doc, id, 'scale', 0, 1)).toBe(2 * HIDDEN_SCALE);
    expect(at(doc, id, 'scale', 2, 9)).toBe(2 * HIDDEN_SCALE);
    expect(at(doc, id, 'scale', 1, 10)).toBe(2);
    expect(at(doc, id, 'scale', 0, 29)).toBe(2);
    expect(at(doc, id, 'scale', 0, 30)).toBe(2 * HIDDEN_SCALE);
    expect(at(doc, id, 'scale', 0, 1000)).toBe(2 * HIDDEN_SCALE);
    // the frames before a first span stay shown (no constant extrapolation of the hidden key)
    const other = cube();
    hideSpans(other.doc, other.id, [1, 1, 1], [{ from: 20, to: 30 }]);
    expect(at(other.doc, other.id, 'scale', 0, 5)).toBe(1);
    expect(at(other.doc, other.id, 'scale', 0, 19)).toBe(1);
    expect(at(other.doc, other.id, 'scale', 0, 20)).toBe(HIDDEN_SCALE);
    expect(at(other.doc, other.id, 'scale', 0, 31)).toBe(1);
    // 'keep': the keys after the span stay (a string keyed on every frame of its flight)
    for (let f = 40; f <= 60; f++) setKey(doc, id, 'scale', 0, f, 5, 'LINEAR');
    hideSpans(doc, id, 'keep', [{ from: 45, to: 50 }]);
    expect(at(doc, id, 'scale', 0, 44)).toBe(5);
    expect(at(doc, id, 'scale', 0, 47)).toBe(HIDDEN_SCALE);
    expect(at(doc, id, 'scale', 0, 51)).toBe(5);
  });
});

function cam() {
  return { x: 0, y: 1.5, z: 5, targetX: 0, targetY: 1.2, targetZ: 0, lensMm: 35 };
}

function actor(i: number) {
  return { id: `a${i}`, characterId: `chr_extra0000000${i}`, color: '#ff8a3d', x: i, z: 0 };
}
