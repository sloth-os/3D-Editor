import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CATALOG,
  OperatorError,
  SceneDoc,
  THUMBNAIL_LOOK,
  THUMBNAIL_SAMPLES,
  THUMBNAIL_SIZE,
  decodePNG,
  renderBuiltinThumbnailPng,
  stageBuiltinThumbnail,
  threeQuarterView,
  thumbnailFrameOptions,
} from '../src';

/*
 * Thumbnails of the built-in models (store/thumbnail.ts), shared by the editor server's store and
 * the browser's thumbnail workers: the three-quarter framing, the staging of a model alone in its
 * document by store.add, the render options, and the PNG itself.
 */

type Vec3 = [number, number, number];

/** Where a world point lands on the image plane of a view (x, y in units of the half extent). */
function project(view: { position: Vec3; target: Vec3; fovY: number }, p: Vec3, aspect = 1) {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const fwd = norm(sub(view.target, view.position));
  const right = norm(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  const r = sub(p, view.position);
  const depth = dot(r, fwd);
  const t = Math.tan(view.fovY / 2);
  return { x: dot(r, right) / depth / (t * aspect), y: dot(r, up) / depth / t, depth };
}

/** A static furniture model of the catalog (any static one does). */
const MODEL =
  BUILTIN_CATALOG.find((e) => e.rig === null && e.category === 'furniture') ??
  BUILTIN_CATALOG.find((e) => e.rig === null)!;
/** A model with a seed parameter (its look changes with the seed). */
const SEEDED = BUILTIN_CATALOG.find((e) => e.params?.shape && 'seed' in e.params.shape)!;

/** Share of opaque pixels and whether the four corners are transparent. */
function coverage(png: Uint8Array) {
  const img = decodePNG(png);
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) opaque++;
  const alphaAt = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
  const w = img.width - 1;
  const h = img.height - 1;
  return {
    img,
    share: opaque / (img.width * img.height),
    cornersClear: [alphaAt(0, 0), alphaAt(w, 0), alphaAt(0, h), alphaAt(w, h)].every((a) => a === 0),
  };
}

describe('threeQuarterView', () => {
  const corners = (min: Vec3, max: Vec3): Vec3[] =>
    Array.from({ length: 8 }, (_, i) => [
      i & 1 ? max[0] : min[0],
      i & 2 ? max[1] : min[1],
      i & 4 ? max[2] : min[2],
    ]);

  it('looks at the box centre from the front right and above, every corner in the frame', () => {
    for (const [min, max] of [
      [
        [-0.3, -0.3, 0],
        [0.3, 0.3, 0.9],
      ],
      [
        [-2, -0.8, 0],
        [2, 0.8, 1.4],
      ],
      [
        [-0.05, -0.05, 0],
        [0.05, 0.05, 3],
      ],
      [
        [0, 0, 0],
        [12, 6, 0.2],
      ],
    ] as [Vec3, Vec3][]) {
      const v = threeQuarterView({ min, max }) as { position: Vec3; target: Vec3; fovY: number; up: Vec3 };
      expect(v.target).toEqual([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
      expect(v.up).toEqual([0, 0, 1]);
      // in front (−Y), to the right (+X), above
      expect(v.position[1]).toBeLessThan(v.target[1]);
      expect(v.position[0]).toBeGreaterThan(v.target[0]);
      expect(v.position[2]).toBeGreaterThan(v.target[2]);
      let widest = 0;
      for (const c of corners(min, max)) {
        const p = project(v, c);
        expect(p.depth).toBeGreaterThan(0);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(0.87);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(0.87);
        widest = Math.max(widest, Math.abs(p.x), Math.abs(p.y));
      }
      // as close as the margin allows: the model fills the frame
      expect(widest).toBeGreaterThan(0.84);
    }
  });

  it('keeps a camera outside degenerate boxes', () => {
    const v = threeQuarterView({ min: [1, 1, 1], max: [1, 1, 1] }) as { position: Vec3; target: Vec3 };
    expect(Math.hypot(v.position[0] - 1, v.position[1] - 1, v.position[2] - 1)).toBeGreaterThan(0.04);
  });
});

describe('stageBuiltinThumbnail', () => {
  it("builds the model alone at the origin and frames it from the front right, the scene's first frame", () => {
    const doc = SceneDoc.create({ empty: true });
    try {
      const framing = stageBuiltinThumbnail(doc, { id: MODEL.id });
      const roots = doc.listObjects().filter((o) => !o.parent);
      // the model's root alone (no camera, no light of a default scene)
      expect(roots).toHaveLength(1);
      expect(roots[0].type).toBe('EMPTY');
      expect(roots[0].location).toEqual([0, 0, 0]);
      expect(framing.frame).toBe(doc.getScene().frame_start);
      const v = framing.view as { position: Vec3; target: Vec3 };
      // the model stands on the ground: the camera looks at its middle from above
      expect(v.target[2]).toBeGreaterThan(0);
      expect(v.position[2]).toBeGreaterThan(v.target[2]);
      expect(v.position[1]).toBeLessThan(v.target[1]);
    } finally {
      doc.destroy();
    }
  });

  it('answers NOT_FOUND for an unknown model and FAILED for parameters it refuses', () => {
    const doc = SceneDoc.create({ empty: true });
    try {
      expect(() => stageBuiltinThumbnail(doc, { id: 'no_such_model' })).toThrowError(
        expect.objectContaining({
          code: 'NOT_FOUND',
          message: expect.stringContaining('builtin:no_such_model'),
        }),
      );
      expect(() => stageBuiltinThumbnail(doc, { id: SEEDED.id, params: { seed: 'many' } })).toThrowError(
        expect.objectContaining({ code: 'FAILED' }),
      );
      expect(doc.listObjects()).toHaveLength(0);
    } finally {
      doc.destroy();
    }
  });
});

describe('thumbnailFrameOptions', () => {
  it('asks for a square RASTER desk frame in the clay look, on a transparent background', () => {
    const framing = { frame: 3, view: threeQuarterView({ min: [0, 0, 0], max: [1, 1, 1] }) };
    expect(thumbnailFrameOptions(framing)).toEqual({
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      frame: 3,
      engine: 'RASTER',
      view: framing.view,
      samples: THUMBNAIL_SAMPLES,
      background: [0, 0, 0, 0],
      desk: THUMBNAIL_LOOK,
    });
    expect(thumbnailFrameOptions(framing, 96)).toMatchObject({ width: 96, height: 96 });
    expect(THUMBNAIL_LOOK).toEqual({ look: 'clay', shadows: true, ao: true, msaa: true, passes: ['beauty'] });
  });
});

describe('renderBuiltinThumbnailPng', () => {
  it('renders the model in the middle of a transparent square, the same PNG every time', () => {
    const a = renderBuiltinThumbnailPng({ id: MODEL.id });
    expect([a.width, a.height]).toEqual([THUMBNAIL_SIZE, THUMBNAIL_SIZE]);
    const c = coverage(a.png);
    expect([c.img.width, c.img.height]).toEqual([THUMBNAIL_SIZE, THUMBNAIL_SIZE]);
    expect(c.cornersClear).toBe(true);
    // the framing fills about three quarters of the square with the model's box
    expect(c.share).toBeGreaterThan(0.05);
    expect(c.share).toBeLessThan(0.9);
    // deterministic (the cache and the server's thumbnails rely on it); 'builtin:' ids work too
    expect(renderBuiltinThumbnailPng({ id: `builtin:${MODEL.id}` }).png).toEqual(a.png);
  });

  it("renders at the size asked for, with the model's own parameters", () => {
    const small = renderBuiltinThumbnailPng({ id: MODEL.id }, 64);
    expect([decodePNG(small.png).width, decodePNG(small.png).height]).toEqual([64, 64]);
    const one = renderBuiltinThumbnailPng({ id: SEEDED.id, params: { seed: 1 } }, 64).png;
    const two = renderBuiltinThumbnailPng({ id: SEEDED.id, params: { seed: 2 } }, 64).png;
    expect(one).not.toEqual(two);
    // no parameters is the model's defaults
    expect(renderBuiltinThumbnailPng({ id: SEEDED.id, params: {} }, 64).png).toEqual(
      renderBuiltinThumbnailPng({ id: SEEDED.id }, 64).png,
    );
  });

  it('refuses sizes outside 16–1024 pixels and unknown models', () => {
    for (const size of [8, 2048, 100.5])
      expect(() => renderBuiltinThumbnailPng({ id: MODEL.id }, size)).toThrowError(OperatorError);
    expect(() => renderBuiltinThumbnailPng({ id: 'no_such_model' })).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
