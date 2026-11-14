import { describe, expect, it } from 'vitest';
import type { Interpolation } from '../src/doc/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import type { Vec3 } from '../src/math/types';
import { compose4, identity4, multiply4 } from '../src/math/mat4';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { HIDDEN_SCALE_EPS, HIDE_SCALE, hiddenByScale, hiddenGeometry, hiddenScale } from '../src/desk/hide';
import { DeskScene } from '../src/desk/layout';
import { getShots, setDeskSettings, setShots } from '../src/desk/shots';
import { FRAMING_TABLE, solveCamera, type SolveSpec } from '../src/desk/solver';
import { shotFitReport, shotOcclusions } from '../src/desk/moves';
import { crossesLine, lineOfAction, linePointsAt } from '../src/desk/line';
import { checkShots, type DeskIssue } from '../src/desk/checks';
import { createActor, moveAlongPath, mount } from '../src/desk/characters';
import type { ShotData } from '../src/doc/types';
import { deskDoc, ed, rideoCamera, standIn } from './desk-fixtures';

/*
 * Objects put away by a hide key (desk/hide.ts: the scale-1e-8 keys desk.tether_fly's after: 'hide'
 * and the rideo import write) in the desk's reading of the scene, its checks and its solver; a rider
 * and her mount in the 180° line, the screen direction and the occlusion test; and desk.check's
 * occluded_subject through the keyed camera. Scenes in rideo's coordinates (desk-fixtures).
 */

type Shot = Partial<ShotData> & Pick<ShotData, 'name' | 'frame_start' | 'frame_end'>;

/** Keys a channel of an object at frames. */
function keys(
  doc: SceneDoc,
  id: string,
  path: 'location' | 'scale',
  frames: [number, Vec3][],
  interpolation: Interpolation = 'CONSTANT',
): void {
  for (let i = 0; i < 3; i++) {
    let fc = createFCurve({ target_type: 'object', target_id: id, path, index: i });
    for (const [f, v] of frames) fc = insertKeyframe(fc, f, v[i], interpolation);
    doc.setFCurve(fc);
  }
}

/** Hides object `id` (scale 1e-8, as the hide keys) over frames [from, to], shown on either side. */
function hideBetween(doc: SceneDoc, id: string, from: number, to: number): void {
  const shown: Vec3 = [1, 1, 1];
  const hidden: Vec3 = [1e-8, 1e-8, 1e-8];
  const frames: [number, Vec3][] = [];
  if (from > -1e6) frames.push([from - 1, shown]);
  frames.push([from, hidden], [to, hidden], [to + 1, shown]);
  keys(doc, id, 'scale', frames);
}

function shots(doc: SceneDoc, list: Shot[]): Record<string, ShotData> {
  setShots(doc, list);
  return Object.fromEntries(getShots(doc).map((s) => [s.name, s]));
}

const byCode = (issues: DeskIssue[], code: string) => issues.filter((i) => i.code === code);

const MEDIUM_FRONT = (subjects: string[]): SolveSpec => ({
  framing: 'medium',
  angle: 'front',
  height: 'eye',
  move: null,
  lens_mm: FRAMING_TABLE.medium.lens_mm,
  subjects,
});

describe('hiddenByScale', () => {
  it('tells a matrix collapsed by a hide key from one that is merely small', () => {
    const at = (s: Vec3) => compose4([1, 2, 3], [0.3, -0.2, 0.1], s);
    expect(hiddenByScale(at([1e-8, 1e-8, 1e-8]))).toBe(true);
    // mirrored objects keep their sign when hidden (desk.tether_fly)
    expect(hiddenByScale(at([-1e-8, 1e-8, 1e-8]))).toBe(true);
    expect(hiddenByScale(at([0, 0, 0]))).toBe(true);
    // two collapsed axes decide: a hidden string keeps its length's axis (1e-8 of it), an object
    // flattened along one axis is still drawn
    expect(hiddenByScale(at([HIDDEN_SCALE_EPS / 2, HIDDEN_SCALE_EPS / 2, 1]))).toBe(true);
    expect(hiddenByScale(at([1e-8, 1e-8, 50e-8]))).toBe(true);
    expect(hiddenByScale(at([1, 1, 0]))).toBe(false);
    expect(hiddenByScale(at([1, 1, HIDDEN_SCALE_EPS / 2]))).toBe(false);
    expect(hiddenByScale(at([HIDDEN_SCALE_EPS * 2, HIDDEN_SCALE_EPS * 2, 1]))).toBe(false);
    // a model in centimetres, a tiny prop, an unscaled object
    expect(hiddenByScale(at([0.01, 0.01, 0.01]))).toBe(false);
    expect(hiddenByScale(identity4())).toBe(false);
    // store models fitted to their size by store.insert_files: 1,000,000 native units made 1 m
    // (1e-6), a 1.5 m model in millimetres made a 2 cm toy (1.3e-5); hidden, they shrink by
    // HIDE_SCALE of that (hiddenScale)
    for (const shown of [1e-6, 0.02 / 1500]) {
      expect(hiddenByScale(at([shown, shown, shown])), `shown at ${shown}`).toBe(false);
      const h = hiddenScale(shown);
      expect(h).toBeCloseTo(shown * HIDE_SCALE, 25);
      expect(hiddenByScale(at([h, h, h])), `hidden from ${shown}`).toBe(true);
    }
    expect(hiddenScale(-2)).toBe(-2 * HIDE_SCALE);
    expect(hiddenScale(0)).toBe(HIDE_SCALE);
    // with its geometry: a model 1,000,000 units across shown 5 cm wide, at a world scale below
    // HIDDEN_SCALE_EPS, is shown; hidden, under a micrometre across
    const box: [Vec3, Vec3] = [
      [-5e5, -5e5, 0],
      [5e5, 5e5, 1e6],
    ];
    const s5cm = 0.05 / 1e6;
    expect(hiddenByScale(at([s5cm, s5cm, s5cm]))).toBe(true);
    expect(hiddenGeometry(at([s5cm, s5cm, s5cm]), ...box)).toBe(false);
    const h5cm = hiddenScale(s5cm);
    expect(hiddenGeometry(at([h5cm, h5cm, h5cm]), ...box)).toBe(true);
    // a 1 m object under the absolute 1e-8 hide keys of earlier versions, and one shown
    const unit: [Vec3, Vec3] = [
      [-0.5, -0.5, 0],
      [0.5, 0.5, 1],
    ];
    expect(hiddenGeometry(at([1e-8, 1e-8, 1e-8]), ...unit)).toBe(true);
    expect(hiddenGeometry(at([1, 1, 1]), ...unit)).toBe(false);
    expect(hiddenGeometry(at([0.01, 0.01, 0.01]), ...unit)).toBe(false);
    // a parent's hide key collapses its children's world matrices too
    const child = multiply4(
      compose4([0, 0, 0], [0, 0, 0], [1e-8, 1e-8, 1e-8]),
      compose4([0, 1, 0], [0, 0, 0], [2, 2, 2]),
    );
    expect(hiddenByScale(child)).toBe(true);
  });
});

describe('subjects put away by a hide key', () => {
  /**
   * Ada at the origin and Ben 0.8 m to her right, both facing the front, framed medium from the
   * front over frames 1–48; Ben is hidden over frames 1–24 and parked 20 m to the right meanwhile.
   */
  function parked() {
    const doc = deskDoc();
    const A = standIn(doc, 'Ada', -0.4, 0, 0);
    const B = standIn(doc, 'Ben', 0.4, 0, 0);
    keys(doc, B, 'location', [
      [1, ed(20, 0, 0)],
      [25, ed(0.4, 0, 0)],
    ]);
    hideBetween(doc, B, 1, 24);
    const c = solveCamera(new DeskScene(doc), MEDIUM_FRONT([A]), 30);
    const r = (v: Vec3) => [v[0], v[2], -v[1]];
    const cam = rideoCamera(doc, 'Cam', r(c.position), r(c.target), c.lens_mm);
    return { doc, A, B, cam };
  }

  it('reads them as hidden at the frames they are put away, where they are put away', () => {
    const { doc, A, B } = parked();
    const scene = new DeskScene(doc);
    expect(scene.hidden(B, 1)).toBe(true);
    expect(scene.hidden(B, 24)).toBe(true);
    expect(scene.hidden(B, 25)).toBe(false);
    expect(scene.subject(B, 10)!.hidden).toBe(true);
    expect(scene.subject(B, 30)!.hidden).toBe(false);
    expect(scene.subject(A, 10)!.hidden).toBe(false);
    // its child (the stand-in's body) is collapsed with it
    const body = doc.findObjectByName('Ben body')!.id;
    expect(scene.hidden(body, 10)).toBe(true);
    // a group a camera follows leaves its hidden members out while one is shown
    expect(scene.groupCentre([A, B], 10)).toEqual(scene.origin(A, 10));
    const both = scene.groupCentre([A, B], 30)!;
    expect(both[0]).toBeCloseTo((scene.origin(A, 30)[0] + scene.origin(B, 30)[0]) / 2, 9);
    // all of them hidden: where they were put away
    expect(scene.groupCentre([B], 10)).toEqual(scene.origin(B, 10));
  });

  it('desk.check says a subject is hidden, not out of frame, and a hidden bystander stands nowhere', () => {
    const { doc, A, B, cam } = parked();
    const s = shots(doc, [{ name: 'Two', camera: cam, frame_start: 1, frame_end: 48, subjects: [A, B] }]);
    const { issues, layouts, lines } = checkShots(doc);
    // samples 1, 25, 48: hidden at 1 (and 20 m to the right, out of the frame), shown at the others
    expect(byCode(issues, 'subject_out_of_frame')).toEqual([]);
    expect(byCode(issues, 'subject_hidden')).toEqual([
      {
        code: 'subject_hidden',
        severity: 'warning',
        shot: s.Two.id,
        objects: [B],
        message: expect.stringMatching(
          /^Ben is hidden in shot 'Two' \(frame 1\): it is scaled to nothing there/,
        ),
      },
    ]);
    // the layout of the first frame has him out of frame, and the blocking line leaves him out
    expect(layouts[0].layout.find((e) => e.subject === B)).toMatchObject({
      in_frame: false,
      edge: null,
      to: null,
    });
    expect(lines[0].line).toMatch(/^Blocking: Ada is /);
    expect(lines[0].line).not.toMatch(/Ben/);

    // as a bystander: not in the shot, put away in its frame, he is not absent_in_frame (shown, he is)
    shots(doc, [{ name: 'Ada', camera: cam, frame_start: 1, frame_end: 48, subjects: [A] }]);
    keys(doc, B, 'location', [[1, ed(0.4, 0, 0)]]);
    expect(byCode(checkShots(doc).issues, 'absent_in_frame')).toEqual([]);
    doc.removeFCurve(`object:${B}:scale:0`);
    doc.removeFCurve(`object:${B}:scale:1`);
    doc.removeFCurve(`object:${B}:scale:2`);
    expect(byCode(checkShots(doc).issues, 'absent_in_frame').map((i) => i.objects)).toEqual([[B]]);
  });

  it('the solver frames the subjects shown at a frame and keeps nothing hidden in frame', () => {
    const { doc, A, B } = parked();
    const scene = new DeskScene(doc);
    const both = MEDIUM_FRONT([A, B]);
    // at frame 10 Ben is put away: Ada's camera exactly
    const hidden = solveCamera(scene, both, 10);
    const alone = solveCamera(scene, MEDIUM_FRONT([A]), 10);
    expect(hidden.position).toEqual(alone.position);
    expect(hidden.target).toEqual(alone.target);
    // shown, he makes it a two-shot
    expect(solveCamera(scene, both, 30).position).not.toEqual(
      solveCamera(scene, MEDIUM_FRONT([A]), 30).position,
    );
    // a camera on Ada over frames 1–20 loses nobody: Ben, 20 m away, is put away there
    const pose = { position: alone.position, target: alone.target, lens: alone.lens_mm };
    expect(shotFitReport(scene, both, { frame_start: 1, frame_end: 20 }, pose).out_of_frame).toEqual([]);
  });

  it('a hidden bystander hides nobody, in the solve and in desk.check', () => {
    const doc = deskDoc();
    const ben = standIn(doc, 'Ben', 0, 0, 0, 1.8);
    const c = solveCamera(new DeskScene(doc), MEDIUM_FRONT([ben]), 1);
    const r = (v: Vec3) => [v[0], v[2], -v[1]];
    const cam = rideoCamera(doc, 'Cam', r(c.position), r(c.target), c.lens_mm);
    // Cy halfway between the camera and Ben, her back to the camera, taller than him
    const cy = standIn(doc, 'Cy', c.position[0] / 2, -c.position[1] / 2, 180, 2.4);
    const s = shots(doc, [{ name: 'Ben', camera: cam, frame_start: 1, frame_end: 48, subjects: [ben] }]);
    const pose = { position: c.position, target: c.target, lens: c.lens_mm };
    const span = { frame_start: 1, frame_end: 48 };
    expect(shotOcclusions(new DeskScene(doc), MEDIUM_FRONT([ben]), span, pose)).toEqual([
      { subject: ben, name: 'Ben', by: ['Cy'], frames: [1, 25, 48], body_frames: [] },
    ]);
    // desk.check reads the same through the keyed camera
    expect(byCode(checkShots(doc).issues, 'occluded_subject')).toEqual([
      {
        code: 'occluded_subject',
        severity: 'warning',
        shot: s.Ben.id,
        objects: [ben, cy],
        message:
          "Ben (frames 1, 25, 48) is hidden behind Cy, who is not in shot 'Ben': restage, add Cy to its " +
          'subjects, or choose another angle or height',
      },
    ]);
    // put away from frame 25 on, she hides him at the first frame only
    hideBetween(doc, cy, 25, 1000);
    expect(shotOcclusions(new DeskScene(doc), MEDIUM_FRONT([ben]), span, pose)).toEqual([
      { subject: ben, name: 'Ben', by: ['Cy'], frames: [1], body_frames: [] },
    ]);
    expect(byCode(checkShots(doc).issues, 'occluded_subject').map((i) => i.message)).toEqual([
      expect.stringMatching(/^Ben \(frame 1\) is hidden behind Cy/),
    ]);
  });

  it('desk.check judges occlusions through the camera as keyed, at the frames it samples', () => {
    const doc = deskDoc();
    const ben = standIn(doc, 'Ben', 0, 0, 0, 1.8);
    const c = solveCamera(new DeskScene(doc), MEDIUM_FRONT([ben]), 1);
    const r = (v: Vec3) => [v[0], v[2], -v[1]];
    const cam = rideoCamera(doc, 'Cam', r(c.position), r(c.target), c.lens_mm);
    standIn(doc, 'Cy', c.position[0] / 2, -c.position[1] / 2, 180, 1.4);
    shots(doc, [{ name: 'Ben', camera: cam, frame_start: 1, frame_end: 48, subjects: [ben] }]);
    // a child halfway to him hides his body below his eyes
    expect(byCode(checkShots(doc).issues, 'occluded_subject').map((i) => i.message)).toEqual([
      "The body of Ben (frames 1, 25, 48) is hidden behind Cy, who is not in shot 'Ben': restage, add Cy to its " +
        'subjects, or choose another angle or height',
    ]);
    // the camera keyed up over her from the middle of the shot: hidden at the first frame only
    const p = doc.getObject(cam)!.location;
    keys(doc, cam, 'location', [
      [1, p],
      [25, [p[0], p[1], p[2] + 3]],
    ]);
    expect(byCode(checkShots(doc).issues, 'occluded_subject').map((i) => i.message)).toEqual([
      expect.stringMatching(/^The body of Ben \(frame 1\) is hidden behind Cy/),
    ]);
  });
});

describe('a rider and her mount', () => {
  /**
   * Maple (a horse) carrying Ada from frame 1, walking to the right over shot 1 and back to the left
   * over shot 2; Ben stands by in shot 3 with Ada.
   */
  function riding() {
    const doc = deskDoc();
    setDeskSettings(doc, { set_width: 40, set_depth: 40 });
    const maple = createActor(doc, {
      kind: 'horse',
      name: 'Maple',
      location: ed(-3, 0, 0),
      facing_deg: 90,
    }).actor;
    const ada = createActor(doc, {
      kind: 'woman',
      name: 'Ada',
      location: ed(-3, 0, 1.5),
      facing_deg: 90,
    }).actor;
    const ben = createActor(doc, { kind: 'man', name: 'Ben', location: ed(0, 0, -3), facing_deg: 0 }).actor;
    mount(doc, ada, maple, { frame: 1 });
    moveAlongPath(doc, maple, [ed(3, 0, 0)], { frame_start: 1, frame_end: 48, gait: 'walk' });
    moveAlongPath(doc, maple, [ed(-3, 0, 0)], { frame_start: 49, frame_end: 96, gait: 'walk' });
    const front = rideoCamera(doc, 'Front', [0, 1.6, 12], [0, 1.2, 0], 24);
    return { doc, ada, maple, ben, front };
  }

  it('rides with her mount: they make no line, and cross the frame as one', () => {
    const { doc, ada, maple, ben, front } = riding();
    const scene = new DeskScene(doc);
    expect(scene.mountOf(ada, 10)).toBe(maple);
    expect(scene.mountOf(maple, 10)).toBeNull();
    expect(scene.rideTogether(ada, maple, 10)).toBe(true);
    expect(scene.rideTogether(maple, ada, 10)).toBe(true);
    expect(scene.rideTogether(ada, ben, 10)).toBe(false);
    const s = shots(doc, [
      { name: 'There', camera: front, frame_start: 1, frame_end: 48, subjects: [maple, ada] },
      { name: 'Back', camera: front, frame_start: 49, frame_end: 96, subjects: [ada, maple] },
      { name: 'Hello', camera: front, frame_start: 97, frame_end: 120, subjects: [ada, ben] },
    ]);
    // they share two shots and Ada shares one with Ben: the line is Ada and Ben's
    const line = lineOfAction(new DeskScene(doc))!;
    expect([line.a, line.b].sort()).toEqual([ada, ben].sort());
    // named as the main pair, they make no line where she rides
    setDeskSettings(doc, { main_pair: [ada, maple] });
    const paired = new DeskScene(doc);
    const theirs = lineOfAction(paired)!;
    expect([theirs.a, theirs.b]).toEqual([ada, maple]);
    expect(linePointsAt(paired, theirs, 10)).toBeNull();
    // a camera behind them would cross any line between them: not where she rides
    const behind = rideoCamera(doc, 'Behind', [0, 1.6, -12], [0, 1.2, 0], 24);
    expect(crossesLine(paired, theirs, { ...s.There, camera: behind })).toBe(false);
    expect(byCode(checkShots(doc).issues, 'line_crossed')).toEqual([]);
    setDeskSettings(doc, { main_pair: null });
    // the screen direction: Maple crosses the frame the other way after the cut, Ada with her: once
    const dir = byCode(checkShots(doc).issues, 'screen_direction');
    expect(dir.map((i) => [i.shot, i.objects])).toEqual([[s.Back.id, [maple]]]);
  });

  it('is not hidden behind her mount, nor her mount behind her', () => {
    const { doc, ada, maple } = riding();
    const scene = new DeskScene(doc);
    // a low camera in front of the horse, on her: the horse's head and neck stand between
    const spec: SolveSpec = { ...MEDIUM_FRONT([ada]), height: 'low' };
    const c = solveCamera(scene, spec, 10);
    const pose = { position: c.position, target: c.target, lens: c.lens_mm };
    expect(shotOcclusions(scene, spec, { frame_start: 10, frame_end: 20 }, pose)).toEqual([]);
    // the horse as a subject with her as a bystander on its back
    const theirs: SolveSpec = { ...MEDIUM_FRONT([maple]), framing: 'wide' };
    const w = solveCamera(scene, theirs, 10);
    expect(
      shotOcclusions(
        scene,
        theirs,
        { frame_start: 10, frame_end: 20 },
        { position: w.position, target: w.target, lens: w.lens_mm },
      ),
    ).toEqual([]);
  });
});
