import { describe, expect, it } from 'vitest';
import {
  MAX_ANIMATION_FRAMES,
  SceneDoc,
  contactSheet,
  contactSheetGrid,
  contactSheetLayout,
  createFCurve,
  decodePNG,
  insertKeyframe,
  renderAnimation,
  renderSceneSoftware,
  sampleFrameIndices,
  sequenceFrameName,
} from '../src';
import { decodeAPNG, decodeGIF, solidFrame } from './render-animation-helpers';

/** Default scene (cube, light, camera) with the cube sliding along X over frames 1..5, 12 fps. */
function slidingCube(): SceneDoc {
  const doc = SceneDoc.create();
  const cube = doc.findObjectByName('Cube')!.id;
  let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
  fc = insertKeyframe(fc, 1, -1.5, 'LINEAR');
  fc = insertKeyframe(fc, 5, 1.5, 'LINEAR');
  doc.setFCurve(fc);
  doc.updateScene({ frame_start: 1, frame_end: 5, fps: 12 });
  doc.updateRender({ resolution_x: 64, resolution_y: 36, resolution_percentage: 50 });
  return doc;
}

/** Horizontal centre of the pixels that differ from the top-left (background) pixel. */
function centreX(data: ArrayLike<number>, width: number, height: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (
        Math.abs(data[o] - data[0]) + Math.abs(data[o + 1] - data[1]) + Math.abs(data[o + 2] - data[2]) >
        12
      ) {
        sum += x;
        n++;
      }
    }
  return n ? sum / n : NaN;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) throw new Error(`differs at byte ${i}: ${a[i]} vs ${b[i]}`);
};

describe('renderAnimation', () => {
  it('renders the scene frame range into a lossless APNG', () => {
    const doc = slidingCube();
    const res = renderAnimation(doc);
    expect(res).toMatchObject({ format: 'APNG', mime: 'image/apng', width: 32, height: 18, fps: 12 });
    expect(res.frames).toEqual([1, 2, 3, 4, 5]);
    expect(res.cancelled).toBe(false);
    const apng = decodeAPNG(res.data!);
    expect(apng.numFrames).toBe(5);
    expect(apng.numPlays).toBe(0);
    expect(apng.frames.every((f) => f.delayNum === 1 && f.delayDen === 12)).toBe(true);
    // every frame is exactly what the software renderer gives for that frame
    res.frames.forEach((frame, k) =>
      same(apng.canvases[k], renderSceneSoftware(doc, { width: 32, height: 18, frame }).data),
    );
    // the cube moves to the right
    const xs = apng.canvases.map((c) => centreX(c, 32, 18));
    for (let k = 1; k < xs.length; k++) expect(xs[k]).toBeGreaterThan(xs[k - 1] + 1);
  });

  it('honours frame ranges, steps, sizes and play counts', () => {
    const doc = slidingCube();
    const res = renderAnimation(doc, {
      frame_start: 2,
      frame_end: 9,
      frame_step: 3,
      width: 20,
      height: 10,
      loop: 2,
    });
    expect(res.frames).toEqual([2, 5, 8]);
    expect(res.fps).toBe(4); // real time: 12 fps / step 3
    const apng = decodeAPNG(res.data!);
    expect([apng.width, apng.height, apng.numFrames, apng.numPlays]).toEqual([20, 10, 3, 2]);
    expect(renderAnimation(doc, { frame_start: 3, frame_end: 3, fps: 30 })).toMatchObject({
      frames: [3],
      fps: 30,
    });
  });

  it('encodes GIFs with the frame count, timing and approximate colours', () => {
    const doc = slidingCube();
    const res = renderAnimation(doc, { format: 'GIF', dither: 'NONE' });
    expect(res).toMatchObject({ format: 'GIF', mime: 'image/gif', fps: 12, frames: [1, 2, 3, 4, 5] });
    const gif = decodeGIF(res.data!);
    expect(gif.frames).toHaveLength(5);
    expect(gif.loopCount).toBe(0);
    // 1/12 s in 1/100 s steps without drift: end times round(k * 100 / 12) = 8, 17, 25, 33, 42
    expect(gif.frames.map((f) => f.delay)).toEqual([8, 9, 8, 8, 9]);
    res.frames.forEach((frame, k) => {
      const ref = renderSceneSoftware(doc, { width: 32, height: 18, frame }).data;
      let err = 0;
      for (let i = 0; i < ref.length; i++) if (i % 4 !== 3) err += Math.abs(gif.canvases[k][i] - ref[i]);
      expect(err / (32 * 18 * 3)).toBeLessThan(3); // palette quantisation only
    });
    const once = decodeGIF(renderAnimation(doc, { format: 'GIF', frame_end: 2, loop: 1, colors: 16 }).data!);
    expect(once.loopCount).toBeNull();
    // at most 16 colours, plus the transparent index of the optimized second frame
    const used = new Set<number>();
    for (const f of once.frames) for (const v of f.indices) if (v !== f.transparentIndex) used.add(v);
    expect(used.size).toBeLessThanOrEqual(16);
    expect(once.palette.length).toBeLessThanOrEqual(32 * 3);
  });

  it('writes PNG sequences named like Blender frame numbers', () => {
    const doc = slidingCube();
    const res = renderAnimation(doc, { format: 'PNG_SEQUENCE', frame_start: 1, frame_end: 3 });
    expect(res.mime).toBe('image/png');
    expect(res.data).toBeUndefined();
    expect(res.files!.map((f) => [f.frame, f.name])).toEqual([
      [1, 'frame_0001.png'],
      [2, 'frame_0002.png'],
      [3, 'frame_0003.png'],
    ]);
    for (const f of res.files!)
      same(decodePNG(f.data).data, renderSceneSoftware(doc, { width: 32, height: 18, frame: f.frame }).data);
    expect(sequenceFrameName(0)).toBe('frame_0000.png');
    expect(sequenceFrameName(12345)).toBe('frame_12345.png');
    expect(sequenceFrameName(-1)).toBe('frame_-0001.png');
    expect(sequenceFrameName(7.4)).toBe('frame_0007.png');
  });

  it('reports progress and stops early when asked', () => {
    const doc = slidingCube();
    const seen: number[] = [];
    const res = renderAnimation(doc, {
      onFrame: ({ frame, index, total }) => {
        seen.push(frame);
        expect(total).toBe(5);
        return index < 1;
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(res.cancelled).toBe(true);
    expect(res.frames).toEqual([1, 2]);
    expect(decodeAPNG(res.data!).numFrames).toBe(2);
    // stopping after the last frame is not a cancellation
    expect(renderAnimation(doc, { frame_start: 5, onFrame: () => false }).cancelled).toBe(false);
  });

  it('validates ranges, sizes and formats', () => {
    const doc = slidingCube();
    expect(() => renderAnimation(doc, { frame_start: 5, frame_end: 1 })).toThrow(/before frame_start/);
    expect(() => renderAnimation(doc, { frame_step: 0 })).toThrow(/frame_step/);
    expect(() => renderAnimation(doc, { frame_step: 1.5 })).toThrow(/frame_step/);
    expect(() => renderAnimation(doc, { frame_start: Number.NaN })).toThrow(/numbers/);
    expect(() => renderAnimation(doc, { frame_end: MAX_ANIMATION_FRAMES + 1 })).toThrow(/Too many frames/);
    expect(() => renderAnimation(doc, { width: 0 })).toThrow(/Invalid animation size/);
    expect(() => renderAnimation(doc, { fps: -1 })).toThrow(/fps/);
    expect(() => renderAnimation(doc, { format: 'MP4' as never })).toThrow(/Unknown animation format/);
    expect(() => renderAnimation(doc, { format: 'GIF', width: 4096, height: 4096, frame_end: 10 })).toThrow(
      /too large/,
    );
  });

  it('uses one automatic view for every frame without a camera, so motion shows', () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!.id;
    let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, -3, 'LINEAR');
    fc = insertKeyframe(fc, 5, 3, 'LINEAR');
    doc.setFCurve(fc);
    doc.updateScene({ frame_start: 1, frame_end: 5, fps: 12, camera: null });
    const res = renderAnimation(doc, { width: 64, height: 36 });
    const apng = decodeAPNG(res.data!);
    // the cube moves 6 m to the right, and so it does in the image
    const xs = apng.canvases.map((c) => centreX(c, 64, 36));
    for (let k = 1; k < xs.length; k++) expect(xs[k]).toBeGreaterThan(xs[k - 1] + 2);
    expect(xs[4] - xs[0]).toBeGreaterThan(15);
    // every frame is the render from that one view, which frames both ends of the motion
    expect(res.view).toBeDefined();
    const view = { position: res.view!.position, target: res.view!.target, fovY: res.view!.fovY };
    expect(view.target[0]).toBeCloseTo(0, 6); // centre of the swept range x ∈ [-4, 4]
    res.frames.forEach((frame, k) =>
      same(apng.canvases[k], renderSceneSoftware(doc, { width: 64, height: 36, frame, view }).data),
    );
    // the cube is fully inside the image at both ends: the image border shows only background
    for (const k of [0, 4]) {
      const c = apng.canvases[k];
      for (let x = 0; x < 64; x++)
        for (const y of [0, 35]) expect(Math.abs(c[(y * 64 + x) * 4] - c[0])).toBeLessThan(13);
    }
    // a scene camera or an explicit camera is used as it is
    doc.updateScene({ camera: doc.findObjectByName('Camera')!.id });
    expect(renderAnimation(doc, { width: 16, height: 9, frame_end: 2 }).view).toBeUndefined();
    doc.updateScene({ camera: null });
    expect(renderAnimation(doc, { width: 16, height: 9, frame_end: 2, camera: 'Camera' }).view).toBeUndefined();
    // nothing to frame: the default view
    const empty = SceneDoc.create({ empty: true });
    expect(renderAnimation(empty, { width: 16, height: 9, frame_end: 2 }).view?.target).toEqual([0, 0, 0]);
  });

  it('samples long frame ranges for the automatic view without aliasing periodic motion', () => {
    expect(sampleFrameIndices(5, 64)).toEqual([0, 1, 2, 3, 4]);
    expect(sampleFrameIndices(0, 64)).toEqual([]);
    const s = sampleFrameIndices(630, 64);
    expect(s.length).toBeLessThanOrEqual(64);
    expect(s.length).toBeGreaterThan(50);
    expect([s[0], s[s.length - 1]]).toEqual([0, 629]);
    for (let k = 1; k < s.length; k++) expect(s[k]).toBeGreaterThan(s[k - 1]);
    // a motion repeating every 10 frames is seen at many phases (even strides would hit only one)
    expect(new Set(s.slice(1, -1).map((i) => i % 10)).size).toBeGreaterThanOrEqual(8);
    expect(sampleFrameIndices(630, 64)).toEqual(s);
  });

  it('rejects contact sheets that would be too large before rendering anything', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ frame_start: 1, frame_end: 13 });
    let rendered = 0;
    expect(() =>
      renderAnimation(doc, {
        format: 'CONTACT_SHEET',
        width: 2048,
        height: 2048,
        samples: 1,
        onFrame: () => {
          rendered++;
        },
      }),
    ).toThrow(/would be 8202×8202 pixels, too large/);
    expect(rendered).toBe(0);
    expect(contactSheetLayout(13, 2048, 2048)).toEqual({
      columns: 4,
      rows: 4,
      gap: 2,
      width: 8202,
      height: 8202,
    });
  });

  it('keeps a whole-render time budget, also inside path traced frames', () => {
    const doc = slidingCube();
    const traced = { engine: 'PATHTRACER', width: 96, height: 54, samples: 4096, denoise: false } as const;
    // a single frame: only the time limit passed into the frame can stop it (4096 samples per
    // pixel would take far longer)
    let t0 = performance.now();
    const one = renderAnimation(doc, { ...traced, frame_end: 1, total_time_limit: 0.3 });
    expect((performance.now() - t0) / 1000).toBeLessThan(2.5);
    expect(one).toMatchObject({
      frames: [1],
      cancelled: false,
      time_limit_reached: true,
      undersampled_frames: [1],
    });
    // several frames: the budget is shared and no frame starts after it is used up
    t0 = performance.now();
    const res = renderAnimation(doc, { ...traced, frame_end: 3, total_time_limit: 0.5 });
    expect((performance.now() - t0) / 1000).toBeLessThan(3);
    expect(res.time_limit_reached).toBe(true);
    expect(res.frames.length).toBeGreaterThanOrEqual(1);
    expect(res.cancelled).toBe(res.frames.length < 3);
    expect(res.undersampled_frames.length).toBeGreaterThanOrEqual(1);
    expect(decodeAPNG(res.data!).numFrames).toBe(res.frames.length);
    // raster frames: no frame is started once the budget is used up, but one is always rendered
    const quick = renderAnimation(doc, { width: 16, height: 9, total_time_limit: 1e-9 });
    expect(quick).toMatchObject({ frames: [1], cancelled: true, time_limit_reached: true });
    expect(quick.undersampled_frames).toEqual([]);
    const free = renderAnimation(doc, { width: 16, height: 9, total_time_limit: 0 });
    expect(free).toMatchObject({ frames: [1, 2, 3, 4, 5], cancelled: false, time_limit_reached: false });
    // enough time: every sample is rendered
    const full = renderAnimation(doc, { ...traced, samples: 2, frame_end: 2, total_time_limit: 600 });
    expect(full).toMatchObject({ frames: [1, 2], time_limit_reached: false, undersampled_frames: [] });
  });

  it('passes the engine and its settings to every frame', () => {
    const doc = slidingCube();
    doc.updateScene({ frame_end: 2 });
    const opts = { width: 16, height: 9, samples: 2, denoise: false, max_bounces: 2 } as const;
    const raster = renderAnimation(doc, { ...opts, engine: 'RASTER', format: 'PNG_SEQUENCE' });
    const traced = renderAnimation(doc, { ...opts, engine: 'PATHTRACER', format: 'PNG_SEQUENCE' });
    expect(traced.files).toHaveLength(2);
    const a = decodePNG(raster.files![0].data).data;
    const b = decodePNG(traced.files![0].data).data;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(0);
    // the same frame, settings and seed reproduce the image; an animated seed changes the noise
    const again = renderAnimation(doc, {
      ...opts,
      engine: 'PATHTRACER',
      format: 'PNG_SEQUENCE',
      frame_end: 1,
    });
    same(decodePNG(again.files![0].data).data, b);
    const seeded = renderAnimation(doc, {
      ...opts,
      engine: 'PATHTRACER',
      format: 'PNG_SEQUENCE',
      frame_end: 1,
      animated_seed: true,
    });
    expect(Buffer.from(decodePNG(seeded.files![0].data).data).equals(Buffer.from(b))).toBe(false);
    // the scene's engine: `samples` still means samples per pixel (the render settings' 4096 would
    // be used otherwise)
    doc.updateRender({ engine: 'PATHTRACER', samples: 4096 });
    const scene = renderAnimation(doc, { ...opts, format: 'PNG_SEQUENCE', frame_end: 1 });
    same(decodePNG(scene.files![0].data).data, b);
  });
});

describe('contact sheets', () => {
  type RGBA = [number, number, number, number];
  const tile = (k: number) => solidFrame(30, 20, [k * 40, 100, 50, 255]);
  const pixel = (img: { width: number; data: ArrayLike<number> }, x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
  };

  it('tiles frames row by row with gaps and a background', () => {
    const frames = [0, 1, 2, 3, 4].map(tile);
    const bg: RGBA = [255, 255, 255, 255];
    const sheet = contactSheet(frames, { columns: 3, gap: 2, background: bg });
    expect([sheet.width, sheet.height]).toEqual([3 * 30 + 4 * 2, 2 * 20 + 3 * 2]);
    expect(pixel(sheet, 0, 0)).toEqual(bg);
    frames.forEach((_, k) =>
      expect(pixel(sheet, 2 + (k % 3) * 32 + 15, 2 + Math.floor(k / 3) * 22 + 10)).toEqual([
        k * 40,
        100,
        50,
        255,
      ]),
    );
    expect(pixel(sheet, 2 + 2 * 32 + 15, 2 + 22 + 10)).toEqual(bg); // the empty sixth cell
    const tight = contactSheet(frames, { columns: 5, gap: 0 });
    expect([tight.width, tight.height]).toEqual([150, 20]);
  });

  it('chooses a roughly square grid', () => {
    expect(contactSheetGrid(24, 160, 90)).toEqual({ columns: 4, rows: 6 });
    expect(contactSheetGrid(1, 160, 90)).toEqual({ columns: 1, rows: 1 });
    expect(contactSheetGrid(9, 10, 10)).toEqual({ columns: 3, rows: 3 });
    expect(contactSheetGrid(5, 10, 10, 99)).toEqual({ columns: 5, rows: 1 });
    expect(contactSheetGrid(5, 10, 10, 0)).toEqual({ columns: 3, rows: 2 }); // invalid: automatic
  });

  it('labels tiles in white on a darkened box, clipped to the tile', () => {
    const sheet = contactSheet([tile(0), tile(1)], { labels: [7, 'x-1.5'], gap: 0, columns: 2 });
    const white = [255, 255, 255, 255];
    const dark = [0, 30, 15, 255]; // tile 0 colour × 0.3
    // "7": the top row of the glyph is lit, the second row only on the right
    expect(pixel(sheet, 1, 1)).toEqual(white);
    expect(pixel(sheet, 3, 1)).toEqual(white);
    expect(pixel(sheet, 1, 2)).toEqual(dark);
    expect(pixel(sheet, 3, 2)).toEqual(white);
    expect(pixel(sheet, 0, 0)).toEqual(dark);
    expect(pixel(sheet, 5, 0)).toEqual([0, 100, 50, 255]); // outside the 5×7 box
    // tile 1 at x = 30: 'x' has no glyph, '-' lights the middle row
    expect(pixel(sheet, 31, 3)).toEqual(white);
    expect(pixel(sheet, 31, 1)).toEqual([12, 30, 15, 255]);
    // long labels never draw outside their tile
    const narrow = contactSheet([solidFrame(6, 4, [0, 0, 0, 255])], { labels: ['123456789'], gap: 1 });
    expect(pixel(narrow, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(narrow, 7, 5)).toEqual([255, 255, 255, 255]);
  });

  it('validates its input', () => {
    expect(() => contactSheet([])).toThrow(/no frames/);
    expect(() => contactSheet([tile(0), solidFrame(3, 3, [0, 0, 0, 255])])).toThrow(
      /every frame must be 30×20/,
    );
    expect(() => contactSheet([{ width: 2, height: 2, data: new Uint8Array(4) }])).toThrow(/too short/);
  });

  it('renders animations as a labelled contact sheet', () => {
    const doc = slidingCube();
    const res = renderAnimation(doc, { format: 'CONTACT_SHEET' });
    expect(res).toMatchObject({ format: 'CONTACT_SHEET', mime: 'image/png', frames: [1, 2, 3, 4, 5] });
    expect([res.width, res.height]).toEqual([32, 18]);
    // 5 frames of 32×18: ceil(sqrt(5 · 18 / 32)) = 2 columns, 3 rows, 2 px gaps
    expect(res.sheet).toEqual({ width: 70, height: 62, columns: 2, rows: 3 });
    const png = decodePNG(res.data!);
    expect([png.width, png.height]).toEqual([70, 62]);
    // below the 7 px label box every tile is exactly the frame's render
    res.frames.forEach((frame, k) => {
      const ref = renderSceneSoftware(doc, { width: 32, height: 18, frame }).data;
      const x0 = 2 + (k % 2) * 34;
      const y0 = 2 + Math.floor(k / 2) * 20;
      let mismatches = 0;
      for (let y = 7; y < 18; y++)
        for (let i = 0; i < 32 * 4; i++)
          if (png.data[((y0 + y) * 70 + x0) * 4 + i] !== ref[y * 32 * 4 + i]) mismatches++;
      expect(mismatches, `frame ${frame}`).toBe(0);
      // label: the bottom-right pixel of every glyph 1..5 is lit
      expect(pixel(png, x0 + 3, y0 + 5)).toEqual([255, 255, 255, 255]);
    });
    expect(renderAnimation(doc, { format: 'CONTACT_SHEET', columns: 5 }).sheet).toMatchObject({
      columns: 5,
      rows: 1,
    });
  });
});
