import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SceneDoc, fcurveKey } from '../src/doc/scene-doc';
import type { FCurve, ObjectData } from '../src/doc/types';
import { evaluateFCurve } from '../src/anim/fcurve';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import { getShots, setShots } from '../src/desk/shots';
import { HIDE_SCALE } from '../src/desk/hide';
import { attachSpans } from '../src/desk/characters/attach';
import { RIDE_PREFIX } from '../src/desk/characters/rig';
import { briefChanges, stageBrief, updateFromBrief, type SceneBrief } from '../src/desk/brief';
import { deleteSceneTime, insertSceneTime } from '../src/desk/brief/timeline';

/*
 * Updating a staging to a later brief (desk/brief update.ts) keeps what the person did in the desk to
 * the shots the brief did not change: a shot made shorter or longer by hand (even over the next one),
 * a shot removed, a brief sent again as it was; it never cuts another shot's keys, and a curve keeps
 * its values on both sides of a ripple edit (an actor hidden in the next shot stays shown in its own).
 * A new first shot stays inside the scene's range, a ripple edit removes what lay inside the frames it
 * deletes, and an update says when a shot's words ask for a rider it does not seat.
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const openScene = (): SceneBrief =>
  structuredClone(JSON.parse(readFileSync(new URL('open.json', FIXTURES), 'utf8')).scene);

const MIRA = 'chr_0123456789mira';
const PIP = 'chr_0123456789pipd';
const SHOT_A = 'sht_0123456789aaaa';
const SHOT_B = 'sht_0123456789bbbb';
const SHOT_C = 'sht_0123456789cccc';

const newDoc = () => SceneDoc.create({ empty: true });

function staged(brief: SceneBrief = openScene()): SceneDoc {
  const doc = newDoc();
  stageBrief(doc, brief);
  return doc;
}

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

const prop = (o: ObjectData | null | undefined, key: string) => o?.custom_props?.[key];
const actorOf = (doc: SceneDoc, castId: string) =>
  doc.listObjects().find((o) => prop(o, 'desk_role') === 'actor' && prop(o, 'desk_character_id') === castId)!;
const deskShot = (doc: SceneDoc, host: string) => getShots(doc).find((s) => s.external?.shot === host)!;
const ranges = (doc: SceneDoc) => getShots(doc).map((s) => [s.external?.shot, s.frame_start, s.frame_end]);

function channel(
  doc: SceneDoc,
  id: string,
  path: 'location' | 'rotation_euler' | 'scale',
  i: number,
  frame: number,
): number {
  const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index: i }));
  return (fc ? evaluateFCurve(fc, frame) : undefined) ?? doc.getObject(id)![path][i];
}
const hiddenAt = (doc: SceneDoc, id: string, frame: number) =>
  Math.abs(channel(doc, id, 'scale', 0, frame)) <=
  HIDE_SCALE * 10 * Math.abs(doc.getObject(id)!.scale[0] || 1);

/** The keys of every F-curve of `ids`, by curve. */
const keysOf = (doc: SceneDoc, ids: readonly string[]) =>
  Object.fromEntries(
    doc
      .listFCurves()
      .filter((fc) => ids.includes(fc.target_id))
      .map((fc) => [fcurveKey(fc), fc.keyframes.map((k) => [k.frame, k.value])]),
  );

/** The location, rotation and scale channels of `ids` at frames `from`–`to` (curves, else stored values). */
const valuesOf = (doc: SceneDoc, ids: readonly string[], from: number, to: number) =>
  Object.fromEntries(
    ids.flatMap((id) =>
      (['location', 'rotation_euler', 'scale'] as const).flatMap((path) =>
        [0, 1, 2].map((i) => [
          `${id}:${path}:${i}`,
          Array.from({ length: to - from + 1 }, (_, k) => channel(doc, id, path, i, from + k)),
        ]),
      ),
    ),
  );

/** The open.json brief with shot C (Pip barks at the pond) added after B: a change of nothing else. */
function withC(): SceneBrief {
  const next = openScene();
  next.shots.push({
    ...next.shots[1],
    id: SHOT_C,
    index: 2,
    durationSec: 2,
    description: 'Medium: Pip barks at the pond.',
    action: '',
    castIds: [PIP],
    elementIds: [],
    framing: 'medium',
    movement: 'static',
    move: null,
    lensMm: null,
    layout: [],
  });
  return next;
}

describe('updateFromBrief keeps what was done in the desk to shots the brief did not change', () => {
  it('keeps a shot made shorter by hand while it stages a new shot', () => {
    const doc = staged();
    const a = deskShot(doc, SHOT_A);
    run(doc, 'desk.shot_update', { shot: a.id, frame_end: 48 });
    const b = deskShot(doc, SHOT_B);
    const bKeys = keysOf(doc, [b.camera!]);
    expect(briefChanges(doc, openScene())).toBeNull();
    expect(briefChanges(doc, withC())?.retimed).toEqual([]);
    const r = updateFromBrief(doc, withC());
    expect(r.changes).toMatchObject({ added: [SHOT_C], retimed: [] });
    expect(ranges(doc)).toEqual([
      [SHOT_A, 1, 48],
      [SHOT_B, 73, 132],
      [SHOT_C, 133, 180],
    ]);
    expect(keysOf(doc, [b.camera!])).toEqual(bKeys);
    expect(r.warnings).toContain(
      'Shot 1 is 48 frames long in the desk and 72 in the brief: kept as edited in the desk',
    );
    // the record holds the brief's frames: nothing differs afterwards
    expect(briefChanges(doc, withC())).toBeNull();
  });

  it('keeps a shot made longer by hand over the next one, and never cuts the next shot’s keys', () => {
    const doc = staged();
    const a = deskShot(doc, SHOT_A);
    const b = deskShot(doc, SHOT_B);
    run(doc, 'desk.shot_update', { shot: a.id, frame_end: 96 });
    const pip = actorOf(doc, PIP).id;
    const mira = actorOf(doc, MIRA).id;
    const bCam = keysOf(doc, [b.camera!]);
    const before = valuesOf(doc, [b.camera!, pip, mira], 1, 132);
    const r = updateFromBrief(doc, withC());
    expect(r.changes).toMatchObject({ added: [SHOT_C], retimed: [] });
    expect(ranges(doc)).toEqual([
      [SHOT_A, 1, 96],
      [SHOT_B, 73, 132],
      [SHOT_C, 133, 180],
    ]);
    // B's camera keys, and every value of it and of the actors in A and B, are as they were (C's
    // frames came after them)
    expect(keysOf(doc, [b.camera!])).toEqual(bCam);
    expect(valuesOf(doc, [b.camera!, pip, mira], 1, 132)).toEqual(before);
  });

  it('shrinks a shot the brief shortens by the frames no other shot covers, moving the next one rigidly', () => {
    const doc = staged();
    const a = deskShot(doc, SHOT_A);
    const b = deskShot(doc, SHOT_B);
    run(doc, 'desk.shot_update', { shot: a.id, frame_end: 96 });
    const camKeys = (fc: FCurve) => fc.keyframes.map((k) => [k.frame, k.value]);
    const bCam = doc.listFCurves(b.camera!).map(camKeys);
    const next = openScene();
    next.shots[0].durationSec = 2;
    const r = updateFromBrief(doc, next);
    expect(r.changes).toMatchObject({ retimed: [SHOT_A] });
    // A's frames 49–72 were its own and went; 73–96 were B's too and stayed (B moved 24 earlier)
    expect(ranges(doc)).toEqual([
      [SHOT_A, 1, 48],
      [SHOT_B, 49, 108],
    ]);
    expect(doc.listFCurves(b.camera!).map(camKeys)).toEqual(
      bCam.map((keys) => keys.map(([f, v]) => [f - 24, v])),
    );
  });

  it('keeps a shot removed by hand removed until the brief changes it', () => {
    const doc = staged();
    const b = deskShot(doc, SHOT_B);
    run(doc, 'desk.shot_remove', { shots: [b.id] });
    expect(briefChanges(doc, openScene())).toBeNull();
    const next = openScene();
    next.shots[0].durationSec = 3.5;
    const r = updateFromBrief(doc, next);
    expect(r.changes).toMatchObject({ added: [], retimed: [SHOT_A] });
    expect(ranges(doc)).toEqual([[SHOT_A, 1, 84]]);
    expect(briefChanges(doc, next)).toBeNull();
    // the brief recasts B: staged again, after A
    const recast = structuredClone(next);
    recast.shots[1].castIds = [MIRA, PIP];
    expect(briefChanges(doc, recast)).toMatchObject({ added: [], recast: [SHOT_B] });
    const again = updateFromBrief(doc, recast);
    expect(ranges(doc)).toEqual([
      [SHOT_A, 1, 84],
      [SHOT_B, 85, 144],
    ]);
    expect(again.solved).toEqual([SHOT_B]);
    expect(again.warnings.join('\n')).toMatch(
      /Shot 2 was removed in the desk; the brief changed its cast, so it is staged again/,
    );
  });

  it('changes nothing when the brief is the one staged, whatever was done by hand', () => {
    const doc = staged();
    run(doc, 'desk.shot_update', { shot: deskShot(doc, SHOT_A).id, frame_end: 48 });
    const shots = JSON.stringify(getShots(doc));
    const curves = JSON.stringify(doc.listFCurves());
    const r = updateFromBrief(doc, openScene());
    expect(r.changes).toBeNull();
    expect(r.solved).toEqual([]);
    expect(JSON.stringify(getShots(doc))).toBe(shots);
    expect(JSON.stringify(doc.listFCurves())).toBe(curves);
  });
});

describe('a ripple edit keeps the values on both sides of it', () => {
  it('keeps an actor the next shot hides shown in a shot the brief shortens', () => {
    const doc = staged();
    const pip = actorOf(doc, PIP).id;
    expect([10, 30, 71, 100].map((f) => hiddenAt(doc, pip, f))).toEqual([false, false, false, true]);
    const next = openScene();
    next.shots[0].durationSec = 2;
    const r = updateFromBrief(doc, next);
    expect(ranges(doc)).toEqual([
      [SHOT_A, 1, 48],
      [SHOT_B, 49, 108],
    ]);
    expect([10, 30, 47, 48, 49, 60].map((f) => hiddenAt(doc, pip, f))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(r.issues.filter((i) => i.code === 'subject_hidden')).toEqual([]);
  });

  it('keeps an actor shown in the shot before a shot the brief removes', () => {
    const brief = openScene();
    brief.shots[1].castIds = [MIRA, PIP];
    brief.shots.push({ ...brief.shots[0], id: SHOT_C, index: 2, castIds: [MIRA], layout: [] });
    // A (Mira, Pip) · B (Mira, Pip) · C (Mira): Pip is hidden from C on, the key that keeps him shown
    // before it on B's last frame; the brief drops B
    const doc = staged(brief);
    const pip = actorOf(doc, PIP).id;
    expect([1, 72, 100, 132, 133].map((f) => hiddenAt(doc, pip, f))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    const next = structuredClone(brief);
    next.shots.splice(1, 1);
    updateFromBrief(doc, next);
    expect(ranges(doc)).toEqual([
      [SHOT_A, 1, 72],
      [SHOT_C, 73, 144],
    ]);
    expect([1, 36, 72].map((f) => hiddenAt(doc, pip, f))).toEqual([false, false, false]);
    expect(hiddenAt(doc, pip, 100)).toBe(true);
  });

  it('pins a curve where frames are inserted or deleted, so neither side changes', () => {
    const doc = newDoc();
    const id = doc.addObject({ name: 'Box', type: 'EMPTY' });
    const keys = [10, 20, 30, 40, 50].map((f) => ({ frame: f, value: f, interpolation: 'LINEAR' as const }));
    const fc: FCurve = {
      target_type: 'object',
      target_id: id,
      path: 'location',
      index: 0,
      keyframes: keys,
      extrapolation: 'CONSTANT',
      mute: false,
    };
    doc.setFCurve(fc);
    const at = (f: number) => channel(doc, id, 'location', 0, f);
    deleteSceneTime(doc, 25, 48);
    // frames before the cut and after it (24 earlier) keep their values
    expect([21, 22, 23, 24].map(at)).toEqual([21, 22, 23, 24]);
    expect([25, 26].map(at)).toEqual([49, 50]);
    insertSceneTime(doc, 22, 10);
    // the inserted frames hold the value of frame 22; then 23 and on resume 10 later
    expect([20, 22, 25, 32].map(at)).toEqual([20, 22, 22, 22]);
    expect([33, 34, 35, 36].map(at)).toEqual([23, 24, 49, 50]);
  });
});

describe('ripple edits and the ranges they move', () => {
  it('keeps a new first shot inside the scene and the rigid body world ranges', () => {
    const doc = staged();
    const scene = doc.getScene();
    expect(scene.frame_start).toBe(1);
    const next = openScene();
    next.shots.unshift({ ...next.shots[1], id: 'sht_0123456789zero', index: 0, durationSec: 1, layout: [] });
    next.shots[1].index = 1;
    next.shots[2].index = 2;
    updateFromBrief(doc, next);
    expect(ranges(doc)[0]).toEqual(['sht_0123456789zero', 1, 24]);
    expect(doc.getScene().frame_start).toBe(1);
    expect(doc.getScene().rigidbody_world?.frame_start ?? 1).toBe(1);
  });

  it('removes a shot and an F-curve modifier range that lie inside deleted frames', () => {
    const doc = newDoc();
    const cam = doc.addObject({ name: 'Cam', type: 'EMPTY' });
    setShots(
      doc,
      [
        ['A', 1, 24],
        ['B', 25, 48],
        ['C', 49, 72],
      ].map(([name, a, b]) => ({
        id: `s${name}`,
        name: name as string,
        enabled: true,
        camera: null,
        frame_start: a as number,
        frame_end: b as number,
        notes: '',
        framing: null,
        angle: null,
        height: null,
        move: null,
        lens_mm: null,
        subjects: [],
        layout: [],
        continuity: 'cut',
        pre_roll: 0,
        external: null,
      })),
    );
    doc.setFCurve({
      target_type: 'object',
      target_id: cam,
      path: 'location',
      index: 0,
      keyframes: [
        { frame: 1, value: 0, interpolation: 'LINEAR' },
        { frame: 72, value: 1, interpolation: 'LINEAR' },
      ],
      extrapolation: 'CONSTANT',
      mute: false,
      modifiers: [
        {
          type: 'NOISE',
          params: { use_restricted_range: true, frame_start: 25, frame_end: 45, strength: 1 },
        },
        {
          type: 'NOISE',
          params: { use_restricted_range: true, frame_start: 10, frame_end: 60, strength: 1 },
        },
      ],
    });
    const warnings = deleteSceneTime(doc, 25, 48);
    expect(getShots(doc).map((s) => [s.name, s.frame_start, s.frame_end])).toEqual([
      ['A', 1, 24],
      ['C', 25, 48],
    ]);
    expect(warnings).toEqual(["'B' lay inside the 24 frames deleted from frame 25: it left the cut"]);
    const mods = doc.listFCurves(cam)[0].modifiers!;
    expect(mods.map((m) => [m.params.frame_start, m.params.frame_end])).toEqual([[10, 36]]);
  });
});

describe('riders', () => {
  it('says so when an update stages a shot whose words seat a rider it does not seat', () => {
    const brief: SceneBrief = {
      id: 'scene-ride',
      name: 'A ride',
      fps: 24,
      width: 640,
      height: 360,
      set: { description: 'A meadow.', interior: false, timeOfDay: null },
      cast: [
        { id: 'lily', name: 'Lily', description: 'A girl of 9.', kind: 'child', heightM: null },
        { id: 'star', name: 'Star', description: 'A brown horse.', kind: 'horse', heightM: null },
      ],
      elements: [],
      shots: [
        {
          id: 's1',
          index: 0,
          durationSec: 2,
          description: 'Medium: Lily walks beside Star.',
          action: '',
          castIds: ['lily', 'star'],
          elementIds: [],
          framing: 'medium',
          movement: 'static',
          move: null,
          lensMm: null,
          continuity: 'cut',
          layout: [],
        },
      ],
    };
    const ride = structuredClone(brief);
    ride.shots.push({
      ...brief.shots[0],
      id: 's2',
      index: 1,
      description: 'Medium: Lily rides Star across the field.',
    });
    // staging the brief with the ride seats her
    const direct = staged(ride);
    const lilyIn = actorOf(direct, 'lily').id;
    const starIn = actorOf(direct, 'star').id;
    const s2 = deskShot(direct, 's2');
    expect(attachSpans(direct, lilyIn, RIDE_PREFIX).some((s) => s.constraint.target === starIn)).toBe(true);
    expect(s2.frame_start).toBeGreaterThan(deskShot(direct, 's1').frame_end + 1);
    // an update that adds it does not, and says so
    const doc = staged(brief);
    const r = updateFromBrief(doc, ride);
    const lily = actorOf(doc, 'lily').id;
    expect(attachSpans(doc, lily, RIDE_PREFIX)).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(
      /Shot 2: the brief says Lily rides Star, but an update does not seat riders: seat Lily with desk.actor_mount \(frame 49\)/,
    );
  });
});
