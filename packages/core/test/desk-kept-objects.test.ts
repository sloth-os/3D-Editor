import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import {
  briefChanges,
  stageBrief,
  unitSourceOf,
  updateFromBrief,
  type BriefUnitPin,
  type GivenUnit,
  type SceneBrief,
  type StageBriefReport,
  type UnitSource,
} from '../src/desk/brief';
import { BRIEF_RECORD_KEY } from '../src/desk/brief/record';
import { docContext } from '../src/desk/brief/stage';
import { sha256Hex } from '../src/desk/container';
import { RIDEO_PROPS, cameraOwnAsStaged, motionDigest, recordMotionOf } from '../src/desk/rideo/import';
import { getShots, newShotId, setShots } from '../src/desk/shots';
import { readInstance } from '../src/desk/units';
import { restParentWorld, restWorld } from '../src/desk/units/remove';
import { FrameState } from '../src/eval/frame-state';
import { insertKeyframe } from '../src/anim/fcurve';
import { identity4, invert4, multiply4 } from '../src/math/mat4';
import type { Mat4, Vec3 } from '../src/math/types';
import type { ShotData } from '../src/doc/types';
import { createCube } from '../src/mesh/primitives';
import { solveShotCameras } from '../src/operators/desk-shots';
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

  it('a held ball the person keyed, which an update ripples before another builds it anew: what rose with it is named', () => {
    const doc = stagedDoc(heldBall(openBrief(), 'Red ball', 'A small red rubber ball.', { firstOnly: true }));
    const ball = propOf(doc, KITE);
    // the person keys the ball rising 1 m in Mira's hand, and puts a sticker on it
    const z = new FrameState(doc, 1).local(ball.id)[14];
    keyMore(doc, ball.id, 'location', 2, [
      [1, z],
      [60, z + 1],
    ]);
    mine(doc, 'Sticker', ball.id, [0, 0, 0.3]);
    const longer = (name: string, description: string) => {
      const b = heldBall(openBrief(), name, description, { firstOnly: true });
      b.shots[0].durationSec += 1;
      return b;
    };
    // the first shot runs a second longer: a ripple moves the ball's keys, the person's with the staging's,
    // and the ball stays the person's keyed one
    const r1 = update(doc, longer('Red ball', 'A small red rubber ball.'));
    expect(propOf(doc, KITE).id).toBe(ball.id);
    expect(r1.warnings.join('\n')).not.toMatch(/no longer follow/);
    // the words describe it anew: the keys go with the red ball, and what rose with it is named
    const r2 = update(doc, longer('Blue ball', 'A small blue rubber ball.'));
    expect(propOf(doc, KITE).id).not.toBe(ball.id);
    expect(r2.warnings).toContain("Blue ball: 'Sticker' no longer follows the animation of 'Red ball'");
  });

  it('a prop the person keyed, which an update stages again before another builds it anew: what was on it is not named', () => {
    /** A third shot: Mira runs back with the prop, which the staging flies or carries again in it. */
    const back = (b: SceneBrief, what: string) => {
      b.shots.push({
        ...structuredClone(b.shots[0]),
        id: 'sht_0123456789cccc',
        index: b.shots.length,
        description: `Wide: Mira runs back across the meadow with the ${what}, Pip chasing.`,
      });
      return b;
    };
    /** Pip carries the ball in the first shot where Mira did. */
    const pip = (b: SceneBrief) => {
      b.shots[0].description = 'Wide: Pip runs across the meadow with the ball, Mira chasing.';
      return b;
    };
    const red = () => heldBall(openBrief(), 'Red ball', 'A small red rubber ball.');
    const cases: [string, () => SceneBrief, () => SceneBrief, () => SceneBrief][] = [
      [
        'the kite flown again in a new shot',
        openBrief,
        () => back(openBrief(), 'kite'),
        () => back(retyped(openBrief(), { balloonWords: true }), 'balloon'),
      ],
      [
        'the ball carried by another',
        red,
        () => pip(red()),
        () => pip(heldBall(openBrief(), 'Blue ball', 'A small blue rubber ball.')),
      ],
    ];
    /** The keys on the prop's own transform channels. */
    const ownKeys = (d: SceneDoc) =>
      JSON.stringify(
        d
          .listFCurves(propOf(d, KITE).id)
          .filter((c) => ['location', 'rotation_euler', 'scale'].includes(c.path))
          .map((c) => [c.path, c.index, c.keyframes]),
      );
    for (const [what, first, again, anew] of cases) {
      const doc = stagedDoc(first());
      const ref = stagedDoc(first());
      const p = propOf(doc, KITE);
      // the person lifts it 2 m at frame 30, and puts a sticker on it
      const z = new FrameState(doc, 1).local(p.id)[14];
      keyMore(doc, p.id, 'location', 2, [[30, z + 2]]);
      for (const d of [doc, ref]) mine(d, 'Sticker', propOf(d, KITE).id, [0, 0, 0.3]);
      // staged again: the staging's keys take the place of the person's, as where they keyed nothing
      for (const d of [doc, ref]) update(d, again());
      expect(propOf(doc, KITE).id, what).toBe(p.id);
      expect(ownKeys(doc), what).toBe(ownKeys(ref));
      // built anew and staged alike: what was on it follows the new one as it followed the old
      const r = update(doc, anew());
      const now = propOf(doc, KITE);
      expect(now.id, what).not.toBe(p.id);
      expect(r.warnings, what).toContain(
        `${now.name}: keeps 'Sticker', which is not part of the prop it replaces`,
      );
      expect(r.warnings.join('\n'), what).not.toMatch(/no longer follow/);
    }
  });
});

/** The brief's shot `host` as the desk has it. */
const shotOf = (doc: SceneDoc, host: string) => getShots(doc).find((s) => s.external?.shot === host)!;

/** The brief's first shot as the desk has it. */
const firstShot = (doc: SceneDoc) => shotOf(doc, 'sht_0123456789aaaa');

/** The world matrix of the camera of the brief's shot `host` at every frame of the shot. */
function shotCamera(doc: SceneDoc, host: string): Mat4[] {
  const s = shotOf(doc, host);
  const out: Mat4[] = [];
  for (let f = s.frame_start; f <= s.frame_end; f++) out.push(new FrameState(doc, f).world(s.camera!)!);
  return out;
}

/** The world matrix of the first shot's camera at every frame of the shot. */
const firstShotCamera = (doc: SceneDoc) => shotCamera(doc, 'sht_0123456789aaaa');

/** The largest difference between two lists of world matrices, entry by entry (axes as they are). */
const largestGap = (a: readonly Mat4[], b: readonly Mat4[]) =>
  Math.max(...a.map((m, i) => Math.max(...m.map((v, k) => Math.abs(v - b[i][k])))));

/**
 * Hangs the first shot's camera from `parent` where the camera stands in the world at rest (`at`
 * 'rest') or at the shot's first frame ('first'); returns the camera.
 */
function hangCamera(doc: SceneDoc, parent: string, at: 'rest' | 'first'): string {
  const s = firstShot(doc);
  const cam = s.camera!;
  const fs = new FrameState(doc, s.frame_start);
  doc.setParent(
    cam,
    parent,
    true,
    at === 'rest'
      ? { world: doc.worldMatrix(cam), parentWorld: doc.worldMatrix(parent) }
      : { world: fs.world(cam)!, parentWorld: fs.world(parent)! },
  );
  return cam;
}

/** The staged scene with the first shot's camera hung from the kite (hangCamera). */
function cameraOnKite(at: 'rest' | 'first'): { doc: SceneDoc; cam: string } {
  const doc = stagedDoc();
  return { doc, cam: hangCamera(doc, propOf(doc, KITE).id, at) };
}

/** The warnings that speak of the first shot's camera `cam`: by what it is, or by its name. */
const cameraWarnings = (doc: SceneDoc, cam: string, warnings: readonly string[]) =>
  warnings.filter((w) => /camera/.test(w) || w.includes(`'${doc.getObject(cam)!.name}'`));

describe('a shot camera the person hung from a prop that a later brief builds anew', () => {
  it('is taken off the new prop that flies in the shot and solved again, where the camera that never hung is', () => {
    const ref = stagedDoc();
    update(ref, retyped(openBrief(), { balloonWords: true }));
    for (const at of ['rest', 'first'] as const) {
      const { doc, cam } = cameraOnKite(at);
      // the kite flies through the shot, and the camera with it
      expect(largestGap(firstShotCamera(doc), firstShotCamera(stagedDoc()))).toBeGreaterThan(0.5);
      const r = update(doc, retyped(openBrief(), { balloonWords: true }));
      expect(doc.getObject(cam)!.parent).toBeNull();
      expect(doc.getObject(cam)!.scale).toEqual([1, 1, 1]);
      expect(largestGap(firstShotCamera(doc), firstShotCamera(ref))).toBeLessThan(1e-9);
      expect(r.warnings).toContain(
        "Shot 1: its camera hung from 'Red kite' (built anew as 'Red balloon'), which moves during the shot; the update took it off 'Red balloon' and solved it again",
      );
      expect(r.solved).toEqual(['sht_0123456789aaaa']);
    }
  });

  it("hung under a rig of the person's on the prop, is taken off the rig and solved again when the new prop flies, the warning naming the rig", () => {
    const ref = stagedDoc();
    update(ref, retyped(openBrief(), { balloonWords: true }));
    const doc = stagedDoc();
    // an empty half a metre above the kite, the camera hung from it where it stands at the shot's
    // first frame
    let rig = '';
    doc.transact(() => {
      rig = doc.addObject({
        type: 'EMPTY',
        name: 'Rig',
        parent: propOf(doc, KITE).id,
        location: [0, 0, 0.5],
        rotation_euler: [0, 0, 0],
        scale: [1, 1, 1],
      });
    });
    const cam = hangCamera(doc, rig, 'first');
    const r = update(doc, retyped(openBrief(), { balloonWords: true }));
    // the rig stays on the balloon, which flies otherwise than the kite did: the camera comes off it
    expect(doc.getObject(rig)!.parent).toBe(propOf(doc, KITE).id);
    expect(doc.getObject(cam)!.parent).toBeNull();
    expect(doc.getObject(cam)!.scale).toEqual([1, 1, 1]);
    expect(r.solved).toEqual(['sht_0123456789aaaa']);
    expect(largestGap(firstShotCamera(doc), firstShotCamera(ref))).toBeLessThan(1e-9);
    expect(cameraWarnings(doc, cam, r.warnings)).toEqual([
      "Shot 1: its camera hung from 'Rig', which moves during the shot; the update took it off 'Rig' and solved it again",
    ]);
  });

  it('stays on the new prop that stands still in the shot, where it was', () => {
    // the balloon no one holds: it stands where the kite was at rest
    const ref = stagedDoc();
    update(ref, retyped(openBrief()));
    const { doc, cam } = cameraOnKite('rest');
    const r = update(doc, retyped(openBrief()));
    expect(doc.getObject(cam)!.parent).toBe(propOf(doc, KITE).id);
    expect(largestGap(firstShotCamera(doc), firstShotCamera(ref))).toBeLessThan(1e-9);
    expect(r.warnings.filter((w) => w.includes('took it off'))).toEqual([]);
    expect(r.solved).toEqual([]);

    // hung where it stood at the shot's first frame, from the kite in flight: the update does not
    // solve it, as the balloon stands still in the shot (one only hung is solved off a piece built
    // anew that moves), so it keeps the hang the kept-objects rule gives it, on the balloon where it
    // was in the world at rest, named as no longer following the kite's flight
    const first = cameraOnKite('first');
    const atRest = restWorld(first.doc, first.cam);
    const r2 = update(first.doc, retyped(openBrief()));
    expect(first.doc.getObject(first.cam)!.parent).toBe(propOf(first.doc, KITE).id);
    sameWorld(restWorld(first.doc, first.cam), atRest);
    expect(r2.solved).toEqual([]);
    expect(cameraWarnings(first.doc, first.cam, r2.warnings)).toEqual([
      "Red balloon: 'Shot 1' no longer follows the animation of 'Red kite'",
    ]);
  });

  it("is taken off and solved with that one warning also when its shot's cast, framing or size or the set changes; kept as set by hand while the new prop stands still", () => {
    // the meadow as a library set, which an update places in the words' set's stead
    const src = stagedDoc();
    const meadow = lib('lib_0123456789mead', 1, unitFrom(src, { kind: 'set', name: 'Meadow' }).ex.data);
    src.destroy();
    const both = ['sht_0123456789aaaa', 'sht_0123456789bbbb'];
    /** Mira alone in the first shot. */
    const recast = (b: SceneBrief) => {
      b.shots[0].castIds = [MIRA];
      b.shots[0].layout = b.shots[0].layout.filter((l) => l.castId === MIRA);
    };
    const changes: { what: string; change: (b: SceneBrief) => void; solved: string[]; units?: UnitSource }[] =
      [
        { what: 'its cast', change: recast, solved: ['sht_0123456789aaaa'] },
        {
          what: 'its framing',
          change: (b) => (b.shots[0].framing = 'medium'),
          solved: ['sht_0123456789aaaa'],
        },
        {
          what: 'the frame size',
          change: (b) => {
            b.width = 1920;
            b.height = 1080;
          },
          solved: both,
        },
        {
          what: 'the set',
          change: (b) => (b.set.unit = meadow.pin),
          solved: both,
          units: unitSourceOf([meadow.given]),
        },
        {
          what: 'its cast and the set',
          change: (b) => {
            recast(b);
            b.set.unit = meadow.pin;
          },
          solved: both,
          units: unitSourceOf([meadow.given]),
        },
      ];
    /** The kite described anew as a red balloon, which Mira flies when `flies`, with `change` made. */
    const next = (change: (b: SceneBrief) => void, flies = true) => {
      const b = retyped(openBrief(), { balloonWords: flies });
      change(b);
      return b;
    };
    for (const { what, change, solved, units } of changes) {
      // the camera that never hung, after the same update
      const ref = stagedDoc();
      update(ref, next(change), units);
      const { doc, cam } = cameraOnKite('first');
      const r = update(doc, next(change), units);
      // the balloon Mira flies moves in the shot otherwise than the kite did: the update solves the
      // camera, so it does not keep it as set by hand
      expect(doc.getObject(cam)!.parent, what).toBeNull();
      expect(r.solved, what).toEqual(solved);
      expect(largestGap(firstShotCamera(doc), firstShotCamera(ref)), what).toBeLessThan(1e-9);
      expect(cameraWarnings(doc, cam, r.warnings), what).toEqual([
        "Shot 1: its camera hung from 'Red kite' (built anew as 'Red balloon'), which moves during the shot; the update took it off 'Red balloon' and solved it again",
      ]);
      expect(r.warnings.join('\n'), what).not.toMatch(/set by hand/);
    }
    // the balloon no one flies stands still: the update does not solve the camera, which counts as
    // set by hand as its shot's framing changed, kept on the balloon with that warning
    const { doc, cam } = cameraOnKite('first');
    const r = update(doc, next(changes[1].change, false));
    expect(doc.getObject(cam)!.parent).toBe(propOf(doc, KITE).id);
    expect(r.solved).toEqual([]);
    expect(cameraWarnings(doc, cam, r.warnings)).toEqual([
      'Shot 1: its camera was set by hand in the desk and is kept; its camera plan changed, so check its framing (solve it again with desk.shot_solve)',
      "Red balloon: 'Shot 1' no longer follows the animation of 'Red kite'",
    ]);
  });

  it('that another shot uses too is taken off and solved again for both shots when the size or the set changes, its one warning naming both', () => {
    // the meadow as a library set, which an update places in the words' set's stead
    const src = stagedDoc();
    const meadow = lib('lib_0123456789mead', 1, unitFrom(src, { kind: 'set', name: 'Meadow' }).ex.data);
    src.destroy();
    const both = ['sht_0123456789aaaa', 'sht_0123456789bbbb'];
    /** The staged scene with the second shot shooting with the first shot's camera. */
    const sharing = () => {
      const doc = stagedDoc();
      const cam = firstShot(doc).camera!;
      setShots(
        doc,
        getShots(doc).map((s) => (s.external?.shot === both[1] ? { ...s, camera: cam } : s)),
      );
      return doc;
    };
    /** The camera's world matrices over each of the two shots. */
    const paths = (doc: SceneDoc) => both.map((host) => shotCamera(doc, host));
    const changes: { what: string; change: (b: SceneBrief) => void; units?: UnitSource }[] = [
      {
        what: 'the frame size',
        change: (b) => {
          b.width = 1920;
          b.height = 1080;
        },
      },
      { what: 'the set', change: (b) => (b.set.unit = meadow.pin), units: unitSourceOf([meadow.given]) },
    ];
    for (const { what, change, units } of changes) {
      /** The kite described anew as a red balloon Mira flies, with `change` made. */
      const next = () => {
        const b = retyped(openBrief(), { balloonWords: true });
        change(b);
        return b;
      };
      // the camera both shots use, never hung, after the same update: solved for both
      const ref = sharing();
      expect(update(ref, next(), units).solved, what).toEqual(both);
      const doc = sharing();
      const cam = hangCamera(doc, propOf(doc, KITE).id, 'first');
      const hung = {
        cam: doc.getObject(cam),
        keys: doc.listFCurves(cam),
        shots: getShots(doc),
        paths: paths(doc),
      };
      const undo = undoOf(doc);
      const r = update(doc, next(), units);
      // the balloon Mira flies moves in the first shot otherwise than the kite did: the camera comes
      // off it and is solved again for each shot that uses it, as the camera that never hung is
      expect(doc.getObject(cam)!.parent, what).toBeNull();
      expect(r.solved, what).toEqual(both);
      const solved = paths(doc);
      paths(ref).forEach((p, i) =>
        expect(largestGap(solved[i], p), `${what}: ${both[i]}`).toBeLessThan(1e-9),
      );
      expect(cameraWarnings(doc, cam, r.warnings), what).toEqual([
        "Shot 1: its camera hung from 'Red kite' (built anew as 'Red balloon'), which moves during the shot; the update took it off 'Red balloon' and solved it again, also for Shot 2, which uses the same camera",
      ]);
      expect(r.warnings.join('\n'), what).not.toMatch(/set by hand/);
      // one undo step puts the hang back as it was
      undo.undo();
      expect(doc.getObject(cam), what).toEqual(hung.cam);
      expect(doc.listFCurves(cam), what).toEqual(hung.keys);
      expect(getShots(doc), what).toEqual(hung.shots);
      paths(doc).forEach((p, i) => expect(largestGap(p, hung.paths[i]), `${what}: ${both[i]}`).toBe(0));
    }
  });

  it('that another shot uses too, recorded where it hangs with no own part as an older desk recorded cameras, is taken off and solved again for both shots when one is framed anew, whichever comes first in the cut, and neither keeps a set-by-hand warning', () => {
    const both = ['sht_0123456789aaaa', 'sht_0123456789bbbb'];
    /** The kite described anew as a red balloon Mira flies, the second shot framed anew. */
    const next = () => {
      const b = retyped(openBrief(), { balloonWords: true });
      b.shots[1].framing = 'medium';
      return b;
    };
    // the first shot first in the cut, as staged: its pass meets the camera, which it does not
    // solve, before the second shot's pass takes it off; then the second shot first, whose pass
    // takes it off before the first shot's
    for (const cut of [both, [both[1], both[0]]]) {
      const what = `${cut[0] === both[0] ? 'Shot 1' : 'Shot 2'} first in the cut`;
      const doc = stagedDoc();
      const cam = firstShot(doc).camera!;
      // the second shot shoots with the first shot's camera, the two in the cut in `cut`'s order
      const shots = getShots(doc).map((s) => (s.external?.shot === both[1] ? { ...s, camera: cam } : s));
      const slots = shots.flatMap((s, i) => (both.includes(s.external?.shot ?? '') ? [i] : []));
      const byHost = (host: string) => shots.find((s) => s.external?.shot === host)!;
      setShots(
        doc,
        shots.map((s, i) => (slots.includes(i) ? byHost(cut[slots.indexOf(i)]) : s)),
      );
      hangCamera(doc, propOf(doc, KITE).id, 'first');
      // recorded as staged where it hangs, as a desk before cameras had an own part recorded it: what
      // it does and nothing more, which cannot tell the hang from what the person set on it
      const o = doc.getObject(cam)!;
      doc.updateObject(cam, {
        custom_props: { ...o.custom_props, [RIDEO_PROPS.motion]: motionDigest(doc, cam) },
      });
      expect(cameraOwnAsStaged(doc, cam), what).toBe(false);
      const hung = { cam: doc.getObject(cam), keys: doc.listFCurves(cam), shots: getShots(doc) };
      const undo = undoOf(doc);
      const r = update(doc, next());
      // the second shot, framed anew, is solved: the balloon Mira flies moves in it otherwise than
      // the kite did, so the camera comes off it and is solved again for both shots, and neither
      // keeps the warning that it was set by hand and is kept
      expect(doc.getObject(cam)!.parent, what).toBeNull();
      expect(r.solved, what).toEqual(cut);
      expect(cameraWarnings(doc, cam, r.warnings), what).toEqual([
        "Shot 2: its camera hung from 'Red kite' (built anew as 'Red balloon'), which moves during the shot; the update took it off 'Red balloon' and solved it again, also for Shot 1, which uses the same camera",
      ]);
      expect(r.warnings.join('\n'), what).not.toMatch(/set by hand/);
      // one undo step puts the hang back as it was
      undo.undo();
      expect(doc.getObject(cam), what).toEqual(hung.cam);
      expect(doc.listFCurves(cam), what).toEqual(hung.keys);
      expect(getShots(doc), what).toEqual(hung.shots);
    }
  });

  it("still as staged on a rig scaled unevenly, is taken off for the shot the update solves and solved again for every other shot that uses it, the brief's or the desk's own", () => {
    const doc = stagedDoc();
    const cam = firstShot(doc).camera!;
    const second = shotOf(doc, 'sht_0123456789bbbb');
    // the second shot, and two cutaways of the desk's own after it, shoot with the first shot's camera
    const cutaway: ShotData = {
      ...second,
      id: newShotId(),
      name: 'Cutaway',
      camera: cam,
      frame_start: second.frame_end + 1,
      frame_end: second.frame_end + 24,
      notes: '',
      layout: [],
      external: null,
    };
    const cutaway2: ShotData = {
      ...cutaway,
      id: newShotId(),
      name: 'Cutaway 2',
      frame_start: cutaway.frame_end + 1,
      frame_end: cutaway.frame_end + 24,
    };
    setShots(doc, [
      ...getShots(doc).map((s) => (s.id === second.id ? { ...s, camera: cam } : s)),
      cutaway,
      cutaway2,
    ]);
    doc.updateScene({ frame_end: cutaway2.frame_end });
    // hung from a dolly of the person's at the scene's root, recorded as staged there, as a rideo
    // re-import leaves a camera it placed in its parent's space
    let dolly = '';
    doc.transact(() => {
      dolly = doc.addObject({
        type: 'EMPTY',
        name: 'Dolly',
        parent: null,
        location: [0, -3, 0.5],
        rotation_euler: [0, 0, 0],
        scale: [1, 1.3, 0.8],
      });
    });
    hangCamera(doc, dolly, 'first');
    recordMotionOf(doc, cam);
    const ids = getShots(doc).map((s) => s.id);
    /** The camera's world matrices over each shot that uses it. */
    const paths = (d: SceneDoc) =>
      getShots(d).map((s) => {
        const out: Mat4[] = [];
        for (let f = s.frame_start; f <= s.frame_end; f++) out.push(new FrameState(d, f).world(cam)!);
        return out;
      });
    const hung = {
      cam: doc.getObject(cam),
      keys: doc.listFCurves(cam),
      shots: getShots(doc),
      paths: paths(doc),
    };
    const undo = undoOf(doc);
    // the brief changes the first shot's framing alone: the update solves that shot, off the dolly
    const b = openBrief();
    b.shots[0].framing = 'medium';
    const r = update(doc, b);
    expect(doc.getObject(cam)!.parent).toBeNull();
    expect(doc.getObject(cam)!.scale).toEqual([1, 1, 1]);
    // the report lists the brief's shots it solved; the cutaways are solved too, and named
    expect(r.solved).toEqual(['sht_0123456789aaaa', 'sht_0123456789bbbb']);
    expect(cameraWarnings(doc, cam, r.warnings)).toEqual([
      "Shot 1: its camera hung from 'Dolly', which is scaled unevenly or mirrored; the update took it off 'Dolly' and solved it again, also for Shot 2, Cutaway and Cutaway 2, which use the same camera",
    ]);
    // each shot is where a solve puts it: solving them all again moves none of them
    const solved = paths(doc);
    const again = SceneDoc.fromUpdate(doc.encodeState());
    solveShotCameras(docContext(again), ids, { enforce_line: false, fit_plan: true, keep_lens: false });
    paths(again).forEach((p, i) => expect(largestGap(p, solved[i]), ids[i]).toBeLessThan(1e-9));
    // one undo step puts the hang back as it was
    undo.undo();
    expect(doc.getObject(cam)).toEqual(hung.cam);
    expect(doc.listFCurves(cam)).toEqual(hung.keys);
    expect(getShots(doc)).toEqual(hung.shots);
    paths(doc).forEach((p, i) => expect(largestGap(p, hung.paths[i]), ids[i]).toBe(0));
  });
});

describe('a shot camera the person hung that a later brief does not solve', () => {
  it('keeps its hang and its path when what it hangs from is restyled, renamed, unpinned or flown again, or moves alike', () => {
    // the kite as a library unit, for a staging that pins it and an update that unpins it
    const src = stagedDoc();
    const unit = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id, name: 'Red kite' });
    src.destroy();
    const kite = lib('lib_0123456789kite', 1, unit.ex.data);
    const units = () => unitSourceOf([kite.given]);
    const brief = (edit: (b: SceneBrief, kite: SceneBrief['elements'][number]) => void = () => {}) => {
      const b = openBrief();
      const k = b.elements.find((e) => e.id === KITE)!;
      edit(b, k);
      return b;
    };
    const onKite = (doc: SceneDoc) => propOf(doc, KITE).id;
    const cases: {
      what: string;
      doc: () => SceneDoc;
      hangFrom: (doc: SceneDoc) => string;
      next: SceneBrief;
      units?: UnitSource;
    }[] = [
      {
        what: 'the kite restyled',
        doc: () => stagedDoc(),
        hangFrom: onKite,
        next: brief((_, k) => (k.description = 'A blue diamond kite with a long tail.')),
      },
      {
        what: 'the kite renamed, its shot longer',
        doc: () => stagedDoc(),
        hangFrom: onKite,
        next: brief((b, k) => {
          k.name = 'Big kite';
          b.shots[0].durationSec += 1;
        }),
      },
      {
        what: 'the kite unpinned to the words',
        doc: () => {
          const d = SceneDoc.create({ empty: true });
          const pinned = brief((_, k) => (k.unit = kite.pin));
          stageBrief(d, pinned, { units: units() });
          return d;
        },
        hangFrom: onKite,
        next: brief(),
        units: units(),
      },
      {
        what: 'the kite flown again for a longer shot',
        doc: () => stagedDoc(),
        hangFrom: onKite,
        next: brief((b) => (b.shots[0].durationSec += 1)),
      },
      {
        what: "a rig of the person's, keyed, under a held ball built anew and held alike",
        doc: () => stagedDoc(heldBall(openBrief(), 'Red ball', 'A small red rubber ball.')),
        hangFrom: (d) => {
          // an empty half a metre above the ball, keyed to slide 2 m aside as Mira carries it
          let rig = '';
          d.transact(() => {
            rig = d.addObject({
              type: 'EMPTY',
              name: 'Rig',
              parent: propOf(d, KITE).id,
              location: [0, 0, 0.5],
              rotation_euler: [0, 0, 0],
              scale: [1, 1, 1],
            });
          });
          keyed(d, rig, 'location', 0, [0, 1, 2]);
          return rig;
        },
        next: heldBall(openBrief(), 'Blue ball', 'A small blue rubber ball.'),
      },
    ];
    for (const c of cases) {
      const doc = c.doc();
      const from = c.hangFrom(doc);
      const cam = hangCamera(doc, from, 'first');
      const before = firstShotCamera(doc);
      const r = update(doc, c.next, c.units);
      // on what the person hung it from, or (the kite unpinned) on the prop built in its place
      expect(doc.getObject(cam)!.parent, c.what).toBe(doc.getObject(from) ? from : onKite(doc));
      // over the frames the shot had: where it is, frame by frame, is where it was
      expect(largestGap(before, firstShotCamera(doc)), c.what).toBeLessThan(1e-9);
      expect(r.solved, c.what).toEqual([]);
      expect(cameraWarnings(doc, cam, r.warnings), c.what).toEqual([]);
    }
  });

  it("stays on a rig of the person's scaled unevenly or mirrored, under a prop built anew that stands still, unsolved", () => {
    // the kite in flight described anew as a balloon no one holds, which stands where the kite was at
    // rest: what hangs from the kite moves otherwise in the shot, but the update solves the camera only
    // off a piece that now moves, not off one that only turns it unevenly
    const rigs: { what: string; rotation: Vec3; scale: Vec3 }[] = [
      { what: 'scaled unevenly', rotation: [0.3, 0.2, 0.1], scale: [1, 1.3, 0.8] },
      { what: 'mirrored', rotation: [0, 0, 0], scale: [-1, 1, 1] },
    ];
    for (const { what, rotation, scale } of rigs) {
      const doc = stagedDoc();
      let rig = '';
      doc.transact(() => {
        rig = doc.addObject({
          type: 'EMPTY',
          name: 'Rig',
          parent: propOf(doc, KITE).id,
          location: [0, 0, 0],
          rotation_euler: rotation,
          scale,
        });
      });
      const cam = hangCamera(doc, rig, 'rest');
      const atRest = restWorld(doc, cam);
      const r = update(doc, retyped(openBrief()));
      // on the rig, which stays on the balloon where it was at rest, and the camera with it
      expect(doc.getObject(rig)!.parent, what).toBe(propOf(doc, KITE).id);
      expect(doc.getObject(cam)!.parent, what).toBe(rig);
      sameWorld(restWorld(doc, cam), atRest);
      expect(r.solved, what).toEqual([]);
      expect(cameraWarnings(doc, cam, r.warnings), what).toEqual([]);
    }
  });
});

describe('a shot camera the person keyed by hand', () => {
  it('is kept with its keys and warned of each change that would have solved it, in order: its cast and the set, or its frame size and the set', () => {
    // the meadow as a library set, which an update places in the words' set's stead
    const src = stagedDoc();
    const meadow = lib('lib_0123456789mead', 1, unitFrom(src, { kind: 'set', name: 'Meadow' }).ex.data);
    src.destroy();
    const kept = (what: string) =>
      `Shot 1: its camera was set by hand in the desk and is kept; ${what} changed, so check its framing (solve it again with desk.shot_solve)`;
    const changes: { what: string; change: (b: SceneBrief) => void; warnings: string[] }[] = [
      {
        what: 'the cast and the set',
        change: (b) => {
          b.shots[0].castIds = [MIRA];
          b.shots[0].layout = b.shots[0].layout.filter((l) => l.castId === MIRA);
          b.set.unit = meadow.pin;
        },
        warnings: [kept('its cast'), kept('the set')],
      },
      {
        what: 'the frame size and the set',
        change: (b) => {
          b.width = 1920;
          b.height = 1080;
          b.set.unit = meadow.pin;
        },
        warnings: [kept('its frame size'), kept('the set')],
      },
    ];
    for (const { what, change, warnings } of changes) {
      const doc = stagedDoc();
      const cam = firstShot(doc).camera!;
      // the person keys the camera half a metre aside ten frames into the shot
      const f = firstShot(doc).frame_start + 10;
      keyMore(doc, cam, 'location', 0, [[f, new FrameState(doc, f).local(cam)[12] + 0.5]]);
      const keys = JSON.stringify(doc.listFCurves(cam));
      const next = openBrief();
      change(next);
      const r = update(doc, next, unitSourceOf([meadow.given]));
      // the second shot's camera, still as staged, is solved again; the first one's stays the person's
      expect(r.solved, what).toEqual(['sht_0123456789bbbb']);
      expect(JSON.stringify(doc.listFCurves(cam)), what).toBe(keys);
      expect(
        r.warnings.filter((w) => w.includes('set by hand')),
        what,
      ).toEqual(warnings);
    }
  });
});

describe('a shot camera the person hung from a prop and keyed by hand', () => {
  it('is never taken off or solved: kept with its keys on the prop built anew, and the warning says to check its framing', () => {
    const { doc, cam } = cameraOnKite('first');
    // the person keys the camera half a metre aside ten frames into the shot
    const f = firstShot(doc).frame_start + 10;
    keyMore(doc, cam, 'location', 0, [[f, new FrameState(doc, f).local(cam)[12] + 0.5]]);
    const keys = JSON.stringify(doc.listFCurves(cam));
    const r = update(doc, retyped(openBrief(), { balloonWords: true }));
    // the balloon flies in the shot otherwise than the kite did
    expect(prop(propOf(doc, KITE), 'desk_tether_flights')).toBeTruthy();
    expect(doc.getObject(cam)!.parent).toBe(propOf(doc, KITE).id);
    expect(JSON.stringify(doc.listFCurves(cam))).toBe(keys);
    expect(r.solved).toEqual([]);
    expect(cameraWarnings(doc, cam, r.warnings)).toEqual([
      "Shot 1: its camera was set by hand in the desk and is kept; what it hangs from, 'Red kite' (built anew as 'Red balloon'), no longer moves as it did, so check its framing (solve it again with desk.shot_solve)",
    ]);
  });

  it('is kept with its keys when the prop is restyled in place or renamed, and the warning says it was staged anew', () => {
    const cases: { what: string; next: SceneBrief; warning: string }[] = [
      {
        what: 'the kite restyled',
        next: (() => {
          const b = openBrief();
          b.elements.find((e) => e.id === KITE)!.description = 'A blue diamond kite with a long tail.';
          return b;
        })(),
        warning:
          "Shot 1: its camera was set by hand in the desk and is kept; what it hangs from, 'Red kite', was staged anew, so check its framing (solve it again with desk.shot_solve)",
      },
      {
        what: 'the kite renamed',
        next: (() => {
          const b = openBrief();
          b.elements.find((e) => e.id === KITE)!.name = 'Big kite';
          return b;
        })(),
        warning:
          "Shot 1: its camera was set by hand in the desk and is kept; what it hangs from, 'Red kite' (built anew as 'Big kite'), was staged anew, so check its framing (solve it again with desk.shot_solve)",
      },
    ];
    for (const { what, next, warning } of cases) {
      const { doc, cam } = cameraOnKite('first');
      const f = firstShot(doc).frame_start + 10;
      keyMore(doc, cam, 'location', 0, [[f, new FrameState(doc, f).local(cam)[12] + 0.5]]);
      const keys = JSON.stringify(doc.listFCurves(cam));
      const before = firstShotCamera(doc);
      const r = update(doc, next);
      // the kite staged again flies as it did, and the camera with it where it was
      expect(doc.getObject(cam)!.parent, what).toBe(propOf(doc, KITE).id);
      expect(JSON.stringify(doc.listFCurves(cam)), what).toBe(keys);
      expect(largestGap(before, firstShotCamera(doc)), what).toBeLessThan(1e-9);
      expect(r.solved, what).toEqual([]);
      expect(cameraWarnings(doc, cam, r.warnings), what).toEqual([warning]);
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
