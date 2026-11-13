import { describe, expect, it } from 'vitest';
import { lookAt4, multiply4, perspective4, type Mat4, type Vec3 } from '@3d-editor/core';
import {
  OPENPOSE18_LIMBS,
  OPENPOSE_COLORS,
  ScreenBoxBuilder,
  cameraOfView,
  drawLineByte,
  drawLineRGB,
  drawSkeleton,
  lineVisible,
  maskFromObjects,
  projectPoint,
  projectSegment,
  rasterizeSegment,
  stringLineWidth,
  stringPolyline,
  worldPositions,
  type Projection,
  type ScreenPoint,
} from '../../src/render/passes';

/*
 * The helpers of desk renders in the render process (render/passes.ts): mask bytes from the object
 * pass, string lines, skeletons, subject boxes and the camera of a frame.
 */

/** A camera at (0, −10, 0) looking at the origin (+Y), 60° vertical field of view. */
function projection(width = 100, height = 50): Projection & { proj: Mat4; eye: Vec3 } {
  const view = lookAt4([0, -10, 0], [0, 0, 0], [0, 0, 1]);
  const proj = perspective4(Math.PI / 3, width / height, 0.1, 100);
  return {
    view,
    proj,
    viewProj: multiply4(proj, view),
    ortho: false,
    near: 0.1,
    width,
    height,
    eye: [0, -10, 0],
  };
}

const pt = (x: number, y: number, depth = 5): ScreenPoint => ({ x, y, depth });

describe('mask bytes', () => {
  it('turns object indices into palette indices through the table', () => {
    const lut = new Uint8Array([0, 7, 3]);
    expect([...maskFromObjects(new Uint32Array([0, 1, 2, 1, 9]), lut)]).toEqual([0, 7, 3, 7, 0]);
  });
});

describe('lines', () => {
  it('covers the pixels within half the width of a segment, nothing else', () => {
    const buf = new Uint8Array(20 * 10);
    drawLineByte(buf, 20, 10, pt(2, 5), pt(18, 5), 1, 9);
    for (let x = 3; x < 17; x++) expect(buf[5 * 20 + x]).toBe(9);
    // 2 px wide: rows 4 and 5 (centres 4.5 and 5.5 are 0.5 from y = 5)
    expect(buf[4 * 20 + 10]).toBe(9);
    expect(buf[3 * 20 + 10]).toBe(0);
    expect(buf[6 * 20 + 10]).toBe(0);
    let n = 0;
    for (const v of buf) if (v) n++;
    expect(n).toBeGreaterThanOrEqual(30);
    expect(n).toBeLessThanOrEqual(40);
  });

  it('draws diagonal lines unbroken at least 2 px wide', () => {
    const w = 64;
    const buf = new Uint8Array(w * w);
    drawLineByte(buf, w, w, pt(1, 1), pt(62, 50), 1, 1);
    // every column between the ends has 2 or more covered pixels
    for (let x = 4; x < 58; x++) {
      let c = 0;
      for (let y = 0; y < w; y++) c += buf[y * w + x];
      expect(c, `column ${x}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('draws the same pixels whichever end a segment starts from', () => {
    // shallow, steep and horizontal segments running right to left and back
    for (const [a, b] of [
      [pt(32, 18), pt(25.3, 19.1)],
      [pt(60, 3), pt(4, 30)],
      [pt(40, 10), pt(36, 33)],
      [pt(50, 20), pt(10, 20)],
    ] as const) {
      const fwd = new Uint8Array(64 * 36);
      const back = new Uint8Array(64 * 36);
      drawLineByte(fwd, 64, 36, a, b, 1, 1);
      drawLineByte(back, 64, 36, b, a, 1, 1);
      expect(back).toEqual(fwd);
      // unbroken: every column between the ends has a covered pixel
      for (let x = Math.ceil(Math.min(a.x, b.x)); x < Math.floor(Math.max(a.x, b.x)); x++) {
        let c = 0;
        for (let y = 0; y < 36; y++) c += fwd[y * 64 + x];
        expect(c, `column ${x}`).toBeGreaterThan(0);
      }
    }
  });

  it('depth-tests against the surface depth (a string behind a body is hidden)', () => {
    const w = 10;
    const surface = new Float32Array(w * w).fill(Infinity);
    for (let y = 0; y < w; y++) surface[y * w + 5] = 2; // a thin wall at depth 2 in column 5
    const front = new Uint8Array(w * w);
    drawLineByte(front, w, w, pt(0, 5, 1), pt(10, 5, 1), 1, 1, surface);
    expect(front[5 * w + 5]).toBe(1);
    const behind = new Uint8Array(w * w);
    drawLineByte(behind, w, w, pt(0, 5, 3), pt(10, 5, 3), 1, 1, surface);
    expect(behind[5 * w + 5]).toBe(0);
    expect(behind[5 * w + 2]).toBe(1);
    // a line inside its own thin tube (2 % / 1 cm slack) stays visible
    expect(lineVisible(2.03, 2)).toBe(true);
    expect(lineVisible(2.2, 2)).toBe(false);
  });

  it('interpolates depth perspective-correctly along the segment', () => {
    const depths: number[] = [];
    rasterizeSegment(101, 3, pt(0.5, 1.5, 1), pt(100.5, 1.5, 3), 0.5, (i, cov, d) => {
      if (Math.floor(i / 101) === 1 && cov >= 1) depths[i % 101] = d;
    });
    // halfway on screen is 1/(0.5/1 + 0.5/3) = 1.5 for a perspective line from 1 to 3
    expect(depths[50]).toBeCloseTo(1.5, 2);
  });

  it('blends RGB lines by coverage', () => {
    const rgb = new Uint8Array(10 * 10 * 3);
    drawLineRGB(rgb, 10, 10, pt(0, 5), pt(10, 5), 1, [255, 100, 0], 0.6);
    const o = (5 * 10 + 5) * 3;
    expect([rgb[o], rgb[o + 1], rgb[o + 2]]).toEqual([153, 60, 0]);
  });

  it('widens lines with the output height', () => {
    expect(stringLineWidth(90)).toBe(2);
    expect(stringLineWidth(720)).toBe(2);
    expect(stringLineWidth(1080)).toBe(3);
    expect(stringLineWidth(2160)).toBe(6);
  });
});

describe('string polylines', () => {
  it('runs along the axis of a thin tube (ends at the ring centres)', () => {
    // an 8-sided 4 mm tube from (0,0,0) to (10,0,5)
    const pos: number[] = [];
    const axis: Vec3 = [10, 0, 5];
    for (const t of [0, 1])
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        pos.push(
          axis[0] * t - 0.002 * Math.sin(a) * 0.447,
          0.002 * Math.cos(a),
          axis[2] * t + 0.002 * Math.sin(a) * 0.894,
        );
      }
    const line = stringPolyline(pos);
    expect(line.length).toBe(2);
    // either end may come first
    const [a, b] = [...line].sort((p, q) => p[0] - q[0]);
    for (const k of [0, 1, 2]) expect(a[k]).toBeCloseTo(0, 3);
    expect(b[0]).toBeCloseTo(10, 3);
    expect(b[1]).toBeCloseTo(0, 3);
    expect(b[2]).toBeCloseTo(5, 3);
  });

  it('follows a sagging wire and keeps its ends', () => {
    const pos: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const x = i / 4;
      pos.push(x, 0, 2 + 0.05 * (x - 5) ** 2);
    }
    const line = stringPolyline(pos, 16);
    expect(line.length).toBeGreaterThan(5);
    expect(line.length).toBeLessThanOrEqual(16);
    expect(line[0]).toEqual([0, 0, 2 + 0.05 * 25]);
    expect(line.at(-1)![0]).toBeCloseTo(10, 6);
    // the middle sags
    const mid = line[Math.floor(line.length / 2)];
    expect(mid[2]).toBeLessThan(2.3);
  });

  it('gives nothing for fewer than two distinct points', () => {
    expect(stringPolyline([1, 2, 3])).toEqual([]);
    expect(stringPolyline([1, 2, 3, 1, 2, 3])).toEqual([]);
  });

  it('transforms vertices to world space', () => {
    const m: Mat4 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1];
    expect([...worldPositions([1, 1, 1], m)]).toEqual([3, 4, 5]);
  });
});

describe('projection, boxes and camera', () => {
  it('projects the target to the image centre and keeps view depth', () => {
    const p = projection();
    const c = projectPoint(p, [0, 0, 0])!;
    expect(c.x).toBeCloseTo(50, 6);
    expect(c.y).toBeCloseTo(25, 6);
    expect(c.depth).toBeCloseTo(10, 6);
    // up is up on screen (top row first)
    expect(projectPoint(p, [0, 0, 1])!.y).toBeLessThan(25);
    expect(projectPoint(p, [0, -20, 0])).toBeNull();
  });

  it('clips segments at the near plane', () => {
    const p = projection();
    const seg = projectSegment(p, [0, -20, 0], [0, 0, 1])!;
    expect(seg).not.toBeNull();
    expect(seg[0].depth).toBeCloseTo(0.1, 4);
    expect(seg[0].depth).toBeGreaterThanOrEqual(0.1);
    expect(projectSegment(p, [0, -20, 0], [1, -15, 0])).toBeNull();
  });

  it('boxes a subject in pixels, clipped to the frame', () => {
    const p = projection(100, 50);
    const b = new ScreenBoxBuilder(p);
    b.add([-1, 0, -1, 1, 0, 1]);
    const box = b.box()!;
    expect(box.visible).toBe(true);
    expect(box.x + box.w / 2).toBeCloseTo(50, 0);
    expect(box.y + box.h / 2).toBeCloseTo(25, 0);
    const off = new ScreenBoxBuilder(p);
    off.add([1000, 0, 0]);
    expect(off.box()).toEqual({ x: 0, y: 0, w: 0, h: 0, visible: false });
    const behind = new ScreenBoxBuilder(p);
    behind.add([0, -50, 0]);
    expect(behind.box()).toBeNull();
  });

  it('gives the camera world matrix and vertical field of view', () => {
    const p = projection();
    const cam = cameraOfView({ view: p.view, proj: p.proj, eye: p.eye, ortho: false });
    expect(cam.fovY).toBeCloseTo(Math.PI / 3, 9);
    expect(cam.matrix.slice(12, 15)).toEqual([0, -10, 0]);
    // looking along +Y: the camera's −Z axis (third column negated) is +Y
    expect(-cam.matrix[8]).toBeCloseTo(0, 9);
    expect(-cam.matrix[9]).toBeCloseTo(1, 9);
    expect(-cam.matrix[10]).toBeCloseTo(0, 9);
  });
});

describe('skeletons', () => {
  it('uses the OpenPose-18 limbs and colours', () => {
    expect(OPENPOSE18_LIMBS).toHaveLength(17);
    expect(OPENPOSE_COLORS).toHaveLength(18);
    for (const [a, b] of OPENPOSE18_LIMBS) {
      expect(a).toBeLessThan(18);
      expect(b).toBeLessThan(18);
    }
  });

  it('draws limbs and joints in their colours on black, skipping missing points', () => {
    const w = 64;
    const rgb = new Uint8Array(w * w * 3);
    const points: (ScreenPoint | null)[] = Array.from({ length: 18 }, () => null);
    // points at pixel centres
    points[1] = pt(32.5, 10.5); // neck
    points[2] = pt(20.5, 12.5); // right shoulder
    points[3] = pt(16.5, 30.5); // right elbow (limb [2, 3] is limb index 2)
    drawSkeleton(rgb, w, w, 'openpose18', points);
    const at = (x: number, y: number) => [...rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
    // the neck joint is drawn opaque in keypoint 1's colour
    expect(at(32, 10)).toEqual([...OPENPOSE_COLORS[1]]);
    // the middle of the upper arm is 60 % of limb 2's colour on black
    expect(at(18, 21)).toEqual(OPENPOSE_COLORS[2].map((c) => Math.round(c * 0.6)));
    // the missing left side draws nothing
    expect(at(44, 12)).toEqual([0, 0, 0]);
    // far away stays black
    expect(at(60, 60)).toEqual([0, 0, 0]);
  });
});
