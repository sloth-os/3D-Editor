/*
 * Sparse symmetric positive definite solver (LDLᵀ) for mesh Laplacian-like systems.
 *
 * Fill-reducing ordering: geometric nested dissection. Vertices are split recursively at the
 * median of the longest bounding-box axis; the vertices of one half that touch the other half
 * form the separator, which is ordered after both halves. For surface meshes the separators are
 * small (rings), so the factor stays sparse.
 *
 * Factorisation: elimination tree + row-by-row ("up-looking") LDLᵀ, with L stored by columns.
 * Once factorised, every right-hand side costs two sparse triangular solves, which makes many
 * solves with the same matrix (one per bone) cheap.
 */

/** Symmetric matrix given as off-diagonal adjacency (CSR, both triangles) plus a diagonal. */
export interface SymmetricMatrix {
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
  diag: Float64Array;
}

/** Nested dissection order (`order[k]` = original index eliminated k-th). */
export function nestedDissectionOrder(
  m: Pick<SymmetricMatrix, 'rowStart' | 'cols'>,
  positions: ArrayLike<number>,
  n: number,
): Int32Array {
  const order = new Int32Array(n);
  let next = n; // separators are filled from the back, leaves from the front
  let front = 0;
  const side = new Int8Array(n).fill(-1);
  // vertex subsets still to split; separators are collected top-down and placed last
  const stack: Int32Array[] = [Int32Array.from({ length: n }, (_, i) => i)];
  const seps: Int32Array[] = [];
  while (stack.length) {
    const verts = stack.pop()!;
    if (verts.length <= 48) {
      for (const v of verts) order[front++] = v;
      continue;
    }
    let lo0 = Infinity;
    let lo1 = Infinity;
    let lo2 = Infinity;
    let hi0 = -Infinity;
    let hi1 = -Infinity;
    let hi2 = -Infinity;
    for (const v of verts) {
      const x = positions[v * 3];
      const y = positions[v * 3 + 1];
      const z = positions[v * 3 + 2];
      if (x < lo0) lo0 = x;
      if (x > hi0) hi0 = x;
      if (y < lo1) lo1 = y;
      if (y > hi1) hi1 = y;
      if (z < lo2) lo2 = z;
      if (z > hi2) hi2 = z;
    }
    const ex = hi0 - lo0;
    const ey = hi1 - lo1;
    const ez = hi2 - lo2;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const sorted = Array.from(verts).sort(
      (a, b) => positions[a * 3 + axis] - positions[b * 3 + axis] || a - b,
    );
    const half = sorted.length >> 1;
    for (let i = 0; i < sorted.length; i++) side[sorted[i]] = i < half ? 0 : 1;
    const left: number[] = [];
    const sep: number[] = [];
    for (let i = 0; i < half; i++) {
      const v = sorted[i];
      let touches = false;
      for (let k = m.rowStart[v]; k < m.rowStart[v + 1]; k++)
        if (side[m.cols[k]] === 1) {
          touches = true;
          break;
        }
      (touches ? sep : left).push(v);
    }
    const right = sorted.slice(half);
    for (const v of verts) side[v] = -1;
    if (!left.length || !right.length || sep.length >= verts.length - 1) {
      // degenerate split (e.g. a dense clique): stop dissecting
      for (const v of verts) order[front++] = v;
      continue;
    }
    seps.push(Int32Array.from(sep));
    // separators are eliminated after everything below them: reserve their slots at the back
    stack.push(Int32Array.from(right), Int32Array.from(left));
  }
  // emit separators: the first (top-level) separator goes last
  for (const s of seps) {
    next -= s.length;
    order.set(s, next);
  }
  // front-filled leaves and back-filled separators meet exactly
  if (front !== next) {
    // should not happen; fall back to the identity order
    for (let i = 0; i < n; i++) order[i] = i;
  }
  return order;
}

/** LDLᵀ factor of a permuted symmetric positive definite matrix. */
export class SparseLDL {
  private constructor(
    private readonly n: number,
    private readonly perm: Int32Array,
    private readonly Lp: Int32Array,
    private readonly Li: Int32Array,
    private readonly Lx: Float64Array,
    private readonly D: Float64Array,
  ) {}

  /** Number of stored off-diagonal entries of L. */
  get nonzeros(): number {
    return this.Lp[this.n];
  }

  /**
   * Factorises `m` (symmetric positive definite). Returns null when the factor would exceed
   * `maxNonzeros` entries or the matrix is not numerically positive definite.
   */
  static factor(m: SymmetricMatrix, perm: Int32Array, maxNonzeros = 2e7): SparseLDL | null {
    const n = m.diag.length;
    const iperm = new Int32Array(n);
    for (let k = 0; k < n; k++) iperm[perm[k]] = k;
    // upper triangle of the permuted matrix, by columns: entries (i, k) with i < k
    const cp = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) {
      const v = perm[k];
      let c = 0;
      for (let p = m.rowStart[v]; p < m.rowStart[v + 1]; p++) if (iperm[m.cols[p]] < k) c++;
      cp[k + 1] = cp[k] + c;
    }
    const ci = new Int32Array(cp[n]);
    const cx = new Float64Array(cp[n]);
    for (let k = 0; k < n; k++) {
      const v = perm[k];
      let o = cp[k];
      for (let p = m.rowStart[v]; p < m.rowStart[v + 1]; p++) {
        const i = iperm[m.cols[p]];
        if (i < k) {
          ci[o] = i;
          cx[o++] = m.vals[p];
        }
      }
    }
    // symbolic: elimination tree and column counts
    const parent = new Int32Array(n);
    const flag = new Int32Array(n);
    const Lnz = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      parent[k] = -1;
      flag[k] = k;
      for (let p = cp[k]; p < cp[k + 1]; p++) {
        let i = ci[p];
        while (flag[i] !== k) {
          if (parent[i] === -1) parent[i] = k;
          Lnz[i]++;
          flag[i] = k;
          i = parent[i];
        }
      }
    }
    const Lp = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) Lp[k + 1] = Lp[k] + Lnz[k];
    if (Lp[n] > maxNonzeros) return null;
    // numeric: compute L row by row
    const Li = new Int32Array(Lp[n]);
    const Lx = new Float64Array(Lp[n]);
    const D = new Float64Array(n);
    const Y = new Float64Array(n);
    const pattern = new Int32Array(n);
    Lnz.fill(0);
    for (let k = 0; k < n; k++) {
      Y[k] = 0;
      let top = n;
      flag[k] = k;
      for (let p = cp[k]; p < cp[k + 1]; p++) {
        let i = ci[p];
        Y[i] += cx[p];
        let len = 0;
        while (flag[i] !== k) {
          pattern[len++] = i;
          flag[i] = k;
          i = parent[i];
        }
        while (len > 0) pattern[--top] = pattern[--len];
      }
      let d = m.diag[perm[k]];
      for (; top < n; top++) {
        const i = pattern[top];
        const yi = Y[i];
        Y[i] = 0;
        const end = Lp[i] + Lnz[i];
        for (let p = Lp[i]; p < end; p++) Y[Li[p]] -= Lx[p] * yi;
        const l = yi / D[i];
        d -= l * yi;
        Li[end] = k;
        Lx[end] = l;
        Lnz[i]++;
      }
      if (!(d > 0) || !Number.isFinite(d)) return null;
      D[k] = d;
    }
    return new SparseLDL(n, perm, Lp, Li, Lx, D);
  }

  /** Solves M·x = b (b in original ordering); returns x in original ordering. */
  solve(b: ArrayLike<number>): Float64Array {
    const { n, perm, Lp, Li, Lx, D } = this;
    const y = new Float64Array(n);
    for (let k = 0; k < n; k++) y[k] = b[perm[k]];
    for (let j = 0; j < n; j++) {
      const yj = y[j];
      if (yj === 0) continue;
      for (let p = Lp[j]; p < Lp[j + 1]; p++) y[Li[p]] -= Lx[p] * yj;
    }
    for (let j = 0; j < n; j++) y[j] /= D[j];
    for (let j = n - 1; j >= 0; j--) {
      let s = y[j];
      for (let p = Lp[j]; p < Lp[j + 1]; p++) s -= Lx[p] * y[Li[p]];
      y[j] = s;
    }
    const x = new Float64Array(n);
    for (let k = 0; k < n; k++) x[perm[k]] = y[k];
    return x;
  }
}
