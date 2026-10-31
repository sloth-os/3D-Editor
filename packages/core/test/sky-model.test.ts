import { describe, expect, it } from 'vitest';
import {
  defaultWorldSettings,
  evalSkyIrradiance,
  prepareSky,
  sampleSky,
  sampleSkyModel,
  sampleSkyPixel,
  skyEquirect,
  skyIrradianceSH,
  skySun,
  sunDirection,
  sunTransmittance,
  type Vec3,
  type WorldSettings,
} from '../src';

const deg = (d: number) => (d * Math.PI) / 180;

function world(patch: Partial<WorldSettings> = {}): WorldSettings {
  return { ...defaultWorldSettings(), environment: 'SKY', ...patch };
}

function dirFrom(elevation: number, azimuth: number): Vec3 {
  // same azimuth convention as sun_rotation (counter-clockwise from −Y)
  return sunDirection({ sun_elevation: elevation, sun_rotation: azimuth });
}

const close3 = (a: readonly number[], b: readonly number[], tol: number) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('sunDirection', () => {
  it('follows the documented convention (azimuth counter-clockwise from −Y)', () => {
    const d0 = sunDirection({ sun_elevation: 0, sun_rotation: 0 });
    expect(d0[0]).toBeCloseTo(0, 12);
    expect(d0[1]).toBeCloseTo(-1, 12);
    expect(d0[2]).toBeCloseTo(0, 12);
    const d90 = sunDirection({ sun_elevation: 0, sun_rotation: Math.PI / 2 });
    expect(d90[0]).toBeCloseTo(1, 12);
    expect(d90[1]).toBeCloseTo(0, 12);
    const d180 = sunDirection({ sun_elevation: 0, sun_rotation: Math.PI });
    expect(d180[1]).toBeCloseTo(1, 12);
    const up = sunDirection({ sun_elevation: Math.PI / 2, sun_rotation: 1 });
    expect(up[2]).toBeCloseTo(1, 12);
    const d = sunDirection({ sun_elevation: deg(30), sun_rotation: deg(70) });
    expect(Math.hypot(...d)).toBeCloseTo(1, 12);
    expect(d[2]).toBeCloseTo(0.5, 12);
  });
});

describe('sampleSky', () => {
  const w = world();

  it('reproduces the zenith, horizon and ground colours for a midday sun', () => {
    const away = w.sun_rotation + Math.PI;
    expect(close3(sampleSky(w, [0, 0, 1]), w.sky_zenith_color, 0.02)).toBe(true);
    expect(close3(sampleSky(w, dirFrom(0, away)), w.sky_horizon_color, 0.02)).toBe(true);
    expect(close3(sampleSky(w, [0, 0, -1]), w.sky_ground_color, 0.01)).toBe(true);
  });

  it('blends monotonically from the horizon to the zenith', () => {
    const away = w.sun_rotation + Math.PI;
    let prev = -Infinity;
    for (let e = 0; e <= 90; e += 5) {
      const c = sampleSky(w, dirFrom(deg(e), away));
      const blueness = c[2] / (c[0] + 1e-9);
      expect(blueness).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = blueness;
    }
  });

  it('is continuous across the horizon', () => {
    // the horizon → zenith blend uses √elevation: continuous with a steep start
    const a = sampleSky(w, dirFrom(1e-10, 1));
    const b = sampleSky(w, dirFrom(-1e-10, 1));
    expect(close3(a, b, 1e-4)).toBe(true);
  });

  it('draws a sun disc that delivers sun_intensity W/m² (× colour × extinction)', () => {
    const sw = world({ sun_size: deg(2), sun_intensity: 5, sun_elevation: deg(60) });
    const s = sunDirection(sw);
    const disc = sampleSky(sw, s);
    const noSun = sampleSky(sw, s, { sun: false });
    expect(disc[0]).toBeGreaterThan(100 * noSun[0]);
    // integrate (L_sun − L_sky) over a cone around the sun in polar coordinates
    const t1: Vec3 = [-s[1], s[0], 0];
    const l1 = Math.hypot(...t1);
    const u: Vec3 = [t1[0] / l1, t1[1] / l1, 0];
    const v: Vec3 = [s[1] * u[2] - s[2] * u[1], s[2] * u[0] - s[0] * u[2], s[0] * u[1] - s[1] * u[0]];
    const R = deg(1);
    const nr = 200;
    const na = 64;
    let e = [0, 0, 0];
    for (let i = 0; i < nr; i++) {
      const g = ((i + 0.5) / nr) * R * 1.02;
      const dOmega = Math.sin(g) * ((R * 1.02) / nr) * ((2 * Math.PI) / na);
      for (let j = 0; j < na; j++) {
        const a = ((j + 0.5) / na) * 2 * Math.PI;
        const d: Vec3 = [0, 1, 2].map(
          (k) => s[k] * Math.cos(g) + (u[k] * Math.cos(a) + v[k] * Math.sin(a)) * Math.sin(g),
        ) as Vec3;
        const L = sampleSky(sw, d);
        const B = sampleSky(sw, d, { sun: false });
        e = e.map((x, k) => x + (L[k] - B[k]) * dOmega);
      }
    }
    const sun = skySun(sw);
    for (let k = 0; k < 3; k++) expect(e[k] / sun.irradiance[k]).toBeCloseTo(1, 2);
    const T = sunTransmittance(Math.sin(deg(60)));
    expect(sun.irradiance[0]).toBeCloseTo(5 * sw.sun_color[0] * T[0], 9);
  });

  it('warms and darkens the sky as the sun sets', () => {
    const at = (el: number) => world({ sun_elevation: deg(el) });
    const towardsSun = (el: number) =>
      sampleSky(at(el), dirFrom(deg(3), at(el).sun_rotation), { sun: false });
    const warmth = (c: Vec3) => c[0] / c[2];
    expect(warmth(towardsSun(1))).toBeGreaterThan(warmth(towardsSun(45)) * 1.5);
    const zen = (el: number) => sampleSky(at(el), [0, 0, 1])[2];
    expect(zen(45)).toBeGreaterThan(zen(2));
    expect(zen(2)).toBeGreaterThan(zen(-10));
    expect(zen(-30)).toBeLessThan(0.05 * zen(45));
    // extinction reddens the sun near the horizon
    const T0 = sunTransmittance(0);
    expect(T0[0]).toBeGreaterThan(T0[1]);
    expect(T0[1]).toBeGreaterThan(T0[2]);
    const T90 = sunTransmittance(1);
    for (let k = 0; k < 3; k++) {
      expect(T90[k]).toBeGreaterThan(T0[k]);
      expect(T90[k]).toBeLessThanOrEqual(1);
    }
  });

  it('hides the sun below the horizon', () => {
    const below = world({ sun_elevation: deg(-5) });
    const sun = skySun(below);
    expect(sun.visible).toBe(false);
    expect(sun.irradiance).toEqual([0, 0, 0]);
    expect(sampleSky(below, sunDirection(below))[0]).toBeLessThan(1);
    // half the disc above the horizon at elevation 0
    const half = skySun(world({ sun_elevation: 0 }));
    const full = prepareSky(world({ sun_elevation: 0 }));
    expect(half.irradiance[0]).toBeCloseTo(full.sunIrradiance[0] * 0.5, 9);
  });

  it('is robust to invalid data and validates its cache by content', () => {
    const bad = {
      ...world(),
      sun_elevation: NaN,
      sun_rotation: Infinity,
      sun_intensity: -4,
      sun_size: NaN,
      sky_zenith_color: [NaN, 0.2, 0.3],
      sun_color: 7,
    } as unknown as WorldSettings;
    for (const d of [
      [0, 0, 1],
      [1, 0, 0],
      [0, 0, -1],
      [0, 0, 0],
      [NaN, 1, 0],
    ] as Vec3[])
      for (const v of sampleSky(bad, d)) expect(Number.isFinite(v)).toBe(true);
    const w1 = world();
    const a = sampleSky(w1, [0, 0, 1]);
    w1.sky_zenith_color = [1, 0, 0];
    expect(sampleSky(w1, [0, 0, 1])).not.toEqual(a);
    // unnormalised directions are normalised
    expect(sampleSky(w1, [0, 0, 7])).toEqual(sampleSky(w1, [0, 0, 1]));
  });

  it('anti-aliases the sun for image pixels without losing its energy', () => {
    const m = prepareSky(world({ sun_elevation: deg(40) }));
    const out = [0, 0, 0];
    const s = m.sun;
    // pixel much larger than the disc: radiance spread over the pixel ≈ E / (π ρ²)
    const rho = deg(2);
    sampleSkyPixel(m, s[0], s[1], s[2], rho, out);
    const bg = [0, 0, 0];
    sampleSkyModel(m, s[0], s[1], s[2], false, bg);
    const mean = (1 - 0.6 / 3) * m.sunRadiance[0] * (m.sunRadius / rho) ** 2;
    expect(out[0] - bg[0]).toBeCloseTo(mean, 6);
    // point sampling equals the disc centre radiance
    sampleSkyPixel(m, s[0], s[1], s[2], 0, out);
    expect(out[0] - bg[0]).toBeCloseTo(m.sunRadiance[0], 6);
  });
});

describe('skyEquirect', () => {
  it('has the documented layout (top row zenith, centre column +X, u = ¼ → +Y)', () => {
    const w = world({ sun_intensity: 0 });
    const W = 64;
    const H = 32;
    const img = skyEquirect(w, W, H);
    expect(img).toHaveLength(W * H * 3);
    expect(img.every(Number.isFinite)).toBe(true);
    const px = (x: number, y: number) => [
      img[(y * W + x) * 3],
      img[(y * W + x) * 3 + 1],
      img[(y * W + x) * 3 + 2],
    ];
    const near = (x: number, y: number) => {
      const el = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
      const phi = Math.PI - (2 * Math.PI * (x + 0.5)) / W;
      return sampleSky(w, [Math.cos(el) * Math.cos(phi), Math.cos(el) * Math.sin(phi), Math.sin(el)], {
        sun: false,
      });
    };
    for (const [x, y] of [
      [32, 15],
      [16, 10],
      [48, 20],
      [5, 0],
      [60, 31],
    ])
      expect(close3(px(x, y), near(x, y), 1e-5)).toBe(true);
    expect(close3(px(10, 0), w.sky_zenith_color, 0.05)).toBe(true);
    expect(close3(px(10, H - 1), w.sky_ground_color, 0.02)).toBe(true);
    // column W/2 looks along +X, W/4 along +Y
    const phiCentre = Math.PI - (2 * Math.PI * (W / 2)) / W;
    const phiQuarter = Math.PI - (2 * Math.PI * (W / 4)) / W;
    expect(phiCentre).toBeCloseTo(0, 12);
    expect(phiQuarter).toBeCloseTo(Math.PI / 2, 12);
  });

  it('keeps the sun irradiance exact when the disc is smaller than a texel', () => {
    for (const [W, H] of [
      [64, 32],
      [256, 128],
    ]) {
      const w = world({ sun_elevation: deg(30), sun_intensity: 4 });
      const withSun = skyEquirect(w, W, H);
      const noSun = skyEquirect(w, W, H, { sun: false });
      const e = [0, 0, 0];
      for (let y = 0; y < H; y++) {
        const top = Math.PI / 2 - (y / H) * Math.PI;
        const bottom = Math.PI / 2 - ((y + 1) / H) * Math.PI;
        const omega = ((2 * Math.PI) / W) * (Math.sin(top) - Math.sin(bottom));
        for (let x = 0; x < W; x++)
          for (let k = 0; k < 3; k++)
            e[k] += (withSun[(y * W + x) * 3 + k] - noSun[(y * W + x) * 3 + k]) * omega;
      }
      const sun = skySun(w);
      for (let k = 0; k < 3; k++) expect(e[k] / sun.irradiance[k]).toBeCloseTo(1, 4);
    }
  });

  it('handles degenerate sizes', () => {
    expect(skyEquirect(world(), 0, -3)).toHaveLength(3);
    expect(skyEquirect(world(), NaN, 2)).toHaveLength(6);
  });
});

describe('sky irradiance (spherical harmonics)', () => {
  it('is exact for a uniform sky', () => {
    const c: Vec3 = [0.3, 0.5, 0.7];
    const w = world({
      sky_zenith_color: c,
      sky_horizon_color: c,
      sky_ground_color: c,
      sun_intensity: 0,
      sun_elevation: deg(60),
    });
    const sh = skyIrradianceSH(w);
    const out = [0, 0, 0];
    for (const n of [
      [0, 0, 1],
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ] as Vec3[]) {
      evalSkyIrradiance(sh, n[0], n[1], n[2], out);
      expect(close3(out, c, 0.005)).toBe(true);
    }
  });

  it('lights up-facing surfaces more than down-facing ones and fades at night', () => {
    const day = skyIrradianceSH(world());
    const up = [0, 0, 0];
    const down = [0, 0, 0];
    evalSkyIrradiance(day, 0, 0, 1, up);
    evalSkyIrradiance(day, 0, 0, -1, down);
    expect(up[2]).toBeGreaterThan(down[2]);
    const night = skyIrradianceSH(world({ sun_elevation: deg(-30) }));
    const n = [0, 0, 0];
    evalSkyIrradiance(night, 0, 0, 1, n);
    expect(n[2]).toBeLessThan(0.05 * up[2]);
    for (const v of [...up, ...down, ...n]) expect(v).toBeGreaterThanOrEqual(0);
  });
});
