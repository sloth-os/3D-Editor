/*
 * Sample accumulation. `PathTile` holds per-pixel sums of a band of rows for a range of sample
 * indices (what `PathTracer.renderRows` returns, e.g. from a worker); `Film` adds tiles up and
 * resolves means. Only plain typed arrays, so tiles can be transferred between threads.
 */

/** Per-pixel sums of rows [y0, y1) for samples [sampleStart, sampleStart + sampleCount). */
export interface PathTile {
  y0: number;
  y1: number;
  width: number;
  sampleStart: number;
  sampleCount: number;
  /** Premultiplied radiance and coverage (rgba). */
  color: Float32Array;
  /** Radiance seen directly by the camera: emission and background (rgb). */
  emission: Float32Array;
  /** Squared luminance of the samples (variance estimation for the denoiser). */
  lum2: Float32Array;
  /** Denoising guides: albedo (rgb), world normal (xyz), distance to the first surface. */
  albedo: Float32Array;
  normal: Float32Array;
  depth: Float32Array;
}

/** Allocates an empty tile. */
export function createPathTile(
  y0: number,
  y1: number,
  width: number,
  sampleStart: number,
  sampleCount: number,
): PathTile {
  const n = Math.max(0, y1 - y0) * width;
  return {
    y0,
    y1,
    width,
    sampleStart,
    sampleCount,
    color: new Float32Array(n * 4),
    emission: new Float32Array(n * 3),
    lum2: new Float32Array(n),
    albedo: new Float32Array(n * 3),
    normal: new Float32Array(n * 3),
    depth: new Float32Array(n),
  };
}

/** The typed-array buffers of a tile (for `postMessage` transfer lists). */
export function pathTileTransferables(t: PathTile): ArrayBuffer[] {
  return [t.color, t.emission, t.lum2, t.albedo, t.normal, t.depth].map((a) => a.buffer as ArrayBuffer);
}

/** Mean values of a film (see `Film.resolve`). */
export interface FilmImage {
  width: number;
  height: number;
  /** Mean premultiplied linear radiance and coverage (rgba). */
  color: Float32Array;
  emission: Float32Array;
  /** Variance of the mean luminance per pixel. */
  variance: Float32Array;
  albedo: Float32Array;
  /** Unit normals (zero where no surface was hit). */
  normal: Float32Array;
  depth: Float32Array;
}

export class PathFilm {
  readonly color: Float32Array;
  readonly emission: Float32Array;
  readonly lum2: Float32Array;
  readonly albedo: Float32Array;
  readonly normal: Float32Array;
  readonly depth: Float32Array;
  /** Samples accumulated per row. */
  readonly rowSamples: Int32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const n = width * height;
    this.color = new Float32Array(n * 4);
    this.emission = new Float32Array(n * 3);
    this.lum2 = new Float32Array(n);
    this.albedo = new Float32Array(n * 3);
    this.normal = new Float32Array(n * 3);
    this.depth = new Float32Array(n);
    this.rowSamples = new Int32Array(height);
  }

  /** Smallest number of samples of any row. */
  get samples(): number {
    let m = Infinity;
    for (let y = 0; y < this.height; y++) m = Math.min(m, this.rowSamples[y]);
    return this.height ? m : 0;
  }

  clear(): void {
    this.color.fill(0);
    this.emission.fill(0);
    this.lum2.fill(0);
    this.albedo.fill(0);
    this.normal.fill(0);
    this.depth.fill(0);
    this.rowSamples.fill(0);
  }

  /** Adds a tile's sums. */
  add(t: PathTile): void {
    if (t.width !== this.width) throw new Error('Tile width does not match the film');
    const y0 = Math.max(0, t.y0);
    const y1 = Math.min(this.height, t.y1);
    for (let y = y0; y < y1; y++) {
      const src = (y - t.y0) * this.width;
      const dst = y * this.width;
      addRange(this.color, t.color, dst * 4, src * 4, this.width * 4);
      addRange(this.emission, t.emission, dst * 3, src * 3, this.width * 3);
      addRange(this.lum2, t.lum2, dst, src, this.width);
      addRange(this.albedo, t.albedo, dst * 3, src * 3, this.width * 3);
      addRange(this.normal, t.normal, dst * 3, src * 3, this.width * 3);
      addRange(this.depth, t.depth, dst, src, this.width);
      this.rowSamples[y] += t.sampleCount;
    }
  }

  /** Mean values per pixel (rows without samples are zero). */
  resolve(): FilmImage {
    const w = this.width;
    const h = this.height;
    const n = w * h;
    const color = new Float32Array(n * 4);
    const emission = new Float32Array(n * 3);
    const variance = new Float32Array(n);
    const albedo = new Float32Array(n * 3);
    const normal = new Float32Array(n * 3);
    const depth = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const N = this.rowSamples[y];
      if (!N) continue;
      const inv = 1 / N;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        for (let k = 0; k < 4; k++) color[i * 4 + k] = this.color[i * 4 + k] * inv;
        for (let k = 0; k < 3; k++) {
          emission[i * 3 + k] = this.emission[i * 3 + k] * inv;
          albedo[i * 3 + k] = this.albedo[i * 3 + k] * inv;
        }
        const nx = this.normal[i * 3];
        const ny = this.normal[i * 3 + 1];
        const nz = this.normal[i * 3 + 2];
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 1e-6) {
          normal[i * 3] = nx / nl;
          normal[i * 3 + 1] = ny / nl;
          normal[i * 3 + 2] = nz / nl;
        }
        depth[i] = this.depth[i] * inv;
        const r = color[i * 4];
        const g = color[i * 4 + 1];
        const b = color[i * 4 + 2];
        const mean = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const v = Math.max(0, this.lum2[i] * inv - mean * mean);
        variance[i] = N > 1 ? v / (N - 1) : v;
      }
    }
    return { width: w, height: h, color, emission, variance, albedo, normal, depth };
  }
}

function addRange(dst: Float32Array, src: Float32Array, d: number, s: number, n: number): void {
  for (let i = 0; i < n; i++) dst[d + i] += src[s + i];
}
