import type { CompiledScene } from './compile';
import { denoiseFilm } from './denoise';
import { PathFilm, createPathTile, type PathTile } from './film';
import {
  BACKGROUND_COLOR,
  BACKGROUND_ENVIRONMENT,
  BACKGROUND_TRANSPARENT,
  PathIntegrator,
  type IntegratorSettings,
} from './integrator';

/** Settings of a `PathTracer` (plain data: post it to workers together with the compiled scene). */
export interface PathTracerSettings {
  width: number;
  height: number;
  /** Samples per pixel rendered by `render()` (default 64). */
  samples: number;
  /** Maximum diffuse/glossy bounces (default 4). */
  maxBounces: number;
  /** Maximum refractions through glass (default max(8, maxBounces)). */
  maxTransmissionBounces: number;
  /** Indirect light clamp (max rgb component per sample, default 10; 0 disables). */
  clampIndirect: number;
  /** Cycles' Filter Glossy: blur glossy lobes after blurry bounces (default 1; 0 disables). */
  filterGlossy: number;
  /** Noise pattern seed (default 0). */
  seed: number;
  /**
   * What camera rays that miss everything show: the world ('ENVIRONMENT'), `backgroundColor`
   * ('COLOR', linear rgba) or nothing ('TRANSPARENT', alpha 0 — film_transparent).
   */
  background: 'ENVIRONMENT' | 'COLOR' | 'TRANSPARENT';
  backgroundColor: [number, number, number, number];
  /** World mist density (1/m, 0 = off) and colour (linear). */
  mistDensity: number;
  mistColor: [number, number, number];
  /** Denoise in `resolve()` by default (default true). */
  denoise: boolean;
  /** Wall-clock budget of `render()` in seconds (0 = none; at least one sample is always rendered). */
  timeLimit: number;
}

/** Progress report of `PathTracer.render`. */
export interface PathTraceProgress {
  /** Samples per pixel finished. */
  samples: number;
  /** Samples per pixel requested. */
  total: number;
  /** Milliseconds since the start of the render. */
  elapsed: number;
}

/** Result of `PathTracer.render`. */
export interface PathTraceStats {
  samples: number;
  elapsed: number;
  /** Why rendering stopped. */
  stopped: 'done' | 'time' | 'cancelled';
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Fills in defaults and sanitizes settings. */
export function pathTracerSettings(
  s: Partial<PathTracerSettings> & { width: number; height: number },
): PathTracerSettings {
  const maxBounces = Math.max(0, Math.min(1024, Math.floor(fin(s.maxBounces, 4))));
  const bg = s.backgroundColor ?? [0, 0, 0, 1];
  const mc = s.mistColor ?? [0, 0, 0];
  return {
    width: Math.max(1, Math.floor(fin(s.width, 1))),
    height: Math.max(1, Math.floor(fin(s.height, 1))),
    samples: Math.max(1, Math.min(1 << 20, Math.floor(fin(s.samples, 64)))),
    maxBounces,
    maxTransmissionBounces: Math.max(
      0,
      Math.min(1024, Math.floor(fin(s.maxTransmissionBounces, Math.max(8, maxBounces)))),
    ),
    clampIndirect: Math.max(0, fin(s.clampIndirect, 10)),
    filterGlossy: Math.max(0, fin(s.filterGlossy, 1)),
    seed: Math.floor(fin(s.seed, 0)) >>> 0,
    background: s.background === 'COLOR' || s.background === 'TRANSPARENT' ? s.background : 'ENVIRONMENT',
    backgroundColor: [
      Math.max(0, fin(bg[0], 0)),
      Math.max(0, fin(bg[1], 0)),
      Math.max(0, fin(bg[2], 0)),
      Math.min(1, Math.max(0, fin(bg[3], 1))),
    ],
    mistDensity: Math.max(0, fin(s.mistDensity, 0)),
    mistColor: [Math.max(0, fin(mc[0], 0)), Math.max(0, fin(mc[1], 0)), Math.max(0, fin(mc[2], 0))],
    denoise: s.denoise !== false,
    timeLimit: Math.max(0, fin(s.timeLimit, 0)),
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Rows per band of a progressive pass: bounds the scratch memory of `render` (tiles are per band). */
const BAND_ROWS = 16;

/**
 * CPU path tracer over a compiled scene.
 *
 * Use `render()` for a progressive render into `film`, or split the work with `renderRows()`
 * (deterministic per pixel and sample index, so any partition gives the same samples) and add the
 * returned tiles with `accumulate()`. For parallel rendering construct one tracer per worker from
 * the same `CompiledScene` and settings (both plain, structured-cloneable data).
 */
export class PathTracer {
  readonly settings: PathTracerSettings;
  readonly film: PathFilm;
  private readonly integrator: PathIntegrator;

  constructor(
    readonly scene: CompiledScene,
    settings: Partial<PathTracerSettings> & { width: number; height: number },
  ) {
    this.settings = pathTracerSettings(settings);
    const s = this.settings;
    const scale = (c: number) => c * s.backgroundColor[3];
    const integratorSettings: IntegratorSettings = {
      maxBounces: s.maxBounces,
      maxTransmissionBounces: s.maxTransmissionBounces,
      maxTransparentLayers: 16,
      clampIndirect: s.clampIndirect,
      filterGlossy: s.filterGlossy,
      seed: s.seed,
      background:
        s.background === 'COLOR'
          ? BACKGROUND_COLOR
          : s.background === 'TRANSPARENT'
            ? BACKGROUND_TRANSPARENT
            : BACKGROUND_ENVIRONMENT,
      bgR: scale(s.backgroundColor[0]),
      bgG: scale(s.backgroundColor[1]),
      bgB: scale(s.backgroundColor[2]),
      bgA: s.backgroundColor[3],
      mistDensity: s.mistDensity,
      mistR: s.mistColor[0],
      mistG: s.mistColor[1],
      mistB: s.mistColor[2],
    };
    this.integrator = new PathIntegrator(scene, integratorSettings);
    this.film = new PathFilm(this.settings.width, this.settings.height);
  }

  /**
   * Renders rows [y0, y1) for sample indices [sampleStart, sampleStart + sampleCount) and returns
   * their per-pixel sums (the film is not touched).
   */
  renderRows(y0: number, y1: number, sampleStart: number, sampleCount: number): PathTile {
    const W = this.settings.width;
    const a = Math.max(0, Math.min(this.settings.height, Math.floor(y0)));
    const b = Math.max(a, Math.min(this.settings.height, Math.floor(y1)));
    const s0 = Math.max(0, Math.floor(sampleStart));
    const n = Math.max(0, Math.floor(sampleCount));
    const tile = createPathTile(a, b, W, s0, n);
    const it = this.integrator;
    const { color, emission, lum2, albedo, normal, depth } = tile;
    for (let y = a; y < b; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y - a) * W + x;
        let r = 0;
        let g = 0;
        let bl = 0;
        let al = 0;
        let er = 0;
        let eg = 0;
        let eb = 0;
        let l2 = 0;
        let ar = 0;
        let ag = 0;
        let ab = 0;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let d = 0;
        for (let s = s0; s < s0 + n; s++) {
          it.trace(x, y, s);
          r += it.r;
          g += it.g;
          bl += it.b;
          al += it.a;
          er += it.er;
          eg += it.eg;
          eb += it.eb;
          const l = 0.2126 * it.r + 0.7152 * it.g + 0.0722 * it.b;
          l2 += l * l;
          ar += it.albR;
          ag += it.albG;
          ab += it.albB;
          nx += it.nrmX;
          ny += it.nrmY;
          nz += it.nrmZ;
          d += it.depth;
        }
        color[i * 4] = r;
        color[i * 4 + 1] = g;
        color[i * 4 + 2] = bl;
        color[i * 4 + 3] = al;
        emission[i * 3] = er;
        emission[i * 3 + 1] = eg;
        emission[i * 3 + 2] = eb;
        lum2[i] = l2;
        albedo[i * 3] = ar;
        albedo[i * 3 + 1] = ag;
        albedo[i * 3 + 2] = ab;
        normal[i * 3] = nx;
        normal[i * 3 + 1] = ny;
        normal[i * 3 + 2] = nz;
        depth[i] = d;
      }
    }
    return tile;
  }

  /** Adds rendered rows (e.g. from a worker) to the film. */
  accumulate(tile: PathTile): void {
    this.film.add(tile);
  }

  /**
   * Progressive render into the film until `samples` per pixel (default `settings.samples`), the
   * time limit or a cancellation (`onProgress` returning false). Passes double in size (1, 2, 4,
   * 8, then 16 samples per pass), every pass covers the whole image (in bands of rows), and the
   * time limit is checked between passes using the last pass's speed.
   */
  render(
    samples = this.settings.samples,
    onProgress?: (p: PathTraceProgress) => boolean | void,
  ): PathTraceStats {
    const total = Math.max(1, Math.floor(samples));
    const H = this.settings.height;
    const limit = this.settings.timeLimit * 1000;
    const t0 = now();
    let done = this.film.samples;
    let pass = 1;
    let stopped: PathTraceStats['stopped'] = 'done';
    let lastPassMs = 0;
    let lastPassSamples = 0;
    while (done < total) {
      const count = Math.min(pass, total - done);
      if (limit > 0 && done > 0 && lastPassSamples > 0) {
        const estimate = (lastPassMs / lastPassSamples) * count;
        if (now() - t0 + estimate > limit) {
          stopped = 'time';
          break;
        }
      }
      const tp = now();
      for (let y = 0; y < H; y += BAND_ROWS) this.film.add(this.renderRows(y, y + BAND_ROWS, done, count));
      lastPassMs = now() - tp;
      lastPassSamples = count;
      done += count;
      pass = Math.min(pass * 2, 16);
      if (onProgress && onProgress({ samples: done, total, elapsed: now() - t0 }) === false) {
        stopped = done < total ? 'cancelled' : 'done';
        break;
      }
      if (limit > 0 && now() - t0 >= limit && done < total) {
        stopped = 'time';
        break;
      }
    }
    return { samples: done, elapsed: now() - t0, stopped };
  }

  /** Mean image: linear premultiplied rgba, denoised when `denoise` (default: settings.denoise). */
  resolve(denoise = this.settings.denoise): Float32Array {
    const img = this.film.resolve();
    return denoise ? denoiseFilm(img) : img.color;
  }

  /** Non-fatal problems found while compiling the scene. */
  get warnings(): readonly string[] {
    return this.scene.warnings;
  }
}
