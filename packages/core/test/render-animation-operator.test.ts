import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  base64Decode,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  decodePNG,
  insertKeyframe,
  type OperatorContext,
} from '../src';
import { decodeAPNG, decodeGIF } from './render-animation-helpers';

/** Default scene with the cube sliding along X over frames 1..6 and a 64×36 render resolution. */
function setup() {
  const doc = SceneDoc.create();
  const cube = doc.findObjectByName('Cube')!.id;
  let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
  fc = insertKeyframe(fc, 1, -1.5, 'LINEAR');
  fc = insertKeyframe(fc, 6, 1.5, 'LINEAR');
  doc.setFCurve(fc);
  doc.updateScene({ frame_start: 1, frame_end: 6, fps: 24 });
  doc.updateRender({ resolution_x: 64, resolution_y: 36, resolution_percentage: 100 });
  const reg = createOperatorRegistry();
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_l, m) => reports.push(m),
  };
  const run = (params?: unknown) => reg.run<any>(ctx, 'render.render_animation', params);
  const ok = (params?: unknown) => {
    const r = run(params);
    if (!r.ok) throw new Error(`render.render_animation failed: ${r.error}`);
    return r.result;
  };
  return { doc, reg, run, ok, reports };
}

describe('render.render_animation', () => {
  it('returns a labelled contact sheet of the scene range by default', () => {
    const { ok } = setup();
    const res = ok();
    expect(res).toMatchObject({
      format: 'CONTACT_SHEET',
      mime: 'image/png',
      width: 64,
      height: 36,
      fps: 24,
      frames: [1, 2, 3, 4, 5, 6],
      frame_count: 6,
      truncated: false,
    });
    // 6 tiles of 64×36: ceil(sqrt(6 · 36 / 64)) = 2 columns, 3 rows, 2 px gaps
    expect(res.sheet).toEqual({ width: 134, height: 116, columns: 2, rows: 3 });
    const png = decodePNG(base64Decode(res.data_base64));
    expect([png.width, png.height]).toEqual([134, 116]);
    expect(res.bytes).toBe(base64Decode(res.data_base64).length);
  });

  it('encodes GIF, APNG and PNG sequences at the requested size and rate', () => {
    const { ok } = setup();
    const gif = ok({ format: 'GIF', width: 48, frame_step: 2 });
    expect(gif).toMatchObject({ mime: 'image/gif', width: 48, height: 27, fps: 12, frames: [1, 3, 5] });
    const g = decodeGIF(base64Decode(gif.data_base64));
    expect([g.width, g.height, g.frames.length]).toEqual([48, 27, 3]);
    const apng = ok({ format: 'APNG', height: 18, frame_start: 2, frame_end: 4, fps: 10, loop: 2 });
    expect(apng).toMatchObject({ mime: 'image/apng', width: 32, height: 18, fps: 10, frames: [2, 3, 4] });
    const a = decodeAPNG(base64Decode(apng.data_base64));
    expect([a.numFrames, a.numPlays, a.frames[0].delayNum, a.frames[0].delayDen]).toEqual([3, 2, 1, 10]);
    const seq = ok({ format: 'PNG_SEQUENCE', frame_start: 5 });
    expect(seq.data_base64).toBeUndefined();
    expect(seq.files.map((f: { name: string }) => f.name)).toEqual(['frame_0005.png', 'frame_0006.png']);
    expect(decodePNG(base64Decode(seq.files[0].data_base64)).width).toBe(64);
  });

  it('scales the default size to the render aspect', () => {
    const { doc, ok } = setup();
    doc.updateRender({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 50 });
    expect(ok({ format: 'GIF', frame_end: 1 })).toMatchObject({ width: 480, height: 270 });
    // contact sheet tiles are smaller
    expect(ok({ frame_end: 2 })).toMatchObject({ width: 240, height: 135 });
  });

  it('stops at the time limit and returns the frames rendered so far', () => {
    const { ok, reports } = setup();
    const res = ok({ format: 'APNG', time_limit: 1e-9 });
    expect(res.truncated).toBe(true);
    expect(res.frames).toEqual([1]);
    expect(decodeAPNG(base64Decode(res.data_base64)).numFrames).toBe(1);
    expect(reports.some((r) => /Stopped after 1 of 6 frames/.test(r))).toBe(true);
  });

  it('bounds a single path traced frame by time_limit and reports the missing samples', () => {
    const { ok, reports } = setup();
    const t0 = performance.now();
    const res = ok({
      format: 'APNG',
      engine: 'PATHTRACER',
      frame_end: 1,
      width: 96,
      height: 54,
      samples: 4096,
      time_limit: 0.3,
    });
    expect((performance.now() - t0) / 1000).toBeLessThan(2.5);
    expect(res).toMatchObject({ frames: [1], truncated: false, undersampled_frames: [1] });
    expect(reports.some((r) => /time_limit \(0\.3 s\) ran out: frame 1 stopped path tracing/.test(r))).toBe(
      true,
    );
    // with enough time nothing is reported
    const fine = ok({ format: 'APNG', engine: 'PATHTRACER', frame_end: 1, width: 16, height: 9, samples: 2 });
    expect(fine.undersampled_frames).toBeUndefined();
  });

  it('keeps the render aspect when the derived side would exceed 2048 pixels', () => {
    const { doc, ok } = setup();
    doc.updateRender({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 100 });
    const wide = ok({ format: 'APNG', frame_end: 1, height: 2048, samples: 1 });
    expect([wide.width, wide.height]).toEqual([2048, 1152]);
    doc.updateRender({ resolution_x: 1080, resolution_y: 1920 });
    const tall = ok({ format: 'APNG', frame_end: 1, width: 2048, samples: 1 });
    expect([tall.width, tall.height]).toEqual([1152, 2048]);
    // within the limit the given side is kept exactly
    expect(ok({ format: 'APNG', frame_end: 1, width: 90, samples: 1 })).toMatchObject({ width: 90, height: 160 });
  });

  it('renders camera-less scenes from one fixed view and returns it', () => {
    const { doc, ok } = setup();
    doc.updateScene({ camera: null });
    const res = ok({ format: 'APNG' });
    expect(res.view.fov_degrees).toBeGreaterThan(10);
    expect(res.view.fov_degrees).toBeLessThan(90);
    expect(res.view.position).toHaveLength(3);
    // the cube slides from x = -1.5 to 1.5: its image moves to the right
    const a = decodeAPNG(base64Decode(res.data_base64));
    const centre = (c: Uint8Array) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 64 * 36; i++)
        if (Math.abs(c[i * 4] - c[0]) + Math.abs(c[i * 4 + 1] - c[1]) + Math.abs(c[i * 4 + 2] - c[2]) > 12) {
          sum += i % 64;
          n++;
        }
      return sum / n;
    };
    expect(centre(a.canvases[5]) - centre(a.canvases[0])).toBeGreaterThan(5);
    // with the scene camera no view is returned
    expect(setup().ok({ frame_end: 1 }).view).toBeUndefined();
  });

  it('validates the range and the camera', () => {
    const { doc, run } = setup();
    expect(run({ frame_start: 5, frame_end: 2 }).error).toMatch(/before frame_start/);
    expect(run({ frame_end: 5000 }).error).toMatch(/Too many frames .* at most 1000/);
    expect(run({ camera: 'Nope' }).error).toMatch(/Camera 'Nope' not found/);
    expect(run({ camera: 'Cube' }).error).toMatch(/not a camera/);
    expect(run({ format: 'MP4' }).ok).toBe(false);
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Side',
      data: doc.addCamera({ name: 'Side' }),
      location: [0, -12, 0],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    expect(run({ camera: 'Side', frame_end: 1 }).ok).toBe(true);
    expect(run({ camera: cam, frame_end: 1 }).ok).toBe(true);
  });

  it('changes nothing and creates no undo step', () => {
    const { doc, ok } = setup();
    const um = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const before = JSON.stringify(doc.toSnapshot());
    ok({ frame_end: 2 });
    expect(JSON.stringify(doc.toSnapshot())).toBe(before);
    expect(um.undoStack.length).toBe(0);
  });

  it('describes every parameter for agents', () => {
    const { reg } = setup();
    const op = reg.describe().find((o) => o.id === 'render.render_animation')!;
    expect(op.description).toMatch(/CONTACT_SHEET/);
    expect(op.description).toMatch(/data_base64/);
    const props = (op.parameters as { properties: Record<string, { description?: string }> }).properties;
    for (const [name, schema] of Object.entries(props)) expect(schema.description, name).toBeTruthy();
  });
});
