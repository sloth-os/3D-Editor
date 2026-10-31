import { describe, expect, it } from 'vitest';
import { SceneDoc, createPlane, createUVSphere, renderSceneSoftware, type RenderedImage } from '../src';
import {
  PathFilm,
  PathTracer,
  denoiseFilm,
  filmToRGBA8,
  pathTileTransferables,
  renderPathTracedImage,
} from '../src/render/pathtrace';
import { SceneEvaluator } from '../src/eval/evaluate';
import { renderItems } from '../src/eval/renderables';
import { viewFromCamera } from '../src/render/view';
import { at, topCamera, tracerFor } from './pathtrace-helpers';

/*
 * Path tracer API: dispatch through renderSceneSoftware, determinism, work splitting for workers,
 * film accumulation, denoising and the display transform.
 */

/** Dark world, a floor lit only by an emissive panel outside the view, plus a lamp that lights nothing. */
function emitterLitFloor(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 20 })),
    material_slots: [doc.addMaterial({ base_color: [0.8, 0.8, 0.8, 1], roughness: 1 })],
  });
  const glow = doc.addMaterial({
    base_color: [0, 0, 0, 1],
    emission_color: [1, 0.9, 0.8],
    emission_strength: 20,
  });
  doc.addObject({
    type: 'MESH',
    name: 'Panel',
    data: doc.addMesh('Panel', createPlane({ size: 1 })),
    location: [2, 0, 1.5],
    material_slots: [glow],
  });
  // a lamp pointing up: lights nothing visible but disables the rasterizer's fallback studio rig
  doc.addObject({
    type: 'LIGHT',
    name: 'Up',
    data: doc.addLight({ type: 'SPOT', energy: 10, spot_size: 0.3 }),
    location: [0, 0, -5],
    rotation_euler: [Math.PI, 0, 0],
  });
  topCamera(doc, 2, 10);
  return doc;
}

const centre = (img: RenderedImage) => {
  const o = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const same = (a: RenderedImage, b: RenderedImage) => Buffer.from(a.data).equals(Buffer.from(b.data));

describe('renderSceneSoftware dispatch', () => {
  it('uses the path tracer for engine PATHTRACER (option or render settings), the rasterizer otherwise', () => {
    const doc = emitterLitFloor();
    const opts = { width: 16, height: 16, samples: 16 };
    const raster = renderSceneSoftware(doc, opts);
    expect(centre(raster).slice(0, 3)).toEqual([0, 0, 0]); // no indirect light in the rasterizer
    const pt = renderSceneSoftware(doc, { ...opts, engine: 'PATHTRACER' });
    expect(centre(pt)[0]).toBeGreaterThan(40);
    // the scene's render engine is used when the option is unset …
    doc.updateRender({ engine: 'PATHTRACER' });
    expect(same(renderSceneSoftware(doc, opts), pt)).toBe(true);
    // … and the option wins over it
    expect(same(renderSceneSoftware(doc, { ...opts, engine: 'RASTER' }), raster)).toBe(true);
    // SOLID shading and wireframe overlays always rasterize
    const solid = renderSceneSoftware(doc, { ...opts, shading: 'SOLID' });
    expect(same(solid, renderSceneSoftware(doc, { ...opts, shading: 'SOLID', engine: 'RASTER' }))).toBe(true);
    const wire = renderSceneSoftware(doc, { ...opts, wireframe: true });
    expect(same(wire, renderSceneSoftware(doc, { ...opts, wireframe: true, engine: 'RASTER' }))).toBe(true);
  });

  it('honours samples, seed, denoise and max_bounces options and the render settings defaults', () => {
    const doc = emitterLitFloor();
    doc.updateRender({ engine: 'PATHTRACER', samples: 8, use_denoising: false, max_bounces: 2 });
    const base = { width: 12, height: 12 };
    const a = renderSceneSoftware(doc, base);
    expect(same(a, renderSceneSoftware(doc, base))).toBe(true); // deterministic
    expect(same(a, renderSceneSoftware(doc, { ...base, seed: 7 }))).toBe(false);
    expect(same(a, renderSceneSoftware(doc, { ...base, samples: 4 }))).toBe(false);
    expect(same(a, renderSceneSoftware(doc, { ...base, denoise: true }))).toBe(false);
    expect(same(a, renderSceneSoftware(doc, { ...base, samples: 8, denoise: false, max_bounces: 2 }))).toBe(
      true,
    );
    // zero bounces still gives direct light (Cycles semantics); bounces add indirect light
    const direct = centre(renderSceneSoftware(doc, { ...base, max_bounces: 0 }))[0];
    expect(direct).toBeGreaterThan(40);
    expect(centre(renderSceneSoftware(doc, { ...base, max_bounces: 4 }))[0]).toBeGreaterThanOrEqual(direct);
    // progress callback per pass
    const passes: number[] = [];
    renderSceneSoftware(doc, { ...base, samples: 8, onProgress: (p) => void passes.push(p.samples) });
    expect(passes).toEqual([1, 3, 7, 8]);
  });

  it('applies the exposure like the rasterizer and returns straight alpha', () => {
    const doc = emitterLitFloor();
    doc.updateRender({ engine: 'PATHTRACER', samples: 4, use_denoising: false });
    const dark = renderSceneSoftware(doc, { width: 8, height: 8 });
    doc.updateRender({ exposure: 1 });
    const bright = renderSceneSoftware(doc, { width: 8, height: 8 });
    expect(centre(bright)[0]).toBeGreaterThan(centre(dark)[0]);
    const lin = new Float32Array([0.25, 0.1, 0, 0.5, 0, 0, 0, 0]);
    const out = filmToRGBA8(lin, 2, 1, 2);
    // un-premultiplied (0.5, 0.2, 0) × exposure 2 = (1, 0.4, 0)
    expect([...out.subarray(0, 4)]).toEqual([255, 170, 0, 128]);
    expect([...out.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
  });
});

describe('work splitting', () => {
  it('gives the same samples for any row partition and on a structured-cloned scene (workers)', () => {
    const doc = emitterLitFloor();
    const tracer = tracerFor(doc, { width: 10, height: 9, samples: 6 });
    const full = tracer.renderRows(0, 9, 0, 6);
    const top = tracer.renderRows(0, 4, 0, 6);
    const bottom = tracer.renderRows(4, 9, 0, 6);
    expect(full.color.subarray(0, 10 * 4 * 4)).toEqual(top.color);
    expect(full.color.subarray(10 * 4 * 4)).toEqual(bottom.color);
    // a worker gets a structured clone of the plain scene and settings
    const worker = new PathTracer(structuredClone(tracer.scene), structuredClone(tracer.settings));
    const w = worker.renderRows(4, 9, 0, 6);
    expect(w.color).toEqual(bottom.color);
    expect(w.albedo).toEqual(bottom.albedo);
    expect(pathTileTransferables(w)).toHaveLength(6);
    // splitting samples gives the same sums up to rounding
    const s0 = tracer.renderRows(0, 9, 0, 2);
    const s1 = tracer.renderRows(0, 9, 2, 4);
    for (let i = 0; i < full.color.length; i++)
      expect(s0.color[i] + s1.color[i]).toBeCloseTo(full.color[i], 4);
  });

  it('accumulates tiles in a film and tracks samples per row', () => {
    const doc = emitterLitFloor();
    const tracer = tracerFor(doc, { width: 6, height: 4, samples: 4 });
    const film = new PathFilm(6, 4);
    film.add(tracer.renderRows(0, 2, 0, 4));
    expect(film.samples).toBe(0);
    film.add(tracer.renderRows(2, 4, 0, 4));
    film.add(tracer.renderRows(0, 4, 4, 2));
    expect(film.samples).toBe(6);
    expect([...film.rowSamples]).toEqual([6, 6, 6, 6]);
    const mean = film.resolve();
    const direct = tracer.renderRows(0, 4, 0, 6);
    for (let i = 0; i < 6 * 4 * 4; i++) expect(mean.color[i]).toBeCloseTo(direct.color[i] / 6, 4);
    expect(() => film.add(tracerFor(doc, { width: 5, height: 4 }).renderRows(0, 1, 0, 1))).toThrow(/width/);
  });
});

describe('denoiser', () => {
  it('reduces the error of a noisy render towards the converged image', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0.02, 0.02, 0.02] });
    const white = doc.addMaterial({ base_color: [0.8, 0.8, 0.8, 1], roughness: 0.8 });
    doc.addObject({
      type: 'MESH',
      name: 'Floor',
      data: doc.addMesh('Floor', createPlane({ size: 10 })),
      material_slots: [white],
    });
    const ball = createUVSphere({ segments: 24, ring_count: 12, radius: 0.6 });
    ball.faceSmooth = ball.faceSmooth.map(() => true);
    const red = doc.addMaterial({ base_color: [0.7, 0.15, 0.1, 1], roughness: 0.6 });
    doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', ball),
      location: [0, 0, 0.6],
      material_slots: [red],
    });
    doc.addObject({
      type: 'LIGHT',
      name: 'Area',
      data: doc.addLight({ type: 'AREA', energy: 150, size: 2 }),
      location: [1, -1, 3],
    });
    const view = {
      position: [3, -4, 2.5] as [number, number, number],
      target: [0, 0, 0.4] as [number, number, number],
    };
    const run = (samples: number) => {
      const t = tracerFor(doc, { width: 32, height: 32, samples, view, maxBounces: 3 });
      t.render();
      return t;
    };
    const ref = run(512).resolve(false);
    const noisyTracer = run(4);
    const noisy = noisyTracer.resolve(false);
    const denoised = noisyTracer.resolve(true);
    const mse = (img: Float32Array) => {
      let s = 0;
      for (let i = 0; i < img.length; i += 4)
        for (let k = 0; k < 3; k++) s += (Math.min(img[i + k], 4) - Math.min(ref[i + k], 4)) ** 2;
      return s / (img.length / 4);
    };
    expect(mse(denoised)).toBeLessThan(0.5 * mse(noisy));
    // alpha is untouched and the result is finite
    for (let i = 3; i < denoised.length; i += 4) expect(denoised[i]).toBe(noisy[i]);
    expect([...denoised].every(Number.isFinite)).toBe(true);
    // a converged image barely changes
    const conv = run(512);
    const c0 = conv.resolve(false);
    const c1 = conv.resolve(true);
    let diff = 0;
    for (let i = 0; i < c0.length; i += 4) diff += Math.abs(c1[i] - c0[i]);
    expect(diff / (c0.length / 4)).toBeLessThan(0.02);
  }, 60_000);

  it('handles empty films and films without surfaces', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0.3, 0.3, 0.3] });
    topCamera(doc, 1, 5);
    const t = tracerFor(doc, { width: 4, height: 4, samples: 2 });
    t.render();
    const img = t.film.resolve();
    expect(denoiseFilm(img)).toEqual(img.color);
    const empty = new PathFilm(3, 3).resolve();
    expect([...denoiseFilm(empty)].every((v) => v === 0)).toBe(true);
    expect(at(t.resolve(), 4, 0, 0)[0]).toBeCloseTo(0.3, 6);
  });
});

describe('renderPathTracedImage', () => {
  it('returns display pixels with render statistics and compile warnings', () => {
    const doc = SceneDoc.create();
    doc.updateWorld({ environment: 'IMAGE', environment_image: 'missing' });
    const scene = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    const items = renderItems(scene, { forRender: true });
    const cam = scene.activeCamera!;
    const res = renderPathTracedImage({
      scene,
      items,
      view: viewFromCamera(cam.camera!, cam.worldMatrix, 2),
      camera: cam.camera!,
      width: 8,
      height: 4,
      images: { get: () => null },
      options: { samples: 3, denoise: false },
    });
    expect(res.width).toBe(8);
    expect(res.data.length).toBe(8 * 4 * 4);
    expect(res.stats.samples).toBe(3);
    expect(res.stats.stopped).toBe('done');
    expect(res.stats.warnings.some((w) => /missing/.test(w))).toBe(true);
  });
});
