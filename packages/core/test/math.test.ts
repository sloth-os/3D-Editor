import { describe, expect, it } from 'vitest';
import {
  compose4,
  decompose4,
  eulerFromQuat,
  invert4,
  multiply4,
  quatFromEuler,
  rotateVec3ByQuat,
  rotationFromEuler,
  transformPoint3,
  identity4,
  equals4,
  type Vec3,
} from '../src';

describe('math', () => {
  it('uses Blender XYZ euler convention (X applied first)', () => {
    // 90° about X then 90° about Z: +Y → +Z (X rot) → stays +Z (Z rot)
    const r = rotationFromEuler([Math.PI / 2, 0, Math.PI / 2]);
    const p = transformPoint3(r, [0, 1, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(1);
    // +X → (X rot keeps) → +Y after Z rot
    const q = transformPoint3(r, [1, 0, 0]);
    expect(q[1]).toBeCloseTo(1);
  });

  it('compose/decompose round-trips', () => {
    const loc: Vec3 = [1, -2, 3];
    const rot: Vec3 = [0.3, -0.7, 1.2];
    const scl: Vec3 = [2, 0.5, 1.5];
    const d = decompose4(compose4(loc, rot, scl));
    d.location.forEach((v, i) => expect(v).toBeCloseTo(loc[i]));
    d.rotation.forEach((v, i) => expect(v).toBeCloseTo(rot[i]));
    d.scale.forEach((v, i) => expect(v).toBeCloseTo(scl[i]));
  });

  it('inverts matrices', () => {
    const m = compose4([1, 2, 3], [0.1, 0.2, 0.3], [1, 2, 3]);
    expect(equals4(multiply4(m, invert4(m)), identity4(), 1e-9)).toBe(true);
  });

  it('quaternions agree with matrices', () => {
    const e: Vec3 = [0.4, -0.2, 2.1];
    const q = quatFromEuler(e);
    const v: Vec3 = [0.3, 1, -2];
    const a = rotateVec3ByQuat(q, v);
    const b = transformPoint3(rotationFromEuler(e), v);
    a.forEach((x, i) => expect(x).toBeCloseTo(b[i]));
    eulerFromQuat(q).forEach((x, i) => expect(x).toBeCloseTo(e[i]));
  });
});
