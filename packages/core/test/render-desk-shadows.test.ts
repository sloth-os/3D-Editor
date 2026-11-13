import { describe, expect, it } from 'vitest';
import { invert4 } from '../src/math/mat4';
import {
  SceneDoc,
  createCube,
  createPlane,
  defaultProcedural,
  encodePNG,
  renderSceneSoftware,
  type MaterialData,
  type RenderedImage,
  type Vec3,
} from '../src';
import {
  fitSunShadow,
  pixelHash,
  buildSpotShadow,
  buildSunShadow,
  shadowVisibility,
} from '../src/render/shadows';
import type { Bounds, RenderView } from '../src/render/view';
import { viewFromSpec } from '../src/render/view';
import {
  boxOverGround,
  deskScene,
  imageHash,
  luma,
  planarDepth,
  projectToPixel,
  samePixel,
  type TestLight,
} from './render-desk-helpers';

const deg = (d: number) => (d * Math.PI) / 180;
const W = 128;
const H = 96;

/** A sun tilted 30° from vertical: light travels along (0, 0.5, −0.866) (towards +Y). */
const SUN: TestLight = { data: { type: 'SUN', energy: 3 }, location: [0, 0, 6], rotation: [deg(30), 0, 0] };
/** A spot 4 m above the ground shining straight down, cone 100°, 5 cm emitter. */
const SPOT: TestLight = {
  data: { type: 'SPOT', energy: 1000, spot_size: deg(100), spot_blend: 0.1, shadow_soft_size: 0.05 },
  location: [0, 0, 4],
};

/** Renders a scene with and without shadows (with the depth pass, for the view and visibility). */
function pair(build: ReturnType<typeof boxOverGround>, shadows: true | 'scene' = true) {
  const opts = { width: W, height: H, samples: 2, aovs: ['depth' as const] };
  const off = renderSceneSoftware(build.doc, opts);
  const on = renderSceneSoftware(build.doc, { ...opts, shadows });
  return { off, on };
}

/**
 * Checks ground points on a grid: where `inside(x, y)` they must be in shadow (at most `dark` of
 * their unshadowed brightness), where `outside(x, y)` exactly as without shadows; points hidden from
 * the camera are skipped. Returns how many points each test covered.
 */
function checkGround(
  off: RenderedImage,
  on: RenderedImage,
  inside: (x: number, y: number) => boolean,
  outside: (x: number, y: number) => boolean,
  dark = 0.6,
): { inside: number; outside: number } {
  const view = on.view!;
  const depth = on.aovs!.depth!;
  let nIn = 0;
  let nOut = 0;
  for (let gy = -4; gy <= 4; gy += 0.05)
    for (let gx = -4; gx <= 4; gx += 0.05) {
      const p: Vec3 = [gx, gy, 0];
      const px = projectToPixel(view, p, W, H);
      if (!px) continue;
      const [x, y] = px;
      // visible: the pixel shows the ground at this point (not the cube in front of it)
      const d = planarDepth(view, p);
      if (!(Math.abs(depth[y * W + x] - d) < 0.02 * d)) continue;
      if (inside(gx, gy)) {
        nIn++;
        expect(luma(on, x, y), `shadow at (${gx.toFixed(2)}, ${gy.toFixed(2)})`).toBeLessThan(
          dark * luma(off, x, y),
        );
      } else if (outside(gx, gy)) {
        nOut++;
        expect(samePixel(on, off, x, y), `lit ground at (${gx.toFixed(2)}, ${gy.toFixed(2)})`).toBe(true);
      }
    }
  return { inside: nIn, outside: nOut };
}

/** Whether no pixel got brighter with shadows (they only take light away). */
function neverBrighter(off: RenderedImage, on: RenderedImage): boolean {
  for (let y = 0; y < off.height; y++)
    for (let x = 0; x < off.width; x++) if (luma(on, x, y) > luma(off, x, y) + 0.01) return false;
  return true;
}

describe('sun shadows', () => {
  it('darken the ground where the floating cube blocks the sun and nowhere else (no acne)', () => {
    const { off, on } = pair(boxOverGround([SUN]));
    // the cube (x, y ∈ [−0.5, 0.5], z ∈ [1, 2]) projected along the light: x ∈ [−0.5, 0.5],
    // y ∈ [0.077, 1.655]; checked 0.12 m inside and outside of that footprint
    const counts = checkGround(
      off,
      on,
      (x, y) => Math.abs(x) < 0.38 && y > 0.2 && y < 1.53,
      (x, y) => Math.abs(x) > 0.62 || y < -0.05 || y > 1.78,
    );
    expect(counts.inside).toBeGreaterThan(30);
    expect(counts.outside).toBeGreaterThan(300);
    expect(neverBrighter(off, on)).toBe(true);
  });

  it("'scene' follows the light's use_shadow and render.use_shadows; true forces them", () => {
    const build = boxOverGround([SUN]);
    const base = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2 });
    const scene = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, shadows: 'scene' });
    expect(imageHash(scene)).not.toBe(imageHash(base));
    // the lamp's shadow switched off: 'scene' draws none, true still does
    const lamp = build.doc.getObject(build.ids.Light0)!.data!;
    build.doc.updateLight(lamp, { use_shadow: false });
    expect(
      imageHash(renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, shadows: 'scene' })),
    ).toBe(imageHash(base));
    const forced = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, shadows: true });
    expect(imageHash(forced)).toBe(imageHash(scene));
    // the render setting switched off (lamp on again): 'scene' draws none
    build.doc.updateLight(lamp, { use_shadow: true });
    build.doc.updateRender({ use_shadows: false });
    expect(
      imageHash(renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, shadows: 'scene' })),
    ).toBe(imageHash(base));
  });

  it('the SKY world sun casts shadows', () => {
    const { doc } = deskScene({ segments: 16 });
    const off = renderSceneSoftware(doc, { width: 160, height: 90, samples: 2 });
    for (const shadows of [true, 'scene'] as const) {
      const on = renderSceneSoftware(doc, { width: 160, height: 90, samples: 2, shadows });
      let darker = 0;
      for (let y = 0; y < 90; y++)
        for (let x = 0; x < 160; x++) if (luma(on, x, y) < luma(off, x, y) - 8) darker++;
      // the cubes, spheres and figures throw shadows on the ground (a few hundred pixels)
      expect(darker).toBeGreaterThan(150);
      expect(neverBrighter(off, on)).toBe(true);
    }
  });

  it('glass and alpha-blended surfaces cast no shadow', () => {
    for (const cube of [
      {
        transmission: 1,
        roughness: 0.05,
        ior: 1.45,
        base_color: [0.9, 0.95, 1, 1] as [number, number, number, number],
      },
      { blend_method: 'BLEND' as const, alpha: 0.5 },
    ]) {
      const { off, on } = pair(boxOverGround([SUN], { cube }));
      expect(imageHash(on)).toBe(imageHash(off));
    }
  });

  it('alpha-clipped surfaces cast their clipped shape: holes let the sun through', () => {
    // a 2 m card 1.5 m above the ground whose alpha is a 4 × 4 checker (procedural alpha, or the
    // alpha of a PNG base colour texture as glTF MASK foliage brings), under a sun 25° from
    // vertical; the camera looks at the card's shadow from the side the light goes to
    const png = new Uint8ClampedArray(4 * 4 * 4);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) png.set([60, 160, 60, (i + j) & 1 ? 255 : 0], (j * 4 + i) * 4);
    const cards: { name: string; material: (doc: SceneDoc) => Partial<MaterialData> }[] = [
      {
        name: 'procedural alpha',
        material: () => ({
          textures: {
            alpha: {
              image: '',
              scale: [1, 1],
              offset: [0, 0],
              procedural: defaultProcedural('CHECKER', { scale: 4 }),
            },
          },
        }),
      },
      {
        name: 'texture alpha',
        material: (doc) => ({
          textures: {
            base_color: {
              image: doc.addImage({
                name: 'Leaves',
                mime: 'image/png',
                width: 4,
                height: 4,
                data: encodePNG({ width: 4, height: 4, data: png }),
              }),
              scale: [1, 1],
              offset: [0, 0],
            },
          },
        }),
      },
    ];
    const tilt = deg(25);
    for (const card of cards) {
      const doc = SceneDoc.create({ empty: true });
      doc.updateWorld({ environment: 'NONE', color: [0.03, 0.03, 0.03], strength: 1 });
      doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
      const ground = doc.addMaterial({ name: 'Ground', base_color: [0.6, 0.6, 0.6, 1], roughness: 1 });
      doc.addObject({
        type: 'MESH',
        name: 'Ground',
        data: doc.addMesh('Ground', createPlane({ size: 12 })),
        material_slots: [ground],
      });
      const leafMat = doc.addMaterial({
        name: 'Leaf',
        base_color: [0.2, 0.6, 0.2, 1],
        blend_method: 'CLIP',
        alpha_threshold: 0.5,
        ...card.material(doc),
      });
      const leaf = doc.addObject({
        type: 'MESH',
        name: 'Leaf',
        data: doc.addMesh('Leaf', createPlane({ size: 2 })),
        material_slots: [leafMat],
        location: [0, 0, 1.5],
      });
      doc.addObject({
        type: 'LIGHT',
        name: 'Sun',
        data: doc.addLight({ type: 'SUN', energy: 4 }),
        rotation_euler: [tilt, 0, 0],
      });
      const view = {
        position: [0, 5, 5] as Vec3,
        target: [0, 0.7, 0.4] as Vec3,
        up: [0, 0, 1] as Vec3,
        fovY: deg(50),
      };
      const opts = { width: 160, height: 120, samples: 2, view, aovs: ['depth' as const, 'object' as const] };
      const off = renderSceneSoftware(doc, opts);
      const on = renderSceneSoftware(doc, { ...opts, shadows: true });
      const v = on.view!;
      const { depth, object, objectTable } = on.aovs!;
      const leafIndex = objectTable!.indexOf(leaf);
      // light travels along (0, sin, −cos): the card point (x, y, 1.5) shades the ground at y + 1.5 tan
      const shift = 1.5 * Math.tan(tilt);
      const counts = { open: 0, solid: 0, lit: 0, dark: 0 };
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const cx = -0.75 + 0.5 * i;
          const cy = -0.75 + 0.5 * j;
          // the card itself tells which cells are holes: the camera sees the ground through them
          const at = projectToPixel(v, [cx, cy, 1.5], 160, 120)!;
          const solid = object![at[1] * 160 + at[0]] === leafIndex;
          counts[solid ? 'solid' : 'open']++;
          for (const dx of [-0.1, 0, 0.1])
            for (const dy of [-0.1, 0, 0.1]) {
              const p: Vec3 = [cx + dx, cy + dy + shift, 0];
              const px = projectToPixel(v, p, 160, 120);
              if (!px) continue;
              const d = planarDepth(v, p);
              if (!(Math.abs(depth![px[1] * 160 + px[0]] - d) < 0.02 * d)) continue;
              const where = `${card.name}: cell (${i}, ${j}) at (${p[0].toFixed(2)}, ${p[1].toFixed(2)})`;
              if (solid) {
                counts.dark++;
                expect(luma(on, px[0], px[1]), where).toBeLessThan(0.6 * luma(off, px[0], px[1]));
              } else {
                counts.lit++;
                expect(samePixel(on, off, px[0], px[1]), where).toBe(true);
              }
            }
        }
      expect(counts.open, card.name).toBeGreaterThanOrEqual(6);
      expect(counts.solid, card.name).toBeGreaterThanOrEqual(6);
      expect(counts.lit, card.name).toBeGreaterThan(40);
      expect(counts.dark, card.name).toBeGreaterThan(40);
      expect(neverBrighter(off, on)).toBe(true);
    }
  });

  it('shadowFit gives the same shadows wherever the camera looks from inside the box', () => {
    // camera A looks straight down at the cube's shadow past six small boxes floating just under
    // it, camera B looks at the shadow from the side: fitted to what A sees, A's map would stop
    // short of the ground (the boxes start at 1.3 m, so the shadows reach 4 × 1.3 m); fitted to
    // the box, both cameras use one and the same map
    const build = boxOverGround([SUN]);
    const doc = build.doc;
    const clutterMesh = doc.addMesh('Clutter', createCube({ size: 0.25 }));
    const clutterMat = doc.addMaterial({ name: 'ClutterMat', base_color: [0.3, 0.3, 0.6, 1] });
    for (const [x, dy] of [
      [-0.7, -0.45],
      [-0.7, 0],
      [-0.7, 0.45],
      [0.7, -0.45],
      [0.7, 0],
      [0.7, 0.45],
    ])
      doc.addObject({
        type: 'MESH',
        name: `Clutter${x}${dy}`,
        data: clutterMesh,
        material_slots: [clutterMat],
        location: [x, 0.9 + dy, 4.6],
      });
    const fit: Bounds = { min: [-8, -8, 0], max: [8, 8, 7] };
    const views = {
      A: { position: [0, 0.9, 6] as Vec3, target: [0, 0.9, 0] as Vec3, up: [0, 1, 0] as Vec3, fovY: deg(50) },
      B: { position: [5, -4, 4] as Vec3, target: [0, 0.9, 0] as Vec3, up: [0, 0, 1] as Vec3, fovY: deg(45) },
    };
    for (const v of Object.values(views)) {
      // both cameras inside the box
      for (let k = 0; k < 3; k++) {
        expect(v.position[k]).toBeGreaterThan(fit.min[k]);
        expect(v.position[k]).toBeLessThan(fit.max[k]);
      }
    }
    const shot = (view: (typeof views)['A']) => {
      const opts = { width: W, height: H, samples: 2, view, aovs: ['depth' as const] };
      return {
        off: renderSceneSoftware(doc, opts),
        on: renderSceneSoftware(doc, { ...opts, shadows: true, shadowFit: fit }),
      };
    };
    const a = shot(views.A);
    const b = shot(views.B);
    /** On/off luma ratio at ground point p, or null when the camera does not see p. */
    const ratio = (s: ReturnType<typeof shot>, p: Vec3) => {
      const px = projectToPixel(s.on.view!, p, W, H);
      if (!px) return null;
      const d = planarDepth(s.on.view!, p);
      if (!(Math.abs(s.on.aovs!.depth![px[1] * W + px[0]] - d) < 0.02 * d)) return null;
      return {
        r: luma(s.on, px[0], px[1]) / luma(s.off, px[0], px[1]),
        same: samePixel(s.on, s.off, px[0], px[1]),
      };
    };
    // the cube's shadow on the ground: x ∈ [−0.5, 0.5], y ∈ [0.077, 1.655]; points within 0.12 m of
    // its edge are skipped (a pixel there averages a different stretch of the penumbra per camera)
    let inside = 0;
    let outside = 0;
    for (let gy = -0.8; gy <= 2.6; gy += 0.05)
      for (let gx = -1.4; gx <= 1.4; gx += 0.05) {
        const p: Vec3 = [gx, gy, 0];
        const ra = ratio(a, p);
        const rb = ratio(b, p);
        if (!ra || !rb) continue;
        const where = `(${gx.toFixed(2)}, ${gy.toFixed(2)})`;
        if (Math.abs(gx) < 0.38 && gy > 0.2 && gy < 1.53) {
          inside++;
          expect(rb.r, `shadow seen by B at ${where}`).toBeLessThan(0.6);
          expect(Math.abs(ra.r - rb.r), `on/off ratio at ${where}: A ${ra.r}, B ${rb.r}`).toBeLessThan(0.05);
        } else if (Math.abs(gx) > 0.62 || gy < -0.05 || gy > 1.78) {
          outside++;
          expect(ra.same && rb.same, `lit ground at ${where}`).toBe(true);
        }
      }
    expect(inside).toBeGreaterThan(30);
    expect(outside).toBeGreaterThan(300);
  });

  it('fitSunShadow: without a fit box the map follows the camera, with one it does not', () => {
    const R: Vec3 = [1, 0, 0];
    const U: Vec3 = [0, 1, 0];
    const F: Vec3 = [0, 0, -1];
    const boxes: Bounds[] = [
      { min: [-10, -10, -0.01], max: [10, 10, 0] },
      { min: [-0.5, -0.5, 1], max: [0.5, 0.5, 2] },
    ];
    const fit: Bounds = { min: [-4, -4, 0], max: [4, 4, 3] };
    const near = viewFromSpec(
      { position: [0, -3, 2], target: [0, 0, 0.5], up: [0, 0, 1], fovY: deg(40) },
      1.5,
      null,
    );
    const wide = viewFromSpec(
      { position: [6, 6, 9], target: [0, 0, 0], up: [0, 0, 1], fovY: deg(70) },
      1.5,
      null,
    );
    const fitted = (cam: RenderView, box: Bounds | null) => fitSunShadow(R, U, F, cam, boxes, box, 8, 2048)!;
    expect(fitted(near, null)).not.toEqual(fitted(wide, null));
    expect(fitted(near, fit)).toEqual(fitted(wide, fit));
  });
});

describe('spot shadows', () => {
  it('darken the ground under the cube (perspective projection from the lamp) and nowhere else', () => {
    const { off, on } = pair(boxOverGround([SPOT], { camera: [3.5, -4.5, 4], target: [0, 0, 0.3] }));
    // the cube seen from (0, 0, 4): its top face (z = 2) projects to x, y ∈ [−1, 1]
    const counts = checkGround(
      off,
      on,
      (x, y) => Math.max(Math.abs(x), Math.abs(y)) < 0.85,
      (x, y) => Math.max(Math.abs(x), Math.abs(y)) > 1.2 && Math.hypot(x, y) < 3.5,
    );
    expect(counts.inside).toBeGreaterThan(30);
    expect(counts.outside).toBeGreaterThan(300);
    expect(neverBrighter(off, on)).toBe(true);
  });

  it('a larger emitter widens the penumbra', () => {
    const edge = (soft: number) => {
      const spot = { ...SPOT, data: { ...SPOT.data, shadow_soft_size: soft } };
      const { off, on } = pair(boxOverGround([spot], { camera: [0, -3, 6], target: [0, -0.6, 0] }));
      // pixels partly darkened along the shadow's −Y edge (y ≈ −1)
      let partial = 0;
      const view = on.view!;
      for (let gy = -1.6; gy <= -0.6; gy += 0.01) {
        const px = projectToPixel(view, [0, gy, 0], W, H);
        if (!px) continue;
        const r = luma(on, px[0], px[1]) / Math.max(1, luma(off, px[0], px[1]));
        if (r > 0.15 && r < 0.85) partial++;
      }
      return partial;
    };
    expect(edge(0.6)).toBeGreaterThan(edge(0.02) + 3);
  });
});

describe('lights without shadows', () => {
  it('point and area lights never cast shadows', () => {
    for (const light of [
      { data: { type: 'POINT' as const, energy: 800 }, location: [0, 0, 4] as Vec3 },
      { data: { type: 'AREA' as const, energy: 800, size: 0.5 }, location: [0, 0, 4] as Vec3 },
    ]) {
      const { off, on } = pair(boxOverGround([light]));
      expect(imageHash(on)).toBe(imageHash(off));
    }
  });

  it('the studio rig of a scene without lights is never shadowed', () => {
    const { off, on } = pair(boxOverGround([]));
    expect(imageHash(on)).toBe(imageHash(off));
  });

  it("with a point light about, 'scene' still skips a sun whose use_shadow is off and true does not", () => {
    const build = boxOverGround([
      { ...SUN, data: { ...SUN.data, use_shadow: false } },
      { data: { type: 'POINT', energy: 200 }, location: [2, -2, 3] },
    ]);
    const scene = pair(build, 'scene');
    expect(imageHash(scene.on)).toBe(imageHash(scene.off));
    const forced = pair(build, true);
    expect(imageHash(forced.on)).not.toBe(imageHash(forced.off));
    expect(neverBrighter(forced.off, forced.on)).toBe(true);
  });
});

// ------------------------------------------------------------------------- unit: shadows.ts

/** A ground plane z = 0 and a 1 × 1 m square occluder at z = 1 over the origin, as seen by a depth pass. */
function analyticPass(view: RenderView, w: number, h: number): Float32Array {
  const keys = new Float32Array(w * h);
  const inv = invert4(view.viewProj);
  const F = view.forward;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      // texel centre on the near plane (orthographic: rays along forward)
      const nx = ((i + 0.5) / w) * 2 - 1;
      const ny = 1 - ((j + 0.5) / h) * 2;
      const cw = inv[3] * nx + inv[7] * ny - inv[11] + inv[15];
      const o: Vec3 = [
        (inv[0] * nx + inv[4] * ny - inv[8] + inv[12]) / cw,
        (inv[1] * nx + inv[5] * ny - inv[9] + inv[13]) / cw,
        (inv[2] * nx + inv[6] * ny - inv[10] + inv[14]) / cw,
      ];
      const hit = (z: number) => (z - o[2]) / F[2];
      let t = hit(0);
      const t1 = hit(1);
      const x1 = o[0] + F[0] * t1;
      const y1 = o[1] + F[1] * t1;
      if (Math.abs(x1) <= 0.5 && Math.abs(y1) <= 0.5) t = t1;
      // planar distance from the view's eye plane → orthographic depth key (1 − z_ndc)
      const d = t + (o[0] - view.eye[0]) * F[0] + (o[1] - view.eye[1]) * F[1] + (o[2] - view.eye[2]) * F[2];
      const zNdc = (2 * d - view.far - view.near) / (view.far - view.near);
      keys[j * w + i] = 1 - zNdc;
    }
  return keys;
}

describe('shadow map unit behaviour', () => {
  const camera = viewFromSpec(
    { position: [4, -4, 4], target: [0, 0, 0], up: [0, 0, 1], fovY: deg(40) },
    1.5,
    null,
  );
  const fit: Bounds = { min: [-3, -3, 0], max: [3, 3, 1.2] };

  it('fitSunShadow: square texels, even sizes, centre on the texel grid, the same for any camera with a fit box', () => {
    const R: Vec3 = [1, 0, 0];
    const U: Vec3 = [0, 1, 0];
    const F: Vec3 = [0, 0, -1];
    const a = fitSunShadow(R, U, F, camera, [], fit, 8, 2048)!;
    const other = viewFromSpec(
      { position: [-6, 2, 3], target: [1, 1, 0], up: [0, 0, 1], fovY: deg(60) },
      1,
      null,
    );
    const b = fitSunShadow(R, U, F, other, [], fit, 8, 2048)!;
    expect(b).toEqual(a);
    expect(a.width).toBeLessThanOrEqual(2048);
    expect(a.height).toBeLessThanOrEqual(2048);
    expect(a.width % 2).toBe(0);
    expect(a.height % 2).toBe(0);
    expect(Math.max(a.width, a.height)).toBe(2048);
    expect((a.right - a.left) / a.width).toBeCloseTo(a.texel, 9);
    expect((a.top - a.bottom) / a.height).toBeCloseTo(a.texel, 9);
    // grid-aligned: the edges are whole texels from the origin
    expect(Math.abs(a.left / a.texel - Math.round(a.left / a.texel))).toBeLessThan(1e-6);
    expect(Math.abs(a.bottom / a.texel - Math.round(a.bottom / a.texel))).toBeLessThan(1e-6);
    // covers the fit box (and its depth range along the light)
    expect(a.left).toBeLessThanOrEqual(-3);
    expect(a.right).toBeGreaterThanOrEqual(3);
    expect(a.near).toBeLessThanOrEqual(-1.2);
    expect(a.far).toBeGreaterThanOrEqual(0);
    expect(fitSunShadow(R, U, F, camera, [], null, 8, 2048)).toBeNull();
  });

  it('fitSunShadow without a fit box keeps its texel grid while the camera moves a little', () => {
    const boxes: Bounds[] = [
      { min: [-10, -10, -0.01], max: [10, 10, 0] },
      { min: [-0.5, -0.5, 1], max: [0.5, 0.5, 2] },
    ];
    const R: Vec3 = [1, 0, 0];
    const U: Vec3 = [0, 1, 0];
    const F: Vec3 = [0, 0, -1];
    const at = (x: number) =>
      fitSunShadow(
        R,
        U,
        F,
        viewFromSpec(
          { position: [4 + x, -4, 4], target: [x, 0, 0], up: [0, 0, 1], fovY: deg(40) },
          1.5,
          null,
        ),
        boxes,
        null,
        8,
        2048,
      )!;
    const a = at(0);
    const b = at(0.003);
    // same quantized size: the texels coincide (their edges sit on one grid)
    expect(b.texel).toBe(a.texel);
    const shift = (b.left - a.left) / a.texel;
    expect(Math.abs(shift - Math.round(shift))).toBeLessThan(1e-6);
  });

  it('pixelHash is deterministic and spreads the 64 rotations evenly', () => {
    expect(pixelHash(10, 20)).toBe(pixelHash(10, 20));
    expect(pixelHash(10, 20)).not.toBe(pixelHash(20, 10));
    const counts = new Array(64).fill(0);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) counts[pixelHash(x, y) & 63]++;
    // 4096 pixels over 64 buckets: 64 each on average
    expect(Math.min(...counts)).toBeGreaterThan(30);
    expect(Math.max(...counts)).toBeLessThan(110);
  });

  it('a sun map from an analytic depth pass: lit ground stays fully lit, the occluded square is dark', () => {
    const map = buildSunShadow({ toLight: [0, 0, 1], angularRadius: 0 }, camera, [], fit, analyticPass)!;
    expect(map).not.toBeNull();
    expect(map.ortho).toBe(true);
    // depths are distances along the light (down): the ground 1 m below the occluder
    const vis = (x: number, y: number, z: number) => shadowVisibility(map, x, y, z, 0, 0, 1, 0, 0, 1, 3, 7);
    let minLit = 1;
    for (let y = -2.5; y <= 2.5; y += 0.0137)
      for (let x = -2.5; x <= 2.5; x += 0.0137) {
        if (Math.max(Math.abs(x), Math.abs(y)) < 0.55) continue;
        minLit = Math.min(minLit, vis(x, y, 0));
      }
    expect(minLit).toBe(1);
    for (const [x, y] of [
      [0, 0],
      [0.4, -0.4],
      [-0.45, 0.2],
    ])
      expect(vis(x, y, 0)).toBe(0);
    // the occluder's own top face is lit (no self-shadowing)
    expect(vis(0.1, 0.2, 1)).toBe(1);
    // halfway across the occluder's edge: partly lit
    const edge = vis(0.5, 0, 0);
    expect(edge).toBeGreaterThan(0.2);
    expect(edge).toBeLessThan(0.8);
    // points beyond the map's range are lit
    expect(vis(50, 50, 0)).toBe(1);
  });

  it('builders refuse lights without a direction or a scene', () => {
    expect(
      buildSunShadow({ toLight: [0, 0, 0], angularRadius: 0 }, camera, [], fit, analyticPass),
    ).toBeNull();
    expect(
      buildSpotShadow(
        { position: [0, 0, 3], direction: [0, 0, -1], spotSize: 1, radius: 0 },
        null,
        analyticPass,
      ),
    ).toBeNull();
  });
});
