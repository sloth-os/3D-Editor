import type { Vec3 } from '../math/types';
import type { MeshData } from '../mesh/types';
import { Rng } from './random';
import { MeshBuilder, boxProjectUV, clampNum, placeMesh } from './builder';
import { polygonize, type ScalarGrid } from './isosurface';
import { faceIslands } from '../mesh/topology';
import { MATERIALS, type GeneratorResult } from './types';

/*
 * Organic shapes from a smooth union of spheres (signed distance fields blended with a polynomial
 * smooth minimum), meshed with the marching-cubes polygonizer: free-form blobs and clouds.
 *
 * The union blends the spheres in order of distance (nearest first), which makes it independent
 * of the order the spheres are listed in and lets the grid sampler skip every sphere that cannot
 * contribute near a block of samples (exactly: a sphere more than the blend width beyond the
 * nearest one leaves the blend unchanged).
 */

export interface BlobSphere {
  center: Vec3;
  radius: number;
}

/** Polynomial smooth minimum: blends a and b over a band of width k (k = 0: plain minimum). */
export function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/**
 * Smooth union of sphere distances sorted ascending (`e[0..n)`), blended nearest first; stops at
 * the first distance a full blend width beyond the result, which (like all farther ones) cannot
 * change it.
 */
function blendSorted(e: ArrayLike<number>, n: number, k: number): number {
  let d = e[0];
  for (let j = 1; j < n; j++) {
    if (e[j] >= d + k) break;
    d = smoothMin(d, e[j], k);
  }
  return d;
}

/**
 * Smooth union of the first `n` values of `v` whose minimum is `vmin`: only values within one blend
 * width of the minimum can matter; they are sorted into `scratch` and blended.
 */
function blendWithin(v: Float64Array, n: number, vmin: number, k: number, scratch: Float64Array): number {
  let w = 0;
  for (let q = 0; q < n; q++) {
    const x = v[q];
    if (x >= vmin + k && x !== vmin) continue;
    let t = w++;
    while (t > 0 && scratch[t - 1] > x) {
      scratch[t] = scratch[t - 1];
      t--;
    }
    scratch[t] = x;
  }
  return w > 0 ? blendSorted(scratch, w, k) : Infinity;
}

/** Signed distance to the smooth union of the spheres (negative inside; Infinity without spheres). */
export function blobDistance(
  spheres: readonly BlobSphere[],
  k: number,
  x: number,
  y: number,
  z: number,
): number {
  if (spheres.length === 0) return Infinity;
  // (the same arithmetic as sampleSpheres, so both give bit-identical values)
  const e = spheres
    .map((s) => {
      const dx = x - s.center[0];
      const dy = y - s.center[1];
      const dz = z - s.center[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - s.radius;
    })
    .sort((a, b) => a - b);
  return blendSorted(e, e.length, Math.max(0, k));
}

/** Samples per block side for culling spheres in `sampleSpheres`. */
const BLOCK = 4;

/**
 * Samples the smooth union of spheres (`blobDistance`) on a grid covering [min, max] with cells of
 * size `cell` (the layout of `sampleGrid`), optionally cut flat at z = 0 (smooth intersection with
 * the half-space z >= 0, blended over `cut` metres; null = no cut).
 *
 * Work is done per block of samples: only spheres that can reach the blend there are evaluated,
 * and blocks that are certainly more than 1.5 cells outside or inside the surface are filled with
 * a constant. The field is 1-Lipschitz, so grid values that far from the surface never take part
 * in a marching-cubes interpolation: the polygonized surface is exactly the same as with every
 * sample evaluated in full.
 */
export function sampleSpheres(
  spheres: readonly BlobSphere[],
  k: number,
  min: Readonly<Vec3>,
  max: Readonly<Vec3>,
  cell: number,
  cut: number | null = null,
): ScalarGrid {
  const n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell)));
  const step: Vec3 = [0, 1, 2].map((a) => (max[a] - min[a]) / n[a] || cell) as Vec3;
  const [nx, ny, nz] = n;
  const sx = nx + 1;
  const sxy = (nx + 1) * (ny + 1);
  const values = new Float64Array(sxy * (nz + 1));
  const blend = Math.max(0, k);
  const hasCut = cut !== null;
  const cutK = hasCut ? Math.max(0, cut) : 0;
  // values beyond ±far are never interpolated (a sign change lies within one step of a sample)
  const far = 1.5 * Math.max(step[0], step[1], step[2], cell);
  const S = spheres.length;
  const cx = new Float64Array(S);
  const cy = new Float64Array(S);
  const cz = new Float64Array(S);
  const cr = new Float64Array(S);
  spheres.forEach((sp, i) => {
    cx[i] = sp.center[0];
    cy[i] = sp.center[1];
    cz[i] = sp.center[2];
    cr[i] = sp.radius;
  });
  const cand = new Int32Array(S);
  const nearB = new Float64Array(S);
  const farB = new Float64Array(S);
  const dist = new Float64Array(S);
  const sorted = new Float64Array(S);
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  const fill = (bi: number, bj: number, bk: number, i1: number, j1: number, k1: number, v: number) => {
    for (let kk = bk; kk <= k1; kk++)
      for (let jj = bj; jj <= j1; jj++) values.fill(v, bi + sx * jj + sxy * kk, i1 + 1 + sx * jj + sxy * kk);
  };
  for (let bk = 0; bk <= nz; bk += BLOCK)
    for (let bj = 0; bj <= ny; bj += BLOCK)
      for (let bi = 0; bi <= nx; bi += BLOCK) {
        const i1 = Math.min(nx, bi + BLOCK - 1);
        const j1 = Math.min(ny, bj + BLOCK - 1);
        const k1 = Math.min(nz, bk + BLOCK - 1);
        lo[0] = min[0] + bi * step[0];
        lo[1] = min[1] + bj * step[1];
        lo[2] = min[2] + bk * step[2];
        hi[0] = min[0] + i1 * step[0];
        hi[1] = min[1] + j1 * step[1];
        hi[2] = min[2] + k1 * step[2];
        // per sphere the smallest and the largest distance a sample of the block can have; the
        // union is monotonic in every sphere distance, so blending those bounds bounds it too
        let upper = Infinity;
        let nearest = Infinity;
        for (let s = 0; s < S; s++) {
          const x = cx[s];
          const y = cy[s];
          const z = cz[s];
          const gx = x < lo[0] ? lo[0] - x : x > hi[0] ? x - hi[0] : 0;
          const gy = y < lo[1] ? lo[1] - y : y > hi[1] ? y - hi[1] : 0;
          const gz = z < lo[2] ? lo[2] - z : z > hi[2] ? z - hi[2] : 0;
          const fx = Math.max(x - lo[0], hi[0] - x);
          const fy = Math.max(y - lo[1], hi[1] - y);
          const fz = Math.max(z - lo[2], hi[2] - z);
          const ne = Math.sqrt(gx * gx + gy * gy + gz * gz) - cr[s];
          const fe = Math.sqrt(fx * fx + fy * fy + fz * fz) - cr[s];
          nearB[s] = ne;
          farB[s] = fe;
          if (fe < upper) upper = fe;
          if (ne < nearest) nearest = ne;
        }
        // the cut only raises the field (smooth max with -z), and is exact far from z = 0
        if (
          (hasCut && -hi[2] > far) ||
          (nearest > far && blendWithin(nearB, S, nearest, blend, sorted) > far)
        ) {
          fill(bi, bj, bk, i1, j1, k1, 2 * far);
          continue;
        }
        if (
          upper < -far - cutK &&
          (!hasCut || lo[2] > far + cutK) &&
          blendWithin(farB, S, upper, blend, sorted) < -far - cutK
        ) {
          fill(bi, bj, bk, i1, j1, k1, -2 * far);
          continue;
        }
        // spheres starting a full blend width beyond the nearest one never change the union here
        let m = 0;
        for (let s = 0; s < S; s++) if (nearB[s] <= upper + blend) cand[m++] = s;
        for (let kk = bk; kk <= k1; kk++) {
          const z = min[2] + kk * step[2];
          for (let jj = bj; jj <= j1; jj++) {
            const y = min[1] + jj * step[1];
            let o = bi + sx * jj + sxy * kk;
            for (let ii = bi; ii <= i1; ii++, o++) {
              const x = min[0] + ii * step[0];
              // distances of the candidates; only those within a blend width of the nearest one
              // can change the union
              let best = Infinity;
              for (let q = 0; q < m; q++) {
                const s = cand[q];
                const dx = x - cx[s];
                const dy = y - cy[s];
                const dz = z - cz[s];
                const v = Math.sqrt(dx * dx + dy * dy + dz * dz) - cr[s];
                if (v < best) best = v;
                dist[q] = v;
              }
              let d = blendWithin(dist, m, best, blend, sorted);
              if (hasCut) d = -smoothMin(-d, z, cutK);
              values[o] = Number.isFinite(d) ? d : 2 * far;
            }
          }
        }
      }
  return { nx, ny, nz, origin: [min[0], min[1], min[2]], step, values };
}

/** Meshes the zero level set of a sampled grid; returns null when nothing is inside. */
function meshGrid(grid: ScalarGrid): MeshBuilder | null {
  const { positions, triangles } = polygonize(grid, 0);
  if (triangles.length === 0) return null;
  const b = new MeshBuilder();
  for (let i = 0; i < positions.length; i += 3) b.vert([positions[i], positions[i + 1], positions[i + 2]]);
  for (let t = 0; t < triangles.length; t += 3)
    b.face([triangles[t], triangles[t + 1], triangles[t + 2]], 0, true);
  return b;
}

/**
 * Grid over [min, max] with `resolution` cells along the longest side plus one cell of margin
 * (keeps the grid boundary outside the surface). Null for an empty box.
 */
function gridBox(min: Vec3, max: Vec3, resolution: number): { lo: Vec3; hi: Vec3; cell: number } | null {
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(extent > 0) || !Number.isFinite(extent)) return null;
  const cell = extent / resolution;
  return {
    lo: [min[0] - cell, min[1] - cell, min[2] - cell],
    hi: [max[0] + cell, max[1] + cell, max[2] + cell],
    cell,
  };
}

function sphereBounds(spheres: readonly BlobSphere[], pad: number): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of spheres)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], s.center[k] - s.radius - pad);
      max[k] = Math.max(max[k], s.center[k] + s.radius + pad);
    }
  return { min, max };
}

/** Metres with up to 4 significant digits (for messages). */
function metres(v: number): string {
  return `${Number(v.toPrecision(4))} m`;
}

// ------------------------------------------------------------------ blob

export interface BlobParams {
  /** Explicit spheres (object space). When empty/null, `count` random spheres are used. */
  spheres: BlobSphere[] | null;
  /** Number of random spheres (when `spheres` is not given). */
  count: number;
  /** Size of the cube the random spheres are placed in, in metres. */
  size: number;
  /** Blend distance in metres: how softly the spheres merge (0 = hard union). */
  smoothness: number;
  /** Grid cells along the longest side (mesh resolution, 8..160). */
  resolution: number;
  seed: number;
}

export const BLOB_DEFAULTS: BlobParams = {
  spheres: null,
  count: 6,
  size: 2,
  smoothness: 0.35,
  resolution: 48,
  seed: 0,
};

/**
 * Smooth union of spheres. Explicit spheres keep their coordinates; random blobs are centred on
 * the origin. Slot 0: Blob.
 */
export function generateBlob(params: Partial<BlobParams> = {}): GeneratorResult {
  const p = { ...BLOB_DEFAULTS, ...params };
  const k = clampNum(p.smoothness, 0, 100, BLOB_DEFAULTS.smoothness);
  const res = Math.round(clampNum(p.resolution, 8, 160, BLOB_DEFAULTS.resolution));
  const given = p.spheres ?? [];
  let spheres = given.filter(
    (s) =>
      s &&
      Array.isArray(s.center) &&
      s.center.every(Number.isFinite) &&
      Number.isFinite(s.radius) &&
      s.radius > 0,
  );
  const warnings: string[] = [];
  if (spheres.length < given.length)
    warnings.push(
      `ignored ${given.length - spheres.length} sphere(s) without a finite centre and a positive radius` +
        (spheres.length ? '' : '; used random spheres instead'),
    );
  const explicit = spheres.length > 0;
  if (!explicit) {
    const size = clampNum(p.size, 0.01, 1000, BLOB_DEFAULTS.size);
    const count = Math.round(clampNum(p.count, 1, 64, BLOB_DEFAULTS.count));
    const rng = new Rng(p.seed, 0xb10b);
    spheres = Array.from({ length: count }, () => ({
      center: [rng.spread(size * 0.3), rng.spread(size * 0.3), rng.spread(size * 0.3)] as Vec3,
      radius: size * rng.range(0.15, 0.3),
    }));
  }
  const { min, max } = sphereBounds(spheres, k * 0.5);
  const box = gridBox(min, max, res);
  const b = box ? meshGrid(sampleSpheres(spheres, k, box.lo, box.hi, box.cell)) : null;
  const cell = box?.cell ?? 0;
  // given spheres smaller than a grid cell fall between the samples (missing or very coarse)
  const small = explicit ? spheres.filter((s) => s.radius < cell).length : 0;
  if (!b) {
    warnings.push(
      `the spheres are too small for the marching-cubes grid: its cells are ${metres(cell)} ` +
        `(resolution ${res} across ${metres(cell * res)}); raise resolution (max 160), use larger ` +
        'spheres or keep them closer together',
    );
    return { mesh: new MeshBuilder().build(), materials: [MATERIALS.blob], warnings };
  }
  if (small > 0)
    warnings.push(
      `${small} of ${spheres.length} sphere(s) have a radius below the grid cell size (${metres(cell)}) ` +
        'and may be missing or faceted; raise resolution (max 160) or keep the spheres closer together',
    );
  const mesh = b.build();
  if (!explicit) placeMesh(mesh, { centerXY: true, centerZ: true });
  return { mesh, materials: [MATERIALS.blob], ...(warnings.length ? { warnings } : {}) };
}

// ------------------------------------------------------------------ cloud

export interface CloudParams {
  /** Dimensions [x, y, z] of the cloud in metres (exact). */
  size: Vec3;
  /** Number of puffs (spheres) the cloud is made of. */
  puffs: number;
  /** Blend distance as a fraction of the cloud height (how soft the puffs merge). */
  smoothness: number;
  /** Cut the underside flat (cumulus look). */
  flat_bottom: boolean;
  /** Grid cells along the longest side (mesh resolution, 8..160). */
  resolution: number;
  seed: number;
}

export const CLOUD_DEFAULTS: CloudParams = {
  size: [4, 2.5, 1.5],
  puffs: 14,
  smoothness: 0.12,
  flat_bottom: true,
  resolution: 56,
  seed: 0,
};

/**
 * Puffy cloud centred on the Z axis with its base at z = 0. Slot 0: Cloud.
 *
 * Built in a normalized space (cloud height about 1) and stretched to the exact size at the end:
 * a base layer of puffs spread evenly over the footprint ellipse, smaller puffs heaped on top of
 * them. The base puffs are about half the cloud height (the cumulus look), but large enough to
 * overlap into one connected layer over the whole footprint: a flat cloud (footprint much larger
 * than its height, e.g. a 520 × 110 × 12 m stratus streak) gets puffs wider than the cloud is
 * high, which the final stretch flattens into a continuous layer. The marching-cubes grid is
 * refined where the longest side alone would leave a base puff less than 2.5 cells in radius
 * (long or flat clouds), within the sample budget of a cube of `resolution` cells. Voids enclosed
 * between puffs are removed; a cloud that still comes out in several pieces is reported.
 */
export function generateCloud(params: Partial<CloudParams> = {}): GeneratorResult {
  const p = { ...CLOUD_DEFAULTS, ...params };
  const size = (p.size ?? CLOUD_DEFAULTS.size).map((v, i) =>
    clampNum(v, 0.01, 1e4, CLOUD_DEFAULTS.size[i]),
  ) as Vec3;
  const puffs = Math.round(clampNum(p.puffs, 1, 64, CLOUD_DEFAULTS.puffs));
  const res = Math.round(clampNum(p.resolution, 8, 160, CLOUD_DEFAULTS.resolution));
  const rng = new Rng(p.seed, 0xc10d);
  const ax = size[0] / size[2];
  const ay = size[1] / size[2];
  const baseCount = Math.max(1, Math.round(puffs * 0.55));
  // base puff radius: the classic cumulus size, or what it takes to cover the footprint with
  // baseCount overlapping puffs (over its area, and along its length for a long streak)
  const rBase = Math.max(
    0.2,
    Math.min(0.55, ax / 4, ay / 4),
    0.6 * Math.sqrt((ax * ay) / baseCount),
    (0.6 * Math.max(ax, ay)) / (baseCount + 1),
  );
  const spheres = baseLayer(rng, ax / 2, ay / 2, baseCount, rBase);
  for (let i = baseCount; i < puffs; i++) {
    // heap on a base puff, preferring the ones near the centre (the first ones of the layer);
    // pulled a little toward the centre for a domed top, but never off its base puff
    const j = Math.min(baseCount - 1, Math.floor(rng.next() * rng.next() * baseCount));
    const base = spheres[j];
    const r = base.radius * rng.range(0.55, 0.85);
    const off = Math.hypot(base.center[0], base.center[1]);
    const pull = off > 1e-9 ? Math.min(0.3, (0.35 * base.radius) / off) : 0;
    spheres.push({
      center: [
        base.center[0] * (1 - pull) + rng.spread(base.radius * 0.3),
        base.center[1] * (1 - pull) + rng.spread(base.radius * 0.3),
        base.center[2] + base.radius * rng.range(0.45, 0.85),
      ],
      radius: r,
    });
  }
  const flat = p.flat_bottom !== false;
  // smoothness is a fraction of the cloud height: scale it (and the flat cut) to the height of
  // the puffs in the normalized space, which grows with the puffs of a flat cloud
  const bare = sphereBounds(spheres, 0);
  const height = bare.max[2] - (flat ? Math.max(bare.min[2], 0) : bare.min[2]);
  const k = clampNum(p.smoothness, 0, 2, CLOUD_DEFAULTS.smoothness) * height;
  const cut = 0.05 * height;
  const { min, max } = sphereBounds(spheres, k * 0.5);
  if (flat) min[2] = Math.max(min[2], -cut);
  const smallest = Math.min(...spheres.slice(0, baseCount).map((sp) => sp.radius));
  const box = cloudGrid(min, max, res, smallest / 2.5);
  const b = box ? meshGrid(sampleSpheres(spheres, k, box.lo, box.hi, box.cell, flat ? cut : null)) : null;
  if (!b) return { mesh: new MeshBuilder().build(), materials: [MATERIALS.cloud] };
  const { mesh, pieces } = withoutCavities(b.build());
  placeMesh(mesh, { ground: true, centerXY: true });
  // stretch to the exact requested dimensions
  const P = mesh.positions;
  const ext: Vec3 = [0, 0, 0];
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], P[i + c]);
      hi[c] = Math.max(hi[c], P[i + c]);
    }
  for (let c = 0; c < 3; c++) ext[c] = hi[c] - lo[c];
  for (let i = 0; i < P.length; i += 3)
    for (let c = 0; c < 3; c++) if (ext[c] > 1e-9) P[i + c] *= size[c] / ext[c];
  mesh.uvs = mesh.faces.map((f) => boxProjectUV(P, f));
  const warnings =
    pieces > 1
      ? [`the cloud came out in ${pieces} separate pieces: raise smoothness, puffs or resolution`]
      : [];
  return { mesh, materials: [MATERIALS.cloud], ...(warnings.length ? { warnings } : {}) };
}

/**
 * Drops the closed pieces of a marching-cubes surface that face inward (negative volume): the
 * walls of voids enclosed between the puffs of a hard union, invisible from outside. Returns the
 * mesh and the number of outward-facing pieces it consists of.
 */
function withoutCavities(mesh: MeshData): { mesh: MeshData; pieces: number } {
  const isl = faceIslands(mesh);
  if (isl.count < 2) return { mesh, pieces: isl.count };
  const P = mesh.positions;
  const volume = new Float64Array(isl.count);
  mesh.faces.forEach((f, i) => {
    const a = f[0] * 3;
    for (let t = 1; t + 1 < f.length; t++) {
      const b = f[t] * 3;
      const c = f[t + 1] * 3;
      volume[isl.islandOf[i]] +=
        P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
        P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
        P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
  });
  const pieces = volume.filter((v) => v > 0).length;
  if (pieces === isl.count) return { mesh, pieces };
  const out = new MeshBuilder();
  const map = new Map<number, number>();
  mesh.faces.forEach((f, i) => {
    if (!(volume[isl.islandOf[i]] > 0)) return;
    const vs = f.map((v) => {
      let m = map.get(v);
      if (m === undefined) {
        m = out.vert([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
        map.set(v, m);
      }
      return m;
    });
    out.face(vs, 0, true);
  });
  return { mesh: out.build(), pieces };
}

/**
 * The cloud's base layer: `count` puffs of radius rBase × 0.7…1 whose centres are spread evenly
 * (best-candidate sampling) over the ellipse with half-axes hx, hy minus their radius, sorted from
 * the centre outward (heaped puffs prefer the first ones). Then the radii are scaled up where
 * needed until neighbouring puffs overlap along a minimum spanning tree of the centres, so the
 * layer is always one connected piece, whatever the footprint (a long streak has its centres on a
 * line, a wide flat cloud on a disc).
 */
function baseLayer(rng: Rng, hx: number, hy: number, count: number, rBase: number): BlobSphere[] {
  const radii = Array.from({ length: count }, () => rBase * rng.range(0.7, 1));
  const pts: [number, number][] = [];
  const candidates = 16;
  for (let i = 0; i < count; i++) {
    const ex = Math.max(0, hx - radii[i]);
    const ey = Math.max(0, hy - radii[i]);
    let best: [number, number] = [0, 0];
    let bestD = -1;
    for (let c = 0; c < (i === 0 ? 1 : candidates); c++) {
      // uniform over the ellipse (the first puff near the centre)
      const rho = i === 0 ? 0.3 * rng.next() : Math.sqrt(rng.next());
      const a = rng.next() * 2 * Math.PI;
      const q: [number, number] = [Math.cos(a) * rho * ex, Math.sin(a) * rho * ey];
      let d = Infinity;
      for (const o of pts) d = Math.min(d, Math.hypot(q[0] - o[0], q[1] - o[1]));
      if (d > bestD) {
        bestD = d;
        best = q;
      }
    }
    pts.push(best);
  }
  const order = pts
    .map((q, i) => ({ q, r: radii[i], t: Math.hypot(q[0] / Math.max(hx, 1e-9), q[1] / Math.max(hy, 1e-9)) }))
    .sort((a, b) => a.t - b.t);
  // overlap along a minimum spanning tree (Prim): neighbouring puffs must reach into each other
  // by a quarter of their radii so that the union stays connected at the grid resolution
  let scale = 1;
  const inTree = new Array<boolean>(count).fill(false);
  const link = new Array<number>(count).fill(Infinity);
  const from = new Array<number>(count).fill(-1);
  link[0] = 0;
  for (let n = 0; n < count; n++) {
    let u = -1;
    for (let i = 0; i < count; i++) if (!inTree[i] && (u < 0 || link[i] < link[u])) u = i;
    inTree[u] = true;
    if (from[u] >= 0) {
      const a = order[u];
      const b = order[from[u]];
      const d = Math.hypot(a.q[0] - b.q[0], a.q[1] - b.q[1]);
      scale = Math.max(scale, d / (0.75 * (a.r + b.r)));
    }
    for (let i = 0; i < count; i++) {
      if (inTree[i]) continue;
      const d = Math.hypot(order[i].q[0] - order[u].q[0], order[i].q[1] - order[u].q[1]);
      if (d < link[i]) {
        link[i] = d;
        from[i] = u;
      }
    }
  }
  return order.map(({ q, r }) => ({ center: [q[0], q[1], r * scale * 0.35], radius: r * scale }));
}

/**
 * The cloud's marching-cubes grid: `resolution` cells along the longest side (like gridBox), but
 * cells no larger than `fine` where that fits in the samples of a cube of `resolution` cells (a
 * long or flat cloud has few cells across its short sides, so its puffs can be resolved).
 */
function cloudGrid(
  min: Vec3,
  max: Vec3,
  resolution: number,
  fine: number,
): { lo: Vec3; hi: Vec3; cell: number } | null {
  const box = gridBox(min, max, resolution);
  if (!box || !(fine > 0) || fine >= box.cell) return box;
  const ext = [0, 1, 2].map((a) => max[a] - min[a]);
  // the cell size at which the box (with its margin) holds resolution³ cells
  const budget = Math.cbrt((ext[0] + 2 * fine) * (ext[1] + 2 * fine) * (ext[2] + 2 * fine)) / resolution;
  const cell = Math.max(fine, budget);
  if (cell >= box.cell) return box;
  return {
    lo: [min[0] - cell, min[1] - cell, min[2] - cell],
    hi: [max[0] + cell, max[1] + cell, max[2] + cell],
    cell,
  };
}
