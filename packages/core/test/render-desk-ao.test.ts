import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createCube,
  createPlane,
  defaultAoRadius,
  renderItems,
  renderSceneSoftware,
  type RenderedImage,
  type Vec3,
} from '../src';
import { invert4 } from '../src/math/mat4';
import { AO_HALF_RES_PIXELS, AO_TAPS, ambientOcclusion, applyAmbientOcclusion } from '../src/render/ao';
import type { PixelBuffers } from '../src/render/raster';
import { viewFromSpec, type RenderView } from '../src/render/view';
import {
  boxOverGround,
  imageHash,
  lookCamera,
  luma,
  planarDepth,
  projectToPixel,
} from './render-desk-helpers';

const deg = (d: number) => (d * Math.PI) / 180;

// ------------------------------------------------------------------------------ synthetic buffers

/** A plane n·p = c with its (unit) normal facing the camera side; `within`: the part of it drawn. */
interface Plane {
  n: Vec3;
  c: number;
  within?: (p: Vec3) => boolean;
}

/**
 * Nearest-sample buffers of a view looking at `planes` (each pixel: the nearest plane its centre
 * ray hits in front of the camera), as the rasterizer fills `Rasterizer.pixels`; `object` holds the
 * index + 1 of the plane each pixel shows.
 */
function planeBuffers(view: RenderView, w: number, h: number, planes: readonly Plane[]): PixelBuffers {
  const key = new Float32Array(w * h);
  const normal = new Float32Array(w * h * 3);
  const object = new Uint32Array(w * h);
  const inv = invert4(view.viewProj);
  const un = (x: number, y: number, z: number): Vec3 => {
    const cw = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
    return [
      (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / cw,
      (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / cw,
      (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / cw,
    ];
  };
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const nx = ((i + 0.5) / w) * 2 - 1;
      const ny = 1 - ((j + 0.5) / h) * 2;
      const a = un(nx, ny, -1);
      const b = un(nx, ny, 1);
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      let best = Infinity;
      let hit = -1;
      for (let k = 0; k < planes.length; k++) {
        const pl = planes[k];
        const den = pl.n[0] * d[0] + pl.n[1] * d[1] + pl.n[2] * d[2];
        if (Math.abs(den) < 1e-12) continue;
        const t = (pl.c - (pl.n[0] * a[0] + pl.n[1] * a[1] + pl.n[2] * a[2])) / den;
        if (!(t > 0 && t < best)) continue;
        if (pl.within && !pl.within([a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t])) continue;
        best = t;
        hit = k;
      }
      if (hit < 0) continue;
      const p: Vec3 = [a[0] + d[0] * best, a[1] + d[1] * best, a[2] + d[2] * best];
      const p0 = j * w + i;
      key[p0] = 1 / planarDepth(view, p);
      normal.set(planes[hit].n, p0 * 3);
      object[p0] = hit + 1;
    }
  return { width: w, height: h, key, normal, object };
}

describe('ambientOcclusion (screen space)', () => {
  const W = 96;
  const H = 72;
  // a camera 3 m in front of a wall (y = 0) above a floor (z = 0): the corner runs along x
  const view = viewFromSpec(
    { position: [0, -3, 1.2], target: [0, 0, 0.3], up: [0, 0, 1], fovY: deg(50) },
    W / H,
    {
      min: [-4, -4, 0],
      max: [4, 0, 3],
    },
  );
  const floor: Plane = { n: [0, 0, 1], c: 0 };
  const wall: Plane = { n: [0, -1, 0], c: 0 };
  const at = (ao: Float32Array, p: Vec3) => {
    const px = projectToPixel(view, p, W, H)!;
    return ao[px[1] * W + px[0]];
  };

  it('leaves a flat surface open and empty pixels at 1', () => {
    const pix = planeBuffers(view, W, H, [wall]);
    const ao = ambientOcclusion(pix, view, 0.3);
    expect(Math.min(...ao)).toBe(1);
    const empty = ambientOcclusion(
      { width: 8, height: 8, key: new Float32Array(64), normal: new Float32Array(192), object: null },
      view,
      0.3,
    );
    expect([...empty].every((v) => v === 1)).toBe(true);
  });

  it('darkens the floor and the wall along the corner, not far from it', () => {
    const ao = Float32Array.from(ambientOcclusion(planeBuffers(view, W, H, [floor, wall]), view, 0.3));
    // (about 0.88 here: a 96 × 72 view puts few pixels within the 0.3 m radius of the corner)
    expect(at(ao, [0, -0.06, 0])).toBeLessThan(0.93);
    expect(at(ao, [0.5, -0.04, 0])).toBeLessThan(0.93);
    expect(at(ao, [0, 0, 0.06])).toBeLessThan(0.93);
    // occlusion fades with the distance from the corner (over the 0.3 m radius)
    expect(at(ao, [0, -0.06, 0])).toBeLessThan(at(ao, [0, -0.25, 0]));
    expect(at(ao, [0, -1.2, 0])).toBe(1);
    expect(at(ao, [0, 0, 1.5])).toBe(1);
    for (const v of ao) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('large images: taps on every other pixel, then each pixel takes the occlusion at its own depth', () => {
    expect(AO_HALF_RES_PIXELS).toBeLessThanOrEqual(1920 * 1080);
    expect(AO_HALF_RES_PIXELS).toBeGreaterThan(1280 * 720);
    // the corner behind a card floating in front of it, open itself (0.35 m above the floor, 1.2 m
    // before the wall, both beyond the 0.3 m reach): the card hides part of the corner, which shows
    // beside it
    const w = 384;
    const h = 288;
    const v = viewFromSpec(
      { position: [0, -3, 1.2], target: [0, 0, 0.3], up: [0, 0, 1], fovY: deg(50) },
      w / h,
      { min: [-4, -4, 0], max: [4, 0, 3] },
    );
    const card: Plane = {
      n: [0, -1, 0],
      c: 1.2,
      within: (p) => Math.abs(p[0]) <= 0.3 && p[2] >= 0.35 && p[2] <= 0.75,
    };
    const pix = planeBuffers(v, w, h, [floor, wall, card]);
    const full = Float32Array.from(ambientOcclusion(pix, v, 0.3, undefined, false));
    const half = Float32Array.from(ambientOcclusion(pix, v, 0.3, undefined, true));
    const ao = (img: Float32Array, p: Vec3) => {
      const px = projectToPixel(v, p, w, h)!;
      return img[px[1] * w + px[0]];
    };
    // the card's pixels, its silhouette against the occluded corner included, stay open: each takes
    // the grid pixels at its own depth, never the corner's behind it
    let cardPixels = 0;
    for (let i = 0; i < w * h; i++) {
      if (pix.object![i] !== 3) continue;
      cardPixels++;
      expect(half[i]).toBe(1);
      expect(full[i]).toBe(1);
    }
    expect(cardPixels).toBeGreaterThan(3000);
    // the corner beside the card is occluded about as much as at full resolution
    for (const p of [
      [-0.6, -0.05, 0],
      [0.6, -0.05, 0],
      [-1, -0.04, 0],
      [1, 0, 0.05],
      [-0.6, 0, 0.06],
    ] as Vec3[]) {
      expect(ao(half, p), `corner at ${p}`).toBeLessThan(0.9);
      expect(Math.abs(ao(half, p) - ao(full, p)), `corner at ${p}`).toBeLessThan(0.06);
    }
    // beyond the reach (0.3 m), open at both resolutions; the same on average everywhere
    for (const p of [
      [-1, -0.5, 0],
      [1, -0.6, 0],
      [0.9, 0, 0.45],
    ] as Vec3[]) {
      expect(ao(full, p), `open at ${p}`).toBe(1);
      expect(ao(half, p), `open at ${p}`).toBe(1);
    }
    let diff = 0;
    for (let i = 0; i < w * h; i++) diff += Math.abs(half[i] - full[i]);
    expect(diff / (w * h)).toBeLessThan(0.005);
    // by default from AO_HALF_RES_PIXELS output pixels on (empty pixels stay at 1): the corner at
    // that size, and with its last row cut off
    const bw = 1600;
    const bh = AO_HALF_RES_PIXELS / bw;
    const bv = viewFromSpec(
      { position: [0, -3, 1.2], target: [0, 0, 0.3], up: [0, 0, 1], fovY: deg(50) },
      bw / bh,
      { min: [-4, -4, 0], max: [4, 0, 3] },
    );
    const big = planeBuffers(bv, bw, bh, [floor, wall]);
    big.key.fill(0, 0, bw * 40);
    const same = (x: Float32Array, y: Float32Array) => x.length === y.length && x.every((q, i) => q === y[i]);
    for (const rows of [bh, bh - 1]) {
      const pix: PixelBuffers = {
        width: bw,
        height: rows,
        key: big.key.subarray(0, bw * rows),
        normal: big.normal.subarray(0, bw * rows * 3),
        object: null,
      };
      const auto = Float32Array.from(ambientOcclusion(pix, bv, 0.3));
      const halfRes = Float32Array.from(ambientOcclusion(pix, bv, 0.3, undefined, true));
      const fullRes = Float32Array.from(ambientOcclusion(pix, bv, 0.3, undefined, false));
      expect(same(auto, bw * rows >= AO_HALF_RES_PIXELS ? halfRes : fullRes), `${rows} rows`).toBe(true);
      expect(same(halfRes, fullRes)).toBe(false);
      expect(auto.subarray(0, bw * 40).every((x) => x === 1)).toBe(true);
    }
  });

  it('is deterministic, scales with the radius and is off for a zero radius', () => {
    const pix = planeBuffers(view, W, H, [floor, wall]);
    const a = Float32Array.from(ambientOcclusion(pix, view, 0.3));
    const b = Float32Array.from(ambientOcclusion(pix, view, 0.3));
    expect(b).toEqual(a);
    const wide = Float32Array.from(ambientOcclusion(pix, view, 0.8));
    // a wider radius reaches further from the corner
    expect(at(wide, [0, -0.45, 0])).toBeLessThan(at(a, [0, -0.45, 0]));
    expect([...ambientOcclusion(pix, view, 0)].every((v) => v === 1)).toBe(true);
    expect(AO_TAPS).toBeGreaterThanOrEqual(8);
    expect(AO_TAPS).toBeLessThanOrEqual(12);
  });
});

describe('applyAmbientOcclusion', () => {
  it("darkens each sample's ambient share by its pixel's occlusion", () => {
    // 2 × 2 output pixels of 2 × 2 samples: sample buffers 4 × 4
    const color = new Float32Array(16 * 3).fill(0.8);
    const share = new Uint32Array(16);
    const full = 1023 | (1023 << 10) | (1023 << 20);
    const half = 512 | (512 << 10) | (512 << 20);
    share.fill(full);
    share[1] = half; // pixel (0, 0)
    share[2] = 0; // pixel (1, 0): no ambient
    share[3] = 1023; // pixel (1, 0): red only
    const ao = Float32Array.from([0.5, 0.25, 1, 0]);
    applyAmbientOcclusion(color, share, ao, 4, 4, 2);
    const c = (s: number, ch = 0) => color[s * 3 + ch];
    // pixel (0, 0), ao 0.5: fully ambient samples halve, half-ambient ones lose a quarter
    expect(c(0)).toBeCloseTo(0.4, 6);
    expect(c(1)).toBeCloseTo(0.8 * (1 - 0.5 * (512 / 1023)), 6);
    // pixel (1, 0), ao 0.25: no ambient → unchanged; red-only share darkens red alone
    expect(c(2)).toBeCloseTo(0.8, 6);
    expect(c(3, 0)).toBeCloseTo(0.8 * 0.25, 6);
    expect(c(3, 1)).toBeCloseTo(0.8, 6);
    // pixel (0, 1), ao 1: unchanged; pixel (1, 1), ao 0: ambient removed
    expect(c(8)).toBeCloseTo(0.8, 6);
    expect(c(10)).toBeCloseTo(0, 6);
    expect(c(15)).toBeCloseTo(0, 6);
  });
});

// ------------------------------------------------------------------------------------- renders

/** A room corner (floor, back and left walls) lit only by a bright flat world (ambient light). */
function cornerScene(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0.6, 0.6, 0.6], strength: 1 });
  doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
  const mat = doc.addMaterial({ name: 'Plaster', base_color: [0.8, 0.8, 0.8, 1], roughness: 1 });
  const unit = doc.addMesh('Unit', createCube({ size: 1 }));
  doc.addObject({
    type: 'MESH',
    name: 'Floor',
    data: doc.addMesh('Floor', createPlane({ size: 8 })),
    material_slots: [mat],
  });
  doc.addObject({
    type: 'MESH',
    name: 'Back',
    data: unit,
    material_slots: [mat],
    location: [0, 0.1, 1.5],
    scale: [8, 0.2, 3],
  });
  doc.addObject({
    type: 'MESH',
    name: 'Left',
    data: unit,
    material_slots: [mat],
    location: [-2.1, 0, 1.5],
    scale: [0.2, 8, 3],
  });
  lookCamera(doc, [1.2, -3, 1.4], [-1, 0, 0.2], 30);
  return doc;
}

function aoPair(
  doc: SceneDoc,
  extra: Record<string, unknown> = {},
): { off: RenderedImage; on: RenderedImage } {
  const opts = { width: 120, height: 90, samples: 2, aovs: ['depth' as const], ...extra };
  return { off: renderSceneSoftware(doc, opts), on: renderSceneSoftware(doc, { ...opts, ao: true }) };
}

describe('ambient occlusion in renders', () => {
  it('darkens a room corner and its creases, not the open floor', () => {
    const { off, on } = aoPair(cornerScene());
    const view = on.view!;
    const ratio = (p: Vec3) => {
      const px = projectToPixel(view, p, 120, 90)!;
      return luma(on, px[0], px[1]) / luma(off, px[0], px[1]);
    };
    // the floor in the corner, along the back wall and along the left wall (display values: a
    // linear occlusion of about 0.73 shows as 0.87 here)
    const corner = ratio([-1.95, -0.05, 0]);
    expect(corner).toBeLessThan(0.92);
    expect(ratio([-0.5, -0.04, 0])).toBeLessThan(0.96);
    expect(ratio([-1.95, -1, 0])).toBeLessThan(0.96);
    expect(corner).toBeLessThan(ratio([-0.5, -0.04, 0]));
    // the open floor in front stays as it was
    expect(ratio([0.2, -1.6, 0])).toBe(1);
    // nothing gets brighter
    for (let y = 0; y < 90; y++)
      for (let x = 0; x < 120; x++) expect(luma(on, x, y)).toBeLessThanOrEqual(luma(off, x, y));
  });

  it('only darkens ambient light: a scene lit by a sun alone (black world) is unchanged', () => {
    const build = boxOverGround(
      [{ data: { type: 'SUN', energy: 3 }, location: [0, 0, 5], rotation: [deg(20), 0, 0] }],
      {
        world: 0,
      },
    );
    const { off, on } = aoPair(build.doc);
    expect(imageHash(on)).toBe(imageHash(off));
  });

  it('the radius holds still while things out of view turn, and aoRadius pins it for a shot', () => {
    // two crates on a bright-lit ground in view; far behind the camera an "actor" of ten thin
    // parts (the median items: they set the default radius) whose parent empty turns
    const scene = (turn: number, actor = true) => {
      const doc = SceneDoc.create({ empty: true });
      doc.updateWorld({ environment: 'NONE', color: [0.6, 0.6, 0.6], strength: 1 });
      doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
      const mat = doc.addMaterial({ name: 'Plaster', base_color: [0.8, 0.8, 0.8, 1], roughness: 1 });
      doc.addObject({
        type: 'MESH',
        name: 'Ground',
        data: doc.addMesh('Ground', createPlane({ size: 20 })),
        material_slots: [mat],
      });
      const crate = doc.addMesh('Crate', createCube({ size: 1 }));
      for (const [x, y] of [
        [0, 0],
        [1.2, 0.3],
      ])
        doc.addObject({
          type: 'MESH',
          name: `Crate${x}`,
          data: crate,
          material_slots: [mat],
          location: [x, y, 0.5],
        });
      if (actor) {
        const root = doc.addObject({
          type: 'EMPTY',
          name: 'Actor',
          location: [0, -20, 1],
          rotation_euler: [0, 0, turn],
        });
        const limb = doc.addMesh('Limb', createCube({ size: 1 }));
        for (let i = 0; i < 10; i++)
          doc.addObject({
            type: 'MESH',
            name: `Limb${i}`,
            data: limb,
            material_slots: [mat],
            parent: root,
            location: [(i % 5) * 0.3 - 0.6, 0, i < 5 ? 0 : 0.5],
            scale: [0.4, 0.1, 0.1],
          });
      }
      lookCamera(doc, [3, -4, 2.5], [0.5, 0.2, 0.3], 35);
      return doc;
    };
    const opts = { width: 120, height: 90, samples: 2, ao: true };
    const items = (doc: SceneDoc) =>
      renderItems(new SceneEvaluator(doc).evaluate(1, { forRender: true }), { forRender: true });
    // the limbs (0.4 × 0.1 × 0.1 m) are the median: a quarter of their diagonal, however turned
    for (const turn of [0, Math.PI / 4]) {
      expect(defaultAoRadius(items(scene(turn)))).toBeCloseTo(0.25 * Math.hypot(0.4, 0.1, 0.1), 9);
    }
    const still = renderSceneSoftware(scene(0), opts);
    expect(imageHash(renderSceneSoftware(scene(Math.PI / 4), opts))).toBe(imageHash(still));
    // without the actor the default follows the crates (documented: what the scene holds counts)
    expect(defaultAoRadius(items(scene(0, false)))).toBeCloseTo(0.25 * Math.sqrt(3), 9);
    expect(imageHash(renderSceneSoftware(scene(0, false), opts))).not.toBe(imageHash(still));
    // one radius for the shot: the actor's presence or pose no longer matters
    const pinned = { ...opts, aoRadius: 0.3 };
    const a = renderSceneSoftware(scene(0), pinned);
    expect(imageHash(renderSceneSoftware(scene(0, false), pinned))).toBe(imageHash(a));
    expect(imageHash(renderSceneSoftware(scene(1), pinned))).toBe(imageHash(a));
    // and it is the reach: 30 cm in front of the crate's foot, a wide radius darkens, a short one not
    const view = a.view ?? renderSceneSoftware(scene(0), { ...pinned, aovs: ['depth'] }).view!;
    const foot = projectToPixel(view, [0, -0.8, 0], 120, 90)!;
    const near = renderSceneSoftware(scene(0), { ...opts, aoRadius: 0.1 });
    const far = renderSceneSoftware(scene(0), { ...opts, aoRadius: 0.6 });
    expect(luma(far, foot[0], foot[1])).toBeLessThan(luma(near, foot[0], foot[1]) - 2);
  });

  it('defaultAoRadius: a quarter of the median rest size times scale, 5–50 cm', () => {
    const doc = SceneDoc.create({ empty: true });
    const mat = doc.addMaterial({});
    const cube = doc.addMesh('Cube', createCube({ size: 1 }));
    const ids = [0, 1, 2].map((i) =>
      doc.addObject({
        type: 'MESH',
        name: `C${i}`,
        data: cube,
        material_slots: [mat],
        location: [i * 3, 0, 0],
      }),
    );
    const radius = () =>
      defaultAoRadius(
        renderItems(new SceneEvaluator(doc).evaluate(1, { forRender: true }), { forRender: true }),
      );
    expect(radius()).toBeCloseTo(0.25 * Math.sqrt(3), 9);
    // non-uniform scale stretches each axis; rotation changes nothing
    for (const id of ids) doc.updateObject(id, { scale: [0.4, 0.4, 0.2], rotation_euler: [0.3, 0.5, 0.7] });
    expect(radius()).toBeCloseTo(0.25 * Math.hypot(0.4, 0.4, 0.2), 9);
    // clamped to 5–50 cm
    for (const id of ids) doc.updateObject(id, { scale: [0.01, 0.01, 0.01] });
    expect(radius()).toBe(0.05);
    for (const id of ids) doc.updateObject(id, { scale: [10, 10, 10] });
    expect(radius()).toBe(0.5);
    expect(defaultAoRadius([])).toBe(0.5);
  });

  it('works with msaa, shadows and the tonemapped resolve, deterministically', () => {
    const doc = cornerScene();
    const opts = {
      width: 96,
      height: 72,
      samples: 2,
      ao: true,
      msaa: true,
      shadows: true,
      resolve: 'tonemap' as const,
    };
    const a = renderSceneSoftware(doc, opts);
    const b = renderSceneSoftware(doc, opts);
    expect(imageHash(b)).toBe(imageHash(a));
    const off = renderSceneSoftware(doc, { ...opts, ao: false });
    expect(imageHash(a)).not.toBe(imageHash(off));
  });
});
