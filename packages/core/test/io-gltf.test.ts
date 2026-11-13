import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createFCurve,
  createUVSphere,
  encodePNG,
  exportScene,
  importFile,
  insertKeyframe,
  sniffFormat,
  type FCurve,
  type Mat4,
} from '../src';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function parseGLB(data: Uint8Array): { json: any; bin: Uint8Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  expect(dv.getUint32(0, true)).toBe(GLB_MAGIC);
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(data.length);
  expect(data.length % 4).toBe(0);
  const jsonLen = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(CHUNK_JSON);
  expect(jsonLen % 4).toBe(0);
  const jsonBytes = data.subarray(20, 20 + jsonLen);
  const text = new TextDecoder().decode(jsonBytes);
  const trimmed = text.replace(/ +$/, '');
  expect(trimmed.endsWith('}')).toBe(true); // padded with spaces only
  const json = JSON.parse(text);
  let bin: Uint8Array = new Uint8Array(0);
  if (20 + jsonLen < data.length) {
    const binLen = dv.getUint32(20 + jsonLen, true);
    expect(dv.getUint32(24 + jsonLen, true)).toBe(CHUNK_BIN);
    expect(binLen % 4).toBe(0);
    expect(28 + jsonLen + binLen).toBe(data.length);
    bin = data.subarray(28 + jsonLen, 28 + jsonLen + binLen);
  }
  return { json, bin };
}

const COMPONENT_SIZE: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessorData(json: any, bin: Uint8Array, index: number): number[] {
  const acc = json.accessors[index];
  const bv = json.bufferViews[acc.bufferView];
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const n = acc.count * COMPONENTS[acc.type];
  const copy = bin.slice(start, start + n * COMPONENT_SIZE[acc.componentType]);
  if (acc.componentType === 5126) return [...new Float32Array(copy.buffer)];
  if (acc.componentType === 5123) return [...new Uint16Array(copy.buffer)];
  return [...new Uint32Array(copy.buffer)];
}

/** Structural checks a glTF validator would do on our output. */
function validateGLTF(json: any, bin: Uint8Array): void {
  expect(json.asset.version).toBe('2.0');
  expect(json.scenes[json.scene]).toBeDefined();
  const buffer = json.buffers[0];
  expect(buffer.byteLength).toBeLessThanOrEqual(bin.length);
  for (const bv of json.bufferViews) {
    expect(bv.buffer).toBe(0);
    expect((bv.byteOffset ?? 0) % 4).toBe(0);
    expect((bv.byteOffset ?? 0) + bv.byteLength).toBeLessThanOrEqual(buffer.byteLength);
  }
  for (const acc of json.accessors) {
    const csize = COMPONENT_SIZE[acc.componentType];
    expect(csize).toBeDefined();
    expect(COMPONENTS[acc.type]).toBeDefined();
    const bv = json.bufferViews[acc.bufferView];
    expect((bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)).toSatisfy((o: number) => o % csize === 0);
    expect((acc.byteOffset ?? 0) + acc.count * COMPONENTS[acc.type] * csize).toBeLessThanOrEqual(
      bv.byteLength,
    );
  }
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const pos = json.accessors[prim.attributes.POSITION];
      expect(pos.type).toBe('VEC3');
      expect(pos.componentType).toBe(5126);
      expect(pos.min).toHaveLength(3);
      expect(pos.max).toHaveLength(3);
      const data = accessorData(json, bin, prim.attributes.POSITION);
      for (let i = 0; i < data.length; i++) {
        expect(data[i]).toBeGreaterThanOrEqual(pos.min[i % 3]);
        expect(data[i]).toBeLessThanOrEqual(pos.max[i % 3]);
      }
      expect(json.bufferViews[pos.bufferView].target).toBe(34962);
      if (prim.attributes.NORMAL !== undefined)
        expect(json.accessors[prim.attributes.NORMAL]).toMatchObject({ type: 'VEC3', componentType: 5126 });
      if (prim.attributes.TEXCOORD_0 !== undefined)
        expect(json.accessors[prim.attributes.TEXCOORD_0]).toMatchObject({
          type: 'VEC2',
          componentType: 5126,
        });
      if (prim.attributes.COLOR_0 !== undefined)
        expect(json.accessors[prim.attributes.COLOR_0]).toMatchObject({ type: 'VEC4', componentType: 5126 });
      for (const a of Object.values(prim.attributes) as number[])
        expect(json.accessors[a].count).toBe(pos.count);
      const idx = json.accessors[prim.indices];
      expect(idx.type).toBe('SCALAR');
      expect([5123, 5125]).toContain(idx.componentType);
      expect(json.bufferViews[idx.bufferView].target).toBe(34963);
      expect(Math.max(...accessorData(json, bin, prim.indices))).toBeLessThan(pos.count);
    }
  }
  for (const anim of json.animations ?? []) {
    for (const s of anim.samplers) {
      const input = json.accessors[s.input];
      expect(input.min).toHaveLength(1);
      expect(input.max).toHaveLength(1);
      const out = json.accessors[s.output];
      expect(out.count).toBe(input.count);
    }
  }
  const used = new Set(json.extensionsUsed ?? []);
  const text = JSON.stringify({ ...json, extensionsUsed: undefined });
  for (const ext of [
    'KHR_lights_punctual',
    'KHR_materials_emissive_strength',
    'KHR_materials_transmission',
    'KHR_materials_ior',
    'KHR_materials_clearcoat',
  ])
    expect(used.has(ext)).toBe(text.includes(`"${ext}"`));
}

function expectMatrixClose(a: Mat4, b: Mat4, digits = 5): void {
  for (let i = 0; i < 16; i++) expect(b[i]).toBeCloseTo(a[i], digits);
}

function keyed(target: string, path: string, index: number, keys: [number, number][]): FCurve {
  let fc = createFCurve({ target_type: 'object', target_id: target, path, index });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, 'LINEAR');
  return fc;
}

function richScene() {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ frame_start: 1, frame_end: 11 });
  const paint = doc.addMaterial({
    name: 'Paint',
    base_color: [0.2, 0.4, 0.6, 1],
    metallic: 0.3,
    roughness: 0.7,
    emission_color: [1, 0.5, 0],
    emission_strength: 2,
    blend_method: 'CLIP',
    alpha_threshold: 0.3,
    use_backface_culling: true,
    transmission: 0.5,
    ior: 1.33,
    coat_weight: 0.4,
    coat_roughness: 0.1,
  });
  const plain = doc.addMaterial({
    name: 'Plain',
    base_color: [0.9, 0.1, 0.1, 1],
    alpha: 0.5,
    blend_method: 'BLEND',
  });
  const rig = doc.addObject({
    type: 'EMPTY',
    name: 'Rig',
    location: [1, 2, 3],
    rotation_euler: [0.1, 0.2, 0.3],
    scale: [2, 2, 2],
  });
  const cube = doc.addObject({
    type: 'MESH',
    name: 'Cube',
    data: doc.addMesh('CubeMesh', createCube()),
    parent: rig,
    location: [1, 0, 0.5],
    rotation_euler: [0, 0.4, 0],
    scale: [1, 0.5, 1.5],
    material_slots: [paint],
  });
  const sphereMesh = createUVSphere({ segments: 8, ring_count: 4 });
  sphereMesh.faceSmooth = sphereMesh.faceSmooth.map(() => true);
  sphereMesh.faceMaterials = sphereMesh.faces.map((_, i) => (i % 2 ? 1 : 0));
  const sphere = doc.addObject({
    type: 'MESH',
    name: 'Sphere',
    data: doc.addMesh('SphereMesh', sphereMesh),
    location: [-3, 0, 1],
    material_slots: [paint, plain],
  });
  const camera = doc.addObject({
    type: 'CAMERA',
    name: 'Camera',
    data: doc.addCamera({ name: 'Cam35', lens: 35 }),
    location: [7, -6, 5],
    rotation_euler: [1.1, 0, 0.8],
  });
  const ortho = doc.addObject({
    type: 'CAMERA',
    name: 'Ortho',
    data: doc.addCamera({ name: 'OrthoCam', type: 'ORTHO', ortho_scale: 10 }),
    parent: cube,
    location: [0, 0, 4],
    rotation_euler: [0.2, 0, 0],
  });
  const point = doc.addObject({
    type: 'LIGHT',
    name: 'Point',
    data: doc.addLight({ name: 'PointLight', type: 'POINT', energy: 1000, color: [1, 0.9, 0.8] }),
    location: [4, 1, 6],
  });
  const spot = doc.addObject({
    type: 'LIGHT',
    name: 'Spot',
    data: doc.addLight({ name: 'SpotLight', type: 'SPOT', energy: 500, spot_size: 1, spot_blend: 0.2 }),
    location: [0, -4, 4],
    rotation_euler: [0.8, 0, 0.1],
  });
  const marker = doc.addObject({
    type: 'EMPTY',
    name: 'Marker',
    parent: spot,
    location: [0, 0, -2],
    rotation_euler: [0.3, 0.1, 0],
  });
  const sun = doc.addObject({
    type: 'LIGHT',
    name: 'Sun',
    data: doc.addLight({ name: 'SunLight', type: 'SUN', energy: 3 }),
    rotation_euler: [0.3, 0.2, 0],
  });
  const area = doc.addObject({
    type: 'LIGHT',
    name: 'Area',
    data: doc.addLight({ name: 'AreaLight', type: 'AREA', energy: 200 }),
    location: [0, 0, 5],
  });
  // animation: cube location/rotation/scale, rig location
  doc.setFCurve(
    keyed(cube, 'location', 0, [
      [1, 1],
      [11, 3],
    ]),
  );
  doc.setFCurve(
    keyed(cube, 'rotation_euler', 2, [
      [1, 0],
      [11, 1.2],
    ]),
  );
  doc.setFCurve(
    keyed(cube, 'scale', 1, [
      [1, 0.5],
      [11, 1],
    ]),
  );
  doc.setFCurve(
    keyed(rig, 'location', 2, [
      [1, 3],
      [11, 4],
    ]),
  );
  return { doc, ids: { rig, cube, sphere, camera, ortho, point, spot, marker, sun, area } };
}

describe('glTF export', () => {
  it('writes a structurally valid GLB', () => {
    const { doc } = richScene();
    const out = exportScene(doc, 'glb');
    expect(out.mime).toBe('model/gltf-binary');
    expect(out.extension).toBe('glb');
    expect(sniffFormat(out.data)).toBe('glb');
    const { json, bin } = parseGLB(out.data);
    validateGLTF(json, bin);
    expect(json.nodes).toHaveLength(10);
    // Z-up → Y-up: the root empty at (1, 2, 3) is at (1, 3, -2)
    const rig = json.nodes.find((n: any) => n.name === 'Rig');
    expect(rig.translation).toEqual([1, 3, -2]);
    expect(rig.children.map((c: number) => json.nodes[c].name)).toEqual(['Cube']);
    expect(json.scenes[0].nodes.map((i: number) => json.nodes[i].name).sort()).toEqual([
      'Area',
      'Camera',
      'Point',
      'Rig',
      'Sphere',
      'Spot',
      'Sun',
    ]);
    // one primitive per material group, sharing vertex attributes
    const sphereMesh = json.meshes[json.nodes.find((n: any) => n.name === 'Sphere').mesh];
    expect(sphereMesh.primitives).toHaveLength(2);
    expect(sphereMesh.primitives[0].attributes).toEqual(sphereMesh.primitives[1].attributes);
    expect(sphereMesh.primitives.map((p: any) => json.materials[p.material].name)).toEqual([
      'Paint',
      'Plain',
    ]);
    // lights: candela = W / 4π, sun = lux; area exported as point with a warning
    const lights = json.extensions.KHR_lights_punctual.lights;
    const byName = (n: string) => lights.find((l: any) => l.name === n);
    expect(byName('PointLight')).toMatchObject({
      type: 'point',
      intensity: expect.closeTo(1000 / (4 * Math.PI), 6),
    });
    expect(byName('SpotLight').spot.outerConeAngle).toBeCloseTo(0.5);
    expect(byName('SpotLight').spot.innerConeAngle).toBeCloseTo(0.4);
    expect(byName('SunLight')).toMatchObject({ type: 'directional', intensity: 3 });
    expect(byName('AreaLight').type).toBe('point');
    expect(out.warnings!.some((w) => w.includes('Area light'))).toBe(true);
    // materials
    const paint = json.materials.find((m: any) => m.name === 'Paint');
    expect(paint.pbrMetallicRoughness).toMatchObject({
      baseColorFactor: [0.2, 0.4, 0.6, 1],
      metallicFactor: 0.3,
      roughnessFactor: 0.7,
    });
    expect(paint.emissiveFactor).toEqual([1, 0.5, 0]);
    expect(paint.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(2);
    expect(paint).toMatchObject({ alphaMode: 'MASK', alphaCutoff: 0.3 });
    expect(paint.doubleSided).toBeUndefined();
    expect(json.materials.find((m: any) => m.name === 'Plain')).toMatchObject({
      alphaMode: 'BLEND',
      doubleSided: true,
    });
    // cameras
    const persp = json.cameras.find((c: any) => c.name === 'Cam35');
    expect(persp.type).toBe('perspective');
    expect(persp.perspective.aspectRatio).toBeCloseTo(16 / 9);
    const orthoCam = json.cameras.find((c: any) => c.name === 'OrthoCam');
    expect(orthoCam.orthographic.xmag).toBeCloseTo(5);
    expect(orthoCam.orthographic.ymag).toBeCloseTo(5 / (16 / 9));
    // animation sampled per frame over the scene range
    const anim = json.animations[0];
    const cubeNode = json.nodes.findIndex((n: any) => n.name === 'Cube');
    expect(
      anim.channels
        .filter((c: any) => c.target.node === cubeNode)
        .map((c: any) => c.target.path)
        .sort(),
    ).toEqual(['rotation', 'scale', 'translation']);
    const input = json.accessors[anim.samplers[0].input];
    expect(input.count).toBe(11);
    expect(input.max[0]).toBeCloseTo(10 / 24);
    for (const s of anim.samplers) expect(s.interpolation).toBe('LINEAR');
    const rot = anim.channels.find((c: any) => c.target.node === cubeNode && c.target.path === 'rotation');
    const q = accessorData(json, bin, anim.samplers[rot.sampler].output);
    for (let i = 0; i < q.length; i += 4)
      expect(Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3])).toBeCloseTo(1, 5);
  });

  it('embeds the buffer as a data URI for .gltf', () => {
    const { doc } = richScene();
    const out = exportScene(doc, 'gltf');
    expect(out.mime).toBe('model/gltf+json');
    const json = JSON.parse(new TextDecoder().decode(out.data));
    expect(json.buffers[0].uri.startsWith('data:application/octet-stream;base64,')).toBe(true);
    expect(sniffFormat(out.data)).toBe('gltf');
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'gltf', out.data);
    expect(res.objects).toHaveLength(10);
  });

  it('roots objects whose parent is not exported at their world transform', () => {
    const { doc, ids } = richScene();
    const out = exportScene(doc, 'glb', { objectIds: [ids.cube, ids.ortho] });
    const { json } = parseGLB(out.data);
    expect(json.nodes.map((n: any) => n.name)).toEqual(['Cube', 'Ortho']);
    expect(json.scenes[0].nodes).toEqual([0]);
    const doc2 = SceneDoc.create({ empty: true });
    importFile(doc2, 'glb', out.data);
    const cube2 = doc2.findObjectByName('Cube')!;
    expect(cube2.parent).toBeNull();
    expectMatrixClose(doc.worldMatrix(ids.cube), doc2.worldMatrix(cube2.id));
    expectMatrixClose(doc.worldMatrix(ids.ortho), doc2.worldMatrix(doc2.findObjectByName('Ortho')!.id));
  });
});

describe('glTF round trip', () => {
  it('preserves transforms, hierarchy, materials, lights, cameras and animation', () => {
    const { doc, ids } = richScene();
    const out = exportScene(doc, 'glb');
    const doc2 = SceneDoc.create({ empty: true });
    const res = importFile(doc2, 'glb', out.data);
    expect(res.objects).toHaveLength(10);
    const find = (name: string) => doc2.findObjectByName(name)!;
    // hierarchy + world transforms (cameras and lights keep their -Z viewing axis)
    expect(find('Cube').parent).toBe(find('Rig').id);
    expect(find('Ortho').parent).toBe(find('Cube').id);
    expect(find('Marker').parent).toBe(find('Spot').id);
    for (const [name, id] of Object.entries(ids)) {
      const o2 = doc2.findObjectByName(name[0].toUpperCase() + name.slice(1))!;
      expect(o2, name).toBeTruthy();
      expect(o2.type).toBe(doc.getObject(id)!.type === 'LIGHT' ? 'LIGHT' : doc.getObject(id)!.type);
      expectMatrixClose(doc.worldMatrix(id), doc2.worldMatrix(o2.id));
    }
    // mesh data
    const cubeMesh = doc2.getMesh(find('Cube').data!)!;
    expect(cubeMesh.positions.length / 3).toBe(24); // split at UV seams / hard edges
    expect(cubeMesh.faces).toHaveLength(12);
    expect(cubeMesh.faceSmooth.every((s) => !s)).toBe(true);
    const sphere2 = doc2.getMesh(find('Sphere').data!)!;
    expect(sphere2.faceSmooth.every((s) => s)).toBe(true);
    expect(new Set(sphere2.faceMaterials)).toEqual(new Set([0, 1]));
    expect(find('Sphere').material_slots.map((m) => doc2.getMaterial(m!)!.name)).toEqual(['Paint', 'Plain']);
    // materials
    const paint = doc2.listMaterials().find((m) => m.name === 'Paint')!;
    expect(paint.base_color).toEqual([0.2, 0.4, 0.6, 1]);
    expect(paint.metallic).toBeCloseTo(0.3);
    expect(paint.roughness).toBeCloseTo(0.7);
    expect(paint.emission_color).toEqual([1, 0.5, 0]);
    expect(paint.emission_strength).toBe(2);
    expect(paint.blend_method).toBe('CLIP');
    expect(paint.alpha_threshold).toBeCloseTo(0.3);
    expect(paint.use_backface_culling).toBe(true);
    expect(paint.transmission).toBeCloseTo(0.5);
    expect(paint.ior).toBeCloseTo(1.33);
    expect(paint.coat_weight).toBeCloseTo(0.4);
    expect(paint.coat_roughness).toBeCloseTo(0.1);
    const plain = doc2.listMaterials().find((m) => m.name === 'Plain')!;
    expect(plain.alpha).toBeCloseTo(0.5);
    expect(plain.blend_method).toBe('BLEND');
    expect(plain.use_backface_culling).toBe(false);
    // lights
    const light = (name: string) => doc2.getLight(find(name).data!)!;
    expect(light('Point')).toMatchObject({
      type: 'POINT',
      energy: expect.closeTo(1000, 6),
      color: [1, 0.9, 0.8],
    });
    expect(light('Spot')).toMatchObject({
      type: 'SPOT',
      energy: expect.closeTo(500, 6),
      spot_size: expect.closeTo(1, 6),
      spot_blend: expect.closeTo(0.2, 6),
    });
    expect(light('Sun')).toMatchObject({ type: 'SUN', energy: 3 });
    expect(light('Area').type).toBe('POINT');
    // cameras
    const cam = (name: string) => doc2.getCamera(find(name).data!)!;
    expect(cam('Camera')).toMatchObject({ type: 'PERSP', lens: expect.closeTo(35, 6) });
    expect(cam('Ortho')).toMatchObject({ type: 'ORTHO', ortho_scale: expect.closeTo(10, 6) });
    expect(doc2.getScene().camera).toBeTruthy();
    // animation: evaluated world matrices match at sampled frames
    const ev1 = new SceneEvaluator(doc);
    const ev2 = new SceneEvaluator(doc2);
    for (const frame of [1, 4, 8, 11]) {
      const a = ev1.evaluate(frame);
      const b = ev2.evaluate(frame);
      for (const name of ['Rig', 'Cube', 'Ortho']) {
        const wa = a.objects.find((o) => o.name === name)!.worldMatrix;
        const wb = b.objects.find((o) => o.name === name)!.worldMatrix;
        expectMatrixClose(wa, wb, 4);
      }
    }
    const curves = doc2.listFCurves(find('Cube').id);
    expect(curves.map((c) => `${c.path}${c.index}`).sort()).toEqual([
      'location0',
      'location1',
      'location2',
      'rotation_euler0',
      'rotation_euler1',
      'rotation_euler2',
      'scale0',
      'scale1',
      'scale2',
    ]);
    expect(curves[0].keyframes).toHaveLength(11);
    expect(curves[0].keyframes[10].frame).toBeCloseTo(11, 4);
  });

  it('round-trips vertex colors and embedded PNG textures', () => {
    const doc = SceneDoc.create({ empty: true });
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const png = encodePNG({ width: 2, height: 2, data: px });
    const img = doc.addImage({ name: 'Checker', mime: 'image/png', width: 2, height: 2, data: png });
    const mat = doc.addMaterial({
      name: 'Textured',
      textures: { base_color: { image: img, scale: [2, 2], offset: [0, 0] } },
    });
    const mesh = createCube();
    mesh.colors = [];
    for (let i = 0; i < 8; i++) mesh.colors.push(i / 8, 1 - i / 8, 0.5, 1);
    doc.addObject({ type: 'MESH', name: 'Box', data: doc.addMesh('Box', mesh), material_slots: [mat] });
    const out = exportScene(doc, 'glb');
    const { json, bin } = parseGLB(out.data);
    validateGLTF(json, bin);
    expect(json.images[0].mimeType).toBe('image/png');
    expect(json.extensionsUsed).toContain('KHR_texture_transform');
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform).toEqual({
      offset: [0, -1],
      scale: [2, 2],
    });
    const doc2 = SceneDoc.create({ empty: true });
    importFile(doc2, 'glb', out.data);
    const images = doc2.listImages();
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ name: 'Checker', mime: 'image/png', width: 2, height: 2 });
    expect(doc2.getImageBytes(images[0].id)).toEqual(png);
    const m2 = doc2.listMaterials()[0];
    expect(m2.textures.base_color).toEqual({ image: images[0].id, scale: [2, 2], offset: [0, 0] });
    const box = doc2.getMesh(doc2.findObjectByName('Box')!.data!)!;
    expect(box.colors).not.toBeNull();
    // every face corner keeps its source vertex color
    const src = createCube();
    for (let f = 0; f < box.faces.length; f++)
      for (const v of box.faces[f]) {
        const p = box.positions.slice(v * 3, v * 3 + 3);
        const sv = [...Array(8).keys()].find((i) =>
          src.positions.slice(i * 3, i * 3 + 3).every((x, k) => Math.abs(x - p[k]) < 1e-6),
        )!;
        expect(box.colors!.slice(v * 4, v * 4 + 4).map((c) => +c.toFixed(5))).toEqual(
          mesh.colors.slice(sv * 4, sv * 4 + 4).map((c) => +c.toFixed(5)),
        );
      }
  });
});

describe('glTF import', () => {
  it('reads hand-written files with matrix nodes and non-indexed geometry', () => {
    const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(positions.buffer)));
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Tri', mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          emissiveFactor: [1, 1, 0],
          extensions: { KHR_materials_emissive_strength: { emissiveStrength: 5 } },
        },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      ],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64}` }],
    };
    const doc = SceneDoc.create({ empty: true });
    const res = importFile(doc, 'gltf', new TextEncoder().encode(JSON.stringify(gltf)), {
      location: [10, 0, 0],
    });
    expect(res.objects).toHaveLength(1);
    const o = doc.getObject(res.objects[0])!;
    // glTF translation (0, 1, 0) is Z-up (0, 0, 1), plus the import offset
    expect(o.location.map((v) => +v.toFixed(6))).toEqual([10, 0, 1]);
    const m = doc.getMesh(o.data!)!;
    expect(m.positions.map((v) => +v.toFixed(6))).toEqual([1, 0, 0, 0, 0, 1, 0, -1, 0]);
    expect(m.faces).toEqual([[0, 1, 2]]);
    const mat = doc.getMaterial(o.material_slots[0]!)!;
    expect(mat.emission_strength).toBe(5);
    expect(mat.emission_color).toEqual([1, 1, 0]);
  });

  it('rejects unsupported required extensions and invalid files', () => {
    const doc = SceneDoc.create({ empty: true });
    const draco = { asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] };
    expect(() => importFile(doc, 'gltf', new TextEncoder().encode(JSON.stringify(draco)))).toThrow(
      /compressed geometry/,
    );
    expect(() => importFile(doc, 'gltf', new TextEncoder().encode('{"asset":{"version":"1.0"}}'))).toThrow(
      /version/,
    );
    expect(() => importFile(doc, 'gltf', new TextEncoder().encode('not json'))).toThrow(/Invalid glTF JSON/);
    expect(doc.listObjects()).toHaveLength(0);
  });
});

describe('glTF import edge cases', () => {
  const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  it('handles empty scenes and missing external buffers', () => {
    const empty = SceneDoc.create({ empty: true });
    for (const f of ['glb', 'gltf'] as const) {
      const out = exportScene(empty, f);
      expect(importFile(SceneDoc.create({ empty: true }), f, out.data).objects).toEqual([]);
    }
    const file = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { name: 'M', mesh: 0 },
        { name: 'C', camera: 0 },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      cameras: [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36, uri: 'geo.bin' }],
    };
    const doc = SceneDoc.create({ empty: true });
    const res = importFile(doc, 'gltf', json(file));
    expect(res.warnings.some((w) => w.includes("'geo.bin'"))).toBe(true);
    expect(doc.listObjects().map((o) => `${o.type}:${o.name}`)).toEqual(['CAMERA:C', 'EMPTY:M']);
    const doc2 = SceneDoc.create({ empty: true });
    const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    expect(importFile(doc2, 'gltf', json(file), { files: { 'geo.bin': bin } }).warnings).toEqual([]);
    expect(doc2.findObjectByName('M')!.type).toBe('MESH');
  });

  it('reads sparse and normalized accessors, triangle strips and STEP/CUBICSPLINE animation', () => {
    const buf = new ArrayBuffer(256);
    const dv = new DataView(buf);
    let o = 0;
    const f32 = (...v: number[]) => {
      const s = o;
      for (const x of v) {
        dv.setFloat32(o, x, true);
        o += 4;
      }
      return s;
    };
    const pos = f32(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0);
    const uv = o;
    for (const v of [0, 0, 65535, 0, 0, 65535, 65535, 65535]) {
      dv.setUint16(o, v, true);
      o += 2;
    }
    const times = f32(0, 1, 2);
    const steps = f32(0, 0, 0, 1, 0, 0, 2, 0, 0);
    const cubic = f32(0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0);
    const spIdx = o;
    dv.setUint16(o, 1, true);
    o += 4;
    const spVal = f32(0, 0, 7);
    const bytes = new Uint8Array(buf, 0, o);
    const file = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Strip', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, mode: 5 }] }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: pos,
          componentType: 5126,
          count: 4,
          type: 'VEC3',
          sparse: {
            count: 1,
            indices: { bufferView: 0, byteOffset: spIdx, componentType: 5123 },
            values: { bufferView: 0, byteOffset: spVal },
          },
        },
        { bufferView: 0, byteOffset: uv, componentType: 5123, normalized: true, count: 4, type: 'VEC2' },
        {
          bufferView: 0,
          byteOffset: times,
          componentType: 5126,
          count: 3,
          type: 'SCALAR',
          min: [0],
          max: [2],
        },
        { bufferView: 0, byteOffset: steps, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 0, byteOffset: cubic, componentType: 5126, count: 9, type: 'VEC3' },
      ],
      bufferViews: [{ buffer: 0, byteLength: bytes.length }],
      buffers: [
        {
          byteLength: bytes.length,
          uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`,
        },
      ],
      animations: [
        {
          channels: [
            { sampler: 0, target: { node: 0, path: 'translation' } },
            { sampler: 1, target: { node: 0, path: 'scale' } },
          ],
          samplers: [
            { input: 2, output: 3, interpolation: 'STEP' },
            { input: 2, output: 4, interpolation: 'CUBICSPLINE' },
          ],
        },
      ],
    };
    const doc = SceneDoc.create({ empty: true });
    doc.updateScene({ fps: 24, frame_start: 1 });
    const res = importFile(doc, 'gltf', json(file));
    const ob = doc.getObject(res.objects[0])!;
    const m = doc.getMesh(ob.data!)!;
    expect(m.faces).toEqual([
      [0, 1, 2],
      [2, 1, 3],
    ]);
    // sparse override of vertex 1: glTF (0, 0, 7) → Z-up (0, -7, 0)
    expect(m.positions.slice(3, 6).map((v) => v + 0)).toEqual([0, -7, 0]);
    // normalized UNSIGNED_SHORT UVs, V flipped back
    expect(m.uvs![0]).toEqual([0, 1, 1, 1, 0, 0]);
    const fc = (path: string, index: number) =>
      doc.listFCurves(ob.id).find((c) => c.path === path && c.index === index)!;
    expect(fc('location', 0).keyframes.map((k) => [k.frame, k.value, k.interpolation])).toEqual([
      [1, 0, 'CONSTANT'],
      [25, 1, 'CONSTANT'],
      [49, 2, 'CONSTANT'],
    ]);
    // CUBICSPLINE: only the values (middle of each in/value/out triple) are used; glTF Z → editor Y scale
    expect(fc('scale', 1).keyframes.map((k) => k.value)).toEqual([1, 5, 10]);
  });
});
