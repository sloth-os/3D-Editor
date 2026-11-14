import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SceneDoc, newShotId, setDeskSettings, setShots } from '@3d-editor/core';
import { ToolError } from '../../src/mcp/agent';
import { DEFAULT_PASS } from '../../src/rideo/shots';
import {
  EXPORT_PRESET_PARAMS,
  MAX_EXPORT_WAIT_S,
  RIDEO_PASSES,
  exportSize,
  exportVideoArgsShape,
  qualityPreset,
  videoExportParamsSchema,
  type VideoExportParams,
} from '../../src/video/params';
import { MAX_EXPORT_FRAMES, planExport, sceneFrameAt, slugify } from '../../src/video/plan';

/*
 * Video export parameters (one schema for export_video and the REST body), the quality presets,
 * the frame size and the export plan: which shots, cameras and frames an export renders.
 */

const params = (p: Record<string, unknown> = {}): VideoExportParams => videoExportParamsSchema.parse(p);

/** The thrown ToolError's code. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as ToolError).code;
  }
  throw new Error('expected a ToolError');
}

/** A default scene (cube, camera, light) with a second camera and the given shots. */
function sceneWithShots(shots: Record<string, unknown>[] = []): {
  doc: SceneDoc;
  cam: string;
  cam2: string;
  cube: string;
} {
  const doc = SceneDoc.create();
  const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!.id;
  const cube = doc.listObjects().find((o) => o.type === 'MESH')!.id;
  const cam2 = doc.addObject({ type: 'CAMERA', name: 'Close cam', data: doc.addCamera({ lens: 85 }) });
  doc.transact(() => {
    doc.updateScene({ fps: 24, frame_start: 1, frame_end: 96, camera: cam });
    doc.updateRender({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 50 });
  });
  if (shots.length)
    setShots(
      doc,
      shots.map((s) => ({
        id: newShotId(),
        enabled: true,
        ...s,
        camera: s.camera === 'cam2' ? cam2 : s.camera === null ? null : cam,
      })),
    );
  return { doc, cam, cam2, cube };
}

describe('export parameters', () => {
  it('fills in the defaults', () => {
    const p = params();
    expect(p).toMatchObject({
      quality: 'standard',
      look: 'material',
      passes: ['beauty'],
      codec: 'h264',
      match_model_duration: false,
    });
    expect(p.shots).toBeUndefined();
    expect(p.outputs).toBeUndefined();
    expect(params({ outputs: {} }).outputs).toEqual({
      sequence: true,
      clips: true,
      posters: true,
      contact_sheet: true,
    });
  });

  it('refuses odd, tiny and oversized frames, unknown keys and passes', () => {
    expect(videoExportParamsSchema.safeParse({ width: 641 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ height: 8 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ width: 4096 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ height: 2162 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ widht: 640 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ outputs: { gif: true } }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ passes: ['beauty', 'albedo'] }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ passes: [] }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ fps: 0 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ fps: 240 }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ codec: 'prores' }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ shots: [] }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ shots: 'some' }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ width: 3840, height: 2160, fps: 23.976 }).success).toBe(true);
    expect(MAX_EXPORT_WAIT_S).toBeLessThan(60);
  });

  it("applies preset 'rideo' where the parameters leave it out: what rideo_push sends", () => {
    expect(params({ preset: 'rideo' })).toMatchObject({
      preset: 'rideo',
      quality: 'draft',
      look: 'clay',
      outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
      passes: ['beauty', 'depth', 'pose'],
      codec: 'h264',
    });
    // the parameters given win, outputs key by key
    expect(
      params({
        preset: 'rideo',
        quality: 'standard',
        look: 'material',
        passes: ['beauty'],
        outputs: { posters: true },
      }),
    ).toMatchObject({
      quality: 'standard',
      look: 'material',
      passes: ['beauty'],
      outputs: { sequence: false, clips: true, posters: true, contact_sheet: false },
    });
    // parsing again (start() re-parses what MCP and REST parsed) changes nothing
    const once = params({ preset: 'rideo', outputs: { sequence: true } });
    expect(params(once as unknown as Record<string, unknown>)).toEqual(once);
    expect(videoExportParamsSchema.safeParse({ preset: 'previs' }).success).toBe(false);
    expect(videoExportParamsSchema.safeParse({ preset: 'constructor' }).success).toBe(false);
    // without a preset, the defaults as before
    expect(params({}).preset).toBeUndefined();
  });

  it("renders with preset 'rideo' every pass a reference mode of rideo_push sends", () => {
    expect([...RIDEO_PASSES].sort()).toEqual([...new Set(Object.values(DEFAULT_PASS))].sort());
    expect(EXPORT_PRESET_PARAMS.rideo.passes).toBe(RIDEO_PASSES);
  });

  it("leaves to the export what export_video's arguments leave out, for the preset to set", () => {
    // the tool's schema has no defaults for what a preset sets (the MCP SDK would fill them in)
    const args = z.object(exportVideoArgsShape);
    expect(args.parse({ preset: 'rideo' })).not.toHaveProperty('quality');
    expect(args.parse({ preset: 'rideo' })).not.toHaveProperty('look');
    expect(args.parse({ preset: 'rideo' })).not.toHaveProperty('passes');
    expect(params(args.parse({ preset: 'rideo' }))).toMatchObject({ quality: 'draft', look: 'clay' });
    expect(params(args.parse({}))).toMatchObject({
      quality: 'standard',
      look: 'material',
      passes: ['beauty'],
    });
  });

  it('maps qualities to render settings', () => {
    expect(qualityPreset('draft', 1280, 720)).toEqual({ samples: 1, shadows: true, ao: false, msaa: true });
    expect(qualityPreset('standard', 1280, 720)).toEqual({ samples: 2, shadows: true, ao: true, msaa: true });
    expect(qualityPreset('high', 1280, 720).samples).toBe(4);
    expect(qualityPreset('high', 1920, 1080).samples).toBe(2);
  });

  it('sizes the frame from the render settings, even, at most 3840×2160', () => {
    const render = { resolution_x: 1920, resolution_y: 1080, resolution_percentage: 50 };
    expect(exportSize(render)).toEqual({ width: 960, height: 540 });
    expect(exportSize(render, 640)).toEqual({ width: 640, height: 360 });
    expect(exportSize(render, undefined, 90)).toEqual({ width: 160, height: 90 });
    expect(exportSize(render, 200, 200)).toEqual({ width: 200, height: 200 });
    // odd results round to even
    expect(exportSize({ resolution_x: 1001, resolution_y: 563, resolution_percentage: 100 })).toEqual({
      width: 1002,
      height: 564,
    });
    // too large: scaled down keeping the aspect
    expect(exportSize({ resolution_x: 7680, resolution_y: 4320, resolution_percentage: 100 })).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(exportSize({ resolution_x: 8000, resolution_y: 2000, resolution_percentage: 100 })).toEqual({
      width: 3840,
      height: 960,
    });
  });
});

describe('export plan', () => {
  it('exports the enabled shots in cut order with their cameras and output positions', () => {
    const { doc, cam, cam2 } = sceneWithShots([
      { name: 'Opening wide', frame_start: 1, frame_end: 24 },
      { name: 'Skipped', frame_start: 25, frame_end: 30, enabled: false },
      { name: 'Close', frame_start: 31, frame_end: 42, camera: 'cam2' },
    ]);
    const plan = planExport(doc, params());
    expect(plan).toMatchObject({ frames: 36, fps: 24, sceneFps: 24, width: 960, height: 540, warnings: [] });
    expect(
      plan.shots.map((s) => [s.name, s.camera, s.sceneStart, s.sceneEnd, s.outStart, s.outFrames, s.slug]),
    ).toEqual([
      ['Opening wide', cam, 1, 24, 0, 24, 'shot-01-opening-wide'],
      ['Close', cam2, 31, 42, 24, 12, 'shot-02-close'],
    ]);
    expect(plan.shots.every((s) => s.renderFrames === s.outFrames)).toBe(true);
  });

  it('picks shots by id or name, in cut order, each once', () => {
    const { doc } = sceneWithShots([
      { name: 'A', frame_start: 1, frame_end: 10 },
      { name: 'B', frame_start: 11, frame_end: 20 },
      { name: 'C', frame_start: 21, frame_end: 30, enabled: false },
    ]);
    expect(planExport(doc, params({ shots: 'all' })).shots.map((s) => s.name)).toEqual(['A', 'B']);
    const ids = planExport(doc, params()).shots.map((s) => s.id);
    // a disabled shot named explicitly is exported; order follows the cut, duplicates once
    const plan = planExport(doc, params({ shots: ['C', 'B', ids[1], 'A'] }));
    expect(plan.shots.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    expect(plan.shots.map((s) => s.slug)).toEqual(['shot-01-a', 'shot-02-b', 'shot-03-c']);
    expect(codeOf(() => planExport(doc, params({ shots: ['Nope'] })))).toBe('NOT_FOUND');
  });

  it('refuses a cut whose shots are all disabled, and shots without any camera', () => {
    const off = sceneWithShots([{ name: 'A', frame_start: 1, frame_end: 10, enabled: false }]);
    // no enabled shot and no range given: the frame range is exported
    expect(planExport(off.doc, params()).shots[0].id).toBe('range');
    expect(codeOf(() => planExport(off.doc, params({ shots: 'all' })))).toBe('INVALID_PARAMS');
    const noCam = sceneWithShots([{ name: 'A', frame_start: 1, frame_end: 10, camera: null }]);
    noCam.doc.transact(() => noCam.doc.updateScene({ camera: null }));
    expect(codeOf(() => planExport(noCam.doc, params()))).toBe('INVALID_PARAMS');
    // a shot without a camera of its own uses the scene camera
    const sceneCam = sceneWithShots([{ name: 'A', frame_start: 1, frame_end: 10, camera: null }]);
    expect(planExport(sceneCam.doc, params()).shots[0].camera).toBe(sceneCam.cam);
  });

  it("sizes a preset 'rideo' export at the render resolution at 100 % (rideo's, after rideo_import)", () => {
    const { doc } = sceneWithShots([{ name: 'Wide', frame_start: 1, frame_end: 24 }]);
    // the scene renders at 50 %: 960×540 by default, rideo's 1920×1080 with the preset
    expect(planExport(doc, params())).toMatchObject({ width: 960, height: 540 });
    expect(planExport(doc, params({ preset: 'rideo' }))).toMatchObject({ width: 1920, height: 1080 });
    // a size given wins
    expect(planExport(doc, params({ preset: 'rideo', width: 640 }))).toMatchObject({
      width: 640,
      height: 360,
    });
  });

  it('exports a frame range without shots', () => {
    const { doc, cam, cam2 } = sceneWithShots();
    const plan = planExport(doc, params({ frame_start: 10, frame_end: 33 }));
    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0]).toMatchObject({
      id: 'range',
      shot: null,
      camera: cam,
      sceneStart: 10,
      sceneEnd: 33,
      outFrames: 24,
      slug: 'range',
    });
    expect(planExport(doc, params({ camera: 'Close cam' })).shots[0]).toMatchObject({
      camera: cam2,
      sceneStart: 1,
      sceneEnd: 96,
    });
    expect(codeOf(() => planExport(doc, params({ camera: 'Cube' })))).toBe('NOT_FOUND');
    expect(codeOf(() => planExport(doc, params({ frame_start: 20, frame_end: 10 })))).toBe('INVALID_PARAMS');
  });

  it('converts frame rates (fractional scene frames) and ends on the last scene frame', () => {
    const { doc } = sceneWithShots([{ name: 'A', frame_start: 1, frame_end: 24 }]);
    const plan = planExport(doc, params({ fps: 12 }));
    const shot = plan.shots[0];
    expect(shot.outFrames).toBe(12);
    expect(sceneFrameAt(plan, shot, 0)).toBe(1);
    expect(sceneFrameAt(plan, shot, 1)).toBe(3);
    expect(sceneFrameAt(plan, shot, 11)).toBe(23);
    const fast = planExport(doc, params({ fps: 30 }));
    expect(fast.shots[0].outFrames).toBe(30);
    expect(sceneFrameAt(fast, fast.shots[0], 1)).toBeCloseTo(1.8, 9);
    expect(sceneFrameAt(fast, fast.shots[0], 29)).toBeLessThanOrEqual(24);
    // NTSC
    const ntsc = planExport(doc, params({ fps: 24000 / 1001 }));
    expect(ntsc.shots[0].outFrames).toBe(24);
  });

  it("trims and pads shots to the video model's take lengths (match_model_duration)", () => {
    const { doc } = sceneWithShots([
      { name: 'Long', frame_start: 1, frame_end: 240 },
      { name: 'Short', frame_start: 241, frame_end: 252 },
      { name: 'Fine', frame_start: 253, frame_end: 300 },
    ]);
    setDeskSettings(doc, { max_shot_s: 5, min_shot_s: 2 });
    const plan = planExport(doc, params({ match_model_duration: true }));
    expect(plan.shots.map((s) => [s.outFrames, s.renderFrames, s.outStart])).toEqual([
      [120, 120, 0],
      [48, 12, 120],
      [48, 48, 168],
    ]);
    expect(plan.frames).toBe(216);
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toMatch(/^duration_clamped: shot 'Long' \(10\.00 s\) was trimmed to 5\.00 s/);
    expect(plan.warnings[1]).toMatch(/^duration_clamped: shot 'Short' \(0\.50 s\) was padded to 2\.00 s/);
    // padded frames hold the last rendered frame
    const short = plan.shots[1];
    expect(sceneFrameAt(plan, short, 11)).toBe(252);
    expect(sceneFrameAt(plan, short, 47)).toBe(252);
    // without the option nothing changes
    expect(planExport(doc, params()).frames).toBe(300);
  });

  it('keeps file names unique and safe', () => {
    expect(slugify('Ünïcödé — Shot #1!')).toBe('unicode-shot-1');
    expect(slugify('***')).toBe('');
    expect(slugify('a'.repeat(40))).toHaveLength(32);
    const { doc } = sceneWithShots([
      { name: 'Same', frame_start: 1, frame_end: 2 },
      { name: '!!!', frame_start: 3, frame_end: 4 },
    ]);
    expect(planExport(doc, params()).shots.map((s) => s.slug)).toEqual(['shot-01-same', 'shot-02']);
  });

  it('refuses exports longer than the frame limit', () => {
    const { doc } = sceneWithShots();
    doc.transact(() => doc.updateScene({ frame_start: 0, frame_end: MAX_EXPORT_FRAMES }));
    expect(codeOf(() => planExport(doc, params()))).toBe('INVALID_PARAMS');
  });
});
