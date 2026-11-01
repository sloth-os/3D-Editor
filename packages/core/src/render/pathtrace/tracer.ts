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
  /**
   * Maximum bounces of any kind (diffuse, glossy and transmission) on a path, like Blender's Total
   * max bounces (default 4; 0 = direct light only). Alpha-transparent surfaces do not count.
   */
  maxBounces: number;
  /** Maximum refractions through glass within `maxBounces` (default: no extra limit). */
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
  /**
   * Wall-clock budget of `render()` in seconds (0 = none). The first sample of every pixel is
   * always rendered; after that passes shrink to what still fits, and a pass that overruns its
   * estimate stops between bands of rows.
   */
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
      Math.min(1024, Math.floor(fin(s.maxTransmissionBounces, maxBounces))),
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
   * time limit or a cancellation (`onProgress` returning false, asked after every pass). Passes
   * double in size (1, 2, 4, 8, then 16 samples per pass) and every pass covers the whole image in
   * bands of rows, each band continuing from its own sample count (so a film with unevenly
   * sampled rows is evened out first).
   *
   * Time limit: the first pass (one sample per pixel) always completes. Every later pass renders
   * at most as many samples as the measured speed says still fit, and stops between bands once
   * the limit is reached (the bands done keep their extra samples). `samples` of the result is the
   * smallest number of samples of any pixel.
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
    /** Measured wall time of one sample per pixel over the whole image (0 = unknown). */
    let msPerSample = 0;
    while (done < total) {
      let count = Math.min(pass, total - done);
      const timed = limit > 0 && done > 0;
      if (timed && msPerSample > 0) {
        const fit = Math.floor((limit - (now() - t0)) / msPerSample);
        if (fit < 1) {
          stopped = 'time';
          break;
        }
        if (fit < count) count = fit;
      }
      const target = done + count;
      const tp = now();
      let rendered = 0;
      let complete = true;
      for (let y = 0; y < H; y += BAND_ROWS) {
        if (timed && y > 0 && now() - t0 >= limit) {
          complete = false;
          break;
        }
        rendered += this.renderBand(y, Math.min(H, y + BAND_ROWS), target);
      }
      if (!complete) {
        stopped = 'time';
        break;
      }
      // speed of this pass in samples per pixel over the whole image
      if (rendered > 0) msPerSample = ((now() - tp) * H) / rendered;
      done = target;
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
    return { samples: this.film.samples, elapsed: now() - t0, stopped };
  }

  /**
   * Brings rows [y0, y1) of the film up to `target` samples (runs of rows with equal counts share
   * a tile) and returns the number of row-samples rendered.
   */
  private renderBand(y0: number, y1: number, target: number): number {
    const counts = this.film.rowSamples;
    let rendered = 0;
    let y = y0;
    while (y < y1) {
      const start = counts[y];
      let end = y + 1;
      while (end < y1 && counts[end] === start) end++;
      if (start < target) {
        this.film.add(this.renderRows(y, end, start, target - start));
        rendered += (end - y) * (target - start);
      }
      y = end;
    }
    return rendered;
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
