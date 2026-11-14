import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { createConstraint } from '../src/constraints/catalogue';
import { DeskScene } from '../src/desk/layout';
import { getShots } from '../src/desk/shots';
import { FRAMING_TABLE, shotSpec, solveCamera, type SolveSpec } from '../src/desk/solver';
import { shotFitReport, shotOcclusions } from '../src/desk/moves';
import { createActor } from '../src/desk/characters';
import { checkShots } from '../src/desk/checks';
import type { SolvedShot } from '../src/operators/desk-shots';
import { deskDoc, deskOperators, ed, prop, standIn } from './desk-fixtures';

/*
 * What keeps the film's shots right after the camera is fitted over the shot: the line enforced on
 * fitted cameras (a mirrored camera kept around its subjects), the plan fitted over the shot (a plan
 * that agrees kept with all the subjects, else said to be given up), the shared reading of the
 * subjects only when no camera leads anything, and the warning for subjects hidden behind a
 * bystander. Scenes in rideo's coordinates.
 */

/** Keys an object's location through rideo points (x, y, z) at frames (linear between them). */
function keyPath(doc: SceneDoc, id: string, keys: [number, number, number, number][]): void {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: i });
    for (const [f, x, y, z] of keys) fc = insertKeyframe(fc, f, ed(x, y, z)[i], 'LINEAR');
    doc.setFCurve(fc);
  }
}

const issuesOf = (doc: SceneDoc, code: string) => checkShots(doc).issues.filter((i) => i.code === code);
const near = (a: Readonly<Vec3>, b: Readonly<Vec3>, eps: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= eps;

describe('the line on fitted cameras', () => {
  it('a mirrored camera keeps the subject who walks off in frame (S32)', () => {
    const doc = deskDoc();
    const { run } = deskOperators(doc);
    standIn(doc, 'Ada', -0.8, 0, 90);
    const ben = standIn(doc, 'Ben', 0.8, 0, 270);
    // Ben stays for the first shot, then walks off upstage during the second
    keyPath(doc, ben, [
      [1, 0.8, 0, 0],
      [61, 0.8, 0, 0],
      [180, 2.5, 0, -1],
    ]);
    run('desk.shot_add', {
      subjects: ['Ada', 'Ben'],
      framing: 'medium',
      angle: 'front',
      frame_start: 1,
      frame_end: 60,
      solve: false,
    });
    // from behind them: across the line the first shot sets, so the solve mirrors it
    run('desk.shot_add', {
      subjects: ['Ada', 'Ben'],
      framing: 'medium',
      angle: 'back',
      move: 'locked_off',
      frame_start: 61,
      frame_end: 180,
      solve: false,
    });
    const r = run<{ shots: SolvedShot[] }>('desk.shot_solve');
    expect(r.shots.map((s) => s.mirrored)).toEqual([false, true]);
    expect(r.shots[1].out_of_frame).toEqual([]);
    expect(issuesOf(doc, 'line_crossed')).toEqual([]);
    expect(issuesOf(doc, 'subject_out_of_frame')).toEqual([]);
  });
});

describe('plans fitted over the shot (S02)', () => {
  /** Ada, Ben and Pip walk in from the left over a locked-off shot, `walk` metres, to stand at x ≈ 0. */
  function walkIn(framing: string, walk: number) {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const ada = standIn(doc, 'Ada', -walk, 0, 90);
    const ben = standIn(doc, 'Ben', -walk - 1.2, -0.8, 90);
    const pip = standIn(doc, 'Pip', -walk - 0.6, 0.9, 90, 1.2);
    keyPath(doc, ada, [
      [1, -walk, 0, 0],
      [120, 0, 0, 0],
    ]);
    keyPath(doc, ben, [
      [1, -walk - 1.2, 0, -0.8],
      [120, -1.2, 0, -0.8],
    ]);
    keyPath(doc, pip, [
      [1, -walk - 0.6, 0, 0.9],
      [120, -0.6, 0, 0.9],
    ]);
    const { solve } = ops.run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ada', 'Ben', 'Pip'],
      framing,
      move: 'locked_off',
      frame_start: 1,
      frame_end: 120,
      // rideo's board: Ada in the middle, Pip on the right, walking right
      layout: [
        { subject: 'Ada', side: 'centre', facing: 'right' },
        { subject: 'Pip', side: 'right', facing: 'right' },
      ],
    });
    return { doc, ops, solve, ada, pip };
  }

  it('a camera that agrees with the plan and keeps every subject is taken', () => {
    const { doc, solve, ada, pip } = walkIn('wide', 9);
    expect(solve).toMatchObject({ refit: true, agrees: true, gave_up: [], out_of_frame: [] });
    expect(issuesOf(doc, 'plan_mismatch')).toEqual([]);
    expect(issuesOf(doc, 'subject_out_of_frame')).toEqual([]);
    // fitted at its first frame only, the same camera would lose Ada and Pip by the end
    const scene = new DeskScene(doc);
    const shot = getShots(doc)[0];
    const spec = { ...shotSpec(scene, shot, 0), angle: solve.angle };
    const first = solveCamera(scene, spec, 1);
    const lost = shotFitReport(scene, spec, shot, {
      position: first.position,
      target: first.target,
      lens: first.lens_mm,
    }).out_of_frame;
    expect(lost.map((o) => o.subject).sort()).toEqual([ada, pip].sort());
  });

  it('when none keeps both, the subjects in frame win and the result says the plan was given up', () => {
    const { doc, ops, solve } = walkIn('medium', 4);
    expect(solve).toMatchObject({ agrees: false, gave_up: ['plan'], out_of_frame: [] });
    expect(solve.distance_ratio).toBeGreaterThan(1);
    expect(issuesOf(doc, 'subject_out_of_frame')).toEqual([]);
    expect(issuesOf(doc, 'plan_mismatch')).toHaveLength(1);
    expect(ops.reports.map((r) => r.message)).toEqual([
      expect.stringContaining(
        'its camera disagrees with its planned layout (plan_mismatch): a camera that agrees with it lets a ' +
          'subject leave the frame, and keeping the subjects in frame comes first',
      ),
    ]);
  });
});

describe('the subjects read once for the whole solve', () => {
  /** Shot 1 on Ada, then shot 2 on a lantern its camera carries (`how`: parented or constrained). */
  function lanternScene(how: 'parent' | 'constraint') {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    standIn(doc, 'Ada', 0, 0, 0);
    ops.run('desk.shot_add', {
      subjects: ['Ada'],
      framing: 'medium',
      frame_start: 1,
      frame_end: 48,
      solve: false,
    });
    const camA = getShots(doc)[0].camera!;
    const lantern = prop(doc, 'Lantern', 3, 3, 0.3);
    if (how === 'parent') doc.updateObject(lantern, { parent: camA, location: [0.4, 0, -1.5] });
    else
      doc.updateObject(lantern, {
        constraints: [createConstraint('COPY_LOCATION', { target: camA })],
      });
    ops.run('desk.shot_add', {
      subjects: ['Lantern'],
      framing: 'medium',
      frame_start: 49,
      frame_end: 96,
      solve: false,
    });
    return { doc, ops, camA };
  }

  for (const how of ['parent', 'constraint'] as const)
    it(`an object ${how === 'parent' ? 'parented' : 'constrained'} to a camera another shot frames: fresh readings`, () => {
      const { doc, ops } = lanternScene(how);
      // the lantern follows shot 1's camera, so the subjects cannot be read once for the whole solve
      expect(new DeskScene(doc).camerasLeadNothing()).toBe(false);
      ops.run('desk.shot_solve');
      const shots = getShots(doc);
      const cam = shots[1].camera!;
      const solved = new DeskScene(doc).camera(cam, shots[1].frame_start)!;
      // solving shot 2 again reads the lantern where shot 1's camera put it: the same camera
      ops.run('desk.shot_solve', { shots: [shots[1].id] });
      const again = new DeskScene(doc).camera(cam, shots[1].frame_start)!;
      expect(near(again.position, solved.position, 1e-9)).toBe(true);
      expect(near(again.forward, solved.forward, 1e-9)).toBe(true);
    });

  it('a scene whose cameras lead nothing is read once', () => {
    const doc = deskDoc();
    const { run } = deskOperators(doc);
    standIn(doc, 'Ada', 0, 0, 0);
    run('desk.shot_add', { subjects: ['Ada'], framing: 'medium' });
    prop(doc, 'Lantern', 1, 1, 0.3);
    expect(new DeskScene(doc).camerasLeadNothing()).toBe(true);
  });
});

describe('subjects hidden behind a bystander (occluded_subject)', () => {
  /**
   * Ben (an adult, a rigged actor) facing the front of the set, and a bystander `kind` in front of him
   * (her back to the camera, else `facing`).
   */
  function rigged(kind: 'adult' | 'child', at: [number, number], facing = 180) {
    const doc = deskDoc();
    const ben = createActor(doc, { kind: 'adult', name: 'Ben', location: ed(0, 0, 0), facing_deg: 0 }).actor;
    createActor(doc, { kind, name: 'Ada', location: ed(at[0], 0, at[1]), facing_deg: facing });
    const scene = new DeskScene(doc);
    const spec: SolveSpec = {
      framing: 'medium',
      angle: 'front',
      height: 'eye',
      move: 'locked_off',
      lens_mm: FRAMING_TABLE.medium.lens_mm,
      subjects: [ben],
    };
    const rideo = solveCamera(scene, spec, 1);
    const pose = { position: rideo.position, target: rideo.target, lens: rideo.lens_mm };
    return { doc, ben, occluded: shotOcclusions(scene, spec, { frame_start: 1, frame_end: 120 }, pose) };
  }

  it('a bystander’s posed body hides a subject’s face, or only the body below it', () => {
    // an adult standing in front of Ben hides his face at every frame desk.check samples
    const adult = rigged('adult', [0.05, 0.9]);
    expect(adult.occluded).toEqual([
      { subject: adult.ben, name: 'Ben', by: ['Ada'], frames: [1, 61, 120], body_frames: [] },
    ]);
    // a child there hides his body below his eyes (Kite Day S11: Ada seated before Ben)
    const child = rigged('child', [0.05, 0.9]);
    expect(child.occluded).toEqual([
      { subject: child.ben, name: 'Ben', by: ['Ada'], frames: [], body_frames: [1, 61, 120] },
    ]);
    // beside the shot she hides nothing
    expect(rigged('adult', [1.5, 0.9]).occluded).toEqual([]);
  });

  it('a rigged bystander hides what its posed parts cover, not a column around it', () => {
    // 16 cm aside his face shows past her head while her shoulders still hide his body (a column
    // OCCLUDER_RADIUS_M around her would hide his face)
    const aside = rigged('adult', [0.16, 0.9]);
    expect(aside.occluded).toEqual([
      { subject: aside.ben, name: 'Ben', by: ['Ada'], frames: [], body_frames: [1, 61, 120] },
    ]);
    // side on to the camera, 19 cm aside, she hides nothing of him
    expect(rigged('adult', [0.19, 0.9], 90).occluded).toEqual([]);
  });

  it('a subject out of the frame is not hidden behind anyone: it is out of frame', () => {
    // Ben walks 6 m to his left in a locked-off medium, out of it from the middle of the shot on, and
    // Ada stands halfway along the camera's line of sight to his eyes at the middle frame
    const doc = deskDoc();
    const ben = standIn(doc, 'Ben', 0, 0, 0, 1.8);
    keyPath(doc, ben, [
      [1, 0, 0, 0],
      [120, 6, 0, 0],
    ]);
    const spec: SolveSpec = {
      framing: 'medium',
      angle: 'front',
      height: 'eye',
      move: 'locked_off',
      lens_mm: FRAMING_TABLE.medium.lens_mm,
      subjects: [ben],
    };
    const rideo = solveCamera(new DeskScene(doc), spec, 1);
    const eyes = new DeskScene(doc).subject(ben, 61)!.eyes;
    // halfway, in rideo's coordinates (editor x, y is rideo x, −z)
    standIn(doc, 'Ada', (rideo.position[0] + eyes[0]) / 2, -(rideo.position[1] + eyes[1]) / 2, 180, 1.8);
    const scene = new DeskScene(doc);
    const span = { frame_start: 1, frame_end: 120 };
    const pose = { position: rideo.position, target: rideo.target, lens: rideo.lens_mm };
    expect(shotFitReport(scene, spec, span, pose).out_of_frame).toEqual([
      { subject: ben, name: 'Ben', frames: [61, 120] },
    ]);
    expect(shotOcclusions(scene, spec, span, pose)).toEqual([]);
    // through a lens wide enough to frame him at the middle frame, she hides his face there
    const wide = { ...pose, lens: 12 };
    expect(shotFitReport(scene, spec, span, wide).out_of_frame).toEqual([
      { subject: ben, name: 'Ben', frames: [120] },
    ]);
    expect(shotOcclusions(scene, spec, span, wide)).toEqual([
      { subject: ben, name: 'Ben', by: ['Ada'], frames: [61], body_frames: [] },
    ]);
  });

  /** Ben (1.8 m) and a melon, and Ada (`height`) at `adaAt`, her back to the camera, in a front medium. */
  function standIns(adaAt: [number, number], height = 1.7) {
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const ben = standIn(doc, 'Ben', 0, 0, 0, 1.8);
    prop(doc, 'Melon', 0.4, 0.2, 0.25);
    standIn(doc, 'Ada', adaAt[0], adaAt[1], 180, height);
    const { solve } = ops.run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ben', 'Melon'],
      framing: 'medium',
      angle: 'front',
      frame_start: 1,
      frame_end: 120,
    });
    const scene = new DeskScene(doc);
    const shot = getShots(doc)[0];
    const spec = shotSpec(scene, shot, 0);
    const rideo = solveCamera(scene, spec, 1);
    const rideoPose = { position: rideo.position, target: rideo.target, lens: rideo.lens_mm };
    return { doc, ben, solve, reports: ops.reports, scene, shot, spec, rideo, rideoPose };
  }

  it('a camera a bystander blocks steps aside to see past them', () => {
    // between rideo's camera and Ben (S11)
    const t = standIns([0.1, 1]);
    expect(shotOcclusions(t.scene, t.spec, t.shot, t.rideoPose).map((o) => o.name)).toContain('Ben');
    // the solve's camera sees past her: a small turn about the aim, at rideo's distance and height
    expect(t.solve.occluded).toEqual([]);
    expect(t.reports).toEqual([]);
    const view = t.scene.camera(t.shot.camera!, 1)!;
    // turned to look at the subjects from at most 20° aside, at the same height
    const a = [t.rideo.target[0] - t.rideo.position[0], t.rideo.target[1] - t.rideo.position[1]];
    const b = [view.forward[0], view.forward[1]];
    const turn = (Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180) / Math.PI;
    expect(turn).toBeGreaterThan(5);
    expect(turn).toBeLessThan(21);
    expect(view.position[2]).toBeCloseTo(t.rideo.position[2], 3);
    expect(issuesOf(t.doc, 'subject_out_of_frame')).toEqual([]);
  });

  it('a camera a row of bystanders blocks rises to look over them', () => {
    // five children 1.5 m tall in a row a metre in front of Ben (1.8 m): no step aside sees past them
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const ben = standIn(doc, 'Ben', 0, 0, 0, 1.8);
    for (let i = 0; i < 5; i++) standIn(doc, `Kid ${i + 1}`, (i - 2) * 0.45, 1, 180, 1.5);
    const { solve } = ops.run<{ solve: SolvedShot }>('desk.shot_add', {
      subjects: ['Ben'],
      framing: 'medium',
      angle: 'front',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 48,
    });
    const scene = new DeskScene(doc);
    const shot = getShots(doc)[0];
    const spec = shotSpec(scene, shot, 0);
    const rideo = solveCamera(scene, spec, 1);
    // from rideo's camera the middle one hides his body
    expect(
      shotOcclusions(scene, spec, shot, {
        position: rideo.position,
        target: rideo.target,
        lens: rideo.lens_mm,
      }),
    ).toEqual([{ subject: ben, name: 'Ben', by: ['Kid 3'], frames: [], body_frames: [1, 25, 48] }]);
    // the solve's camera stands a metre higher at the same place and sees him whole
    const view = scene.camera(shot.camera!, 1)!;
    const raised: Vec3 = [rideo.position[0], rideo.position[1], rideo.position[2] + 1];
    expect(near(view.position, raised, 1e-6)).toBe(true);
    expect(solve.occluded).toEqual([]);
    expect(ops.reports).toEqual([]);
    expect(issuesOf(doc, 'subject_out_of_frame')).toEqual([]);
  });

  it('a step aside that would lose a subject from the frame is not taken', () => {
    // Ben walks 2.1 m across a front medium: from rideo's distance his eyes come near its edges at both ends
    const doc = deskDoc();
    const ops = deskOperators(doc);
    const ben = standIn(doc, 'Ben', -1.05, 0, 0, 1.8);
    keyPath(doc, ben, [
      [1, -1.05, 0, 0],
      [120, 1.05, 0, 0],
    ]);
    ops.run('desk.shot_add', {
      subjects: ['Ben'],
      framing: 'medium',
      angle: 'front',
      move: 'locked_off',
      frame_start: 1,
      frame_end: 120,
    });
    const cam = getShots(doc)[0].camera!;
    const fitted = new DeskScene(doc).camera(cam, 1)!;
    // a tall bystander halfway along the camera's line of sight to his eyes at the first frame
    const eyes = new DeskScene(doc).subject(ben, 1)!.eyes;
    standIn(doc, 'Ada', (fitted.position[0] + eyes[0]) / 2, -(fitted.position[1] + eyes[1]) / 2, 180, 2.4);
    const { shots } = ops.run<{ shots: SolvedShot[] }>('desk.shot_solve', { shots: ['Shot 1'] });
    // a 20° turn would see past her but push him out of the frame at its other end: the camera stays,
    // and the solve says she hides him
    const view = new DeskScene(doc).camera(cam, 1)!;
    expect(near(view.position, fitted.position, 1e-6)).toBe(true);
    expect(near(view.forward, fitted.forward, 1e-6)).toBe(true);
    expect(shots[0].out_of_frame).toEqual([]);
    expect(shots[0].occluded).toEqual([
      { subject: ben, name: 'Ben', by: ['Ada'], frames: [1], body_frames: [] },
    ]);
    expect(issuesOf(doc, 'subject_out_of_frame')).toEqual([]);
    expect(ops.reports.map((r) => r.message)).toEqual([
      expect.stringContaining('Ben (frame 1) is hidden behind Ada, who is not in the shot'),
    ]);
  });

  it('when no small step sees past a bystander, the solve says who hides whom', () => {
    // a tall bystander right in front of Ben: no turn of 20° or rise of 1 m sees past her
    const t = standIns([0, 0.3], 2.4);
    expect(t.solve.occluded).toEqual([
      { subject: t.ben, name: 'Ben', by: ['Ada'], frames: [1, 61, 120], body_frames: [] },
    ]);
    expect(t.reports.map((r) => r.level)).toEqual(['WARNING']);
    expect(t.reports[0].message).toContain(
      'Ben (frames 1, 61, 120) is hidden behind Ada, who is not in the shot (occluded_subject: restage, ' +
        'add Ada to its subjects, or choose another angle or height)',
    );
    // beside the shot she hides nothing
    const beside = standIns([1.5, 0]);
    expect(beside.solve.occluded).toEqual([]);
    expect(beside.reports).toEqual([]);
  });
});
