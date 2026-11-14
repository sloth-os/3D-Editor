import { describe, expect, it } from 'vitest';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { DeskAngle, ShotData } from '../src/doc/types';
import { DeskScene, viewFromPose, type CameraView } from '../src/desk/layout';
import { lineSide, solveCamera } from '../src/desk/solver';
import { getShots, setShots } from '../src/desk/shots';
import { crossesLine, enforceLine, lineOfAction, mirrorPose } from '../src/desk/line';
import { fitShotToPlan, layoutView, planAgreement, planFit, shotLayout } from '../src/desk/plan';
import { checkShots } from '../src/desk/checks';
import { deskDoc, ed, expectNear, rideo, rideoCamera, standIn } from './desk-fixtures';

/*
 * The 180° line and planned layouts against rideo's enforceLine and fitBlockingToPlan (values frozen
 * from running rideo on the same blocking): cuts that crossed the line are mirrored back, orbits
 * keep crossing it, and a shot's camera is refitted to the direction that agrees with its plan.
 */

type Shot = Partial<ShotData> & Pick<ShotData, 'name' | 'frame_start' | 'frame_end'>;

/** Ada at x −0.8 and Ben (1.8 m) at x 0.8 facing each other, rideo's two-shot blocking. */
function pair() {
  const doc = deskDoc();
  const A = standIn(doc, 'Ada', -0.8, 0, 90);
  const B = standIn(doc, 'Ben', 0.8, 0, 270, 1.8);
  return { doc, A, B };
}

function store(doc: SceneDoc, list: Shot[]): Record<string, ShotData> {
  setShots(doc, list);
  return Object.fromEntries(getShots(doc).map((s) => [s.name, s]));
}

const viewAt = (doc: SceneDoc, cam: string, frame: number): CameraView =>
  new DeskScene(doc).camera(cam, frame)!;

/** The angle between where a view looks and the direction to `target` (rideo coordinates). */
function aimsAt(v: CameraView, target: number[]): number {
  const t = ed(target[0], target[1], target[2]);
  const d = t.map((x, i) => x - v.position[i]);
  const n = Math.hypot(...d);
  return Math.acos(Math.min(1, d.reduce((s, x, i) => s + x * v.forward[i], 0) / n));
}

/** rideo's crossed blocking: the pair wide; Ada close from the far side with a push; an orbit; Ben close with a dolly. */
function crossed() {
  const { doc, A, B } = pair();
  const s = store(doc, [
    {
      name: 'S1',
      camera: rideoCamera(doc, 'C1', [0, 1.674, 5.213], [0, 0.9, 0], 24),
      frame_start: 1,
      frame_end: 24,
      framing: 'wide',
      subjects: [A, B],
    },
    {
      name: 'S2',
      camera: rideoCamera(doc, 'C2', [0.747, 1.581, -1.083], [-0.8, 1.564, 0], 85),
      frame_start: 25,
      frame_end: 48,
      framing: 'close_up',
      angle: 'three_quarter_left',
      move: 'push_in',
      subjects: [A],
    },
    {
      name: 'S3',
      camera: rideoCamera(doc, 'C3', [0, 1.674, -2.256], [0, 1.296, 0], 35),
      frame_start: 49,
      frame_end: 72,
      framing: 'medium',
      angle: 'back',
      move: 'orbit_left',
      subjects: [A, B],
    },
    {
      name: 'S4',
      camera: rideoCamera(doc, 'C4', [-0.838, 1.674, -1.147], [0.8, 1.656, 0], 85),
      frame_start: 73,
      frame_end: 96,
      framing: 'close_up',
      angle: 'three_quarter_right',
      move: 'dolly_left',
      subjects: [B],
    },
  ]);
  return { doc, A, B, s };
}

describe('the 180° line', () => {
  it("flags the cuts that crossed it (orbits cross it by design), as rideo's blockingIssues", () => {
    const { doc, A, B, s } = crossed();
    const scene = new DeskScene(doc);
    const line = lineOfAction(scene);
    expect(line).toEqual({ a: A, b: B, side: 1 });
    expect(['S1', 'S2', 'S3', 'S4'].map((n) => crossesLine(scene, line, s[n]))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    const crossings = checkShots(doc).issues.filter((i) => i.code === 'line_crossed');
    expect(crossings.map((i) => i.shot)).toEqual([s.S2.id, s.S4.id]);
  });

  it("mirrors the crossed cuts back over the line (rideo's enforceLine) and keys their moves again", () => {
    const { doc, s } = crossed();
    expect(enforceLine(doc)).toEqual({ mirrored: [s.S2.id, s.S4.id] });
    // rideo's positions after enforceLine
    const after = (name: string, frame: number) => rideo(viewAt(doc, s[name].camera!, frame).position);
    expectNear(after('S1', 1), [0, 1.674, 5.213], 1.5e-3, 'S1 kept');
    expectNear(after('S2', 25), [0.747, 1.581, 1.083], 1.5e-3, 'S2 mirrored');
    expect(aimsAt(viewAt(doc, s.S2.camera!, 25), [-0.8, 1.564, 0])).toBeLessThan(1e-3);
    // the push in, from the mirrored start: where rideo's mirrored push ends
    expectNear(after('S2', 48), [0.206, 1.575, 0.704], 1.5e-3, 'S2 push end');
    expectNear(after('S3', 49), [0, 1.674, -2.256], 1.5e-3, 'S3 orbit kept');
    expectNear(after('S4', 73), [-0.838, 1.674, 1.147], 1.5e-3, 'S4 mirrored');
    expect(aimsAt(viewAt(doc, s.S4.camera!, 73), [0.8, 1.656, 0])).toBeLessThan(1e-3);
    // the dolly stays a dolly to the left on screen (rideo would call the mirrored move dolly_right)
    const start = viewAt(doc, s.S4.camera!, 73);
    const end = viewAt(doc, s.S4.camera!, 96);
    const moved = end.position.map((p, i) => p - start.position[i]);
    expect(moved.reduce((acc, d, i) => acc + d * start.right[i], 0)).toBeCloseTo(-1.5, 3); // rideo's moves land on the millimetre
    expect(getShots(doc).find((x) => x.name === 'S4')!.move).toBe('dolly_left');
    expect(checkShots(doc).issues.filter((i) => i.code === 'line_crossed')).toEqual([]);
    // enforcing again changes nothing
    expect(enforceLine(doc)).toEqual({ mirrored: [] });
  });

  it('lets a planned layout win over the line', () => {
    const { doc, A, s } = crossed();
    const shots = getShots(doc);
    // the plan wants Ada centred, facing the camera: what the crossed camera of S2 shows
    shots[1] = { ...shots[1], layout: [{ subject: A, side: 'centre', facing: 'camera' }] };
    setShots(doc, shots);
    expect(enforceLine(doc)).toEqual({ mirrored: [s.S4.id] });
    expect(enforceLine(doc, undefined, { respectPlan: false })).toEqual({ mirrored: [s.S2.id] });
    // only the shots named
    const again = crossed();
    expect(enforceLine(again.doc, ['S4'])).toEqual({ mirrored: [again.s.S4.id] });
  });

  it("takes the pair from the shots it is given, as rideo's lineOfAction", () => {
    const doc = deskDoc();
    const A = standIn(doc, 'Ada', -0.8, 0, 90);
    const B = standIn(doc, 'Ben', 0.8, 0, 270);
    const C = standIn(doc, 'Cy', 0, 2, 180);
    store(doc, [
      { name: 'S1', frame_start: 1, frame_end: 24, subjects: [A, C] },
      { name: 'S2', frame_start: 25, frame_end: 48, subjects: [A, B] },
      { name: 'S3', frame_start: 49, frame_end: 72, subjects: [A, B] },
    ]);
    const scene = new DeskScene(doc);
    const all = getShots(doc);
    // the scene's pair shares the most shots; a solve that has placed only the first shot uses its own
    expect(lineOfAction(scene)).toMatchObject({ a: A, b: B });
    expect(lineOfAction(scene, all.slice(0, 1))).toMatchObject({ a: A, b: C });
    // a single shot with the pair and no camera yet: the side facing the front of the set (+z)
    const line = lineOfAction(scene, [{ ...all[1], camera: null }])!;
    const front = ed(0, 0, 5);
    expect(line).toMatchObject({ a: A, b: B });
    const pts = [scene.subject(A, 25)!.feet, scene.subject(B, 25)!.feet];
    expect(lineSide(pts[0], pts[1], front)).toBe(line.side);
  });

  it("mirrors a pose across the pair's floor line", () => {
    const p = mirrorPose([-1, 0, 0], [1, 0, 0], { position: [0.5, -2, 1.6], target: [0, 1, 1.2], lens: 50 });
    expect(p.position).toEqual([0.5, 2, 1.6]);
    expect(p.target).toEqual([0, -1, 1.2]);
    expect(p.lens).toBe(50);
  });
});

describe('planned layouts', () => {
  /** rideo's planned shots, cameras where rideo's solver placed them from the default specs. */
  function planned() {
    const { doc, A, B } = pair();
    const cam = (name: string, pos: number[], target: number[], lens: number) =>
      rideoCamera(doc, name, pos, target, lens);
    const s = store(doc, [
      {
        name: 'S1',
        camera: cam('C1', [0, 1.674, 2.256], [0, 1.296, 0], 35),
        frame_start: 1,
        frame_end: 24,
        framing: 'medium',
        subjects: [A, B],
        layout: [
          { subject: A, side: 'left', facing: 'right' },
          { subject: B, side: 'right', facing: 'left' },
        ],
      },
      {
        name: 'S2',
        camera: cam('C2', [0, 1.674, 2.256], [0, 1.296, 0], 35),
        frame_start: 25,
        frame_end: 48,
        framing: 'medium',
        subjects: [A, B],
        layout: [
          { subject: A, side: 'right', facing: 'left' },
          { subject: B, side: 'left', facing: 'right' },
        ],
      },
      {
        name: 'S3',
        camera: cam('C3', [0.747, 1.581, -1.083], [-0.8, 1.564, 0], 85),
        frame_start: 49,
        frame_end: 72,
        framing: 'close_up',
        subjects: [A],
        layout: [{ subject: A, side: 'centre', facing: 'camera' }],
      },
      {
        name: 'S4',
        camera: cam('C4', [0.945, 1.581, 1.222], [-0.8, 1.224, 0], 35),
        frame_start: 73,
        frame_end: 96,
        framing: 'medium',
        subjects: [A],
        layout: [{ subject: A, side: 'centre', facing: 'away' }],
      },
      {
        name: 'S5',
        camera: cam('C5', [-1.382, 1.462, 0.339], [0.8, 1.674, 0], 50),
        frame_start: 97,
        frame_end: 120,
        framing: 'over_shoulder',
        subjects: [A, B],
        layout: [{ subject: B, side: 'right', facing: 'camera' }],
      },
    ]);
    return { doc, A, B, s };
  }

  it("scores each camera against its plan as rideo's planAgreement", () => {
    const { doc, s } = planned();
    const golden: Record<string, [boolean, number, string[]]> = {
      S1: [true, 6, []],
      S2: [
        false,
        -2,
        [
          'Ada is left of frame, not right of frame',
          'Ada faces right, not left',
          'Ben is right of frame, not left of frame',
          'Ben faces left, not right',
          'Ben is not left of Ada',
        ],
      ],
      S3: [true, 3, []],
      S4: [false, 2, ['Ada faces camera right, not away']],
      S5: [false, 1, ['Ben is in the centre, not right of frame']],
    };
    for (const [name, [agrees, score, misses]] of Object.entries(golden)) {
      const shot = s[name];
      const a = planAgreement(shotLayout(doc, shot, shot.frame_start), shot.layout);
      expect({ agrees: a.agrees, score: a.score, misses: a.misses }, name).toEqual({ agrees, score, misses });
    }
    // no camera: every planned subject mismatched
    expect(planAgreement(null, s.S1.layout)).toMatchObject({
      agrees: false,
      misses: ['the shot has no camera'],
    });
    expect(planAgreement([], [])).toEqual({ agrees: true, score: 0, misses: [], mismatched: [] });
  });

  it("refits the cameras that disagree to the direction rideo's fitBlockingToPlan picks", () => {
    const { doc, s } = planned();
    const golden: Record<
      string,
      { angle: DeskAngle; pos: number[]; target: number[]; score: number } | null
    > = {
      S1: null,
      S2: { angle: 'back', pos: [0, 1.674, -2.256], target: [0, 1.296, 0], score: 6 },
      S3: null,
      S4: { angle: 'back', pos: [-2.931, 1.581, 0], target: [-0.8, 1.224, 0], score: 3 },
      S5: { angle: 'three_quarter_right', pos: [-1.875, 1.674, 2.678], target: [0, 1.584, 0], score: 3 },
    };
    const scene = new DeskScene(doc);
    getShots(doc).forEach((shot, index) => {
      const fit = planFit(scene, shot, index)!;
      const g = golden[shot.name];
      expect(fit.agreement.agrees, shot.name).toBe(true);
      if (!g) {
        expect(fit.spec, shot.name).toBeNull();
        return;
      }
      expect(fit.own.agrees, shot.name).toBe(false);
      expect(fit.spec!.angle, shot.name).toBe(g.angle);
      expectNear(rideo(fit.solved!.position), g.pos, 1.5e-3, `${shot.name} position`);
      expectNear(rideo(fit.solved!.target), g.target, 1.5e-3, `${shot.name} target`);
      expect(fit.agreement.score, shot.name).toBe(g.score);
    });
    // without a plan there is nothing to fit
    expect(planFit(scene, { ...s.S1, layout: [] }, 0)).toBeNull();
  });

  it('turns a shot that is not an over-the-shoulder into one only when that agrees with the plan', () => {
    const fit = (a: number[], b: number[], plan: [string, string][]) => {
      const doc = deskDoc();
      const A = standIn(doc, 'Ada', a[0], a[1], a[2]);
      const B = standIn(doc, 'Ben', b[0], b[1], b[2]);
      const ids = [A, B];
      setShots(doc, [
        {
          name: 'S',
          frame_start: 1,
          frame_end: 24,
          framing: 'medium',
          angle: 'front',
          subjects: ids,
          layout: plan.map(([side, facing], i) => ({
            subject: ids[i],
            side: side as 'left',
            facing: facing as 'camera',
          })),
        },
      ]);
      const scene = new DeskScene(doc);
      const shot = getShots(doc)[0];
      const shoulder = (subjects: string[]) => {
        const c = solveCamera(
          scene,
          { framing: 'medium', angle: 'over_shoulder', height: 'eye', move: null, lens_mm: 35, subjects },
          1,
        );
        const view = viewFromPose(c.position, c.target, c.lens_mm, scene.aspect);
        return planAgreement(layoutView(scene, shot, 1, view)!.subjects, shot.layout);
      };
      return { result: planFit(scene, shot, 0)!, overBen: shoulder([B, A]), overAda: shoulder([A, B]) };
    };
    // no camera meets this plan; the shoulder over Ben comes closest (5) but still disagrees, so the
    // best standard angle stays (rideo keeps the front, 4) and the shot stays a medium front shot
    const near = fit(
      [1.7, -0.5, 45],
      [1, 0.6, 90],
      [
        ['centre', 'camera'],
        ['left', 'camera'],
      ],
    );
    expect(near.overBen).toMatchObject({ agrees: false, score: 5 });
    expect(near.result.agreement).toMatchObject({ agrees: false, score: 4 });
    expect(near.result.spec!.angle).toBe('front');
    // here only the shoulder over Ada agrees: it is taken
    const only = fit(
      [-1, 1, 135],
      [-0.3, -0.1, 225],
      [
        ['left', 'right'],
        ['centre', 'left'],
      ],
    );
    expect(only.overAda.agrees).toBe(true);
    expect(only.result.agreement.agrees).toBe(true);
    expect(only.result.spec!.angle).toBe('over_shoulder');
  });

  it('writes the refitted camera and the angle it took', () => {
    const { doc, s } = planned();
    expect(fitShotToPlan(doc, s.S1)).toMatchObject({ changed: false, agreement: { agrees: true } });
    expect(fitShotToPlan(doc, s.S2)).toMatchObject({ changed: true, agreement: { agrees: true, score: 6 } });
    expectNear(rideo(viewAt(doc, s.S2.camera!, 25).position), [0, 1.674, -2.256], 1.5e-3, 'S2 camera');
    expect(getShots(doc).find((x) => x.name === 'S2')!.angle).toBe('back');
    // the plan is met: no plan_mismatch left for the refitted shot
    const mismatches = checkShots(doc)
      .issues.filter((i) => i.code === 'plan_mismatch')
      .map((i) => i.shot);
    expect(mismatches).not.toContain(s.S2.id);
    expect(mismatches).toEqual(expect.arrayContaining([s.S4.id, s.S5.id]));
  });
});
