import { describe, expect, it } from 'vitest';
import {
  FMODIFIER_PARAM_SCHEMAS,
  FMODIFIER_TYPES,
  FMODIFIER_TYPE_INFO,
  FModifierError,
  applyFModifiers,
  createFModifier,
  defaultFModifierParams,
  normalizeFModifierParams,
  resolveFModifierType,
} from '../src/anim/fmodifiers';
import { gradientNoise3 } from '../src/anim/expression';
import { createFCurve, evaluateFCurve, insertKeyframe } from '../src/anim/fcurve';
import { SceneDoc, SceneEvaluator } from '../src';
import type { FCurve, FModifierData, FModifierType } from '../src/doc/types';

const mod = (type: FModifierType, params: Record<string, unknown> = {}, mute = false) =>
  createFModifier(type, params, mute);

/** value = frame everywhere (linear keys 0→0, 128→128, linear extrapolation; exact in binary). */
function linearCurve(mods: FModifierData[], extrapolation: FCurve['extrapolation'] = 'LINEAR'): FCurve {
  let fc = createFCurve({ target_type: 'object', target_id: 'x', path: 'location', index: 0 });
  fc = insertKeyframe(fc, 0, 0, 'LINEAR');
  fc = insertKeyframe(fc, 128, 128, 'LINEAR');
  return { ...fc, extrapolation, modifiers: mods };
}

/** A curve holding `value` at every frame. */
function constantCurve(value: number, mods: FModifierData[]): FCurve {
  const fc = insertKeyframe(createFCurve({ target_type: 'object', target_id: 'x', path: 'location', index: 0 }), 1, value);
  return { ...fc, modifiers: mods };
}

const at = (fc: FCurve, frame: number) => evaluateFCurve(fc, frame)!;

/** Lattice shifts of the NOISE modifier (keep integer frames off the gradient-noise lattice). */
const SHIFT = [0.3183098861837907, 0.5772156649015329, 0.7236067977499789];

/** Reference NOISE value n in [0, 1] following the documented formula. */
function refNoise(
  t: number,
  o: { scale?: number; phase?: number; offset?: number; depth?: number; lacunarity?: number; roughness?: number } = {},
): number {
  const { scale = 1, phase = 1, offset = 0, depth = 0, lacunarity = 2, roughness = 0.5 } = o;
  const layer = (size: number) =>
    0.5 +
    0.5 * gradientNoise3((1 + t - offset) / size + SHIFT[0], (1 + phase) / size + SHIFT[1], 1.1 / size + SHIFT[2]);
  let sum = layer(scale);
  let w = 1;
  let total = 1;
  let size = scale;
  for (let k = 0; k < depth; k++) {
    w *= roughness;
    size /= lacunarity;
    sum += w * layer(size);
    total += w;
  }
  return sum / total;
}

describe('GENERATOR', () => {
  it('replaces the curve by a polynomial of the frame', () => {
    expect(at(constantCurve(5, [mod('GENERATOR')]), 7)).toBe(7);
    expect(at(constantCurve(5, [mod('GENERATOR', { coefficients: [1, 2, 3] })]), 2)).toBe(17);
    expect(at(constantCurve(5, [mod('GENERATOR', { coefficients: [0, 0.5], use_additive: true })]), 4)).toBe(7);
    // factorised: (2t + 1)(1t - 3) at t = 5 → 11 * 2
    const f = mod('GENERATOR', { mode: 'POLYNOMIAL_FACTORISED', coefficients: [2, 1, 1, -3] });
    expect(at(constantCurve(0, [f]), 5)).toBe(22);
  });

  it('keeps coefficients and polynomial order consistent', () => {
    const p = (params: Record<string, unknown>) =>
      normalizeFModifierParams('GENERATOR', params) as { poly_order: number; coefficients: number[] };
    expect(p({}).coefficients).toEqual([0, 1]);
    expect(p({}).poly_order).toBe(1);
    expect(p({ poly_order: 3 }).coefficients).toEqual([0, 1, 0, 0]);
    expect(p({ coefficients: [1, 2, 3] }).poly_order).toBe(2);
    expect(p({ poly_order: 1, coefficients: [1, 2, 3] }).coefficients).toEqual([1, 2]);
    expect(p({ mode: 'POLYNOMIAL_FACTORISED', coefficients: [1, 2, 3] }).coefficients).toEqual([1, 2, 3, 0]);
    expect(p({ coefficients: [4] }).coefficients).toEqual([4, 0]);
    // updating the order resizes the stored coefficients; new coefficients re-derive the order
    const base = p({ coefficients: [1, 2, 3] }) as unknown as Record<string, unknown>;
    expect((normalizeFModifierParams('GENERATOR', { poly_order: 1 }, base) as { coefficients: number[] }).coefficients).toEqual([1, 2]);
    expect((normalizeFModifierParams('GENERATOR', { coefficients: [7] }, base) as { poly_order: number }).poly_order).toBe(1);
  });
});

describe('NOISE', () => {
  it('matches the documented turbulence formula for every blend type', () => {
    const t = 13;
    const n = refNoise(t);
    expect(at(constantCurve(5, [mod('NOISE', { strength: 2 })]), t)).toBeCloseTo(5 + (n - 0.5) * 2, 12);
    expect(at(constantCurve(5, [mod('NOISE', { strength: 2, blend_type: 'ADD' })]), t)).toBeCloseTo(5 + n * 2, 12);
    expect(at(constantCurve(5, [mod('NOISE', { strength: 2, blend_type: 'SUBTRACT' })]), t)).toBeCloseTo(
      5 - n * 2,
      12,
    );
    expect(at(constantCurve(5, [mod('NOISE', { strength: 2, blend_type: 'MULTIPLY' })]), t)).toBeCloseTo(
      5 * n * 2,
      12,
    );
  });

  it('adds octaves with lacunarity and roughness', () => {
    const t = 21.5;
    const layer = (size: number) =>
      0.5 + 0.5 * gradientNoise3((1 + t) / size + SHIFT[0], 2 / size + SHIFT[1], 1.1 / size + SHIFT[2]);
    // depth 1, defaults: (n(scale) + 0.5 n(scale / 2)) / 1.5
    const d1 = (layer(4) + 0.5 * layer(2)) / 1.5;
    expect(at(constantCurve(0, [mod('NOISE', { scale: 4, depth: 1, blend_type: 'ADD' })]), t)).toBeCloseTo(d1, 12);
    // depth 2, lacunarity 3, roughness 0.25: (n(s) + 0.25 n(s/3) + 0.0625 n(s/9)) / 1.3125
    const d2 = (layer(9) + 0.25 * layer(3) + 0.0625 * layer(1)) / 1.3125;
    const m = mod('NOISE', { scale: 9, depth: 2, lacunarity: 3, roughness: 0.25, blend_type: 'ADD' });
    expect(at(constantCurve(0, [m]), t)).toBeCloseTo(d2, 12);
    expect(refNoise(t, { scale: 9, depth: 2, lacunarity: 3, roughness: 0.25 })).toBeCloseTo(d2, 12);
  });

  it('is deterministic, phase acts as a seed and offset shifts it in time', () => {
    const a = constantCurve(0, [mod('NOISE', { phase: 3 })]);
    const b = constantCurve(0, [mod('NOISE', { phase: 3 })]);
    const c = constantCurve(0, [mod('NOISE', { phase: 4 })]);
    const shifted = constantCurve(0, [mod('NOISE', { phase: 3, offset: 3 })]);
    let differs = 0;
    for (let f = 0; f < 50; f++) {
      expect(at(a, f)).toBe(at(b, f));
      if (Math.abs(at(a, f) - at(c, f)) > 1e-6) differs++;
      expect(at(shifted, f + 3)).toBeCloseTo(at(a, f), 12);
    }
    expect(differs).toBeGreaterThan(45);
  });

  it('stays centred around the curve with REPLACE and varies on integer frames', () => {
    const fc = constantCurve(10, [mod('NOISE', { strength: 4, scale: 5, depth: 2 })]);
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const values = new Set<number>();
    for (let f = 0; f < 2000; f++) {
      const v = at(fc, f);
      sum += v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      values.add(Math.round(v * 1e6));
    }
    expect(sum / 2000).toBeCloseTo(10, 0);
    expect(lo).toBeGreaterThan(10 - 2.2);
    expect(hi).toBeLessThan(10 + 2.2);
    expect(hi - lo).toBeGreaterThan(1);
    expect(values.size).toBeGreaterThan(1900);
  });
});

describe('STEPPED', () => {
  it('holds values for frame_step frames (Blender truncation toward zero)', () => {
    const fc = (params: Record<string, unknown>) => linearCurve([mod('STEPPED', params)]);
    expect(at(fc({ frame_step: 4 }), 7)).toBe(4);
    expect(at(fc({ frame_step: 4 }), 8)).toBe(8);
    expect(at(fc({ frame_step: 4 }), 4.5)).toBe(4);
    expect(at(fc({}), 5)).toBe(4); // default step 2
    expect(at(fc({ frame_step: 4, frame_offset: 1 }), 7)).toBe(5);
    expect(at(fc({ frame_step: 2 }), -3)).toBe(-2);
    expect(at(fc({ frame_step: 0.1 }), 0.3)).toBeCloseTo(0.3, 9);
  });

  it('honours the start/end frames and influence', () => {
    const s = (params: Record<string, unknown>) => linearCurve([mod('STEPPED', { frame_step: 4, ...params })]);
    expect(at(s({ use_frame_start: true, frame_start: 10 }), 7)).toBe(7);
    expect(at(s({ use_frame_start: true, frame_start: 10 }), 13)).toBe(12);
    expect(at(s({ use_frame_end: true, frame_end: 20 }), 23)).toBe(23);
    expect(at(s({ use_frame_end: true, frame_end: 20 }), 18)).toBe(16);
    // influence blends the sampling time: lerp(7, 4, 0.5)
    expect(at(s({ use_influence: true, influence: 0.5 }), 7)).toBe(5.5);
  });

  it('applies time modifiers last-to-first and steps the value modifiers below', () => {
    const coarseFirst = linearCurve([mod('STEPPED', { frame_step: 10 }), mod('STEPPED', { frame_step: 4 })]);
    expect(at(coarseFirst, 17)).toBe(10); // 17 → 16 (step 4) → 10 (step 10)
    const fineFirst = linearCurve([mod('STEPPED', { frame_step: 4 }), mod('STEPPED', { frame_step: 10 })]);
    expect(at(fineFirst, 17)).toBe(8); // 17 → 10 (step 10) → 8 (step 4)
    const steppedNoise = constantCurve(0, [mod('STEPPED', { frame_step: 4 }), mod('NOISE', { strength: 3 })]);
    expect(at(steppedNoise, 5)).toBe(at(steppedNoise, 4));
    expect(at(steppedNoise, 7)).toBe(at(steppedNoise, 4));
    expect(at(steppedNoise, 8)).not.toBe(at(steppedNoise, 4));
  });

  it('works with cyclic extrapolation and needs the sampler', () => {
    let fc = createFCurve({ target_type: 'object', target_id: 'x', path: 'location', index: 0 });
    fc = insertKeyframe(fc, 0, 0, 'LINEAR');
    fc = insertKeyframe(fc, 10, 10, 'LINEAR');
    const cyc: FCurve = { ...fc, extrapolation: 'CYCLIC', modifiers: [mod('STEPPED', { frame_step: 3 })] };
    expect(at(cyc, 14)).toBe(2); // stepped to 12, cycled to 2
    // without a sampler (plain value API) time modifiers cannot resample: unchanged
    expect(applyFModifiers([mod('STEPPED', { frame_step: 4 })], 7, 7)).toBe(7);
    expect(applyFModifiers([mod('STEPPED', { frame_step: 4 })], 7, 7, (t) => t * 10)).toBe(40);
  });
});

describe('LIMITS', () => {
  it('clamps values and sampling frames', () => {
    const y = linearCurve([mod('LIMITS', { use_min_y: true, min_y: 20, use_max_y: true, max_y: 50 })]);
    expect(at(y, 10)).toBe(20);
    expect(at(y, 70)).toBe(50);
    expect(at(y, 30)).toBe(30);
    const x = linearCurve([mod('LIMITS', { use_min_x: true, min_x: 10, use_max_x: true, max_x: 50 })]);
    expect(at(x, 3)).toBe(10);
    expect(at(x, 70)).toBe(50);
    expect(at(x, 25)).toBe(25);
    const soft = linearCurve([mod('LIMITS', { use_max_y: true, max_y: 50, use_influence: true, influence: 0.5 })]);
    expect(at(soft, 70)).toBe(60);
    // disabled limits do nothing
    expect(at(linearCurve([mod('LIMITS', { min_y: 20, max_y: 30 })]), 70)).toBe(70);
  });
});

describe('ENVELOPE', () => {
  it('maps the reference band onto interpolated control point bounds', () => {
    const env = (params: Record<string, unknown>, value = 0.5) => constantCurve(value, [mod('ENVELOPE', params)]);
    const pts = {
      control_points: [
        { frame: 10, min: 0, max: 0 },
        { frame: 0, min: -2, max: 2 },
      ],
    };
    // v = 0.5 in band [-1, 1] → fac 0.75
    expect(at(env(pts), 0)).toBe(1); // -2 + 0.75 * 4
    expect(at(env(pts), -5)).toBe(1);
    expect(at(env(pts), 5)).toBe(0.5); // bounds [-1, 1]
    expect(at(env(pts), 20)).toBe(0);
    // reference 5: band [4, 6]; v = 5.5 → fac 0.75 → 3 + 0.75 * 4
    expect(at(env({ reference_value: 5, control_points: [{ frame: 0, min: 3, max: 7 }] }, 5.5), 0)).toBe(6);
    // no points / zero-width band: no effect
    expect(at(env({}), 3)).toBe(0.5);
    expect(at(env({ ...pts, default_min: 1, default_max: 1 }), 3)).toBe(0.5);
    const sorted = normalizeFModifierParams('ENVELOPE', pts) as { control_points: { frame: number }[] };
    expect(sorted.control_points.map((p) => p.frame)).toEqual([0, 10]);
  });
});

describe('influence, mute, restricted range and stacking', () => {
  const ten = { coefficients: [10] };

  it('blends by influence and skips muted modifiers', () => {
    expect(at(constantCurve(0, [mod('GENERATOR', { ...ten, use_influence: true, influence: 0.25 })]), 3)).toBe(2.5);
    expect(at(constantCurve(0, [mod('GENERATOR', { ...ten, influence: 0.25 })]), 3)).toBe(10);
    expect(at(constantCurve(0, [mod('GENERATOR', ten, true)]), 3)).toBe(0);
  });

  it('fades restricted ranges in and out', () => {
    const fc = constantCurve(0, [
      mod('GENERATOR', {
        ...ten,
        use_restricted_range: true,
        frame_start: 10,
        frame_end: 20,
        blend_in: 4,
        blend_out: 2,
      }),
    ]);
    expect(at(fc, 5)).toBe(0);
    expect(at(fc, 10)).toBe(0);
    expect(at(fc, 12)).toBe(5);
    expect(at(fc, 15)).toBe(10);
    expect(at(fc, 19)).toBe(5);
    expect(at(fc, 20)).toBe(0);
    expect(at(fc, 25)).toBe(0);
  });

  it('evaluates value modifiers in stack order', () => {
    const add = mod('GENERATOR', { coefficients: [1], use_additive: true });
    const clamp = mod('LIMITS', { use_max_y: true, max_y: 5 });
    expect(at(constantCurve(5, [add, clamp]), 1)).toBe(5);
    expect(at(constantCurve(5, [clamp, add]), 1)).toBe(6);
  });
});

describe('robustness of stored data', () => {
  it('never throws for malformed modifiers and falls back to defaults', () => {
    const defaults = at(constantCurve(0, [mod('NOISE')]), 7.5);
    const bad = { type: 'NOISE', params: { scale: -1, strength: 'big', bogus: 1 } } as unknown as FModifierData;
    expect(at(constantCurve(0, [bad]), 7.5)).toBe(defaults);
    const noParams = { type: 'GENERATOR', params: null } as unknown as FModifierData;
    expect(at(constantCurve(0, [noParams]), 7)).toBe(7);
    const odd = [
      null,
      { type: 'CYCLES', params: {} },
      { type: 'toString', params: {} },
      { type: 'constructor' },
      'NOISE',
    ] as unknown as FModifierData[];
    expect(at(constantCurve(3, odd), 7)).toBe(3);
    const cyclic: Record<string, unknown> = { strength: 1 };
    cyclic.self = cyclic;
    expect(() => at(constantCurve(0, [{ type: 'NOISE', params: cyclic } as unknown as FModifierData]), 2)).not.toThrow();
    // a modifier producing a non-finite value is skipped
    expect(at(constantCurve(4, [mod('GENERATOR', { coefficients: [0, 1e308] })]), 100)).toBe(4);
    // partially valid control point lists keep their valid points
    const env = {
      type: 'ENVELOPE',
      params: { control_points: [{ frame: 0, min: -2, max: 2 }, { frame: 'x' }, null] },
    } as unknown as FModifierData;
    expect(at(constantCurve(0.5, [env]), 0)).toBe(1);
    expect(applyFModifiers(undefined as unknown as FModifierData[], 1, 2)).toBe(2);
  });

  it('validates parameters strictly when creating modifiers', () => {
    expect(() => normalizeFModifierParams('NOISE', { strenght: 2 })).toThrow(
      /unknown parameter\(s\) 'strenght'.*Valid parameters: blend_type, scale/,
    );
    expect(() => normalizeFModifierParams('NOISE', { scale: 'x' })).toThrow(FModifierError);
    expect(() => normalizeFModifierParams('NOISE', { scale: 0 })).toThrow(/scale/);
    expect(() => normalizeFModifierParams('NOISE', { depth: 99 })).toThrow(/depth/);
    expect(() => normalizeFModifierParams('STEPPED', { frame_step: -1 })).toThrow(/frame_step/);
    expect(() => normalizeFModifierParams('LIMITS', { influence: 2 })).toThrow(/influence/);
    expect(() => normalizeFModifierParams('ENVELOPE', { control_points: [{ frame: 1 }] })).toThrow(
      /control_points/,
    );
    expect(() => normalizeFModifierParams('STEPPED', { use_restricted_range: true })).toThrow(/unknown parameter/);
    expect(() => normalizeFModifierParams('CYCLES' as FModifierType, {})).toThrow(/Unknown F-curve modifier type/);
    expect(resolveFModifierType(' noise ')).toBe('NOISE');
    expect(resolveFModifierType('nope')).toBeNull();
  });

  it('documents defaults for every type', () => {
    for (const type of FMODIFIER_TYPES) {
      expect(FMODIFIER_TYPE_INFO.find((i) => i.type === type)).toBeTruthy();
      const d = defaultFModifierParams(type) as Record<string, unknown>;
      expect(d.use_influence).toBe(false);
      expect(d.influence).toBe(1);
      for (const [key, field] of Object.entries(FMODIFIER_PARAM_SCHEMAS[type].shape))
        expect((field as { description?: string }).description, `${type}.${key}`).toBeTruthy();
    }
    expect(defaultFModifierParams('NOISE')).toMatchObject({ scale: 1, strength: 1, phase: 1, depth: 0 });
    expect(defaultFModifierParams('STEPPED')).toMatchObject({ frame_step: 2, frame_offset: 0 });
    expect(defaultFModifierParams('ENVELOPE')).toMatchObject({ default_min: -1, default_max: 1 });
  });
});

describe('scene evaluation with F-curve modifiers', () => {
  it('applies modifiers to animated objects and survives snapshots', () => {
    const doc = new SceneDoc();
    const id = doc.addObject({ type: 'EMPTY', name: 'Shaky' });
    let z = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 2 });
    z = insertKeyframe(z, 1, 1, 'LINEAR');
    doc.setFCurve({ ...z, modifiers: [mod('NOISE', { strength: 2, scale: 3 })] });
    let x = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    x = insertKeyframe(x, 0, 0, 'LINEAR');
    x = insertKeyframe(x, 100, 100, 'LINEAR');
    doc.setFCurve({ ...x, modifiers: [mod('STEPPED', { frame_step: 5 })] });
    doc.setFCurve({
      ...insertKeyframe(createFCurve({ target_type: 'object', target_id: id, path: 'scale', index: 1 }), 1, 1),
      modifiers: [mod('ENVELOPE', { control_points: [{ frame: 0, min: 0, max: 4 }] })],
    });
    const ev = new SceneEvaluator(doc);
    for (const f of [1, 2, 7, 13]) {
      const o = ev.evaluate(f).byId.get(id)!;
      expect(o.data.location[2]).toBeCloseTo(1 + (refNoise(f, { scale: 3 }) - 0.5) * 2, 12);
      expect(o.worldMatrix[14]).toBeCloseTo(o.data.location[2], 12);
      expect(o.data.location[0]).toBe(Math.trunc(f / 5) * 5);
      expect(o.data.scale[1]).toBe(4); // band [-1, 1] → [0, 4]: the value 1 is the top of the band
    }
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    const ev2 = new SceneEvaluator(copy);
    expect(ev2.evaluate(7).byId.get(id)!.data.location[2]).toBe(ev.evaluate(7).byId.get(id)!.data.location[2]);
    expect(copy.listFCurves(id).find((f) => f.path === 'scale')!.modifiers![0].params.control_points).toEqual([
      { frame: 0, min: 0, max: 4 },
    ]);
  });
});
