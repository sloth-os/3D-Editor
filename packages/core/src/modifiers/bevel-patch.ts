import type { MeshBuilder } from './util';

/*
 * Quad-grid vertex patches for the BEVEL modifier (Blender's "ADJ" vertex mesh).
 *
 * Where three or more beveled edges meet, the hole between their profiles is an n-sided patch whose
 * sides are the n profiles (S segments each, sharing their end points). Like Blender, it is filled
 * with n sectors of quads around a center: for even S every sector is an (S/2) × (S/2) grid around
 * one center vertex; for odd S every sector is (S−1)/2 × (S+1)/2 quads around a center n-gon. A
 * cube corner with two segments gets three quads, with three segments six quads and a triangle.
 *
 * The interior comes from Catmull–Clark subdivision of a coarse control mesh (the profiles' ends and
 * middles plus one center point) until a side has at least S segments, then resampling to S. The
 * boundary always stays on the true profiles; for the interior rules every profile point (except the
 * corners) is moved off the curve by a sixth of its second difference, so the subdivided surface
 * follows curved profiles instead of sagging between them (Levin's combined subdivision). The control
 * center is placed so that the patch center lands where a superellipsoid corner with the profile's
 * shape has it: on the sphere for round profiles at a cube corner. When all profiles lie on one
 * sphere (round profiles at a cube-like corner) the interior is projected onto it, so such corners
 * are exact sphere patches, like Blender's cube-corner special case.
 */

/** One side of an n-sided patch, in the patch's winding order. */
export interface PatchSide {
  /** S + 1 vertex indices along the profile (shared with the neighbouring strip or face). */
  ids: number[];
  /** Profile from `a` (t = 0, at ids[0]) to `b` (t = 1, at ids[S]) bulging toward the control point `c`. */
  a: number[];
  b: number[];
  c: number[];
  /** The caller's tag for the side (the beveled edge or the face it lies in). */
  tag?: number;
}

export interface GridPatchContext {
  b: MeshBuilder;
  /** Vertex colour source (the original vertex's colour is copied to new vertices). */
  colors: ArrayLike<number> | null;
  colorIndex: number;
  /** Point of a side's profile at t ∈ [0, 1]. */
  profileAt: (a: number[], b: number[], c: number[], t: number) => number[];
  /**
   * Called for every new vertex with its place in the grid: sector `i` (the sector around side i's
   * first corner), row `j` (0 = side i) and column `k` (0 = side i − 1); the center vertex of an
   * even patch has i = −1 and j = k = S / 2. The caller derives the vertex's UV source from it.
   */
  onVertex?: (id: number, i: number, j: number, k: number) => void;
  /** Adds one face of the patch (the caller sets its material, smoothing and UVs). */
  addFace: (loop: number[]) => void;
}

/** Point components: position and the weight of the control center (for placing it afterwards). */
const D = 4;
type Pt = Float64Array;

interface Level {
  /** Segments per side. */
  N: number;
  pts: Pt[];
  /** Boundary ring: ring[i * N + k] is side i's point at t = k / N. */
  ring: number[];
  /** grid[i][j][k], j, k ∈ [0, N / 2]: sector i around side i's first corner (row 0 = first half of side i). */
  grid: number[][][];
}

/**
 * Fraction of the way from the centroid of the patch corners toward the original vertex where the
 * patch center goes: the diagonal point of the superellipsoid octant (|x|^k + |y|^k + |z|^k = 1) a
 * cube corner with the profile's exponent k rounds to (0.366 for round profiles, 0 for chamfers).
 */
export function patchFullness(exponent: number): number {
  return (Math.pow(3, -1 / exponent) - 1 / 3) * 1.5;
}

function lerpPts(ps: Pt[], ws: number[]): Pt {
  const out = new Float64Array(D);
  for (let i = 0; i < ps.length; i++) for (let q = 0; q < D; q++) out[q] += ps[i][q] * ws[i];
  return out;
}

function average(ps: Pt[]): Pt {
  return lerpPts(
    ps,
    ps.map(() => 1 / ps.length),
  );
}

/** One Catmull–Clark step on the sector grids (boundary points stay on the profiles). */
function refine(lv: Level, n: number, sample: (side: number, t: number) => Pt): Level {
  const { N, pts, ring, grid } = lv;
  const h = N / 2;
  const R = n * N;
  const ringAt = new Int32Array(pts.length).fill(-1);
  ring.forEach((p, r) => (ringAt[p] = r));
  // boundary points as the interior rules see them: off the curve by a sixth of the second difference
  const cpos = pts.map((p, idx) => {
    const r = ringAt[idx];
    if (r < 0 || r % N === 0) return p;
    const a = pts[ring[(r + R - 1) % R]];
    const c = pts[ring[(r + 1) % R]];
    const out = new Float64Array(D);
    for (let q = 0; q < D; q++) out[q] = p[q] - (a[q] + c[q] - 2 * p[q]) / 6;
    return out;
  });
  const out: Pt[] = [];
  const add = (p: Pt) => out.push(p) - 1;
  const quads: number[][] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < h; j++)
      for (let k = 0; k < h; k++)
        quads.push([grid[i][j][k], grid[i][j][k + 1], grid[i][j + 1][k + 1], grid[i][j + 1][k]]);
  const facePt = quads.map((q) => average(q.map((x) => cpos[x])));
  const fmap = facePt.map(add);
  const M = pts.length;
  const edgeFaces = new Map<number, number[]>();
  const vertFaces: number[][] = pts.map(() => []);
  const vertNbrs: number[][] = pts.map(() => []);
  quads.forEach((q, qi) => {
    for (let c = 0; c < 4; c++) {
      const a = q[c];
      const d = q[(c + 1) % 4];
      const key = Math.min(a, d) * M + Math.max(a, d);
      let fs = edgeFaces.get(key);
      if (!fs) {
        edgeFaces.set(key, (fs = []));
        vertNbrs[a].push(d);
        vertNbrs[d].push(a);
      }
      fs.push(qi);
      vertFaces[a].push(qi);
    }
  });
  const emap = new Map<number, number>();
  for (const [key, fs] of edgeFaces) {
    const a = Math.floor(key / M);
    const d = key - a * M;
    let p: Pt;
    if (fs.length === 1) {
      // boundary edge: the profile point halfway between its ends
      const ra = ringAt[a];
      const rd = ringAt[d];
      const r = (ra + 1) % R === rd ? ra : rd;
      p = sample(Math.floor(r / N), ((r % N) + 0.5) / N);
    } else p = average([cpos[a], cpos[d], facePt[fs[0]], facePt[fs[1]]]);
    emap.set(key, add(p));
  }
  const vmap = pts.map((p, idx) => {
    if (ringAt[idx] >= 0) return add(p);
    const nb = vertNbrs[idx];
    const val = nb.length;
    const F = average(vertFaces[idx].map((f) => facePt[f]));
    const E = average(nb.map((x) => lerpPts([cpos[idx], cpos[x]], [0.5, 0.5])));
    return add(lerpPts([F, E, p], [1 / val, 2 / val, (val - 3) / val]));
  });
  const edge = (a: number, d: number) => emap.get(Math.min(a, d) * M + Math.max(a, d))!;
  const N2 = 2 * N;
  const ring2: number[] = new Array(n * N2);
  for (let r = 0; r < R; r++) {
    ring2[2 * r] = vmap[ring[r]];
    ring2[2 * r + 1] = edge(ring[r], ring[(r + 1) % R]);
  }
  const grid2 = grid.map((g, i) => {
    const rows: number[][] = [];
    for (let j = 0; j <= N; j++) rows.push(new Array<number>(N + 1));
    for (let j = 0; j <= h; j++)
      for (let k = 0; k <= h; k++) {
        rows[2 * j][2 * k] = vmap[g[j][k]];
        if (j < h) rows[2 * j + 1][2 * k] = edge(g[j][k], g[j + 1][k]);
        if (k < h) rows[2 * j][2 * k + 1] = edge(g[j][k], g[j][k + 1]);
        if (j < h && k < h) rows[2 * j + 1][2 * k + 1] = fmap[(i * h + j) * h + k];
      }
    return rows;
  });
  return { N: N2, pts: out, ring: ring2, grid: grid2 };
}

/** Bilinear sample of sector grid g at fractional row / column (both within [0, h]). */
function sampleGrid(lv: Level, g: number[][], js: number, ks: number): Pt {
  const h = lv.N / 2;
  const j0 = Math.min(Math.floor(js), h);
  const k0 = Math.min(Math.floor(ks), h);
  const j1 = Math.min(j0 + 1, h);
  const k1 = Math.min(k0 + 1, h);
  const fj = js - j0;
  const fk = ks - k0;
  const P = (j: number, k: number) => lv.pts[g[j][k]];
  return lerpPts(
    [P(j0, k0), P(j0, k1), P(j1, k0), P(j1, k1)],
    [(1 - fj) * (1 - fk), (1 - fj) * fk, fj * (1 - fk), fj * fk],
  );
}

/** Least-squares sphere through points (xyz of `pts`), or null when they do not lie on one sphere. */
function sphereThrough(pts: Pt[]): { c: number[]; r: number } | null {
  if (pts.length < 4) return null;
  // |p|² = 2 c·p + d, d = r² − |c|²: normal equations of the linear fit
  const A = [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0]);
  const mean = [0, 0, 0];
  for (const p of pts) for (let q = 0; q < 3; q++) mean[q] += p[q] / pts.length;
  let extent = 0;
  for (const p of pts) {
    const x = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
    extent = Math.max(extent, Math.hypot(x[0], x[1], x[2]));
    const row = [2 * x[0], 2 * x[1], 2 * x[2], 1];
    const rhs = x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j];
      A[i][4] += row[i] * rhs;
    }
  }
  if (!(extent > 0)) return null;
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (!(Math.abs(A[piv][c]) > 1e-12 * extent * extent * pts.length)) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
    }
  }
  const sol = A.map((row, i) => row[4] / row[i]);
  const c = [sol[0] + mean[0], sol[1] + mean[1], sol[2] + mean[2]];
  const r = Math.sqrt(sol[3] + sol[0] * sol[0] + sol[1] * sol[1] + sol[2] * sol[2]);
  if (!Number.isFinite(r) || r > 100 * extent) return null;
  // the points must lie on it, and not all on one circle of it (a flat ring fits any sphere through it)
  let off = 0;
  for (const p of pts) off = Math.max(off, Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) - r));
  if (off > 1e-6 * r) return null;
  const n = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl > 0) {
    let bend = 0;
    for (const p of pts)
      bend = Math.max(
        bend,
        Math.abs(((p[0] - mean[0]) * n[0] + (p[1] - mean[1]) * n[1] + (p[2] - mean[2]) * n[2]) / nl),
      );
    if (bend < 1e-3 * extent) return null;
  }
  return { c, r };
}

/**
 * Fills an n-sided vertex patch (n ≥ 3 sides of S ≥ 2 segments that share their end points, in the
 * winding order the patch faces get) with a quad grid; see the file comment. `corner` is the original
 * vertex position and `fullness` the fraction of the way from the corners' centroid toward it where
 * the patch center goes (`patchFullness`).
 */
export function fillGridPatch(
  ctx: GridPatchContext,
  sides: PatchSide[],
  S: number,
  corner: number[],
  fullness: number,
  boxiness = 0,
): void {
  const n = sides.length;
  const sample = (i: number, t: number): Pt => {
    const s = sides[i];
    const q = t <= 0 ? s.a : t >= 1 ? s.b : ctx.profileAt(s.a, s.b, s.c, t);
    return Float64Array.of(q[0], q[1], q[2], 0);
  };
  // control mesh: every sector one quad (corner, middle of its side, center, middle of the previous side)
  const pts: Pt[] = [];
  const ring: number[] = [];
  for (let i = 0; i < n; i++) ring.push(pts.push(sample(i, 0)) - 1, pts.push(sample(i, 0.5)) - 1);
  const center = average(ring.filter((_, r) => r % 2 === 0).map((r) => pts[r]));
  const A = [center[0], center[1], center[2]];
  center[3] = 1;
  const c0 = pts.push(center) - 1;
  const grid = sides.map((_, i) => [
    [ring[2 * i], ring[2 * i + 1]],
    [ring[(2 * i - 1 + 2 * n) % (2 * n)], c0],
  ]);
  let lv: Level = { N: 2, pts, ring, grid };
  while (lv.N < S) lv = refine(lv, n, sample);
  // place the control center so that the patch center lands on its target: every point depends
  // linearly on the control center, with the weight carried in component 3
  const h = lv.N / 2;
  const pc = lv.pts[lv.grid[0][h][h]];
  const lambda = pc[3];
  if (lambda > 1e-9) {
    const delta = [0, 1, 2].map((q) => (A[q] + (corner[q] - A[q]) * fullness - pc[q]) / lambda);
    // (boundary points have weight 0; a point object may be listed twice)
    const seen = new Set<Pt>();
    for (const p of lv.pts) {
      if (p[3] === 0 || seen.has(p)) continue;
      seen.add(p);
      for (let q = 0; q < 3; q++) p[q] += p[3] * delta[q];
    }
  }
  // round profiles on one sphere (a cube-like corner): the patch is part of that sphere
  const sphere = sphereThrough(lv.ring.map((x) => lv.pts[x]));
  // resample to S segments per side: canonical points of sector i are rows j ≤ m − 1 + odd and
  // columns k ≤ m (plus the center for even S); the other grid positions are shared with neighbours
  const m = Math.floor(S / 2);
  const odd = S % 2;
  const newVertex = (p: Pt, i: number, j: number, k: number): number => {
    if (sphere) {
      const d = [p[0] - sphere.c[0], p[1] - sphere.c[1], p[2] - sphere.c[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      if (l > 1e-12 * sphere.r) for (let q = 0; q < 3; q++) p[q] = sphere.c[q] + (d[q] * sphere.r) / l;
    }
    const id = ctx.b.addVertex(p[0], p[1], p[2], ctx.colors, ctx.colorIndex);
    ctx.onVertex?.(id, i, j, k);
    return id;
  };
  const canon: number[][][] = sides.map((_, i) => {
    const rows: number[][] = [];
    for (let j = 0; j <= m - 1 + odd; j++) {
      const row: number[] = [];
      for (let k = 0; k <= m; k++) {
        if (j === 0) row.push(sides[i].ids[k]);
        else if (k === 0) row.push(sides[(i + n - 1) % n].ids[S - j]);
        else {
          const p = sampleGrid(lv, lv.grid[i], (j * lv.N) / S, (k * lv.N) / S);
          if (boxiness > 0) {
            // boxy profiles: toward the Coons patch of the sector (its corner, the halves of the two
            // profiles there, straight lines from their middles to the center), which for square
            // profiles is the flat corner of the face itself
            const u = k / (S / 2);
            const w = j / (S / 2);
            const prev = (i + n - 1) % n;
            const c0 = sample(i, 0);
            const mi = sample(i, 0.5);
            const mp = sample(prev, 0.5);
            const g0 = sample(i, u / 2);
            const d0 = sample(prev, 1 - w / 2);
            for (let q = 0; q < 3; q++) {
              const g1 = mp[q] + (pc[q] - mp[q]) * u;
              const d1 = mi[q] + (pc[q] - mi[q]) * w;
              const bil =
                (1 - u) * (1 - w) * c0[q] + u * (1 - w) * mi[q] + (1 - u) * w * mp[q] + u * w * pc[q];
              const coons = (1 - w) * g0[q] + w * g1 + (1 - u) * d0[q] + u * d1 - bil;
              p[q] += boxiness * (coons - p[q]);
            }
          }
          row.push(newVertex(p, i, j, k));
        }
      }
      rows.push(row);
    }
    return rows;
  });
  const centerId = odd ? -1 : newVertex(pc, -1, m, m);
  const at = (i0: number, j0: number, k0: number): number => {
    let [i, j, k] = [i0, j0, k0];
    for (let guard = 0; guard < 4; guard++) {
      if (!odd && j === m && k === m) return centerId;
      if (j <= m - 1 + odd && k <= m) return canon[i][j][k];
      if (k <= m) [i, j, k] = [(i + n - 1) % n, k, S - j];
      else [i, j, k] = [(i + 1) % n, S - k, j];
    }
    throw new Error(`bevel patch: no grid point (${i0}, ${j0}, ${k0})`);
  };
  const face = ctx.addFace;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let k = 0; k < m + odd; k++)
        face([at(i, j, k), at(i, j, k + 1), at(i, j + 1, k + 1), at(i, j + 1, k)]);
  if (odd) face(sides.map((_, i) => at(i, m, m)));
}
