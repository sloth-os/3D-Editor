import { describe, expect, it } from 'vitest';
import { SceneDoc, createActor, createCube, newShotId, setShots } from '../src';
import {
  NO_POSE_ACTORS_WARNING,
  contactSheetColumns,
  isTileFrame,
  middleFrame,
  poseActorsOf,
  round6,
  shotDeskOptions,
  shotRenderFrames,
  stringLines,
  tileLabel,
} from '../src/export/job';
import { qualityPreset, videoExportParamsSchema } from '../src/export/params';
import { planExport, type PlannedShot } from '../src/export/plan';
import { stringLineWidth } from '../src/export/screen';
import { fpsRational, fpsValue } from '../src/export/timing';

/*
 * How an export renders its frames, the same on the server and in the browser: strings, pose
 * actors, the desk options of a shot, which frames give posters and contact sheet tiles, their
 * labels and the sheet's columns, and the exact frame rate of the videos.
 */

const shot = (outFrames: number, index = 0): PlannedShot => ({
  id: `s${index}`,
  name: `S${index}`,
  index,
  shot: null,
  camera: 'cam',
  sceneStart: 1,
  sceneEnd: outFrames,
  outStart: 0,
  outFrames,
  renderFrames: outFrames,
  slug: `shot-0${index + 1}`,
});

describe('strings and actors', () => {
  it('draws every string (desk_role string) in its first material colour, in display sRGB', () => {
    const doc = SceneDoc.create();
    const mat = doc.addMaterial({ name: 'Red', base_color: [1, 0, 0, 1] });
    const id = doc.addObject({
      type: 'MESH',
      name: 'String',
      data: doc.addMesh('String', createCube()),
      material_slots: [mat],
      custom_props: { desk_role: 'string' },
    });
    const plain = doc.addObject({
      type: 'MESH',
      name: 'Grey string',
      data: doc.addMesh('Grey', createCube()),
      custom_props: { desk_role: 'string' },
    });
    const lines = stringLines(doc, 1080);
    expect(lines.map((l) => l.object).sort()).toEqual([id, plain].sort());
    const red = lines.find((l) => l.object === id)!;
    expect(red.width_px).toBe(stringLineWidth(1080));
    expect(red.width_px).toBe(3);
    expect(red.color[0]).toBeCloseTo(1, 12);
    expect(red.color.slice(1)).toEqual([0, 0]);
    // the default colour 0.85 (linear) is about 0.93 on screen
    expect(lines.find((l) => l.object === plain)!.color[0]).toBeCloseTo(0.9309, 3);
    expect(stringLines(SceneDoc.create(), 720)).toEqual([]);
  });

  it('draws the skeletons of every actor of the snapshot, and warns of a pose pass without any', () => {
    const doc = SceneDoc.create();
    expect(poseActorsOf(doc)).toEqual([]);
    expect(NO_POSE_ACTORS_WARNING).toMatch(/^pose pass: the scene has no actors/);
    let actor = '';
    doc.transact(() => {
      actor = createActor(doc, { kind: 'adult', location: [0, 0, 0], facing_deg: 0 }).actor;
    });
    expect(poseActorsOf(doc)).toEqual([actor]);
  });
});

describe('frames of a shot', () => {
  it('takes contact sheet tiles from the first and the middle frame (one for a one-frame shot)', () => {
    expect(middleFrame(shot(48))).toBe(24);
    expect([0, 1, 23, 24, 25, 47].filter((k) => isTileFrame(shot(48), k))).toEqual([0, 24]);
    expect([0, 1].filter((k) => isTileFrame(shot(2), k))).toEqual([0, 1]);
    expect(isTileFrame(shot(1), 0)).toBe(true);
    expect(middleFrame(shot(1))).toBe(0);
  });

  it("labels tiles with the shot's number and the scene frame shown", () => {
    const doc = SceneDoc.create();
    const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!.id;
    doc.transact(() => doc.updateScene({ fps: 24, camera: cam }));
    setShots(doc, [
      { id: newShotId(), name: 'A', enabled: true, camera: cam, frame_start: 1, frame_end: 10 },
      { id: newShotId(), name: 'B', enabled: true, camera: cam, frame_start: 31, frame_end: 54 },
    ]);
    const plan = planExport(doc, videoExportParamsSchema.parse({ fps: 12 }));
    const b = plan.shots[1];
    expect(b.outFrames).toBe(12);
    expect(tileLabel(plan, b, 0)).toBe('2-31');
    expect(tileLabel(plan, b, middleFrame(b))).toBe('2-43');
    expect(shotRenderFrames(plan, b)).toEqual([31, 33, 35, 37, 39, 41, 43, 45, 47, 49, 51, 53]);
  });

  it('lays the sheet out in pairs of tiles', () => {
    expect(contactSheetColumns(2)).toBe(2);
    expect(contactSheetColumns(1)).toBe(1);
    expect(contactSheetColumns(8)).toBe(4);
    expect(contactSheetColumns(18)).toBe(6);
    expect(contactSheetColumns(3)).toBe(2);
  });

  it('gives every frame of a shot the shot measurement, the palette and the quality', () => {
    const preset = qualityPreset('standard', 1280, 720);
    const s = { ...shot(4), shot: { subjects: ['a'] } as unknown as PlannedShot['shot'] };
    const desk = shotDeskOptions({
      look: 'clay',
      preset,
      passes: ['beauty', 'depth'],
      info: {
        depthRange: [1, 9],
        shadowFit: { min: [0, 0, 0], max: [1, 1, 1] },
        aoRadius: 0.5,
        ms: 3,
      },
      objectPalette: { a: [1, 2, 3] },
      shot: s,
      poseActors: ['actor'],
      lines: [],
    });
    expect(desk).toEqual({
      look: 'clay',
      shadows: true,
      ao: true,
      msaa: true,
      shadowFit: { min: [0, 0, 0], max: [1, 1, 1] },
      aoRadius: 0.5,
      passes: ['beauty', 'depth'],
      depthRange: [1, 9],
      objectPalette: { a: [1, 2, 3] },
      subjects: ['a'],
      poseActors: ['actor'],
      lines: [],
    });
    // without a shadow box the renderer fits its own
    const plain = shotDeskOptions({
      look: 'material',
      preset,
      passes: ['beauty'],
      info: { depthRange: [1, 9], shadowFit: null, ms: 1 },
      objectPalette: {},
      shot: shot(2),
      poseActors: [],
      lines: [],
    });
    expect(plain.shadowFit).toBeUndefined();
    expect(plain.subjects).toEqual([]);
  });

  it('rounds durations to microseconds', () => {
    expect(round6(13 / 24)).toBe(0.541667);
    expect(round6(2)).toBe(2);
  });
});

describe('frame rates', () => {
  it('are exact rationals: NTSC rates as N × 1000 / 1001', () => {
    expect(fpsRational(24)).toEqual({ num: 24, den: 1, text: '24/1' });
    expect(fpsRational(23.976)).toEqual({ num: 24000, den: 1001, text: '24000/1001' });
    expect(fpsRational(29.97)).toEqual({ num: 30000, den: 1001, text: '30000/1001' });
    expect(fpsRational(12.5)).toEqual({ num: 12500, den: 1000, text: '12500/1000' });
    expect(fpsValue(fpsRational(59.94))).toBeCloseTo(60000 / 1001, 12);
    expect(() => fpsRational(0)).toThrow(/invalid frame rate/);
  });
});
