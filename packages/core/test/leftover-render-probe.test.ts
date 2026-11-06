import { describe, expect, it } from 'vitest';
import { SceneDoc, SceneEvaluator, createPlane, createUVSphere, renderSceneSoftware } from '../src';
import { buildRenderBuffers } from '../src/mesh/render-buffers';
import { viewFromSpec } from '../src/render/view';
import {
  LOD_MIN_TRIANGLES,
  Rasterizer,
  SHADE_MATERIAL,
  clusteredRenderBuffers,
  rasterStats,
  type SurfaceMaterial,
} from '../src/render/raster';

/*
 * The RASTER reflection probe (a depth pre-pass and six 32 × 32 cube faces) drew every mesh at full
 * detail: on a dense mesh each of these seven tiny passes cost about as much as the main view, so a
 * reflective material roughly doubled the render time (leftovers of the last verification). The
 * probe's passes now draw dense meshes from a vertex-clustered proxy.
 */

function denseScene(metallic: number): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'STUDIO' });
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 20 })),
    material_slots: [doc.addMaterial({ base_color: [0.5, 0.5, 0.5, 1], roughness: 0.8 })],
  });
  doc.addObject({
    type: 'MESH',
    name: 'Ball',
    // 256 × 256 segments: 130 560 triangles
    data: doc.addMesh('Ball', createUVSphere({ segments: 256, ring_count: 256, radius: 1 })),
    location: [0, 0, 1],
    material_slots: [
      doc.addMaterial({ base_color: [0.9, 0.9, 0.9, 1], metallic, roughness: metallic ? 0.1 : 0.8 }),
    ],
  });
  doc.addObject({
    type: 'LIGHT',
    name: 'Sun',
    data: doc.addLight({ type: 'SUN', energy: 3 }),
    rotation_euler: [0.5, 0.3, 0],
  });
  return doc;
}

const VIEW = { position: [4, -6, 3] as [number, number, number], target: [0, 0, 1] as [number, number, number] };

/** Triangles the rasterizers iterate for one 320 × 180 render. */
function trianglesOfRender(doc: SceneDoc): number {
  const evaluator = new SceneEvaluator(doc);
  rasterStats.triangles = 0;
  renderSceneSoftware(doc, { width: 320, height: 180, samples: 1, view: VIEW, evaluator, engine: 'RASTER' });
  return rasterStats.triangles;
}

const MAT: SurfaceMaterial = {
  r: 0.8,
  g: 0.8,
  b: 0.8,
  alpha: 1,
  metallic: 0,
  roughness: 0.5,
  er: 0,
  eg: 0,
  eb: 0,
  blend: 0,
  threshold: 0.5,
  cull: false,
  vertexColors: false,
  tex: null,
  texScale: [1, 1],
  texOffset: [0, 0],
};

describe('RASTER reflection probe on dense meshes', () => {
  it('adds little rasterization work: the probe passes draw a coarse proxy of dense meshes', () => {
    const plain = trianglesOfRender(denseScene(0));
    const reflective = trianglesOfRender(denseScene(1));
    // without the proxy the pre-pass and the probe faces that see the ball iterate all of its
    // 130k triangles again (6× the work of the plain render); with it, ~1.33×
    expect(plain).toBeGreaterThan(130_000);
    expect(reflective / plain).toBeLessThan(1.6);
  });

  it('builds a proxy that keeps the shape, the material groups and the bounds', () => {
    const rb = buildRenderBuffers(createUVSphere({ segments: 256, ring_count: 256, radius: 1 }));
    expect(rb.indices.length / 3).toBeGreaterThan(LOD_MIN_TRIANGLES);
    const lod = clusteredRenderBuffers(rb, 32);
    const tris = lod.indices.length / 3;
    expect(tris).toBeGreaterThan(1000);
    expect(tris).toBeLessThan(12 * 32 * 32);
    expect(lod.triFace.length).toBe(tris);
    expect(lod.groups.reduce((s, g) => s + g.count, 0)).toBe(lod.indices.length);
    expect(lod.groups.map((g) => g.materialIndex)).toEqual(rb.groups.map((g) => g.materialIndex));
    const nv = lod.positions.length / 3;
    expect(lod.vertexSource.length).toBe(nv);
    for (let i = 0; i < nv; i++) {
      // vertices stay on the sphere (cell means of points on it: slightly inside) with unit normals
      const r = Math.hypot(lod.positions[i * 3], lod.positions[i * 3 + 1], lod.positions[i * 3 + 2]);
      expect(r).toBeGreaterThan(0.95);
      expect(r).toBeLessThan(1.0001);
      expect(Math.hypot(lod.normals[i * 3], lod.normals[i * 3 + 1], lod.normals[i * 3 + 2])).toBeCloseTo(1, 5);
    }
    for (let i = 0; i < lod.indices.length; i++) expect(lod.indices[i]).toBeLessThan(nv);
  });

  it('draws the proxy in small images like the full mesh', () => {
    const mesh = createUVSphere({ segments: 256, ring_count: 256, radius: 1 });
    const view = viewFromSpec({ position: [0, -4, 0], target: [0, 0, 0], up: [0, 0, 1], fovY: Math.PI / 2 }, 1, null);
    const draw = (lodCells: number) => {
      const ras = new Rasterizer(32, 32, view);
      ras.mode = SHADE_MATERIAL;
      ras.lights = new Float64Array([3, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0]);
      ras.lightCount = 1;
      ras.lodCells = lodCells;
      rasterStats.triangles = 0;
      ras.drawMesh(mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [MAT], MAT);
      return { ras, tris: rasterStats.triangles };
    };
    const full = draw(0);
    const lod = draw(32);
    expect(lod.tris).toBeLessThan(full.tris / 10);
    let covFull = 0;
    let covLod = 0;
    let diff = 0;
    for (let i = 0; i < 32 * 32; i++) {
      covFull += full.ras.cov[i];
      covLod += lod.ras.cov[i];
      for (let c = 0; c < 3; c++) diff += Math.abs(full.ras.color[i * 3 + c] - lod.ras.color[i * 3 + c]);
    }
    // same silhouette (within a few edge pixels) and shading
    expect(Math.abs(covFull - covLod)).toBeLessThan(8);
    expect(diff / (32 * 32 * 3)).toBeLessThan(0.02);
  });
});
