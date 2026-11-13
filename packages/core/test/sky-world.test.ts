import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  createCube,
  createEditorState,
  createOperatorRegistry,
  createPlane,
  prepareSky,
  renderSceneSoftware,
  sampleSky,
  sampleSkyModel,
  skySun,
  sunDirection,
  type OperatorContext,
  type RenderedImage,
} from '../src';
import { linearToSrgb } from '../src/render/color';

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  };
  const um = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const run = (id: string, params?: unknown) => reg.run<Record<string, unknown>>(ctx, id, params);
  return { doc, reg, ctx, um, run };
}

const px = (img: RenderedImage, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];
const deg = (d: number) => (d * Math.PI) / 180;

describe('world.sky_set', () => {
  it('switches the world to the sky, shows it and reports the sun', () => {
    const { doc, run } = setup();
    expect(doc.getWorld().environment).toBe('STUDIO');
    const r = run('world.sky_set', { sun_elevation: deg(20), sun_rotation: deg(90), sun_intensity: 4 });
    expect(r.ok).toBe(true);
    const w = doc.getWorld();
    expect(w.environment).toBe('SKY');
    expect(w.show_environment_background).toBe(true);
    expect(w.sun_intensity).toBe(4);
    const dir = r.result!.sun_direction as number[];
    const expected = sunDirection(w);
    dir.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
    // rotation 90° turns the sun from +Y to −X (Blender's convention)
    expect(dir[0]).toBeLessThan(-0.9);
    expect((r.result!.sun_irradiance as number[]).every((v) => v > 0 && v < 4)).toBe(true);
  });

  it('applies presets before explicit values and keeps an explicit background choice', () => {
    const { doc, run } = setup();
    run('world.sky_set', { preset: 'SUNSET', sun_rotation: 1, show_background: false });
    let w = doc.getWorld();
    expect(w.sun_elevation).toBeCloseTo(deg(2), 9);
    expect(w.sun_rotation).toBe(1);
    expect(w.show_environment_background).toBe(false);
    run('world.sky_set', { sun_elevation: 0.3 });
    w = doc.getWorld();
    expect(w.show_environment_background).toBe(false);
    expect(w.sun_elevation).toBe(0.3);
    run('world.sky_set', { preset: 'NIGHT' });
    expect(doc.getWorld().sun_intensity).toBe(0);
  });

  it('can edit the sky without enabling it, validates input and undoes in one step', () => {
    const { doc, run, um } = setup();
    expect(run('world.sky_set', { zenith_color: [0.1, 0.2, 0.9], enable: false }).ok).toBe(true);
    expect(doc.getWorld().environment).toBe('STUDIO');
    expect(doc.getWorld().sky_zenith_color).toEqual([0.1, 0.2, 0.9]);
    expect(run('world.sky_set', { sun_elevation: 5 }).ok).toBe(false);
    expect(run('world.sky_set', { preset: 'MARS' }).ok).toBe(false);
    run('world.sky_set', { preset: 'OVERCAST', strength: 2 });
    expect(doc.getWorld().strength).toBe(2);
    um.undo();
    const w = doc.getWorld();
    expect(w.environment).toBe('STUDIO');
    expect(w.strength).toBe(1);
    expect(w.sky_zenith_color).toEqual([0.1, 0.2, 0.9]);
  });

  it('honours every accepted sun_size up to π/2 (Blender range)', () => {
    // regression: diameters above 1 rad used to be clamped silently to 1 rad
    const { doc, run } = setup();
    expect(run('world.sky_set', { sun_size: 1.5 }).ok).toBe(true);
    expect(skySun(doc.getWorld()).angularRadius).toBeCloseTo(0.75, 12);
    expect(run('world.sky_set', { sun_size: Math.PI / 2 }).ok).toBe(true);
    expect(skySun(doc.getWorld()).angularRadius).toBeCloseTo(Math.PI / 4, 12);
    expect(run('world.sky_set', { sun_size: 2 }).ok).toBe(false);
    // even a 90° disc delivers exactly its irradiance: ∫disc L dω = sun_intensity × extinction
    // (the limb-darkening normalisation accounts for the curvature of large caps)
    for (const size of [0.5, 1.5, Math.PI / 2]) {
      run('world.sky_set', { sun_size: size, sun_elevation: 0.9 });
      const w = doc.getWorld();
      const sun = skySun(w);
      const m = prepareSky(w);
      const d = sun.direction;
      const u = normalize(cross(d, [0, 0, 1]));
      const v = cross(d, u);
      const withSun = new Float64Array(3);
      const sky = new Float64Array(3);
      const n = 300;
      let e = 0;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const theta = ((i + 0.5) / n) * m.sunRadius;
          const phi = ((j + 0.5) / n) * 2 * Math.PI;
          const s = Math.sin(theta);
          const c = Math.cos(theta);
          const dir = [0, 1, 2].map((k) => d[k] * c + (u[k] * Math.cos(phi) + v[k] * Math.sin(phi)) * s);
          sampleSkyModel(m, dir[0], dir[1], dir[2], true, withSun);
          sampleSkyModel(m, dir[0], dir[1], dir[2], false, sky);
          e += (withSun[1] - sky[1]) * s * (m.sunRadius / n) * ((2 * Math.PI) / n);
        }
      expect(Math.abs(e / sun.irradiance[1] - 1), `sun_size ${size}`).toBeLessThan(2e-3);
    }
  });
});

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

describe('world.mist_set', () => {
  it('sets density directly or from a 95 % distance, and the colour', () => {
    const { doc, run, um } = setup();
    const r = run('world.mist_set', { density: 0.05, color: [0.5, 0.6, 0.7] });
    expect(r.ok).toBe(true);
    expect(doc.getWorld().mist_density).toBe(0.05);
    expect(doc.getWorld().mist_color).toEqual([0.5, 0.6, 0.7]);
    expect(r.result!.distance_95 as number).toBeCloseTo(Math.sqrt(Math.log(20)) / 0.05, 9);
    expect(run('world.mist_set', { distance: 100 }).ok).toBe(true);
    const d = doc.getWorld().mist_density;
    expect(1 - Math.exp(-((d * 100) ** 2))).toBeCloseTo(0.95, 9);
    expect(run('world.mist_set', { density: 0.1, distance: 10 }).ok).toBe(false);
    expect(run('world.mist_set', { density: -1 }).ok).toBe(false);
    um.undo();
    expect(doc.getWorld().mist_density).toBe(0.05);
    run('world.mist_set', { density: 0 });
    expect(run('world.mist_set', {}).result!.distance_95).toBe(null);
  });
});

describe('CPU renderer: sky and mist', () => {
  it('draws the procedural sky as background along each camera ray', () => {
    const { doc, run } = setup();
    // sun ahead of the camera (+Y), above the field of view
    run('world.sky_set', { sun_elevation: deg(40), sun_rotation: 0 });
    // compared with linearToSrgb: the Standard view transform
    doc.updateRender({ view_transform: 'STANDARD' });
    const fovY = 0.8;
    const img = renderSceneSoftware(doc, {
      width: 64,
      height: 64,
      samples: 1,
      view: { position: [0, 0, 0], target: [0, 10, 0], fovY },
    });
    const w = doc.getWorld();
    for (const y of [0, 20, 40, 63]) {
      const ny = 1 - ((y + 0.5) / 64) * 2;
      const el = Math.atan(ny * Math.tan(fovY / 2));
      const nx = (0.5 / 64) * 2; // centre column x = 32 → +½ pixel
      const dir = [Math.tan(fovY / 2) * nx, Math.cos(el), Math.sin(el)] as [number, number, number];
      const c = sampleSky(w, dir, { sun: false });
      const p = px(img, 32, y);
      for (let k = 0; k < 3; k++)
        expect(Math.abs(p[k] - Math.round(linearToSrgb(c[k]) * 255))).toBeLessThanOrEqual(2);
    }
    // without show_environment_background the flat world colour is used
    doc.updateWorld({ show_environment_background: false });
    const flat = renderSceneSoftware(doc, {
      width: 8,
      height: 8,
      samples: 1,
      view: { position: [0, 0, 0], target: [0, 10, 0] },
    });
    expect(px(flat, 0, 0)).toEqual(px(flat, 7, 7));
  });

  it('lights the scene with the sky and its sun (no studio rig)', () => {
    const { doc, run } = setup();
    const plane = doc.addMesh('Plane', createPlane({ size: 4 }));
    const mat = doc.addMaterial({ name: 'White', base_color: [0.8, 0.8, 0.8, 1], roughness: 0.9 });
    doc.addObject({ type: 'MESH', name: 'Plane', data: plane, material_slots: [mat] });
    const view = {
      position: [0, -6, 6] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    };
    const lum = (img: RenderedImage) =>
      px(img, 16, 16)
        .slice(0, 3)
        .reduce((a, b) => a + b, 0);
    run('world.sky_set', { sun_elevation: deg(60), show_background: false });
    const day = renderSceneSoftware(doc, { width: 32, height: 32, samples: 1, view });
    run('world.sky_set', { sun_elevation: deg(-20) });
    const night = renderSceneSoftware(doc, { width: 32, height: 32, samples: 1, view });
    run('world.sky_set', { sun_elevation: deg(60), sun_intensity: 0 });
    const skyOnly = renderSceneSoftware(doc, { width: 32, height: 32, samples: 1, view });
    expect(lum(day)).toBeGreaterThan(lum(skyOnly) + 30);
    expect(lum(skyOnly)).toBeGreaterThan(lum(night) + 30);
    // the sky tints a white surface blue-ish when the sun is off
    const s = px(skyOnly, 16, 16);
    expect(s[2]).toBeGreaterThan(s[0]);
  });

  it('fogs distant surfaces towards the mist colour but not the background', () => {
    const { doc, run } = setup();
    const cube = doc.addMesh('Cube', createCube({ size: 2 }));
    const mat = doc.addMaterial({
      name: 'Red',
      base_color: [0.8, 0.05, 0.05, 1],
      emission_color: [1, 0, 0],
      emission_strength: 0.5,
    });
    doc.addObject({ type: 'MESH', name: 'Far', data: cube, material_slots: [mat], location: [0, 40, 0] });
    const view = {
      position: [0, 0, 0] as [number, number, number],
      target: [0, 40, 0] as [number, number, number],
      fovY: 0.3,
    };
    const clear = renderSceneSoftware(doc, { width: 32, height: 32, samples: 1, view });
    run('world.mist_set', { distance: 40, color: [0.2, 0.9, 0.2] });
    const misty = renderSceneSoftware(doc, { width: 32, height: 32, samples: 1, view });
    const c0 = px(clear, 16, 16);
    const c1 = px(misty, 16, 16);
    expect(c1[1]).toBeGreaterThan(c0[1] + 100);
    expect(c1[0]).toBeLessThan(c0[0]);
    expect(px(misty, 0, 0)).toEqual(px(clear, 0, 0));
    // SOLID shading ignores mist
    const solid = renderSceneSoftware(doc, { width: 32, height: 32, samples: 1, view, shading: 'SOLID' });
    expect(solid.data[(16 * 32 + 16) * 4 + 1]).toBeLessThan(c1[1]);
  });
});
