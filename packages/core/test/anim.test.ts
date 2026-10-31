import { describe, expect, it } from 'vitest';
import { createFCurve, evaluateFCurve, insertKeyframe, removeKeyframe, type FCurve } from '../src';

function curve(keys: [number, number][], interp: 'LINEAR' | 'BEZIER' | 'CONSTANT' = 'BEZIER'): FCurve {
  let fc = createFCurve({ target_type: 'object', target_id: 'x', path: 'location', index: 0 });
  for (const [f, v] of keys) fc = insertKeyframe(fc, f, v, interp);
  return fc;
}

describe('fcurves', () => {
  it('interpolates linearly and holds constants outside the range', () => {
    const fc = curve([
      [1, 0],
      [11, 10],
    ], 'LINEAR');
    expect(evaluateFCurve(fc, 6)).toBeCloseTo(5);
    expect(evaluateFCurve(fc, -5)).toBe(0);
    expect(evaluateFCurve(fc, 50)).toBe(10);
  });

  it('linear extrapolation', () => {
    const fc = { ...curve([[0, 0], [10, 10]], 'LINEAR'), extrapolation: 'LINEAR' as const };
    expect(evaluateFCurve(fc, 20)).toBeCloseTo(20);
    expect(evaluateFCurve(fc, -10)).toBeCloseTo(-10);
  });

  it('bezier is smooth, hits keys and never overshoots (auto-clamped)', () => {
    const fc = curve([
      [0, 0],
      [10, 10],
      [20, 0],
    ]);
    expect(evaluateFCurve(fc, 10)).toBeCloseTo(10);
    for (let f = 0; f <= 20; f += 0.5) {
      const v = evaluateFCurve(fc, f)!;
      expect(v).toBeLessThanOrEqual(10 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
    }
    // ease in/out: slow near the keys
    expect(evaluateFCurve(fc, 1)!).toBeLessThan(1);
  });

  it('constant interpolation steps', () => {
    const fc = curve([[0, 1], [10, 5]], 'CONSTANT');
    expect(evaluateFCurve(fc, 9.9)).toBe(1);
    expect(evaluateFCurve(fc, 10)).toBe(5);
  });

  it('replaces and removes keyframes', () => {
    let fc = curve([[0, 1], [10, 5]]);
    fc = insertKeyframe(fc, 10, 7);
    expect(fc.keyframes).toHaveLength(2);
    expect(evaluateFCurve(fc, 10)).toBe(7);
    fc = removeKeyframe(fc, 0);
    expect(fc.keyframes).toHaveLength(1);
    expect(evaluateFCurve(createFCurve({ target_type: 'object', target_id: 'x', path: 'location', index: 0 }), 3)).toBeUndefined();
  });
});
