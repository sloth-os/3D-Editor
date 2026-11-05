import { describe, expect, it } from 'vitest';
import { SceneDoc, createPlane, renderSceneSoftware, type MaterialData, type RenderedImage } from '../src';
import { linearToSrgb } from '../src/render/color';

/*
 * Regression tests for phase-3 issues #5 and #40: the RASTER renderer drew alpha-blended (BLEND)
 * materials and glass (transmission) as a coarse 4×4 Bayer screen-door stipple (a faint light
 * shaft became a dot grid, a clear glass bottle a dotted white veil). Transparent surfaces are now
 * drawn after the opaque ones, sorted back to front and blended per sample.
 */

const px = (img: RenderedImage, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

/** Mean and standard deviation of channel `k` over a pixel box. */
function stats(img: RenderedImage, x0: number, y0: number, x1: number, y1: number, k: number) {
  const v: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(px(img, x, y)[k]);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd };
}

/**
 * A dark world (no lamps, no environment light: emission only) seen from above through planes at
 * the given heights; the camera looks straight down at a black floor.
 */
function layered(
  layers: { z: number; material: Partial<MaterialData>; size?: number }[],
  floor?: Partial<MaterialData>,
) {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  doc.addObject({ type: 'LIGHT', name: 'Off', data: doc.addLight({ type: 'SUN', energy: 0 }) });
  if (floor)
    doc.addObject({
      type: 'MESH',
      name: 'Floor',
      data: doc.addMesh('Floor', createPlane({ size: 20 })),
      material_slots: [doc.addMaterial({ name: 'Floor', ...floor })],
    });
  layers.forEach((l, i) =>
    doc.addObject({
      type: 'MESH',
      name: `Layer${i}`,
      data: doc.addMesh(`Layer${i}`, createPlane({ size: l.size ?? 20 })),
      location: [0, 0, l.z],
      material_slots: [doc.addMaterial({ name: `M${i}`, ...l.material })],
    }),
  );
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Top',
    data: doc.addCamera({ type: 'ORTHO', ortho_scale: 4, clip_end: 100 }),
    location: [0, 0, 10],
  });
  doc.updateScene({ camera: cam });
  return doc;
}

const emissive = (rgb: [number, number, number], alpha: number): Partial<MaterialData> => ({
  base_color: [0, 0, 0, 1],
  roughness: 1,
  emission_color: rgb,
  emission_strength: 1,
  alpha,
  blend_method: 'BLEND',
});

const level = (linear: number) => Math.round(linearToSrgb(linear) * 255);

describe('RASTER smooth transparency (#5, #40)', () => {
  it('blends a faint BLEND surface smoothly (no screen-door pattern), at the right level', () => {
    // a light-shaft-like surface: alpha 0.1 emissive over a mid-grey emissive floor
    const doc = layered([{ z: 1, material: emissive([1, 0.8, 0.5], 0.1) }], {
      base_color: [0, 0, 0, 1],
      roughness: 1,
      emission_color: [0.2, 0.2, 0.2],
      emission_strength: 1,
    });
    for (const samples of [1, 2, 4]) {
      const img = renderSceneSoftware(doc, { width: 32, height: 32, samples });
      for (let k = 0; k < 3; k++) {
        const s = stats(img, 4, 4, 28, 28, k);
        // uniform: before, a 4×4 Bayer dither left 0 or 1 of 16 samples covered (sd ≈ 10–30)
        expect(s.sd).toBeLessThan(0.75);
        const expected = 0.1 * [1, 0.8, 0.5][k] + 0.9 * 0.2;
        expect(Math.abs(s.mean - level(expected))).toBeLessThanOrEqual(2);
      }
    }
  });

  it('gives a smooth partial alpha over a transparent background', () => {
    // (0.3: not a multiple of 1/16, which a 4×4 dither would happen to spread evenly)
    const doc = layered([{ z: 1, material: emissive([1, 1, 1], 0.3) }]);
    const img = renderSceneSoftware(doc, { width: 24, height: 24, samples: 2, background: [0, 0, 0, 0] });
    const a = stats(img, 2, 2, 22, 22, 3);
    expect(a.sd).toBeLessThan(0.75);
    expect(Math.abs(a.mean - 0.3 * 255)).toBeLessThan(1);
  });

  it('sorts transparent surfaces back to front, whatever their drawing order', () => {
    const red = emissive([1, 0, 0], 0.5);
    const blue = emissive([0, 0, 1], 0.5);
    // red below blue, then the same layers swapped in the document (so drawing order differs)
    const a = renderSceneSoftware(
      layered([
        { z: 1, material: red },
        { z: 2, material: blue },
      ]),
      { width: 16, height: 16, samples: 1 },
    );
    const b = renderSceneSoftware(
      layered([
        { z: 2, material: blue },
        { z: 1, material: red },
      ]),
      { width: 16, height: 16, samples: 1 },
    );
    // blue over red over black: blue 0.5, red 0.5 × 0.5
    for (const img of [a, b]) {
      const c = px(img, 8, 8);
      expect(Math.abs(c[0] - level(0.25))).toBeLessThanOrEqual(2);
      expect(Math.abs(c[2] - level(0.5))).toBeLessThanOrEqual(2);
    }
    // and an opaque surface in front hides them (depth test against opaque geometry)
    const c = renderSceneSoftware(
      layered([
        { z: 1, material: red },
        { z: 3, material: { ...emissive([0, 1, 0], 1), blend_method: 'OPAQUE' } },
        { z: 2, material: blue },
      ]),
      { width: 16, height: 16, samples: 1 },
    );
    const g = px(c, 8, 8);
    expect(g[0]).toBeLessThan(3);
    expect(g[2]).toBeLessThan(3);
    expect(g[1]).toBeGreaterThan(250);
  });

  it('shows the scene through clear glass, tinted by its base colour, without a dotted veil', () => {
    // floor: an emissive red/blue split; a glass sheet (transmission 1) over half of it
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
    doc.addObject({ type: 'LIGHT', name: 'Off', data: doc.addLight({ type: 'SUN', energy: 0 }) });
    const glow = (rgb: [number, number, number]) =>
      doc.addMaterial({ base_color: [0, 0, 0, 1], roughness: 1, emission_color: rgb, emission_strength: 1 });
    doc.addObject({
      type: 'MESH',
      name: 'Red',
      data: doc.addMesh('Red', createPlane({ size: 2 })),
      location: [-1, 0, 0],
      material_slots: [glow([0.8, 0.1, 0.1])],
    });
    doc.addObject({
      type: 'MESH',
      name: 'Blue',
      data: doc.addMesh('Blue', createPlane({ size: 2 })),
      location: [1, 0, 0],
      material_slots: [glow([0.1, 0.1, 0.8])],
    });
    const glass = doc.addMaterial({
      name: 'Glass',
      base_color: [1, 1, 1, 1],
      transmission: 1,
      roughness: 0,
      ior: 1.5,
    });
    // the sheet covers y ∈ [0, 4]: the upper half of the floor (image rows 10–20) and nothing
    // above it (rows 0–10); the lower half of the floor (rows 20–30) is bare
    doc.addObject({
      type: 'MESH',
      name: 'Glass',
      data: doc.addMesh('Glass', createPlane({ size: 4 })),
      location: [0, 2, 1],
      material_slots: [glass],
    });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Top',
      data: doc.addCamera({ type: 'ORTHO', ortho_scale: 4, clip_end: 100 }),
      location: [0, 0, 10],
    });
    doc.updateScene({ camera: cam });
    const img = renderSceneSoftware(doc, { width: 40, height: 40, samples: 2 });
    for (const [x, k] of [
      [10, 0],
      [30, 2],
    ] as const) {
      const through = stats(img, x - 4, 12, x + 4, 18, k);
      const bare = stats(img, x - 4, 22, x + 4, 28, k);
      // clear glass at normal incidence lets ≈ 96 % through (4 % Fresnel reflection), smoothly
      // (before: a 20 % opaque white Bayer dither)
      expect(through.sd).toBeLessThan(0.75);
      expect(through.mean).toBeGreaterThan(bare.mean - 10);
      expect(through.mean).toBeLessThanOrEqual(bare.mean + 1);
    }
    // over a transparent film the glass is nearly transparent too (its coverage is what it reflects)
    const film = renderSceneSoftware(doc, { width: 40, height: 40, samples: 2, background: [0, 0, 0, 0] });
    const alpha = stats(film, 4, 2, 36, 8, 3);
    expect(alpha.mean).toBeLessThan(0.1 * 255);
    expect(alpha.sd).toBeLessThan(0.75);
    // a green-tinted glass filters the red floor
    doc.updateMaterial(glass, { base_color: [0.1, 1, 0.1, 1] });
    const tinted = renderSceneSoftware(doc, { width: 40, height: 40, samples: 2 });
    expect(stats(tinted, 6, 12, 14, 18, 0).mean).toBeLessThan(stats(img, 6, 12, 14, 18, 0).mean * 0.6);
  });
});
