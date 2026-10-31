import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createPlane,
  createUVSphere,
  defaultProcedural,
  renderSceneSoftware,
  sampleProcedural,
  type MaterialData,
  type ProceduralTexture,
  type RenderedImage,
  type TextureSlot,
  type Vec3,
} from '../src';
import { linearToSrgb } from '../src/render/color';

function slot(p: ProceduralTexture): TextureSlot {
  return { image: '', scale: [1, 1], offset: [0, 0], procedural: p };
}

const px = (img: RenderedImage, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

/** A 2 × 2 m plane at z = 0 seen from straight above; the centre pixel (33 × 33) looks at `target`. */
function planeScene(material: Partial<MaterialData>, opts: { modifiers?: boolean } = {}) {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ color: [0, 0, 0] });
  const mesh = doc.addMesh('Plane', createPlane({ size: 2 }));
  const mat = doc.addMaterial({ name: 'M', ...material });
  doc.addObject({
    type: 'MESH',
    name: 'Plane',
    data: mesh,
    material_slots: [mat],
    modifiers: opts.modifiers
      ? [
          {
            id: 'arr',
            name: 'Array',
            type: 'ARRAY',
            show_viewport: true,
            show_render: true,
            show_in_editmode: true,
            show_expanded: true,
            params: { count: 2 },
          },
        ]
      : [],
  });
  return { doc, mat };
}

const render = (doc: SceneDoc, target: Vec3, size = 33) =>
  renderSceneSoftware(doc, {
    width: size,
    height: size,
    samples: 1,
    view: { position: [target[0], target[1], 4], target, up: [0, 1, 0], fovY: 0.6 },
  });

/** Emission-only material: the pixel colour is exactly the procedural colour. */
const emissive = (p: ProceduralTexture): Partial<MaterialData> => ({
  base_color: [0, 0, 0, 1],
  roughness: 1,
  emission_strength: 1,
  textures: { emission: slot(p) },
});

function expectPixel(img: RenderedImage, x: number, y: number, linear: readonly number[], tol = 2) {
  const p = px(img, x, y);
  for (let k = 0; k < 3; k++)
    expect(Math.abs(p[k] - Math.round(linearToSrgb(linear[k]) * 255))).toBeLessThanOrEqual(tol);
}

describe('CPU renderer: procedural textures', () => {
  it('renders the procedural colour of the shaded point (GENERATED mapping)', () => {
    const tex = defaultProcedural('NOISE', {
      scale: 3,
      detail: 3,
      color_a: [0.1, 0.2, 0.9, 1],
      color_b: [0.9, 0.6, 0.1, 1],
    });
    const { doc } = planeScene(emissive(tex));
    for (const target of [
      [0.3, 0.2, 0],
      [-0.6, 0.45, 0],
    ] as Vec3[]) {
      const img = render(doc, target);
      // plane bounds [-1, 1]² × {0}: GENERATED = ((x + 1) / 2, (y + 1) / 2, 0.5)
      const c = sampleProcedural(tex, [(target[0] + 1) / 2, (target[1] + 1) / 2, 0.5]);
      expectPixel(img, 16, 16, c);
    }
  });

  it('uses the base mesh bounds as GENERATED texture space (modifiers do not shift it)', () => {
    const tex = defaultProcedural('GRADIENT', { color_a: [0, 0, 0, 1], color_b: [1, 1, 1, 1] });
    const { doc } = planeScene(emissive(tex), { modifiers: true });
    // the array copy spans x ∈ [1, 3]; on its left part x = 1.5 → GENERATED x = 1.25 → clamped to 1
    const img = render(doc, [0.5, 0, 0]);
    expectPixel(img, 16, 16, sampleProcedural(tex, [0.75, 0.5, 0.5]));
    const copy = render(doc, [1.5, 0, 0]);
    expectPixel(copy, 16, 16, [1, 1, 1]);
  });

  it('supports UV and OBJECT mappings', () => {
    // (channels away from 0: the dim studio ambient would shift pure black by a few sRGB levels)
    const uvTex = defaultProcedural('CHECKER', {
      mapping: 'UV',
      scale: 4,
      color_a: [1, 0.1, 0.1, 1],
      color_b: [0.1, 0.1, 1, 1],
    });
    const objTex = defaultProcedural('WAVE', {
      mapping: 'OBJECT',
      scale: 0.5,
      color_a: [0.1, 0.1, 0.1, 1],
      color_b: [0.1, 1, 0.1, 1],
    });
    const target: Vec3 = [0.37, -0.21, 0];
    const a = planeScene(emissive(uvTex));
    // createPlane UVs span the plane: u = (x + 1) / 2, v = (y + 1) / 2
    expectPixel(render(a.doc, target), 16, 16, sampleProcedural(uvTex, [(0.37 + 1) / 2, (-0.21 + 1) / 2, 0]));
    const b = planeScene(emissive(objTex));
    expectPixel(render(b.doc, target), 16, 16, sampleProcedural(objTex, target));
  });

  it('differs from a flat material and is deterministic', () => {
    const flat = planeScene({ base_color: [0.5, 0.5, 0.5, 1] });
    const tex = defaultProcedural('CHECKER', {
      scale: 4,
      color_a: [0.9, 0.9, 0.9, 1],
      color_b: [0.05, 0.05, 0.05, 1],
    });
    const proc = planeScene({ base_color: [0.5, 0.5, 0.5, 1], textures: { base_color: slot(tex) } });
    const a = render(flat.doc, [0, 0, 0], 48);
    const b = render(proc.doc, [0, 0, 0], 48);
    const distinct = (img: RenderedImage) => {
      const s = new Set<string>();
      for (let i = 0; i < img.data.length; i += 4)
        s.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
      return s.size;
    };
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
    expect(distinct(b)).toBeGreaterThan(distinct(a));
    expect(Buffer.from(render(proc.doc, [0, 0, 0], 48).data).equals(Buffer.from(b.data))).toBe(true);
    // SOLID shading uses the flat viewport colour (no procedural evaluation)
    const solid = (doc: SceneDoc) =>
      renderSceneSoftware(doc, {
        width: 24,
        height: 24,
        samples: 1,
        shading: 'SOLID',
        view: { position: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0] },
      });
    expect(Buffer.from(solid(flat.doc).data).equals(Buffer.from(solid(proc.doc).data))).toBe(true);
  });

  it('drives roughness, metallic and alpha per sample', () => {
    const checker = (a: number, b: number) =>
      slot(defaultProcedural('CHECKER', { scale: 4, color_a: [a, a, a, 1], color_b: [b, b, b, 1] }));
    const base = { base_color: [0.8, 0.2, 0.1, 1] as MaterialData['base_color'] };
    const plain = render(planeScene(base).doc, [0, 0, 0], 48);
    for (const textures of [{ roughness: checker(0.05, 1) }, { metallic: checker(0, 1) }]) {
      const img = render(planeScene({ ...base, textures }).doc, [0, 0, 0], 48);
      expect(Buffer.from(img.data).equals(Buffer.from(plain.data))).toBe(false);
    }
    // alpha clip: half of the checker cells show the background
    const clipped = render(
      planeScene({ ...base, blend_method: 'CLIP', alpha_threshold: 0.5, textures: { alpha: checker(1, 0) } })
        .doc,
      [0, 0, 0],
      48,
    );
    const bg = px(clipped, 0, 0);
    let holes = 0;
    for (let y = 12; y < 36; y++)
      for (let x = 12; x < 36; x++) if (px(clipped, x, y).every((v, k) => v === bg[k])) holes++;
    expect(holes / (24 * 24)).toBeGreaterThan(0.3);
    expect(holes / (24 * 24)).toBeLessThan(0.7);
  });

  it('bumps the shading normal from the height (normal channel)', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateWorld({ color: [0, 0, 0] });
    const sun = doc.addLight({ type: 'SUN', energy: 3 });
    doc.addObject({ type: 'LIGHT', name: 'Sun', data: sun, rotation_euler: [0.9, 0, 0.4] });
    const sphere = doc.addMesh('Sphere', createUVSphere({ radius: 1, segments: 48, ring_count: 24 }));
    const bumpTex = defaultProcedural('NOISE', {
      scale: 4,
      detail: 2,
      color_a: [0, 0, 0, 1],
      color_b: [1, 1, 1, 1],
    });
    const mat = doc.addMaterial({ name: 'M', roughness: 0.8 });
    doc.addObject({ type: 'MESH', name: 'Sphere', data: sphere, material_slots: [mat] });
    const view = { position: [0, -4, 0.5] as Vec3, target: [0, 0, 0] as Vec3 };
    const smooth = renderSceneSoftware(doc, { width: 48, height: 48, samples: 1, view });
    doc.updateMaterial(mat, { textures: { normal: slot({ ...bumpTex, params: { bump_distance: 0.3 } }) } });
    const bumped = renderSceneSoftware(doc, { width: 48, height: 48, samples: 1, view });
    // neighbouring-pixel variation is much larger with the bump
    const roughness = (img: RenderedImage) => {
      let s = 0;
      for (let y = 16; y < 32; y++)
        for (let x = 16; x < 31; x++) s += Math.abs(px(img, x, y)[0] - px(img, x + 1, y)[0]);
      return s;
    };
    expect(roughness(bumped)).toBeGreaterThan(2 * roughness(smooth) + 20);
    // bump_distance 0 (or normal_strength 0) leaves the shading untouched
    doc.updateMaterial(mat, { normal_strength: 0 });
    const flat = renderSceneSoftware(doc, { width: 48, height: 48, samples: 1, view });
    expect(Buffer.from(flat.data).equals(Buffer.from(smooth.data))).toBe(true);
  });
});
