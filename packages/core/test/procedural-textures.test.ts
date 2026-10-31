import { describe, expect, it } from 'vitest';
import {
  PROCEDURAL_TYPES,
  PROCEDURAL_TYPE_ID,
  compileProcedural,
  defaultProcedural,
  describeProceduralParams,
  proceduralCoord,
  sampleProcedural,
  validateProceduralParams,
  type ProceduralTexture,
  type ProceduralType,
  type Vec3,
} from '../src';

const BW = {
  color_a: [0, 0, 0, 1] as ProceduralTexture['color_a'],
  color_b: [1, 1, 1, 1] as ProceduralTexture['color_b'],
};

function tex(type: ProceduralType, init: Partial<Omit<ProceduralTexture, 'type'>> = {}): ProceduralTexture {
  return defaultProcedural(type, { ...BW, ...init });
}

/** Red channel of a texture at a coordinate. */
const red = (t: ProceduralTexture, c: Vec3) => sampleProcedural(t, c)[0];

function grid(n = 9): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) out.push([(i + 0.37) / n, (j + 0.61) / n, ((i * 7 + j * 3) % n) / n]);
  return out;
}

describe('sampleProcedural', () => {
  it('evaluates every type to a non-constant pattern (differs from the color_a stub)', () => {
    for (const type of PROCEDURAL_TYPES) {
      const t = tex(type, { scale: type === 'GRADIENT' ? 1 : 4 });
      const values = new Set(
        grid().map((c) =>
          sampleProcedural(t, c)
            .map((v) => v.toFixed(6))
            .join(','),
        ),
      );
      expect(values.size, type).toBeGreaterThan(1);
      const notA = grid().some((c) =>
        sampleProcedural(t, c).some((v, i) => Math.abs(v - t.color_a[i]) > 1e-6),
      );
      expect(notA, type).toBe(true);
    }
  });

  it('is deterministic and stays within the ramp colours', () => {
    for (const type of PROCEDURAL_TYPES) {
      const t = tex(type, { distortion: type === 'NOISE' ? 0.7 : undefined });
      for (const c of grid(7)) {
        const a = sampleProcedural(t, c);
        expect(sampleProcedural(structuredClone(t), c)).toEqual(a);
        for (const v of a) {
          expect(v, type).toBeGreaterThanOrEqual(0);
          expect(v, type).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('applies scale and params.offset_* to the coordinate', () => {
    for (const type of ['NOISE', 'VORONOI', 'WAVE', 'MARBLE'] as const) {
      const c: Vec3 = [0.3, 0.7, 0.2];
      const s2 = sampleProcedural(tex(type, { scale: 2 }), c);
      const s1 = sampleProcedural(tex(type, { scale: 1 }), [0.6, 1.4, 0.4]);
      for (let i = 0; i < 4; i++) expect(s2[i]).toBeCloseTo(s1[i], 10);
      const shifted = sampleProcedural(tex(type, { scale: 3, params: { offset_x: 0.25, offset_z: -1 } }), c);
      const direct = sampleProcedural(tex(type, { scale: 3 }), [0.55, 0.7, -0.8]);
      for (let i = 0; i < 4; i++) expect(shifted[i]).toBeCloseTo(direct[i], 10);
    }
  });

  it('depends on the seed for random types only', () => {
    const differs = (type: ProceduralType) =>
      grid().some((c) => red(tex(type, { seed: 1 }), c) !== red(tex(type, { seed: 2 }), c));
    expect(differs('NOISE')).toBe(true);
    expect(differs('VORONOI')).toBe(true);
    expect(differs('BRICK')).toBe(true);
    expect(differs('CHECKER')).toBe(false);
    expect(differs('GRADIENT')).toBe(false);
  });

  it('maps the factor through the two-stop ramp (LINEAR, EASE, CONSTANT)', () => {
    const g = (init: Partial<ProceduralTexture>) =>
      tex('GRADIENT', { ramp_low: 0.2, ramp_high: 0.6, ...init });
    expect(red(g({}), [0.4, 0, 0])).toBeCloseTo(0.5, 12);
    expect(red(g({}), [0.1, 0, 0])).toBe(0);
    expect(red(g({}), [0.9, 0, 0])).toBe(1);
    expect(red(g({ params: { ramp_interpolation: 'EASE' } }), [0.3, 0, 0])).toBeCloseTo(0.15625, 12);
    expect(red(g({ params: { ramp_interpolation: 'CONSTANT' } }), [0.59, 0, 0])).toBe(0);
    expect(red(g({ params: { ramp_interpolation: 'CONSTANT' } }), [0.6, 0, 0])).toBe(1);
    // degenerate ramp: a step at ramp_high
    expect(red(g({ ramp_low: 0.5, ramp_high: 0.5 }), [0.49, 0, 0])).toBe(0);
    expect(red(g({ ramp_low: 0.5, ramp_high: 0.5 }), [0.51, 0, 0])).toBe(1);
    // colours interpolate per channel, including alpha
    const c = sampleProcedural(
      tex('GRADIENT', { color_a: [1, 0, 0, 0], color_b: [0, 0, 1, 1] }),
      [0.25, 0, 0],
    );
    expect(c).toEqual([0.75, 0, 0.25, 0.25]);
  });

  it('CHECKER alternates per scaled unit and keeps boundary faces consistent', () => {
    const t = tex('CHECKER', { scale: 1 });
    expect(red(t, [0.5, 0.5, 0.5])).toBe(0);
    expect(red(t, [1.5, 0.5, 0.5])).toBe(1);
    expect(red(t, [1.5, 1.5, 0.5])).toBe(0);
    expect(red(t, [-0.5, 0.5, 0.5])).toBe(1);
    const t5 = tex('CHECKER', { scale: 5 });
    // GENERATED coordinate 1 (bounding box face) lies in the same cell as 0.99
    expect(red(t5, [1, 0.5, 0.5])).toBe(red(t5, [0.99, 0.5, 0.5]));
    expect(red(t5, [0, 0.5, 0.5])).toBe(red(t5, [0.01, 0.5, 0.5]));
  });

  it('GRADIENT implements every gradient_type', () => {
    const g = (gradient_type: string, c: Vec3) => red(tex('GRADIENT', { params: { gradient_type } }), c);
    expect(g('LINEAR', [0.3, 0.9, 0])).toBeCloseTo(0.3, 12);
    expect(g('LINEAR', [1.7, 0, 0])).toBe(1);
    expect(g('QUADRATIC', [0.5, 0, 0])).toBeCloseTo(0.25, 12);
    expect(g('EASING', [0.25, 0, 0])).toBeCloseTo(0.15625, 12);
    expect(g('DIAGONAL', [0.2, 0.6, 0])).toBeCloseTo(0.4, 12);
    expect(g('SPHERICAL', [0, 0, 0])).toBeCloseTo(0.999999, 12);
    expect(g('SPHERICAL', [0.6, 0, 0.8])).toBe(0);
    expect(g('QUADRATIC_SPHERE', [0.5, 0, 0])).toBeCloseTo(0.499999 ** 2, 9);
    expect(g('RADIAL', [0, 1, 0])).toBeCloseTo(0.75, 12);
    expect(g('RADIAL', [0, -1, 0])).toBeCloseTo(0.25, 12);
  });

  it('WAVE: bands/rings, profiles and direction', () => {
    const w = (params: Record<string, string | number>, c: Vec3) => red(tex('WAVE', { scale: 1, params }), c);
    const half = Math.PI / 20; // n = 20·x = π: half a period
    expect(w({}, [0, 0, 0])).toBeCloseTo(0, 12);
    expect(w({}, [half, 0, 0])).toBeCloseTo(1, 12);
    expect(w({ wave_profile: 'SAW' }, [half, 0, 0])).toBeCloseTo(0.5, 12);
    expect(w({ wave_profile: 'TRI' }, [half, 0, 0])).toBeCloseTo(1, 12);
    expect(w({ direction: 'Y' }, [half, 0, 0])).toBeCloseTo(0, 12);
    expect(w({ direction: 'Y' }, [0, half, 0])).toBeCloseTo(1, 12);
    expect(w({ phase: Math.PI }, [0, 0, 0])).toBeCloseTo(1, 12);
    // spherical rings only depend on the distance to the origin
    const r = (c: Vec3) => w({ wave_type: 'RINGS', direction: 'SPHERICAL' }, c);
    expect(r([0.3, 0.4, 0])).toBeCloseTo(r([0, 0, 0.5]), 12);
    // rings around Z ignore z
    const rz = (c: Vec3) => w({ wave_type: 'RINGS', direction: 'Z' }, c);
    expect(rz([0.3, 0.4, 0])).toBeCloseTo(rz([0.4, 0.3, 7]), 12);
    // distortion changes the pattern
    expect(red(tex('WAVE', { scale: 1, distortion: 3 }), [0.3, 0.2, 0.1])).not.toBeCloseTo(
      w({}, [0.3, 0.2, 0.1]),
      6,
    );
  });

  it('BRICK: mortar colour in the joints, one random tint per brick, WALL plane', () => {
    const params = { mortar_size: 0.02, mortar_smooth: 0, mortar_r: 0.25, mortar_g: 0.5, mortar_b: 0.75 };
    const b = tex('BRICK', { scale: 1, params });
    expect(sampleProcedural(b, [0.001, 0.001, 0])).toEqual([0.25, 0.5, 0.75, 1]);
    // row 1 is not offset (offset_frequency 2 offsets rows 0, 2, …)
    const inBrick = sampleProcedural(b, [0.3, 0.37, 0]);
    expect(sampleProcedural(b, [0.2, 0.33, 0])).toEqual(inBrick);
    expect(inBrick[0]).toBe(inBrick[1]); // grey ramp
    const tints = new Set<number>();
    for (let i = 0; i < 20; i++) tints.add(red(b, [0.25 + i * 0.5, 0.375, 0]));
    expect(tints.size).toBeGreaterThan(5);
    // bias −1 pins every brick to color_a
    expect(red(tex('BRICK', { scale: 1, params: { ...params, bias: -1 } }), [0.3, 0.37, 0])).toBe(0);
    // WALL: courses stack along Z, so moving along Z crosses joints, moving along Y within a brick does not
    const wall = tex('BRICK', { scale: 1, params: { ...params, plane: 'WALL' } });
    expect(sampleProcedural(wall, [0.1, 0, 0.001])).toEqual([0.25, 0.5, 0.75, 1]);
    expect(sampleProcedural(wall, [0.2, 0, 0.37])).toEqual(sampleProcedural(wall, [0.1, 0.1, 0.37]));
  });

  it('VORONOI: features, per-cell values and colour randomness', () => {
    const v = (params: Record<string, string | number>, c: Vec3) =>
      sampleProcedural(tex('VORONOI', { scale: 1, params }), c);
    const f1 = v({}, [0.3, 0.6, 0.2])[0];
    const f2 = v({ feature: 'F2' }, [0.3, 0.6, 0.2])[0];
    expect(f1).toBeLessThanOrEqual(f2);
    // randomness 0 + CELL: constant inside a cell
    const cell = { feature: 'CELL', randomness: 0 };
    expect(v(cell, [2.1, 3.2, 4.3])).toEqual(v(cell, [1.9, 2.8, 4.4]));
    // full colour randomness replaces the ramp colour by the random cell colour
    const col = v({ color_randomness: 1 }, [0.3, 0.6, 0.2]);
    const col2 = v({ color_randomness: 1, feature: 'F2' }, [0.3, 0.6, 0.2]);
    expect(col).toEqual(col2);
    expect(new Set(col.slice(0, 3)).size).toBeGreaterThan(1);
  });

  it('MARBLE sharpness, WOOD rings and MAGIC channels', () => {
    for (const c of grid(5)) {
      const m = (marble_type: string) => red(tex('MARBLE', { params: { marble_type } }), c);
      expect(m('SHARP')).toBeGreaterThanOrEqual(m('SOFT') - 1e-12);
      expect(m('SHARPER')).toBeGreaterThanOrEqual(m('SHARP') - 1e-12);
    }
    // regular rings (no distortion, no grain) depend on the distance from the Z axis only
    const wood = tex('WOOD', { scale: 3, distortion: 0, params: { grain: 0 } });
    expect(red(wood, [0.3, 0.4, 0])).toBeCloseTo(red(wood, [0, 0.5, 2]), 12);
    expect(red(wood, [0.3, 0.4, 0])).not.toBeCloseTo(red(wood, [0.3, 0.45, 0]), 3);
    // MAGIC ramps every channel separately
    const magic = tex('MAGIC', { scale: 1 });
    expect(
      grid().some((c) => {
        const s = sampleProcedural(magic, c);
        return Math.abs(s[0] - s[1]) > 0.05;
      }),
    ).toBe(true);
    const depth0 = tex('MAGIC', { detail: 0 });
    expect(grid().some((c) => red(depth0, c) !== red(tex('MAGIC', { detail: 3 }), c))).toBe(true);
  });

  it('never throws on invalid data and falls back to defaults', () => {
    const bad = {
      type: 'NOPE',
      mapping: 'WHATEVER',
      scale: NaN,
      detail: Infinity,
      roughness: -3,
      distortion: 'x',
      color_a: [0.2, 0.4, 0.6],
      color_b: null,
      ramp_low: undefined,
      ramp_high: 'y',
      seed: 'z',
      params: { lacunarity: 'big', noise_type: 42 },
    } as unknown as ProceduralTexture;
    // unknown type: constant color_a (alpha completed to 1)
    expect(sampleProcedural(bad, [0.3, 0.2, 0.1])).toEqual([0.2, 0.4, 0.6, 1]);
    const noise = { ...bad, type: 'NOISE' } as ProceduralTexture;
    for (const c of [
      [NaN, 0, 0],
      [Infinity, -Infinity, 1e30],
      [0.3, 0.2, 0.1],
    ] as Vec3[])
      for (const v of sampleProcedural(noise, c)) expect(Number.isFinite(v)).toBe(true);
    expect(sampleProcedural(null as unknown as ProceduralTexture, [0, 0, 0]).every(Number.isFinite)).toBe(
      true,
    );
    const noParams = { ...tex('BRICK'), params: undefined } as unknown as ProceduralTexture;
    expect(sampleProcedural(noParams, [0.3, 0.3, 0]).every(Number.isFinite)).toBe(true);
  });

  it('re-validates its compile cache when a texture object is mutated', () => {
    const t = tex('GRADIENT');
    expect(red(t, [0.3, 0, 0])).toBeCloseTo(0.3, 12);
    t.color_b = [0.5, 0.5, 0.5, 1];
    expect(red(t, [0.3, 0, 0])).toBeCloseTo(0.15, 12);
    t.params.gradient_type = 'QUADRATIC';
    expect(red(t, [0.3, 0, 0])).toBeCloseTo(0.045, 12);
    t.scale = 2;
    expect(red(t, [0.3, 0, 0])).toBeCloseTo(0.18, 12);
  });
});

describe('compiled form (layout shared with the GLSL)', () => {
  it('packs params into the documented slots', () => {
    const c = compileProcedural(
      tex('BRICK', {
        params: {
          plane: 'WALL',
          mortar_size: 0.03,
          mortar_smooth: 0.2,
          brick_width: 0.6,
          row_height: 0.3,
          offset: 0.4,
          squash: 0.9,
          bias: 0.1,
          offset_frequency: 3,
          squash_frequency: 4,
          mortar_r: 0.1,
          mortar_g: 0.2,
          mortar_b: 0.3,
          ramp_interpolation: 'EASE',
          offset_x: 1,
          offset_y: 2,
          offset_z: 3,
        },
      }),
    );
    expect(c.type).toBe(PROCEDURAL_TYPE_ID.BRICK);
    expect(c.mode).toEqual([3, 4, 1, 1]);
    expect(c.k0).toEqual([0.03, 0.2, 0.6, 0.3]);
    expect(c.k1).toEqual([0.4, 0.9, 0.1, 0]);
    expect(c.k2).toEqual([0.1, 0.2, 0.3, 1]);
    expect(c.offset).toEqual([1, 2, 3, 0]);
    const n = compileProcedural(tex('NOISE', { params: { noise_type: 'RIDGED', lacunarity: 3 } }));
    expect(n.mode[0]).toBe(1);
    expect(n.k0[0]).toBe(3);
    const w = compileProcedural(
      tex('WAVE', { params: { wave_type: 'RINGS', direction: 'Z', wave_profile: 'TRI' } }),
    );
    expect(w.mode.slice(0, 3)).toEqual([1, 2, 2]);
    expect(compileProcedural(tex('MAGIC', { detail: 12.7 })).mode[0]).toBe(10);
  });

  it('clamps out-of-range values', () => {
    const c = compileProcedural(
      tex('NOISE', { detail: 99, roughness: 7, params: { lacunarity: 100, bump_distance: -1 } }),
    );
    expect(c.basic[1]).toBe(15);
    expect(c.basic[2]).toBe(1);
    expect(c.k0[0]).toBe(8);
    expect(c.bumpDistance).toBe(0);
  });
});

describe('proceduralCoord', () => {
  it('normalises GENERATED coordinates to the bounding box (0.5 on flat axes)', () => {
    expect(proceduralCoord('GENERATED', [1, 0, 3], [-1, -2, 3], [3, 2, 3], null)).toEqual([0.5, 0.5, 0.5]);
    expect(proceduralCoord('GENERATED', [3, 2, 0], [-1, -2, 0], [3, 2, 1], null)).toEqual([1, 1, 0]);
    expect(proceduralCoord('OBJECT', [1, 2, 3], [0, 0, 0], [1, 1, 1], null)).toEqual([1, 2, 3]);
    expect(proceduralCoord('UV', [1, 2, 3], [0, 0, 0], [1, 1, 1], [0.25, 0.75])).toEqual([0.25, 0.75, 0]);
    expect(proceduralCoord('UV', [1, 2, 3], [0, 0, 0], [1, 1, 1], null)).toEqual([0, 0, 0]);
  });
});

describe('param specification', () => {
  it('validates params per type', () => {
    expect(validateProceduralParams('NOISE', { noise_type: 'RIDGED', lacunarity: 2.5, offset_x: 1 })).toEqual(
      [],
    );
    expect(validateProceduralParams('NOISE', { foo: 1 })[0]).toMatch(/unknown param 'foo'/);
    expect(validateProceduralParams('NOISE', { noise_type: 'SMOOTH' })[0]).toMatch(/FBM\|RIDGED\|TURBULENCE/);
    expect(validateProceduralParams('BRICK', { offset_frequency: 1.5 })[0]).toMatch(/integer/);
    expect(validateProceduralParams('VORONOI', { randomness: 2 })[0]).toMatch(/\[0, 1\]/);
    expect(validateProceduralParams('WAVE', { phase: 'x' })[0]).toMatch(/finite number/);
    expect(validateProceduralParams('BOGUS' as ProceduralType, {})[0]).toMatch(/unknown procedural type/);
    expect(describeProceduralParams('CHECKER')).toBe('none');
    expect(describeProceduralParams('GRADIENT')).toMatch(/gradient_type=LINEAR\|/);
  });

  it('builds complete textures with per-type defaults', () => {
    for (const type of PROCEDURAL_TYPES) {
      const t = defaultProcedural(type);
      expect(Object.keys(t).sort()).toEqual(
        [
          'color_a',
          'color_b',
          'detail',
          'distortion',
          'mapping',
          'params',
          'ramp_high',
          'ramp_low',
          'roughness',
          'scale',
          'seed',
          'type',
        ].sort(),
      );
      expect(t.type).toBe(type);
    }
    expect(defaultProcedural('GRADIENT').scale).toBe(1);
    expect(defaultProcedural('CHECKER', { scale: 3 }).scale).toBe(3);
  });
});
