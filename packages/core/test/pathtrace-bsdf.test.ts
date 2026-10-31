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

  it('transmits (1 − F)/η² of the radiance into glass and η² more when leaving it', () => {
    const into = sampledAlbedo(setup({ transmission: 1, roughness: 0.2 }, 1, true), 64);
    const F = fresnelDielectric(1, 1.5);
    expect(into).toBeCloseTo(F + (1 - F) / 2.25, 1);
    const out = sampledAlbedo(setup({ transmission: 1, roughness: 0.2 }, 1, false), 64);
    expect(out).toBeCloseTo(F + (1 - F) * 2.25, 1);
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
