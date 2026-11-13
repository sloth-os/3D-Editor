import { describe, expect, it } from 'vitest';
import { drawLines, renderSceneSoftware, type ScreenLine, type Vec3 } from '../src';
import { orthoView, viewFromSpec } from '../src/render/view';
import { boxOverGround, projectToPixel } from './render-desk-helpers';

/** A top-down orthographic view of x, y ∈ [−5, 5] (z up, 10 pixels per metre on 100 × 100). */
const TOP = orthoView([0, 0, 10], [0, 0, -1], [0, 1, 0], {
  left: -5,
  right: 5,
  bottom: -5,
  top: 5,
  near: 0.1,
  far: 20,
});
const N = 100;

const rgba = (img: Uint8Array, x: number, y: number) => [
  ...img.subarray((y * N + x) * 4, (y * N + x) * 4 + 4),
];
const red = (a: Vec3, b: Vec3, width_px = 3): ScreenLine => ({ a, b, width_px, color: [1, 0, 0] });

describe('drawLines', () => {
  it('draws a round-capped stroke between the projected endpoints', () => {
    const img = new Uint8Array(N * N * 4);
    const touched = drawLines(img, N, N, [red([-3, 0, 0], [3, 0, 0])], TOP);
    expect(touched).toBeGreaterThan(150);
    // y = 0 is the boundary between rows 49 and 50: both are covered by the 3 px stroke
    for (const x of [21, 35, 50, 65, 78]) {
      expect(rgba(img, x, 49)).toEqual([255, 0, 0, 255]);
      expect(rgba(img, x, 50)).toEqual([255, 0, 0, 255]);
    }
    // nothing beyond the caps or the stroke's width
    for (const [x, y] of [
      [10, 50],
      [90, 49],
      [50, 44],
      [50, 55],
    ])
      expect(rgba(img, x, y)).toEqual([0, 0, 0, 0]);
    // the cap reaches just past the endpoint (x = 20)
    expect(img[(50 * N + 19) * 4 + 3]).toBeGreaterThan(0);
  });

  it('anti-aliases edge pixels by coverage, or not at all', () => {
    const line = red([-3, 0.03, 0], [3, 0.47, 0], 1);
    const aa = new Uint8Array(N * N * 4);
    drawLines(aa, N, N, [line], TOP);
    const partial = [...Array(N * N).keys()].filter((p) => aa[p * 4 + 3] > 0 && aa[p * 4 + 3] < 255).length;
    expect(partial).toBeGreaterThan(20);
    const hard = new Uint8Array(N * N * 4);
    drawLines(hard, N, N, [line], TOP, { antialias: false });
    for (let p = 0; p < N * N; p++) expect([0, 255]).toContain(hard[p * 4 + 3]);
    expect([...Array(N * N).keys()].some((p) => hard[p * 4 + 3] === 255)).toBe(true);
  });

  it('wider lines cover more pixels', () => {
    const count = (w: number) =>
      drawLines(new Uint8Array(N * N * 4), N, N, [red([-3, 1, 0], [3, -1, 0], w)], TOP);
    expect(count(6)).toBeGreaterThan(count(2) * 2);
    // widths under a pixel still draw a pixel-wide line
    expect(count(0.1)).toBeGreaterThan(50);
  });

  it('hides line pixels behind nearer surfaces of a depth pass', () => {
    // a surface 5 m from the camera plane over the left half; the line lies at 10 m
    const depth = new Float32Array(N * N).fill(Infinity);
    for (let y = 0; y < N; y++) for (let x = 0; x < N / 2; x++) depth[y * N + x] = 5;
    const img = new Uint8Array(N * N * 4);
    drawLines(img, N, N, [red([-4, 0, 0], [4, 0, 0])], TOP, { depth });
    expect(rgba(img, 25, 50)[3]).toBe(0);
    expect(rgba(img, 75, 50)).toEqual([255, 0, 0, 255]);
    // a line in front of the surface (2 m from the camera) shows everywhere
    const front = new Uint8Array(N * N * 4);
    drawLines(front, N, N, [red([-4, 0, 8], [4, 0, 8])], TOP, { depth });
    expect(rgba(front, 25, 50)).toEqual([255, 0, 0, 255]);
    // a line lying on the surface is not hidden by it (depth tolerance)
    const on = new Uint8Array(N * N * 4);
    drawLines(on, N, N, [red([-4, 0, 5], [4, 0, 5])], TOP, { depth });
    expect(rgba(on, 25, 50)).toEqual([255, 0, 0, 255]);
  });

  it('blends in linear light over RGB and by value over single-channel images', () => {
    const rgb = new Uint8Array(N * N * 3).fill(255);
    drawLines(rgb, N, N, [{ a: [-3, 0, 0], b: [3, 0, 0], width_px: 3, color: [0, 0, 1] }], TOP, {
      channels: 3,
    });
    const o = (50 * N + 50) * 3;
    expect([...rgb.subarray(o, o + 3)]).toEqual([0, 0, 255]);
    const grey = new Uint8Array(N * N);
    drawLines(grey, N, N, [{ a: [-3, 0, 0], b: [3, 0, 0], width_px: 3, color: [0.5, 0.9, 0.9] }], TOP, {
      channels: 1,
    });
    expect(grey[50 * N + 50]).toBe(128);
    expect(grey[10 * N + 10]).toBe(0);
  });

  it('over transparent pixels: soft edges keep the line colour, alpha composites "over"', () => {
    // a 2 px white line off the pixel grid: rows above and below it are partly covered
    const line = {
      a: [-4, 0.013, 0] as Vec3,
      b: [4, 0.013, 0] as Vec3,
      width_px: 2,
      color: [1, 1, 1] as Vec3,
    };
    const clear = new Uint8Array(N * N * 4);
    drawLines(clear, N, N, [line], TOP);
    const partial = [...Array(N).keys()].filter((y) => {
      const a = clear[(y * N + 50) * 4 + 3];
      return a > 0 && a < 255;
    });
    expect(partial.length).toBeGreaterThanOrEqual(2);
    for (const y of partial) expect(rgba(clear, 50, y).slice(0, 3)).toEqual([255, 255, 255]);
    // over pixels of alpha 0.5: alpha = cov + 0.5 (1 − cov), colour between the two
    const half = new Uint8Array(N * N * 4);
    for (let p = 0; p < N * N; p++) half.set([255, 0, 0, 128], p * 4);
    drawLines(half, N, N, [line], TOP);
    for (const y of partial) {
      const cov = clear[(y * N + 50) * 4 + 3] / 255;
      expect(
        Math.abs(half[(y * N + 50) * 4 + 3] - (cov + (128 / 255) * (1 - cov)) * 255),
      ).toBeLessThanOrEqual(1);
      const [r, g] = rgba(half, 50, y);
      expect(r).toBe(255);
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThan(255);
    }
  });

  it('clips segments at the near plane and skips invalid ones', () => {
    const persp = viewFromSpec({ position: [0, -5, 1], target: [0, 0, 1], up: [0, 0, 1], fovY: 1 }, 1, null);
    const img = new Uint8Array(N * N * 4);
    // from in front of the camera to behind it: only the visible part is drawn
    expect(drawLines(img, N, N, [red([0.5, 2, 1], [0.5, -8, 1])], persp)).toBeGreaterThan(0);
    // wholly behind the camera, or with NaN endpoints: nothing
    expect(drawLines(new Uint8Array(N * N * 4), N, N, [red([0, -7, 1], [1, -9, 1])], persp)).toBe(0);
    expect(drawLines(new Uint8Array(N * N * 4), N, N, [red([NaN, 0, 0], [1, 1, 1])], persp)).toBe(0);
    expect(() => drawLines(new Uint8Array(10), N, N, [red([0, 0, 0], [1, 1, 0])], persp)).toThrow();
  });
});

describe('lines in RASTER renders', () => {
  it('draw over the image and hide behind opaque geometry', () => {
    const build = boxOverGround([], { camera: [0, -6, 1.5], target: [0, 0, 1.5] });
    const W = 120;
    const H = 90;
    // a red line behind the floating cube (y = 1) and a blue one in front of it (y = −1)
    const lines: ScreenLine[] = [
      { a: [-3, 1, 1.5], b: [3, 1, 1.5], width_px: 3, color: [1, 0, 0] },
      { a: [-3, -1, 1.2], b: [3, -1, 1.2], width_px: 3, color: [0, 0, 1] },
    ];
    const plain = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2 });
    const img = renderSceneSoftware(build.doc, { width: W, height: H, samples: 2, lines });
    const view = img.view!;
    expect(view).toBeDefined();
    const px = (p: Vec3) => {
      const q = projectToPixel(view, p, W, H)!;
      const o = (q[1] * W + q[0]) * 4;
      return { line: [...img.data.subarray(o, o + 3)], plain: [...plain.data.subarray(o, o + 3)] };
    };
    // beside the cube the red line shows; behind the cube the cube does
    expect(px([2, 1, 1.5]).line).toEqual([255, 0, 0]);
    const hidden = px([0, 1, 1.5]);
    expect(hidden.line).toEqual(hidden.plain);
    // the blue line in front of the cube covers it
    expect(px([0, -1, 1.2]).line).toEqual([0, 0, 255]);
    // and the rest of the image is untouched
    const far = px([2.5, 3, 0.2]);
    expect(far.line).toEqual(far.plain);
  });
});
