import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import { defaultRigidBody } from '../src/doc/defaults';
import type { Interpolation, ShotData } from '../src/doc/types';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { DeskScene, rideoSunVector } from '../src/desk/layout';
import { getShots, setDeskSettings, setShots } from '../src/desk/shots';
import { FRAMING_TABLE, solveCamera, type SolveSpec } from '../src/desk/solver';
import { layoutView, viewFacing } from '../src/desk/plan';
import {
  DESK_ISSUE_CODES,
  DESK_ISSUE_SEVERITY,
  blockingLine,
  blockingMoves,
  checkShots,
  type DeskIssue,
} from '../src/desk/checks';
import { buildSet, skySunRotation } from '../src/desk/set';
import {
  deskDoc,
  deskOperators,
  ed,
  expectNear,
  landmark,
  prop,
  rideoCamera,
  standIn,
} from './desk-fixtures';

/*
 * Continuity checks (desk/checks.ts): rideo's blockingIssues on rideo's own crafted blocking (the
 * same issues, frozen from running rideo), each of the desk's own issue codes raised by a crafted
 * scene and not by a clean one, and rideo's blocking sentences (blockingLine, blockingMoves) and
 * layouts word for word.
 */

type Shot = Partial<ShotData> & Pick<ShotData, 'name' | 'frame_start' | 'frame_end'>;

/** Keys an object's location at rideo floor points (x, z) per frame. */
function walk(
  doc: SceneDoc,
  id: string,
  keys: [number, number, number][],
  interpolation: Interpolation = 'LINEAR',
) {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: i });
    for (const [f, x, z] of keys) fc = insertKeyframe(fc, f, ed(x, 0, z)[i], interpolation);
    doc.setFCurve(fc);
  }
}

/** Stores the shots and returns them by name. */
function shots(doc: SceneDoc, list: Shot[]): Record<string, ShotData> {
  setShots(doc, list);
  return Object.fromEntries(getShots(doc).map((s) => [s.name, s]));
}

const codes = (issues: DeskIssue[]) => issues.map((i) => i.code).sort();

/** A camera solved by the desk's solver from `spec`, placed as a camera object. */
function solvedCameraOf(doc: SceneDoc, spec: SolveSpec, name = 'Solved', frame = 1) {
  const c = solveCamera(new DeskScene(doc), spec, frame);
  const r = (v: Vec3) => [v[0], v[2], -v[1]];
  return rideoCamera(doc, name, r(c.position), r(c.target), c.lens_mm);
}

/** A camera solved by the desk's solver for `subjects` (front, eye height), placed as a camera object. */
function solvedCamera(
  doc: SceneDoc,
  name: string,
  framing: keyof typeof FRAMING_TABLE,
  subjects: string[],
  frame = 1,
) {
  const c = solveCamera(
    new DeskScene(doc),
    { framing, angle: 'front', height: 'eye', move: null, lens_mm: FRAMING_TABLE[framing].lens_mm, subjects },
    frame,
  );
  const r = (v: Vec3) => [v[0], v[2], -v[1]];
  return rideoCamera(doc, name, r(c.position), r(c.target), c.lens_mm);
}

describe("rideo's blockingIssues", () => {
  it("raises on rideo's crafted blocking exactly the issues rideo raises", () => {
    const doc = deskDoc();
    setDeskSettings(doc, { set_width: 8, set_depth: 6 });
    landmark(doc, 'shed', 0, 6, 2, 2, 3);
    const A = standIn(doc, 'Ada', -0.5, 0, 90);
    const B = standIn(doc, 'Ben', 0.5, 0, 270);
    const C = standIn(doc, 'Cy', 0.6, 0.1, 0);
    // Ada's mark in shot 2 is off the set, at x −5
    walk(
      doc,
      A,
      [
        [1, -0.5, 0],
        [25, -5, 0],
        [49, -0.5, 0],
      ],
      'CONSTANT',
    );
    const s = shots(doc, [
      {
        name: 'S1',
        camera: rideoCamera(doc, 'C1', [0, 1.6, 6], [0, 1, 0], 24),
        frame_start: 1,
        frame_end: 24,
        framing: 'wide',
        subjects: [A, B],
      },
      {
        name: 'S2',
        camera: rideoCamera(doc, 'C2', [-5, 1.6, -3], [-5, 1.5, 0], 85),
        frame_start: 25,
        frame_end: 48,
        framing: 'close_up',
        subjects: [A],
      },
      {
        name: 'S3',
        camera: rideoCamera(doc, 'C3', [0, 1.6, 3], [0, 1.2, 0], 35),
        frame_start: 49,
        frame_end: 72,
        framing: 'medium',
        subjects: [A, B, C],
        layout: [{ subject: A, side: 'right', facing: 'away' }],
      },
      {
        name: 'S4',
        camera: rideoCamera(doc, 'C4', [3, 1.6, 0.5], [-3, 1.6, 0.5], 50),
        frame_start: 73,
        frame_end: 96,
        framing: 'medium',
        subjects: [B],
      },
    ]);
    const { issues: all, summary } = checkShots(doc);
    // rideo's issues; the desk adds its own occluded_subject: Cy stands 14 cm in front of Ben
    const issues = all.filter((i) => i.code !== 'occluded_subject');
    expect(all.filter((i) => i.code === 'occluded_subject').map((i) => [i.shot, i.objects])).toEqual([
      [s.S1.id, [B, C]],
      [s.S4.id, [B, C]],
    ]);
    const got = issues.map((i) => ({ code: i.code, shot: i.shot, objects: i.objects, severity: i.severity }));
    const shed = doc.findObjectByName('shed')!.id;
    // rideo: camera_inside s1, absent_in_frame s1 Cy, line_crossed s2, outside_set s2 Ada, plan_mismatch s3,
    // actors_overlap s3 Ben, absent_in_frame s4 Ada and Cy
    expect(got).toEqual(
      expect.arrayContaining([
        { code: 'camera_inside', shot: s.S1.id, objects: [s.S1.camera, shed], severity: 'error' },
        { code: 'absent_in_frame', shot: s.S1.id, objects: [C], severity: 'warning' },
        { code: 'line_crossed', shot: s.S2.id, objects: [s.S2.camera, A, B], severity: 'error' },
        { code: 'outside_set', shot: s.S2.id, objects: [A], severity: 'warning' },
        { code: 'plan_mismatch', shot: s.S3.id, objects: [A], severity: 'warning' },
        { code: 'actors_overlap', shot: s.S3.id, objects: [B, C], severity: 'warning' },
        { code: 'absent_in_frame', shot: s.S4.id, objects: [A], severity: 'warning' },
        { code: 'absent_in_frame', shot: s.S4.id, objects: [C], severity: 'warning' },
      ]),
    );
    expect(issues).toHaveLength(8);
    // rideo's sentences, with the shot's name for its number
    const message = (code: string, shot: string) =>
      issues.find((i) => i.code === code && i.shot === shot)!.message;
    expect(message('camera_inside', s.S1.id)).toMatch(/^The camera of shot 'S1' stands inside shed/);
    expect(message('line_crossed', s.S2.id)).toBe(
      "The camera of shot 'S2' crossed the line between Ada and Ben: they swap sides on the cut",
    );
    expect(message('outside_set', s.S2.id)).toBe("Ada stands outside the set in shot 'S2'");
    expect(message('plan_mismatch', s.S3.id)).toBe(
      "The camera of shot 'S3' disagrees with its plan: Ada is in the centre, not right of frame; Ada faces right, not away",
    );
    expect(message('actors_overlap', s.S3.id)).toBe("Ben and Cy stand in the same place in shot 'S3'");
    expect(message('absent_in_frame', s.S1.id)).toBe("Cy is not in shot 'S1' but stands in its frame");
    expect(summary).toBe(
      '4 shots checked: 2 errors, 8 warnings, 0 info (camera_inside, absent_in_frame, occluded_subject, outside_set, line_crossed, actors_overlap, plan_mismatch)',
    );
    // checking some shots reports theirs only (the line is still the scene's)
    expect(codes(checkShots(doc, { shots: ['S2'] }).issues)).toEqual(['line_crossed', 'outside_set']);
  });

  it('raises nothing on a clean cut', () => {
    const doc = deskDoc();
    setDeskSettings(doc, { set_width: 12, set_depth: 10 });
    const A = standIn(doc, 'Ada', -0.8, 0, 90);
    const B = standIn(doc, 'Ben', 0.8, 0, 270, 1.8);
    shots(doc, [
      {
        name: 'Two',
        camera: solvedCamera(doc, 'Cam 1', 'wide', [A, B]),
        frame_start: 1,
        frame_end: 48,
        subjects: [A, B],
        framing: 'wide',
      },
      {
        name: 'Ada',
        camera: rideoCamera(doc, 'Cam 2', [0.747, 1.581, 1.083], [-0.8, 1.564, 0], 85),
        frame_start: 49,
        frame_end: 96,
        subjects: [A],
        framing: 'close_up',
      },
    ]);
    const r = checkShots(doc);
    expect(r.issues).toEqual([]);
    expect(r.summary).toBe('2 shots checked: no issues');
    expect(r.lines).toHaveLength(2);
    expect(r.layouts.map((l) => l.layout.length)).toEqual([2, 1]);
  });

  it('gives each code its severity', () => {
    expect(Object.keys(DESK_ISSUE_SEVERITY).sort()).toEqual([...DESK_ISSUE_CODES].sort());
    expect(DESK_ISSUE_CODES.filter((c) => DESK_ISSUE_SEVERITY[c] === 'error').sort()).toEqual([
      'camera_inside',
      'line_crossed',
      'missing_camera',
      'subject_out_of_frame',
      'tether_detached',
      'walks_on_water',
    ]);
    expect(DESK_ISSUE_CODES.filter((c) => DESK_ISSUE_SEVERITY[c] === 'info').sort()).toEqual([
      'physics_unbaked',
      'shot_gap',
    ]);
  });
});

describe("the desk's own checks", () => {
  /** Ada alone at the origin facing the audience, framed medium from the front over frames 1–48. */
  function alone() {
    const doc = deskDoc();
    const A = standIn(doc, 'Ada', 0, 0, 0);
    const cam = solvedCamera(doc, 'Cam', 'medium', [A]);
    return { doc, A, cam };
  }

  it('missing_camera, empty_shot and duration_clamped', () => {
    const { doc, A, cam } = alone();
    shots(doc, [
      { name: 'Ok', camera: cam, frame_start: 1, frame_end: 48, subjects: [A] },
      { name: 'No camera', frame_start: 49, frame_end: 96, subjects: [A] },
      // (a camera turned away from Ada: she would be absent_in_frame in front of it)
      {
        name: 'Nobody',
        camera: rideoCamera(doc, 'Away', [0, 1.6, 3], [0, 1.6, 10], 35),
        frame_start: 97,
        frame_end: 144,
        subjects: [],
      },
    ]);
    const r = checkShots(doc);
    expect(codes(r.issues)).toEqual(['empty_shot', 'missing_camera']);
    expect(r.issues.find((i) => i.code === 'missing_camera')!.severity).toBe('error');
    expect(r.lines.find((l) => l.line === '')).toBeDefined();
    // the video model makes 2–3 s clips: a 2 s shot is fine, a 4 s one too long, a 1 s one too short
    setDeskSettings(doc, { max_shot_s: 3, min_shot_s: 2 });
    shots(doc, [
      { name: 'Fits', camera: cam, frame_start: 1, frame_end: 48, subjects: [A] },
      { name: 'Long', camera: cam, frame_start: 49, frame_end: 144, subjects: [A] },
      { name: 'Short', camera: cam, frame_start: 145, frame_end: 168, subjects: [A] },
    ]);
    const clamped = checkShots(doc).issues.filter((i) => i.code === 'duration_clamped');
    expect(clamped.map((i) => getShots(doc).find((s) => s.id === i.shot)!.name)).toEqual(['Long', 'Short']);
    expect(clamped[0].message).toMatch(/lasts 4\.00 s; the video model makes at most 3 s/);
    expect(clamped[1].message).toMatch(/lasts 1\.00 s; the video model makes at least 2 s/);
  });

  it('subject_out_of_frame on the frames it leaves, but not for the shoulder of an over-the-shoulder', () => {
    const { doc, A, cam } = alone();
    // Ada walks 6 m to the right during the shot: out of frame by its middle
    walk(doc, A, [
      [1, 0, 0],
      [48, 6, 0],
    ]);
    const s = shots(doc, [{ name: 'Walk', camera: cam, frame_start: 1, frame_end: 48, subjects: [A] }]);
    const out = checkShots(doc).issues.filter((i) => i.code === 'subject_out_of_frame');
    expect(out).toEqual([
      {
        code: 'subject_out_of_frame',
        severity: 'error',
        shot: s.Walk.id,
        objects: [A],
        message: "Ada is not in the frame of shot 'Walk' (frames 25, 48)",
      },
    ]);
    // over the shoulder (the default angle of the framing for two actors): the shoulder is exempt
    const two = deskDoc();
    const a = standIn(two, 'Ada', -0.8, 0, 90);
    const b = standIn(two, 'Ben', 0.8, 0, 270);
    const ots = rideoCamera(two, 'OTS', [-1.382, 1.462, 0.339], [0.8, 1.674, 0], 50);
    shots(two, [
      { name: 'OTS', camera: ots, frame_start: 1, frame_end: 24, framing: 'over_shoulder', subjects: [a, b] },
    ]);
    expect(checkShots(two).issues).toEqual([]);
    // the same camera as a medium two-shot leaves Ada out
    shots(two, [
      { name: 'OTS', camera: ots, frame_start: 1, frame_end: 24, framing: 'medium', subjects: [a, b] },
    ]);
    expect(codes(checkShots(two).issues)).toEqual(['subject_out_of_frame']);
  });

  it("subject_out_of_frame spares what a shot leaves out by design: a viewer, an insert's cast, a turn away", () => {
    // a point of view from Ada's eyes at Ben: Ada stands behind the camera
    const pov = deskDoc();
    const a = standIn(pov, 'Ada', -0.8, 0, 90);
    const b = standIn(pov, 'Ben', 0.8, 0, 270);
    const c = solveCamera(
      new DeskScene(pov),
      { framing: 'pov', angle: 'pov', height: 'eye', move: null, lens_mm: 28, subjects: [a, b] },
      1,
    );
    const r = (v: Vec3) => [v[0], v[2], -v[1]];
    const povCam = rideoCamera(pov, 'POV', r(c.position), r(c.target), c.lens_mm);
    shots(pov, [
      { name: 'POV', camera: povCam, frame_start: 1, frame_end: 24, framing: 'pov', subjects: [a, b] },
    ]);
    expect(codes(checkShots(pov).issues)).toEqual([]);
    // the same camera framed as a medium two-shot leaves Ada out
    shots(pov, [
      { name: 'POV', camera: povCam, frame_start: 1, frame_end: 24, framing: 'medium', subjects: [a, b] },
    ]);
    expect(checkShots(pov).issues.map((i) => [i.code, i.objects])).toEqual([['subject_out_of_frame', [a]]]);

    // an insert frames its prop: its cast is out of frame by design, the prop is not
    const ins = deskDoc();
    const ada = standIn(ins, 'Ada', 0.5, 0.2, 45);
    const mug = prop(ins, 'mug', -0.3, 0.6, 0.1);
    const insert = (id: string) =>
      solvedCameraOf(ins, {
        framing: 'insert',
        angle: 'front',
        height: 'eye',
        move: null,
        lens_mm: 85,
        subjects: [id],
      });
    const onMug = insert(mug);
    shots(ins, [
      {
        name: 'Insert',
        camera: onMug,
        frame_start: 1,
        frame_end: 24,
        framing: 'insert',
        subjects: [ada, mug],
      },
    ]);
    expect(codes(checkShots(ins).issues)).toEqual([]);
    const away = rideoCamera(ins, 'Away', [3, 0.2, 3], [6, 0.2, 6], 85);
    shots(ins, [
      {
        name: 'Insert',
        camera: away,
        frame_start: 1,
        frame_end: 24,
        framing: 'insert',
        subjects: [ada, mug],
      },
    ]);
    expect(checkShots(ins).issues.map((i) => [i.code, i.objects])).toEqual([['subject_out_of_frame', [mug]]]);

    // pans, tilts and whip pans turn away from their subjects by design: their first frame counts;
    // other moves count at every sample: the solve keeps the subjects in frame through a dolly, a
    // longer dolly keyed over the shot afterwards loses them
    for (const move of ['whip_pan', 'pan_left', 'tilt_up', 'dolly_right'] as const) {
      const d = deskDoc();
      const ops = deskOperators(d);
      standIn(d, 'Ada', -0.8, 0, 90);
      standIn(d, 'Ben', 0.8, 0, 270);
      ops.run('desk.shot_add', { subjects: ['Ada', 'Ben'], framing: 'close_up', move });
      const out = () => checkShots(d).issues.filter((i) => i.code === 'subject_out_of_frame');
      expect(out(), move).toEqual([]);
      ops.run('desk.camera_move', { shot: getShots(d)[0].id, move, amount: 4 });
      expect(out().length > 0, move).toBe(move === 'dolly_right');
    }
  });

  it('camera_inside a landmark or under the ground, not over water or a plane', () => {
    const { doc, A, cam } = alone();
    shots(doc, [{ name: 'Shot', camera: cam, frame_start: 1, frame_end: 24, subjects: [A] }]);
    // water taller than the camera stands: cameras may stand in it
    const lake = landmark(doc, 'lake', 0, 2.131, 4, 4, 3);
    expect(checkShots(doc).issues).toEqual([]);
    doc.removeObjects([lake]);
    // a label that only starts with a water word is solid
    const cabin = landmark(doc, 'the lakeside cabin', 0, 2.131, 4, 4, 3);
    expect(checkShots(doc).issues.map((i) => [i.code, i.objects])).toEqual([['camera_inside', [cam, cabin]]]);
    doc.removeObjects([cabin]);
    const hut = landmark(doc, 'hut', 0, 2.131, 1, 1, 3);
    const inside = checkShots(doc).issues;
    expect(inside.map((i) => [i.code, i.objects])).toEqual([['camera_inside', [cam, hut]]]);
    doc.removeObjects([hut]);
    buildSet(doc, {
      width: 12,
      depth: 10,
      ground: 'grass',
      interior: false,
      sun_azimuth_deg: 135,
      sun_elevation_deg: 40,
      sky: true,
    });
    expect(checkShots(doc).issues).toEqual([]);
    doc.updateObject(cam, { location: ed(0, -0.5, 2.131) });
    const under = checkShots(doc).issues;
    expect(under.map((i) => i.code)).toContain('camera_inside');
    expect(under.find((i) => i.code === 'camera_inside')!.message).toMatch(/stands inside the ground/);
  });

  it('screen_direction when an actor crosses the frame one way, then the other after a cut', () => {
    const doc = deskDoc();
    const A = standIn(doc, 'Ada', -1, 0, 90);
    const front = rideoCamera(doc, 'Front', [0, 1.6, 6], [0, 1, 0], 24);
    // Ada walks left to right in shot 1 and back right to left in shot 2
    walk(doc, A, [
      [1, -1, 0],
      [48, 1, 0],
      [96, -1, 0],
    ]);
    const s = shots(doc, [
      { name: 'There', camera: front, frame_start: 1, frame_end: 48, subjects: [A] },
      { name: 'Back', camera: front, frame_start: 48, frame_end: 96, subjects: [A], continuity: 'cut' },
    ]);
    const dir = checkShots(doc).issues.filter((i) => i.code === 'screen_direction');
    expect(dir.map((i) => [i.shot, i.objects])).toEqual([[s.Back.id, [A]]]);
    // a continuous shot carries the action on: no warning
    shots(doc, [
      { name: 'There', camera: front, frame_start: 1, frame_end: 48, subjects: [A] },
      {
        name: 'Back',
        camera: front,
        frame_start: 48,
        frame_end: 96,
        subjects: [A],
        continuity: 'continuous',
      },
    ]);
    expect(checkShots(doc).issues.filter((i) => i.code === 'screen_direction')).toEqual([]);
  });

  it('jump_cut between near-identical setups of the same subjects, not after a real change of angle', () => {
    const { doc, A } = alone();
    const c1 = rideoCamera(doc, 'C1', [0, 1.581, 2.131], [0, 1.224, 0], 35);
    const c2 = rideoCamera(doc, 'C2', [0.3, 1.581, 2.1], [0, 1.224, 0], 35);
    const c3 = rideoCamera(doc, 'C3', [2.131, 1.581, 0], [0, 1.224, 0], 35);
    const s = shots(doc, [
      { name: 'A', camera: c1, frame_start: 1, frame_end: 24, subjects: [A] },
      { name: 'B', camera: c2, frame_start: 25, frame_end: 48, subjects: [A] },
      { name: 'C', camera: c3, frame_start: 49, frame_end: 72, subjects: [A] },
    ]);
    const jumps = checkShots(doc).issues.filter((i) => i.code === 'jump_cut');
    expect(jumps.map((i) => i.shot)).toEqual([s.B.id]);
    expect(jumps[0].message).toMatch(/camera turned 8° \(less than 30°\)/);
  });

  it('shot_gap beyond the pre-roll, and physics_unbaked for live rigid bodies', () => {
    const { doc, A, cam } = alone();
    const s = shots(doc, [
      { name: 'One', camera: cam, frame_start: 1, frame_end: 24, subjects: [A] },
      { name: 'Two', camera: cam, frame_start: 37, frame_end: 60, subjects: [A], pre_roll: 12 },
      { name: 'Three', camera: cam, frame_start: 80, frame_end: 100, subjects: [A], pre_roll: 12 },
    ]);
    const gaps = checkShots(doc).issues.filter((i) => i.code === 'shot_gap');
    expect(gaps.map((i) => [i.shot, i.severity])).toEqual([[s.Three.id, 'info']]);
    expect(gaps[0].message).toMatch(/^19 scene frames between shot 'Two' \(ends at 60\) and shot 'Three'/);
    const ball = landmark(doc, 'ball', 3, -3, 0.3, 0.3, 0.3);
    doc.updateObject(ball, { rigid_body: defaultRigidBody('ACTIVE') });
    const live = checkShots(doc).issues.filter((i) => i.code === 'physics_unbaked');
    expect(live).toMatchObject([{ shot: null, objects: [ball], severity: 'info' }]);
    doc.updateObject(ball, { rigid_body: { ...defaultRigidBody('ACTIVE'), kinematic: true } });
    expect(checkShots(doc).issues.filter((i) => i.code === 'physics_unbaked')).toEqual([]);
  });
});

describe("rideo's blocking sentences and layouts", () => {
  it("says where the sun is: rideo's default sun from a front camera is ahead of it, behind the scene", () => {
    const doc = deskDoc();
    const A = standIn(doc, 'Ada', 0, 0, 0);
    const cam = rideoCamera(doc, 'Cam', [0, 1.581, 2.131], [0, 1.224, 0], 35);
    const s = shots(doc, [
      { name: 'S', camera: cam, frame_start: 1, frame_end: 24, framing: 'medium', subjects: [A] },
    ]);
    expect(blockingLine(doc, s.S, 1)).toBe(
      'Blocking: Ada is in the centre, facing the camera. Light: the sun is ahead of the camera, behind the scene.',
    );
    // rideo's sun vector for 135°/40°, in editor axes
    expectNear(rideoSunVector(135, 40), [0.5416752204197018, 0.5416752204197018, 0.6427876096865393], 1e-12);
  });

  /** rideo's layout scene: a lake and a barn behind, Ada walking right while Ben waits. */
  function layoutScene() {
    const doc = deskDoc();
    setDeskSettings(doc, { set_width: 12, set_depth: 10 });
    landmark(doc, 'the lake', 0, -4, 6, 2, 0.05);
    landmark(doc, 'a barn', 3, -4.5, 3, 2, 3);
    const A = standIn(doc, 'Ada', -1, 0.8, 90);
    const B = standIn(doc, 'Ben', 1, -1.5, 0);
    walk(doc, A, [
      [1, -1, 0.8],
      [48, 1.5, 0.8],
    ]);
    const cam = rideoCamera(doc, 'Cam', [3.716, 1.581, 2.881], [0, 0.85, -0.35], 24);
    const s = shots(doc, [
      { name: 'S', camera: cam, frame_start: 1, frame_end: 48, framing: 'wide', subjects: [A, B] },
    ]);
    return { doc, A, B, shot: s.S };
  }

  it('lays out a wide two-shot as rideo does: thirds, facings, what is behind, the light and the moves', () => {
    const { doc, shot } = layoutScene();
    const scene = new DeskScene(doc);
    const view = layoutView(scene, shot, 1, scene.camera(shot.camera!, 1))!;
    const [ada, ben] = view.subjects;
    expect(ada).toMatchObject({ name: 'Ada', side: 'left', in_frame: true, depth_label: null, edge: null });
    expect(ada.x).toBeCloseTo(-0.41272100815927343, 3);
    expect(ada.y).toBeCloseTo(0.17811753162900318, 3);
    expect(ada.depth).toBeCloseTo(4.9233421887979265, 3);
    expect(viewFacing(ada)).toBe('camera');
    expect(ada.to).toEqual({ side: 'centre', toward: 'camera' });
    expect(ben).toMatchObject({ name: 'Ben', side: 'right', to: null });
    expect(viewFacing(ben)).toBe('camera');
    expect(view).toMatchObject({ behind: ['the lake'], light: 'right', light_side: null, interior: false });
    expect(blockingLine(doc, shot, 1)).toBe(
      'Blocking: Ada is left of frame, facing the camera; Ben is right of frame, facing the camera. Behind them: the lake. Light: the sun comes from the right.',
    );
    expect(blockingMoves(doc, shot)).toBe('Ada walks towards the camera.');
  });

  it('places the sun at every azimuth, inside the key light of an interior', () => {
    const golden: Record<number, [string, string | null, string]> = {
      0: ['behind', 'left', 'the sun is behind the camera, on the left'],
      45: ['behind', null, 'the sun is behind the camera'],
      90: ['behind', 'right', 'the sun is behind the camera, on the right'],
      135: ['right', null, 'the sun comes from the right'],
      180: ['ahead', null, 'the sun is ahead of the camera, behind the scene'],
      225: ['ahead', null, 'the sun is ahead of the camera, behind the scene'],
      270: ['ahead', null, 'the sun is ahead of the camera, behind the scene'],
      315: ['left', null, 'the sun comes from the left'],
    };
    const { doc, shot } = layoutScene();
    const blocking =
      'Blocking: Ada is left of frame, facing the camera; Ben is right of frame, facing the camera. Behind them: the lake.';
    for (const [az, [light, side, words]] of Object.entries(golden)) {
      doc.updateWorld({
        environment: 'SKY',
        sun_rotation: skySunRotation(Number(az)),
        sun_elevation: (40 * Math.PI) / 180,
      });
      const scene = new DeskScene(doc);
      const view = layoutView(scene, shot, 1, scene.camera(shot.camera!, 1))!;
      expect([view.light, view.light_side], `azimuth ${az}`).toEqual([light, side]);
      expect(blockingLine(doc, shot, 1), `azimuth ${az}`).toBe(`${blocking} Light: ${words}.`);
    }
    // the set's sky drives the light too
    buildSet(doc, {
      width: 12,
      depth: 10,
      ground: 'grass',
      interior: false,
      sun_azimuth_deg: 315,
      sun_elevation_deg: 40,
      sky: true,
    });
    expect(blockingLine(doc, shot, 1)).toBe(`${blocking} Light: the sun comes from the left.`);
    // a sun lamp instead of the sky
    buildSet(doc, {
      width: 12,
      depth: 10,
      ground: 'grass',
      interior: false,
      sun_azimuth_deg: 0,
      sun_elevation_deg: 40,
      sky: false,
    });
    expect(blockingLine(doc, shot, 1)).toBe(`${blocking} Light: the sun is behind the camera, on the left.`);
    setDeskSettings(doc, { interior: true });
    doc.updateWorld({
      environment: 'SKY',
      sun_rotation: skySunRotation(135),
      sun_elevation: (40 * Math.PI) / 180,
    });
    buildSet(doc, {
      width: 12,
      depth: 10,
      ground: 'wood',
      interior: true,
      sun_azimuth_deg: 135,
      sun_elevation_deg: 40,
      sky: true,
    });
    expect(blockingLine(doc, shot, 1)).toBe(`${blocking} Light: the key light comes from the right.`);
  });

  it('leaves the depth words to the actors when a prop is among the subjects (rideo lays out characters only)', () => {
    const doc = deskDoc();
    const ada = standIn(doc, 'Ada', -0.8, 1.5, 0);
    const ben = standIn(doc, 'Ben', 0.8, -0.2, 0);
    const crate = prop(doc, 'crate', 0.2, 2.6, 1);
    const cam = rideoCamera(doc, 'Cam', [0, 1.6, 5], [0, 1, 0], 24);
    // rideo's sentence for this staging (the crate is no character)
    const said =
      'Blocking: Ada is in the centre in the foreground, facing the camera; Ben is in the centre, facing the camera. Light: the sun is ahead of the camera, behind the scene.';
    for (const subjects of [
      [ada, ben],
      [ada, ben, crate],
      [crate, ada, ben],
    ]) {
      const s = shots(doc, [
        { name: 'S', camera: cam, frame_start: 1, frame_end: 24, framing: 'wide', subjects },
      ]);
      expect(blockingLine(doc, s.S, 1), subjects.length.toString()).toBe(said);
      const scene = new DeskScene(doc);
      const view = layoutView(scene, s.S, 1, scene.camera(cam, 1))!;
      expect(view.subjects).toHaveLength(subjects.length);
      expect(view.subjects.find((e) => e.subject === ada)!.depth_label).toBe('foreground');
      expect(view.subjects.find((e) => e.subject === ben)!.depth_label).toBeNull();
    }
  });

  it("names the shoulder of an over-the-shoulder shot, rideo's six facings and the depth of a deep staging", () => {
    const doc = deskDoc();
    const A = standIn(doc, 'Ada', -0.8, 0, 90);
    const B = standIn(doc, 'Ben', 0.8, 0, 270, 1.8);
    const ots = rideoCamera(doc, 'OTS', [-1.382, 1.462, 0.339], [0.8, 1.674, 0], 50);
    const s = shots(doc, [
      {
        name: 'OTS',
        camera: ots,
        frame_start: 1,
        frame_end: 24,
        framing: 'over_shoulder',
        angle: 'over_shoulder',
        subjects: [A, B],
      },
    ]);
    const scene = new DeskScene(doc);
    const view = layoutView(scene, s.OTS, 1, scene.camera(ots, 1))!;
    expect(view.subjects[0]).toMatchObject({ name: 'Ada', in_frame: false, edge: 'left', side: 'left' });
    expect(viewFacing(view.subjects[0])).toBe('away');
    expect(view.subjects[1]).toMatchObject({ name: 'Ben', in_frame: true, side: 'centre' });
    expect(blockingLine(doc, s.OTS, 1)).toBe(
      "Blocking: Ben is in the centre, facing the camera, Ada's shoulder in the left foreground. Light: the sun is ahead of the camera, behind the scene.",
    );

    const facings: Record<number, string> = {
      0: 'camera',
      30: 'camera',
      50: 'camera_right',
      80: 'right',
      100: 'right',
      140: 'right',
      180: 'away',
      200: 'away',
      230: 'left',
      280: 'left',
      320: 'camera_left',
    };
    for (const [deg, facing] of Object.entries(facings)) {
      const d = deskDoc();
      const a = standIn(d, 'Ada', 0, 0, Number(deg));
      const cam = rideoCamera(d, 'Cam', [0, 1.581, 2.131], [0, 1.224, 0], 35);
      const sh = shots(d, [{ name: 'S', camera: cam, frame_start: 1, frame_end: 24, subjects: [a] }]);
      const sc = new DeskScene(d);
      expect(viewFacing(layoutView(sc, sh.S, 1, sc.camera(cam, 1))!.subjects[0]), `facing ${deg}°`).toBe(
        facing,
      );
    }

    const deep = deskDoc();
    const ada = standIn(deep, 'Ada', -0.6, 2, 0);
    const ben = standIn(deep, 'Ben', 0.4, -3, 0);
    const cy = standIn(deep, 'Cy', 0.9, -0.5, 0);
    walk(deep, cy, [
      [1, 0.9, -0.5],
      [24, 0.9, 2.5],
    ]);
    const cam = rideoCamera(deep, 'Cam', [0, 1.6, 7], [0, 1, 0], 24);
    const sh = shots(deep, [
      { name: 'Deep', camera: cam, frame_start: 1, frame_end: 24, framing: 'wide', subjects: [ada, ben, cy] },
    ]);
    const sc = new DeskScene(deep);
    const dv = layoutView(sc, sh.Deep, 1, sc.camera(cam, 1))!;
    expect(dv.subjects.map((e) => e.depth_label)).toEqual(['foreground', null, null]);
    expect(dv.subjects[2].to).toEqual({ side: 'centre', toward: 'camera' });
    expect(blockingLine(deep, sh.Deep, 1)).toBe(
      'Blocking: Ada is in the centre in the foreground, facing the camera; Ben is in the centre, facing the camera; Cy is in the centre, facing the camera. Light: the sun is ahead of the camera, behind the scene.',
    );
    expect(blockingMoves(deep, sh.Deep)).toBe('Cy walks towards the camera.');
  });
});
