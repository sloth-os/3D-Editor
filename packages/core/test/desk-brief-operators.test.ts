import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import {
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  type OperatorContext,
} from '../src/operators';
import { getShots } from '../src/desk/shots';
import { stageBrief, updateFromBrief, type SceneBrief } from '../src/desk/brief';
import { MAX_BRIEF_PRE_ROLL } from '../src/desk/brief/stage';

/*
 * The brief operators (operators/desk-brief.ts) and their memory estimates (memory-desk.ts): a
 * brief's cast stands on its marks (nobody walks), so its staging is estimated by the keys it writes
 * (a pose per actor, a mark and a visibility per actor and shot, each shot's camera move), not by a
 * gait on every frame; an update by what it stages of the brief (what changed since the record).
 * The pre-roll before a cut where a rider gets on or off is bounded as the staging engine bounds it.
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const openScene = (): SceneBrief =>
  structuredClone(JSON.parse(readFileSync(new URL('open.json', FIXTURES), 'utf8')).scene);

function setup() {
  const reg = createOperatorRegistry();
  const doc = SceneDoc.create({ empty: true });
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'api',
    report: () => {},
  };
  const estimate = (id: string, params: Record<string, unknown>) =>
    estimateOperator(id, ctx, reg.parseParams(id, params));
  return { reg, doc, ctx, estimate };
}

/** A brief of `shots` shots of `seconds` each, `cast` people in each (a third of them out of each shot). */
function crowd(shots: number, seconds: number, cast: number): SceneBrief {
  const people = Array.from({ length: cast }, (_, i) => ({
    id: `c${i}`,
    name: `Person ${i}`,
    description: 'An adult.',
    kind: 'person',
    heightM: null,
  }));
  return {
    id: 'crowd',
    name: 'Crowd',
    fps: 24,
    width: 640,
    height: 360,
    set: { description: 'A meadow.', interior: false, timeOfDay: null },
    cast: people,
    elements: [],
    shots: Array.from({ length: shots }, (_, i) => ({
      id: `s${i}`,
      index: i,
      durationSec: seconds,
      description: `Wide: everyone waits (${i + 1}).`,
      action: '',
      castIds: people.filter((_, k) => (k + i) % 3 !== 0).map((c) => c.id),
      elementIds: [],
      framing: 'wide' as const,
      movement: 'static',
      move: null,
      lensMm: null,
      continuity: 'cut' as const,
      layout: [],
    })),
  };
}

const keysOf = (doc: SceneDoc) => doc.listFCurves().reduce((n, fc) => n + fc.keyframes.length, 0);

describe('brief memory estimates', () => {
  it('estimate a staging by the keys it writes: no gait on every frame', () => {
    const { estimate } = setup();
    // 60 shots of 5 s with 8 people: the import's gait estimate said 3,097,560 keyframes, more
    // than the server keeps for a project, and refused a brief that stages about 1,500
    const e = estimate('desk.stage_brief', { brief: crowd(60, 5, 8) })!;
    expect(e.keyframes).toBeLessThan(20_000);
    expect(e.bytes).toBeLessThan(300 * 2 ** 20);
  });

  it('bound what a staging adds', () => {
    const { doc, estimate } = setup();
    const brief = crowd(6, 2, 3);
    const e = estimate('desk.stage_brief', { brief })!;
    const objects = doc.listObjects().length;
    stageBrief(doc, brief);
    expect(keysOf(doc)).toBeLessThanOrEqual(e.keyframes!);
    expect(doc.listObjects().length - objects).toBeLessThanOrEqual(e.objects!);
  });

  it('estimate an update by what it stages of the brief', () => {
    const { doc, estimate } = setup();
    stageBrief(doc, openScene());
    const staging = estimate('desk.stage_brief', { brief: openScene() })!;
    // the brief as staged: nothing to key
    expect(estimate('desk.update_from_brief', { brief: openScene() })?.keyframes ?? 0).toBe(0);
    // a new shot: its keys only, and they bound what the update adds
    const next = openScene();
    next.shots.push({ ...next.shots[1], id: 'sht_0123456789cccc', index: 2 });
    const e = estimate('desk.update_from_brief', { brief: next })!;
    expect(e.keyframes).toBeGreaterThan(0);
    expect(e.keyframes).toBeLessThan(staging.keyframes!);
    const before = keysOf(doc);
    updateFromBrief(doc, next);
    expect(keysOf(doc) - before).toBeLessThanOrEqual(e.keyframes!);
  });

  it('estimate an update with the checks it runs over every shot it keeps, as desk.check counts them', () => {
    // 60 shots of 5 s with 8 people, one shot retimed: the update solves that shot but checks all
    // 60 afterwards. Counting only the shot it solves, the estimate said 34 MB, where the update
    // needed 90–140 MB above the staged project (out of memory at a 128 MB heap, fine at 176 MB, the
    // project taking 38 MB), and desk.check alone on it estimates 163 MB.
    const { doc, estimate } = setup();
    const brief = crowd(60, 5, 8);
    stageBrief(doc, brief);
    const next = structuredClone(brief);
    next.shots[1].durationSec = 6;
    const update = estimate('desk.update_from_brief', { brief: next })!;
    const check = estimate('desk.check', {})!;
    expect(check.bytes).toBeGreaterThan(100 * 2 ** 20);
    expect(update.bytes).toBeGreaterThanOrEqual(check.bytes);
    // the brief as staged changes nothing, but the update still checks every shot
    expect(estimate('desk.update_from_brief', { brief })!.bytes).toBeGreaterThanOrEqual(check.bytes);
  });
});

describe('the pre-roll before a cut where a rider gets on or off', () => {
  it('is bounded as the staging engine bounds it', () => {
    const { reg, ctx } = setup();
    const refused = reg.run(ctx, 'desk.stage_brief', {
      brief: openScene(),
      pre_roll_frames: MAX_BRIEF_PRE_ROLL + 1,
    });
    expect(refused).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(refused.error).toMatch(/pre_roll_frames/);
    expect(refused.error).not.toMatch(/blocking import|preRollFrames/);
    expect(() => stageBrief(SceneDoc.create({ empty: true }), openScene(), { preRollFrames: 5000 })).toThrow(
      /pre-roll must be a whole number of frames from 0 to 1000/,
    );
    expect(
      reg.run(ctx, 'desk.stage_brief', { brief: openScene(), pre_roll_frames: MAX_BRIEF_PRE_ROLL }).ok,
    ).toBe(true);
  });

  it('is the gap staging leaves before a shot where a rider gets on', () => {
    const brief: SceneBrief = {
      id: 'ride',
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
        {
          id: 's2',
          index: 1,
          durationSec: 2,
          description: 'Medium: Lily rides Star across the field.',
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
    const doc = SceneDoc.create({ empty: true });
    stageBrief(doc, brief, { preRollFrames: 30 });
    const [a, b] = getShots(doc);
    expect([a.frame_start, a.frame_end, a.pre_roll]).toEqual([1, 48, 0]);
    expect([b.frame_start, b.frame_end, b.pre_roll]).toEqual([79, 126, 30]);
  });
});
