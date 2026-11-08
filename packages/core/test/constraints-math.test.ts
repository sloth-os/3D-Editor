import { describe, expect, it } from 'vitest';
import {
  blendMatrices,
  compatibleEuler,
  composeLocRotSize,
  decomposeLocRotSize,
  eulerToMatrix,
  invertSafe,
  matrixToAxisAngle,
  matrixToCompatibleEuler,
  matrixToEuler,
  matrixToStoredEuler,
  orthogonalizeStable,
  polarDecompose,
  quatFromMatrix,
  type EulerOrder,
} from '../src/constraints/math';
import { clampAngle } from '../src/constraints/limit';
import { clampToTime } from '../src/constraints/path';
import {
  axisAngle4,
  compose4,
  fromQuat4,
  identity4,
  multiply4,
  rotationFromEuler,
  type Mat4,
} from '../src/math';

const ORDERS: EulerOrder[] = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
const AXES: Record<string, [number, number, number]> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const DEG = Math.PI / 180;

/** Deterministic pseudo random numbers (LCG) so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function expectMat(a: Mat4, b: Mat4, digits = 9) {
  for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

describe('euler orders', () => {
  it('applies the first letter first (XYZ = Rz·Ry·Rx, matching the core convention)', () => {
    const e: [number, number, number] = [0.3, -0.7, 1.9];
    for (const order of ORDERS) {
      const [a, b, c] = order.split('');
      const angle = (axis: string) => e['XYZ'.indexOf(axis)];
      const expected = multiply4(
        axisAngle4(AXES[c], angle(c)),
        multiply4(axisAngle4(AXES[b], angle(b)), axisAngle4(AXES[a], angle(a))),
      );
      expectMat(eulerToMatrix(e, order), expected);
    }
    expectMat(eulerToMatrix(e, 'XYZ'), rotationFromEuler(e));
  });

  it('round-trips rotations in every order and stays compatible with a reference', () => {
    const rand = rng(7);
    for (const order of ORDERS)
      for (let n = 0; n < 40; n++) {
        const e: [number, number, number] = [rand() * 6 - 3, rand() * 3 - 1.5, rand() * 6 - 3];
        const m = eulerToMatrix(e, order);
        expectMat(eulerToMatrix(matrixToEuler(m, order), order), m);
        const compat = matrixToCompatibleEuler(m, e, order);
        compat.forEach((v, i) => expect(v).toBeCloseTo(e[i], 6));
      }
  });

  it('prefers the smallest solution and handles gimbal lock', () => {
    // a Y rotation beyond 90° is reported as such (not as a 180° flip of X and Z)
    expect(matrixToEuler(eulerToMatrix([0, 100 * DEG, 0]))[1]).toBeCloseTo(100 * DEG);
    const locked = eulerToMatrix([0.4, Math.PI / 2, 0]);
    expectMat(eulerToMatrix(matrixToEuler(locked)), locked);
    // scaled matrices are normalised first
    expect(matrixToEuler(compose4([0, 0, 0], [0.1, 0.2, 0.3], [4, 5, 6]))[2]).toBeCloseTo(0.3);
  });

  it('wraps angles towards the reference', () => {
    expect(compatibleEuler([0.1, 0, 0], [2 * Math.PI, 0, 0])[0]).toBeCloseTo(0.1 + 2 * Math.PI);
    expect(compatibleEuler([-3, 0, 0], [3, 0, 0])[0]).toBeCloseTo(-3 + 2 * Math.PI);
    expect(compatibleEuler([0.5, 0.5, 0.5], [0, 0, 0])).toEqual([0.5, 0.5, 0.5]);
  });

  it('within 0.00215° of Y ±90° Blender’s conversion sets Z to 0; the angles transforms store keep the matrix', () => {
    for (const y of [89.999, -89.999]) {
      const e: [number, number, number] = [10 * DEG, y * DEG, 30 * DEG];
      const m = eulerToMatrix(e);
      // Blender's mat3_normalized_to_compatible_eulO (EULER_HYPOT_EPSILON): X takes X − Z (Y near
      // 90°) or X + Z (near −90°) and Z is 0, which is up to 9.0e-6 off the matrix here
      const blender = matrixToCompatibleEuler(m, [0, 0, 0]);
      expect(blender[2], `Y ${y}°`).toBe(0);
      expect(blender[0] / DEG, `Y ${y}°`).toBeCloseTo(y > 0 ? -20 : 40, 2);
      // matrixToStoredEuler reads the angles the matrix has
      const stored = matrixToStoredEuler(m, [0, 0, 0]);
      const r = eulerToMatrix(stored);
      for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10])
        expect(Math.abs(r[k] - m[k]), `Y ${y}°: matrix[${k}]`).toBeLessThan(1e-14);
      expect(stored[2] / DEG, `Y ${y}°`).toBeCloseTo(30, 9);
    }
  });
});

describe('decompositions', () => {
  it('splits mirrored matrices like Blender (all sizes negated, rotation kept proper)', () => {
    const m = compose4([1, 2, 3], [0.2, 0.3, 0.4], [-2, 3, 4]);
    const d = decomposeLocRotSize(m);
    d.size.forEach((v, i) => expect(v).toBeCloseTo([-2, -3, -4][i], 12));
    expectMat(composeLocRotSize(d.loc, d.rot, d.size), m);
    const det =
      d.rot[0] * (d.rot[5] * d.rot[10] - d.rot[9] * d.rot[6]) -
      d.rot[4] * (d.rot[1] * d.rot[10] - d.rot[9] * d.rot[2]) +
      d.rot[8] * (d.rot[1] * d.rot[6] - d.rot[5] * d.rot[2]);
    expect(det).toBeCloseTo(1);
  });

  it('polar-decomposes sheared, mirrored and degenerate matrices', () => {
    const sheared = [1, 0.5, 0, 0, 0.2, 2, 0.3, 0, 0, 0.1, 3, 0, 4, 5, 6, 1];
    for (const m of [
      sheared,
      compose4([0, 0, 0], [0.2, 0.3, 0.4], [-1, 2, 3]),
      compose4([0, 0, 0], [1, 0, 0], [0, 2, 2]),
    ]) {
      const { u, p } = polarDecompose(m);
      const up = multiply4(u, p);
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) expect(up[i]).toBeCloseTo(m[i], 9);
      // U is a proper rotation that a quaternion represents exactly
      expectMat(fromQuat4(quatFromMatrix(u)), u);
    }
  });

  it('extracts axis and angle', () => {
    const { axis, angle } = matrixToAxisAngle(axisAngle4([0, 0.6, 0.8], 2.5));
    expect(angle).toBeCloseTo(2.5);
    expect(axis[1]).toBeCloseTo(0.6);
    expect(axis[2]).toBeCloseTo(0.8);
    expect(matrixToAxisAngle(identity4()).angle).toBe(0);
  });
});

describe('blending and inversion', () => {
  it('interpolates location linearly, rotation along the shortest arc and scale linearly', () => {
    const a = compose4([0, 0, 0], [0, 0, -170 * DEG], [1, 1, 1]);
    const b = compose4([2, 0, 0], [0, 0, 170 * DEG], [3, 1, 1]);
    const m = blendMatrices(a, b, 0.5);
    expect(m[12]).toBeCloseTo(1);
    // -170° → 170° passes through 180°, not 0°
    const angle = Math.atan2(m[1], m[0]);
    expect(Math.abs(angle)).toBeCloseTo(Math.PI, 6);
    expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(2);
    expectMat(blendMatrices(a, b, 0), a);
    expectMat(blendMatrices(a, b, 1), b);
  });

  it('inverts singular matrices without producing NaN', () => {
    const flat = compose4([1, 2, 3], [0.3, 0, 0], [1, 0, 1]);
    const back = multiply4(invertSafe(flat), flat);
    expect(back.every(Number.isFinite)).toBe(true);
    // the healthy X and Z axes still map back to themselves; the flat Y axis collapses
    expect(back[0]).toBeCloseTo(1);
    expect(back[10]).toBeCloseTo(1);
    expect(back[5]).toBeCloseTo(0);
    expect(back[12]).toBeCloseTo(0);
    expect(invertSafe([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]).every(Number.isFinite)).toBe(true);
    const m = compose4([1, 2, 3], [0.1, 0.2, 0.3], [2, 0.5, 3]);
    expectMat(multiply4(invertSafe(m), m), identity4());
    // tiny but valid scales are still inverted exactly
    const tiny = compose4([0, 0, 0], [0, 0, 0], [1e-6, 1e-6, 1e-6]);
    expect(invertSafe(tiny)[0]).toBeCloseTo(1e6, 0);
  });

  it('removes shear while keeping the primary axis direction', () => {
    const sheared = [1, 0.5, 0, 0, 0.2, 2, 0.3, 0, 0, 0.1, 3, 0, 4, 5, 6, 1];
    const o = orthogonalizeStable(sheared, 1, false);
    const col = (c: number) => [o[c * 4], o[c * 4 + 1], o[c * 4 + 2]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(col(0), col(1))).toBeCloseTo(0, 9);
    expect(dot(col(1), col(2))).toBeCloseTo(0, 9);
    expect(dot(col(0), col(2))).toBeCloseTo(0, 9);
    expect(col(1)).toEqual([0.2, 2, 0.3]); // primary axis untouched
    expect(o.slice(12)).toEqual([4, 5, 6, 1]);
    const n = orthogonalizeStable(sheared, 1, true);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1);
    expect(Math.hypot(n[4], n[5], n[6])).toBeCloseTo(1);
  });
});

describe('range helpers', () => {
  it('clamps angles on the circle', () => {
    expect(clampAngle(0.5, -1, 1)).toBe(0.5);
    expect(clampAngle(2, -1, 1)).toBeCloseTo(1);
    expect(clampAngle(-2, -1, 1)).toBeCloseTo(-1);
    // 300° is -60°: inside [-90°, 90°] on the circle
    expect(clampAngle(300 * DEG, -90 * DEG, 90 * DEG)).toBeCloseTo(300 * DEG);
    // an empty range collapses to min, a full turn never clamps
    expect(clampAngle(1, 0.2, 0.2)).toBe(0.2);
    expect(clampAngle(5, -Math.PI, Math.PI)).toBe(5);
  });

  it('maps coordinates to Clamp To path times', () => {
    expect(clampToTime(5, 0, 10, false)).toBeCloseTo(0.5);
    expect(clampToTime(-5, 0, 10, false)).toBe(0);
    expect(clampToTime(15, 0, 10, false)).toBe(1);
    expect(clampToTime(15, 0, 10, true)).toBeCloseTo(0.5);
    expect(clampToTime(-2.5, 0, 10, true)).toBeCloseTo(0.75);
    expect(clampToTime(3, 2, 2, true)).toBe(0);
    expect(clampToTime(3, 2, 2, false)).toBe(1);
  });
});
