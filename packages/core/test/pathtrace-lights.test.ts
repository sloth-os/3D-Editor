import { describe, expect, it } from 'vitest';
import { SceneDoc, createPlane, createUVSphere, renderSceneSoftware, type MaterialData } from '../src';
import { at, mean, topCamera, traceLinear } from './pathtrace-helpers';

/*
 * Physical sanity of the path tracer: white furnace, emission, and Blender light units for every
 * lamp type (cross-checked with analytic irradiance and the rasterizer).
 */

/** Pure Lambertian material (IOR 1 → no specular layer). */
function lambert(doc: SceneDoc, albedo = 0.8, extra: Partial<MaterialData> = {}): string {
  return doc.addMaterial({ base_color: [albedo, albedo, albedo, 1], roughness: 1, ior: 1, ...extra });
}

/** Black world, a large Lambertian floor at z = 0 and an orthographic camera looking down. */
function floorScene(albedo = 0.8, view = 0.05): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 40 })),
    material_slots: [lambert(doc, albedo)],
  });
  topCamera(doc, view, 20);
  return doc;
}

const centre = (doc: SceneDoc, samples = 64) => {
  const { img } = traceLinear(doc, { width: 8, height: 8, samples, maxBounces: 1 });
  return mean(img, 8, 2, 2, 6, 6)[0];
};

describe('path tracer: white furnace and emission', () => {
  it('a white diffuse sphere disappears in a uniform environment', () => {
    for (const material of [
      { base_color: [1, 1, 1, 1] },
      { base_color: [1, 1, 1, 1], metallic: 1, roughness: 0.3 },
    ]) {
      const doc = SceneDoc.create({ empty: true });
      doc.updateWorld({ environment: 'NONE', color: [0.5, 0.5, 0.5], strength: 1 });
      const sphere = createUVSphere({ segments: 48, ring_count: 24 });
      sphere.faceSmooth = sphere.faceSmooth.map(() => true);
      doc.addObject({
        type: 'MESH',
        name: 'Ball',
        data: doc.addMesh('Ball', sphere),
        material_slots: [doc.addMaterial(material as Partial<MaterialData>)],
      });
      const { img } = traceLinear(doc, {
        width: 16,
        height: 16,
        samples: 128,
        maxBounces: 8,
        view: { position: [0, -5, 0], target: [0, 0, 0], fovY: 0.5 },
      });
      const c = mean(img, 16, 5, 5, 11, 11);
      expect(c[0]).toBeGreaterThan(0.48);
      expect(c[0]).toBeLessThan(0.515);
      expect(c[3]).toBe(1);
      expect(at(img, 16, 0, 0)[0]).toBeCloseTo(0.5, 6);
    }
  }, 30_000);

  it('a closed glass sphere conserves the environment radiance', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0.5, 0.5, 0.5], strength: 1 });
    const sphere = createUVSphere({ segments: 48, ring_count: 24 });
    sphere.faceSmooth = sphere.faceSmooth.map(() => true);
    const glass = doc.addMaterial({ base_color: [1, 1, 1, 1], transmission: 1, roughness: 0.1, ior: 1.45 });
    doc.addObject({
      type: 'MESH',
      name: 'Glass',
      data: doc.addMesh('Glass', sphere),
      material_slots: [glass],
    });
    const { img } = traceLinear(doc, {
      width: 16,
      height: 16,
      samples: 128,
      maxBounces: 4,
      view: { position: [0, -5, 0], target: [0, 0, 0], fovY: 0.5 },
    });
    const c = mean(img, 16, 5, 5, 11, 11);
    expect(c[0]).toBeGreaterThan(0.47);
    expect(c[0]).toBeLessThan(0.53);
  }, 30_000);

  it('emissive surfaces show their emission colour × strength as radiance', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
    const m = doc.addMaterial({
      base_color: [0, 0, 0, 1],
      emission_color: [1, 0.5, 0.25],
      emission_strength: 3,
    });
    doc.addObject({
      type: 'MESH',
      name: 'Panel',
      data: doc.addMesh('Panel', createPlane({ size: 4 })),
      material_slots: [m],
    });
    topCamera(doc, 2, 5);
    const { img } = traceLinear(doc, { width: 4, height: 4, samples: 4 });
    const p = at(img, 4, 1, 1);
    expect(p[0]).toBeCloseTo(3, 4);
    expect(p[1]).toBeCloseTo(1.5, 4);
    expect(p[2]).toBeCloseTo(0.75, 4);
    expect(p[3]).toBe(1);
  });
});

describe('path tracer: Blender light units', () => {
  it('point lights: radiance = albedo/π · P/(4π d²), inverse-square falloff, radius does not change it', () => {
    const doc = floorScene();
    const light = doc.addLight({ type: 'POINT', energy: 1000, shadow_soft_size: 0 });
    const obj = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: light, location: [0, 0, 5] });
    const expected = (d: number) => (0.8 / Math.PI) * (1000 / (4 * Math.PI * d * d));
    const rel = (v: number, e: number) => Math.abs(v - e) / e;
    expect(rel(centre(doc, 8), expected(5))).toBeLessThan(0.005);
    doc.updateObject(obj, { location: [0, 0, 10] });
    expect(rel(centre(doc, 8), expected(10))).toBeLessThan(0.005);
    doc.updateLight(light, { shadow_soft_size: 0.5 });
    const soft = centre(doc, 64);
    expect(Math.abs(soft - expected(10)) / expected(10)).toBeLessThan(0.02);
    doc.updateLight(light, { color: [1, 0, 0] });
    const { img } = traceLinear(doc, { width: 4, height: 4, samples: 16, maxBounces: 1 });
    expect(at(img, 4, 2, 2)[1]).toBe(0);
  });

  it('agrees with the rasterizer on the brightness of a lamp-lit diffuse surface', () => {
    const doc = floorScene();
    doc.addObject({
      type: 'LIGHT',
      name: 'Lamp',
      data: doc.addLight({ type: 'POINT', energy: 600 }),
      location: [0, 0, 4],
    });
    const raster = renderSceneSoftware(doc, { width: 8, height: 8, samples: 1 });
    const pt = renderSceneSoftware(doc, {
      width: 8,
      height: 8,
      engine: 'PATHTRACER',
      samples: 32,
      denoise: false,
    });
    const o = (4 * 8 + 4) * 4;
    expect(Math.abs(pt.data[o] - raster.data[o])).toBeLessThanOrEqual(6);
  });

  it('sun lamps deliver their strength as irradiance (W/m²) times the cosine', () => {
    const doc = floorScene();
    const sun = doc.addLight({ type: 'SUN', energy: 2 });
    const obj = doc.addObject({ type: 'LIGHT', name: 'Sun', data: sun, location: [0, 0, 5] });
    expect(centre(doc, 16)).toBeCloseTo((0.8 / Math.PI) * 2, 3);
    doc.updateObject(obj, { rotation_euler: [Math.PI / 3, 0, 0] });
    expect(centre(doc, 16)).toBeCloseTo((0.8 / Math.PI) * 2 * 0.5, 3);
    // below the horizon: nothing
    doc.updateObject(obj, { rotation_euler: [Math.PI * 0.75, 0, 0] });
    expect(centre(doc, 4)).toBe(0);
  });

  it('spot lights: point light intensity inside the cone, dark outside, smooth blend', () => {
    const doc = floorScene();
    const spot = doc.addLight({
      type: 'SPOT',
      energy: 1000,
      spot_size: Math.PI / 6,
      spot_blend: 0,
      shadow_soft_size: 0,
    });
    doc.addObject({ type: 'LIGHT', name: 'Spot', data: spot, location: [0, 0, 5] });
    // camera covering 8 m: the cone (half angle 15°) lights a disc of radius 1.34 m
    const cam = doc.findObjectByName('Top')!;
    doc.updateCamera(cam.data!, { ortho_scale: 8 });
    const { img } = traceLinear(doc, { width: 16, height: 16, samples: 16, maxBounces: 1 });
    // pixel (8, 8) looks at (0.25, −0.25): E = I · h / d³
    const d = Math.hypot(0.25, 0.25, 5);
    const inside = at(img, 16, 8, 8)[0];
    expect(Math.abs(inside / (((0.8 / Math.PI) * ((1000 / (4 * Math.PI)) * 5)) / d ** 3) - 1)).toBeLessThan(
      0.01,
    );
    expect(at(img, 16, 1, 1)[0]).toBe(0);
    expect(at(img, 16, 8, 1)[0]).toBe(0);
  });

  it('area lights: one-sided Lambertian emitters with radiance P/(πA) for every shape', () => {
    for (const shape of ['SQUARE', 'RECTANGLE', 'DISK', 'ELLIPSE'] as const) {
      const doc = floorScene();
      const area = doc.addLight({ type: 'AREA', energy: 100, size: 0.2, size_y: 0.1, shape });
      const obj = doc.addObject({ type: 'LIGHT', name: 'Area', data: area, location: [0, 0, 3] });
      // small light far away: E ≈ P / (π d²)
      const v = centre(doc, 32);
      const expected = (0.8 / Math.PI) * (100 / (Math.PI * 9));
      expect(Math.abs(v - expected) / expected, shape).toBeLessThan(0.01);
      // facing away (rotated half a turn): the floor gets nothing
      doc.updateObject(obj, { rotation_euler: [Math.PI, 0, 0] });
      expect(centre(doc, 4), shape).toBe(0);
    }
  }, 20_000);

  it('a large area light close to the floor gives the analytic irradiance (soft light, MIS)', () => {
    const doc = floorScene();
    // 2 m × 2 m square, 1 m above the centre: E = L · F with the form factor of a square
    doc.addObject({
      type: 'LIGHT',
      name: 'Box',
      data: doc.addLight({ type: 'AREA', energy: 40, size: 2, shape: 'SQUARE' }),
      location: [0, 0, 1],
    });
    const L = 40 / (Math.PI * 4);
    // irradiance below the centre of a rectangle (sum of four corner rectangles a = b = 1, h = 1)
    const corner = (a: number, b: number, h: number) => {
      const x = a / h;
      const y = b / h;
      return (
        (1 / (2 * Math.PI)) *
        ((x / Math.sqrt(1 + x * x)) * Math.atan(y / Math.sqrt(1 + x * x)) +
          (y / Math.sqrt(1 + y * y)) * Math.atan(x / Math.sqrt(1 + y * y)))
      );
    };
    const E = Math.PI * L * 4 * corner(1, 1, 1);
    const expected = (0.8 / Math.PI) * E;
    expect(Math.abs(centre(doc, 256) - expected) / expected).toBeLessThan(0.02);
    // direct light stays complete when no bounce is allowed: the BSDF half of the MIS still
    // traces the ray that ends the path
    const { img } = traceLinear(doc, { width: 8, height: 8, samples: 256, maxBounces: 0 });
    expect(Math.abs(mean(img, 8, 2, 2, 6, 6)[0] - expected) / expected).toBeLessThan(0.02);
  }, 20_000);

  it('is linear in the lights: several lights render as the sum of each one alone (selection + MIS)', () => {
    const build = (which: string[]) => {
      const doc = floorScene(0.8, 3);
      doc.updateWorld({ environment: which.includes('env') ? 'STUDIO' : 'NONE', color: [0, 0, 0] });
      const ball = createUVSphere({ segments: 24, ring_count: 12, radius: 0.5 });
      ball.faceSmooth = ball.faceSmooth.map(() => true);
      doc.addObject({
        type: 'MESH',
        name: 'Ball',
        data: doc.addMesh('Ball', ball),
        location: [0.3, 0.2, 0.5],
        material_slots: [doc.addMaterial({ base_color: [0.6, 0.3, 0.2, 1], roughness: 0.3 })],
      });
      if (which.includes('area'))
        doc.addObject({
          type: 'LIGHT',
          name: 'Area',
          data: doc.addLight({ type: 'AREA', energy: 60, size: 1.5 }),
          location: [-1, 0, 2],
          rotation_euler: [0, -0.4, 0],
        });
      if (which.includes('point'))
        doc.addObject({
          type: 'LIGHT',
          name: 'Point',
          data: doc.addLight({ type: 'POINT', energy: 300, shadow_soft_size: 0.3, color: [1, 0.8, 0.6] }),
          location: [2, -1, 2.5],
        });
      if (which.includes('panel'))
        doc.addObject({
          type: 'MESH',
          name: 'Panel',
          data: doc.addMesh('Panel', createPlane({ size: 0.6 })),
          location: [0, 2, 1.5],
          rotation_euler: [1, 0, 0],
          material_slots: [doc.addMaterial({ base_color: [0, 0, 0, 1], emission_color: [0.5, 0.7, 1], emission_strength: 15 })],
        });
      const { img } = traceLinear(doc, { width: 8, height: 8, samples: 512, maxBounces: 2 });
      return mean(img, 8, 0, 0, 8, 8);
    };
    const parts = ['area', 'point', 'panel', 'env'].map((l) => build([l]));
    const all = build(['area', 'point', 'panel', 'env']);
    for (let c = 0; c < 3; c++) {
      const sum = parts.reduce((a, p) => a + p[c], 0);
      expect(Math.abs(all[c] - sum) / sum, `channel ${c}`).toBeLessThan(0.02);
    }
  }, 60_000);

  it('emissive meshes light other surfaces (light sampling of emissive triangles)', () => {
    const doc = floorScene(0.8, 1);
    const emit = doc.addMaterial({
      base_color: [0, 0, 0, 1],
      emission_color: [1, 1, 1],
      emission_strength: 10,
    });
    // small emissive quad 2 m above and 1.5 m beside the viewed floor patch (out of view)
    doc.addObject({
      type: 'MESH',
      name: 'Panel',
      data: doc.addMesh('Panel', createPlane({ size: 0.2 })),
      location: [1.5, 0, 2],
      material_slots: [emit],
    });
    // E ≈ L · A · cosθ_floor · cosθ_panel / d² with d = 2.5, both cosines 0.8
    const expected = (0.8 / Math.PI) * ((10 * 0.04 * 0.64) / 6.25);
    const { img } = traceLinear(doc, { width: 8, height: 8, samples: 256, maxBounces: 1 });
    const v = mean(img, 8, 3, 3, 5, 5)[0];
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.05);
  }, 20_000);
});
