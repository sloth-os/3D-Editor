import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import { getShots } from '../src/desk/shots';
import { BRIEF_RECORD_KEY } from '../src/desk/brief/record';
import {
  briefChanges,
  shotResults,
  stageBrief,
  updateFromBrief,
  type BriefChanges,
  type SceneBrief,
} from '../src/desk/brief';

/*
 * briefChanges reports whatever an update acts on (desk/brief changes.ts): besides the contract's
 * lists, `other` names the frame size, the set, the props, the shots' camera plans and words and the
 * cast's names, kinds and heights. It is null exactly when updateFromBrief changes nothing of the
 * staging: such an update gives only the warnings every update of the brief repeats (a length
 * changed in the desk, a cast member kept as the kind staged, a member in no shot), so a desk that
 * offers Update shots on a non-null value offers it whenever the update does something. What the
 * desk did stays out of it: a shot removed in the desk counts only for what stages it again, an
 * actor deleted in the desk is not renamed, a length or cut order or scene range given in the desk
 * stays. A brief that gives back the lens and move the desk staged (a host copying the shot results
 * into its shots) changes nothing; a new frame rate retimes only the shots whose frame count changes.
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const openScene = (): SceneBrief =>
  structuredClone(JSON.parse(readFileSync(new URL('open.json', FIXTURES), 'utf8')).scene);

const SHOT_A = 'sht_0123456789aaaa';
const SHOT_B = 'sht_0123456789bbbb';
const MIRA = 'chr_0123456789mira';
const PIP = 'chr_0123456789pipd';

function staged(brief: SceneBrief = openScene()): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  stageBrief(doc, brief);
  return doc;
}

/** Everything of the staging but the brief record: objects, curves, scene and render settings. */
function staging(doc: SceneDoc): string {
  const scene = Object.fromEntries([...doc.map('scene').entries()].filter(([k]) => k !== BRIEF_RECORD_KEY));
  return JSON.stringify({
    objects: doc.listObjects(),
    curves: doc.listFCurves(),
    scene,
    render: doc.getRender(),
  });
}

const NOTHING_LISTED = { added: [], removed: [], retimed: [], recast: [], cast: { added: [], removed: [] } };

/**
 * The warnings every update of a brief repeats, whatever it changes: a length changed in the desk,
 * a cast member kept as the kind staged, a member in no shot.
 */
const REPEATED = /frames long in the desk|stays the \w+ staged before|is in no shot: not staged/;

/** The warnings of an update that every update of the brief does not repeat. */
const warningsOf = (w: readonly string[]) => w.filter((x) => !REPEATED.test(x));

function run(doc: SceneDoc, id: string, params: Record<string, unknown>): void {
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'api',
    report: () => {},
  };
  const r = createOperatorRegistry().run(ctx, id, params);
  expect(r.ok, r.error).toBe(true);
}

const deskShot = (doc: SceneDoc, host: string) => getShots(doc).find((s) => s.external?.shot === host)!;
const actorOf = (doc: SceneDoc, castId: string) =>
  doc
    .listObjects()
    .find((o) => o.custom_props?.desk_role === 'actor' && o.custom_props?.desk_character_id === castId)!;

describe('briefChanges reports whatever an update acts on', () => {
  const cases: [string, (b: SceneBrief) => void, string[]][] = [
    [
      'the frame size',
      (b) => {
        b.width = 1920;
        b.height = 1080;
      },
      ['the frame size (1280×720 to 1920×1080)'],
    ],
    ['the time of day', (b) => void (b.set.timeOfDay = 'night'), ['the set']],
    ['an interior', (b) => void (b.set.interior = true), ['the set']],
    [
      'a shot’s framing and lens',
      (b) => {
        b.shots[1].framing = 'wide';
        b.shots[1].lensMm = 24;
      },
      ['1 shot with a new camera plan'],
    ],
    ['a shot’s movement', (b) => void (b.shots[0].movement = 'static'), ['1 shot with a new camera plan']],
    [
      'a shot’s continuity',
      (b) => void (b.shots[1].continuity = 'continuous'),
      ['1 shot with a new camera plan'],
    ],
    [
      'a new prop in a shot',
      (b) => {
        b.elements.push({
          id: 'ele_ball',
          name: 'Red ball',
          description: 'A red rubber ball.',
          kind: 'prop',
        });
        b.shots[0].elementIds.push('ele_ball');
      },
      ['the set', 'the props'],
    ],
    ['a prop’s words', (b) => void (b.elements[1].description = 'A blue box kite.'), ['the props']],
    [
      'a shot’s words',
      (b) => void (b.shots[1].description = 'Close-up: Mira smiles at the kite.'),
      ['1 shot with new words'],
    ],
    ['a cast member’s kind', (b) => void (b.cast[0].kind = 'dog'), ['1 cast member of another kind']],
    ['a cast member’s height', (b) => void (b.cast[0].heightM = 1.4), ['1 cast member of another height']],
  ];

  for (const [what, edit, other] of cases)
    it(`reports ${what}, and the update acts on it`, () => {
      const doc = staged();
      const next = openScene();
      edit(next);
      const changes = briefChanges(doc, next);
      expect(changes).toEqual({ ...NOTHING_LISTED, other });
      const before = staging(doc);
      const r = updateFromBrief(doc, next);
      expect(r.changes).toEqual(changes);
      // it changed the staging, or it says what it kept (the first time: later updates repeat it)
      expect(staging(doc) !== before || r.warnings.length > 0).toBe(true);
      expect(briefChanges(doc, next)).toBeNull();
    });

  const quiet: [string, (b: SceneBrief) => void][] = [
    ['the scene’s name', (b) => void (b.name = 'Kite Day')],
    [
      'words of the set that plan the same set',
      (b) => void (b.set.description = 'A wide green meadow, a pond on the left.'),
    ],
    [
      'words of a cast member that stage the same actor',
      (b) => void (b.cast[0].description = 'A girl of 8 in a green coat.'),
    ],
  ];
  for (const [what, edit] of quiet)
    it(`is null for ${what}, and the update changes nothing`, () => {
      const doc = staged();
      const next = openScene();
      edit(next);
      expect(briefChanges(doc, next)).toBeNull();
      const before = staging(doc);
      const r = updateFromBrief(doc, next);
      expect(r.changes).toBeNull();
      expect(r.solved).toEqual([]);
      expect(warningsOf(r.warnings)).toEqual([]);
      expect(staging(doc)).toBe(before);
    });

  // what the desk did, then what the brief changes: nothing the update acts on
  const quietAfterDesk: [string, (doc: SceneDoc) => void, (b: SceneBrief) => void][] = [
    [
      'new words of a shot removed in the desk',
      (doc) => run(doc, 'desk.shot_remove', { shots: [deskShot(doc, SHOT_B).id] }),
      (b) => void (b.shots[1].description = 'Close-up: Mira squints up at the kite.'),
    ],
    [
      'a new number of a shot removed in the desk',
      (doc) => run(doc, 'desk.shot_remove', { shots: [deskShot(doc, SHOT_B).id] }),
      (b) => void (b.shots[1].index = 5),
    ],
    [
      'a shot removed in the desk that the brief drops',
      (doc) => run(doc, 'desk.shot_remove', { shots: [deskShot(doc, SHOT_B).id] }),
      (b) => void b.shots.splice(1, 1),
    ],
    [
      'a new length the desk gave the shot already',
      (doc) => run(doc, 'desk.shot_update', { shot: deskShot(doc, SHOT_A).id, frame_end: 48 }),
      (b) => void (b.shots[0].durationSec = 2),
    ],
    ['a new duration of the same frame count', () => {}, (b) => void (b.shots[0].durationSec = 3.01)],
    [
      'a new name of a cast member whose actor was deleted in the desk',
      (doc) => run(doc, 'object.delete', { objects: [actorOf(doc, PIP).id] }),
      (b) => void (b.cast[1].name = 'Pippin'),
    ],
    [
      'a new cast member in no shot',
      () => {},
      (b) =>
        void b.cast.push({
          id: 'chr_lena',
          name: 'Lena',
          description: 'A girl of 9.',
          kind: null,
          heightM: null,
        }),
    ],
    [
      'the brief as staged, with the scene’s range shortened in the desk',
      (doc) => doc.updateScene({ frame_end: 60 }),
      () => {},
    ],
    [
      'the brief as staged, with the cut order changed in the desk',
      (doc) => run(doc, 'desk.shot_move', { shot: deskShot(doc, SHOT_B).id, index: 0 }),
      () => {},
    ],
    [
      'the brief as staged, with the scene camera cleared in the desk',
      (doc) => doc.updateScene({ camera: null }),
      () => {},
    ],
    [
      'a new name of a cast member that the desk gave its actor already',
      (doc) => doc.rename('objects', actorOf(doc, PIP).id, 'Pippin'),
      (b) => void (b.cast[1].name = 'Pippin'),
    ],
  ];
  for (const [what, desk, edit] of quietAfterDesk)
    it(`is null for ${what}, and the update changes nothing`, () => {
      const doc = staged();
      desk(doc);
      const next = openScene();
      edit(next);
      expect(briefChanges(doc, next)).toBeNull();
      const before = staging(doc);
      const r = updateFromBrief(doc, next);
      expect(r.changes).toBeNull();
      expect(r.solved).toEqual([]);
      expect(warningsOf(r.warnings)).toEqual([]);
      expect(staging(doc)).toBe(before);
    });

  it('does not list as removed a cast member whose actor was deleted in the desk, and the update removes nothing', () => {
    const doc = staged();
    run(doc, 'object.delete', { objects: [actorOf(doc, PIP).id] });
    const next = openScene();
    next.cast.splice(1, 1);
    next.shots[0].castIds = [MIRA];
    next.shots[0].layout = next.shots[0].layout.filter((e) => e.castId !== PIP);
    const changes = briefChanges(doc, next);
    expect(changes).toEqual({
      ...NOTHING_LISTED,
      recast: [SHOT_A],
      other: ['1 shot with a new camera plan'],
    });
    const objects = doc.listObjects().map((o) => o.id);
    const r = updateFromBrief(doc, next);
    expect(r.changes).toEqual(changes);
    expect(doc.listObjects().map((o) => o.id)).toEqual(objects);
    expect(r.cast.map((c) => c.castId)).toEqual([MIRA]);
  });

  it('does not count a rename the desk already made among what else changed', () => {
    const doc = staged();
    doc.rename('objects', actorOf(doc, PIP).id, 'Pippin');
    const next = openScene();
    next.cast[1].name = 'Pippin';
    next.shots[1].description = 'Close-up: Mira squints up at the kite.';
    expect(briefChanges(doc, next)).toEqual({ ...NOTHING_LISTED, other: ['1 shot with new words'] });
    const r = updateFromBrief(doc, next);
    expect(warningsOf(r.warnings)).toEqual([]);
    expect(actorOf(doc, PIP).name).toBe('Pippin');
  });

  it('a warning of what an update keeps comes again with the brief, while briefChanges is null', () => {
    const doc = staged();
    const next = openScene();
    next.cast[0].kind = 'dog';
    const kept = 'Mira now reads as a dog but stays the child staged before';
    expect(updateFromBrief(doc, next).warnings.join('\n')).toContain(kept);
    expect(briefChanges(doc, next)).toBeNull();
    const before = staging(doc);
    expect(updateFromBrief(doc, next).warnings.join('\n')).toContain(kept);
    expect(staging(doc)).toBe(before);
  });

  it('lists a shot removed in the desk as retimed when the brief gives it a new length: the update stages it again', () => {
    const doc = staged();
    run(doc, 'desk.shot_remove', { shots: [deskShot(doc, SHOT_B).id] });
    const next = openScene();
    next.shots[1].durationSec = 3;
    expect(briefChanges(doc, next)).toEqual({ ...NOTHING_LISTED, retimed: [SHOT_B] });
    updateFromBrief(doc, next);
    expect(deskShot(doc, SHOT_B)).toMatchObject({ frame_start: 73, frame_end: 144 });
  });

  it('is null for a brief that gives back the lens and move the desk staged, and the update solves nothing', () => {
    const doc = staged();
    const echo = openScene();
    const results = shotResults(doc);
    for (const s of echo.shots) {
      const camera = results.find((x) => x.shotId === s.id)!.camera;
      s.lensMm = camera.lensMm;
      s.move = camera.move;
    }
    // the planned lens and move of shot A were the desk's own choice
    expect(echo.shots[0]).toMatchObject({ lensMm: 24, move: 'tracking_follow' });
    expect(briefChanges(doc, echo)).toBeNull();
    const before = staging(doc);
    const r = updateFromBrief(doc, echo);
    expect(r).toMatchObject({ changes: null, solved: [] });
    expect(staging(doc)).toBe(before);
    // a lens the host then changes is a new camera plan
    const next = structuredClone(echo);
    next.shots[0].lensMm = 35;
    expect(briefChanges(doc, next)).toEqual({ ...NOTHING_LISTED, other: ['1 shot with a new camera plan'] });
  });

  it('lists as retimed, for a new frame rate, only the shots whose frame count changes', () => {
    const brief = openScene();
    brief.shots.push({ ...brief.shots[1], id: 'sht_0123456789cccc', index: 2, durationSec: 0.2 });
    const doc = staged(brief);
    // at 25 fps shot A is 75 frames (72 at 24) and B 63 (60); C stays 5
    const next = { ...structuredClone(brief), fps: 25 };
    const changes = briefChanges(doc, next) as BriefChanges;
    expect(changes).toEqual({
      ...NOTHING_LISTED,
      retimed: [SHOT_A, SHOT_B],
      other: ['the frame rate (24 to 25 fps)'],
    });
  });
});
