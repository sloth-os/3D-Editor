import { describe, expect, it } from 'vitest';
import { SceneDoc, createCube, createPlane, createUVSphere, decodePNG, renderSceneSoftware } from '../src';
import { PathFilm, denoiseFilm } from '../src/render/pathtrace';
import { renderAnimation } from '../src/render/animation';
import { tracerFor } from './pathtrace-helpers';

/*
 * Regression tests for phase-3 issues #12 and #18: the path tracer's denoiser did nothing at one
 * sample per pixel (the per-pixel variance estimate lum²/N − mean² is exactly 0 for N = 1), so
 * time-limited frames that stopped after the first pass came out as raw salt-and-pepper noise.
 */

/** A floor, a ball and a metal box lit by an area light: soft shadows give 1-spp speckle. */
function shadowScene(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0.05, 0.05, 0.06], strength: 1 });
  const table = doc.addMaterial({ name: 'Table', base_color: [0.6, 0.45, 0.3, 1], roughness: 0.6 });
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 10 })),
    material_slots: [table],
  });
  const ball = createUVSphere({ segments: 24, ring_count: 12, radius: 0.6 });
  ball.faceSmooth = ball.faceSmooth.map(() => true);
  const red = doc.addMaterial({ name: 'Red', base_color: [0.7, 0.15, 0.1, 1], roughness: 0.4 });
  doc.addObject({
    type: 'MESH',
    name: 'Ball',
    data: doc.addMesh('Ball', ball),
    location: [0, 0, 0.6],
    material_slots: [red],
  });
  const brass = doc.addMaterial({ name: 'Brass', base_color: [0.9, 0.7, 0.3, 1], metallic: 1, roughness: 0.3 });
  doc.addObject({
    type: 'MESH',
    name: 'Box',
    data: doc.addMesh('Box', createCube({ size: 0.8 })),
    location: [1.3, 0.5, 0.4],
    material_slots: [brass],
  });
  doc.addObject({
    type: 'LIGHT',
    name: 'Area',
    data: doc.addLight({ type: 'AREA', energy: 300, size: 1.5 }),
    location: [1, -1, 3],
  });
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ name: 'Cam', lens: 35 }),
    location: [3.2, -4.2, 2.4],
    rotation_euler: [1.15, 0, 0.65],
  });
  doc.updateScene({ camera: cam, frame_start: 1, frame_end: 2 });
  return doc;
}

/** Mean absolute difference of horizontally adjacent pixels (sRGB levels): high for speckle. */
function neighbourDiff(d: Uint8ClampedArray, w: number, h: number): number {
  let s = 0;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x + 1 < w; x++) {
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) s += Math.abs(d[o + k] - d[o + 4 + k]);
      n += 3;
    }
  return s / n;
}

/** Mean absolute difference of two RGBA8 images (sRGB levels, colour channels). */
function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) s += Math.abs(a[i + k] - b[i + k]);
  return s / ((a.length / 4) * 3);
}

const W = 96;
const H = 54;

describe('path tracer denoising at very low sample counts (#12, #18)', () => {
  it('estimates the variance of one-sample pixels from their neighbourhood', () => {
    const doc = shadowScene();
    const t = tracerFor(doc, { width: W, height: H, samples: 1, maxBounces: 3 });
    t.render();
    expect(t.film.samples).toBe(1);
    const img = t.film.resolve();
    // the per-pixel estimate (lum2/N − mean²) is exactly 0 at N = 1; the spatial one is not
    let surfaces = 0;
    let positive = 0;
    for (let i = 0; i < W * H; i++) {
      const nl = Math.hypot(img.normal[i * 3], img.normal[i * 3 + 1], img.normal[i * 3 + 2]);
      if (nl < 0.5) continue;
      surfaces++;
      if (img.variance[i] > 0) positive++;
      expect(Number.isFinite(img.variance[i])).toBe(true);
    }
    expect(surfaces).toBeGreaterThan(W * H * 0.5);
    expect(positive / surfaces).toBeGreaterThan(0.9);
  });

  it('denoises a 1-spp render about as well as a 2-spp one (no raw speckle)', () => {
    const doc = shadowScene();
    const render = (samples: number, denoise: boolean, seed = 0) =>
      renderSceneSoftware(doc, {
        width: W,
        height: H,
        engine: 'PATHTRACER',
        samples,
        denoise,
        max_bounces: 3,
        seed,
      });
    const ref = render(256, false, 11);
    const raw1 = render(1, false);
    const den1 = render(1, true);
    const den2 = render(2, true);
    const nd = (img: { data: Uint8ClampedArray }) => neighbourDiff(img.data, W, H);
    // before the fix the denoised 1-spp image was the raw one (identical speckle)
    expect(meanAbsDiff(den1.data, raw1.data)).toBeGreaterThan(3);
    expect(nd(den1)).toBeLessThan(0.3 * nd(raw1));
    expect(nd(den1)).toBeLessThan(nd(den2) * 2);
    // and it is close to the converged image (the raw one is far off)
    expect(meanAbsDiff(den1.data, ref.data)).toBeLessThan(0.4 * meanAbsDiff(raw1.data, ref.data));
    expect(meanAbsDiff(den1.data, ref.data)).toBeLessThan(meanAbsDiff(den2.data, ref.data) * 2);
  }, 60_000);

  it('denoises films whose rows have different sample counts (time-limited passes)', () => {
    const doc = shadowScene();
    const t = tracerFor(doc, { width: W, height: H, samples: 8, maxBounces: 3 });
    const film = new PathFilm(W, H);
    // the top half reached 8 samples, the bottom half only the guaranteed first one
    film.add(t.renderRows(0, H / 2, 0, 8));
    film.add(t.renderRows(H / 2, H, 0, 1));
    const img = film.resolve();
    const out = denoiseFilm(img);
    const raw = img.color;
    // speckle of the bottom (1-spp) half before and after denoising, in linear luminance
    const speckle = (c: Float32Array) => {
      let s = 0;
      let n = 0;
      for (let y = H / 2 + 1; y < H; y++)
        for (let x = 0; x + 1 < W; x++) {
          const i = (y * W + x) * 4;
          const l = (j: number) => 0.2126 * c[j] + 0.7152 * c[j + 1] + 0.0722 * c[j + 2];
          s += Math.abs(Math.min(l(i), 2) - Math.min(l(i + 4), 2));
          n++;
        }
      return s / n;
    };
    expect(speckle(out)).toBeLessThan(0.35 * speckle(raw));
    expect([...out].every(Number.isFinite)).toBe(true);
    // well-sampled rows keep the per-pixel estimate: identical to a film of only those rows
    const top = new PathFilm(W, H / 2);
    top.add(t.renderRows(0, H / 2, 0, 8));
    const topImg = top.resolve();
    for (let i = 0; i < (W * H) / 2; i++) expect(img.variance[i]).toBe(topImg.variance[i]);
  }, 60_000);

  it('time-limited animation frames that stop at 1 spp come out denoised', () => {
    const doc = shadowScene();
    // a time limit that only fits the guaranteed first sample of every frame
    const res = renderAnimation(doc, {
      format: 'PNG_SEQUENCE',
      frame_start: 1,
      frame_end: 2,
      width: W,
      height: H,
      engine: 'PATHTRACER',
      samples: 64,
      denoise: true,
      max_bounces: 3,
      time_limit: 1e-6,
    });
    expect(res.undersampled_frames).toEqual([1, 2]);
    // how many samples every frame got (aligned with `frames`)
    expect(res.frame_samples).toEqual([1, 1]);
    const raw = renderSceneSoftware(doc, {
      width: W,
      height: H,
      frame: 1,
      engine: 'PATHTRACER',
      samples: 1,
      denoise: false,
      max_bounces: 3,
    });
    for (const f of res.files!) {
      const img = decodePNG(f.data);
      expect(neighbourDiff(img.data, W, H)).toBeLessThan(0.3 * neighbourDiff(raw.data, W, H));
    }
  }, 60_000);

  it('reports no per-frame sample counts for rasterized animations', () => {
    const doc = shadowScene();
    const res = renderAnimation(doc, {
      format: 'PNG_SEQUENCE',
      frame_start: 1,
      frame_end: 1,
      width: 16,
      height: 9,
      engine: 'RASTER',
    });
    expect(res.frame_samples).toBeUndefined();
  });
});
