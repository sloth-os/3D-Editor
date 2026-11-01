import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  createMesh,
  createPlane,
  createUVSphere,
  encodePNG,
  renderSceneSoftware,
  type MaterialData,
  type MeshData,
} from '../src';
import { defaultProcedural } from '../src/material/procedural';
import { defaultSpline, defaultSplinePoint } from '../src/doc/defaults';
import { SceneEvaluator } from '../src/eval/evaluate';
import { renderItems } from '../src/eval/renderables';
import { viewFromCamera } from '../src/render/view';
import {
  compileScene,
  PathTracer,
  PrincipledBSDF,
  renderPathTracedImage,
  studioRadiance,
} from '../src/render/pathtrace';
import { terminatorAmount } from '../src/render/pathtrace/integrator';
import { at, mean, topCamera, traceLinear, tracerFor } from './pathtrace-helpers';

/*
 * Feature behaviour of the path tracer: refraction, reflection, instancing, textures,
 * transparency, environments, depth of field, mist, culling and normal maps.
 */

function lambert(
  doc: SceneDoc,
  rgb: [number, number, number] = [0.8, 0.8, 0.8],
  extra: Partial<MaterialData> = {},
) {
  return doc.addMaterial({ base_color: [...rgb, 1], roughness: 1, ior: 1, ...extra });
}

/** Pure emitter: black, IOR 1 (no specular reflection). */
function emissive(doc: SceneDoc, rgb: [number, number, number], strength = 1) {
  return doc.addMaterial({
    base_color: [0, 0, 0, 1],
    ior: 1,
    emission_color: rgb,
    emission_strength: strength,
  });
}

function plane(
  doc: SceneDoc,
  name: string,
  size: number,
  mat: string,
  o: Partial<{ location: number[]; rotation: number[]; scale: number[] }> = {},
) {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, createPlane({ size })),
    material_slots: [mat],
    location: (o.location ?? [0, 0, 0]) as [number, number, number],
    rotation_euler: (o.rotation ?? [0, 0, 0]) as [number, number, number],
    scale: (o.scale ?? [1, 1, 1]) as [number, number, number],
  });
}

const MIRROR_INPUTS = {
  baseR: 0.9,
  baseG: 0.9,
  baseB: 0.9,
  metallic: 1,
  roughness: 0,
  ior: 1.5,
  transmission: 0,
  coat: 0,
  coatRoughness: 0.03,
  sheen: 0,
  sheenR: 1,
  sheenG: 1,
  sheenB: 1,
};

function blackWorld(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0, 0, 0] });
  return doc;
}

describe('path tracer: refraction and reflection', () => {
  it('a glass ball acts as a lens and inverts the scene behind it', () => {
    const doc = blackWorld();
    const red = emissive(doc, [1, 0, 0]);
    const blue = emissive(doc, [0, 0, 1]);
    // backdrop at y = 6 facing the camera: red for x < 0, blue for x > 0
    plane(doc, 'Left', 10, red, { location: [-5, 6, 0], rotation: [Math.PI / 2, 0, 0] });
    plane(doc, 'Right', 10, blue, { location: [5, 6, 0], rotation: [Math.PI / 2, 0, 0] });
    const ball = createUVSphere({ segments: 64, ring_count: 32 });
    ball.faceSmooth = ball.faceSmooth.map(() => true);
    const glass = doc.addMaterial({ base_color: [1, 1, 1, 1], transmission: 1, roughness: 0, ior: 1.5 });
    doc.addObject({ type: 'MESH', name: 'Ball', data: doc.addMesh('Ball', ball), material_slots: [glass] });
    const view = {
      position: [0, -10, 0] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      fovY: 2 * Math.atan(0.15),
    };
    const { img } = traceLinear(doc, { width: 32, height: 32, samples: 16, maxBounces: 8, view });
    const inLeft = at(img, 32, 10, 16); // x ≈ −0.5 m on the ball
    const inRight = at(img, 32, 21, 16);
    const outLeft = at(img, 32, 2, 16); // beside the ball
    const outRight = at(img, 32, 29, 16);
    expect(outLeft[0]).toBeGreaterThan(0.9);
    expect(outRight[2]).toBeGreaterThan(0.9);
    // through the lens the sides swap, attenuated only by the two Fresnel reflections
    expect(inLeft[2]).toBeGreaterThan(0.75);
    expect(inLeft[0]).toBeLessThan(0.1);
    expect(inRight[0]).toBeGreaterThan(0.75);
    expect(inRight[2]).toBeLessThan(0.1);
  });

  it('a polished metal mirror reflects emitters tinted by its base colour', () => {
    const doc = blackWorld();
    const mirror = doc.addMaterial({ base_color: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0 });
    plane(doc, 'Mirror', 20, mirror);
    plane(doc, 'Sky', 40, emissive(doc, [1, 0.5, 0.2], 2), { location: [0, 0, 10] });
    topCamera(doc, 1, 5);
    const { img } = traceLinear(doc, { width: 8, height: 8, samples: 8 });
    const p = mean(img, 8, 2, 2, 6, 6);
    expect(p[0]).toBeCloseTo(1.8, 1);
    expect(p[1]).toBeCloseTo(0.9, 1);
    expect(p[2]).toBeCloseTo(0.36, 1);
    // rough metal: the image equals the BSDF's reflectance towards the (finite) emitter
    doc.updateMaterial(mirror, { roughness: 0.4 });
    const rough = mean(traceLinear(doc, { width: 8, height: 8, samples: 256 }).img, 8, 0, 0, 8, 8);
    const b = new PrincipledBSDF();
    b.setup({ ...MIRROR_INPUTS, roughness: 0.4 }, 0, 0, 1, true);
    let inside = 0;
    const n = 300;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (
          b.sample((i + 0.5) / n, (j + 0.5) / n, 0.5) &&
          Math.abs(b.wx / b.wz) <= 2 &&
          Math.abs(b.wy / b.wz) <= 2
        )
          inside += b.fR / b.pdf;
    const expected = (2 * inside) / (n * n);
    expect(Math.abs(rough[0] - expected) / expected).toBeLessThan(0.01);
    expect(expected).toBeLessThan(1.8);
  });

  it('filter glossy (default) finds caustics of small lamps through glass at low sample counts', () => {
    const doc = blackWorld();
    plane(doc, 'Floor', 20, lambert(doc));
    const ball = createUVSphere({ segments: 32, ring_count: 16, radius: 0.5 });
    ball.faceSmooth = ball.faceSmooth.map(() => true);
    doc.addObject({
      type: 'MESH',
      name: 'Glass',
      data: doc.addMesh('Glass', ball),
      location: [0, 0, 1],
      material_slots: [
        doc.addMaterial({ base_color: [1, 1, 1, 1], transmission: 1, roughness: 0, ior: 1.5 }),
      ],
    });
    // a small lamp up and to the right: the caustic lands on the floor left of the ball
    doc.addObject({
      type: 'LIGHT',
      name: 'Lamp',
      data: doc.addLight({ type: 'POINT', energy: 300, shadow_soft_size: 0.05 }),
      location: [2, 0, 4],
    });
    topCamera(doc, 3, 6);
    // mean of the caustic region around x ≈ −0.7 m (the ball covers x ∈ ±0.5 m)
    const caustic = (filter: number, seed: number) => {
      const { img } = traceLinear(doc, {
        width: 24,
        height: 24,
        samples: 32,
        seed,
        options: { filter_glossy: filter },
      });
      return mean(img, 24, 2, 9, 10, 15)[0];
    };
    // without the filter the caustic is (almost) never found: only the indirect light remains
    const none = caustic(0, 1);
    const a = caustic(1, 1);
    const b = caustic(1, 2);
    expect(a).toBeGreaterThan(2 * none);
    expect(Math.abs(a - b) / a).toBeLessThan(0.2);
  }, 30_000);
});

describe('path tracer: instancing', () => {
  it('shares one mesh BVH between instances with different transforms', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    const mat = lambert(doc);
    const cube = doc.addObject({
      type: 'MESH',
      name: 'Cube',
      data: doc.addMesh('Cube', createCube({ size: 1 })),
      material_slots: [mat],
    });
    topCamera(doc, 8, 10);
    const ev = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    const items = renderItems(ev, { forRender: true });
    expect(items).toHaveLength(1);
    const twin = {
      ...items[0],
      id: `${cube}:copy`,
      instance: true,
      worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, 0, 1],
    };
    const cam = ev.activeCamera!;
    const compiled = compileScene({
      items: [items[0], twin],
      lights: [],
      world: ev.world,
      view: viewFromCamera(cam.camera!, cam.worldMatrix, 1),
      camera: null,
      width: 32,
      height: 32,
      image: () => null,
    });
    expect(compiled.geometries).toHaveLength(1);
    expect(compiled.instances.count).toBe(2);
    expect(compiled.instances.ids).toEqual([cube, `${cube}:copy`]);
    const pt = new PathTracer(compiled, {
      width: 32,
      height: 32,
      samples: 4,
      background: 'TRANSPARENT',
      denoise: false,
    });
    pt.render();
    const img = pt.resolve();
    // 8 m wide view: the cube at x = 0 covers columns 14..17, the copy at x = 2.5 columns 24..27
    expect(at(img, 32, 16, 16)[3]).toBe(1);
    expect(at(img, 32, 25, 16)[3]).toBe(1);
    expect(at(img, 32, 21, 16)[3]).toBe(0);
  });

  it('renders collection instances evaluated from the document', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    const coll = doc.addCollection({ name: 'Props' });
    doc.addObject({
      type: 'MESH',
      name: 'Box',
      collection: coll,
      data: doc.addMesh('Box', createCube({ size: 1 })),
      material_slots: [lambert(doc)],
    });
    for (const x of [-2.5, 2.5])
      doc.addObject({
        type: 'EMPTY',
        name: `Inst${x}`,
        instance_type: 'COLLECTION',
        instance_collection: coll,
        location: [x, 0, 0],
      });
    topCamera(doc, 8, 10);
    const { img, tracer } = traceLinear(doc, {
      width: 32,
      height: 32,
      samples: 4,
      options: { background: [0, 0, 0, 0] },
    });
    expect(tracer.scene.instances.count).toBe(3);
    expect(tracer.scene.geometries).toHaveLength(1);
    for (const x of [6, 16, 26]) expect(at(img, 32, x, 16)[3], `column ${x}`).toBe(1);
    expect(at(img, 32, 11, 16)[3]).toBe(0);
  });

  it('renders evaluated curve and text geometry with its materials', () => {
    const doc = blackWorld();
    doc.updateRender({ film_transparent: true });
    const red = emissive(doc, [1, 0, 0]);
    const green = emissive(doc, [0, 1, 0]);
    // a beveled circle (CURVE) around the origin and the word "Hi" (FONT) right of it
    const circle = defaultSpline(
      'BEZIER',
      [
        [-1, 0, 0],
        [0, 1, 0],
        [1, 0, 0],
        [0, -1, 0],
      ].map((co) => defaultSplinePoint(co as [number, number, number])),
    );
    circle.use_cyclic_u = true;
    doc.addObject({
      type: 'CURVE',
      name: 'Ring',
      data: doc.addCurve({ splines: [circle], bevel_depth: 0.25 }),
      material_slots: [red],
    });
    doc.addObject({
      type: 'FONT',
      name: 'Sign',
      data: doc.addCurve({ body: 'Hi', size: 2, fill_mode: 'BOTH', extrude: 0.05 }),
      location: [1.6, -0.7, 0],
      material_slots: [green],
    });
    doc.updateObject(topCamera(doc, 6, 5), { location: [1.2, 0, 5] });
    const { img } = traceLinear(doc, { width: 48, height: 32, samples: 4 });
    let redPx = 0;
    let greenPx = 0;
    for (let i = 0; i < 48 * 32; i++) {
      if (img[i * 4 + 3] < 0.5) continue;
      if (img[i * 4] > 0.4 && img[i * 4 + 1] === 0) redPx++;
      if (img[i * 4 + 1] > 0.4 && img[i * 4] === 0) greenPx++;
    }
    expect(redPx).toBeGreaterThan(60);
    expect(greenPx).toBeGreaterThan(20);
    // the ring is hollow: its centre stays empty
    expect(at(img, 48, Math.round(((0 - 1.2) / 6 + 0.5) * 48), 16)[3]).toBe(0);
  });
});

describe('path tracer: textures and vertex colours', () => {
  it('samples PNG base colour textures with the editor UV convention (V up)', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] }); // uniform light: radiance = albedo
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const image = doc.addImage({
      name: 'Quad',
      mime: 'image/png',
      width: 2,
      height: 2,
      data: encodePNG({ width: 2, height: 2, data: px }),
    });
    const mat = lambert(doc, [1, 1, 1], {
      textures: { base_color: { image, scale: [1, 1], offset: [0, 0] } },
    });
    plane(doc, 'Plane', 2, mat);
    topCamera(doc, 2, 5);
    // pixels 4 and 13 of 18 look at the texel centres (u, v = 0.25 / 0.75)
    const { img } = traceLinear(doc, { width: 18, height: 18, samples: 16, maxBounces: 1 });
    const tl = at(img, 18, 4, 4);
    const tr = at(img, 18, 13, 4);
    const bl = at(img, 18, 4, 13);
    const br = at(img, 18, 13, 13);
    expect(tl[0]).toBeGreaterThan(0.9);
    expect(tl[1]).toBeLessThan(0.05);
    expect(tr[1]).toBeGreaterThan(0.9);
    expect(bl[2]).toBeGreaterThan(0.9);
    expect(Math.min(br[0], br[1], br[2])).toBeGreaterThan(0.9);
  });

  it('procedural base colour replaces the material colour (checker pattern)', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    const tex = defaultProcedural('CHECKER', {
      mapping: 'OBJECT',
      scale: 1,
      color_a: [1, 0, 0, 1],
      color_b: [0, 0, 1, 1],
    });
    const mat = lambert(doc, [0.2, 0.2, 0.2], {
      textures: { base_color: { image: '', scale: [1, 1], offset: [0, 0], procedural: tex } },
    });
    plane(doc, 'Plane', 4, mat);
    topCamera(doc, 4, 5);
    const { img } = traceLinear(doc, { width: 16, height: 16, samples: 4, maxBounces: 1 });
    let red = 0;
    let blue = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const p = at(img, 16, x, y);
        if (p[0] > 0.8 && p[2] < 0.1) red++;
        if (p[2] > 0.8 && p[0] < 0.1) blue++;
      }
    expect(red).toBeGreaterThan(40);
    expect(blue).toBeGreaterThan(40);
  });

  it('GENERATED coordinates stick to surfaces deformed by shape keys (orco), like the rasterizer', () => {
    // regression: GENERATED used the deformed positions, so procedural textures swam over
    // shape-key / deform-modifier animation (the rasterizer already used the orco)
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    doc.updateRender({ view_transform: 'STANDARD' });
    const base = createPlane({ size: 2 });
    const meshId = doc.addMesh('Plane', base);
    const moved = Float32Array.from(base.positions, (v, i) => (i % 3 === 0 ? v + 0.5 : v));
    const shapeKey = (value: number) =>
      doc.setShapeKeys(meshId, [
        {
          name: 'Move',
          value,
          slider_min: 0,
          slider_max: 1,
          mute: false,
          relative_key: '',
          data: new Uint8Array(moved.buffer),
        },
      ]);
    const tex = defaultProcedural('CHECKER', {
      mapping: 'GENERATED',
      scale: 4,
      color_a: [1, 0, 0, 1],
      color_b: [0, 0, 1, 1],
    });
    const mat = lambert(doc, [1, 1, 1], {
      textures: { base_color: { image: '', scale: [1, 1], offset: [0, 0], procedural: tex } },
    });
    doc.addObject({ type: 'MESH', name: 'Plane', data: meshId, material_slots: [mat] });
    topCamera(doc, 4, 5);
    // red − blue along 32 pixels of the plane's own surface (16 px per metre), starting at pixel x0
    const surface = (engine: 'PATHTRACER' | 'RASTER', x0: number) => {
      const img = renderSceneSoftware(doc, {
        width: 64,
        height: 8,
        engine,
        samples: engine === 'RASTER' ? 1 : 16,
        denoise: false,
        max_bounces: 0,
      });
      const out: number[] = [];
      for (let x = x0; x < x0 + 32; x++) {
        let d = 0;
        for (const y of [1, 2]) d += img.data[(y * 64 + x) * 4] - img.data[(y * 64 + x) * 4 + 2];
        out.push(d / 2);
      }
      return out;
    };
    shapeKey(0);
    const rest = surface('PATHTRACER', 16);
    shapeKey(1); // the plane moves 0.5 m (8 px, one checker square) along +X
    const deformed = surface('PATHTRACER', 24);
    const raster = surface('RASTER', 24);
    expect(Math.max(...rest)).toBeGreaterThan(150);
    expect(Math.min(...rest)).toBeLessThan(-150);
    rest.forEach((v, i) => {
      if (Math.abs(v) < 100) return; // a square's edge
      expect(Math.sign(deformed[i]), `pixel ${i}`).toBe(Math.sign(v));
      expect(Math.sign(raster[i]), `pixel ${i}`).toBe(Math.sign(v));
    });
  });

  it('multiplies vertex colours into the base colour', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    const mesh: MeshData = createPlane({ size: 2 });
    mesh.colors = new Array((mesh.positions.length / 3) * 4).fill(0).map((_, i) => [1, 0.5, 0, 1][i % 4]);
    doc.addObject({
      type: 'MESH',
      name: 'Coloured',
      data: doc.addMesh('Coloured', mesh),
      material_slots: [lambert(doc, [1, 1, 1])],
    });
    topCamera(doc, 1, 5);
    const p = mean(traceLinear(doc, { width: 4, height: 4, samples: 128, maxBounces: 1 }).img, 4, 0, 0, 4, 4);
    expect(p[0]).toBeCloseTo(1, 2);
    expect(p[1]).toBeCloseTo(0.5, 2);
    expect(p[2]).toBeCloseTo(0, 6);
  });

  it('bends shading normals with tangent-space normal maps', () => {
    const doc = blackWorld();
    // sun from +X at 45°
    doc.addObject({
      type: 'LIGHT',
      name: 'Sun',
      data: doc.addLight({ type: 'SUN', energy: 3 }),
      rotation_euler: [0, Math.PI / 4, 0],
    });
    const png = (r: number, g: number, b: number) =>
      encodePNG({ width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, 255]) });
    const flatImg = doc.addImage({
      name: 'Flat',
      mime: 'image/png',
      width: 1,
      height: 1,
      data: png(128, 128, 255),
    });
    const tiltImg = doc.addImage({
      name: 'Tilt',
      mime: 'image/png',
      width: 1,
      height: 1,
      data: png(218, 128, 218),
    });
    const mat = lambert(doc);
    const id = plane(doc, 'Plane', 4, mat);
    topCamera(doc, 0.5, 5);
    const value = () =>
      mean(traceLinear(doc, { width: 4, height: 4, samples: 8, maxBounces: 1 }).img, 4, 0, 0, 4, 4)[0];
    const none = value();
    doc.updateMaterial(mat, { textures: { normal: { image: flatImg, scale: [1, 1], offset: [0, 0] } } });
    expect(value()).toBeCloseTo(none, 2);
    doc.updateMaterial(mat, { textures: { normal: { image: tiltImg, scale: [1, 1], offset: [0, 0] } } });
    // normal tilted towards +X (the light): brighter than the flat plane
    expect(value()).toBeGreaterThan(none * 1.15);
    void id;
  });
});

describe('path tracer: transparency, culling and film', () => {
  it('BLEND alpha gives partial coverage, CLIP is binary, OPAQUE ignores alpha', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    const mat = lambert(doc, [0.8, 0.8, 0.8], { alpha: 0.4, blend_method: 'BLEND' });
    plane(doc, 'Veil', 4, mat);
    topCamera(doc, 1, 5);
    doc.updateRender({ film_transparent: true });
    const cover = () =>
      mean(traceLinear(doc, { width: 4, height: 4, samples: 64, maxBounces: 2 }).img, 4, 0, 0, 4, 4)[3];
    expect(cover()).toBeCloseTo(0.4, 1);
    doc.updateMaterial(mat, { blend_method: 'CLIP', alpha_threshold: 0.5 });
    expect(cover()).toBe(0);
    doc.updateMaterial(mat, { alpha: 0.6 });
    expect(cover()).toBe(1);
    doc.updateMaterial(mat, { blend_method: 'OPAQUE', alpha: 0.1 });
    expect(cover()).toBe(1);
  });

  it('transparent surfaces attenuate shadows by their coverage', () => {
    const doc = blackWorld();
    plane(doc, 'Floor', 20, lambert(doc));
    // sun from +X at 45°; the blocker's shadow falls on the viewed patch at the origin
    doc.addObject({
      type: 'LIGHT',
      name: 'Sun',
      data: doc.addLight({ type: 'SUN', energy: 2 }),
      rotation_euler: [0, Math.PI / 4, 0],
    });
    topCamera(doc, 0.1, 5);
    const lit = () =>
      mean(traceLinear(doc, { width: 4, height: 4, samples: 4, maxBounces: 1 }).img, 4, 0, 0, 4, 4)[0];
    const full = lit();
    expect(full).toBeCloseTo((0.8 / Math.PI) * 2 * Math.SQRT1_2, 2);
    const veil = lambert(doc, [0.8, 0.8, 0.8], { alpha: 0.5, blend_method: 'BLEND' });
    const blocker = plane(doc, 'Blocker', 1, veil, { location: [1, 0, 1] });
    expect(lit() / full).toBeCloseTo(0.5, 2);
    doc.updateMaterial(veil, { blend_method: 'OPAQUE' });
    expect(lit()).toBe(0);
    void blocker;
  });

  it('keeps contact shadows on smooth-shaded low-poly surfaces (terminator offset only at grazing light)', () => {
    // regression: the shadow-terminator lift (up to 0.67 m on a smooth 2 m cube) was applied to
    // every shadow ray, so a box standing on a smooth cube cast almost no shadow
    const table = (smooth: boolean) => {
      const doc = blackWorld();
      const white = lambert(doc);
      const cube = createCube({ size: 2 });
      if (smooth) cube.faceSmooth = cube.faceSmooth.map(() => true);
      doc.addObject({ type: 'MESH', name: 'Table', data: doc.addMesh('Table', cube), material_slots: [white] });
      doc.addObject({
        type: 'MESH',
        name: 'Box',
        data: doc.addMesh('Box', createCube({ size: 1 })),
        location: [0, 0, 1.15],
        scale: [0.2, 0.2, 0.3],
        material_slots: [white],
      });
      // sun at 45° from +X: the shadow falls on x ∈ [−0.4, −0.1], y ∈ [−0.1, 0.1] of the top
      doc.addObject({
        type: 'LIGHT',
        name: 'Sun',
        data: doc.addLight({ type: 'SUN', energy: 3 }),
        rotation_euler: [0, Math.PI / 4, 0],
      });
      topCamera(doc, 2, 10);
      const { img } = traceLinear(doc, { width: 40, height: 40, samples: 16, maxBounces: 0 });
      return { shadow: mean(img, 40, 13, 19, 17, 21)[0], lit: mean(img, 40, 28, 10, 36, 30)[0] };
    };
    const flat = table(false);
    const smooth = table(true);
    expect(flat.shadow).toBeLessThan(0.02 * flat.lit);
    expect(smooth.lit).toBeGreaterThan(0.3);
    expect(smooth.shadow).toBeLessThan(0.02 * smooth.lit);
    // the offset fades in only for light within ~6° of the facet plane (Cycles' cutoff 0.1)
    expect(terminatorAmount(Math.SQRT1_2, Math.SQRT1_2)).toBe(0);
    expect(terminatorAmount(0.1, 0)).toBe(0);
    expect(terminatorAmount(0.02, 0.05)).toBe(1);
    expect(terminatorAmount(0.05, 0.1)).toBeCloseTo(0.5, 12);
    expect(terminatorAmount(0.05, 0.3)).toBe(0);
    expect(terminatorAmount(NaN, 0)).toBe(0);
  });

  it('backface culling lets camera rays through back faces', () => {
    const doc = blackWorld();
    plane(doc, 'Below', 4, emissive(doc, [0, 1, 0]));
    const cover = doc.addMaterial({
      base_color: [0, 0, 0, 1],
      ior: 1,
      emission_color: [1, 0, 0],
      emission_strength: 1,
      use_backface_culling: true,
    });
    plane(doc, 'Cover', 4, cover, { location: [0, 0, 1], rotation: [Math.PI, 0, 0] }); // faces down, away from the camera
    topCamera(doc, 1, 5);
    const p = at(traceLinear(doc, { width: 4, height: 4, samples: 2 }).img, 4, 2, 2);
    expect(p[1]).toBeCloseTo(1, 4);
    doc.updateMaterial(cover, { use_backface_culling: false });
    const q = at(traceLinear(doc, { width: 4, height: 4, samples: 2 }).img, 4, 2, 2);
    expect(q[0]).toBeCloseTo(1, 4);
  });

  it('film_transparent and explicit backgrounds set the alpha of empty pixels', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [0.2, 0.2, 0.2] });
    plane(doc, 'Plane', 1, lambert(doc));
    topCamera(doc, 4, 5);
    const run = (o = {}) => traceLinear(doc, { width: 8, height: 8, samples: 2, options: o }).img;
    expect(at(run(), 8, 0, 0)).toEqual([
      expect.closeTo(0.2, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.2, 5),
      1,
    ]);
    doc.updateRender({ film_transparent: true });
    const t = run();
    expect(at(t, 8, 0, 0)[3]).toBe(0);
    expect(at(t, 8, 4, 4)[3]).toBe(1);
    // an explicit background leaves the film transparent; it is composited after the display
    // transform, so it shows exactly the requested display colour whatever the view transform
    const bg = run({ background: [1, 0, 0, 0.5] });
    expect(at(bg, 8, 0, 0)[3]).toBe(0);
    doc.updateRender({ film_transparent: false, view_transform: 'AGX', exposure: 1.5 });
    const scene = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    const cam = scene.activeCamera!;
    const img = renderPathTracedImage({
      scene,
      items: renderItems(scene, { forRender: true }),
      view: viewFromCamera(cam.camera!, cam.worldMatrix, 1),
      camera: cam.camera!,
      width: 8,
      height: 8,
      images: { get: () => null },
      options: { samples: 2, denoise: false, background: [1, 0.5, 0, 0.5] },
    });
    expect([...img.data.subarray(0, 4)]).toEqual([255, 128, 0, 128]);
    const centre = (4 * 8 + 4) * 4;
    expect(img.data[centre + 3]).toBe(255);
  });
});

describe('path tracer: environments, camera and mist', () => {
  it('lights with the studio environment as its importance-sampled integral predicts', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'STUDIO', environment_strength: 1, strength: 1, environment_rotation: 0 });
    plane(doc, 'Floor', 100, lambert(doc));
    topCamera(doc, 0.2, 5);
    // E = ∫ L cosθ dω over the upper hemisphere
    let E = 0;
    const n = 400;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < 2 * n; j++) {
        const z = (i + 0.5) / n;
        const r = Math.sqrt(1 - z * z);
        const ph = (Math.PI * (j + 0.5)) / n;
        E += studioRadiance(r * Math.cos(ph), r * Math.sin(ph), z) * z;
      }
    E *= (2 * Math.PI) / (n * 2 * n);
    const { img } = traceLinear(doc, { width: 4, height: 4, samples: 512, maxBounces: 1 });
    const v = mean(img, 4, 0, 0, 4, 4)[0];
    expect(Math.abs(v - (0.8 / Math.PI) * E) / ((0.8 / Math.PI) * E)).toBeLessThan(0.03);
  }, 20_000);

  it('uses equirectangular image environments (furnace with a uniform image)', () => {
    const doc = SceneDoc.create({ empty: true });
    const data = new Uint8ClampedArray(8 * 4 * 4).fill(128);
    const image = doc.addImage({
      name: 'Env',
      mime: 'image/png',
      width: 8,
      height: 4,
      data: encodePNG({ width: 8, height: 4, data }),
    });
    doc.updateWorld({
      environment: 'IMAGE',
      environment_image: image,
      environment_strength: 1,
      strength: 1,
      show_environment_background: true,
    });
    const ball = createUVSphere({ segments: 32, ring_count: 16 });
    ball.faceSmooth = ball.faceSmooth.map(() => true);
    doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', ball),
      material_slots: [doc.addMaterial({ base_color: [1, 1, 1, 1] })],
    });
    const { img } = traceLinear(doc, {
      width: 8,
      height: 8,
      samples: 64,
      maxBounces: 4,
      view: { position: [0, -5, 0], target: [0, 0, 0], fovY: 0.5 },
    });
    const L = Math.pow((128 / 255 + 0.055) / 1.055, 2.4);
    expect(at(img, 8, 0, 0)[0]).toBeCloseTo(L, 4);
    const c = mean(img, 8, 3, 3, 5, 5)[0];
    expect(Math.abs(c - L) / L).toBeLessThan(0.04);
  }, 20_000);

  it('lights with the procedural sky and its sun, and shows the sky as background', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({
      environment: 'SKY',
      show_environment_background: true,
      sun_elevation: Math.PI / 4,
      sun_intensity: 3,
    });
    plane(doc, 'Floor', 100, lambert(doc));
    topCamera(doc, 0.2, 5);
    const lit = mean(
      traceLinear(doc, { width: 4, height: 4, samples: 64, maxBounces: 1 }).img,
      4,
      0,
      0,
      4,
      4,
    )[0];
    doc.updateWorld({ sun_intensity: 0 });
    const sky = mean(
      traceLinear(doc, { width: 4, height: 4, samples: 64, maxBounces: 1 }).img,
      4,
      0,
      0,
      4,
      4,
    )[0];
    expect(sky).toBeGreaterThan(0);
    expect(lit - sky).toBeGreaterThan(0.5 * (0.8 / Math.PI) * 3 * Math.SQRT1_2);
    // background: looking at the horizon shows the sky colour, not the world colour
    const bg = traceLinear(doc, {
      width: 4,
      height: 4,
      samples: 2,
      view: { position: [0, 0, 1], target: [0, 10, 1.5] },
    }).img;
    const p = at(bg, 4, 2, 0);
    expect(p[2]).toBeGreaterThan(p[0]);
  }, 20_000);

  it('orients the sky by sun_rotation only (environment_rotation turns studio and image worlds)', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ environment: 'SKY', sun_elevation: 0.4, sun_rotation: 1, sun_intensity: 2 });
    plane(doc, 'Floor', 100, lambert(doc));
    const ball = createUVSphere({ segments: 16, ring_count: 8, radius: 0.5 });
    doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: doc.addMesh('Ball', ball),
      location: [0, 0, 0.5],
      material_slots: [lambert(doc)],
    });
    topCamera(doc, 3, 5);
    const run = () => traceLinear(doc, { width: 8, height: 8, samples: 8, maxBounces: 2 });
    const a = run();
    expect(a.tracer.scene.environment.rotation).toBe(0);
    doc.updateWorld({ environment_rotation: 1.3 });
    const b = run();
    expect(b.tracer.scene.environment.rotation).toBe(0);
    expect(b.img).toEqual(a.img);
    // the sun direction does turn it: the shadow moves
    doc.updateWorld({ sun_rotation: 2.5 });
    expect(run().img).not.toEqual(a.img);
    doc.updateWorld({ environment: 'STUDIO' });
    expect(run().tracer.scene.environment.rotation).toBeCloseTo(1.3, 12);
  }, 20_000);

  it('depth of field blurs out-of-focus edges only', () => {
    const doc = blackWorld();
    // two emissive half planes with a vertical edge at x = 0: one at the focus distance, one far
    plane(doc, 'Near', 2, emissive(doc, [1, 1, 1]), { location: [1, 0, 0], rotation: [Math.PI / 2, 0, 0] });
    const cam = doc.addCamera({ lens: 50, dof_use: true, dof_focus_distance: 5, dof_aperture_fstop: 0.05 });
    doc.updateScene({
      camera: doc.addObject({
        type: 'CAMERA',
        name: 'Cam',
        data: cam,
        location: [0, -5, 0],
        rotation_euler: [Math.PI / 2, 0, 0],
      }),
    });
    const edgeWidth = () => {
      const { img } = traceLinear(doc, { width: 32, height: 8, samples: 64 });
      let partial = 0;
      for (let x = 0; x < 32; x++) {
        const v = at(img, 32, x, 4)[0];
        if (v > 0.05 && v < 0.95) partial++;
      }
      return partial;
    };
    const sharp = edgeWidth();
    doc.updateCamera(cam, { dof_focus_distance: 1 });
    const blurred = edgeWidth();
    expect(sharp).toBeLessThanOrEqual(3);
    expect(blurred).toBeGreaterThan(sharp + 3);
    doc.updateCamera(cam, { dof_use: false });
    expect(edgeWidth()).toBeLessThanOrEqual(3);
  }, 20_000);

  it('depth of field also works for orthographic cameras (aperture radius 1 / (2 · f-stop) m)', () => {
    // regression: orthographic cameras ignored dof_use
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    plane(doc, 'Card', 1, lambert(doc, [0, 0, 0])); // a black card at z = 0 on a white world
    const cam = doc.addCamera({
      type: 'ORTHO',
      ortho_scale: 3,
      dof_use: true,
      dof_focus_distance: 8, // the card
      dof_aperture_fstop: 0.5,
    });
    doc.updateScene({
      camera: doc.addObject({ type: 'CAMERA', name: 'Cam', data: cam, location: [0, 0, 8] }),
    });
    const render = () => traceLinear(doc, { width: 32, height: 32, samples: 16, maxBounces: 0 }).img;
    const maxDiff = (a: Float32Array, b: Float32Array) => {
      let m = 0;
      for (let i = 0; i < a.length; i += 4) m = Math.max(m, Math.abs(a[i] - b[i]));
      return m;
    };
    const focused = render();
    doc.updateCamera(cam, { dof_focus_distance: 4 });
    const blurred = render();
    doc.updateCamera(cam, { dof_use: false });
    const pinhole = render();
    // in focus: the rays of a pixel meet on the card (at most a sample flips at its edges); out of
    // focus (aperture radius 1 m): the card's outline spreads over the white world
    expect(maxDiff(focused, pinhole)).toBeLessThan(0.07);
    expect(maxDiff(blurred, pinhole)).toBeGreaterThan(0.3);
    expect(mean(pinhole, 32, 14, 14, 18, 18)[0]).toBe(0);
    expect(mean(blurred, 32, 14, 14, 18, 18)[0]).toBeGreaterThan(0.1);
  });

  it('fades surfaces towards the mist colour with distance', () => {
    const doc = blackWorld();
    plane(doc, 'Floor', 20, emissive(doc, [1, 1, 1]));
    topCamera(doc, 1, 5);
    doc.updateWorld({ mist_density: 0.2, mist_color: [0, 0, 1] });
    const p = at(traceLinear(doc, { width: 4, height: 4, samples: 2 }).img, 4, 2, 2);
    const m = 1 - Math.exp(-((0.2 * 5) ** 2));
    expect(p[0]).toBeCloseTo(1 - m, 4);
    expect(p[2]).toBeCloseTo(1 - m + m, 4);
  });
});

describe('path tracer: robustness', () => {
  it('renders degenerate and invalid data without throwing', () => {
    const doc = blackWorld();
    doc.updateWorld({ color: [1, 1, 1] });
    const bad = doc.addMaterial({
      base_color: [NaN, 0.5, Infinity, 1],
      roughness: NaN,
      ior: -3,
      metallic: NaN,
      emission_strength: NaN,
      alpha: NaN,
    });
    // a plane scaled flat (zero-scale axis) is still rendered
    plane(doc, 'Flat', 2, bad, { scale: [1, 1, 0] });
    doc.addObject({
      type: 'MESH',
      name: 'Broken',
      data: doc.addMesh(
        'Broken',
        createMesh({
          positions: [0, 0, 0, NaN, 1, 0, 1, 1, 0, 2, 2, 2],
          faces: [
            [0, 1, 2],
            [0, 2, 3],
            [3, 3, 3],
          ],
        }),
      ),
    });
    doc.addObject({
      type: 'LIGHT',
      name: 'BadLamp',
      data: doc.addLight({ type: 'AREA', energy: NaN, size: 0 }),
    });
    doc.addObject({
      type: 'LIGHT',
      name: 'BadSun',
      data: doc.addLight({ type: 'SUN', energy: 1, color: [NaN, 1, 1] }),
      location: [NaN, 0, 0],
    });
    topCamera(doc, 4, 5);
    const { img, tracer } = traceLinear(doc, { width: 8, height: 8, samples: 4 });
    expect([...img].every(Number.isFinite)).toBe(true);
    expect(at(img, 8, 4, 4)[3]).toBe(1);
    expect(tracer.warnings.length).toBeGreaterThan(0);
  });

  it('honours the time budget and cancellation, always rendering at least one sample', () => {
    const doc = SceneDoc.create();
    const t = tracerFor(doc, { width: 16, height: 16, samples: 4096, options: { time_limit: 0.001 } });
    const stats = t.render();
    expect(stats.stopped).toBe('time');
    expect(t.film.samples).toBeGreaterThanOrEqual(1);
    expect(t.film.samples).toBeLessThan(4096);
    let calls = 0;
    const c = tracerFor(doc, { width: 16, height: 16, samples: 4096 });
    const cs = c.render(undefined, (p) => {
      expect(p.total).toBe(4096);
      return ++calls < 3;
    });
    expect(calls).toBe(3);
    expect(cs.stopped).toBe('cancelled');
    expect(c.film.samples).toBe(1 + 2 + 4);
  });
});
