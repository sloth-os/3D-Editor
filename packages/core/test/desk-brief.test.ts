import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, fcurveKey } from '../src/doc/scene-doc';
import type { ObjectData } from '../src/doc/types';
import { evaluateFCurve } from '../src/anim/fcurve';
import { OperatorError, createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import { getDeskSettings, getShots } from '../src/desk/shots';
import { skySunRotation } from '../src/desk/set';
import { FRAMING_TABLE } from '../src/desk/solver';
import { HIDE_SCALE } from '../src/desk/hide';
import { BUILT_KINDS } from '../src/desk/characters';
import { setKey } from '../src/desk/rideo/keys';
import { clearAnimation } from '../src/desk/rideo/keys';
import {
  SceneBriefSchema,
  TIME_OF_DAY_SUN,
  briefChanges,
  briefRecord,
  shotResults,
  stageBrief,
  updateFromBrief,
  type SceneBrief,
} from '../src/desk/brief';
import { hostShots } from '../src/desk/brief/stage';
import { WATER_CLEARANCE_M } from '../src/desk/brief/plan';

/*
 * Staging from a host's brief (desk/brief; the desk embed protocol v1's SceneBrief): the open.json
 * fixture staged (Mira, a child, and Pip, a dog, over 72 and 60 frames at 24 fps, cameras by framing,
 * the afternoon sun, the kite in Mira's hand, the pond on the left clear of the cast), generic host
 * ids, kinds the desk cannot build, the time of day, the words of the set, how a later brief differs,
 * an update that keeps what was done by hand, the shot results, the schema against every fixture
 * scene, and that all of it runs without DOM or Node APIs (a web worker).
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const openScene = (): SceneBrief => structuredClone(fixture('open.json').scene);

const MIRA = 'chr_0123456789mira';
const PIP = 'chr_0123456789pipd';
const SHOT_A = 'sht_0123456789aaaa';
const SHOT_B = 'sht_0123456789bbbb';
const SHOT_C = 'sht_0123456789cccc';
const KITE = 'ele_0123456789kite';

const newDoc = () => SceneDoc.create({ empty: true });

function staged(brief: SceneBrief = openScene()) {
  const doc = newDoc();
  const report = stageBrief(doc, brief);
  return { doc, report };
}

const prop = (o: ObjectData | null | undefined, key: string) => o?.custom_props?.[key];
const actorOf = (doc: SceneDoc, castId: string) =>
  doc.listObjects().find((o) => prop(o, 'desk_role') === 'actor' && prop(o, 'desk_character_id') === castId);

/** An object channel's value at `frame` (its F-curve, else its stored value). */
function channel(doc: SceneDoc, id: string, path: 'location' | 'scale', i: number, frame: number): number {
  const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index: i }));
  return (fc ? evaluateFCurve(fc, frame) : undefined) ?? doc.getObject(id)![path][i];
}

/** Whether object `id` is hidden at `frame` (shrunk by a hide key). */
const hiddenAt = (doc: SceneDoc, id: string, frame: number) =>
  Math.abs(channel(doc, id, 'scale', 0, frame)) <=
  HIDE_SCALE * 10 * Math.abs(doc.getObject(id)!.scale[0] || 1);

/** The brief that adds shot C (Pip at the pond) and makes shot B a second longer (the opened-changed fixture). */
function addedAndRetimed(): SceneBrief {
  const next = openScene();
  next.shots[1].durationSec = 3.5;
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

function briefOf(over: Partial<SceneBrief> = {}): SceneBrief {
  return {
    id: 'scene-1',
    name: 'A scene',
    fps: 24,
    width: 640,
    height: 360,
    set: { description: 'A meadow.', interior: false, timeOfDay: null },
    cast: [{ id: 'ada', name: 'Ada', description: 'A woman in a coat.', kind: 'person', heightM: null }],
    elements: [],
    shots: [
      {
        id: 's1',
        index: 0,
        durationSec: 1,
        description: 'Medium: Ada waits.',
        action: '',
        castIds: ['ada'],
        elementIds: [],
        framing: 'medium',
        movement: 'static',
        move: null,
        lensMm: null,
        continuity: 'cut',
        layout: [],
      },
    ],
    ...over,
  };
}

function refusal(fn: () => unknown): OperatorError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OperatorError) return e;
    throw e;
  }
  throw new Error('expected an OperatorError');
}

describe('stageBrief: the open.json fixture', () => {
  let doc: SceneDoc;
  let report: ReturnType<typeof stageBrief>;
  beforeAll(() => ({ doc, report } = staged()));

  it('stages the cast as actors of the kinds the brief gives, keeping the host ids', () => {
    expect(report.cast.map((c) => [c.castId, c.kind])).toEqual([
      [MIRA, 'child'],
      [PIP, 'dog'],
    ]);
    for (const c of report.cast) expect(prop(doc.getObject(c.object), 'desk_character_id')).toBe(c.castId);
    expect(actorOf(doc, MIRA)!.name).toBe('Mira');
    expect(report.warnings).toEqual([]);
  });

  it('gives the scene the brief frame rate and size, and each shot round(durationSec × fps) frames', () => {
    expect(doc.getScene().fps).toBe(24);
    expect(doc.getRender()).toMatchObject({ resolution_x: 1280, resolution_y: 720 });
    expect(report.shots.map((s) => [s.shotId, s.frames])).toEqual([
      [SHOT_A, 72],
      [SHOT_B, 60],
    ]);
    const shots = getShots(doc);
    expect(shots.map((s) => [s.frame_start, s.frame_end])).toEqual([
      [1, 72],
      [73, 132],
    ]);
    // the host's ids are the shots' external reference
    expect(shots.map((s) => s.external)).toEqual([
      { source: 'host', project: null, clip: 'clp_0123456789abcdef', shot: SHOT_A, index: 0 },
      { source: 'host', project: null, clip: 'clp_0123456789abcdef', shot: SHOT_B, index: 1 },
    ]);
  });

  it('solves every camera from its framing, lens and move, fitted to the planned layout', () => {
    const [a, b] = getShots(doc);
    expect([a.framing, a.move, b.framing, b.move, b.lens_mm]).toEqual([
      'wide',
      'tracking_follow',
      'close_up',
      'push_in',
      85,
    ]);
    expect(report.solved).toEqual([SHOT_A, SHOT_B]);
    expect(doc.getCamera(doc.getObject(a.camera!)!.data!)!.lens).toBeCloseTo(FRAMING_TABLE.wide.lens_mm, 5);
    expect(doc.getCamera(doc.getObject(b.camera!)!.data!)!.lens).toBeCloseTo(85, 5);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('hides the cast not in a shot there (Pip in the close-up)', () => {
    const pip = actorOf(doc, PIP)!;
    const mira = actorOf(doc, MIRA)!;
    expect(hiddenAt(doc, pip.id, 30)).toBe(false);
    expect(hiddenAt(doc, pip.id, 100)).toBe(true);
    expect(hiddenAt(doc, mira.id, 100)).toBe(false);
  });

  it('lights the set with the afternoon sun', () => {
    const sun = TIME_OF_DAY_SUN.afternoon;
    const world = doc.getWorld();
    expect(world.environment).toBe('SKY');
    expect(world.sun_rotation).toBeCloseTo(skySunRotation(sun.azimuthDeg), 6);
    expect(world.sun_elevation).toBeCloseTo((sun.elevationDeg * Math.PI) / 180, 6);
    expect(getDeskSettings(doc).interior).toBe(false);
  });

  it('places the kite in Mira’s hand, flying on its string', () => {
    expect(report.props).toEqual([{ elementId: KITE, object: expect.any(String), heldBy: MIRA }]);
    const kite = doc.getObject(report.props[0].object)!;
    expect(prop(kite, 'desk_element_id')).toBe(KITE);
    expect(String(prop(kite, 'desk_tether_flights'))).toMatch(/^\d+:\d+/);
  });

  it('puts the pond the set names on the left, clear of the cast', () => {
    const pond = doc.listObjects().find((o) => prop(o, 'desk_role') === 'landmark')!;
    expect(pond).toBeDefined();
    const xs = [MIRA, PIP].map((c) => actorOf(doc, c)!.location[0]);
    expect(pond.location[0]).toBeLessThan(Math.min(...xs) - WATER_CLEARANCE_M);
  });

  it('records the brief it was staged from', () => {
    expect(briefRecord(doc)).toEqual({ sceneId: 'clp_0123456789abcdef', hash: report.hash });
    expect(report.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('stageBrief', () => {
  it('stages in one undo step', () => {
    const doc = newDoc();
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    stageBrief(doc, openScene());
    expect(getShots(doc)).toHaveLength(2);
    undo.undo();
    expect(getShots(doc)).toHaveLength(0);
    expect(doc.listObjects()).toHaveLength(0);
    expect(briefRecord(doc)).toBeNull();
  });

  it('keeps any id the contract allows (dots, colons, dashes) as the host ids', () => {
    const brief = briefOf({
      id: 'proj:42.scene-7',
      cast: [{ id: 'cast.ada:1', name: 'Ada', description: 'A woman.', kind: null, heightM: 1.65 }],
    });
    brief.shots[0] = { ...brief.shots[0], id: 'shot_1.v2:take-3', castIds: ['cast.ada:1'] };
    const { doc, report } = staged(brief);
    expect([...hostShots(doc, 'proj:42.scene-7').keys()]).toEqual(['shot_1.v2:take-3']);
    expect(report.cast[0]).toMatchObject({ castId: 'cast.ada:1', kind: 'woman' });
    expect(prop(actorOf(doc, 'cast.ada:1'), 'desk_character_id')).toBe('cast.ada:1');
  });

  it('stages animals it has no figure for as the nearest kind it builds, with warnings', () => {
    const brief = briefOf({
      cast: [
        { id: 'daisy', name: 'Daisy', description: 'A white duck.', kind: 'duck', heightM: null },
        { id: 'gus', name: 'Gus', description: 'A tall man in a hat.', kind: 'griffin', heightM: null },
        { id: 'tweety', name: 'Tweety', description: 'A small yellow bird.', kind: null, heightM: null },
      ],
    });
    brief.shots[0].castIds = ['daisy', 'gus', 'tweety'];
    const { report } = staged(brief);
    const kinds = Object.fromEntries(report.cast.map((c) => [c.castId, c.kind]));
    expect(kinds).toEqual({ daisy: 'cat', gus: 'man', tweety: 'cat' });
    for (const k of Object.values(kinds)) expect(BUILT_KINDS).toContain(k);
    expect(report.warnings.join('\n')).toMatch(/Daisy is a duck: the desk has no duck figure/);
    expect(report.warnings.join('\n')).toMatch(/Gus's kind 'griffin' is not one the desk builds/);
    expect(report.warnings.join('\n')).toMatch(/Tweety is a bird/);
  });

  it('lights the set by the time of day, keeping the default sun without one', () => {
    const night = staged(
      briefOf({ set: { description: 'A park.', interior: false, timeOfDay: 'night' } }),
    ).doc;
    expect(night.getWorld().sun_elevation).toBeCloseTo(
      (TIME_OF_DAY_SUN.night.elevationDeg * Math.PI) / 180,
      6,
    );
    expect(night.getWorld().sun_rotation).toBeCloseTo(skySunRotation(TIME_OF_DAY_SUN.night.azimuthDeg), 6);
    const none = staged(briefOf()).doc;
    expect(none.getWorld().sun_elevation).toBeCloseTo((40 * Math.PI) / 180, 6);
    expect(none.getWorld().sun_rotation).toBeCloseTo(skySunRotation(135), 6);
  });

  it('reads an interior and water from the words when the brief leaves them open', () => {
    const inside = staged(
      briefOf({
        set: { description: 'Inside a small kitchen, morning light.', interior: null, timeOfDay: null },
      }),
    ).doc;
    expect(getDeskSettings(inside).interior).toBe(true);
    const lake = staged(
      briefOf({
        set: { description: 'A grassy bank.', interior: null, timeOfDay: null },
        elements: [
          { id: 'loc', name: 'The lake', description: 'A wide lake behind them.', kind: 'location' },
        ],
      }),
    ).doc;
    expect(getDeskSettings(lake).interior).toBe(false);
    const water = lake.listObjects().find((o) => prop(o, 'desk_role') === 'landmark')!;
    // behind the cast: further from the camera's side (−Y is the front)
    expect(water.location[1]).toBeGreaterThan(actorOf(lake, 'ada')!.location[1] + WATER_CLEARANCE_M);
  });

  it('refuses a brief that does not validate, a project with shots, and a second staging', () => {
    expect(refusal(() => stageBrief(newDoc(), { ...openScene(), width: 1281 })).code).toBe('INVALID_PARAMS');
    const { doc } = staged(briefOf());
    const again = refusal(() => stageBrief(doc, briefOf()));
    expect(again.code).toBe('INVALID_PARAMS');
    expect(again.message).toMatch(/already staged from scene 'scene-1'/);
    expect(refusal(() => stageBrief(doc, briefOf({ id: 'other' }))).message).toMatch(
      /staged from scene 'scene-1', not 'other'/,
    );
  });

  it('runs as desk.stage_brief, reporting its warnings', () => {
    const doc = newDoc();
    const reg = createOperatorRegistry();
    const reports: string[] = [];
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'api',
      report: (_l, m) => reports.push(m),
    };
    const brief = briefOf();
    brief.cast[0] = { ...brief.cast[0], kind: 'duck', description: 'A duck.' };
    const res = reg.run<{ shots: unknown[] }>(ctx, 'desk.stage_brief', { brief });
    expect(res.ok, res.error).toBe(true);
    expect(res.result!.shots).toHaveLength(1);
    expect(reports.some((m) => /duck figure/.test(m))).toBe(true);
    const bad = reg.run(ctx, 'desk.stage_brief', { brief: { id: 'x' } });
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });
});

describe('briefChanges', () => {
  let doc: SceneDoc;
  beforeAll(() => ({ doc } = staged()));

  it('is null for the brief staged, and lists what a later brief adds and retimes', () => {
    expect(briefChanges(doc, openScene())).toBeNull();
    expect(briefChanges(doc, addedAndRetimed())).toEqual(fixture('opened-changed.json').changes);
  });

  it('lists recast shots and the cast added and removed', () => {
    const next = openScene();
    next.cast = next.cast.filter((c) => c.id !== PIP);
    next.cast.push({ id: 'chr_lena', name: 'Lena', description: 'A girl of 9.', kind: null, heightM: null });
    next.shots[0].castIds = [MIRA, 'chr_lena'];
    next.shots[0].layout = [];
    expect(briefChanges(doc, next)).toEqual({
      added: [],
      removed: [],
      retimed: [],
      recast: [SHOT_A],
      cast: { added: ['chr_lena'], removed: [PIP] },
    });
  });

  it('counts frames: a new frame rate retimes every shot', () => {
    expect(briefChanges(doc, { ...openScene(), fps: 30 })?.retimed).toEqual([SHOT_A, SHOT_B]);
  });

  it('lists every shot and cast member of a brief the project was not staged from', () => {
    expect(briefChanges(newDoc(), openScene())).toEqual({
      added: [SHOT_A, SHOT_B],
      removed: [],
      retimed: [],
      recast: [],
      cast: { added: [MIRA, PIP], removed: [] },
    });
  });
});

describe('updateFromBrief', () => {
  it('keeps a hand-moved actor and a hand-set camera of an unchanged shot through an update that adds a shot and retimes another', () => {
    const { doc } = staged();
    const pip = actorOf(doc, PIP)!;
    const [a, b] = getShots(doc);
    // by hand: Pip moved in shot A (keyed), shot A's camera placed and its animation cleared
    setKey(doc, pip.id, 'location', 0, a.frame_start, 2.5);
    clearAnimation(doc, a.camera!);
    doc.updateObject(a.camera!, { location: [9, -9, 3] });
    const bKeysBefore = doc.listFCurves(b.camera!).flatMap((fc) => fc.keyframes.map((k) => k.frame));

    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const r = updateFromBrief(doc, addedAndRetimed());
    expect(r.changes).toEqual(fixture('opened-changed.json').changes);
    expect(r.solved).toEqual([SHOT_C]);

    const shots = getShots(doc);
    expect(shots.map((s) => [s.external?.shot, s.frame_start, s.frame_end])).toEqual([
      [SHOT_A, 1, 72],
      [SHOT_B, 73, 156],
      [SHOT_C, 157, 204],
    ]);
    // shot A as it was left by hand
    expect(channel(doc, pip.id, 'location', 0, 36)).toBeCloseTo(2.5, 6);
    expect(doc.getObject(a.camera!)!.location).toEqual([9, -9, 3]);
    expect(doc.listFCurves(a.camera!)).toEqual([]);
    // shot B's camera move fitted to its new length
    const bKeys = doc.listFCurves(b.camera!).flatMap((fc) => fc.keyframes.map((k) => k.frame));
    expect(Math.max(...bKeysBefore)).toBeLessThanOrEqual(132);
    expect(Math.max(...bKeys)).toBeGreaterThan(132);
    expect(Math.max(...bKeys)).toBeLessThanOrEqual(156);
    // shot C: a solved camera, Pip shown, Mira and her kite hidden
    const c = shots[2];
    expect(c.camera).not.toBe(b.camera);
    expect(c.subjects).toEqual([pip.id]);
    expect(hiddenAt(doc, pip.id, 180)).toBe(false);
    expect(hiddenAt(doc, actorOf(doc, MIRA)!.id, 180)).toBe(true);
    const kite = r.props.find((p) => p.elementId === KITE)!.object;
    expect(hiddenAt(doc, kite, 180)).toBe(true);
    expect(hiddenAt(doc, kite, 100)).toBe(false);
    // the staging now is the new brief's; one undo step takes the update back
    expect(briefChanges(doc, addedAndRetimed())).toBeNull();
    undo.undo();
    expect(getShots(doc).map((s) => s.frame_end)).toEqual([72, 132]);
    expect(briefChanges(doc, openScene())).toBeNull();
  });

  it('removes a shot with its frames, the shots after it moving earlier, and shows a recast shot’s new cast', () => {
    const { doc } = staged();
    const [a, b] = getShots(doc);
    const next = openScene();
    next.shots = [{ ...next.shots[1], castIds: [MIRA, PIP] }];
    const r = updateFromBrief(doc, next);
    expect(r.changes).toMatchObject({ removed: [SHOT_A], recast: [SHOT_B] });
    const shots = getShots(doc);
    expect(shots.map((s) => [s.id, s.frame_start, s.frame_end])).toEqual([[b.id, 1, 60]]);
    expect(doc.getObject(a.camera!)).toBeNull();
    const pip = actorOf(doc, PIP)!;
    expect(shots[0].subjects).toContain(pip.id);
    expect(hiddenAt(doc, pip.id, 30)).toBe(false);
    expect(r.solved).toEqual([SHOT_B]);
  });

  it('removes the cast the brief no longer has and stages new members on a free mark', () => {
    const { doc } = staged();
    const next = openScene();
    next.cast = [
      next.cast[0],
      { id: 'chr_lena', name: 'Lena', description: 'A girl of 9.', kind: null, heightM: null },
    ];
    next.shots[0].castIds = [MIRA, 'chr_lena'];
    next.shots[0].layout = [];
    const r = updateFromBrief(doc, next);
    expect(actorOf(doc, PIP)).toBeUndefined();
    const lena = actorOf(doc, 'chr_lena')!;
    expect(r.cast.map((c) => [c.castId, c.kind])).toEqual([
      [MIRA, 'child'],
      ['chr_lena', 'child'],
    ]);
    const mira = actorOf(doc, MIRA)!;
    expect(
      Math.hypot(lena.location[0] - mira.location[0], lena.location[1] - mira.location[1]),
    ).toBeGreaterThan(0.6);
    // shown in shot A only
    expect(hiddenAt(doc, lena.id, 30)).toBe(false);
    expect(hiddenAt(doc, lena.id, 100)).toBe(true);
    for (const s of getShots(doc)) expect(s.subjects.every((id) => doc.getObject(id))).toBe(true);
  });

  it('refuses a project not staged from a brief, or staged from another scene', () => {
    expect(refusal(() => updateFromBrief(newDoc(), openScene())).message).toMatch(/not staged from a brief/);
    const { doc } = staged(briefOf());
    expect(refusal(() => updateFromBrief(doc, openScene())).code).toBe('INVALID_PARAMS');
  });
});

describe('shotResults', () => {
  let doc: SceneDoc;
  beforeAll(() => ({ doc } = staged()));

  it('reports each staged shot in brief order: frames, duration, camera, line, moves, plan and checks', () => {
    const [a, b] = shotResults(doc);
    expect(a).toMatchObject({
      shotId: SHOT_A,
      frames: 72,
      durationSec: 3,
      camera: { lensMm: FRAMING_TABLE.wide.lens_mm, move: 'tracking_follow' },
      moves: null,
      planAgrees: true,
      issues: [],
    });
    expect(a.line).toMatch(/Mira is left of frame, facing right; Pip is right of frame, facing left/);
    expect(b).toMatchObject({
      shotId: SHOT_B,
      frames: 60,
      durationSec: 2.5,
      camera: { lensMm: 85, move: 'push_in' },
      planAgrees: null,
    });
    expect(b.line).toMatch(/Mira/);
    expect(b.line).not.toMatch(/Pip/);
  });

  it('reports the shots asked for, in that order, and refuses unknown ones', () => {
    expect(shotResults(doc, { shots: [SHOT_B, SHOT_A] }).map((r) => r.shotId)).toEqual([SHOT_B, SHOT_A]);
    expect(refusal(() => shotResults(doc, { shots: ['nope'] })).code).toBe('NOT_FOUND');
    expect(refusal(() => shotResults(newDoc())).code).toBe('INVALID_PARAMS');
  });
});

describe('SceneBriefSchema', () => {
  it('accepts every fixture scene and refuses every invalid one', () => {
    for (const name of ['open.json', 'open-with-state.json'])
      expect(SceneBriefSchema.safeParse(fixture(name).scene).success, name).toBe(true);
    const invalid = readdirSync(new URL('invalid/', FIXTURES));
    expect(invalid.length).toBeGreaterThanOrEqual(4);
    for (const name of invalid)
      expect(SceneBriefSchema.safeParse(fixture(`invalid/${name}`).scene).success, name).toBe(false);
  });

  it('holds the contract’s limits and cross-references', () => {
    const ok = (b: unknown) => SceneBriefSchema.safeParse(b).success;
    expect(ok(briefOf())).toBe(true);
    expect(ok(briefOf({ fps: 121 }))).toBe(false);
    expect(ok(briefOf({ height: 17 }))).toBe(false);
    expect(ok(briefOf({ id: '-x' }))).toBe(false);
    const many = Array.from({ length: 17 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      description: '',
      kind: null,
      heightM: null,
    }));
    expect(ok(briefOf({ cast: many }))).toBe(false);
    const layout = briefOf();
    layout.shots[0].layout = [{ castId: 'zed', side: 'left', facing: 'right' }];
    expect(ok(layout)).toBe(false);
    const element = briefOf();
    element.shots[0].elementIds = ['nothing'];
    expect(ok(element)).toBe(false);
    const order = briefOf();
    order.shots.push({ ...order.shots[0], id: 's2', index: 0 });
    expect(ok(order)).toBe(false);
    const duration = briefOf();
    duration.shots[0].durationSec = 0;
    expect(ok(duration)).toBe(false);
  });
});

describe('worker safety', () => {
  const NODE = ['process', 'Buffer', 'setImmediate', 'global', 'require', '__dirname'];
  const DOM = ['window', 'document', 'self', 'localStorage', 'XMLHttpRequest', 'fetch', 'HTMLElement'];

  /** Runs `fn` with Node and DOM globals replaced by getters that record each read. */
  function trapped(fn: () => void): string[] {
    const read: string[] = [];
    const saved: [string, PropertyDescriptor | undefined][] = [];
    for (const name of [...NODE, ...DOM]) {
      const d = Object.getOwnPropertyDescriptor(globalThis, name);
      if (d && !d.configurable) continue;
      saved.push([name, d]);
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          read.push(name);
          return undefined;
        },
      });
    }
    try {
      fn();
    } finally {
      for (const [name, d] of saved)
        if (d) Object.defineProperty(globalThis, name, d);
        else delete (globalThis as Record<string, unknown>)[name];
    }
    return read;
  }

  it('stages, updates and reports without reading a DOM or Node global', () => {
    const doc = newDoc();
    const read = trapped(() => {
      stageBrief(doc, openScene());
      briefChanges(doc, addedAndRetimed());
      updateFromBrief(doc, addedAndRetimed());
      shotResults(doc);
    });
    expect(read).toEqual([]);
    expect(getShots(doc)).toHaveLength(3);
  });

  it('imports no Node module and names no DOM API', () => {
    const dir = new URL('../src/desk/brief/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, f).not.toMatch(/from 'node:|require\(|\bdocument\.|\bwindow\.|\bprocess\./);
    }
  });
});
