import { describe, expect, it } from 'vitest';
import { SceneDoc, createMesh, createPlane, type MaterialData } from '../src';
import { SceneEvaluator } from '../src/eval/evaluate';
import { renderItems } from '../src/eval/renderables';
import { evaluatedBounds } from '../src/io/common';
import { resolveView, TextureCache } from '../src/render';
import { preparePathTrace, viewCameraData } from '../src/render/pathtrace';
import { at, mean, topCamera, traceLinear } from './pathtrace-helpers';

/*
 * Path tracer fixes from the example projects (phase 3 v2):
 * - faint alpha-blended (BLEND) emitters rendered as sparse speckles: the camera now shades BLEND
 *   surfaces with deterministic coverage (lighthouse-cove);
 * - world mist was taken from the first surface a camera ray hit, so whatever was seen through
 *   glass lost its mist (lighthouse-cove);
 * - the "N degenerate triangle(s) skipped" warning did not say which objects (clockwork-orrery).
 */

function blackWorld(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  return doc;
}

function plane(doc: SceneDoc, name: string, size: number, material: Partial<MaterialData>, z: number): string {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, createPlane({ size })),
    location: [0, 0, z],
    material_slots: [doc.addMaterial({ name, ...material })],
  });
}

/** Black emitter (IOR 1: no specular reflection). */
const glow = (rgb: [number, number, number], extra: Partial<MaterialData> = {}): Partial<MaterialData> => ({
  base_color: [0, 0, 0, 1],
  ior: 1,
  roughness: 1,
  emission_color: rgb,
  emission_strength: 1,
  ...extra,
});

/** Mean and standard deviation of the red channel over a whole linear film. */
function stats(img: Float32Array, w: number, h: number): { mean: number; sd: number } {
  const v: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v.push(at(img, w, x, y)[0]);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) };
}

describe('path tracer: alpha-blended emitters seen by the camera (lighthouse-cove v2)', () => {
  it('shades a faint BLEND glow with its coverage instead of speckles', () => {
    const doc = blackWorld();
    // a faint glow (alpha 0.05): 0.05 × its emission in every pixel, at one sample per pixel
    // (it was the full emission in 5 % of the samples)
    const shaft = plane(doc, 'Shaft', 20, glow([1, 0.8, 0.5], { alpha: 0.05, blend_method: 'BLEND' }), 1);
    topCamera(doc, 2, 5);
    const one = stats(traceLinear(doc, { width: 16, height: 16, samples: 1 }).img, 16, 16);
    expect(one.mean).toBeCloseTo(0.05, 6);
    expect(one.sd).toBeLessThan(1e-6);
    // with specular reflection (IOR 1.5) and in front of a grey emissive backdrop: the expected
    // 0.05 × 1 + 0.95 × 0.2 on average
    plane(doc, 'Backdrop', 20, glow([0.2, 0.2, 0.2]), 0);
    doc.updateMaterial(doc.getObject(shaft)!.material_slots[0]!, { ior: 1.5 });
    const avg = stats(traceLinear(doc, { width: 16, height: 16, samples: 64 }).img, 16, 16);
    expect(avg.mean).toBeCloseTo(0.05 + 0.95 * 0.2, 2);
  });

  it('weighs the direct light of a BLEND surface by its coverage, keeping the expected brightness', () => {
    const doc = blackWorld();
    // a lit white veil (alpha 0.3) over a black floor; the sun lights both
    plane(doc, 'Floor', 20, { base_color: [0, 0, 0, 1], roughness: 1, ior: 1 }, 0);
    plane(doc, 'Veil', 20, { base_color: [1, 1, 1, 0.3], roughness: 1, ior: 1, blend_method: 'BLEND' }, 1);
    doc.addObject({ type: 'LIGHT', name: 'Sun', data: doc.addLight({ type: 'SUN', energy: 2 }) });
    topCamera(doc, 2, 5);
    const { img } = traceLinear(doc, { width: 16, height: 16, samples: 4, maxBounces: 0 });
    const s = stats(img, 16, 16);
    const expected = 0.3 * (1 / Math.PI) * 2;
    expect(s.mean).toBeCloseTo(expected, 3);
    // the alpha of what the camera sees stays the coverage (film transparent)
    doc.updateRender({ film_transparent: true });
    doc.removeObject(doc.findObjectByName('Floor')!.id);
    const film = traceLinear(doc, { width: 16, height: 16, samples: 64, maxBounces: 0 }).img;
    expect(mean(film, 16, 0, 0, 16, 16)[3]).toBeCloseTo(0.3, 1);
  });
});

describe('path tracer: mist through glass (lighthouse-cove v2)', () => {
  /** An emissive wall 150 m away in red mist, seen through two panes 5 m in front of the camera. */
  function mistScene(paneDistance = 5): SceneDoc {
    const doc = blackWorld();
    doc.updateWorld({ color: [0.02, 0.02, 0.05], mist_density: 0.01, mist_color: [0.8, 0.1, 0.1] });
    const wall = (name: string, size: number, x: number, y: number, m: Partial<MaterialData>) =>
      doc.addObject({
        type: 'MESH',
        name,
        data: doc.addMesh(name, createPlane({ size })),
        location: [x, y, 0],
        rotation_euler: [Math.PI / 2, 0, 0],
        material_slots: [doc.addMaterial({ name, ...m })],
      });
    wall('Far', 400, 0, 150, glow([1, 1, 1]));
    const pane = { base_color: [1, 1, 1, 1] as [number, number, number, number], transmission: 1, roughness: 0 };
    wall('Matched', 1.6 * (paneDistance / 5), -1.2 * (paneDistance / 5), paneDistance, { ...pane, ior: 1 });
    wall('Glass', 1.6 * (paneDistance / 5), 1.2 * (paneDistance / 5), paneDistance, { ...pane, ior: 1.45 });
    return doc;
  }

  const view = { position: [0, 0, 0] as [number, number, number], target: [0, 10, 0] as [number, number, number], fovY: 0.66 };

  it('keeps the mist of what is seen through glass (like the rasterizer)', () => {
    for (const distance of [5, 120]) {
      const { img } = traceLinear(mistScene(distance), { width: 64, height: 32, samples: 8, view });
      const around = mean(img, 64, 1, 14, 6, 18);
      const matched = mean(img, 64, 20, 14, 23, 18);
      const glass = mean(img, 64, 41, 14, 44, 18);
      // the wall is 90 % in the red mist
      const m = 1 - Math.exp(-((0.01 * 150) ** 2));
      expect(around[0]).toBeCloseTo(1 - m + 0.8 * m, 2);
      expect(around[1]).toBeCloseTo(1 - m + 0.1 * m, 2);
      for (let c = 0; c < 3; c++) {
        // index-matched glass is invisible, mist included
        expect(Math.abs(matched[c] / around[c] - 1), `IOR 1 at ${distance} m, channel ${c}`).toBeLessThan(0.01);
        // glass dims the view by its two Fresnel reflections at most
        expect(glass[c] / around[c], `IOR 1.45 at ${distance} m, channel ${c}`).toBeGreaterThan(0.9);
        expect(glass[c] / around[c], `IOR 1.45 at ${distance} m, channel ${c}`).toBeLessThan(1.02);
      }
    }
  }, 30_000);
});

describe('path tracer: warnings name the objects (clockwork-orrery v2)', () => {
  it('names the objects whose degenerate triangles are skipped, with their counts', () => {
    const doc = blackWorld();
    const sliver = () =>
      createMesh({
        // face 0 is a zero-area triangle (three points on a line), face 1 a proper one
        positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0],
        faces: [
          [0, 1, 2],
          [0, 1, 3],
        ],
      });
    const plate = doc.addMesh('Plate', sliver());
    doc.addObject({ type: 'MESH', name: 'Motto Plate', data: plate });
    // a linked duplicate shares the mesh: counted once, named with it
    doc.addObject({ type: 'MESH', name: 'Motto Plate.001', data: plate, location: [0, 3, 0] });
    doc.addObject({ type: 'MESH', name: 'Gear', data: doc.addMesh('Gear', sliver()), location: [3, 0, 0] });
    doc.addObject({ type: 'MESH', name: 'Clean', data: doc.addMesh('Clean', createPlane()), location: [6, 0, 0] });
    const scene = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    const items = renderItems(scene, { forRender: true });
    const view = resolveView(doc, scene, { width: 32, height: 24 }, 32 / 24, evaluatedBounds(items));
    const { scene: compiled } = preparePathTrace({
      scene,
      items,
      view,
      camera: viewCameraData(doc, scene, {}),
      width: 32,
      height: 24,
      images: new TextureCache(doc),
      options: { samples: 1 },
    });
    expect(compiled.warnings).toEqual([
      "2 degenerate triangle(s) skipped (zero-area or non-finite faces of the render geometry; they do not render): 'Gear' 1, 'Motto Plate', 'Motto Plate.001' 1",
    ]);
  });
});
