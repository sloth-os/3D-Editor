import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { OperatorError } from '../src/operators/context';
import { getShots, setShots } from '../src/desk/shots';
import { planExport, videoExportParamsSchema } from '../src/export';
import { stageBrief, type SceneBrief } from '../src/desk/brief';
import { hostShots } from '../src/desk/brief/stage';
import { outputFramesAt, shotResults, shotResultsOf } from '../src/desk/brief/results';

/*
 * The shot results of a staged brief (desk/brief/results.ts), as the desk embed protocol's result
 * needs them: in brief order whatever order they are asked in, a shot without a staging named on
 * its own (the others still come back), and frames and durations at the brief's frame rate counted
 * as an export at that rate plans them (core's planExport), also after the scene's frame rate
 * changed in the desk.
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);
const openScene = (): SceneBrief =>
  structuredClone(JSON.parse(readFileSync(new URL('open.json', FIXTURES), 'utf8')).scene);

const SHOT_A = 'sht_0123456789aaaa';
const SHOT_B = 'sht_0123456789bbbb';

function staged(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  stageBrief(doc, openScene());
  return doc;
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

/** The frames an export of desk shot `deskShotId` at `fps` plans (the engine's count). */
function plannedFrames(doc: SceneDoc, deskShotId: string, fps: number): number {
  const params = videoExportParamsSchema.parse({ preset: 'reference', shots: [deskShotId], fps });
  return planExport(doc, params).shots[0].outFrames;
}

describe('shotResults: order and shots without a staging', () => {
  let doc: SceneDoc;
  beforeAll(() => (doc = staged()));

  it('keeps brief order whatever order the shots are asked in', () => {
    expect(shotResults(doc).map((r) => r.shotId)).toEqual([SHOT_A, SHOT_B]);
    expect(shotResults(doc, { shots: [SHOT_B, SHOT_A] }).map((r) => r.shotId)).toEqual([SHOT_A, SHOT_B]);
    expect(shotResults(doc, { shots: [SHOT_B, SHOT_B] }).map((r) => r.shotId)).toEqual([SHOT_B]);
  });

  it('names each shot it has no staging of, and still reports the others', () => {
    const later = 'sht_0123456789cccc';
    const r = shotResultsOf(doc, { shots: [later, SHOT_B, 'nope', SHOT_A] });
    expect(r.results.map((x) => x.shotId)).toEqual([SHOT_A, SHOT_B]);
    expect(r.missing).toEqual([later, 'nope']);
    // shotResults refuses the call naming all of them (the operator's and the MCP tool's answer)
    const err = refusal(() => shotResults(doc, { shots: [SHOT_A, later, 'nope'] }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain(`'${later}', 'nope'`);
    expect(refusal(() => shotResults(SceneDoc.create({ empty: true }))).code).toBe('INVALID_PARAMS');
  });

  it('names a shot whose desk shot was deleted', () => {
    const d = staged();
    const deskB = hostShots(d, openScene().id).get(SHOT_B)!.id;
    setShots(
      d,
      getShots(d).filter((s) => s.id !== deskB),
    );
    const r = shotResultsOf(d, { shots: [SHOT_A, SHOT_B] });
    expect(r.results.map((x) => x.shotId)).toEqual([SHOT_A]);
    expect(r.missing).toEqual([SHOT_B]);
    // without a list: the staged shots, nothing missing
    expect(shotResultsOf(d)).toMatchObject({ results: [{ shotId: SHOT_A }], missing: [] });
  });
});

describe("shotResults: frames at the brief's frame rate, as an export plans them", () => {
  it('reports the staged frames at the rate staged', () => {
    const doc = staged();
    const [a, b] = shotResults(doc);
    expect([a.frames, a.durationSec, a.sceneFrames, a.sceneFps]).toEqual([72, 3, 72, 24]);
    expect([b.frames, b.durationSec, b.sceneFrames, b.sceneFps]).toEqual([60, 2.5, 60, 24]);
  });

  it('counts at the brief frame rate after the scene rate changed in the desk', () => {
    const doc = staged();
    doc.updateScene({ fps: 30 });
    const [a, b] = shotResults(doc);
    // the shots keep their 72 and 60 scene frames, now 2.4 s and 2 s long; at the brief's 24 fps an
    // export resamples them to 58 and 48 frames
    expect([a.sceneFrames, a.sceneFps]).toEqual([72, 30]);
    expect([a.frames, a.durationSec]).toEqual([58, 58 / 24]);
    expect([b.frames, b.durationSec]).toEqual([48, 2]);
    for (const r of [a, b]) expect(r.frames).toBe(plannedFrames(doc, r.deskShotId, 24));
  });

  it('counts at another rate when asked (a later brief of another frame rate)', () => {
    const doc = staged();
    const at30 = shotResults(doc, { fps: 30 });
    expect(at30.map((r) => [r.frames, r.durationSec])).toEqual([
      [90, 3],
      [75, 2.5],
    ]);
    for (const r of at30) expect(r.frames).toBe(plannedFrames(doc, r.deskShotId, 30));
    // rates whose frames round: as the export rounds them, at least one frame
    for (const fps of [12, 25, 29.97, 60, 120])
      for (const r of shotResults(doc, { fps })) {
        expect(r.frames, `${fps} fps`).toBe(plannedFrames(doc, r.deskShotId, fps));
        expect(r.durationSec).toBeCloseTo(r.frames / fps, 12);
      }
    expect(outputFramesAt(1, 24, 1)).toBe(1);
    expect(outputFramesAt(7, 24, 30)).toBe(9);
  });
});
