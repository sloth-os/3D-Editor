import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { DeskScene, projectPoint } from '../src/desk/layout';
import { getShots } from '../src/desk/shots';
import { MAX_WIDEN, shotSpec, solveCamera } from '../src/desk/solver';
import { checkShots } from '../src/desk/checks';
import type { SolvedShot } from '../src/operators/desk-shots';
import { deskDoc, deskOperators, ed, prop, standIn } from './desk-fixtures';

/*
 * How far the solve may widen a shot to keep its subjects in frame (desk/solver.ts MAX_WIDEN: about
 * one framing step), and how it says what it gave up: the shot_add / shot_update / shot_solve result
 * (widened, distance_ratio, effective_framing, out_of_frame, needed_ratio, gave_up), a WARNING, and
 * desk.check's subject_out_of_frame for whoever it leaves. Scenes in rideo's coordinates.
 */

/** Keys an object's location through rideo points (x, y, z) at frames (linear between them). */
function keyPath(doc: SceneDoc, id: string, keys: [number, number, number, number][]): void {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: i });
    for (const [f, x, y, z] of keys) fc = insertKeyframe(fc, f, ed(x, y, z)[i], 'LINEAR');
    doc.setFCurve(fc);
  }
}

const dist = (a: Readonly<Vec3>, b: Readonly<Vec3>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const outOfFrame = (doc: SceneDoc) => checkShots(doc).issues.filter((i) => i.code === 'subject_out_of_frame');
/** desk.check's frame for subject_out_of_frame (|x| ≤ 1, −1 ≤ y ≤ 1.15). */
const checked = (q: { x: number; y: number }) =>
  Number.isFinite(q.x) && Math.abs(q.x) <= 1 && q.y >= -1 && q.y <= 1.15;

/** The shot's camera against rideo's camera for it at its first frame, both measured to `at`. */
function standsBack(doc: SceneDoc, at: (scene: DeskScene) => Vec3): number {
  const scene = new DeskScene(doc);
  const shot = getShots(doc)[0];
  const view = scene.camera(shot.camera!, shot.frame_start)!;
  const rideo = solveCamera(scene, shotSpec(scene, shot, 0), shot.frame_start);
  const p = at(scene);
  return dist(view.position, p) / dist(rideo.position, p);
}

describe('widening is limited to about a framing step', () => {
  it('a close-up whose actor walks 20 m stays near rideo’s camera and says she leaves', () => {
    const doc = deskDoc();
    const { run, reports } = deskOperators(doc);
    const ada = standIn(doc, 'Ada', 0, 0, 90);
    keyPath(doc, ada, [
      [1, 0, 0, 0],
      [120, 20, 0, 0],
    ]);
    const { solve } = run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ada'],
      framing: 'close_up',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 120,
    });
    // the old solve backed off 32 times rideo's distance (a lake with a 40 px actor)
    expect(standsBack(doc, (scene) => scene.subject(ada, 1)!.eyes)).toBeLessThanOrEqual(3);
    expect(solve.distance_ratio).toBeLessThanOrEqual(MAX_WIDEN.close_up);
    expect(solve.out_of_frame).toEqual([{ subject: ada, name: 'Ada', frames: [61, 120] }]);
    expect(solve.gave_up).toEqual(['in_frame']);
    expect(solve.needed_ratio).toBeGreaterThan(MAX_WIDEN.close_up);
    expect(outOfFrame(doc).map((i) => i.objects)).toEqual([[ada]]);
    expect(reports).toEqual([
      expect.objectContaining({
        level: 'WARNING',
        message: expect.stringMatching(
          /^Shot 'Shot 1' \(close up, locked_off\): Ada \(frames 61, 120\) leaves its frame: keeping it would take a camera \d+\.\d times as far back as a close up's, and the solve widens a close up at most 2 times \(restage, choose a wider framing, or follow or pan with it/,
        ),
      }),
    ]);
  });

  it('a medium whose ball is kicked toward the camera keeps the kicker, not the ball', () => {
    const doc = deskDoc();
    const { run, reports } = deskOperators(doc);
    const ben = standIn(doc, 'Ben', 0, 0, 0);
    const ball = prop(doc, 'Ball', 0.3, 0.3, 0.22);
    keyPath(doc, ball, [
      [1, 0.3, 0.11, 0.3],
      [30, 0.3, 0.11, 20],
      [72, 0.3, 0.11, 20],
    ]);
    const { solve } = run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ben', 'Ball'],
      framing: 'medium',
      angle: 'front',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 72,
    });
    expect(standsBack(doc, (scene) => scene.subject(ben, 1)!.eyes)).toBeLessThanOrEqual(
      MAX_WIDEN.medium + 0.05,
    );
    expect(solve.distance_ratio).toBeLessThanOrEqual(MAX_WIDEN.medium);
    expect(solve.effective_framing).toBe('medium');
    expect(solve.out_of_frame.map((o) => o.name)).toEqual(['Ball']);
    // the kicker stays in frame on every frame
    const scene = new DeskScene(doc);
    const cam = getShots(doc)[0].camera!;
    for (let f = 1; f <= 72; f++)
      expect(checked(projectPoint(scene.camera(cam, f)!, scene.subject(ben, f)!.eyes)), `frame ${f}`).toBe(
        true,
      );
    expect(outOfFrame(doc).map((i) => i.objects)).toEqual([[ball]]);
    expect(reports.map((r) => r.message)).toEqual([
      expect.stringContaining('Ball (frames 37, 72) leaves its frame'),
    ]);
  });

  /** Ada walks 1.5 m towards the front of the set in a locked-off close-up (`angle`, else none). */
  function approach(angle?: string) {
    const doc = deskDoc();
    const { run, reports } = deskOperators(doc);
    const ada = standIn(doc, 'Ada', 0, 0, 0);
    keyPath(doc, ada, [
      [1, 0, 0, 0],
      [120, 0, 0, 1.5],
    ]);
    const { solve } = run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ada'],
      framing: 'close_up',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 120,
      ...(angle ? { angle } : {}),
    });
    return { doc, solve, reports };
  }

  it('a camera that stands back far enough to read as the next framing out says so', () => {
    // the single's default angle (three-quarter left) sees her come towards it
    const { doc, solve, reports } = approach('three_quarter_left');
    expect(solve).toMatchObject({
      widened: true,
      effective_framing: 'medium_close',
      out_of_frame: [],
      gave_up: [],
    });
    expect(solve.distance_ratio).toBeGreaterThan(1.4);
    expect(solve.distance_ratio).toBeLessThanOrEqual(MAX_WIDEN.close_up);
    expect(outOfFrame(doc)).toEqual([]);
    expect(reports).toEqual([
      {
        level: 'WARNING',
        message:
          `Shot 'Shot 1' (close up, locked_off): its camera stands ${solve.distance_ratio.toFixed(1)} times as far ` +
          "back as a close up's, so it reads as a medium close (set framing 'medium_close' to say so, or restage)",
      },
    ]);
  });

  it('a shot that names no angle turns to see a subject come towards it rather than stand back a framing', () => {
    const { doc, solve, reports } = approach();
    // a side angle holds her at rideo's distance: still a close-up, nothing to warn about
    expect(solve.angle).not.toBe('three_quarter_left');
    expect(getShots(doc)[0].angle).toBeNull();
    expect(solve).toMatchObject({ effective_framing: 'close_up', out_of_frame: [], gave_up: [] });
    expect(solve.distance_ratio).toBeLessThan(1.1);
    expect(reports).toEqual([]);
    expect(outOfFrame(doc)).toEqual([]);
  });

  it('a shot that names no angle takes one that keeps its framing, though it stands back only a little less', () => {
    // Ada walks 3.75 m away across the set (to its right and back) in a locked-off medium
    const walk = (angle?: string) => {
      const doc = deskDoc();
      const { run, reports } = deskOperators(doc);
      const ada = standIn(doc, 'Ada', 0, 0, 0);
      const d = 3.75 * Math.SQRT1_2;
      keyPath(doc, ada, [
        [1, 0, 0, 0],
        [96, d, 0, -d],
      ]);
      const { solve } = run<{ solve: SolvedShot }>('desk.shot_add', {
        subjects: ['Ada'],
        framing: 'medium',
        move: 'locked_off',
        frame_start: 1,
        frame_end: 96,
        ...(angle ? { angle } : {}),
      });
      return { doc, solve, reports };
    };
    // the single's default angle (three-quarter left) stands back far enough to read as a wide
    const asked = walk('three_quarter_left');
    expect(asked.solve).toMatchObject({ effective_framing: 'wide', out_of_frame: [] });
    // three-quarter right keeps her a medium, though it stands back less than a tenth less
    const free = walk();
    expect(free.solve).toMatchObject({
      angle: 'three_quarter_right',
      effective_framing: 'medium',
      out_of_frame: [],
      gave_up: [],
    });
    expect(free.solve.distance_ratio).toBeLessThan(asked.solve.distance_ratio);
    expect(free.solve.distance_ratio).toBeGreaterThan(0.9 * asked.solve.distance_ratio);
    expect(getShots(free.doc)[0].angle).toBeNull();
    expect(free.reports).toEqual([]);
  });

  it('a shot that names no angle takes the one that sees its actor cross the frame', () => {
    const scene = (angle?: string) => {
      const doc = deskDoc();
      const { run } = deskOperators(doc);
      // Ada faces the front of the set and walks 4 m to her left, across it
      const ada = standIn(doc, 'Ada', 0, 0, 0);
      keyPath(doc, ada, [
        [1, 0, 0, 0],
        [120, 4, 0, 0],
      ]);
      const { solve } = run<{ solve: SolvedShot }>('desk.shot_add', {
        subjects: ['Ada'],
        framing: 'medium',
        move: 'locked_off',
        frame_start: 1,
        frame_end: 120,
        ...(angle ? { angle } : {}),
      });
      return { doc, ada, solve };
    };
    // the single's default angle (three-quarter left) sees her walk away along its view
    const asked = scene('three_quarter_left');
    expect(asked.solve.angle).toBe('three_quarter_left');
    expect(asked.solve.out_of_frame).toEqual([{ subject: asked.ada, name: 'Ada', frames: [120] }]);
    // without an angle the solve takes the front, which she crosses within the limit
    const free = scene();
    expect(free.solve.angle).toBe('front');
    expect(getShots(free.doc)[0].angle).toBeNull();
    expect(free.solve.out_of_frame).toEqual([]);
    expect(free.solve.distance_ratio).toBeLessThanOrEqual(MAX_WIDEN.medium);
    expect(outOfFrame(free.doc)).toEqual([]);
  });

  it('shot_update and shot_solve return the same account as shot_add', () => {
    const doc = deskDoc();
    const { run, reports } = deskOperators(doc);
    standIn(doc, 'Ada', -0.8, 0, 90);
    const ben = standIn(doc, 'Ben', 0.8, 0, 270);
    keyPath(doc, ben, [
      [1, 0.8, 0, 0],
      [120, 6.5, 0, -1],
    ]);
    const added = run<{ solved: boolean; solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ada', 'Ben'],
      framing: 'medium',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 120,
    });
    expect(added.solved).toBe(true);
    const fields = (s: SolvedShot) => ({
      angle: s.angle,
      widened: s.widened,
      distance_ratio: s.distance_ratio,
      effective_framing: s.effective_framing,
      out_of_frame: s.out_of_frame,
      needed_ratio: s.needed_ratio,
      gave_up: s.gave_up,
    });
    expect(fields(added.solve).out_of_frame.map((o) => o.name)).toEqual(['Ben']);
    const updated = run<{ solved: boolean; solve: SolvedShot }>('desk.shot_update', {
      shot: 'Shot 1',
      resolve: true,
    });
    expect(updated.solved).toBe(true);
    expect(fields(updated.solve)).toEqual(fields(added.solve));
    const solved = run<{ shots: SolvedShot[] }>('desk.shot_solve', { shots: ['Shot 1'] });
    expect(fields(solved.shots[0])).toEqual(fields(added.solve));
    // each solve warns once
    expect(reports.filter((r) => r.level === 'WARNING')).toHaveLength(3);
    // a shot that is not solved has no account
    const kept = run<{ solved: boolean; solve: SolvedShot | null }>('desk.shot_update', {
      shot: 'Shot 1',
      notes: 'kept',
    });
    expect(kept).toMatchObject({ solved: false, solve: null });
  });
});
