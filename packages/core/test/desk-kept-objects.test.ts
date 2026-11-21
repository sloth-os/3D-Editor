import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import {
  briefChanges,
  unitSourceOf,
  updateFromBrief,
  type BriefUnitPin,
  type GivenUnit,
  type SceneBrief,
  type StageBriefReport,
  type UnitSource,
} from '../src/desk/brief';
import { BRIEF_RECORD_KEY } from '../src/desk/brief/record';
import { sha256Hex } from '../src/desk/container';
import { getShots } from '../src/desk/shots';
import { readInstance } from '../src/desk/units';
import { restParentWorld, restWorld } from '../src/desk/units/remove';
import { FrameState } from '../src/eval/frame-state';
import { insertKeyframe } from '../src/anim/fcurve';
import { identity4, invert4, multiply4 } from '../src/math/mat4';
import type { Mat4, Vec3 } from '../src/math/types';
import { createCube } from '../src/mesh/primitives';
import { KITE, MIRA, PIP, actorOf, openBrief, prop, propOf, stagedDoc, unitFrom } from './desk-units-helpers';
import { MUM, SAM, importClip, kiteClip } from './desk-rideo-fixtures';

/*
 * What the person put on a piece the desk builds anew or takes out (a words' prop or landmark the
 * words describe anew or drop, an actor or a shot's camera that goes, the set built again, an
 * actor's look swapped) stays, in the same undo step: hung from what takes the piece's place (the
 * ground when nothing does) where it was in the world at rest, its keyed motion kept where the change
 * of parent allows it, a bone it followed through the piece followed still where the new piece has
 * it, and the warnings name it, and name what no longer follows the animation of a piece that went.
 */

/** The frames keyed motion is compared at. */
const FRAMES = [1, 13, 25, 37, 50];

/** A cube of the person's under `parent` (from bone `bone` of it when given). */
function mine(
  doc: SceneDoc,
  name: string,
  parent: string,
  location: Vec3,
  rotation: Vec3 = [0, 0, 0],
  bone?: string,
): string {
  let id = '';
  doc.transact(() => {
    id = doc.addObject({
      type: 'MESH',
      name,
      data: doc.addMesh(name, createCube()),
      parent,
      location,
      rotation_euler: rotation,
      ...(bone ? { parent_type: 'BONE' as const, parent_bone: bone } : {}),
    });
  });
  return id;
}

/** Keys object `id`'s channel `path`[`index`] at frames 1, 25 and 50 (Bezier). */
function keyed(doc: SceneDoc, id: string, path: string, index: number, values: [number, number, number]) {
  doc.transact(() =>
    doc.setFCurve({
      target_type: 'object',
      target_id: id,
      path,
      index,
      keyframes: [1, 25, 50].map((frame, i) => ({ frame, value: values[i], interpolation: 'BEZIER' })),
      extrapolation: 'CONSTANT',
      mute: false,
    }),
  );
}

/** Expects two matrices to agree to rounding. */
const sameWorld = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v, `entry ${i}`).toBeCloseTo(b[i], 9));

/** An object's evaluated world matrix at the frames. */
const worldsAt = (doc: SceneDoc, id: string): Mat4[] => FRAMES.map((f) => new FrameState(doc, f).world(id)!);

/**
 * How object `id` moves on its own (its keys), placed where its parent is at rest: its parent's rest
 * matrix times its local matrix at each frame (the parent's own motion left out).
 */
function ownMotion(doc: SceneDoc, id: string): Mat4[] {
  const parentRest = restParentWorld(doc, doc.getObject(id)!) ?? identity4();
  return FRAMES.map((f) => multiply4(parentRest, new FrameState(doc, f).local(id)));
}

const undoOf = (doc: SceneDoc) =>
  new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });

/** Everything of the staging but the brief record. */
function staging(doc: SceneDoc): string {
  const scene = Object.fromEntries([...doc.map('scene').entries()].filter(([k]) => k !== BRIEF_RECORD_KEY));
  return JSON.stringify({ objects: doc.listObjects(), curves: doc.listFCurves(), scene });
}

/** Updates `doc` to `b`, checking that briefChanges was null exactly when the update changed nothing. */
function update(doc: SceneDoc, b: SceneBrief, units?: UnitSource): StageBriefReport {
  const o = units ? { units } : {};
  const changes = briefChanges(doc, b, o);
  const before = staging(doc);
  const r = updateFromBrief(doc, b, o);
  expect(changes === null, `briefChanges ${JSON.stringify(changes)}`).toBe(staging(doc) === before);
  return r;
}

const landmarkOf = (doc: SceneDoc) => doc.listObjects().find((o) => prop(o, 'desk_role') === 'landmark')!;
const wordsGround = (doc: SceneDoc) => doc.listObjects().find((o) => prop(o, 'desk_label') === 'ground')!;

/**
 * Brief `b` with the kite described anew as a red balloon; `balloonWords`: the shots' words name the
 * balloon where they named the kite (so Mira holds it, and flies it, again).
 */
function retyped(b: SceneBrief, o: { balloonWords?: boolean } = {}): SceneBrief {
  const el = b.elements.find((e) => e.id === KITE)!;
  el.name = 'Red balloon';
  el.description = 'A big red balloon on a string.';
  if (o.balloonWords)
    for (const s of b.shots) {
      s.description = s.description.replace(/\bkite\b/g, 'balloon');
      s.action = s.action.replace(/\bkite\b/g, 'balloon');
    }
  return b;
}

/** How far object `id` moves over the frames (the largest distance from where it is at the first). */
function travel(doc: SceneDoc, id: string): number {
  const at = worldsAt(doc, id).map((m) => [m[12], m[13], m[14]]);
  return Math.max(...at.map((p) => Math.hypot(p[0] - at[0][0], p[1] - at[0][1], p[2] - at[0][2])));
}

const BALL = 'ele_0123456789ball';
/** Brief `b` with a prop no one holds, the ball `name` (`description`), in its first shot. */
function withBall(b: SceneBrief, name: string, description: string): SceneBrief {
  b.elements.push({ id: BALL, name, description, kind: 'prop' });
  b.shots[0].elementIds = [...b.shots[0].elementIds, BALL];
  return b;
}

/**
 * Brief `b` with the kite the ball `name` (`description`) Mira carries in her hand where she ran with
 * the kite; `firstOnly`: she is in the first shot only (Pip has the close-up), so she lets it go at
 * the cut and it is hidden after.
 */
function heldBall(
  b: SceneBrief,
  name: string,
  description: string,
  o: { firstOnly?: boolean } = {},
): SceneBrief {
  const el = b.elements.find((e) => e.id === KITE)!;
  el.name = name;
  el.description = description;
  for (const s of b.shots) s.description = s.description.replace(/\bkite\b/g, 'ball');
  if (o.firstOnly) {
    b.shots[1].castIds = [PIP];
    b.shots[1].description = 'Close-up: Pip looks up.';
  }
  return b;
}

/** Adds keys of the person's (Bezier) to object `id`'s channel `path`[`index`], beside any there. */
function keyMore(doc: SceneDoc, id: string, path: string, index: number, keys: [number, number][]) {
  doc.transact(() => {
    const fc = doc
      .listFCurves(id)
      .find((c) => c.target_type === 'object' && c.path === path && c.index === index);
    let curve = fc ?? {
      target_type: 'object' as const,
      target_id: id,
      path,
      index,
      keyframes: [],
      extrapolation: 'CONSTANT' as const,
      mute: false,
    };
    for (const [frame, value] of keys) curve = insertKeyframe(curve, frame, value, 'BEZIER');
    doc.setFCurve(curve);
  });
}

/** How far object `id`'s own channels lift it from frame 1 to frame 60 (what its keys do, holds aside). */
const ownRise = (doc: SceneDoc, id: string): number =>
  new FrameState(doc, 60).local(id)[14] - new FrameState(doc, 1).local(id)[14];

describe("what the person put on a words' prop or landmark stays when a later brief builds it anew or drops it", () => {
  it('a prop described anew is built anew with them on it, nested and keyed, in one undo step; a reopened scene keeps them', () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    const ribbon = mine(doc, 'Ribbon', kite.id, [0.1, 0, -0.2], [0, 0, 0.4]);
    const bow = mine(doc, 'Bow', ribbon, [0, 0, 0.1]);
    const riser = mine(doc, 'Riser', kite.id, [0.05, 0, 0]);
    keyed(doc, riser, 'location', 2, [0, 0.3, 0.6]);
    const ours = [ribbon, bow, riser];
    const rests = () => ours.map((id) => restWorld(doc, id));
    const before = rests();
    const rising = ownMotion(doc, riser);
    const undo = undoOf(doc);
    // the shots' words name the balloon: Mira runs with it as she ran with the kite
    const b2 = retyped(openBrief(), { balloonWords: true });
    const r = update(doc, b2);
    const balloon = propOf(doc, KITE);
    expect(balloon.id).not.toBe(kite.id);
    expect(doc.getObject(kite.id)).toBeNull();
    const parents = (d: SceneDoc = doc) => ours.map((id) => d.getObject(id)?.parent);
    expect(parents()).toEqual([balloon.id, ribbon, balloon.id]);
    rests().forEach((m, i) => sameWorld(m, before[i]));
    ownMotion(doc, riser).forEach((m, i) => sameWorld(m, rising[i]));
    expect(r.warnings).toContain(
      `${balloon.name}: keeps 'Ribbon' and 'Riser', which are not part of the prop it replaces`,
    );
    // the staging holds and flies the balloon as it did the kite: what is on it moves with it, unnamed
    expect([prop(kite, 'desk_rideo_held_by'), prop(balloon, 'desk_rideo_held_by')]).toEqual([MIRA, MIRA]);
    expect(prop(balloon, 'desk_tether_flights')).toBeTruthy();
    const flight = worldsAt(doc, balloon.id);
    const onBalloon = worldsAt(doc, ribbon).map((m, i) => multiply4(invert4(flight[i]), m));
    onBalloon.forEach((m) => sameWorld(m, onBalloon[0]));
    expect(r.warnings.join('\n')).not.toMatch(/no longer follow/);
    // one undo step: the kite again, with them on it
    undo.undo();
    expect(propOf(doc, KITE).id).toBe(kite.id);
    expect(parents()).toEqual([kite.id, ribbon, kite.id]);
    rests().forEach((m, i) => sameWorld(m, before[i]));
    undo.redo();
    expect(parents()).toEqual([balloon.id, ribbon, balloon.id]);
    // a reopened scene holds them so, and the same brief changes nothing more
    const reopened = SceneDoc.fromUpdate(doc.encodeState());
    expect(parents(reopened)).toEqual([balloon.id, ribbon, balloon.id]);
    ours.forEach((id, i) => sameWorld(restWorld(reopened, id), before[i]));
    expect(briefChanges(reopened, b2)).toBeNull();
    const again = update(reopened, b2);
    expect(again.warnings.join('\n')).not.toMatch(/keeps|goes|follow/);
  });

  it("a prop described anew that no one holds any more: what followed the old one's flight keeps its place at rest and is named", () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    expect(kite.name).toBe('Red kite');
    const ribbon = mine(doc, 'Ribbon', kite.id, [0.1, 0, -0.2], [0, 0, 0.4]);
    const riser = mine(doc, 'Riser', kite.id, [0.05, 0, 0]);
    keyed(doc, riser, 'location', 2, [0, 0.3, 0.6]);
    const ours = [ribbon, riser];
    const before = ours.map((id) => restWorld(doc, id));
    const rising = ownMotion(doc, riser);
    // the kite flies: what is on it goes up with it
    expect(travel(doc, ribbon)).toBeGreaterThan(1);
    // the shots' words still say the kite, which the brief no longer has: no one holds the balloon
    const r = update(doc, retyped(openBrief()));
    const balloon = propOf(doc, KITE);
    expect(balloon.id).not.toBe(kite.id);
    expect(prop(balloon, 'desk_rideo_held_by')).toBeUndefined();
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([balloon.id, balloon.id]);
    ours.forEach((id, i) => sameWorld(restWorld(doc, id), before[i]));
    ownMotion(doc, riser).forEach((m, i) => sameWorld(m, rising[i]));
    expect(travel(doc, ribbon)).toBeLessThan(1e-9);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "Red balloon: keeps 'Ribbon' and 'Riser', which are not part of the prop it replaces",
        "Red balloon: 'Ribbon' and 'Riser' no longer follow the animation of 'Red kite'",
      ]),
    );
  });

  it('a prop described anew that another holds flies another way: what followed the old one is named', () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    const ribbon = mine(doc, 'Ribbon', kite.id, [0.1, 0, -0.2]);
    // Pip runs with the balloon now, where Mira ran with the kite
    const b2 = retyped(openBrief(), { balloonWords: true });
    b2.shots[0].description = 'Wide: Pip runs across the meadow with the balloon, Mira chasing.';
    const r = update(doc, b2);
    const balloon = propOf(doc, KITE);
    expect([prop(kite, 'desk_rideo_held_by'), prop(balloon, 'desk_rideo_held_by')]).toEqual([MIRA, PIP]);
    expect(prop(balloon, 'desk_tether_flights')).toBeTruthy();
    expect(doc.getObject(ribbon)?.parent).toBe(balloon.id);
    expect(r.warnings).toContain("Red balloon: 'Ribbon' no longer follows the animation of 'Red kite'");
  });

  it('a prop described anew that its holder carries where the old one flew: what followed the flight is named', () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    const ribbon = mine(doc, 'Ribbon', kite.id, [0.1, 0, -0.2]);
    // Mira runs with a ball now: in her hand, where the kite flew on its string
    const b2 = openBrief();
    const el = b2.elements.find((e) => e.id === KITE)!;
    el.name = 'Red ball';
    el.description = 'A small red rubber ball.';
    for (const s of b2.shots) s.description = s.description.replace(/\bkite\b/g, 'ball');
    const r = update(doc, b2);
    const ball = propOf(doc, KITE);
    expect(prop(ball, 'desk_rideo_held_by')).toBe(MIRA);
    expect(prop(ball, 'desk_tether_flights')).toBeUndefined();
    expect(ball.constraints.some((c) => c.type === 'CHILD_OF' && c.name.startsWith('Hold '))).toBe(true);
    expect(doc.getObject(ribbon)?.parent).toBe(ball.id);
    expect(r.warnings).toContain("Red ball: 'Ribbon' no longer follows the animation of 'Red kite'");
  });

  it('a prop the person keyed by hand and the words describe anew: what moved with it is named, as the keys go with it', () => {
    const doc = stagedDoc(withBall(openBrief(), 'Red ball', 'A small red rubber ball.'));
    const ball = propOf(doc, BALL);
    expect(ball.name).toBe('Red ball');
    // no one holds it: the staging leaves it where it stands, and the person keys it bouncing 0.8 m
    expect(prop(ball, 'desk_rideo_held_by')).toBeUndefined();
    const z = ball.location[2];
    keyed(doc, ball.id, 'location', 2, [z, z + 0.8, z]);
    const sticker = mine(doc, 'Sticker', ball.id, [0, 0.1, 0.1]);
    const at = restWorld(doc, sticker);
    expect(travel(doc, sticker)).toBeCloseTo(0.8, 6);
    const r = update(doc, withBall(openBrief(), 'Blue bucket', 'A blue plastic bucket.'));
    const bucket = propOf(doc, BALL);
    expect(bucket.id).not.toBe(ball.id);
    expect(doc.getObject(ball.id)).toBeNull();
    expect(doc.getObject(sticker)?.parent).toBe(bucket.id);
    sameWorld(restWorld(doc, sticker), at);
    expect(travel(doc, sticker)).toBeLessThan(1e-9);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "Blue bucket: keeps 'Sticker', which is not part of the prop it replaces",
        "Blue bucket: 'Sticker' no longer follows the animation of 'Red ball'",
      ]),
    );
  });

  it("a prop staged again but kept keeps the keys of the person's objects on it, and what was on its old string stays on the ground", () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    const riser = mine(doc, 'Riser', kite.id, [0.05, 0, 0]);
    keyed(doc, riser, 'location', 2, [0, 0.3, 0.6]);
    const string = doc.listObjects().find((o) => prop(o, 'desk_string_to') === kite.id)!;
    expect(string).toBeDefined();
    const bead = mine(doc, 'Bead', string.id, [0, 0, 0.2]);
    const beadAt = restWorld(doc, bead);
    const keys = doc.listFCurves(riser).map((fc) => fc.keyframes.map((k) => k.value));
    // the first shot runs a second longer: the kite flies again
    const b2 = openBrief();
    b2.shots[0].durationSec += 1;
    const r = update(doc, b2);
    expect(propOf(doc, KITE).id).toBe(kite.id);
    expect(doc.getObject(riser)?.parent).toBe(kite.id);
    expect(doc.listFCurves(riser).map((fc) => fc.keyframes.map((k) => k.value))).toEqual(keys);
    expect(doc.getObject(string.id)).toBeNull();
    expect(doc.getObject(bead)?.parent).toBe(wordsGround(doc).id);
    sameWorld(restWorld(doc, bead), beadAt);
    expect(r.warnings).toContain(`'${string.name}' goes; 'Bead' stays where it is, on the words' ground`);
  });

  it('a landmark described anew keeps them, keyed moves kept, and names what changes shape or follows the new one', () => {
    const doc = stagedDoc();
    const pond = landmarkOf(doc);
    expect(pond.name).toBe('pond');
    expect(pond.scale).toEqual([5, 4, 1]);
    // a lily turned on the pond (skewed by its uneven scale), a duck swimming across it, a buoy turning
    const lily = mine(doc, 'Lily', pond.id, [0.1, 0.1, 0.02], [0, 0, 0.5]);
    const duck = mine(doc, 'Duck', pond.id, [0.1, 0, 0.02]);
    keyed(doc, duck, 'location', 0, [-0.3, 0, 0.3]);
    const buoy = mine(doc, 'Buoy', pond.id, [-0.1, 0, 0.02]);
    keyed(doc, buoy, 'rotation_euler', 2, [0, 0.5, 1.5]);
    const ours = [lily, duck, buoy];
    const before = ours.map((id) => restWorld(doc, id));
    const swim = worldsAt(doc, duck);
    const undo = undoOf(doc);
    const b2 = openBrief();
    b2.set.description = 'A wide green meadow on a breezy afternoon, a lake on the left, an oak tree behind.';
    const r = update(doc, b2);
    const lake = landmarkOf(doc);
    expect(lake.name).toBe('lake');
    expect(lake.id).not.toBe(pond.id);
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([lake.id, lake.id, lake.id]);
    sameWorld(restWorld(doc, duck), before[1]);
    sameWorld(restWorld(doc, buoy), before[2]);
    worldsAt(doc, duck).forEach((m, i) => sameWorld(m, swim[i]));
    // the lily's origin stays where it was; its skew does not
    sameWorld(restWorld(doc, lily).slice(12, 15), before[0].slice(12, 15));
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "lake: keeps 'Buoy', 'Duck' and 'Lily', which are not part of the landmark it replaces",
        "lake: 'Lily' changes shape on the new landmark: the uneven scale of what it hung from skewed it, and no channels keep that skew there",
        "lake: 'Buoy' is animated: its keyed motion now follows the new landmark",
      ]),
    );
    const motion = r.warnings.filter((w) => /animated|no longer follow/.test(w));
    expect(motion.join('\n')).not.toMatch(/Duck|Lily/);
    undo.undo();
    expect(landmarkOf(doc).id).toBe(pond.id);
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([pond.id, pond.id, pond.id]);
    ours.forEach((id, i) => sameWorld(restWorld(doc, id), before[i]));
    undo.redo();
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([lake.id, lake.id, lake.id]);
  });

  it('a landmark the words drop goes, and what was on it stays on the ground, keyed moves kept', () => {
    const doc = stagedDoc();
    const pond = landmarkOf(doc);
    const duck = mine(doc, 'Duck', pond.id, [0.1, 0, 0.02]);
    keyed(doc, duck, 'location', 0, [-0.3, 0, 0.3]);
    const reed = mine(doc, 'Reed', duck, [0, 0, 0.1]);
    const swim = worldsAt(doc, duck);
    const reedAt = restWorld(doc, reed);
    const b2 = openBrief();
    b2.set.description = 'A wide green meadow on a breezy afternoon, an oak tree behind.';
    const r = update(doc, b2);
    expect(doc.getObject(pond.id)).toBeNull();
    expect(landmarkOf(doc)).toBeUndefined();
    const ground = wordsGround(doc);
    expect(doc.getObject(duck)?.parent).toBe(ground.id);
    expect(doc.getObject(reed)?.parent).toBe(duck);
    worldsAt(doc, duck).forEach((m, i) => sameWorld(m, swim[i]));
    sameWorld(restWorld(doc, reed), reedAt);
    expect(r.warnings).toContain("'pond' goes; 'Duck' stays where it is, on the words' ground");
    expect(r.warnings.join('\n')).not.toMatch(/Reed|animated|follow/);
    // the same brief again changes nothing more
    expect(briefChanges(doc, b2)).toBeNull();
  });
});

describe('keys of the person on a prop the staging holds or flies, which go with it when the words build it anew', () => {
  it('a held ball the person also keyed to rise, described anew and held again by the same holder: what rose with it is named', () => {
    const doc = stagedDoc(heldBall(openBrief(), 'Red ball', 'A small red rubber ball.'));
    const ball = propOf(doc, KITE);
    expect(ball.name).toBe('Red ball');
    expect(prop(ball, 'desk_rideo_held_by')).toBe(MIRA);
    expect(ball.constraints.some((c) => c.type === 'CHILD_OF' && c.name.startsWith('Hold '))).toBe(true);
    // the person keys the ball rising 1 m in her hand over the first shot, and puts a sticker on it
    const z = new FrameState(doc, 1).local(ball.id)[14];
    keyMore(doc, ball.id, 'location', 2, [
      [1, z],
      [60, z + 1],
    ]);
    const sticker = mine(doc, 'Sticker', ball.id, [0, 0, 0.3]);
    const at = restWorld(doc, sticker);
    expect(ownRise(doc, ball.id)).toBeCloseTo(1, 9);
    // the words describe it anew; the shots still put it in Mira's hand
    const r = update(doc, heldBall(openBrief(), 'Blue ball', 'A small blue rubber ball.'));
    const blue = propOf(doc, KITE);
    expect(blue.id).not.toBe(ball.id);
    expect(prop(blue, 'desk_rideo_held_by')).toBe(MIRA);
    expect(blue.constraints.some((c) => c.type === 'CHILD_OF' && c.name.startsWith('Hold '))).toBe(true);
    expect(doc.getObject(sticker)?.parent).toBe(blue.id);
    sameWorld(restWorld(doc, sticker), at);
    // the keys went with the red ball: the sticker no longer rises in her hand, and that is said
    expect(ownRise(doc, blue.id)).toBeCloseTo(0, 9);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "Blue ball: keeps 'Sticker', which is not part of the prop it replaces",
        "Blue ball: 'Sticker' no longer follows the animation of 'Red ball'",
      ]),
    );
  });

  it('a kite the person also keyed in its flight, described anew and flown again by the same holder: what was on it is named', () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    // the person lifts the kite 2 m higher at frame 30 of its flight, a key of their own among the flight's
    const z = new FrameState(doc, 30).local(kite.id)[14];
    keyMore(doc, kite.id, 'location', 2, [[30, z + 2]]);
    const ribbon = mine(doc, 'Ribbon', kite.id, [0.1, 0, -0.2]);
    const at = restWorld(doc, ribbon);
    const r = update(doc, retyped(openBrief(), { balloonWords: true }));
    const balloon = propOf(doc, KITE);
    expect([prop(kite, 'desk_rideo_held_by'), prop(balloon, 'desk_rideo_held_by')]).toEqual([MIRA, MIRA]);
    expect(prop(balloon, 'desk_tether_flights')).toBeTruthy();
    expect(doc.getObject(ribbon)?.parent).toBe(balloon.id);
    sameWorld(restWorld(doc, ribbon), at);
    expect(r.warnings).toContain("Red balloon: 'Ribbon' no longer follows the animation of 'Red kite'");
  });

  it('a held ball only the staging keyed, described anew and held again, keeps what was on it following it, unnamed, also after a ripple', () => {
    const doc = stagedDoc(heldBall(openBrief(), 'Red ball', 'A small red rubber ball.'));
    const ball = propOf(doc, KITE);
    const sticker = mine(doc, 'Sticker', ball.id, [0, 0, 0.3]);
    const at = restWorld(doc, sticker);
    const r = update(doc, heldBall(openBrief(), 'Blue ball', 'A small blue rubber ball.'));
    const blue = propOf(doc, KITE);
    expect(blue.id).not.toBe(ball.id);
    expect(doc.getObject(sticker)?.parent).toBe(blue.id);
    sameWorld(restWorld(doc, sticker), at);
    expect(r.warnings).toContain("Blue ball: keeps 'Sticker', which is not part of the prop it replaces");
    expect(r.warnings.join('\n')).not.toMatch(/no longer follow/);

    // Mira lets it go at the cut and it is hidden after: a ripple moves those keys of the staging's,
    // in the update that builds it anew and in an update before it, and neither reads as the person's
    const once = stagedDoc(
      heldBall(openBrief(), 'Red ball', 'A small red rubber ball.', { firstOnly: true }),
    );
    const twice = stagedDoc(
      heldBall(openBrief(), 'Red ball', 'A small red rubber ball.', { firstOnly: true }),
    );
    for (const d of [once, twice]) mine(d, 'Sticker', propOf(d, KITE).id, [0, 0, 0.3]);
    const longer = (name: string, description: string) => {
      const b = heldBall(openBrief(), name, description, { firstOnly: true });
      b.shots[0].durationSec += 1;
      return b;
    };
    const keysOf = (d: SceneDoc) =>
      d.listFCurves(propOf(d, KITE).id).map((fc) => fc.keyframes.map((k) => k.frame));
    const was = keysOf(twice);
    const r1 = update(twice, longer('Red ball', 'A small red rubber ball.'));
    expect(r1.warnings).toEqual([]);
    expect(keysOf(twice)).not.toEqual(was);
    for (const d of [once, twice]) {
      const red = propOf(d, KITE).id;
      const r2 = update(d, longer('Blue ball', 'A small blue rubber ball.'));
      expect(propOf(d, KITE).id).not.toBe(red);
      expect(r2.warnings).toContain("Blue ball: keeps 'Sticker', which is not part of the prop it replaces");
      expect(r2.warnings.join('\n')).not.toMatch(/no longer follow/);
    }
  });
});

describe('what the person put on an actor, a camera or a prop the brief drops stays on the ground', () => {
  it('an actor that goes leaves what hung from its bones and itself where it was at rest, named as no longer following it', () => {
    const doc = stagedDoc();
    const pip = actorOf(doc, PIP);
    const hat = mine(doc, 'Hat', pip.id, [0, 0.05, 0], [0, 0, 0], 'head');
    const collar = mine(doc, 'Collar', pip.id, [0, 0, 0.3]);
    const ours = [hat, collar];
    const before = ours.map((id) => restWorld(doc, id));
    // the hat hangs from the head bone's tail, which a matrix that knows nothing of bones leaves out
    expect(Math.abs(before[0][14] - doc.worldMatrix(hat)[14])).toBeGreaterThan(0.1);
    const undo = undoOf(doc);
    const b2 = openBrief();
    b2.cast = b2.cast.filter((c) => c.id !== PIP);
    for (const s of b2.shots) {
      s.castIds = s.castIds.filter((c) => c !== PIP);
      s.layout = s.layout.filter((l) => l.castId !== PIP);
    }
    const r = update(doc, b2);
    expect(doc.getObject(pip.id)).toBeNull();
    const ground = wordsGround(doc);
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([ground.id, ground.id]);
    expect(doc.getObject(hat)?.parent_type).toBe('OBJECT');
    ours.forEach((id, i) => sameWorld(restWorld(doc, id), before[i]));
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "'Pip' goes; 'Collar' and 'Hat' stay where they are, on the words' ground",
        "'Collar' and 'Hat' no longer follow the animation of 'Pip'",
      ]),
    );
    undo.undo();
    expect(actorOf(doc, PIP).id).toBe(pip.id);
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([pip.id, pip.id]);
    expect(doc.getObject(hat)).toMatchObject({ parent_type: 'BONE', parent_bone: 'head' });
    ours.forEach((id, i) => sameWorld(restWorld(doc, id), before[i]));
  });

  it('a shot that goes takes its camera, but a light the person hung on it stays on the ground', () => {
    const doc = stagedDoc();
    const shot = getShots(doc).find((s) => s.external?.shot === 'sht_0123456789bbbb')!;
    let fill = '';
    doc.transact(() => {
      fill = doc.addObject({
        type: 'LIGHT',
        name: 'Fill',
        data: doc.addLight({ name: 'Fill', type: 'POINT' }),
        parent: shot.camera!,
        location: [0.2, 0, 0],
      });
    });
    const at = restWorld(doc, fill);
    const b2 = openBrief();
    b2.shots = b2.shots.filter((s) => s.id !== 'sht_0123456789bbbb');
    const r = update(doc, b2);
    expect(doc.getObject(shot.camera!)).toBeNull();
    expect(doc.getObject(fill)?.parent).toBe(wordsGround(doc).id);
    sameWorld(restWorld(doc, fill), at);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        `'${shot.name}' goes; 'Fill' stays where it is, on the words' ground`,
        `'Fill' no longer follows the animation of '${shot.name}'`,
      ]),
    );
  });

  it('a prop the brief drops goes with its string, and what was on them stays on the ground', () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    const ribbon = mine(doc, 'Ribbon', kite.id, [0.1, 0, -0.2]);
    const at = restWorld(doc, ribbon);
    const b2 = openBrief();
    b2.elements = b2.elements.filter((e) => e.id !== KITE);
    for (const s of b2.shots) s.elementIds = (s.elementIds ?? []).filter((e) => e !== KITE);
    const r = update(doc, b2);
    expect(doc.getObject(kite.id)).toBeNull();
    expect(doc.listObjects().filter((o) => prop(o, 'desk_string_to') === kite.id)).toEqual([]);
    expect(doc.getObject(ribbon)?.parent).toBe(wordsGround(doc).id);
    sameWorld(restWorld(doc, ribbon), at);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        `'${kite.name}' goes; 'Ribbon' stays where it is, on the words' ground`,
        `'Ribbon' no longer follows the animation of '${kite.name}'`,
      ]),
    );
  });
});

/** A library version: its pin and the file the host sends for it. */
function lib(ref: string, version: number, data: Uint8Array): { pin: BriefUnitPin; given: GivenUnit } {
  const sha256 = sha256Hex(data);
  return { pin: { ref, version, sha256 }, given: { ref, version, sha256, data } };
}

describe("what the person put on an actor's look stays on the bone it followed when the look is swapped", () => {
  it('a figure pinned in an update, and the mannequin back when the pin goes, keep a hat on the head where it was and moving with it', () => {
    const src = stagedDoc();
    const figure = unitFrom(src, { kind: 'figure', actor: actorOf(src, MIRA).id, name: 'Mira' });
    src.destroy();
    const mira = lib('lib_0123456789mira', 1, figure.ex.data);
    const units = unitSourceOf([mira.given]);
    const doc = stagedDoc();
    const actor = actorOf(doc, MIRA);
    const head = doc
      .listObjects()
      .find((o) => o.parent === actor.id && o.parent_type === 'BONE' && o.parent_bone === 'head')!;
    expect(head).toBeDefined();
    // a hat on the mannequin's head part, a badge on the actor itself
    const hat = mine(doc, 'Hat', head.id, [0, 0, 0.1]);
    const badge = mine(doc, 'Badge', actor.id, [0, -0.1, 1.1]);
    const before = [hat, badge].map((id) => restWorld(doc, id));
    const bobbing = worldsAt(doc, hat);
    const undo = undoOf(doc);
    const pinned = openBrief();
    pinned.cast.find((c) => c.id === MIRA)!.unit = mira.pin;
    const r = update(doc, pinned, units);
    expect(readInstance(doc, actor.id)).toMatchObject({ ref: mira.pin.ref, version: 1 });
    expect(doc.getObject(head.id)).toBeNull();
    expect(doc.getObject(hat)).toMatchObject({ parent: actor.id, parent_type: 'BONE', parent_bone: 'head' });
    expect(doc.getObject(badge)).toMatchObject({ parent: actor.id, parent_type: 'OBJECT' });
    [hat, badge].forEach((id, i) => sameWorld(restWorld(doc, id), before[i]));
    worldsAt(doc, hat).forEach((m, i) => sameWorld(m, bobbing[i]));
    expect(r.warnings).toContain(
      "Mira: keeps 'Badge' and 'Hat', which are not part of the look the library figure replaces",
    );
    expect(r.warnings.join('\n')).not.toMatch(/no longer follow|animated/);
    undo.undo();
    expect(doc.getObject(hat)?.parent).toBe(head.id);
    sameWorld(restWorld(doc, hat), before[0]);
    undo.redo();
    // a cap the person puts on the figure's own head part stays on the head when the pin goes
    const figureHead = [...readInstance(doc, actor.id)!.parts.values()]
      .map((p) => doc.getObject(p.id))
      .find((o) => o?.parent === actor.id && o.parent_type === 'BONE' && o.parent_bone === 'head')!;
    expect(figureHead).toBeDefined();
    const cap = mine(doc, 'Cap', figureHead.id, [0, 0.05, 0.1]);
    const capAt = restWorld(doc, cap);
    const capBobbing = worldsAt(doc, cap);
    const back = update(doc, openBrief(), units);
    expect(readInstance(doc, actor.id)).toBeNull();
    expect(doc.getObject(cap)).toMatchObject({ parent: actor.id, parent_type: 'BONE', parent_bone: 'head' });
    sameWorld(restWorld(doc, cap), capAt);
    worldsAt(doc, cap).forEach((m, i) => sameWorld(m, capBobbing[i]));
    expect(back.warnings).toContain(
      "Mira: keeps 'Badge', 'Hat' and 'Cap', which are not part of the library figure's look",
    );
    expect(back.warnings.join('\n')).not.toMatch(/no longer follow|animated/);
  });
});

describe('what the person put on what a rideo re-import builds anew or drops stays', () => {
  /** The kite clip again with Sam taller (his actor built anew), Mum gone, the bench gone, the oak a box and the kite a balloon. */
  function changedClip() {
    const clip = kiteClip();
    const b = clip.blocking as {
      actors: { characterId: string; heightM: number }[];
      set: { landmarks: { id: string; shape: string }[] };
      props: { label: string }[];
      shots: Record<string, { marks?: Record<string, unknown> }>;
    };
    b.actors.find((a) => a.characterId === SAM)!.heightM = 1.5;
    b.actors = b.actors.filter((a) => a.characterId !== MUM);
    for (const s of Object.values(b.shots)) if (s.marks) delete s.marks[MUM];
    b.set.landmarks = b.set.landmarks.filter((l) => l.id !== 'l2');
    b.set.landmarks[0].shape = 'box';
    b.props[0].label = 'balloon';
    clip.characters = clip.characters!.filter((c) => c.id !== MUM);
    clip.shots = clip.shots
      .map((s) => ({ ...s, characterIds: s.characterIds!.filter((c) => c !== MUM) }))
      .filter((s) => s.characterIds.length);
    const elements = clip.elements!;
    elements[0] = { ...elements[0], name: 'Red balloon', label: 'balloon' };
    return clip;
  }

  it('keeps them on the actor, landmark and prop built anew and on the ground for what goes, a hat on its bone', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, kiteClip());
    const sam = first.actors.find((a) => a.character_id === SAM)!.id;
    const mum = first.actors.find((a) => a.character_id === MUM)!.id;
    const kite = first.props[0].id;
    const bench = first.landmarks.find((l) => l.rideo_id === 'l2')!.id;
    const oak = first.landmarks.find((l) => l.rideo_id === 'l1')!.id;
    const samHead = doc
      .listObjects()
      .find((o) => o.parent === sam && o.parent_type === 'BONE' && o.parent_bone === 'head')!;
    const hat = mine(doc, 'Hat', samHead.id, [0, 0.05, 0.1]);
    const scarf = mine(doc, 'Scarf', mum, [0, -0.1, 1.4]);
    const ribbon = mine(doc, 'Ribbon', kite, [0.1, 0, -0.2]);
    const cushion = mine(doc, 'Cushion', bench, [0, 0, 0.5]);
    const nest = mine(doc, 'Nest', oak, [0.3, 0, 0.8]);
    const ours = [hat, scarf, ribbon, cushion, nest];
    const before = ours.map((id) => restWorld(doc, id));
    const r = importClip(doc, changedClip());
    const sam2 = r.actors.find((a) => a.character_id === SAM)!.id;
    const balloon = r.props[0].id;
    const oak2 = r.landmarks.find((l) => l.rideo_id === 'l1')!.id;
    expect([sam2, balloon, oak2]).not.toContain(sam);
    expect(balloon).not.toBe(kite);
    expect(oak2).not.toBe(oak);
    for (const gone of [sam, mum, kite, bench, oak]) expect(doc.getObject(gone)).toBeNull();
    const ground = wordsGround(doc).id;
    expect(ours.map((id) => doc.getObject(id)?.parent)).toEqual([sam2, ground, balloon, ground, oak2]);
    expect(doc.getObject(hat)).toMatchObject({ parent_type: 'BONE', parent_bone: 'head' });
    ours.forEach((id, i) => sameWorld(restWorld(doc, id), before[i]));
    // the hat moves with the new actor's head
    const newHead = doc
      .listObjects()
      .find((o) => o.parent === sam2 && o.parent_type === 'BONE' && o.parent_bone === 'head')!;
    const onHead = (f: number) => {
      const fs = new FrameState(doc, f);
      return multiply4(invert4(fs.world(newHead.id)!), fs.world(hat)!);
    };
    for (const f of [30, 60, 90]) sameWorld(onHead(f), onHead(1));
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "Sam: keeps 'Hat', which is not part of the actor it replaces",
        "'Mum' goes; 'Scarf' stays where it is, on the words' ground",
        "'Scarf' no longer follows the animation of 'Mum'",
        "balloon: keeps 'Ribbon', which is not part of the prop it replaces",
        "'park bench' goes; 'Cushion' stays where it is, on the words' ground",
        "oak tree: keeps 'Nest', which is not part of the landmark it replaces",
      ]),
    );
    expect(r.warnings.join('\n')).not.toMatch(/'Hat' no longer|'Ribbon' no longer/);
    // importing the same clip again builds the set again as it was: nothing more is named
    const again = importClip(doc, changedClip());
    expect(again.warnings.join('\n')).not.toMatch(/keeps|goes|follow|Cushion/);
    expect(doc.getObject(cushion)?.parent).toBe(wordsGround(doc).id);
    sameWorld(restWorld(doc, cushion), before[3]);
  });

  it('names what followed the flight of a prop it builds anew that no one holds any more', () => {
    const doc = SceneDoc.create({ empty: true });
    const kite = importClip(doc, kiteClip()).props[0].id;
    expect(doc.getObject(kite)?.name).toBe('kite');
    const ribbon = mine(doc, 'Ribbon', kite, [0.1, 0, -0.2]);
    const at = restWorld(doc, ribbon);
    expect(travel(doc, ribbon)).toBeGreaterThan(1);
    // the kite is a balloon now, and rideo has no one holding it
    const clip = changedClip();
    delete (clip.blocking as { props: { heldBy?: string }[] }).props[0].heldBy;
    const r = importClip(doc, clip);
    const balloon = r.props[0].id;
    expect(balloon).not.toBe(kite);
    expect(r.props[0].held_by ?? null).toBeNull();
    expect(doc.getObject(ribbon)?.parent).toBe(balloon);
    sameWorld(restWorld(doc, ribbon), at);
    expect(travel(doc, ribbon)).toBeLessThan(1e-9);
    expect(r.warnings).toContain("balloon: 'Ribbon' no longer follows the animation of 'kite'");
  });

  it('names what followed a prop the person keyed by hand that it builds anew, though the clip flies the new one alike', () => {
    const doc = SceneDoc.create({ empty: true });
    const kite = importClip(doc, kiteClip()).props[0].id;
    // a key of the person's among the flight's: the kite 2 m higher at frame 30
    const z = new FrameState(doc, 30).local(kite)[14];
    keyMore(doc, kite, 'location', 2, [[30, z + 2]]);
    const ribbon = mine(doc, 'Ribbon', kite, [0.1, 0, -0.2]);
    const at = restWorld(doc, ribbon);
    const r = importClip(doc, changedClip());
    const balloon = r.props[0].id;
    expect(balloon).not.toBe(kite);
    expect(r.props[0].held_by).toBe(SAM);
    expect(doc.getObject(ribbon)?.parent).toBe(balloon);
    sameWorld(restWorld(doc, ribbon), at);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "balloon: keeps 'Ribbon', which is not part of the prop it replaces",
        "balloon: 'Ribbon' no longer follows the animation of 'kite'",
      ]),
    );
  });
});
