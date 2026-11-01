import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  base64Decode,
  createEditorState,
  createOperatorRegistry,
  createPlane,
  createUVSphere,
  decodePNG,
  renderSceneSoftware,
  type OperatorContext,
  type RenderedImage,
} from '../src';
import {
  PathFilm,
  PathTracer,
  VIEW_TRANSFORMS,
  applyViewTransform,
  denoiseFilm,
  filmToRGBA8,
  pathTileTransferables,
  renderPathTracedImage,
  viewTransformOf,
} from '../src/render/pathtrace';
import { linearToSrgb } from '../src/render/color';
import { defaultProcedural } from '../src/material/procedural';
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
    // the scene's render engine is used when the option is unset (with the render settings'
    // samples: without an explicit engine `samples` is the anti-aliasing factor) …
    doc.updateRender({ engine: 'PATHTRACER', samples: 16 });
    expect(same(renderSceneSoftware(doc, { ...opts, samples: 2 }), pt)).toBe(true);
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
    // samples per pixel come from `samples` only with an explicit engine
    expect(same(a, renderSceneSoftware(doc, { ...base, engine: 'PATHTRACER', samples: 4 }))).toBe(false);
    expect(same(a, renderSceneSoftware(doc, { ...base, samples: 4 }))).toBe(true);
    expect(same(a, renderSceneSoftware(doc, { ...base, denoise: true }))).toBe(false);
    expect(
      same(
        a,
        renderSceneSoftware(doc, {
          ...base,
          engine: 'PATHTRACER',
          samples: 8,
          denoise: false,
          max_bounces: 2,
        }),
      ),
    ).toBe(true);
    // zero bounces still gives direct light (Cycles semantics); bounces add indirect light
    const direct = centre(renderSceneSoftware(doc, { ...base, max_bounces: 0 }))[0];
    expect(direct).toBeGreaterThan(40);
    expect(centre(renderSceneSoftware(doc, { ...base, max_bounces: 4 }))[0]).toBeGreaterThanOrEqual(direct);
    // progress callback per pass
    const passes: number[] = [];
    renderSceneSoftware(doc, { ...base, samples: 8, onProgress: (p) => void passes.push(p.samples) });
    expect(passes).toEqual([1, 3, 7, 8]);
  });

  it('path traces operator renders with the render settings samples (their samples are anti-aliasing)', () => {
    // regression: render.render_software passes its anti-aliasing factor (default 2) as `samples`,
    // which made scenes with engine PATHTRACER render at 2 samples per pixel
    const doc = emitterLitFloor();
    doc.updateRender({ engine: 'PATHTRACER', samples: 24, use_denoising: false });
    const reg = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: doc.origin,
      source: 'test',
      report: () => {},
    };
    const res = reg.run<{ data_base64: string }>(ctx, 'render.render_software', { width: 12, height: 12 });
    expect(res.ok).toBe(true);
    const img = decodePNG(base64Decode(res.result!.data_base64));
    const opts = { width: 12, height: 12, frame: ctx.state.frame, engine: 'PATHTRACER' } as const;
    const full = renderSceneSoftware(doc, { ...opts, samples: 24 });
    expect(Buffer.from(img.data).equals(Buffer.from(full.data))).toBe(true);
    expect(same(full, renderSceneSoftware(doc, { ...opts, samples: 2 }))).toBe(false);
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

describe('display transforms', () => {
  const out = [0, 0, 0];
  const show = (vt: (typeof VIEW_TRANSFORMS)[number], r: number, g = r, b = r) => {
    applyViewTransform(vt, r, g, b, out);
    return [...out];
  };

  it('STANDARD is the sRGB transfer function; the filmic transforms keep middle grey and roll off highlights', () => {
    for (const v of [0, 0.002, 0.05, 0.18, 0.7, 1, 3])
      expect(show('STANDARD', v)[0]).toBeCloseTo(linearToSrgb(v), 12);
    for (const vt of ['AGX', 'FILMIC', 'ACES'] as const) {
      expect(show(vt, 0.18)[0]).toBeCloseTo(linearToSrgb(0.18), 6);
      // neutral in, neutral out, monotonic over 23 stops, within [0, 1]
      let prev = 0;
      for (let e = -14; e <= 9; e += 0.05) {
        const [r, g, b] = show(vt, 2 ** e);
        expect(r).toBeGreaterThanOrEqual(prev);
        expect(r).toBeLessThanOrEqual(1);
        expect(g).toBeCloseTo(r, 12);
        expect(b).toBeCloseTo(r, 12);
        prev = r;
      }
      // scene white stays below display white, +4 stops are still distinguishable, +8 stops clip
      expect(show(vt, 1)[0]).toBeGreaterThan(0.7);
      expect(show(vt, 1)[0]).toBeLessThan(0.85);
      expect(show(vt, 16)[0]).toBeGreaterThan(show(vt, 8)[0]);
      expect(show(vt, 64)[0]).toBe(1);
    }
  });

  it('AgX and Filmic take very bright saturated colours to white; Standard and ACES keep them saturated', () => {
    for (const vt of ['AGX', 'FILMIC'] as const) {
      const [r, g, b] = show(vt, 64, 0, 0);
      expect(r).toBeGreaterThan(0.99);
      expect(Math.min(g, b)).toBeGreaterThan(0.6);
      // moderately bright colours keep their hue
      const [r1, g1, b1] = show(vt, 1, 0.3, 0.05);
      expect(r1).toBeGreaterThan(g1);
      expect(g1).toBeGreaterThan(b1);
    }
    expect(show('STANDARD', 64, 0, 0)).toEqual([1, 0, 0]);
    expect(show('ACES', 64, 0, 0)).toEqual([1, 0, 0]);
  });

  it('NEUTRAL is almost the identity below its compression start and compresses the peak above', () => {
    // Khronos PBR Neutral: a 0.04 offset above 0.08, nothing else below 0.76
    expect(show('NEUTRAL', 0.5)[0]).toBeCloseTo(linearToSrgb(0.46), 12);
    // below 0.08 the offset x − 6.25x² leaves 6.25x² (a smooth toe)
    expect(show('NEUTRAL', 0.02)[0]).toBeCloseTo(linearToSrgb(6.25 * 0.02 * 0.02), 12);
    const [r, g, b] = show('NEUTRAL', 20, 10, 5);
    expect(r).toBeLessThan(1);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('maps negative and non-finite input to black and unknown names to STANDARD', () => {
    for (const vt of VIEW_TRANSFORMS) expect(show(vt, NaN, -1, Infinity)).toEqual([0, 0, 0]);
    expect(viewTransformOf('AGX')).toBe('AGX');
    expect(viewTransformOf('Filmic Log')).toBe('STANDARD');
    expect(viewTransformOf(undefined)).toBe('STANDARD');
  });

  it('applies the scene view transform to path traced renders (the linear film is unchanged)', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
    // a camera-filling emitter with radiance 3
    doc.addObject({
      type: 'MESH',
      name: 'Glow',
      data: doc.addMesh('Glow', createPlane({ size: 20 })),
      material_slots: [
        doc.addMaterial({
          base_color: [0, 0, 0, 1],
          ior: 1,
          emission_color: [1, 0.25, 0.1],
          emission_strength: 3,
        }),
      ],
    });
    topCamera(doc, 2, 5);
    doc.updateRender({ engine: 'PATHTRACER', samples: 2, use_denoising: false });
    const opts = { width: 4, height: 4 };
    const expected = (vt: (typeof VIEW_TRANSFORMS)[number], r: number, g: number, b: number) =>
      show(vt, r, g, b).map((v) => Math.round(v * 255));
    const near = (a: number[], b: number[]) =>
      a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(1));
    const seen = new Set<string>();
    for (const vt of VIEW_TRANSFORMS) {
      doc.updateRender({ view_transform: vt });
      const c = centre(renderSceneSoftware(doc, opts));
      near(c.slice(0, 3), expected(vt, 3, 0.75, 0.3));
      expect(c[3]).toBe(255);
      seen.add(c.join());
    }
    expect(seen.size).toBe(VIEW_TRANSFORMS.length);
    // Standard clips the red channel, AgX keeps it below white
    doc.updateRender({ view_transform: 'STANDARD' });
    expect(centre(renderSceneSoftware(doc, opts))[0]).toBe(255);
    doc.updateRender({ view_transform: 'AGX' });
    expect(centre(renderSceneSoftware(doc, opts))[0]).toBeLessThan(250);
    // exposure is applied before the transform
    doc.updateRender({ exposure: -2 });
    near(centre(renderSceneSoftware(doc, opts)).slice(0, 3), expected('AGX', 0.75, 0.1875, 0.075));
  });

  it('filmToRGBA8 (by lookup tables) matches the exact transforms within one 8-bit step', () => {
    // regression: whole images went through a dozen Math.pow calls per pixel (AgX ≈ 2 µs/pixel)
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const n = 20000;
    const lin = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = i % 5 === 0 ? rnd() : 1;
      for (let k = 0; k < 3; k++) lin[i * 4 + k] = rnd() < 0.05 ? 0 : a * 2 ** (-14 + 23 * rnd());
      lin[i * 4 + 3] = a;
    }
    for (const vt of VIEW_TRANSFORMS)
      for (const bg of [null, [0.2, 0.5, 0.9, 0.7] as const]) {
        const img = filmToRGBA8(lin, n, 1, 1.3, vt, bg);
        let worst = 0;
        for (let i = 0; i < n; i++) {
          const a = lin[i * 4 + 3];
          const rest = (1 - a) * (bg ? bg[3] : 0);
          if (vt === 'STANDARD' && rest === 0) continue; // the rasterizer's byte table, as before
          show(vt, (lin[i * 4] * 1.3) / a, (lin[i * 4 + 1] * 1.3) / a, (lin[i * 4 + 2] * 1.3) / a).forEach(
            (v, k) => {
              const exact = Math.round(((v * a + (bg ? bg[k] : 0) * rest) / (a + rest)) * 255);
              worst = Math.max(worst, Math.abs(exact - img[i * 4 + k]));
            },
          );
        }
        expect(worst, `${vt} ${bg ? 'over a background' : ''}`).toBeLessThanOrEqual(1);
      }
  });

  it('filmToRGBA8 composites a display-space background behind partial coverage', () => {
    // pixel 0: half-covered mid grey; pixel 1: empty
    const lin = new Float32Array([0.09, 0.09, 0.09, 0.5, 0, 0, 0, 0]);
    const grey = Math.round(linearToSrgb(0.18) * 255);
    const mix = Math.round((linearToSrgb(0.18) + 1) * 0.5 * 255);
    for (const vt of ['STANDARD', 'AGX'] as const) {
      expect([...filmToRGBA8(lin, 2, 1, 1, vt)]).toEqual([grey, grey, grey, 128, 0, 0, 0, 0]);
      expect([...filmToRGBA8(lin, 2, 1, 1, vt, [1, 1, 1, 1])]).toEqual([
        mix,
        mix,
        mix,
        255,
        255,
        255,
        255,
        255,
      ]);
      // a half transparent background
      const half = filmToRGBA8(lin, 2, 1, 1, vt, [0, 0, 1, 0.5]);
      expect([...half.subarray(4)]).toEqual([0, 0, 255, 128]);
      expect(half[3]).toBe(191);
    }
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

  it('structured-clones scenes with a procedural sky, procedural textures and emitters', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'SKY', show_environment_background: true });
    const slot = (type: 'CHECKER' | 'NOISE', mapping: 'OBJECT' | 'GENERATED') => ({
      image: '',
      scale: [1, 1] as [number, number],
      offset: [0, 0] as [number, number],
      procedural: defaultProcedural(type, { mapping, scale: 3 }),
    });
    doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: doc.addMesh('Ground', createPlane({ size: 20 })),
      material_slots: [
        doc.addMaterial({
          textures: { base_color: slot('CHECKER', 'OBJECT'), normal: slot('NOISE', 'GENERATED') },
        }),
      ],
    });
    doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', createUVSphere({ segments: 16, ring_count: 8 })),
      location: [0, 0, 1],
      material_slots: [
        doc.addMaterial({
          emission_strength: 2,
          emission_color: [1, 0.5, 0.2],
          textures: { emission: slot('NOISE', 'GENERATED') },
        }),
      ],
    });
    const tracer = tracerFor(doc, {
      width: 12,
      height: 8,
      samples: 2,
      view: { position: [0, -6, 2.5], target: [0, 0, 0.5] },
    });
    expect(tracer.scene.environment.kind).toBe(2);
    expect(tracer.scene.emitters).toHaveLength(1);
    const clone = new PathTracer(structuredClone(tracer.scene), structuredClone(tracer.settings));
    expect(clone.renderRows(0, 8, 0, 2).color).toEqual(tracer.renderRows(0, 8, 0, 2).color);
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
