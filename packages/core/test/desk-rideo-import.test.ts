import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ShotData } from '../src/doc/types';
import type { Vec3 } from '../src/math/types';
import { FrameState } from '../src/eval/frame-state';
import { createOperatorRegistry } from '../src/operators';
import { DESK_PROPS } from '../src/desk/props';
import { getDeskSettings, getShots, newShotId, setDeskSettings, setShots } from '../src/desk/shots';
import { isWater } from '../src/desk/layout';
import { defaultActorHeight } from '../src/desk/characters';
import { defaultRigidBody } from '../src/doc/defaults';
import { RIDEO_HIDDEN_SCALE, RIDEO_PROPS, type RideoImportResult } from '../src/desk/rideo';
import { docParts, footprint } from '../src/desk/rideo/footprint';
import {
  CUP,
  DIALOGUE_SHOTS,
  KITE,
  KITE_SHOTS,
  LEO,
  MAYA,
  MUM,
  PEPPER,
  RIDING_SHOTS,
  ROSIE,
  SAM,
  TABLE,
  angleDiff,
  dialogueClip,
  ed,
  facingAt,
  importClip,
  kiteClip,
  originAt,
  rideoContext,
  ridingClip,
  scaleAt,
  type ImportInput,
} from './desk-rideo-fixtures';

/*
 * desk.import_rideo_blocking (spec §11 "Import semantics") on three rideo clips: a dialogue in shot /
 * reverse shot, a girl riding her pony, a boy flying a kite. Positions are checked in rideo's
 * coordinates through ed() (rideo (x, y, z) → editor (x, −z, y)).
 */

const near = (a: readonly number[], b: readonly number[], tol: number, what = '') => {
  const d = Math.hypot(...a.map((v, i) => v - b[i]));
  expect(
    d,
    `${what}: |${a.map((v) => v.toFixed(3))} − ${b.map((v) => v.toFixed(3))}| = ${d.toFixed(4)}`,
  ).toBeLessThanOrEqual(tol);
};
const flat = (v: readonly number[]): Vec3 => [v[0], v[1], 0];
const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** A camera's world position and view direction (its −Z axis) at a frame. */
function view(doc: SceneDoc, camera: string, frame: number) {
  const m = new FrameState(doc, frame).world(camera)!;
  return { position: [m[12], m[13], m[14]] as Vec3, forward: unit([-m[8], -m[9], -m[10]]) };
}

/** Expects a camera to stand at rideo `pos` looking at rideo `target` at `frame`. */
function expectCamera(
  doc: SceneDoc,
  camera: string,
  frame: number,
  pos: number[],
  target: number[],
  what: string,
) {
  const v = view(doc, camera, frame);
  const p = ed(pos[0], pos[1], pos[2]);
  near(v.position, p, 1e-3, `${what} position`);
  near(v.forward, unit(sub(ed(target[0], target[1], target[2]), p)), 1e-3, `${what} direction`);
}

const actorOf = (r: RideoImportResult, characterId: string) =>
  r.actors.find((a) => a.character_id === characterId)!.id;
const shotOf = (r: RideoImportResult, rideoShot: string) => r.shots.find((s) => s.rideo_shot === rideoShot)!;
const prop = (doc: SceneDoc, id: string, key: string) => doc.getObject(id)?.custom_props?.[key];

/**
 * Expects each shot to show its own cast and hide the clip's other actors (rideo draws a shot with
 * its characters only and wants the others out of its frame) at its first, middle and last frame.
 */
function expectOwnCastOnly(doc: SceneDoc, r: RideoImportResult, clip: ImportInput) {
  const cast = new Map(clip.shots!.map((s) => [s.id, new Set(s.characterIds ?? [])]));
  let hidden = 0;
  for (const s of r.shots) {
    const mid = Math.round((s.frame_start + s.frame_end) / 2);
    for (const a of r.actors)
      for (const f of [s.frame_start, mid, s.frame_end]) {
        const scale = scaleAt(doc, a.id, f);
        if (cast.get(s.rideo_shot)!.has(a.character_id))
          expect(Math.min(...scale), `${a.name} shown in ${s.name} at ${f}`).toBeGreaterThan(0.5);
        else {
          expect(Math.max(...scale), `${a.name} hidden in ${s.name} at ${f}`).toBe(RIDEO_HIDDEN_SCALE);
          hidden++;
        }
      }
  }
  return hidden;
}

describe('rideo import: a dialogue in shot / reverse shot', () => {
  let doc: SceneDoc;
  let r: RideoImportResult;
  let maya: string;
  let leo: string;
  beforeAll(() => {
    doc = SceneDoc.create({ empty: true });
    const clip = dialogueClip();
    // rideo's order is its index, not the order the shots come in
    clip.shots = [...clip.shots!].reverse();
    r = importClip(doc, clip);
    maya = actorOf(r, MAYA);
    leo = actorOf(r, LEO);
  });

  it("takes rideo's project settings and the video model's limits", () => {
    expect(doc.getScene().fps).toBe(24);
    expect(doc.getRender()).toMatchObject({
      resolution_x: 1920,
      resolution_y: 1080,
      resolution_percentage: 100,
    });
    const desk = getDeskSettings(doc);
    expect(desk.aspect).toBeCloseTo(16 / 9, 6);
    expect(desk).toMatchObject({ min_shot_s: 2, max_shot_s: 10 });
    expect(r.state).toBe('ready');
  });

  it('lays the shots out in rideo order, round(duration × fps) frames, a pre-roll before cuts where marks jump', () => {
    expect(r.shots.map((s) => s.rideo_shot)).toEqual([...DIALOGUE_SHOTS]);
    expect(r.shots.map((s) => [s.frame_start, s.frame_end, s.pre_roll])).toEqual([
      [1, 72, 0],
      [73, 132, 0],
      [133, 192, 0],
      [193, 264, 0],
      // Leo turns from Maya to the wall (130°), Maya stands by the door: their marks jump
      [277, 372, 12],
      [385, 456, 12],
    ]);
    expect(r.frames).toEqual({ start: 1, end: 456 });
    expect(doc.getScene().frame_end).toBe(456);
    const stored = getShots(doc);
    expect(stored.map((s) => s.name)).toEqual(['Shot 1', 'Shot 2', 'Shot 3', 'Shot 4', 'Shot 5', 'Shot 6']);
    for (const [i, s] of stored.entries())
      expect(s.external).toEqual({
        source: 'rideo',
        project: 'prj_cafe00000001',
        clip: 'clp_cafe00000001',
        shot: DIALOGUE_SHOTS[i],
        index: i,
      });
    expect(stored[0]).toMatchObject({
      framing: 'wide',
      angle: 'front',
      height: 'eye',
      lens_mm: 32,
      subjects: [maya, leo],
      layout: [
        { subject: maya, side: 'left', facing: 'right' },
        { subject: leo, side: 'right', facing: 'left' },
      ],
    });
    expect(stored[1]).toMatchObject({
      framing: 'over_shoulder',
      angle: 'over_shoulder',
      subjects: [leo, maya],
    });
    expect(stored[0].notes).toContain('bistro table');
  });

  it('makes people of the cast, with their character ids, heights and colours', () => {
    expect(r.actors.map((a) => [a.name, a.kind, a.created])).toEqual([
      ['Maya', 'child', true],
      ['Leo', 'elder', true],
    ]);
    expect(prop(doc, maya, DESK_PROPS.characterId)).toBe(MAYA);
    expect(prop(doc, maya, DESK_PROPS.heightM)).toBeCloseTo(1.4, 6);
    expect(prop(doc, leo, DESK_PROPS.heightM)).toBeCloseTo(1.78, 6);
    expect(prop(doc, maya, RIDEO_PROPS.id)).toBe('a1');
    expect(prop(doc, leo, DESK_PROPS.color)).toBe('#3d8bff');
    expect(prop(doc, leo, RIDEO_PROPS.clip)).toBe('clp_cafe00000001');
  });

  it('keys everyone on their mark at each shot start, facing as marked (CONSTANT)', () => {
    near(originAt(doc, maya, 1), ed(-0.9, 0, 0), 1e-4, 'Maya at the opening');
    near(originAt(doc, leo, 1), ed(0.9, 0, 0), 1e-4, 'Leo at the opening');
    expect(angleDiff(facingAt(doc, maya, 1), 90)).toBeLessThan(0.1);
    expect(angleDiff(facingAt(doc, leo, 1), 270)).toBeLessThan(0.1);
    // Maya holds her mark up to the cut, then stands by the door from the pre-roll on
    near(originAt(doc, maya, 372), ed(-0.9, 0, 0), 1e-4, 'Maya before the cut');
    near(originAt(doc, maya, 373), ed(-2.2, 0, 1), 1e-4, 'Maya in the pre-roll');
    near(originAt(doc, maya, 385), ed(-2.2, 0, 1), 1e-4, 'Maya at shot 6');
    expect(angleDiff(facingAt(doc, maya, 385), 45)).toBeLessThan(0.1);
  });

  it('walks a mark with toX/toZ over its shot, and nothing walks into the next shot', () => {
    near(originAt(doc, leo, 277), ed(0.9, 0, 0), 1e-3, 'Leo at the start of his walk');
    expect(angleDiff(facingAt(doc, leo, 277), 140)).toBeLessThan(1);
    near(flat(originAt(doc, leo, 372)), ed(2.8, 0, -2.2), 0.25, 'Leo at the wall');
    // he walks toward the wall (rideo facing of the way from his mark to it: 139°)
    expect(angleDiff(facingAt(doc, leo, 325), 139)).toBeLessThan(25);
    // shot 6 has no mark of his: rideo's markFor puts him on his opening mark, and he stays there
    near(originAt(doc, leo, 385), ed(0.9, 0, 0), 1e-4, 'Leo at shot 6');
    near(originAt(doc, leo, 456), ed(0.9, 0, 0), 1e-4, 'Leo at the end');
  });

  it("imports rideo's cameras as they are (position, aim, lens on a 36 mm sensor)", () => {
    const blocking = dialogueClip().blocking as { shots: Record<string, { camera: Record<string, number> }> };
    for (const [i, id] of DIALOGUE_SHOTS.entries()) {
      const s = shotOf(r, id);
      const c = blocking.shots[id].camera;
      expect(s.camera_from, id).toBe('blocking');
      expectCamera(
        doc,
        s.camera,
        s.frame_start,
        [c.x, c.y, c.z],
        [c.targetX, c.targetY, c.targetZ],
        `shot ${i + 1}`,
      );
      const cam = doc.getCamera(doc.getObject(s.camera)!.data!)!;
      expect(cam).toMatchObject({ lens: c.lensMm, sensor_fit: 'HORIZONTAL', sensor_width: 36 });
    }
    // one camera per shot
    expect(new Set(r.shots.map((s) => s.camera)).size).toBe(6);
  });

  it("keys each shot's move: rideo's camera.move, its blocked end, else its planned movement", () => {
    expect(r.shots.map((s) => s.move)).toEqual([
      'locked_off',
      'locked_off',
      'locked_off',
      'push_in',
      'pan_right',
      'locked_off',
    ]);
    // the push in ends where rideo blocked its end
    const push = shotOf(r, DIALOGUE_SHOTS[3]);
    expectCamera(doc, push.camera, push.frame_end, [0.6, 1.25, 1.0], [-0.9, 1.2, 0], 'push_in end');
    // a pan rideo's text gives no direction: the way its blocked end turns, ending where it is blocked
    const pan = shotOf(r, DIALOGUE_SHOTS[4]);
    expectCamera(doc, pan.camera, pan.frame_end, [0, 1.5, 5.5], [2.5, 1.1, -2], 'pan end');
    // locked off: the last frame is the first
    const locked = shotOf(r, DIALOGUE_SHOTS[1]);
    near(
      view(doc, locked.camera, locked.frame_end).forward,
      view(doc, locked.camera, locked.frame_start).forward,
      1e-9,
    );
  });

  it("holds the teacup in Leo's hand in his shots and hides it in the others", () => {
    expect(r.holds).toEqual([
      { actor: 'Leo', prop: 'teacup', shots: ['Shot 1', 'Shot 2', 'Shot 3', 'Shot 5'] },
    ]);
    const cup = r.props[0].id;
    expect(r.props[0]).toMatchObject({
      model: 'cup',
      held_by: LEO,
      flies: null,
      rideo_id: 'p1',
      element_id: CUP,
    });
    const base = doc.getObject(cup)!.scale;
    for (const f of [10, 100, 150, 300]) near(scaleAt(doc, cup, f), base, 1e-9, `cup shown at ${f}`);
    // hidden: shrunk to RIDEO_HIDDEN_SCALE of the scale it is shown at
    for (const f of [200, 264, 400])
      expect(scaleAt(doc, cup, f)[0], `cup hidden at ${f}`).toBe(base[0] * RIDEO_HIDDEN_SCALE);
    const hand = new FrameState(doc, 40).boneMatrix(leo, 'hand.R')!.matrix;
    near(originAt(doc, cup, 40), [hand[12], hand[13], hand[14]], 0.25, 'cup in the hand');
  });

  it('builds the set, its landmarks and props from built-in models, keeping rideo ids', () => {
    const ground = doc.listObjects().find((o) => o.custom_props?.[RIDEO_PROPS.ground]);
    expect(ground?.custom_props?.[RIDEO_PROPS.ground]).toBe('stone paving');
    expect(r.landmarks.map((l) => [l.name, l.shape, l.model, l.rideo_id, l.element_id])).toEqual([
      ['bistro table', 'cylinder', 'round_table', 'l1', TABLE],
      ['brick wall', 'wall', 'brick_wall', 'l2', null],
    ]);
    const table = r.landmarks[0].id;
    expect(prop(doc, table, DESK_PROPS.role)).toBe('landmark');
    expect(prop(doc, table, DESK_PROPS.elementId)).toBe(TABLE);
    expect(prop(doc, r.props[0].id, DESK_PROPS.label)).toBe('teacup');
  });

  it('hides Leo in the shots he is not cast in, on his mark all the same', () => {
    // shots 4 and 6 are Maya's alone
    expect(expectOwnCastOnly(doc, r, dialogueClip())).toBe(6);
    const shot4 = r.shots[3];
    near(flat(originAt(doc, leo, shot4.frame_start)), flat(originAt(doc, leo, r.shots[2].frame_end)), 1e-6);
  });

  it('reports the boards rideo drew before this staging', () => {
    expect(r.boards).toEqual([{ shot: 'Shot 1', rideo_shot: DIALOGUE_SHOTS[0], state: 'approved' }]);
    expect(r.warnings.join('\n')).toMatch(/1 shot board\(s\) were drawn before this staging \(Shot 1\)/);
    expect(r.issues).toEqual([]);
  });
});

describe('rideo import: a girl riding her pony', () => {
  let doc: SceneDoc;
  let r: RideoImportResult;
  let rosie: string;
  let pepper: string;
  beforeAll(() => {
    doc = SceneDoc.create({ empty: true });
    r = importClip(doc, ridingClip());
    rosie = actorOf(r, ROSIE);
    pepper = actorOf(r, PEPPER);
  });

  it('makes a pony of the pony and a child of the girl', () => {
    expect(r.actors.map((a) => [a.name, a.kind, a.reason])).toEqual([
      ['Rosie', 'child', 'a person'],
      ['Pepper', 'pony', 'a pony another character rides'],
    ]);
    // rideo's default 1.7 m is a person's: the pony is the pony's height
    expect(prop(doc, pepper, DESK_PROPS.heightM)).toBeCloseTo(defaultActorHeight('pony'), 6);
  });

  it('seats the rider on her mount over the shot she rides it in, with a pre-roll to get on and off', () => {
    expect(r.mounts).toEqual([{ rider: 'Rosie', mount: 'Pepper', shots: ['Shot 2'] }]);
    expect(r.shots.map((s) => [s.frame_start, s.frame_end, s.pre_roll])).toEqual([
      [1, 72, 0],
      [85, 180, 12],
      [193, 264, 12],
    ]);
    // shot 1: she walks up to him
    near(originAt(doc, rosie, 1), ed(-1.2, 0, 1), 1e-4, 'Rosie at the opening');
    near(flat(originAt(doc, rosie, 72)), ed(-0.2, 0, 1), 0.2, 'Rosie by Pepper');
    // shot 2: in the saddle, carried along the fence
    for (const f of [85, 130, 180]) {
      const seat = originAt(doc, rosie, f);
      const steed = originAt(doc, pepper, f);
      near(flat(seat), flat(steed), 0.45, `Rosie on Pepper at ${f}`);
      expect(seat[2], `Rosie off the ground at ${f}`).toBeGreaterThan(0.3);
    }
    near(originAt(doc, pepper, 85), ed(-3, 0, -2.5), 1e-3, 'Pepper at the start of the ride');
    near(flat(originAt(doc, pepper, 180)), ed(2.5, 0, -2.5), 0.3, 'Pepper at the end of the ride');
    // shot 3: down again, on her own mark
    near(originAt(doc, rosie, 193), ed(3.4, 0, -0.7), 1e-3, 'Rosie by the trough');
    expect(angleDiff(facingAt(doc, rosie, 193), 180)).toBeLessThan(0.5);
    near(originAt(doc, pepper, 193), ed(3.4, 0, -1.6), 1e-3, 'Pepper by the trough');
  });

  it("keys a blocked end that agrees with the shot's move as it is (a dolly along the fence)", () => {
    const ride = shotOf(r, RIDING_SHOTS[1]);
    expect(ride.move).toBe('dolly_right');
    expectCamera(doc, ride.camera, ride.frame_start, [-5.5, 1.5, 1.5], [-3, 1, -2.5], 'dolly start');
    expectCamera(doc, ride.camera, ride.frame_end, [0, 1.5, 1.5], [2.5, 1, -2.5], 'dolly end');
  });

  it('builds the paddock: a fence and a trough from built-in models, a pond cameras may stand in', () => {
    expect(r.landmarks.map((l) => [l.name, l.shape, l.model])).toEqual([
      ['paddock fence', 'wall', 'rail_fence'],
      ['water trough', 'box', 'water_trough'],
      ['pond', 'water', null],
    ]);
    const pond = doc.getObject(r.landmarks[2].id)!;
    expect(isWater(pond)).toBe(true);
    expect(pond.custom_props?.[DESK_PROPS.heightM]).toBe(0.05);
    expect(pond.scale).toEqual([3, 2, 1]);
  });

  it("follows the cast overrides, and keeps a continuous shot's frames contiguous", () => {
    const d = SceneDoc.create({ empty: true });
    const clip = ridingClip();
    clip.castOverrides = { [PEPPER]: 'horse' };
    clip.shots![1].continuity = 'continuous';
    const r2 = importClip(d, clip);
    expect(r2.actors.find((a) => a.character_id === PEPPER)).toMatchObject({
      kind: 'horse',
      reason: 'cast override',
    });
    expect(r2.shots[1]).toMatchObject({ frame_start: 73, pre_roll: 0 });
    expect(r2.warnings).toContain('shot 2 continues shot 1, but marks jump between them');
  });

  it('seats nobody on a pony that only trots up to her: an animal’s gait is no rider', () => {
    const d = SceneDoc.create({ empty: true });
    const clip = ridingClip();
    clip.shots![0].description = 'Pepper trots over to Rosie, who holds out an apple.';
    const r2 = importClip(d, clip);
    expect(r2.mounts).toEqual([{ rider: 'Rosie', mount: 'Pepper', shots: ['Shot 2'] }]);
    const girl = actorOf(r2, ROSIE);
    for (const f of [1, 37, 72])
      expect(originAt(d, girl, f)[2], `Rosie on the ground at ${f}`).toBeLessThan(0.05);
    expect(r2.warnings.filter((w) => w.includes('seated on'))).toEqual([]);
  });

  it('seats a person by their marks only with a warning, and never one the words busy with the mount', () => {
    const quiet = ridingClip();
    quiet.shots![1].description = 'Rosie and Pepper go along the fence at a gentle walk.';
    const d1 = SceneDoc.create({ empty: true });
    const r1 = importClip(d1, quiet);
    expect(r1.mounts).toEqual([{ rider: 'Rosie', mount: 'Pepper', shots: ['Shot 2'] }]);
    expect(r1.warnings).toContain(
      "shot 2: Rosie is seated on Pepper because their marks are 0.35 m apart, though the shot's words do not say who rides (say it, as in 'Rosie rides Pepper', or set their marks apart)",
    );
    const busy = ridingClip();
    busy.shots![1].description = 'Rosie leads Pepper along the fence at a gentle walk.';
    const d2 = SceneDoc.create({ empty: true });
    const r2 = importClip(d2, busy);
    expect(r2.mounts).toEqual([]);
    expect(r2.warnings.filter((w) => w.includes('seated on'))).toEqual([]);
    expect(originAt(d2, actorOf(r2, ROSIE), 130)[2]).toBeLessThan(0.05);
  });

  it('makes a person of an animal that rides: a bear cub on her pony', () => {
    const d = SceneDoc.create({ empty: true });
    const clip = ridingClip();
    clip.characters![0] = { ...clip.characters![0], summary: 'A playful bear cub.' };
    const r2 = importClip(d, clip);
    expect(r2.actors.map((a) => [a.name, a.kind, a.reason])).toEqual([
      ['Rosie', 'child', 'a bear that rides: a person'],
      ['Pepper', 'pony', 'a pony another character rides'],
    ]);
    expect(r2.mounts).toEqual([{ rider: 'Rosie', mount: 'Pepper', shots: ['Shot 2'] }]);
    expect(originAt(d, actorOf(r2, ROSIE), 130)[2]).toBeGreaterThan(0.3);
  });
});

describe('rideo import: a kite on a windy hill', () => {
  let doc: SceneDoc;
  let r: RideoImportResult;
  let sam: string;
  let kite: string;
  beforeAll(() => {
    doc = SceneDoc.create({ empty: true });
    r = importClip(doc, kiteClip());
    sam = actorOf(r, SAM);
    kite = r.props[0].id;
  });

  it('solves only the shot rideo has not blocked, and says the blocking is incomplete', () => {
    expect(r.shots.map((s) => s.camera_from)).toEqual(['blocking', 'blocking', 'blocking', 'solved']);
    expect(r.warnings[0]).toMatch(/incomplete/);
    const solved = getShots(doc).find((s) => s.external?.shot === KITE_SHOTS[3])!;
    expect(solved.camera).toBeTruthy();
    // Sam, back on his opening mark (rideo's markFor), is not cast in Mum's wide shot: hidden there, as
    // rideo draws it, he no longer stands in its frame (absent_in_frame)
    expect(r.issues.map((i) => i.code)).toEqual([]);
  });

  it("flies the held kite on a string from Sam's hand over his shots, hidden in the others", () => {
    expect(r.props[0]).toMatchObject({
      model: 'diamond_kite',
      held_by: SAM,
      flies: 'kite',
      element_id: KITE,
    });
    expect(r.tethers).toEqual([
      { flyer: 'kite', anchor: 'Sam', frame_start: 1, frame_end: 252, string: 'kite String' },
    ]);
    const string = doc.listObjects().find((o) => o.name === 'kite String')!.id;
    const base = doc.getObject(kite)!.scale;
    // shot 1 and shot 3 (Sam's): flying; shot 2 (Mum's close-up): hidden with its string
    for (const f of [60, 200]) {
      near(scaleAt(doc, kite, f), base, 1e-9, `kite shown at ${f}`);
      expect(scaleAt(doc, string, f)[2], `string shown at ${f}`).toBeGreaterThan(1);
      const hand = new FrameState(doc, f).boneMatrix(sam, 'hand.R')!.matrix;
      const at = originAt(doc, kite, f);
      expect(at[2], `kite up at ${f}`).toBeGreaterThan(1.5);
      expect(Math.hypot(at[0] - hand[12], at[1] - hand[13], at[2] - hand[14])).toBeLessThan(7.2 + 0.6);
    }
    for (const f of [100, 156]) {
      expect(scaleAt(doc, kite, f)[0], `kite hidden at ${f}`).toBe(base[0] * RIDEO_HIDDEN_SCALE);
      expect(scaleAt(doc, string, f)[0], `string hidden at ${f}`).toBeLessThan(1e-6);
    }
    // after Sam's last shot the flight puts it away
    for (const f of [253, 300, 336]) {
      expect(scaleAt(doc, kite, f)[0], `kite put away at ${f}`).toBeLessThan(1e-6);
      expect(scaleAt(doc, string, f)[0], `string put away at ${f}`).toBeLessThan(1e-6);
    }
  });

  it('runs Sam up the hill and tracks him, with a pre-roll where he is back on his mark', () => {
    const run = shotOf(r, KITE_SHOTS[2]);
    expect(run.move).toBe('tracking_follow');
    near(originAt(doc, sam, run.frame_start), ed(0, 0, 0), 1e-3, 'Sam at the start of the run');
    near(flat(originAt(doc, sam, run.frame_end)), ed(0, 0, -6), 0.3, 'Sam up the hill');
    const moved = Math.hypot(
      ...sub(view(doc, run.camera, run.frame_end).position, view(doc, run.camera, run.frame_start).position),
    );
    expect(moved).toBeGreaterThan(3);
    expect(shotOf(r, KITE_SHOTS[3]).pre_roll).toBe(12);
    near(originAt(doc, sam, shotOf(r, KITE_SHOTS[3]).frame_start), ed(0, 0, 0), 1e-4, 'Sam on his mark');
  });

  it('hides Sam in the shots that are Mum’s, and Mum in the one that is Sam’s', () => {
    expect(expectOwnCastOnly(doc, r, kiteClip())).toBe(9);
  });

  it('keeps Mum, who holds nothing, on her mark', () => {
    near(originAt(doc, actorOf(r, MUM), 120), ed(-2.5, 0, 1.5), 1e-4, 'Mum');
  });
});

describe('rideo import: states, re-import and the operator', () => {
  it("places the cast from the shots' planned layouts when rideo has no blocking, and solves every camera", () => {
    const doc = SceneDoc.create({ empty: true });
    const clip = dialogueClip();
    clip.state = 'missing';
    const r = importClip(doc, clip);
    expect(r.shots.map((s) => s.camera_from)).toEqual(Array(6).fill('solved'));
    expect(r.shots.every((s) => s.pre_roll === 0)).toBe(true);
    expect(r.warnings[0]).toMatch(/state 'missing'/);
    near(originAt(doc, actorOf(r, MAYA), 1), ed(-1.2, 0, 0), 1e-4, 'Maya on the left');
    near(originAt(doc, actorOf(r, LEO), 1), ed(1.2, 0, 0), 1e-4, 'Leo on the right');
    expect(angleDiff(facingAt(doc, actorOf(r, MAYA), 1), 90)).toBeLessThan(0.1);
  });

  it("refits a blocked camera that disagrees with its shot's planned layout", () => {
    const doc = SceneDoc.create({ empty: true });
    const clip = dialogueClip();
    clip.shots![0].layout = [
      { characterId: MAYA, side: 'right', facing: 'left' },
      { characterId: LEO, side: 'left', facing: 'right' },
    ];
    const r = importClip(doc, clip);
    expect(r.shots[0]).toMatchObject({ camera_from: 'refit', agrees: true });
    expect(r.warnings).toContain(
      "Shot 1: the blocked camera disagreed with the shot's planned layout; refitted (back)",
    );
    // seen from behind them: Maya (rideo x −0.9) is now on the right of the frame
    const v = view(doc, r.shots[0].camera, 1);
    const right = unit([v.forward[1], -v.forward[0], 0]);
    const side = (p: Vec3) => (p[0] - v.position[0]) * right[0] + (p[1] - v.position[1]) * right[1];
    expect(side(originAt(doc, actorOf(r, MAYA), 1))).toBeGreaterThan(side(originAt(doc, actorOf(r, LEO), 1)));
  });

  it('updates a scene imported from the clip in place, keeping what was added since', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, dialogueClip());
    const extra = doc.addObject({ type: 'EMPTY', name: 'My lamp post' });
    const mine: ShotData = {
      ...getShots(doc)[0],
      id: newShotId(),
      name: 'My shot',
      external: null,
      camera: null,
    };
    setShots(doc, [...getShots(doc), mine]);
    const objects = doc.listObjects().length;
    // rideo dropped shot 3, moved Maya and lengthened shot 1
    const clip = dialogueClip();
    clip.shots = clip.shots!.filter((s) => s.id !== DIALOGUE_SHOTS[2]);
    clip.shots[0].durationSec = 4;
    (clip.blocking as { actors: { x: number }[] }).actors[0].x = -1;
    const second = importClip(doc, clip);
    expect(second.actors.map((a) => [a.id, a.created])).toEqual(first.actors.map((a) => [a.id, false]));
    const kept = first.shots.filter((s) => s.rideo_shot !== DIALOGUE_SHOTS[2]);
    expect(second.shots.map((s) => [s.id, s.camera])).toEqual(kept.map((s) => [s.id, s.camera]));
    expect(second.disabled_shots).toEqual([
      { id: first.shots[2].id, name: 'Shot 3', rideo_shot: DIALOGUE_SHOTS[2] },
    ]);
    expect(second.shots[0]).toMatchObject({ frame_start: 1, frame_end: 96 });
    near(originAt(doc, actorOf(second, MAYA), 1), ed(-1, 0, 0), 1e-4, 'Maya moved');
    // the user's own object and shot are kept; nothing imported twice
    expect(doc.getObject(extra)).toBeTruthy();
    const shots = getShots(doc);
    expect(shots.find((s) => s.id === mine.id)?.enabled).toBe(true);
    expect(shots.find((s) => s.id === first.shots[2].id)?.enabled).toBe(false);
    expect(doc.listObjects().length).toBe(objects);
    expect(doc.listObjects().filter((o) => o.custom_props?.[DESK_PROPS.characterId] === MAYA)).toHaveLength(
      1,
    );
    // update: false imports everything anew
    importClip(doc, { ...dialogueClip(), update: false });
    expect(doc.listObjects().filter((o) => o.custom_props?.[DESK_PROPS.characterId] === MAYA)).toHaveLength(
      2,
    );
  });

  it('keeps the props and landmarks it built while rideo has them the same, with what was added to them', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, dialogueClip());
    const [table, wall] = first.landmarks.map((l) => l.id);
    const cup = first.props[0].id;
    doc.updateObject(table, { rigid_body: defaultRigidBody('PASSIVE') });
    doc.updateObject(cup, { rigid_body: defaultRigidBody('ACTIVE') });
    const objects = doc.listObjects().length;
    // rideo moved the table and lowered the wall
    const clip = dialogueClip();
    const set = (clip.blocking as { set: { landmarks: { x: number; height: number }[] } }).set;
    set.landmarks[0].x = 0.5;
    set.landmarks[1].height = 2.5;
    const second = importClip(doc, clip);
    expect(second.landmarks.map((l) => [l.rideo_id, l.created])).toEqual([
      ['l1', false],
      ['l2', true],
    ]);
    expect(second.landmarks[0].id).toBe(table);
    expect(doc.getObject(wall)).toBeNull();
    expect(doc.getObject(table)!.rigid_body?.type).toBe('PASSIVE');
    const f = footprint(doc, new FrameState(doc, 1), docParts(doc), table)!;
    near([f.x, f.z], [0.5, 0], 1e-6, 'table on its new mark');
    // the cup is the same: kept with its rigid body, held and hidden as before
    expect(second.props.map((p) => [p.id, p.created])).toEqual([[cup, false]]);
    expect(doc.getObject(cup)!.rigid_body?.type).toBe('ACTIVE');
    expect(second.holds).toEqual(first.holds);
    expect(scaleAt(doc, cup, 200)[0]).toBe(doc.getObject(cup)!.scale[0] * RIDEO_HIDDEN_SCALE);
    const leo = actorOf(second, LEO);
    const hand = new FrameState(doc, 40).boneMatrix(leo, 'hand.R')!.matrix;
    near(originAt(doc, cup, 40), [hand[12], hand[13], hand[14]], 0.25, 'cup in the hand');
    expect(doc.listObjects().length).toBe(objects);
  });

  it('flies a kept kite again on a re-import, with one string', () => {
    const doc = SceneDoc.create({ empty: true });
    const first = importClip(doc, kiteClip());
    const kite = first.props[0].id;
    const objects = doc.listObjects().length;
    const before = [60, 100, 200, 300].map((f) => [...originAt(doc, kite, f), ...scaleAt(doc, kite, f)]);
    const second = importClip(doc, kiteClip());
    expect(second.props.map((p) => [p.id, p.created])).toEqual([[kite, false]]);
    expect(second.tethers).toEqual(first.tethers);
    expect(doc.listObjects().length).toBe(objects);
    expect(doc.listObjects().filter((o) => o.name.startsWith('kite String'))).toHaveLength(1);
    [60, 100, 200, 300].forEach((f, i) =>
      near([...originAt(doc, kite, f), ...scaleAt(doc, kite, f)], before[i], 1e-6, `kite at ${f}`),
    );
  });

  it("keeps the desk's duration limits when it is not given the video model's", () => {
    const doc = SceneDoc.create({ empty: true });
    setDeskSettings(doc, { min_shot_s: 3, max_shot_s: 8 });
    importClip(doc, { ...ridingClip(), modelLimits: null });
    expect(getDeskSettings(doc)).toMatchObject({ min_shot_s: 3, max_shot_s: 8 });
    importClip(doc, { ...ridingClip(), modelLimits: { minSeconds: 4, maxSeconds: 10 } });
    expect(getDeskSettings(doc)).toMatchObject({ min_shot_s: 4, max_shot_s: 10 });
  });

  it('refuses a clip it cannot read', () => {
    const doc = SceneDoc.create({ empty: true });
    expect(() => importClip(doc, { ...dialogueClip(), shots: [] })).toThrow(/the clip has no shots/);
    expect(() => importClip(doc, { ...dialogueClip(), blocking: { actors: [{ id: 'a1' }] } })).toThrow(
      /not a SceneBlocking v1/,
    );
    expect(doc.listObjects()).toHaveLength(0);
  });

  it('runs as desk.import_rideo_blocking in one undo step, its warnings reported', () => {
    const doc = SceneDoc.create({ empty: true });
    const reg = createOperatorRegistry();
    const ctx = rideoContext(doc);
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const res = reg.run<RideoImportResult>(ctx, 'desk.import_rideo_blocking', operatorParams(dialogueClip()));
    expect(res.ok, res.error).toBe(true);
    expect(res.result!.shots).toHaveLength(6);
    expect(res.result!.actors.map((a) => a.kind)).toEqual(['child', 'elder']);
    expect(ctx.reports.some((m) => /shot board\(s\)/.test(m))).toBe(true);
    // the notes the operator takes are the shot's description
    expect(getShots(doc)[0].notes).toContain('bistro table');
    undo.undo();
    expect(doc.listObjects()).toHaveLength(0);
    expect(getShots(doc)).toHaveLength(0);
    const bad = reg.run(ctx, 'desk.import_rideo_blocking', {
      ...operatorParams(dialogueClip()),
      shots: [{ id: 's1', index: 0, duration_s: 2, movement: 'swoop' }],
    });
    // an unknown movement is read as static, with a warning
    expect(bad.ok, bad.error).toBe(true);
    expect(ctx.reports.some((m) => m.includes("unknown movement 'swoop' read as 'static'"))).toBe(true);
  });
});

describe('rideo import: long clips', () => {
  /** A clip of `n` shots in which `a` people walk across the set and back, shot after shot. */
  function walkers(n: number, a: number): ImportInput {
    const chars = Array.from({ length: a }, (_, i) => `chr_walker${String(i).padStart(5, '0')}x`);
    const ids = Array.from({ length: n }, (_, i) => `sht_walk${String(i).padStart(6, '0')}xx`);
    const shots: Record<string, unknown> = {};
    ids.forEach((id, s) => {
      const marks: Record<string, unknown> = {};
      chars.forEach((c, i) => {
        const x = i * 2 - a + (s % 2 ? 2 : -2);
        marks[c] = { x, z: 0, facingDeg: s % 2 ? 270 : 90, pose: 'walk', toX: s % 2 ? x - 4 : x + 4, toZ: 0 };
      });
      shots[id] = { marks, camera: { x: 0, y: 1.6, z: 9, targetX: 0, targetY: 1.2, targetZ: 0, lensMm: 28 } };
    });
    return {
      blocking: {
        version: 1,
        source: 'ai',
        updatedAt: '2026-11-13T00:00:00Z',
        set: { width: 16, depth: 10, ground: 'grass', landmarks: [] },
        actors: chars.map((c, i) => ({
          id: `a${i + 1}`,
          characterId: c,
          color: '#ff8a3d',
          heightM: 1.7,
          x: i * 2 - a,
          z: 0,
          facingDeg: 90,
        })),
        props: [],
        shots,
      } as never,
      state: 'ready',
      project: 'prj_walk00000001',
      clip: 'clp_walk00000001',
      settings: { fps: 24, width: 640, height: 360, aspectRatio: '16:9' },
      characters: chars.map((c, i) => ({ id: c, name: `Walker ${i + 1}`, summary: 'A grown-up.' })),
      shots: ids.map((id, i) => ({
        id,
        index: i,
        durationSec: 2,
        description: 'They walk across.',
        camera: { framing: 'wide', movement: 'static' },
        characterIds: chars,
      })),
    };
  }

  /** The keys an import copies in and out of the document's curves (what its time is made of). */
  function keysCopied(input: ImportInput): number {
    const doc = SceneDoc.create({ empty: true });
    let n = 0;
    const get = doc.getFCurve.bind(doc);
    const list = doc.listFCurves.bind(doc);
    const set = doc.setFCurve.bind(doc);
    doc.getFCurve = (key) => {
      const fc = get(key);
      n += fc?.keyframes.length ?? 0;
      return fc;
    };
    doc.listFCurves = (target) => {
      const all = list(target);
      for (const fc of all) n += fc.keyframes.length;
      return all;
    };
    doc.setFCurve = (fc) => {
      n += fc.keyframes.length;
      set(fc);
    };
    doc.transact(() => importClip(doc, input));
    return n;
  }

  it('keys each shot at a cost that does not grow with the shots keyed before it', () => {
    // every key writer copies a channel's whole curve: with the film's keys in the curves, three
    // times the shots cost about nine times the copies (measured 9.5); kept to the keys around each
    // shot, about three times (3.1)
    const short = keysCopied(walkers(4, 2));
    const long = keysCopied(walkers(12, 2));
    expect(long / short).toBeLessThan(4.5);
  });
});

/** The operator's parameters (snake_case) for a clip. */
function operatorParams(clip: ImportInput): Record<string, unknown> {
  return {
    blocking: clip.blocking,
    state: clip.state,
    project: clip.project,
    clip: clip.clip,
    settings: {
      fps: clip.settings!.fps,
      width: clip.settings!.width,
      height: clip.settings!.height,
      aspect_ratio: clip.settings!.aspectRatio,
    },
    model_limits: clip.modelLimits
      ? { min_s: clip.modelLimits.minSeconds, max_s: clip.modelLimits.maxSeconds }
      : undefined,
    characters: clip.characters!.map((c) => ({
      id: c.id,
      name: c.name,
      summary: c.summary,
      identity: c.identity,
      ...(c.heightM ? { height_m: c.heightM } : {}),
    })),
    elements: clip.elements!.map((e) => ({
      id: e.id,
      name: e.name,
      label: e.label ?? undefined,
      kind: e.kind,
    })),
    shots: clip.shots!.map((s) => ({
      id: s.id,
      index: s.index,
      duration_s: s.durationSec,
      framing: s.camera?.framing,
      movement: s.camera?.movement,
      move: s.camera?.move,
      lens_mm: s.camera?.lensMm,
      angle: s.angle,
      character_ids: s.characterIds,
      element_ids: s.elementIds,
      layout: (s.layout ?? []).map((e) => ({ character_id: e.characterId, side: e.side, facing: e.facing })),
      continuity: s.continuity,
      notes: s.description,
      board_state: s.boardState,
    })),
  };
}
