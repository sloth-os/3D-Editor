import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  createPlane,
  defaultProcedural,
  filmToRGBA8,
  renderSceneSoftware,
  type RenderedImage,
  type Vec3,
} from '../src';
import { ditherByte, ditherThreshold, linearToSrgb, linearToSrgb255 } from '../src/render/color';
import {
  boxOverGround,
  imageHash,
  lookCamera,
  luma,
  mixedScene,
  projectToPixel,
} from './render-desk-helpers';

const rgbAt = (img: RenderedImage, p: [number, number]) => {
  const o = (p[1] * img.width + p[0]) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const chroma = (c: number[]) => Math.max(...c) - Math.min(...c);

describe('looks', () => {
  it('clay: every surface the same neutral grey under neutral light', () => {
    const build = boxOverGround(
      [{ data: { type: 'SUN', energy: 3 }, location: [0, 0, 5], rotation: [0.4, 0, 0.3] }],
      {
        cube: { base_color: [0.9, 0.1, 0.05, 1], metallic: 1, roughness: 0.2 },
        camera: [3, -5, 4],
        target: [0, 0, 1],
      },
    );
    const W = 96;
    const H = 72;
    const material = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, aovs: ['depth'] });
    const clay = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, look: 'clay' });
    const face = projectToPixel(material.view!, [0.1, -0.5, 1.5], W, H)!;
    expect(chroma(rgbAt(material, face))).toBeGreaterThan(40);
    expect(chroma(rgbAt(clay, face))).toBeLessThanOrEqual(2);
    expect(imageHash(clay)).not.toBe(imageHash(material));
  });

  it('clay: textures give way to the plain grey', () => {
    // a 4 m plane with a 6 × 6 checker (0.67 m squares) under a sun, seen from above
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0.03, 0.03, 0.03], strength: 1 });
    doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
    const checker = doc.addMaterial({
      base_color: [0.5, 0.5, 0.5, 1],
      textures: {
        base_color: {
          image: '',
          scale: [1, 1],
          offset: [0, 0],
          procedural: defaultProcedural('CHECKER', {
            scale: 6,
            color_a: [0.8, 0.8, 0.8, 1],
            color_b: [0.1, 0.1, 0.1, 1],
          }),
        },
      },
    });
    doc.addObject({
      type: 'MESH',
      name: 'Board',
      data: doc.addMesh('B', createPlane({ size: 4 })),
      material_slots: [checker],
    });
    doc.addObject({
      type: 'LIGHT',
      name: 'Sun',
      data: doc.addLight({ type: 'SUN', energy: 2 }),
      location: [0, 0, 5],
    });
    lookCamera(doc, [0, -3, 4], [0, 0, 0], 35);
    const W = 96;
    const H = 72;
    const material = renderSceneSoftware(doc, { width: W, height: H, samples: 2, aovs: ['depth'] });
    const clay = renderSceneSoftware(doc, { width: W, height: H, samples: 2, look: 'clay' });
    // neighbouring squares differ in the material look, not in clay
    const a = projectToPixel(material.view!, [0.33, 0.1, 0], W, H)!;
    const b = projectToPixel(material.view!, [-0.33, 0.1, 0], W, H)!;
    expect(Math.abs(luma(material, a[0], a[1]) - luma(material, b[0], b[1]))).toBeGreaterThan(60);
    expect(Math.abs(luma(clay, a[0], a[1]) - luma(clay, b[0], b[1]))).toBeLessThan(2);
  });

  it('clay: alpha-blended and glass surfaces are still drawn where they were', () => {
    const { doc, ids } = mixedScene();
    const material = renderSceneSoftware(doc, { width: 96, height: 72, samples: 2, aovs: ['object'] });
    const clay = renderSceneSoftware(doc, {
      width: 96,
      height: 72,
      samples: 2,
      look: 'clay',
      aovs: ['object'],
    });
    expect(clay.aovs!.object).toEqual(material.aovs!.object);
    expect(material.aovs!.objectTable).toContain(ids.Veil);
    expect(material.aovs!.objectTable).toContain(ids.Glass);
  });

  it("solid: the look is the Solid shading's", () => {
    const { doc } = mixedScene();
    const look = renderSceneSoftware(doc, { width: 64, height: 48, samples: 2, look: 'solid' });
    const shading = renderSceneSoftware(doc, { width: 64, height: 48, samples: 2, shading: 'SOLID' });
    expect(imageHash(look)).toBe(imageHash(shading));
  });
});

describe('tonemapped resolve', () => {
  /** A thin, very bright emissive bar across a black world. */
  function brightBar(): SceneDoc {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0], strength: 1 });
    doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
    const mat = doc.addMaterial({
      base_color: [1, 1, 1, 1],
      emission_color: [1, 0.9, 0.7],
      emission_strength: 40,
    });
    doc.addObject({
      type: 'MESH',
      name: 'Bar',
      data: doc.addMesh('Bar', createCube({ size: 1 })),
      material_slots: [mat],
      scale: [3, 0.04, 0.04],
      rotation_euler: [0, 0, 0.3],
    });
    const floor = doc.addMaterial({ base_color: [0.2, 0.2, 0.2, 1] });
    doc.addObject({
      type: 'MESH',
      name: 'Floor',
      data: doc.addMesh('F', createPlane({ size: 10 })),
      material_slots: [floor],
      location: [0, 0, -1],
    });
    lookCamera(doc, [0, -4, 0.5], [0, 0, 0], 35);
    return doc;
  }

  it('keeps bright thin edges from blooming (darker partly covered pixels), interiors unchanged', () => {
    const doc = brightBar();
    const box = renderSceneSoftware(doc, { width: 96, height: 72, samples: 4 });
    const tm = renderSceneSoftware(doc, { width: 96, height: 72, samples: 4, resolve: 'tonemap' });
    let boxSum = 0;
    let tmSum = 0;
    let differing = 0;
    for (let y = 0; y < 72; y++)
      for (let x = 0; x < 96; x++) {
        const lb = luma(box, x, y);
        const lt = luma(tm, x, y);
        expect(lt).toBeLessThanOrEqual(lb + 1);
        if (lb !== lt) differing++;
        boxSum += lb;
        tmSum += lt;
      }
    expect(differing).toBeGreaterThan(20);
    expect(tmSum).toBeLessThan(boxSum * 0.97);
  });

  it('keeps the coverage as alpha on a transparent film and over an explicit background', () => {
    // the bright bar alone (one emissive colour): every pixel's covered samples share one colour,
    // so the tonemapped resolve must give the box resolve's pixels — its weights may favour dark
    // samples over bright ones, but empty samples are no colour and must not thin the bar out
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0], strength: 1 });
    doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD', film_transparent: true });
    const mat = doc.addMaterial({
      base_color: [1, 1, 1, 1],
      emission_color: [1, 0.9, 0.7],
      emission_strength: 40,
    });
    doc.addObject({
      type: 'MESH',
      name: 'Bar',
      data: doc.addMesh('Bar', createCube({ size: 1 })),
      material_slots: [mat],
      scale: [3, 0.04, 0.04],
      rotation_euler: [0, 0, 0.3],
    });
    lookCamera(doc, [0, -4, 0.5], [0, 0, 0], 35);
    const size = { width: 96, height: 72, samples: 4 };
    for (const vt of ['STANDARD', 'AGX'] as const)
      for (const background of [undefined, [0.2, 0.3, 0.4, 1] as [number, number, number, number]]) {
        doc.updateRender({ view_transform: vt });
        const box = renderSceneSoftware(doc, { ...size, background });
        const tm = renderSceneSoftware(doc, { ...size, background, resolve: 'tonemap' });
        let edge = 0;
        for (let p = 0; p < 96 * 72; p++) {
          const o = p * 4;
          const a = box.data[o + 3];
          const where = `${vt} ${background ? 'background' : 'film'} pixel ${p}`;
          expect(tm.data[o + 3], where).toBe(a);
          for (let c = 0; c < 3; c++)
            expect(Math.abs(tm.data[o + c] - box.data[o + c]), where).toBeLessThanOrEqual(1);
          if (!background && a > 0 && a < 255) edge++;
          else if (background) expect(a).toBe(255);
        }
        if (!background) expect(edge).toBeGreaterThan(40);
      }
  });

  it('matches the box filter with one sample per pixel and in msaa interiors', () => {
    const { doc } = mixedScene();
    const box = renderSceneSoftware(doc, { width: 64, height: 48, samples: 1 });
    const tm = renderSceneSoftware(doc, { width: 64, height: 48, samples: 1, resolve: 'tonemap' });
    for (let i = 0; i < box.data.length; i++)
      expect(Math.abs(box.data[i] - tm.data[i])).toBeLessThanOrEqual(1);
    const build = boxOverGround([
      { data: { type: 'SUN', energy: 3 }, location: [0, 0, 5], rotation: [0.4, 0, 0] },
    ]);
    const mBox = renderSceneSoftware(build.doc, {
      width: 96,
      height: 72,
      samples: 2,
      msaa: true,
      aovs: ['depth'],
    });
    const mTm = renderSceneSoftware(build.doc, {
      width: 96,
      height: 72,
      samples: 2,
      msaa: true,
      resolve: 'tonemap',
    });
    // the middle of the cube's lit top face and of the ground: one shading per pixel, unchanged
    for (const p of [
      [0, 0, 2],
      [2, 3, 0],
    ] as Vec3[]) {
      const px = projectToPixel(mBox.view!, p, 96, 72)!;
      expect(rgbAt(mTm, px)).toEqual(rgbAt(mBox, px));
    }
  });
});

describe('dithering', () => {
  it('uses the 64 thresholds of an 8 × 8 ordered pattern, repeating every 8 pixels', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const t = ditherThreshold(x, y);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        expect(Number.isInteger(t * 64 - 0.5)).toBe(true);
        expect(ditherThreshold(x + 8, y + 16)).toBe(t);
        seen.add(t);
      }
    expect(seen.size).toBe(64);
    // neighbours sit far apart in the order (no visible ramps)
    expect(Math.abs(ditherThreshold(0, 0) - ditherThreshold(1, 0))).toBeGreaterThan(0.2);
  });

  it('ditherByte: floor(v + t) clamped to a byte', () => {
    expect(ditherByte(10.3, 0.5)).toBe(10);
    expect(ditherByte(10.6, 0.5)).toBe(11);
    expect(ditherByte(-3, 0.9)).toBe(0);
    expect(ditherByte(300, 0.1)).toBe(255);
    expect(ditherByte(254.9, 0.2)).toBe(255);
  });

  it('linearToSrgb255 follows the sRGB curve', () => {
    for (let i = 0; i <= 2000; i++) {
      const c = i / 2000;
      expect(Math.abs(linearToSrgb255(c) - linearToSrgb(c) * 255)).toBeLessThan(0.02);
    }
    expect(linearToSrgb255(-1)).toBe(0);
    expect(linearToSrgb255(2)).toBe(255);
    expect(linearToSrgb255(Number.NaN)).toBe(0);
  });

  it('keeps the average of smooth gradients (no banding) within one step per pixel', () => {
    // a film ramp from 0.2 to 0.21 linear: a byte or two of display values
    const W = 64;
    const H = 8;
    const film = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        film.set([0.2 + (0.01 * x) / W, 0.2, 0.2, 1], o);
      }
    for (const vt of ['STANDARD', 'AGX'] as const) {
      const plain = filmToRGBA8(film, W, H, 1, vt);
      expect(filmToRGBA8(film, W, H, 1, vt, null, false)).toEqual(plain);
      const dith = filmToRGBA8(film, W, H, 1, vt, null, true);
      for (let i = 0; i < plain.length; i++) expect(Math.abs(dith[i] - plain[i])).toBeLessThanOrEqual(1);
      // the green channel's exact display value, against 8 × 8 block averages
      const exact = vt === 'STANDARD' ? linearToSrgb(0.2) * 255 : null;
      if (exact !== null) {
        let sum = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += dith[(y * W + x) * 4 + 1];
        expect(Math.abs(sum / 64 - exact)).toBeLessThan(0.05);
        expect(Math.abs(plain[1] - exact)).toBeGreaterThan(0.1);
      }
    }
  });

  it('renders deterministically, within one step of the undithered image', () => {
    const { doc } = mixedScene();
    const a = renderSceneSoftware(doc, { width: 64, height: 48, samples: 2, dither: true });
    const b = renderSceneSoftware(doc, { width: 64, height: 48, samples: 2, dither: true });
    const plain = renderSceneSoftware(doc, { width: 64, height: 48, samples: 2 });
    expect(imageHash(a)).toBe(imageHash(b));
    expect(imageHash(a)).not.toBe(imageHash(plain));
    for (let i = 0; i < a.data.length; i++)
      expect(Math.abs(a.data[i] - plain.data[i])).toBeLessThanOrEqual(1);
  });
});
