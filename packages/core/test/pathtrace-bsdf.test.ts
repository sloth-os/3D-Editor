import { describe, expect, it } from 'vitest';
import { PrincipledBSDF, fresnelDielectric, type BSDFInputs } from '../src/render/pathtrace';
import { rng } from './pathtrace-helpers';

const WHITE: BSDFInputs = {
  baseR: 1,
  baseG: 1,
  baseB: 1,
  metallic: 0,
  roughness: 0.5,
  ior: 1.5,
  transmission: 0,
  coat: 0,
  coatRoughness: 0.03,
  sheen: 0,
  sheenR: 1,
  sheenG: 1,
  sheenB: 1,
};

function setup(p: Partial<BSDFInputs>, mu: number, entering = true): PrincipledBSDF {
  const b = new PrincipledBSDF();
  b.setup({ ...WHITE, ...p }, Math.sqrt(1 - mu * mu), 0, mu, entering);
  return b;
}

/** ∫ f·|cos| dω estimated by sampling the BSDF (stratified). */
function sampledAlbedo(b: PrincipledBSDF, n = 48): number {
  let s = 0;
  const r = rng(5);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < 4; k++)
        if (b.sample((i + r()) / n, (j + r()) / n, (k + r()) / 4)) s += b.fR / b.pdf;
  return s / (n * n * 4);
}

/** ∫ g(ω) dω over the sphere by midpoint quadrature in (cos θ, φ). */
function quadrature(b: PrincipledBSDF, g: (b: PrincipledBSDF) => number, m = 300): number {
  let s = 0;
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++) {
      const z = 1 - (2 * (i + 0.5)) / m;
      const r = Math.sqrt(1 - z * z);
      const ph = (2 * Math.PI * (j + 0.5)) / m;
      b.eval(r * Math.cos(ph), r * Math.sin(ph), z);
      s += g(b);
    }
  return (s * 4 * Math.PI) / (m * m);
}

describe('Fresnel', () => {
  it('matches the dielectric reflectance at normal incidence, grazing and total internal reflection', () => {
    expect(fresnelDielectric(1, 1.5)).toBeCloseTo(0.04, 6);
    expect(fresnelDielectric(1, 1 / 1.5)).toBeCloseTo(0.04, 6);
    expect(fresnelDielectric(1e-6, 1.5)).toBeCloseTo(1, 3);
    expect(fresnelDielectric(0.5, 1)).toBeCloseTo(0, 9);
    // beyond the critical angle (41.8° inside glass) everything reflects
    expect(fresnelDielectric(Math.cos((50 * Math.PI) / 180), 1 / 1.5)).toBe(1);
    expect(fresnelDielectric(Math.cos((30 * Math.PI) / 180), 1 / 1.5)).toBeLessThan(0.1);
  });
});

describe('principled BSDF', () => {
  it('conserves energy for lossless white materials (white furnace per lobe)', () => {
    const cases: [string, Partial<BSDFInputs>][] = [
      ['diffuse + specular', {}],
      ['rough diffuse + specular', { roughness: 1 }],
      ['near-mirror dielectric', { roughness: 0.05 }],
      ['metal', { metallic: 1, roughness: 0.3 }],
      ['rough metal', { metallic: 1, roughness: 1 }],
      ['coat', { coat: 1, coatRoughness: 0.1 }],
      ['sheen', { sheen: 1 }],
    ];
    for (const [name, p] of cases)
      for (const mu of [1, 0.6, 0.3]) {
        const a = sampledAlbedo(setup(p, mu));
        expect(a, `${name} at μ=${mu}`).toBeGreaterThan(0.95);
        expect(a, `${name} at μ=${mu}`).toBeLessThan(1.03);
      }
  });

  it('transmits (1 − F) of the radiance into and out of glass, without η² scaling (like Cycles)', () => {
    // regression: refraction scaled radiance by 1/η² into glass and η² out of it, so a single glass
    // sheet darkened (or, seen from its back, brightened ×2.25) what was behind it, and lamps inside
    // glass bodies did not match their thin-walled shadows
    const F = fresnelDielectric(1, 1.5);
    for (const entering of [true, false]) {
      const b = setup({ transmission: 1, roughness: 0.2 }, 1, entering);
      expect(sampledAlbedo(b, 64)).toBeCloseTo(1, 1);
      let t = 0;
      const n = 64;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          for (let k = 0; k < 4; k++)
            if (b.sample((i + 0.5) / n, (j + 0.5) / n, (k + 0.5) / 4) && b.sampledTransmission)
              t += b.fR / b.pdf;
      expect(t / (n * n * 4)).toBeCloseTo(1 - F, 1);
    }
  });

  it('passes light straight through index-matched glass (IOR 1) at any roughness', () => {
    for (const roughness of [0, 0.3, 1])
      for (const entering of [true, false]) {
        const b = setup({ transmission: 1, ior: 1, roughness, baseG: 0.5 }, 0.6, entering);
        expect(b.singular).toBe(true);
        expect(b.sample(0.3, 0.7, 0.5)).toBe(true);
        expect(b.sampledDelta && b.sampledTransmission).toBe(true);
        [-0.8, 0, -0.6].forEach((v, i) => expect([b.wx, b.wy, b.wz][i]).toBeCloseTo(v, 12));
        // weight: the tint (no Fresnel reflection at IOR 1, no η² scaling)
        expect(b.fR / b.pdf).toBeCloseTo(1, 12);
        expect(b.fG / b.pdf).toBeCloseTo(0.5, 12);
        // a delta lobe is never hit by an evaluated direction
        b.eval(-0.8, 0, -0.6);
        expect(b.fR + b.fG + b.fB + b.pdf).toBe(0);
      }
    // mixed with a diffuse base: light sampling still applies; the delta is picked by its probability
    const half = setup({ transmission: 0.5, ior: 1, roughness: 0.5 }, 1);
    expect(half.singular).toBe(false);
    let delta = 0;
    let sum = 0;
    for (let i = 0; i < 400; i++) {
      if (!half.sample((i * 0.618) % 1, (i * 0.414) % 1, (i + 0.5) / 400)) continue;
      if (half.sampledDelta) {
        delta++;
        sum += half.fR / half.pdf;
      }
    }
    expect(delta).toBeGreaterThan(0);
    expect(sum / 400).toBeCloseTo(0.5, 6); // transmitted share: (1 − metallic) × transmission
  });

  it('compensates the single-scattering energy loss of rough glass (energy albedo ≈ 1)', () => {
    // energy = reflected + transmitted
    const energy = (b: PrincipledBSDF, n = 48) => {
      let s = 0;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          for (let k = 0; k < 4; k++)
            if (b.sample((i + 0.5) / n, (j + 0.5) / n, (k + 0.5) / 4)) s += b.fR / b.pdf;
      return s / (n * n * 4);
    };
    for (const roughness of [0.5, 0.7, 1])
      for (const mu of [1, 0.6, 0.3])
        for (const entering of [true, false]) {
          const b = setup({ transmission: 1, ior: 1.5, roughness }, mu, entering);
          const e = energy(b);
          const what = `roughness ${roughness}, μ ${mu}, ${entering ? 'entering' : 'leaving'}`;
          expect(e, what).toBeGreaterThan(0.95);
          expect(e, what).toBeLessThan(1.04);
        }
  });

  it('samples directions with the pdf it reports (importance sampling equals quadrature)', () => {
    const cases: Partial<BSDFInputs>[] = [
      { roughness: 0.6 },
      { metallic: 1, roughness: 0.5, baseR: 0.9, baseG: 0.6, baseB: 0.2 },
      { transmission: 1, roughness: 0.6 },
      { sheen: 0.7, roughness: 0.8 },
      { coat: 0.6, coatRoughness: 0.5, roughness: 0.7 },
    ];
    for (const p of cases)
      for (const mu of [0.8, 0.45]) {
        const b = setup(p, mu);
        const q = quadrature(b, (x) => x.fR);
        const s = sampledAlbedo(b, 64);
        expect(Math.abs(q - s), JSON.stringify({ p, mu, q, s })).toBeLessThan(0.02 * Math.max(1, q));
        // the combined pdf integrates to (at most) one
        const pdfInt = quadrature(b, (x) => x.pdf);
        expect(pdfInt).toBeGreaterThan(0.9);
        expect(pdfInt).toBeLessThan(1.02);
      }
  });

  it('never returns negative, non-finite or energy-creating values for random parameters', () => {
    const r = rng(77);
    for (let k = 0; k < 60; k++) {
      const p: Partial<BSDFInputs> = {
        baseR: r(),
        baseG: r(),
        baseB: r(),
        metallic: r() < 0.3 ? 1 : r(),
        roughness: r(),
        ior: 1 + r() * 1.5,
        transmission: r() < 0.3 ? 1 : r() * r(),
        coat: r() * r(),
        coatRoughness: r(),
        sheen: r() * r(),
      };
      const mu = 0.05 + 0.95 * r();
      const entering = r() < 0.7;
      const b = setup(p, mu, entering);
      for (let i = 0; i < 50; i++) {
        const z = 1 - 2 * r();
        const s = Math.sqrt(1 - z * z);
        const ph = 2 * Math.PI * r();
        b.eval(s * Math.cos(ph), s * Math.sin(ph), z);
        for (const v of [b.fR, b.fG, b.fB, b.pdf]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
      // (light leaving a transmissive medium gains η² radiance: no bound there)
      if (entering || p.transmission === 0) expect(sampledAlbedo(b, 24)).toBeLessThan(1.05);
    }
    // invalid inputs are sanitized
    const bad = new PrincipledBSDF();
    bad.setup({ ...WHITE, roughness: NaN, ior: NaN, metallic: Infinity, baseR: -1 }, 0, 0, 1, true);
    bad.eval(0, 0.6, 0.8);
    expect(Number.isFinite(bad.fR + bad.fG + bad.fB + bad.pdf)).toBe(true);
  });

  it('flags smooth mirrors and glass as singular, rough or diffuse surfaces as not', () => {
    expect(setup({ metallic: 1, roughness: 0 }, 0.7).singular).toBe(true);
    expect(setup({ transmission: 1, roughness: 0 }, 0.7).singular).toBe(true);
    expect(setup({ metallic: 1, roughness: 0.4 }, 0.7).singular).toBe(false);
    expect(setup({ roughness: 0 }, 0.7).singular).toBe(false); // the diffuse base remains
    // a perfect mirror reflects into the mirror direction with weight F
    const m = setup({ metallic: 1, roughness: 0, baseR: 0.9, baseG: 0.9, baseB: 0.9 }, 1);
    expect(m.sample(0.3, 0.7, 0.5)).toBe(true);
    expect(m.wz).toBeCloseTo(1, 3);
    expect(m.fR / m.pdf).toBeCloseTo(0.9, 2);
  });

  it('filter glossy (minimum α) widens near-specular lobes and leaves rough ones alone', () => {
    const blurred = (p: Partial<BSDFInputs>, minAlpha: number) => {
      const b = new PrincipledBSDF();
      b.setup({ ...WHITE, ...p }, Math.sqrt(1 - 0.7 * 0.7), 0, 0.7, true, minAlpha);
      return b;
    };
    // smooth glass and mirrors become glossy: light sampling applies again
    expect(blurred({ transmission: 1, roughness: 0 }, 0.4).singular).toBe(false);
    expect(blurred({ metallic: 1, roughness: 0 }, 0.4).singular).toBe(false);
    // the blurred lobe still conserves energy (lossless white metal)
    expect(sampledAlbedo(blurred({ metallic: 1, roughness: 0 }, 0.4))).toBeCloseTo(1, 1);
    // a lobe rougher than the blur is unchanged
    const a = blurred({ metallic: 1, roughness: 0.8 }, 0);
    const b = blurred({ metallic: 1, roughness: 0.8 }, 0.4);
    for (const [x, y, z] of [
      [0.3, 0.1, 0.9],
      [-0.5, 0.2, 0.6],
    ]) {
      a.eval(x, y, z);
      b.eval(x, y, z);
      expect(b.fR).toBe(a.fR);
      expect(b.pdf).toBe(a.pdf);
    }
  });
});
