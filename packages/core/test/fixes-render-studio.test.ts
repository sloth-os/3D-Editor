import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  createCylinder,
  createPlane,
  createUVSphere,
  decompose4,
  encodePNG,
  getMaterialPreset,
  invert4,
  lookAt4,
  presetMaterialValues,
  renderSceneSoftware,
  type RenderedImage,
  type Vec3,
} from '../src';
import { environmentLighting, sampleEnvironmentLighting } from '../src/render/env-light';
import { defaultWorldSettings } from '../src/doc/defaults';

/*
 * Regression tests for phase-3 issue #11: the RASTER renderer ignored the STUDIO (and IMAGE) world
 * environment (it lit with a uniform ambient = world colour), so metals, which have no diffuse
 * part, rendered as black silhouettes while the path tracer showed them bright and reflective.
 */

const aim = (from: Vec3, to: Vec3): Vec3 => decompose4(invert4(lookAt4(from, to, [0, 0, 1]))).rotation;

/** A pixel box [x0, y0, x1, y1). */
type Box = readonly [number, number, number, number];

/** Mean sRGB colour of a pixel box [x0, x1) × [y0, y1). */
function boxMean(img: RenderedImage, ...[x0, y0, x1, y1]: Box): number[] {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) s[k] += img.data[o + k];
      n++;
    }
  return s.map((v) => v / n);
}

const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** A brass ball and a chrome ball on a grey floor in a studio world with a dark backdrop colour. */
function studioScene(envStrength: number): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({
    environment: 'STUDIO',
    environment_strength: envStrength,
    color: [0.012, 0.009, 0.007],
    strength: 1,
  });
  const floor = doc.addMaterial({ name: 'Floor', base_color: [0.3, 0.3, 0.32, 1], roughness: 0.7 });
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 10 })),
    material_slots: [floor],
  });
  const brass = doc.addMaterial({
    name: 'Brass',
    ...presetMaterialValues(getMaterialPreset('brass')!),
  });
  const chrome = doc.addMaterial({ name: 'Chrome', base_color: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.05 });
  const ball = createUVSphere({ segments: 32, ring_count: 16, radius: 0.5 });
  ball.faceSmooth = ball.faceSmooth.map(() => true);
  doc.addObject({
    type: 'MESH',
    name: 'Brass',
    data: doc.addMesh('Ball', ball),
    location: [-0.6, 0, 0.5],
    material_slots: [brass],
  });
  doc.addObject({
    type: 'MESH',
    name: 'Chrome',
    data: doc.addMesh('Ball2', ball),
    location: [0.6, 0, 0.5],
    material_slots: [chrome],
  });
  const camLoc: Vec3 = [0, -4, 1.2];
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ name: 'Cam', lens: 50 }),
    location: camLoc,
    rotation_euler: aim(camLoc, [0, 0, 0.5]),
  });
  doc.updateScene({ camera: cam });
  return doc;
}

const W = 96;
const H = 54;
// the balls' centres in the 96 × 54 image
const BRASS: Box = [26, 22, 36, 32];
const CHROME: Box = [60, 22, 70, 32];

describe('RASTER studio / image environment lighting (#11)', () => {
  it('lights and reflects metals with the STUDIO environment like the path tracer', () => {
    const doc = studioScene(1);
    // the rasterizer's display transform, for a like-for-like comparison
    doc.updateRender({ view_transform: 'STANDARD' });
    const raster = renderSceneSoftware(doc, { width: W, height: H, engine: 'RASTER', samples: 2 });
    const pt = renderSceneSoftware(doc, { width: W, height: H, engine: 'PATHTRACER', samples: 24, denoise: true });
    for (const box of [BRASS, CHROME]) {
      const r = lum(boxMean(raster, ...box));
      const p = lum(boxMean(pt, ...box));
      // not a black silhouette (before the fix: ≈ 0.05 × F0 ambient, under 30 sRGB levels)
      expect(r).toBeGreaterThan(70);
      // and in the path tracer's ballpark
      expect(r).toBeGreaterThan(p * 0.6);
      expect(r).toBeLessThan(p * 1.6);
    }
    // brass keeps its colour (reflections are tinted by the metal)
    const brass = boxMean(raster, ...BRASS);
    expect(brass[0]).toBeGreaterThan(brass[2] * 1.3);
  }, 60_000);

  it('scales with environment_strength and follows environment_rotation', () => {
    const bright = renderSceneSoftware(studioScene(1), { width: W, height: H, samples: 1 });
    const dim = renderSceneSoftware(studioScene(0.07), { width: W, height: H, samples: 1 });
    expect(lum(boxMean(dim, ...BRASS))).toBeLessThan(lum(boxMean(bright, ...BRASS)) * 0.6);
    const rotated = studioScene(1);
    rotated.updateWorld({ environment_rotation: Math.PI / 2 });
    const turned = renderSceneSoftware(rotated, { width: W, height: H, samples: 1 });
    let diff = 0;
    for (let i = 0; i < turned.data.length; i++) diff += Math.abs(turned.data[i] - bright.data[i]);
    expect(diff / turned.data.length).toBeGreaterThan(0.5);
  });

  it('draws the studio as background with show_environment_background', () => {
    const doc = studioScene(1);
    doc.updateWorld({ show_environment_background: true });
    const img = renderSceneSoftware(doc, { width: W, height: H, samples: 1 });
    // the backdrop colour (≈ 0.01 linear, ~25 sRGB levels) unless the studio is shown
    const plain = renderSceneSoftware(studioScene(1), { width: W, height: H, samples: 1 });
    expect(lum(boxMean(plain, 0, 0, W, 6))).toBeLessThan(35);
    expect(lum(boxMean(img, 0, 0, W, 6))).toBeGreaterThan(lum(boxMean(plain, 0, 0, W, 6)) + 15);
  });

  it('lights with an IMAGE environment (equirectangular PNG)', () => {
    // 64 × 32 equirect: bright warm sky (top half), dark ground
    const ew = 64;
    const eh = 32;
    const px = new Uint8ClampedArray(ew * eh * 4);
    for (let y = 0; y < eh; y++)
      for (let x = 0; x < ew; x++) {
        const o = (y * ew + x) * 4;
        const sky = y < eh / 2;
        px[o] = sky ? 255 : 10;
        px[o + 1] = sky ? 200 : 10;
        px[o + 2] = sky ? 120 : 10;
        px[o + 3] = 255;
      }
    const doc = studioScene(1);
    const image = doc.addImage({
      name: 'Sky',
      mime: 'image/png',
      width: ew,
      height: eh,
      data: encodePNG({ width: ew, height: eh, data: px }),
    });
    doc.updateWorld({ environment: 'IMAGE', environment_image: image });
    const img = renderSceneSoftware(doc, { width: W, height: H, samples: 1 });
    // the chrome ball's upper half mirrors the warm sky, its lower half the dark ground / floor
    const top = boxMean(img, 62, 15, 68, 20);
    const bottom = boxMean(img, 62, 34, 68, 38);
    expect(lum(top)).toBeGreaterThan(lum(bottom) + 40);
    expect(top[0]).toBeGreaterThan(top[2] + 30);
    // an undecodable image lights like no environment: nothing breaks
    doc.updateWorld({ environment_image: 'missing' });
    expect(() => renderSceneSoftware(doc, { width: 16, height: 9, samples: 1 })).not.toThrow();
  });

  it('prefiltered environment lookups are finite, rotate with the world and blur with roughness', () => {
    const w = defaultWorldSettings();
    const env = environmentLighting(w, null)!;
    expect(env).not.toBeNull();
    const out = new Float64Array(3);
    const values: number[] = [];
    for (const r of [0, 0.1, 0.26, 0.5, 0.8, 1]) {
      sampleEnvironmentLighting(env, 0, 0, 1, r, out);
      expect([...out].every(Number.isFinite)).toBe(true);
      values.push(out[0]);
    }
    // the top softbox seen straight up: the mirror sees it at full radiance, blur spreads it out
    expect(values[0]).toBeGreaterThan(values[values.length - 1]);
    // no lighting without strength, and none for NONE / SKY worlds (those have their own)
    expect(environmentLighting({ ...w, environment_strength: 0 }, null)).toBeNull();
    expect(environmentLighting({ ...w, environment: 'NONE' }, null)).toBeNull();
    expect(environmentLighting({ ...w, environment: 'SKY' }, null)).toBeNull();
  });

  it('lights metals with the glossy reflections of large area lamps (dark studio, #11 repro)', () => {
    // the clockwork-orrery setup: STUDIO at 0.07 behind a dark backdrop, disc area lamps
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({
      environment: 'STUDIO',
      environment_strength: 0.07,
      color: [0.012, 0.009, 0.007],
      environment_rotation: (200 * Math.PI) / 180,
    });
    doc.updateRender({ view_transform: 'STANDARD', exposure: -1.15 });
    const brass = doc.addMaterial({
      name: 'Brass',
      ...presetMaterialValues(getMaterialPreset('brass')!),
      roughness: 0.26,
    });
    const wood = doc.addMaterial({ name: 'Wood', base_color: [0.15, 0.07, 0.03, 1], roughness: 0.5 });
    const marble = doc.addMaterial({ name: 'Marble', base_color: [0.02, 0.02, 0.02, 1], roughness: 0.3 });
    doc.addObject({
      type: 'MESH',
      name: 'Table',
      data: doc.addMesh('Table', createPlane({ size: 6 })),
      location: [0, 0, -0.01],
      material_slots: [wood],
    });
    doc.addObject({
      type: 'MESH',
      name: 'Plinth',
      data: doc.addMesh('Plinth', createCube({ size: 1 })),
      location: [0, 0, 0.06],
      scale: [0.7, 0.7, 0.12],
      material_slots: [marble],
    });
    const focus: Vec3 = [0, -0.03, 0.335];
    doc.addObject({
      type: 'MESH',
      name: 'Gear',
      data: doc.addMesh('Gear', createCylinder({ vertices: 48, radius: 0.22, depth: 0.03 })),
      location: focus,
      rotation_euler: [1.4, 0, 0.3],
      material_slots: [brass],
    });
    for (const [loc, energy, color, size] of [
      [[-1.25, -1.35, 1.65], 260, [1, 0.8, 0.6], 0.9],
      [[1.7, -0.75, 0.8], 70, [0.78, 0.86, 1], 1.4],
      [[0.55, 1.65, 1.35], 240, [1, 0.72, 0.45], 0.7],
      [[0.0, 0.2, 2.2], 60, [1, 0.92, 0.82], 1.2],
    ] as [Vec3, number, Vec3, number][])
      doc.addObject({
        type: 'LIGHT',
        name: 'Lamp',
        data: doc.addLight({ type: 'AREA', energy, color, size, shape: 'DISK' }),
        location: loc,
        rotation_euler: aim(loc, focus),
      });
    const camLoc: Vec3 = [1.3, -2.47, 1.24];
    doc.updateScene({
      camera: doc.addObject({
        type: 'CAMERA',
        name: 'Cam',
        data: doc.addCamera({ name: 'Cam', lens: 50 }),
        location: camLoc,
        rotation_euler: aim(camLoc, focus),
      }),
    });
    const w = 160;
    const h = 90;
    const gear: Box = [75, 40, 85, 50];
    const raster = renderSceneSoftware(doc, { width: w, height: h, engine: 'RASTER', samples: 2 });
    const pt = renderSceneSoftware(doc, { width: w, height: h, engine: 'PATHTRACER', samples: 32, denoise: true });
    const r = lum(boxMean(raster, ...gear));
    const p = lum(boxMean(pt, ...gear));
    // before the fix the gear was a black silhouette (≈ 12 sRGB levels) while the path tracer
    // shows lit brass (≈ 70)
    expect(p).toBeGreaterThan(45);
    expect(r).toBeGreaterThan(p * 0.65);
    expect(r).toBeLessThan(p * 1.5);
  }, 60_000);

  it('reflects the lit scene around (reflection probe): a chrome ball mirrors a bright floor', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
    const glow = doc.addMaterial({
      name: 'Glow',
      base_color: [0, 0, 0, 1],
      emission_color: [0.2, 0.8, 0.3],
      emission_strength: 2,
    });
    doc.addObject({
      type: 'MESH',
      name: 'Floor',
      data: doc.addMesh('Floor', createPlane({ size: 20 })),
      material_slots: [glow],
    });
    const chrome = doc.addMaterial({ name: 'Chrome', base_color: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.1 });
    const ball = createUVSphere({ segments: 32, ring_count: 16, radius: 0.5 });
    ball.faceSmooth = ball.faceSmooth.map(() => true);
    doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', ball),
      location: [0, 0, 0.6],
      material_slots: [chrome],
    });
    doc.addObject({ type: 'LIGHT', name: 'Off', data: doc.addLight({ type: 'SUN', energy: 0 }) });
    const camLoc: Vec3 = [0, -3, 0.6];
    doc.updateScene({
      camera: doc.addObject({
        type: 'CAMERA',
        name: 'Cam',
        data: doc.addCamera({ name: 'Cam', lens: 50 }),
        location: camLoc,
        rotation_euler: aim(camLoc, [0, 0, 0.6]),
      }),
    });
    const img = renderSceneSoftware(doc, { width: 64, height: 64, samples: 1 });
    // the lower half of the ball mirrors the glowing green floor, the upper half the black world
    const lower = boxMean(img, 29, 36, 35, 40);
    const upper = boxMean(img, 29, 24, 35, 28);
    expect(lower[1]).toBeGreaterThan(100);
    expect(lower[1]).toBeGreaterThan(lower[0] * 1.5);
    expect(lum(upper)).toBeLessThan(20);
  });
});
