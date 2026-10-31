/*
 * Piecewise-constant probability distributions (plain typed arrays, worker-transferable).
 */

/** Discrete distribution over `n` weights: `cdf[0] = 0 … cdf[n] = 1`. */
export interface Distribution1D {
  n: number;
  cdf: Float64Array;
  /** Sum of the (non-negative) input weights. */
  total: number;
}

/** Builds a discrete distribution; non-finite or negative weights count as 0. Uniform when all are 0. */
export function buildDistribution1D(weights: ArrayLike<number>, n = weights.length): Distribution1D {
  const cdf = new Float64Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    total += w > 0 && Number.isFinite(w) ? w : 0;
    cdf[i + 1] = total;
  }
  if (total > 0) for (let i = 1; i <= n; i++) cdf[i] /= total;
  else for (let i = 1; i <= n; i++) cdf[i] = i / n;
  if (n > 0) cdf[n] = 1;
  return { n, cdf, total };
}

/** Index i with cdf[i] <= u < cdf[i + 1] (skipping zero-probability entries). */
export function sampleDiscrete(d: Distribution1D, u: number): number {
  const cdf = d.cdf;
  let lo = 0;
  let hi = d.n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] <= u) lo = mid;
    else hi = mid;
  }
  // skip empty buckets (u exactly on a boundary of zero-width entries)
  while (lo < d.n - 1 && cdf[lo + 1] - cdf[lo] <= 0) lo++;
  return lo;
}

/** Probability of entry `i`. */
export function discretePdf(d: Distribution1D, i: number): number {
  return i >= 0 && i < d.n ? d.cdf[i + 1] - d.cdf[i] : 0;
}

/**
 * Piecewise-constant 2D distribution over [0,1)² on a `w × h` grid (row-major, row 0 at v = 0):
 * marginal over rows, conditional over columns. The density of a point in cell (i, j) is
 * `f(i, j) / integral` where `integral = Σ f / (w·h)`.
 */
export interface Distribution2D {
  w: number;
  h: number;
  func: Float32Array;
  /** Per-row CDFs, (w + 1) entries each. */
  conditional: Float64Array;
  marginal: Float64Array;
  integral: number;
}

export function buildDistribution2D(func: Float32Array, w: number, h: number): Distribution2D {
  const conditional = new Float64Array(h * (w + 1));
  const rowSum = new Float64Array(h);
  for (let j = 0; j < h; j++) {
    let s = 0;
    const o = j * (w + 1);
    for (let i = 0; i < w; i++) {
      const f = func[j * w + i];
      s += f > 0 && Number.isFinite(f) ? f : 0;
      conditional[o + i + 1] = s;
    }
    rowSum[j] = s;
    if (s > 0) for (let i = 1; i <= w; i++) conditional[o + i] /= s;
    else for (let i = 1; i <= w; i++) conditional[o + i] = i / w;
  }
  const marginal = new Float64Array(h + 1);
  let total = 0;
  for (let j = 0; j < h; j++) {
    total += rowSum[j];
    marginal[j + 1] = total;
  }
  if (total > 0) for (let j = 1; j <= h; j++) marginal[j] /= total;
  else for (let j = 1; j <= h; j++) marginal[j] = j / h;
  return { w, h, func, conditional, marginal, integral: total / (w * h) };
}

function searchCdf(cdf: Float64Array, offset: number, n: number, u: number): number {
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cdf[offset + mid] <= u) lo = mid;
    else hi = mid;
  }
  while (lo < n - 1 && cdf[offset + lo + 1] - cdf[offset + lo] <= 0) lo++;
  return lo;
}

/** Samples a point in [0,1)²; returns its density (0 if the distribution is empty). */
export function sampleDistribution2D(d: Distribution2D, u0: number, u1: number, out: Float64Array): number {
  if (!(d.integral > 0)) return 0;
  const j = searchCdf(d.marginal, 0, d.h, u1);
  const m0 = d.marginal[j];
  const m1 = d.marginal[j + 1];
  const fv = m1 > m0 ? (u1 - m0) / (m1 - m0) : 0.5;
  const o = j * (d.w + 1);
  const i = searchCdf(d.conditional, o, d.w, u0);
  const c0 = d.conditional[o + i];
  const c1 = d.conditional[o + i + 1];
  const fu = c1 > c0 ? (u0 - c0) / (c1 - c0) : 0.5;
  out[0] = (i + Math.min(0.999999, Math.max(0, fu))) / d.w;
  out[1] = (j + Math.min(0.999999, Math.max(0, fv))) / d.h;
  return d.func[j * d.w + i] / d.integral;
}

/** Density of a point in [0,1)². */
export function distribution2DPdf(d: Distribution2D, u: number, v: number): number {
  if (!(d.integral > 0)) return 0;
  const i = Math.min(d.w - 1, Math.max(0, Math.floor(u * d.w)));
  const j = Math.min(d.h - 1, Math.max(0, Math.floor(v * d.h)));
  return d.func[j * d.w + i] / d.integral;
}
