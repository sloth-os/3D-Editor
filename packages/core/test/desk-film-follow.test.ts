import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import { SceneDoc } from '../src/doc/scene-doc';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { DeskScene, projectPoint } from '../src/desk/layout';
import { getShots } from '../src/desk/shots';
import { checkShots } from '../src/desk/checks';
import { solveShotCameras, type SolvedShot } from '../src/operators/desk-shots';
import { deskDoc, deskOperators, ed, prop, standIn } from './desk-fixtures';
import {
  DIALOGUE_SHOTS,
  LEO,
  MAYA,
  dialogueBlocking,
  dialogueClip,
  importClip,
  originAt,
  rideoContext,
} from './desk-rideo-fixtures';

/*
 * Following moves (tracking_follow, steadicam_walk) follow the group of their subjects: its centre on
 * the floor, its heading from its actors (a prop's tumbling turns nothing) and its height from its
 * actors (a bouncing ball lifts nothing), the same in the solver's fit (solver.ts followMap) as in
 * the keyed move (moves.ts applyCameraMove). Scenes in rideo's coordinates.
 */

/** Keys an object's location through rideo points (x, y, z) at frames (linear between them). */
function keyPath(doc: SceneDoc, id: string, keys: [number, number, number, number][]): void {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: i });
    for (const [f, x, y, z] of keys) fc = insertKeyframe(fc, f, ed(x, y, z)[i], 'LINEAR');
    doc.setFCurve(fc);
  }
}

/** Keys one channel of an object's rotation (radians) at frames. */
function keyTurn(doc: SceneDoc, id: string, index: number, keys: [number, number][]): void {
  let fc = createFCurve({ target_type: 'object', target_id: id, path: 'rotation_euler', index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, 'LINEAR');
  doc.setFCurve(fc);
}

/** desk.check's frame for subject_out_of_frame (|x| ≤ 1, −1 ≤ y ≤ 1.15). */
const checked = (q: { x: number; y: number }) =>
  Number.isFinite(q.x) && Math.abs(q.x) <= 1 && q.y >= -1 && q.y <= 1.15;
const deg = (r: number) => (r * 180) / Math.PI;
/** The camera's heading on the floor (degrees, editor X towards editor Y). */
const yaw = (v: { forward: Readonly<Vec3> }) => deg(Math.atan2(v.forward[1], v.forward[0]));
const turn = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/** Where a shot's camera looks over its frames, and whether `ids` stay in desk.check's frame on each. */
function track(doc: SceneDoc, ids: string[], frames: [number, number]) {
  const scene = new DeskScene(doc);
  const cam = getShots(doc)[0].camera!;
  const out: { frame: number; id: string }[] = [];
  const yaws: number[] = [];
  const heights: number[] = [];
  for (let f = frames[0]; f <= frames[1]; f++) {
    const view = scene.camera(cam, f)!;
    yaws.push(yaw(view));
    heights.push(view.position[2]);
    for (const id of ids)
      if (!checked(projectPoint(view, scene.subject(id, f)!.eyes))) out.push({ frame: f, id });
  }
  let maxTurn = 0;
  for (let i = 1; i < yaws.length; i++) maxTurn = Math.max(maxTurn, Math.abs(turn(yaws[i - 1], yaws[i])));
  return { yaws, heights, maxTurn, out };
}

describe('following moves follow the actors of their group', () => {
  it('a steadicam on an actor and a tumbling ball turns no faster than the actor', () => {
    const doc = deskDoc();
    const { run } = deskOperators(doc);
    const ada = standIn(doc, 'Ada', 0, 0, 90);
    keyPath(doc, ada, [
      [1, 0, 0, 0],
      [96, 8, 0, 0],
    ]);
    // the ball rolls ahead of her, spinning about two axes
    const ball = prop(doc, 'Ball', 1, 0, 0.22);
    keyPath(doc, ball, [
      [1, 1, 0.11, 0],
      [96, 9, 0.11, 0],
    ]);
    keyTurn(doc, ball, 0, [
      [1, 0],
      [96, 23],
    ]);
    keyTurn(doc, ball, 2, [
      [1, 0],
      [96, 9],
    ]);
    run('desk.shot_add', {
      subjects: ['Ada', 'Ball'],
      framing: 'medium',
      move: 'steadicam_walk',
      frame_start: 1,
      frame_end: 96,
    });
    const t = track(doc, [ada], [1, 96]);
    // she walks straight: the camera does not turn (it whipped round 158° a frame with the ball's spin)
    expect(t.maxTurn).toBeLessThan(0.5);
    expect(Math.abs(turn(t.yaws[0], t.yaws[95]))).toBeLessThan(0.5);
    expect(t.out).toEqual([]);
  });

  it('a tracking shot keeps the actor in frame on every frame while the ball bounces', () => {
    const doc = deskDoc();
    const { run } = deskOperators(doc);
    const ada = standIn(doc, 'Ada', 0, 0, 90);
    keyPath(doc, ada, [
      [1, 0, 0, 0],
      [96, 8, 0, 0],
    ]);
    // the ball bounces ahead of her, 0.11 m to 2.5 m up
    const ball = prop(doc, 'Ball', 1, 0, 0.22);
    keyPath(
      doc,
      ball,
      Array.from({ length: 9 }, (_, k): [number, number, number, number] => [
        1 + (k * 95) / 8,
        1 + k,
        k % 2 ? 2.5 : 0.11,
        0,
      ]),
    );
    run('desk.shot_add', {
      subjects: ['Ada', 'Ball'],
      framing: 'medium',
      move: 'tracking_follow',
      frame_start: 1,
      frame_end: 96,
    });
    const t = track(doc, [ada], [1, 96]);
    // the camera travels at her height (it rose 1.18 m with the ball and lost her 28 frames of 96)
    expect(Math.max(...t.heights) - Math.min(...t.heights)).toBeLessThan(1e-9);
    expect(t.out).toEqual([]);
  });

  it('a steadicam on two actors turning together turns with them and keeps both (followMap)', () => {
    const doc = deskDoc();
    const { run } = deskOperators(doc);
    // Ada and Ben walk side by side, 1.2 m apart: along +x, a quarter turn round (4, 2), then along +z
    const ada = standIn(doc, 'Ada', 0, 0.6, 90);
    const ben = standIn(doc, 'Ben', 0, -0.6, 90);
    const length = 4 + Math.PI + 4;
    const centre = (f: number): { p: [number, number]; heading: number } => {
      const s = ((f - 1) / 95) * length;
      if (s <= 4) return { p: [s, 0], heading: Math.PI / 2 };
      if (s <= 4 + Math.PI) {
        const a = (s - 4) / 2;
        return { p: [4 + 2 * Math.sin(a), 2 - 2 * Math.cos(a)], heading: Math.PI / 2 - a };
      }
      return { p: [6, 2 + (s - 4 - Math.PI)], heading: 0 };
    };
    for (const [id, side] of [
      [ada, 1],
      [ben, -1],
    ] as const) {
      const keys: [number, number, number, number][] = [];
      const turns: [number, number][] = [];
      for (let f = 1; f <= 96; f += 3) {
        const c = centre(f);
        // beside the centre, across the heading
        keys.push([
          f,
          c.p[0] + side * 0.6 * Math.cos(c.heading),
          0,
          c.p[1] - side * 0.6 * Math.sin(c.heading),
        ]);
        turns.push([f, c.heading]);
      }
      keyPath(doc, id, keys);
      keyTurn(doc, id, 2, turns);
    }
    // a close profile alongside them: one stands behind the other along its view
    const { solve } = run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ada', 'Ben'],
      framing: 'close_up',
      angle: 'profile_left',
      move: 'steadicam_walk',
      frame_start: 1,
      frame_end: 96,
    });
    // the fit sees the pair as the turning camera does, still in line with its view: rideo's camera
    // (seen unturned they would stand side by side, and the fit backed off twice as far)
    expect(solve.out_of_frame).toEqual([]);
    expect(solve.distance_ratio).toBeLessThan(1.05);
    const t = track(doc, [ada, ben], [1, 96]);
    // the keyed heading turns with them (a quarter turn)
    expect(Math.abs(turn(t.yaws[0], t.yaws[95]))).toBeCloseTo(90, 0);
    expect(t.out).toEqual([]);
    expect(checkShots(doc).issues.filter((i) => i.code === 'subject_out_of_frame')).toEqual([]);
  });
});

describe('DeskScene.groupHeading', () => {
  it('is the mean heading of the group’s actors, props left out', () => {
    const doc = deskDoc();
    const ada = standIn(doc, 'Ada', 0, 0, 0);
    const ben = standIn(doc, 'Ben', 1, 0, 90);
    const ball = prop(doc, 'Ball', 0.5, 0.5, 0.22);
    keyTurn(doc, ball, 2, [
      [1, 0],
      [96, 40],
    ]);
    const scene = new DeskScene(doc);
    const span = { frame_start: 1, frame_end: 96 };
    const h = scene.groupHeading([ada, ben, ball], 30, span);
    const fa = scene.facing(ada, 30);
    const fb = scene.facing(ben, 30);
    const mean = [(fa[0] + fb[0]) / 2, (fa[1] + fb[1]) / 2];
    const len = Math.hypot(mean[0], mean[1]);
    expect(h[0]).toBeCloseTo(mean[0] / len, 12);
    expect(h[1]).toBeCloseTo(mean[1] / len, 12);
    // halfway between them (45° from each), whatever the ball does
    expect(Math.abs(turn(deg(Math.atan2(fa[1], fa[0])), deg(Math.atan2(h[1], h[0]))))).toBeCloseTo(45, 9);
    expect(scene.groupHeading([ada, ben, ball], 60, span)).toEqual(scene.groupHeading([ada, ben], 60, span));
    // one actor: its own facing
    expect(scene.groupHeading([ada, ball], 30, span)).toEqual(fa);
  });

  it('without actors is the group’s travel, not the props’ spin', () => {
    const doc = deskDoc();
    const ball = prop(doc, 'Ball', 0, 0, 0.22);
    // it rolls 3 m to the right of the set (editor +x), then 3 m to its back (rideo −z, editor +y),
    // then rests, spinning all the while
    keyPath(doc, ball, [
      [1, 0, 0.11, 0],
      [48, 3, 0.11, 0],
      [96, 3, 0.11, -3],
    ]);
    keyTurn(doc, ball, 2, [
      [1, 0],
      [120, 40],
    ]);
    const scene = new DeskScene(doc);
    const span = { frame_start: 1, frame_end: 120 };
    const heads = (h: Vec3, x: number, y: number) => {
      expect(h[0]).toBeCloseTo(x, 9);
      expect(h[1]).toBeCloseTo(y, 9);
      expect(h[2]).toBeCloseTo(0, 12);
    };
    // where it travels around the frame (HEADING_WINDOW_S before and after it)
    heads(scene.groupHeading([ball], 24, span), 1, 0);
    heads(scene.groupHeading([ball], 72, span), 0, 1);
    // at rest: where it travels over the shot
    heads(scene.groupHeading([ball], 115, span), Math.SQRT1_2, Math.SQRT1_2);
    // a prop that never moves turns nothing (the camera keeps looking along −Y)
    const melon = prop(doc, 'Melon', 1, 1, 0.25);
    heads(new DeskScene(doc).groupHeading([melon], 60, span), 0, -1);
  });

  it('the group centre stands at its actors’ height', () => {
    const doc = deskDoc();
    const ada = standIn(doc, 'Ada', 0, 0, 0);
    const ball = prop(doc, 'Ball', 1, 0, 0.22);
    keyPath(doc, ball, [
      [1, 1, 3, 0],
      [96, 1, 3, 0],
    ]);
    const scene = new DeskScene(doc);
    const c = scene.groupCentre([ada, ball], 10)!;
    expect(c[2]).toBeCloseTo(scene.objects.get(ada)!.location[2], 12);
    // across the floor it is the middle of the whole group
    expect(c[0]).toBeCloseTo(0.5, 9);
  });
});

describe('imported following shots follow the group, as a solve keys them (review F7)', () => {
  it('an imported tracking shot and the same shot solved again key the same follow', () => {
    // the dialogue's shot 5 as a tracking shot of Leo (walking 2.8 m to the wall) and Maya (standing),
    // its camera blocked at its start only: the import keys the follow from rideo's camera
    const s5 = DIALOGUE_SHOTS[4];
    const blocking = dialogueBlocking();
    delete blocking.shots![s5].camera!.end;
    const clip = { ...dialogueClip(), blocking };
    clip.shots[4] = { ...clip.shots[4], camera: { framing: 'wide', movement: 'tracking' } };
    const doc = SceneDoc.create({ empty: true });
    const r = importClip(doc, clip);
    const shot = r.shots.find((s) => s.rideo_shot === s5)!;
    expect(shot).toMatchObject({ move: 'tracking_follow', camera_from: 'blocking' });
    const actor = (character: string) => r.actors.find((a) => a.character_id === character)!.id;
    const [leo, maya] = [actor(LEO), actor(MAYA)];
    // its subjects: Leo first (rideo's cast order), so following the first subject follows Leo alone
    expect(getShots(doc).find((s) => s.id === shot.id)!.subjects).toEqual([leo, maya]);
    const frames = Array.from(
      { length: shot.frame_end - shot.frame_start + 1 },
      (_, k) => shot.frame_start + k,
    );
    const centre = (f: number) => {
      const a = originAt(doc, leo, f);
      const b = originAt(doc, maya, f);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
    };
    const path = () => {
      const p0 = originAt(doc, shot.camera, shot.frame_start);
      return frames.map((f) => {
        const p = originAt(doc, shot.camera, f);
        return [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
      });
    };
    // Leo walks, Maya stays: the group's centre travels half his way
    const c0 = centre(shot.frame_start);
    const c1 = centre(shot.frame_end);
    expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeGreaterThan(1);
    const imported = path();
    frames.forEach((f, k) => {
      const c = centre(f);
      expect(imported[k][0], `frame ${f}`).toBeCloseTo(c[0] - c0[0], 6);
      expect(imported[k][1], `frame ${f}`).toBeCloseTo(c[1] - c0[1], 6);
      expect(imported[k][2], `frame ${f}`).toBeCloseTo(0, 6);
    });
    // solved again (desk.shot_solve), the camera stands elsewhere but follows the same way
    solveShotCameras(rideoContext(doc), [shot.id], {
      enforce_line: false,
      fit_plan: false,
      keep_lens: false,
    });
    const solved = path();
    frames.forEach((f, k) => {
      for (let i = 0; i < 3; i++) expect(solved[k][i], `frame ${f}`).toBeCloseTo(imported[k][i], 6);
    });
  });
});
