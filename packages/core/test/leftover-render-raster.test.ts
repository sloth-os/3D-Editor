import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  createPlane,
  encodePNG,
  renderSceneSoftware,
  type MaterialData,
  type RenderedImage,
  type ViewTransform,
} from '../src';
import { defaultProcedural } from '../src/material/procedural';
import { applyViewTransform } from '../src/render/pathtrace';

/*
 * CPU rasterizer (RASTER engine without a browser) fixes from the example projects (phase 3 v2):
 * - it ignored the scene's view transform (always Standard), so previews of AgX/ACES-lit scenes
 *   were blown out (domino-cascade);
 * - a procedural emission texture on a transmissive material was drawn as a flat colour: the
 *   per-pixel material lost the transmission and shaded the glass as an opaque diffuse surface
 *   (lighthouse-cove);
 * - Film > Transparent was ignored (leftovers);
 * - an IMAGE world background came from the 256 × 128 lighting map (blurry);
 * - the mist colour was added again in front of distant glass.
 */

const px = (img: RenderedImage, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

/** An emissive plane filling the view of an orthographic camera looking down (black world). */
function emitterScene(rgb: [number, number, number], extra: Partial<MaterialData> = {}): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  doc.addObject({
    type: 'MESH',
    name: 'Panel',
    data: doc.addMesh('Panel', createPlane({ size: 4 })),
    material_slots: [
      doc.addMaterial({
        base_color: [0, 0, 0, 1],
        ior: 1,
        roughness: 1,
        emission_color: rgb,
        emission_strength: 1,
        ...extra,
      }),
    ],
  });
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Top',
    data: doc.addCamera({ type: 'ORTHO', ortho_scale: 2, clip_end: 100 }),
    location: [0, 0, 5],
  });
  doc.updateScene({ camera: cam });
  return doc;
}

const display = (vt: ViewTransform, rgb: number[]) => {
  const out = [0, 0, 0];
  applyViewTransform(vt, rgb[0], rgb[1], rgb[2], out);
  return out.map((v) => Math.round(v * 255));
};

describe('RASTER: view transform, film transparency, world background (phase 3 v2)', () => {
  it('applies the scene view transform and exposure like the path tracer (domino-cascade)', () => {
    const radiance: [number, number, number] = [2.5, 0.9, 0.2];
    const doc = emitterScene(radiance);
    for (const vt of ['STANDARD', 'AGX', 'FILMIC', 'ACES', 'NEUTRAL'] as const) {
      doc.updateRender({ view_transform: vt, exposure: -0.5 });
      const raster = px(renderSceneSoftware(doc, { width: 8, height: 8, samples: 1 }), 4, 4);
      const expected = display(
        vt,
        radiance.map((v) => v * 2 ** -0.5),
      );
      for (let c = 0; c < 3; c++) expect(Math.abs(raster[c] - expected[c]), `${vt} channel ${c}`).toBeLessThanOrEqual(1);
      const pt = px(
        renderSceneSoftware(doc, { width: 8, height: 8, engine: 'PATHTRACER', samples: 4, denoise: false }),
        4,
        4,
      );
      for (let c = 0; c < 3; c++) expect(Math.abs(raster[c] - pt[c]), `${vt} vs path tracer`).toBeLessThanOrEqual(2);
    }
    // ACES rolls the highlight off where Standard clips
    doc.updateRender({ view_transform: 'STANDARD', exposure: 0 });
    const standard = px(renderSceneSoftware(doc, { width: 8, height: 8, samples: 1 }), 4, 4);
    doc.updateRender({ view_transform: 'ACES' });
    const aces = px(renderSceneSoftware(doc, { width: 8, height: 8, samples: 1 }), 4, 4);
    expect(standard[0]).toBe(255);
    expect(aces[0]).toBeLessThan(250);
    // SOLID shading keeps Standard (like the viewport's Solid mode)
    const solidStd = renderSceneSoftware(doc, { width: 8, height: 8, samples: 1, shading: 'SOLID' });
    doc.updateRender({ view_transform: 'STANDARD' });
    const solidAces = renderSceneSoftware(doc, { width: 8, height: 8, samples: 1, shading: 'SOLID' });
    expect(Buffer.from(solidStd.data).equals(Buffer.from(solidAces.data))).toBe(true);
  });

  it('honours Film > Transparent: no background where nothing is drawn', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0.3, 0.3, 0.3] });
    doc.addObject({ type: 'MESH', name: 'Cube', data: doc.addMesh('Cube', createCube({ size: 1 })) });
    doc.updateRender({ film_transparent: true });
    for (const vt of ['STANDARD', 'AGX'] as const) {
      doc.updateRender({ view_transform: vt });
      const img = renderSceneSoftware(doc, { width: 48, height: 32 });
      expect(px(img, 0, 0)[3], vt).toBe(0);
      expect(px(img, 47, 31)[3], vt).toBe(0);
      const mid = px(img, 24, 16);
      expect(mid[3], vt).toBe(255);
      expect(mid[0], vt).toBeGreaterThan(20);
      // anti-aliased edges: partial alpha, straight (un-premultiplied) colour
      let partial = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0 && img.data[i] < 255) partial++;
      expect(partial, vt).toBeGreaterThan(0);
    }
    // an explicit background still wins
    const red = renderSceneSoftware(doc, { width: 8, height: 8, background: [1, 0, 0, 1] });
    expect(px(red, 0, 0)).toEqual([255, 0, 0, 255]);
    // without Film > Transparent the world colour is behind
    doc.updateRender({ film_transparent: false });
    expect(px(renderSceneSoftware(doc, { width: 8, height: 8 }), 0, 0)[3]).toBe(255);
  });

  it('draws an IMAGE world background from the full-resolution image', () => {
    const doc = SceneDoc.create({ empty: true });
    // a 512 × 256 equirectangular image of 2-pixel stripes: lost in the 256 × 128 lighting map
    const W = 512;
    const H = 256;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = (x >> 1) % 2 ? 230 : 20;
        data.set([v, v, v, 255], (y * W + x) * 4);
      }
    const image = doc.addImage({ name: 'Checker', mime: 'image/png', width: W, height: H, data: encodePNG({ width: W, height: H, data }) });
    doc.updateWorld({
      environment: 'IMAGE',
      environment_image: image,
      show_environment_background: true,
      strength: 1,
    });
    doc.updateRender({ view_transform: 'STANDARD' });
    // 0.09° per render pixel, 0.7° per image pixel: every stripe spans about 15 pixels
    const view = { position: [0, 0, 0] as [number, number, number], target: [0, 10, 0] as [number, number, number], fovY: 0.1 };
    const raster = renderSceneSoftware(doc, { width: 64, height: 64, samples: 1, view });
    const row = Array.from({ length: 64 }, (_, x) => px(raster, x, 32)[0]);
    expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(150);
    // the same background as the path tracer's
    const pt = renderSceneSoftware(doc, { width: 64, height: 64, engine: 'PATHTRACER', samples: 16, denoise: false, view });
    let diff = 0;
    for (let x = 0; x < 64; x++) diff += Math.abs(px(pt, x, 32)[0] - row[x]);
    expect(diff / 64).toBeLessThan(25);
  });
});

describe('RASTER: glass (lighthouse-cove v2)', () => {
  it('draws a procedural emission texture on transmissive materials', () => {
    // a black-to-orange GENERATED gradient on clear index-matched glass, lit by a sun from above
    const doc = (transmission: number, sun: number) => {
      const d = emitterScene([1, 1, 1], {
        base_color: [1, 1, 1, 1],
        transmission,
        roughness: 0,
        textures: {
          emission: {
            image: '',
            scale: [1, 1],
            offset: [0, 0],
            procedural: defaultProcedural('GRADIENT', {
              mapping: 'GENERATED',
              color_a: [0, 0, 0, 1],
              color_b: [1, 0.6, 0.3, 1],
            }),
          },
        },
      });
      d.updateRender({ view_transform: 'STANDARD' });
      d.addObject({ type: 'LIGHT', name: 'Sun', data: d.addLight({ type: 'SUN', energy: sun }) });
      return d;
    };
    const glass = renderSceneSoftware(doc(1, 2), { width: 32, height: 8, samples: 1 });
    // the gradient runs along X (the panel is 4 m wide, the view 2 m: its middle half)
    const left = px(glass, 2, 4);
    const right = px(glass, 29, 4);
    expect(right[0] - left[0]).toBeGreaterThan(60);
    expect(right[0] - right[2]).toBeGreaterThan(40);
    // clear glass reflects no sunlight diffusely: it looks the same unlit (it was shaded as an
    // opaque white surface, a flat lit white)
    const unlit = renderSceneSoftware(doc(1, 0), { width: 32, height: 8, samples: 1 });
    for (const x of [2, 16, 29])
      for (let c = 0; c < 3; c++) expect(Math.abs(px(glass, x, 4)[c] - px(unlit, x, 4)[c])).toBeLessThanOrEqual(3);
    // while an opaque white emitter does
    const opaque = renderSceneSoftware(doc(0, 2), { width: 32, height: 8, samples: 1 });
    expect(px(opaque, 2, 4)[2] - px(glass, 2, 4)[2]).toBeGreaterThan(60);
  });

  it('keeps the mist of what is seen through distant glass (no second mist veil)', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0], mist_density: 0.01, mist_color: [0.8, 0.1, 0.1] });
    doc.updateRender({ view_transform: 'STANDARD' });
    doc.addObject({ type: 'LIGHT', name: 'Off', data: doc.addLight({ type: 'SUN', energy: 0 }) });
    const wall = (name: string, size: number, x: number, y: number, m: Partial<MaterialData>) =>
      doc.addObject({
        type: 'MESH',
        name,
        data: doc.addMesh(name, createPlane({ size })),
        location: [x, y, 0],
        rotation_euler: [Math.PI / 2, 0, 0],
        material_slots: [doc.addMaterial({ name, ...m })],
      });
    wall('Far', 400, 0, 150, { base_color: [0, 0, 0, 1], ior: 1, roughness: 1, emission_color: [1, 1, 1], emission_strength: 1 });
    // an index-matched pane 120 m away, itself 76 % in the mist
    wall('Pane', 40, -30, 120, { base_color: [1, 1, 1, 1], transmission: 1, roughness: 0, ior: 1 });
    const img = renderSceneSoftware(doc, {
      width: 64,
      height: 32,
      samples: 1,
      view: { position: [0, 0, 0], target: [0, 10, 0], fovY: 0.66 },
    });
    const around = px(img, 60, 16);
    const through = px(img, 20, 16);
    for (let c = 0; c < 3; c++) expect(Math.abs(through[c] - around[c]), `channel ${c}`).toBeLessThanOrEqual(3);
  });
});
