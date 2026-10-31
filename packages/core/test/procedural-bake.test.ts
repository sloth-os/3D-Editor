import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  bakeMaterialTextures,
  bakeNormalMap,
  bakeProcedural,
  compileProcedural,
  createCube,
  createPlane,
  decodePNG,
  defaultMaterial,
  defaultProcedural,
  exportScene,
  proceduralBakeNeedsGeometry,
  sampleProcedural,
  type MaterialData,
  type ProceduralTexture,
  type TextureSlot,
} from '../src';
import { linearToSrgb } from '../src/render/color';
import { readGLB } from '../src/io/glb';

const slot = (p: ProceduralTexture): TextureSlot => ({
  image: '',
  scale: [1, 1],
  offset: [0, 0],
  procedural: p,
});
const srgb = (v: number) => Math.round(linearToSrgb(v) * 255);
const texel = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

describe('bakeProcedural', () => {
  const noise = defaultProcedural('NOISE', {
    mapping: 'UV',
    scale: 3,
    color_a: [0.1, 0.2, 0.8, 1],
    color_b: [0.9, 0.5, 0.1, 1],
  });

  it('samples UV-mapped textures at every texel centre (row 0 = v 1, sRGB)', () => {
    const img = bakeProcedural(compileProcedural(noise), null, { width: 32, height: 16 })!;
    expect(img.width).toBe(32);
    expect(img.height).toBe(16);
    for (const [x, y] of [
      [0, 0],
      [31, 15],
      [7, 9],
    ]) {
      const c = sampleProcedural(noise, [(x + 0.5) / 32, 1 - (y + 0.5) / 16, 0]);
      expect(texel(img, x, y)).toEqual([srgb(c[0]), srgb(c[1]), srgb(c[2]), Math.round(c[3] * 255)]);
    }
    const lin = bakeProcedural(compileProcedural(noise), null, { width: 8, srgb: false })!;
    const c = sampleProcedural(noise, [0.5 / 8, 1 - 0.5 / 8, 0]);
    expect(texel(lin, 0, 0)[0]).toBe(Math.round(c[0] * 255));
    expect(lin.height).toBe(8);
  });

  it('needs a UV-mapped mesh for GENERATED/OBJECT mappings', () => {
    const gen = compileProcedural(defaultProcedural('CHECKER'));
    expect(bakeProcedural(gen, null, { width: 8 })).toBeNull();
    const noUv = { ...createPlane({ size: 2 }), uvs: null };
    expect(bakeProcedural(gen, { mesh: noUv }, { width: 8 })).toBeNull();
  });

  it('bakes GENERATED textures through the UV layout of the mesh', () => {
    const tex = defaultProcedural('GRADIENT', { params: { gradient_type: 'DIAGONAL' } });
    const img = bakeProcedural(compileProcedural(tex), { mesh: createPlane({ size: 2 }) }, { width: 16 })!;
    // the plane's UVs span it: texel (u, v) ↔ position (2u − 1, 2v − 1, 0) ↔ GENERATED (u, v, 0.5)
    for (const [x, y] of [
      [3, 4],
      [12, 1],
      [8, 15],
    ]) {
      const u = (x + 0.5) / 16;
      const v = 1 - (y + 0.5) / 16;
      const c = sampleProcedural(tex, [u, v, 0.5]);
      expect(texel(img, x, y)[0]).toBe(srgb(c[0]));
    }
  });

  it('dilates islands and fills the unused texture area', () => {
    const tex = defaultProcedural('CHECKER', { scale: 2, color_a: [1, 0, 0, 1], color_b: [0, 0, 1, 1] });
    const img = bakeProcedural(
      compileProcedural(tex),
      { mesh: createCube({ size: 2 }) },
      { width: 64, padding: 2 },
    )!;
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
    // every texel is red, blue or a blend of them (no black background)
    for (let i = 0; i < img.data.length; i += 4) expect(img.data[i] + img.data[i + 2]).toBeGreaterThan(100);
  });

  it('clamps sizes', () => {
    const img = bakeProcedural(compileProcedural(noise), null, { width: 0, height: 5000 })!;
    expect(img.width).toBe(1);
    expect(img.height).toBe(4096);
  });
});

describe('bakeNormalMap', () => {
  it('is flat for a constant height and tilts against the height gradient', () => {
    const plane = { mesh: createPlane({ size: 2 }) };
    const constant = defaultProcedural('CHECKER', {
      color_a: [0.4, 0.4, 0.4, 1],
      color_b: [0.4, 0.4, 0.4, 1],
    });
    const flat = bakeNormalMap(compileProcedural(constant), 0.5, plane, { width: 16 })!;
    for (let i = 0; i < flat.data.length; i += 4)
      expect([...flat.data.subarray(i, i + 3)]).toEqual([128, 128, 255]);
    // height = u (UV mapping, GRADIENT LINEAR), plane metric |∂P/∂u| = 2 m → slope = d / 2
    const d = 0.8;
    const ramp = compileProcedural(defaultProcedural('GRADIENT', { mapping: 'UV' }));
    const img = bakeNormalMap(ramp, d, plane, { width: 16 })!;
    const l = Math.hypot(d / 2, 1);
    const expected = [
      Math.round(((-d / 2 / l) * 0.5 + 0.5) * 255),
      128,
      Math.round(((1 / l) * 0.5 + 0.5) * 255),
    ];
    for (const [x, y] of [
      [4, 4],
      [10, 12],
    ])
      texel(img, x, y)
        .slice(0, 3)
        .forEach((v, k) => expect(Math.abs(v - expected[k])).toBeLessThanOrEqual(1));
    // the same height through GENERATED coordinates on the plane gives the same normals
    const gen = compileProcedural(defaultProcedural('GRADIENT'));
    const img2 = bakeNormalMap(gen, d, plane, { width: 16 })!;
    texel(img2, 6, 6)
      .slice(0, 3)
      .forEach((v, k) => expect(Math.abs(v - expected[k])).toBeLessThanOrEqual(1));
    // along +V (green): height = v
    const vRamp = compileProcedural(
      defaultProcedural('GRADIENT', { mapping: 'UV', params: { gradient_type: 'DIAGONAL' } }),
    );
    const img3 = bakeNormalMap(vRamp, d, plane, { width: 16 })!;
    const t3 = texel(img3, 8, 8);
    expect(t3[0]).toBe(t3[1]);
    expect(t3[1]).toBeLessThan(128);
  });
});

describe('bakeMaterialTextures', () => {
  const material = (patch: Partial<MaterialData>): MaterialData => ({
    ...defaultMaterial('m', 'Mat'),
    ...patch,
  });
  const plane = { mesh: createPlane({ size: 2 }) };

  it('packs base colour + alpha and metallic/roughness like glTF', () => {
    const m = material({
      base_color: [0.3, 0.6, 0.9, 0.5],
      alpha: 0.4,
      metallic: 0.25,
      roughness: 0.75,
      textures: {
        alpha: slot(
          defaultProcedural('CHECKER', {
            mapping: 'UV',
            scale: 2,
            color_a: [1, 1, 1, 1],
            color_b: [0.2, 0.2, 0.2, 1],
          }),
        ),
        roughness: slot(defaultProcedural('GRADIENT', { mapping: 'UV' })),
      },
    });
    const baked = bakeMaterialTextures(m, plane, { width: 8 });
    expect(baked.warnings).toEqual([]);
    // only alpha is procedural: white RGB in the texture, the colour stays a factor; alpha replaces m.alpha
    expect(baked.baseColorFactor).toEqual([0.3, 0.6, 0.9, 0.5]);
    const b0 = texel(baked.baseColor!, 0, 0);
    expect(b0.slice(0, 3)).toEqual([255, 255, 255]);
    expect([255, 51]).toContain(b0[3]);
    const mr = baked.metallicRoughness!;
    const t = texel(mr, 2, 3);
    expect(t[1]).toBe(Math.round(((2 + 0.5) / 8) * 255));
    expect(t[2]).toBe(Math.round(0.25 * 255));
    expect(baked.normal).toBeUndefined();
    expect(baked.emissive).toBeUndefined();
  });

  it('bakes base colour, emission and bump, and reports channels it cannot bake', () => {
    const m = material({
      emission_strength: 2,
      textures: {
        base_color: slot(defaultProcedural('NOISE')),
        emission: slot(defaultProcedural('VORONOI', { mapping: 'UV' })),
        normal: slot(defaultProcedural('NOISE')),
      },
    });
    // invisible channels (no emission strength, zero bump) are not baked
    const invisible = bakeMaterialTextures({ ...m, emission_strength: 0, normal_strength: 0 }, plane, {
      width: 4,
    });
    expect(invisible.emissive).toBeUndefined();
    expect(invisible.normal).toBeUndefined();
    expect(proceduralBakeNeedsGeometry(m)).toBe(true);
    const full = bakeMaterialTextures(m, plane, { width: 8 });
    expect(full.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(full.baseColor && full.emissive && full.normal).toBeTruthy();
    const noUv = bakeMaterialTextures(m, { mesh: { ...plane.mesh, uvs: null } }, { width: 8 });
    expect(noUv.baseColor).toBeUndefined();
    expect(noUv.normal).toBeUndefined();
    expect(noUv.emissive).toBeTruthy();
    expect(noUv.warnings.join('\n')).toMatch(/base_color needs a UV-mapped mesh/);
    expect(noUv.warnings.join('\n')).toMatch(/normal needs a UV-mapped mesh/);
    const uvOnly = material({
      textures: { base_color: slot(defaultProcedural('CHECKER', { mapping: 'UV' })) },
    });
    expect(proceduralBakeNeedsGeometry(uvOnly)).toBe(false);
    expect(proceduralBakeNeedsGeometry(material({}))).toBe(false);
    expect(bakeMaterialTextures(material({}), plane)).toEqual({ warnings: [] });
  });

  it('warns about image/procedural combinations glTF cannot express', () => {
    const m = material({
      textures: {
        base_color: { image: 'img', scale: [1, 1], offset: [0, 0] },
        alpha: slot(defaultProcedural('CHECKER', { mapping: 'UV' })),
        metallic: { image: 'img2', scale: [1, 1], offset: [0, 0] },
        roughness: slot(defaultProcedural('CHECKER', { mapping: 'UV' })),
      },
    });
    const baked = bakeMaterialTextures(m, plane, { width: 4 });
    expect(baked.baseColor).toBeUndefined();
    expect(baked.metallicRoughness).toBeTruthy();
    expect(baked.warnings.join('\n')).toMatch(/procedural alpha cannot be combined/);
    expect(baked.warnings.join('\n')).toMatch(/image metallic texture is replaced/);
  });
});

describe('glTF export of procedural materials', () => {
  function scene() {
    const doc = SceneDoc.create({ empty: true });
    const generated = doc.addMaterial({
      name: 'Gen',
      metallic: 0.3,
      roughness: 0.6,
      textures: {
        base_color: slot(
          defaultProcedural('CHECKER', { scale: 2, color_a: [1, 0, 0, 1], color_b: [0, 1, 0, 1] }),
        ),
        roughness: slot(defaultProcedural('GRADIENT')),
      },
    });
    const uv = doc.addMaterial({
      name: 'Uv',
      textures: { base_color: slot(defaultProcedural('CHECKER', { mapping: 'UV', scale: 4 })) },
    });
    const a = doc.addMesh('A', createCube({ size: 2 }));
    const b = doc.addMesh('B', createPlane({ size: 4 }));
    doc.addObject({ type: 'MESH', name: 'A', data: a, material_slots: [generated] });
    doc.addObject({ type: 'MESH', name: 'B', data: b, material_slots: [generated], location: [5, 0, 0] });
    doc.addObject({ type: 'MESH', name: 'C', data: a, material_slots: [uv], location: [0, 5, 0] });
    doc.addObject({ type: 'MESH', name: 'D', data: b, material_slots: [uv], location: [5, 5, 0] });
    return doc;
  }

  it('embeds baked PNG textures with absolute values and per-mesh materials when needed', () => {
    const res = exportScene(scene(), 'glb', {});
    expect(res.warnings).toEqual([]);
    const { json, bin } = readGLB(res.data);
    const materials = json.materials as { name: string; pbrMetallicRoughness: Record<string, unknown> }[];
    // GENERATED bakes depend on the mesh: two 'Gen' materials; UV bakes are shared: one 'Uv'
    expect(materials.filter((m) => m.name === 'Gen')).toHaveLength(2);
    expect(materials.filter((m) => m.name === 'Uv')).toHaveLength(1);
    const gen = materials.find((m) => m.name === 'Gen')!.pbrMetallicRoughness;
    expect(gen.baseColorFactor).toBeUndefined();
    expect(gen.metallicFactor).toBeUndefined();
    expect(gen.roughnessFactor).toBeUndefined();
    expect(gen.baseColorTexture).toBeTruthy();
    expect(gen.metallicRoughnessTexture).toBeTruthy();
    const images = json.images as { mimeType: string; bufferView: number; name: string }[];
    expect(images.length).toBe(5);
    const views = json.bufferViews as { byteOffset?: number; byteLength: number }[];
    for (const im of images) {
      expect(im.mimeType).toBe('image/png');
      const v = views[im.bufferView];
      const png = decodePNG(bin!.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
      expect(png.width).toBe(512);
      expect(png.height).toBe(512);
    }
    // the metallic/roughness texture stores the material's metallic in B
    const mrIndex = (gen.metallicRoughnessTexture as { index: number }).index;
    const mrImage = images[(json.textures as { source: number }[])[mrIndex].source];
    const v = views[mrImage.bufferView];
    const mr = decodePNG(bin!.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
    expect(mr.data[2]).toBe(Math.round(0.3 * 255));
  });

  it('exports without textures (and with warnings) when a mesh has no UVs', () => {
    const doc = SceneDoc.create({ empty: true });
    const mat = doc.addMaterial({ name: 'Gen', textures: { base_color: slot(defaultProcedural('NOISE')) } });
    const mesh = doc.addMesh('NoUV', { ...createCube({ size: 2 }), uvs: null });
    doc.addObject({ type: 'MESH', name: 'NoUV', data: mesh, material_slots: [mat] });
    const res = exportScene(doc, 'gltf', {});
    expect((res.warnings ?? []).join('\n')).toMatch(/needs a UV-mapped mesh/);
    const json = JSON.parse(new TextDecoder().decode(res.data));
    expect(json.images).toBeUndefined();
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture).toBeUndefined();
  });
});
