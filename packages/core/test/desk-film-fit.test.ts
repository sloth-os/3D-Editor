import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { DeskAngle, DeskFraming, DeskHeight, DeskMove } from '../src/doc/types';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { createCube } from '../src/mesh/primitives';
import { actorKeypoints, applyPose, createActor, QUADRUPED_KEYPOINTS } from '../src/desk/characters';
import { DESK_PROPS } from '../src/desk/props';
import { DeskScene, projectPoint, viewFromPose, type CameraView } from '../src/desk/layout';
import { getShots } from '../src/desk/shots';
import {
  FRAMING_TABLE,
  MAX_WIDEN,
  shotSamples,
  shotSpec,
  solveCamera,
  type SolvedCamera,
  type SolveSpec,
} from '../src/desk/solver';
import { lineOfAction, linePointsAt } from '../src/desk/line';
import {
  addDeskCamera,
  applyCameraMove,
  fitShotCamera,
  movePoseAt,
  shotOcclusions,
  type CameraPose,
} from '../src/desk/moves';
import { checkShots } from '../src/desk/checks';
import type { SolvedShot } from '../src/operators/desk-shots';
import { deskDoc, deskOperators, ed, landmark, prop, standIn } from './desk-fixtures';

/*
 * The Kite Day fixes of the camera solver (desk/solver.ts, moves.ts fitShotCamera): a shot's camera
 * fitted to where its subjects go over the shot (F3), following moves that follow the subjects'
 * group (F4), flying props measured where they fly (F6) and animals framed by their length (F7).
 * Scenes are laid out in rideo's coordinates (desk-fixtures.ts); each fix is checked against the
 * camera rideo's rules give at the shot's first frame, which loses the subject the fix keeps.
 */

const spec = (framing: DeskFraming, subjects: string[], o: Partial<SolveSpec> = {}): SolveSpec => ({
  framing,
  angle: 'front',
  height: 'eye',
  move: null,
  lens_mm: FRAMING_TABLE[framing].lens_mm,
  subjects,
  ...o,
});

/** Keys an object's location through rideo points (x, y, z) at frames (linear between them). */
function keyPath(doc: SceneDoc, id: string, keys: [number, number, number, number][]): void {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: i });
    for (const [f, x, y, z] of keys) fc = insertKeyframe(fc, f, ed(x, y, z)[i], 'LINEAR');
    doc.setFCurve(fc);
  }
}

/** A store-like model: a root (desk_role prop) with a box part as its child, `size` metres. */
function model(doc: SceneDoc, label: string, at: Vec3, size: number): string {
  const root = doc.addObject({
    type: 'EMPTY',
    name: label,
    location: at,
    custom_props: { [DESK_PROPS.role]: 'prop', [DESK_PROPS.label]: label },
  });
  doc.addObject({
    type: 'MESH',
    name: `${label} body`,
    data: doc.addMesh(`${label} body`, createCube({ size })),
    parent: root,
  });
  return root;
}

/** A fitted camera without its account (the fields rideo's solver returns). */
const cameraOf = (c: SolvedCamera): SolvedCamera => ({
  position: c.position,
  target: c.target,
  lens_mm: c.lens_mm,
  end: c.end,
});

/** Where a point shows in a camera's picture (x right, y up, ±1 at the edges; NaN behind it). */
const shown = (view: CameraView, p: Readonly<Vec3>) => projectPoint(view, p);
const viewOf = (scene: DeskScene, c: { position: Vec3; target: Vec3; lens_mm: number }) =>
  viewFromPose(c.position, c.target, c.lens_mm, scene.aspect);
/** desk.check's frame for subject_out_of_frame (|x| ≤ 1, −1 ≤ y ≤ 1.15). */
const checked = (q: { x: number; y: number }) =>
  Number.isFinite(q.x) && Math.abs(q.x) <= 1 && q.y >= -1 && q.y <= 1.15;
const outOfFrame = (doc: SceneDoc) => checkShots(doc).issues.filter((i) => i.code === 'subject_out_of_frame');

describe('F3: subjects that stay put get rideo’s camera exactly', () => {
  const framings: DeskFraming[] = [
    'extreme_wide',
    'wide',
    'medium',
    'medium_close',
    'close_up',
    'extreme_close_up',
  ];
  const angles: DeskAngle[] = ['front', 'three_quarter_left', 'profile_right', 'back'];
  const heights: DeskHeight[] = ['eye', 'low', 'high', 'overhead'];

  it('for one, two and three subjects at every framing, angle and height (no move)', () => {
    const doc = deskDoc();
    const a = standIn(doc, 'Ada', -0.8, 0, 90);
    const b = standIn(doc, 'Ben', 0.8, 0.3, 270, 1.8);
    const c = standIn(doc, 'Cy', 0.1, -1.4, 10, 1.2);
    const scene = new DeskScene(doc);
    let same = 0;
    let kept = 0;
    let stepped = 0;
    for (const subjects of [[a], [a, b], [a, b, c]])
      for (const framing of framings)
        for (const angle of angles)
          for (const height of heights) {
            const s = spec(framing, subjects, { angle, height });
            const rideo = solveCamera(scene, s, 1);
            const fitted = fitShotCamera(scene, s, { frame_start: 1, frame_end: 120 });
            const what = `${subjects.length} ${framing} ${angle} ${height}`;
            const eyes = (c: typeof rideo) =>
              subjects.map((id) => shown(viewOf(scene, c), scene.subject(id, 1)!.eyes));
            const inside = eyes(rideo).every((q) => Math.abs(q.x) <= 0.97 && q.y >= -0.97 && q.y <= 1.12);
            const pose = (c: typeof rideo) => ({ position: c.position, target: c.target, lens: c.lens_mm });
            const hidden = shotOcclusions(scene, s, { frame_start: 1, frame_end: 120 }, pose(rideo));
            if (inside && !hidden.length) {
              // rideo's camera, to the bit, and an account that says so
              expect(cameraOf(fitted), what).toEqual(rideo);
              expect(fitted, what).toMatchObject({
                widened: false,
                distance_ratio: 1,
                effective_framing: framing,
                out_of_frame: [],
              });
              same++;
            } else if (inside) {
              // a bystander (the subject left out) hides one from rideo's camera: a step aside or up
              // that hides less, the subjects still in frame
              expect(cameraOf(fitted), what).not.toEqual(rideo);
              const after = shotOcclusions(scene, s, { frame_start: 1, frame_end: 120 }, pose(fitted));
              const weight = (os: typeof hidden) =>
                os.reduce((n, o) => n + 2 * o.frames.length + o.body_frames.length, 0);
              expect(weight(after), what).toBeLessThan(weight(hidden));
              expect(eyes(fitted).every(checked), what).toBe(true);
              stepped++;
            } else if (!eyes(rideo).every(checked)) {
              // rideo's camera loses a subject (a profile of two in line, a short one behind): re-aimed
              // or widened within the framing's limit, keeping them all
              expect(cameraOf(fitted), what).not.toEqual(rideo);
              expect(fitted.distance_ratio, what).toBeLessThanOrEqual(MAX_WIDEN[framing]);
              expect(eyes(fitted).every(checked), what).toBe(true);
              expect(fitted.out_of_frame, what).toEqual([]);
              kept++;
            }
          }
    expect(same).toBeGreaterThan(250);
    expect(kept).toBeGreaterThan(0);
    expect(stepped).toBeGreaterThan(0);
  });

  it('through moves that keep a lone subject in frame', () => {
    const doc = deskDoc();
    const a = standIn(doc, 'Ada', 0.3, -0.2, 35);
    const scene = new DeskScene(doc);
    const moves: DeskMove[] = [
      'locked_off',
      'push_in',
      'pull_out',
      'orbit_left',
      'orbit_right',
      'crane_up',
      'crane_down',
      'handheld',
      'rack_focus',
      'dolly_zoom',
      'pan_left',
      'whip_pan',
    ];
    for (const move of moves)
      for (const framing of ['wide', 'medium', 'close_up'] as const) {
        const s = spec(framing, [a], { move, angle: 'three_quarter_right' });
        const fitted = fitShotCamera(scene, s, { frame_start: 1, frame_end: 96 });
        expect(fitted.widened, `${move} ${framing}`).toBe(false);
        expect(cameraOf(fitted), `${move} ${framing}`).toEqual(solveCamera(scene, s, 1));
      }
  });

  it('through desk.shot_add', () => {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    standIn(doc, 'Ada', -0.8, 0, 90);
    standIn(doc, 'Ben', 0.8, 0, 270, 1.8);
    ops.run('desk.shot_add', { subjects: ['Ada', 'Ben'], framing: 'medium', angle: 'front' });
    ops.run('desk.shot_add', { subjects: ['Ada'], framing: 'close_up', move: 'push_in' });
    ops.run('desk.shot_add', { subjects: ['Ben', 'Ada'], framing: 'wide', move: 'crane_up', height: 'low' });
    const scene = new DeskScene(doc);
    const shots = getShots(doc);
    shots.forEach((s, i) => {
      // solved as solveShotCameras solves a new shot: on the line of the shots placed before it
      const line = lineOfAction(scene, [...shots.slice(0, i), { ...s, camera: null }]);
      const rideo = solveCamera(scene, shotSpec(scene, s, i), s.frame_start, {
        line: linePointsAt(scene, line, s.frame_start),
      });
      const view = scene.camera(s.camera!, s.frame_start)!;
      for (let k = 0; k < 3; k++) expect(view.position[k], s.name).toBeCloseTo(rideo.position[k], 9);
    });
  });
});

describe('F3: cameras fitted over the shot keep moving subjects in frame', () => {
  /** S32: Ada stays, Ben walks off to `x` (rideo metres) over a locked-off medium two-shot. */
  function walkOff(x: number) {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    standIn(doc, 'Ada', -0.8, 0, 90);
    const ben = standIn(doc, 'Ben', 0.8, 0, 270);
    keyPath(doc, ben, [
      [1, 0.8, 0, 0],
      [120, x, 0, -1],
    ]);
    const r = ops.run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ada', 'Ben'],
      framing: 'medium',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 120,
    });
    const scene = new DeskScene(doc);
    const s = getShots(doc)[0];
    const rideo = viewOf(scene, solveCamera(scene, spec('medium', s.subjects, { angle: s.angle! }), 1));
    return { doc, ops, ben, solve: r.solve, scene, rideo };
  }

  it('a locked-off two-shot keeps the actor who walks off within a framing step (S32)', () => {
    const { doc, ops, ben, solve, scene, rideo } = walkOff(2.5);
    expect(outOfFrame(doc)).toEqual([]);
    // rideo's camera at the first frame loses Ben by the last
    expect(checked(shown(rideo, scene.subject(ben, 120)!.eyes))).toBe(false);
    // the result says how far back the camera stands: still a medium, so no warning
    expect(solve).toMatchObject({
      widened: true,
      effective_framing: 'medium',
      out_of_frame: [],
      gave_up: [],
    });
    expect(solve.distance_ratio).toBeGreaterThan(1.2);
    expect(solve.distance_ratio).toBeLessThanOrEqual(MAX_WIDEN.medium);
    expect(ops.reports).toEqual([]);
  });

  it('an actor who walks farther than a framing step is left to leave the frame, and the solve says so (S32)', () => {
    const { doc, ops, ben, solve, scene } = walkOff(6.5);
    // the camera stands no farther back than the framing allows
    const shot = getShots(doc)[0];
    const view = scene.camera(shot.camera!, 1)!;
    const rideoCam = solveCamera(scene, shotSpec(scene, shot, 0), 1);
    const far = (p: Readonly<Vec3>) =>
      Math.hypot(p[0] - rideoCam.target[0], p[1] - rideoCam.target[1], p[2] - rideoCam.target[2]);
    expect(far(view.position) / far(rideoCam.position)).toBeLessThanOrEqual(MAX_WIDEN.medium + 1e-9);
    // Ben leaves it: desk.check, the result and a warning name him and what keeping him would take
    expect(outOfFrame(doc).map((i) => i.objects)).toEqual([[ben]]);
    expect(solve.out_of_frame).toEqual([{ subject: ben, name: 'Ben', frames: [61, 120] }]);
    expect(solve.gave_up).toEqual(['in_frame']);
    expect(solve.needed_ratio).toBeGreaterThan(MAX_WIDEN.medium);
    expect(ops.reports.map((r) => r.level)).toEqual(['WARNING']);
    expect(ops.reports[0].message).toContain('Ben (frames 61, 120) leaves its frame');
    expect(ops.reports[0].message).toContain(`${solve.needed_ratio!.toFixed(1)} times as far back`);
  });

  it('a wide shot aims at the middle of where its subjects walk in from (S02, S05)', () => {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const ada = standIn(doc, 'Ada', -9, 0, 90);
    const ben = standIn(doc, 'Ben', -9.5, 0.8, 90, 1.8);
    keyPath(doc, ada, [
      [1, -9, 0, 0],
      [144, -1, 0, 0],
    ]);
    keyPath(doc, ben, [
      [1, -9.5, 0, 0.8],
      [144, -0.2, 0, 0.6],
    ]);
    ops.run('desk.shot_add', {
      subjects: ['Ada', 'Ben'],
      framing: 'wide',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 144,
    });
    expect(outOfFrame(doc)).toEqual([]);
    const scene = new DeskScene(doc);
    const view = scene.camera(getShots(doc)[0].camera!, 1)!;
    for (const f of [1, 73, 144])
      for (const id of [ada, ben]) {
        const q = shown(view, scene.subject(id, f)!.eyes);
        expect(Math.abs(q.x), `${f}`).toBeLessThan(1);
      }
  });

  it('a group whose subject runs ahead is held across the whole frame (S02)', () => {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    // Ada and Ben walk in side by side from the left, Pip runs far ahead of them
    const ada = standIn(doc, 'Ada', -9, 0, 90);
    const ben = standIn(doc, 'Ben', -8.2, 0.2, 90, 1.8);
    const pip = standIn(doc, 'Pip', -6, 0.4, 90, 0.6);
    keyPath(doc, ada, [
      [1, -9, 0, 0],
      [144, -3, 0, 0],
    ]);
    keyPath(doc, ben, [
      [1, -8.2, 0, 0.2],
      [144, -2.2, 0, 0.2],
    ]);
    keyPath(doc, pip, [
      [1, -6, 0, 0.4],
      [144, 5, 0, 0.6],
    ]);
    ops.run('desk.shot_add', {
      subjects: ['Ada', 'Ben', 'Pip'],
      framing: 'wide',
      angle: 'three_quarter_right',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 144,
    });
    expect(outOfFrame(doc)).toEqual([]);
    const scene = new DeskScene(doc);
    const view = scene.camera(getShots(doc)[0].camera!, 1)!;
    const xs = [1, 73, 144].flatMap((f) =>
      [ada, ben, pip].map((id) => shown(view, scene.subject(id, f)!.eyes).x),
    );
    // the actors left behind reach as far towards the left edge as the one ahead towards the right
    // (aimed at the middle of the group's centres, they kept to the left: -0.85 against 0.52)
    expect(Math.min(...xs)).toBeLessThan(-0.6);
    expect(Math.max(...xs)).toBeGreaterThan(0.6);
    expect(Math.abs(Math.min(...xs) + Math.max(...xs))).toBeLessThan(0.15);
  });

  it('a close-up keeps the face of an actor who crouches (S28)', () => {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const { actor: ben } = createActor(doc, {
      kind: 'adult',
      name: 'Ben',
      location: [0, 0, 0],
      facing_deg: 0,
    });
    applyPose(doc, ben, 'stand', { frame: 1 });
    applyPose(doc, ben, 'crouch', { frame: 40, blend_frames: 12, hold_frames: 60 });
    ops.run('desk.shot_add', {
      subjects: [ben],
      framing: 'close_up',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 96,
    });
    expect(outOfFrame(doc)).toEqual([]);
    const scene = new DeskScene(doc);
    const s = getShots(doc)[0];
    const view = scene.camera(s.camera!, 1)!;
    for (const f of shotSamples(s))
      expect(checked(shown(view, scene.subject(ben, f)!.eyes)), `${f}`).toBe(true);
    const rideo = viewOf(scene, solveCamera(scene, spec('close_up', [ben], { angle: s.angle! }), 1));
    expect(checked(shown(rideo, scene.subject(ben, 96)!.eyes))).toBe(false);
  });

  it('a push-in on a two-shot keeps both actors through its end', () => {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    standIn(doc, 'Ada', -1.2, 0, 90);
    standIn(doc, 'Ben', 1.2, 0, 270);
    ops.run('desk.shot_add', { subjects: ['Ada', 'Ben'], framing: 'medium_close', move: 'push_in' });
    expect(outOfFrame(doc)).toEqual([]);
  });
});

describe('F3: where the solver predicts a move goes', () => {
  it('movePoseAt is where the keyed camera is at the first, middle and last frame', () => {
    const moves: DeskMove[] = [
      'push_in',
      'pull_out',
      'dolly_left',
      'dolly_right',
      'crane_up',
      'crane_down',
      'orbit_left',
      'orbit_right',
      'dolly_zoom',
      'drone_flyover',
      'locked_off',
    ];
    for (const move of moves) {
      const doc = deskDoc();
      const cam = addDeskCamera(doc, { name: 'Cam', shotId: 'shot', lens: 35 });
      const start: CameraPose = { position: [3, -7, 1.6], target: [0.4, 0.2, 1.1], lens: 35 };
      applyCameraMove(doc, cam, move, { frame_start: 1, frame_end: 121, start });
      const scene = new DeskScene(doc);
      for (const [f, t] of [
        [1, 0],
        [61, 0.5],
        [121, 1],
      ] as const) {
        const want = movePoseAt(start, move, t, scene.aspect);
        const view = scene.camera(cam, f)!;
        for (let k = 0; k < 3; k++) expect(view.position[k], `${move} ${f}`).toBeCloseTo(want.position[k], 6);
        expect(view.lens, `${move} ${f}`).toBeCloseTo(want.lens, 6);
        // it looks where the prediction looks
        const dir = [0, 1, 2].map((k) => want.target[k] - want.position[k]);
        const len = Math.hypot(...dir);
        for (let k = 0; k < 3; k++) expect(view.forward[k], `${move} ${f}`).toBeCloseTo(dir[k] / len, 6);
      }
    }
  });
});

describe('F4: following moves follow the subjects’ group', () => {
  /** Ada and Ben walking apart: Ada 4 m along x, Ben 2 m along x and 1.5 m back. */
  function apart() {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const ada = standIn(doc, 'Ada', -0.6, 0, 90);
    const ben = standIn(doc, 'Ben', 0.6, 0, 90);
    keyPath(doc, ada, [
      [1, -0.6, 0, 0],
      [96, 3.4, 0, 0],
    ]);
    keyPath(doc, ben, [
      [1, 0.6, 0, 0],
      [96, 2.6, 0, -1.5],
    ]);
    return { doc, ops, ada, ben };
  }

  for (const move of ['tracking_follow', 'steadicam_walk'] as const)
    it(`${move} keeps its offset from the centre of the group`, () => {
      const { doc, ops, ada, ben } = apart();
      ops.run('desk.shot_add', {
        subjects: ['Ada', 'Ben'],
        framing: 'medium',
        move,
        frame_start: 1,
        frame_end: 96,
      });
      const scene = new DeskScene(doc);
      const cam = getShots(doc)[0].camera!;
      // across the floor (a steadicam bobs; both walk facing the same way, so it does not turn)
      const off = (f: number) => {
        const c = scene.groupCentre([ada, ben], f)!;
        const p = scene.camera(cam, f)!.position;
        return [p[0] - c[0], p[1] - c[1]];
      };
      const first = off(1);
      for (const f of [24, 48, 72, 96])
        for (let k = 0; k < 2; k++) expect(off(f)[k], `${f}`).toBeCloseTo(first[k], 6);
      expect(outOfFrame(doc)).toEqual([]);
    });

  it('a single subject is followed as before: its own origin and heading', () => {
    for (const move of ['tracking_follow', 'steadicam_walk'] as const) {
      const doc = deskDoc();
      const ops = deskOperators(doc);
      const ada = standIn(doc, 'Ada', 0, 0, 90);
      keyPath(doc, ada, [
        [1, 0, 0, 0],
        [60, 2, 0, -1],
        [96, 3, 0, 1],
      ]);
      let fc = createFCurve({ target_type: 'object', target_id: ada, path: 'rotation_euler', index: 2 });
      fc = insertKeyframe(fc, 1, Math.PI / 2, 'LINEAR');
      fc = insertKeyframe(fc, 96, Math.PI / 4, 'LINEAR');
      doc.setFCurve(fc);
      ops.run('desk.shot_add', { subjects: ['Ada'], framing: 'medium', move, frame_start: 1, frame_end: 96 });
      const scene = new DeskScene(doc);
      const cam = getShots(doc)[0].camera!;
      const p0 = scene.camera(cam, 1)!.position;
      const o0 = scene.origin(ada, 1);
      const f0 = scene.facing(ada, 1);
      for (const f of [30, 60, 96]) {
        const o = scene.origin(ada, f);
        const face = scene.facing(ada, f);
        // the camera's offset from Ada turns with her heading (a steadicam) and travels with her
        const turn =
          move === 'steadicam_walk'
            ? Math.atan2(f0[0] * face[1] - f0[1] * face[0], f0[0] * face[0] + f0[1] * face[1])
            : 0;
        const off = [p0[0] - o0[0], p0[1] - o0[1]];
        const want = [
          o[0] + off[0] * Math.cos(turn) - off[1] * Math.sin(turn),
          o[1] + off[0] * Math.sin(turn) + off[1] * Math.cos(turn),
        ];
        const p = scene.camera(cam, f)!.position;
        expect(p[0], `${move} ${f}`).toBeCloseTo(want[0], 6);
        expect(p[1], `${move} ${f}`).toBeCloseTo(want[1], 6);
      }
    }
  });
});

describe('F6: flying subjects measured where they fly', () => {
  it('a kite 15 m up is in the frame of a wide shot listing it with its flyer (S19)', () => {
    for (const framing of ['extreme_wide', 'wide'] as const) {
      const doc = deskDoc();
      const ops = deskOperators(doc);
      const ada = standIn(doc, 'Ada', 0, 0, 0);
      const kite = model(doc, 'Kite', ed(2, 15, -6), 0.9);
      keyPath(doc, kite, [
        [1, 2, 15, -6],
        [72, 4, 17, -7],
        [144, 3, 16, -6.5],
      ]);
      ops.run('desk.shot_add', {
        subjects: ['Ada', 'Kite'],
        framing,
        move: 'locked_off',
        frame_start: 1,
        frame_end: 144,
      });
      expect(outOfFrame(doc), framing).toEqual([]);
      const scene = new DeskScene(doc);
      const s = scene.subject(kite, 1)!;
      expect(s.airborne).toBe(true);
      expect(s.feet[2]).toBeGreaterThan(14);
      // the camera stands on the ground with the flyer, not up with the kite
      const view = scene.camera(getShots(doc)[0].camera!, 1)!;
      expect(view.position[2]).toBeLessThan(3);
      const rideo = viewOf(scene, solveCamera(scene, spec(framing, [ada, kite]), 1));
      expect(checked(shown(rideo, s.center)), framing).toBe(false);
    }
  });

  it('a ball in flight stays in the frame of the shot that kicks it', () => {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    standIn(doc, 'Ben', 0, 0, 90);
    const ball = prop(doc, 'Ball', 0.4, 0, 0.22);
    keyPath(doc, ball, [
      [1, 0.4, 0.11, 0],
      [30, 4, 6, -1],
      [60, 8, 0.11, -2],
    ]);
    ops.run('desk.shot_add', {
      subjects: ['Ben', 'Ball'],
      framing: 'wide',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 60,
    });
    expect(outOfFrame(doc)).toEqual([]);
    const scene = new DeskScene(doc);
    expect(scene.subject(ball, 30)!.airborne).toBe(true);
    expect(scene.subject(ball, 1)!.airborne).toBe(false);
  });

  it('a prop on the ground is measured as before', () => {
    const doc = deskDoc();
    const box = prop(doc, 'Crate', 1, 2, 0.6);
    const s = new DeskScene(doc).subject(box, 1)!;
    expect(s.airborne).toBe(false);
    expect(s.animal).toBe(false);
    expect(s.extent).toBeNull();
    expect(s.feet).toEqual([s.center[0], s.center[1], s.bounds.min[2]]);
    expect(s.height).toBeCloseTo(0.6, 6);
    expect(s.head[2]).toBeCloseTo(0.6, 6);
  });

  it('a prop standing on a table is not flying: the floor under it is the table', () => {
    const doc = deskDoc();
    // a 1.2 m table (a set piece) with a 0.3 m vase on it, and the same vase as high in the air beside it
    landmark(doc, 'Table', 0, 0, 1.4, 0.8, 1.2);
    const vase = prop(doc, 'Vase', 0, 0, 0.3);
    doc.updateObject(vase, { location: ed(0, 1.2 + 0.15, 0) });
    const thrown = prop(doc, 'Ball', 3, 0, 0.3);
    doc.updateObject(thrown, { location: ed(3, 1.2 + 0.15, 0) });
    const scene = new DeskScene(doc);
    const onTable = scene.subject(vase, 1)!;
    expect(onTable.feet[2]).toBeCloseTo(1.2, 6);
    expect(scene.floorUnder(vase, onTable.feet, 1)).toBeCloseTo(1.2, 6);
    expect(onTable.airborne).toBe(false);
    expect(scene.subject(thrown, 1)!.airborne).toBe(true);
  });
});

/**
 * rideo's camera for a figure as tall as the actor, on its mark and facing its way (rideo frames its
 * characters by their height alone). The actor stands at the origin facing 90°.
 */
function solveCameraByHeight(scene: DeskScene, s: SolveSpec) {
  const doc = deskDoc();
  const figure = standIn(doc, 'Figure', 0, 0, 90, scene.subject(s.subjects[0], 1)!.height);
  return solveCamera(new DeskScene(doc), { ...s, subjects: [figure] }, 1);
}

describe('F7: animals framed by their length', () => {
  function dog(kind: 'dog' | 'horse' = 'dog') {
    const doc = deskDoc();
    const { actor } = createActor(doc, {
      kind,
      name: 'Pip',
      location: [0, 0, 0],
      facing_deg: 90,
      pose: 'stand',
    });
    const scene = new DeskScene(doc);
    const kp = actorKeypoints(scene.frameState(1), doc, actor);
    const at = (name: (typeof QUADRUPED_KEYPOINTS)[number]) => kp.points[QUADRUPED_KEYPOINTS.indexOf(name)]!;
    return { doc, scene, actor, at };
  }

  it('a medium shot shows the whole animal, head to tail, with room around it', () => {
    for (const kind of ['dog', 'horse'] as const)
      for (const angle of ['profile_left', 'profile_right', 'three_quarter_left', 'front'] as const) {
        const { scene, actor, at } = dog(kind);
        const s = spec('medium', [actor], { angle });
        const view = viewOf(scene, fitShotCamera(scene, s, { frame_start: 1, frame_end: 1 }));
        const head = scene.subject(actor, 1)!.head;
        const what = `${kind} ${angle}`;
        for (const p of [at('nose'), at('tail_root'), at('l_front_paw'), at('r_back_paw'), head]) {
          const q = shown(view, p);
          expect(Math.abs(q.x), what).toBeLessThan(0.95);
          expect(Math.abs(q.y), what).toBeLessThan(0.95);
        }
        if (angle.startsWith('profile')) {
          // it fills the frame: not a far wide shot
          expect(Math.abs(shown(view, at('nose')).x - shown(view, at('tail_root')).x), what).toBeGreaterThan(
            0.8,
          );
          // rideo frames it by its height alone, cutting off its head or tail
          const rideo = viewOf(scene, solveCameraByHeight(scene, s));
          const ends = [at('nose'), at('tail_root')].map((p) => Math.abs(shown(rideo, p).x));
          expect(Math.max(...ends), what).toBeGreaterThan(0.95);
        }
      }
  });

  it('a close-up shows its head and chest, not its tail', () => {
    const { scene, actor, at } = dog();
    const view = viewOf(
      scene,
      fitShotCamera(scene, spec('close_up', [actor], { angle: 'profile_left' }), {
        frame_start: 1,
        frame_end: 1,
      }),
    );
    for (const p of [at('l_eye'), at('nose')]) {
      const q = shown(view, p);
      expect(Math.abs(q.x)).toBeLessThan(1);
      expect(Math.abs(q.y)).toBeLessThan(1);
    }
    expect(Math.abs(shown(view, scene.subject(actor, 1)!.chest).x)).toBeLessThan(1);
    expect(Math.abs(shown(view, at('tail_root')).x)).toBeGreaterThan(1);
  });

  it('people are framed by their height as rideo frames them', () => {
    const doc = deskDoc();
    const { actor } = createActor(doc, { kind: 'adult', location: [0, 0, 0], facing_deg: 90, pose: 'stand' });
    const scene = new DeskScene(doc);
    const s = scene.subject(actor, 1)!;
    expect(s.animal).toBe(false);
    expect(s.extent).toBeNull();
  });
});
