import { describe, expect, it } from 'vitest';
import { SceneDoc, createCube, createPlane, createUVSphere, type MaterialData } from '../src';
import { PrincipledBSDF, fresnelDielectric, thinTransmittance, type BSDFInputs } from '../src/render/pathtrace';
import { mean, topCamera, traceLinear } from './pathtrace-helpers';

/*
 * Light through glass in the path tracer (lighthouse-cove v2: "Index-matched (IOR 1) and
 * refractive glass is opaque to light"). Shadow rays stopped at every transmissive surface, so a
 * lamp inside a glass lantern or bulb lit nothing outside it and an invisible IOR-1 surface cast a
 * full shadow. Shadow rays now pass glass thin-walled (attenuated by transmission × base colour and
 * the Fresnel reflection), and the BSDF-sampled half of the MIS treats the glass the same way, so
 * no light is counted twice.
 */

/** Lambertian floor (IOR 1: no specular layer) in a black world. */
function floorScene(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 40 })),
    material_slots: [doc.addMaterial({ base_color: [0.8, 0.8, 0.8, 1], roughness: 1, ior: 1 })],
  });
  return doc;
}

function glass(extra: Partial<MaterialData> = {}): Partial<MaterialData> {
  return { base_color: [1, 1, 1, 1], transmission: 1, roughness: 0, ior: 1.5, ...extra };
}

/** Mean linear rgb of the middle of an 8×8 render (camera from `topCamera`). */
function centre(doc: SceneDoc, samples: number, maxBounces = 1): number[] {
  const { img } = traceLinear(doc, { width: 8, height: 8, samples, maxBounces });
  return mean(img, 8, 2, 2, 6, 6);
}

/** A point lamp at (0, 0, 2) inside an optional glass ball of radius 0.5 around it. */
function lampInBall(material: Partial<MaterialData> | null, roughness = 0): SceneDoc {
  const doc = floorScene();
  doc.addObject({
    type: 'LIGHT',
    name: 'Bulb',
    data: doc.addLight({ type: 'POINT', energy: 1000, shadow_soft_size: 0.1 }),
    location: [0, 0, 2],
  });
  if (material) {
    const ball = createUVSphere({ segments: 32, ring_count: 16, radius: 0.5 });
    ball.faceSmooth = ball.faceSmooth.map(() => true);
    doc.addObject({
      type: 'MESH',
      name: 'Glass',
      data: doc.addMesh('Glass', ball),
      location: [0, 0, 2],
      material_slots: [doc.addMaterial({ ...material, roughness })],
    });
  }
  // the camera looks down at the floor from below the ball
  topCamera(doc, 0.1, 0.5);
  return doc;
}

describe('path tracer: light through glass (lighthouse-cove v2)', () => {
  it('a lamp inside a closed glass ball lights the floor (thin-walled shadow rays)', () => {
    const open = centre(lampInBall(null), 64)[0];
    // E = P / (4π d²) on the floor 2 m below
    const E = (0.8 / Math.PI) * (1000 / (4 * Math.PI * 4));
    expect(Math.abs(open / E - 1)).toBeLessThan(0.01);
    // straight down through the bottom of the ball: one wall at normal incidence
    const T = 1 - fresnelDielectric(1, 1.5);
    const through = centre(lampInBall(glass()), 64)[0];
    expect(through / open).toBeGreaterThan(T - 0.02);
    expect(through / open).toBeLessThan(T + 0.02);
    // index-matched: no reflection at all, the ball is invisible to the light
    expect(centre(lampInBall(glass({ ior: 1 })), 64)[0] / open).toBeCloseTo(1, 2);
    // frosted glass passes the same direct light (thin-walled), and gains none through
    // total internal reflection or caustics found by the floor's indirect rays
    const frosted = centre(lampInBall(glass(), 0.4), 256, 4)[0];
    const clear = centre(lampInBall(glass()), 256, 4)[0];
    expect(Math.abs(frosted / clear - 1)).toBeLessThan(0.04);
  }, 30_000);

  it('coloured glass tints the light it lets through by its base colour', () => {
    const open = centre(lampInBall(null), 16);
    const red = centre(lampInBall(glass({ base_color: [1, 0.25, 0.25, 1], ior: 1 })), 16);
    expect(red[0] / open[0]).toBeCloseTo(1, 2);
    expect(red[1] / open[1]).toBeCloseTo(0.25, 2);
    // metallic surfaces never transmit, whatever their transmission
    const metal = centre(lampInBall(glass({ metallic: 1, ior: 1 })), 16);
    expect(metal[0]).toBe(0);
  });

  it('an index-matched (IOR 1) pane casts almost no shadow, a glass pane a light one', () => {
    const doc = floorScene();
    // sun from +X at 45°: the pane's shadow falls on the viewed patch at the origin
    doc.addObject({
      type: 'LIGHT',
      name: 'Sun',
      data: doc.addLight({ type: 'SUN', energy: 2 }),
      rotation_euler: [0, Math.PI / 4, 0],
    });
    topCamera(doc, 0.1, 5);
    const lit = () => centre(doc, 8)[0];
    const full = lit();
    const mat = doc.addMaterial(glass({ ior: 1 }));
    doc.addObject({
      type: 'MESH',
      name: 'Pane',
      data: doc.addMesh('Pane', createPlane({ size: 1 })),
      location: [1, 0, 1],
      material_slots: [mat],
    });
    expect(lit() / full).toBeGreaterThan(0.995);
    // a glass slab (two walls at 45°) passes (1 − F)² of the light
    doc.updateMaterial(mat, { ior: 1.5 });
    const F = fresnelDielectric(Math.SQRT1_2, 1.5);
    expect(lit() / full).toBeCloseTo(1 - F, 2);
    const slab = doc.addObject({
      type: 'MESH',
      name: 'Slab',
      data: doc.addMesh('Slab', createCube({ size: 1 })),
      location: [1, 0, 1],
      scale: [1, 1, 0.05],
      material_slots: [mat],
    });
    doc.removeObject(doc.findObjectByName('Pane')!.id);
    expect(lit() / full).toBeCloseTo((1 - F) ** 2, 2);
    // an opaque material still casts a full shadow
    doc.updateMaterial(mat, { transmission: 0 });
    expect(lit()).toBe(0);
    void slab;
  });

  it('light through glass is not counted twice: an area light behind tinted glass keeps the tint ratio', () => {
    // the floor's light samples pass the glass (thin-walled) and its BSDF-sampled rays pass it as
    // well and are weighed against them (MIS): together exactly the transmitted light
    for (const roughness of [0, 0.5]) {
      const build = (pane: boolean) => {
        const doc = floorScene();
        topCamera(doc, 0.05, 0.25);
        doc.addObject({
          type: 'LIGHT',
          name: 'Box',
          data: doc.addLight({ type: 'AREA', energy: 40, size: 2, shape: 'SQUARE' }),
          location: [0, 0, 1],
        });
        if (pane)
          doc.addObject({
            type: 'MESH',
            name: 'Pane',
            data: doc.addMesh('Pane', createPlane({ size: 6 })),
            location: [0, 0, 0.9],
            material_slots: [doc.addMaterial(glass({ base_color: [0.5, 0.5, 0.5, 1], ior: 1, roughness }))],
          });
        const { img } = traceLinear(doc, { width: 8, height: 8, samples: 512, maxBounces: 0 });
        return mean(img, 8, 2, 2, 6, 6)[0];
      };
      const ratio = build(true) / build(false);
      expect(Math.abs(ratio - 0.5), `roughness ${roughness}`).toBeLessThan(0.015);
    }
  }, 30_000);

  it('thin-walled transmittance matches the BSDF transmission lobe it stands for', () => {
    const inputs: BSDFInputs = {
      baseR: 1,
      baseG: 0.5,
      baseB: 0.25,
      metallic: 0.2,
      roughness: 0,
      ior: 1.45,
      transmission: 0.9,
      coat: 0,
      coatRoughness: 0.03,
      sheen: 0,
      sheenR: 1,
      sheenG: 1,
      sheenB: 1,
    };
    const out = new Float64Array(3);
    for (const mu of [1, 0.7, 0.3]) {
      thinTransmittance(inputs, mu, true, out);
      const k = 0.8 * 0.9 * (1 - fresnelDielectric(mu, 1.45));
      expect(out[0]).toBeCloseTo(k, 9);
      expect(out[1]).toBeCloseTo(k * 0.5, 9);
      // a thin sheet reflects the same from both sides: no total internal reflection
      thinTransmittance(inputs, mu, false, out);
      expect(out[0]).toBeCloseTo(k, 9);
      // the thin-walled BSDF passes the same share straight through (smooth glass)
      const b = new PrincipledBSDF();
      b.setup(inputs, Math.sqrt(1 - mu * mu), 0, mu, false, 0, true);
      let t = 0;
      const n = 4000;
      for (let i = 0; i < n; i++)
        if (b.sample(0.5, 0.5, (i + 0.5) / n) && b.sampledDelta) t += b.fR / b.pdf;
      expect(t / n).toBeCloseTo(k, 2);
    }
    thinTransmittance({ ...inputs, transmission: 0 }, 1, true, out);
    expect([...out]).toEqual([0, 0, 0]);
  });
});
