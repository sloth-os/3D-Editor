import type { MeshData } from '../mesh/types';
import { triangulateFaceCorners } from '../mesh/triangulate';
import type { ParticleSettings } from './settings';
import { MAX_INSTANCES } from './settings';
import { GOLDEN_1D, R2_A, R2_B, R3_A, R3_B, R3_C, fract, goldenStride, hash01, streamKey } from './random';

/*
 * Particle distribution over an emitter mesh (object space). The result is a list of samples that
 * reference the mesh topology (triangle + barycentric weights, or a vertex) rather than positions,
 * so the same distribution can be evaluated on a deformed copy of the mesh with the same topology
 * (shape keys, deforming modifiers) and the expensive part stays cached while the emitter animates.
 */

/** Triangulated surface of a mesh with per-triangle areas (cached per mesh instance). */
export interface SurfaceTriangles {
  count: number;
  /** Face index of each triangle. */
  face: Int32Array;
  /** Vertex indices, 3 per triangle (face winding). */
  verts: Int32Array;
  /** Corner indices within the face, 3 per triangle (for per-corner UVs). */
  corners: Int32Array;
  /** Object-space area of each triangle (0 for degenerate or non-finite ones). */
  area: Float64Array;
  /** Total area of each face. */
  faceArea: Float64Array;
}

export const SAMPLE_TRI = 0;
export const SAMPLE_VERT = 1;
export const SAMPLE_POINT = 2;

/** Particles of one system, in emission order. */
export interface ParticleSamples {
  count: number;
  /** Stable particle id: drives the per-particle randomness (size, rotation, pick, display). */
  ids: Uint32Array;
  /** SAMPLE_TRI, SAMPLE_VERT or SAMPLE_POINT. */
  kind: Uint8Array;
  /** Triangle index (into `tris`) or vertex index; -1 for free points. */
  elem: Int32Array;
  /** Barycentric weights of the triangle's second and third corner (2 per particle). */
  bary: Float64Array;
  /** Object-space positions of free points (3 per particle), null when there are none. */
  points: Float64Array | null;
  /** Triangles of the distribution mesh referenced by SAMPLE_TRI samples. */
  tris: SurfaceTriangles | null;
}

export interface ScatterInput {
  /** Distribution mesh (object space). */
  mesh: MeshData;
  settings: ParticleSettings;
  /** Per-vertex density weights 0..1 (inversion already applied), or null. */
  density: Float32Array | null;
  /**
   * Upper-triangular factor U of the emitter's metric (world distance² = |U·p|²) as
   * [u00, u01, u02, u11, u12, u22]; null measures `min_distance` in object space.
   */
  metric: readonly number[] | null;
}

export interface ScatterResult {
  samples: ParticleSamples;
  errors: string[];
}

/** Absolute bound on generated candidates (rejection sampling) per system. */
const MAX_CANDIDATES = 4_000_000;
/** Consecutive min_distance rejections after which the surface counts as full. */
const STALL_LIMIT = 4000;

// random channels of the scatter stream
const CH_U = 0;
const CH_A = 1;
const CH_B = 2;
const CH_C = 3;
const CH_TRI_A = 4;
const CH_TRI_B = 5;
const CH_OFFSET = 6;
const CH_GRID = 7;
const CH_DENSITY = 8;

const triCache = new WeakMap<MeshData, SurfaceTriangles>();

/** Triangulates a mesh for sampling (cached; the mesh must be treated as immutable). */
export function surfaceTriangles(mesh: MeshData): SurfaceTriangles {
  const hit = triCache.get(mesh);
  if (hit) return hit;
  const p = mesh.positions;
  const nv = Math.floor(p.length / 3);
  const face: number[] = [];
  const verts: number[] = [];
  const corners: number[] = [];
  const area: number[] = [];
  const faceArea = new Float64Array(mesh.faces.length);
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    if (!loop || loop.length < 3 || loop.some((v) => !(v >= 0 && v < nv))) continue;
    let tc: number[];
    try {
      tc = loop.length === 3 ? [0, 1, 2] : triangulateFaceCorners(mesh, f);
    } catch {
      tc = [];
      for (let i = 1; i + 1 < loop.length; i++) tc.push(0, i, i + 1);
    }
    let total = 0;
    for (let t = 0; t + 2 < tc.length; t += 3) {
      const a = loop[tc[t]];
      const b = loop[tc[t + 1]];
      const c = loop[tc[t + 2]];
      const ux = p[b * 3] - p[a * 3];
      const uy = p[b * 3 + 1] - p[a * 3 + 1];
      const uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3];
      const vy = p[c * 3 + 1] - p[a * 3 + 1];
      const vz = p[c * 3 + 2] - p[a * 3 + 2];
      let ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (!Number.isFinite(ar)) ar = 0;
      face.push(f);
      verts.push(a, b, c);
      corners.push(tc[t], tc[t + 1], tc[t + 2]);
      area.push(ar);
      total += ar;
    }
    faceArea[f] = total;
  }
  const out: SurfaceTriangles = {
    count: face.length,
    face: Int32Array.from(face),
    verts: Int32Array.from(verts),
    corners: Int32Array.from(corners),
    area: Float64Array.from(area),
    faceArea,
  };
  triCache.set(mesh, out);
  return out;
}

/** Cumulative distribution over weights; null when the total weight is not positive. */
function cumulative(weights: ArrayLike<number>): { cum: Float64Array; total: number } | null {
  const cum = new Float64Array(weights.length);
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w > 0 && Number.isFinite(w)) total += w;
    cum[i] = total;
  }
  return total > 0 ? { cum, total } : null;
}

/** Index of the element containing `u` (in [0, 1)) of a cumulative distribution. */
function pick(cum: Float64Array, total: number, u: number): number {
  const x = u * total;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  // skip trailing zero-weight elements that share the final cumulative value
  while (lo > 0 && cum[lo] === cum[lo - 1]) lo--;
  return lo;
}

/** Growable sample buffers. */
class SampleBuilder {
  ids: number[] = [];
  kind: number[] = [];
  elem: number[] = [];
  bary: number[] = [];
  points: number[] = [];
  hasPoints = false;

  get count(): number {
    return this.ids.length;
  }

  add(id: number, kind: number, elem: number, b1: number, b2: number, x = 0, y = 0, z = 0): void {
    this.ids.push(id);
    this.kind.push(kind);
    this.elem.push(elem);
    this.bary.push(b1, b2);
    this.points.push(x, y, z);
    if (kind === SAMPLE_POINT) this.hasPoints = true;
  }

  finish(tris: SurfaceTriangles | null): ParticleSamples {
    return {
      count: this.ids.length,
      ids: Uint32Array.from(this.ids),
      kind: Uint8Array.from(this.kind),
      elem: Int32Array.from(this.elem),
      bary: Float64Array.from(this.bary),
      points: this.hasPoints ? Float64Array.from(this.points) : null,
      tris,
    };
  }
}

/**
 * Poisson-disk style rejection: accepts a point when no previously accepted point lies within
 * `distance` (measured through the metric factor), using a hash grid of cell size `distance`.
 */
class MinDistanceFilter {
  private readonly cells = new Map<number, number[]>();
  private readonly pts: number[] = [];
  private readonly r2: number;
  private readonly inv: number;

  constructor(
    private readonly distance: number,
    private readonly metric: readonly number[] | null,
  ) {
    this.r2 = distance * distance;
    this.inv = 1 / distance;
  }

  private static key(ix: number, iy: number, iz: number): number {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
  }

  /** Returns true (and records the point) when it is far enough from every accepted point. */
  accept(px: number, py: number, pz: number): boolean {
    let x = px;
    let y = py;
    let z = pz;
    const u = this.metric;
    if (u) {
      x = u[0] * px + u[1] * py + u[2] * pz;
      y = u[3] * py + u[4] * pz;
      z = u[5] * pz;
    }
    if (!Number.isFinite(x + y + z)) return false;
    const cx = Math.floor(x * this.inv);
    const cy = Math.floor(y * this.inv);
    const cz = Math.floor(z * this.inv);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(MinDistanceFilter.key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const i of list) {
            const ex = this.pts[i] - x;
            const ey = this.pts[i + 1] - y;
            const ez = this.pts[i + 2] - z;
            if (ex * ex + ey * ey + ez * ez < this.r2) return false;
          }
        }
    const k = MinDistanceFilter.key(cx, cy, cz);
    const idx = this.pts.length;
    this.pts.push(x, y, z);
    const list = this.cells.get(k);
    if (list) list.push(idx);
    else this.cells.set(k, [idx]);
    return true;
  }
}

/** Object-space bounding box of the finite vertex positions (null for empty meshes). */
function bounds(mesh: MeshData): { min: number[]; max: number[] } | null {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    any = true;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return any ? { min, max } : null;
}

/**
 * Bins triangles by their projection onto the plane perpendicular to `axis`, for counting and
 * locating intersections of axis-aligned rays with the surface.
 */
class AxisRayGrid {
  private readonly b: number;
  private readonly c: number;
  private readonly cellStart: Int32Array;
  private readonly cellTris: Int32Array;
  private readonly nb: number;
  private readonly nc: number;
  private readonly ob: number;
  private readonly oc: number;
  private readonly sb: number;
  private readonly sc: number;

  /**
   * @param origin lattice origin (b, c) and `size` cell size per axis; cells cover the box
   *   [origin, origin + n·size) and rays outside it hit nothing.
   */
  constructor(
    private readonly mesh: MeshData,
    private readonly tris: SurfaceTriangles,
    readonly axis: number,
    origin: [number, number],
    size: [number, number],
    cells: [number, number],
  ) {
    this.b = (axis + 1) % 3;
    this.c = (axis + 2) % 3;
    this.ob = origin[0];
    this.oc = origin[1];
    this.sb = size[0] > 0 ? size[0] : 1;
    this.sc = size[1] > 0 ? size[1] : 1;
    this.nb = Math.max(1, cells[0]);
    this.nc = Math.max(1, cells[1]);
    const p = mesh.positions;
    const counts = new Int32Array(this.nb * this.nc + 1);
    const ranges: number[] = [];
    for (let t = 0; t < tris.count; t++) {
      let minB = Infinity;
      let maxB = -Infinity;
      let minC = Infinity;
      let maxC = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = tris.verts[t * 3 + k] * 3;
        const vb = p[v + this.b];
        const vc = p[v + this.c];
        if (vb < minB) minB = vb;
        if (vb > maxB) maxB = vb;
        if (vc < minC) minC = vc;
        if (vc > maxC) maxC = vc;
      }
      if (!Number.isFinite(minB + maxB + minC + maxC)) {
        ranges.push(1, 0, 1, 0);
        continue;
      }
      const ib0 = Math.max(0, Math.floor((minB - this.ob) / this.sb));
      const ib1 = Math.min(this.nb - 1, Math.floor((maxB - this.ob) / this.sb));
      const ic0 = Math.max(0, Math.floor((minC - this.oc) / this.sc));
      const ic1 = Math.min(this.nc - 1, Math.floor((maxC - this.oc) / this.sc));
      ranges.push(ib0, ib1, ic0, ic1);
      for (let ib = ib0; ib <= ib1; ib++) for (let ic = ic0; ic <= ic1; ic++) counts[ib * this.nc + ic + 1]++;
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.cellStart = counts;
    const fill = counts.slice(0, counts.length - 1);
    this.cellTris = new Int32Array(counts[counts.length - 1]);
    for (let t = 0; t < tris.count; t++) {
      const [ib0, ib1, ic0, ic1] = [ranges[t * 4], ranges[t * 4 + 1], ranges[t * 4 + 2], ranges[t * 4 + 3]];
      for (let ib = ib0; ib <= ib1; ib++)
        for (let ic = ic0; ic <= ic1; ic++) this.cellTris[fill[ib * this.nc + ic]++] = t;
    }
  }

  /**
   * Calls `hit(t, w1, w2, coord)` for every triangle crossed by the line through (pb, pc) parallel
   * to the axis; `coord` is the hit coordinate along the axis and w1/w2 the barycentric weights.
   */
  forEachHit(
    pb: number,
    pc: number,
    hit: (tri: number, w1: number, w2: number, coord: number) => void,
  ): void {
    const ib = Math.floor((pb - this.ob) / this.sb);
    const ic = Math.floor((pc - this.oc) / this.sc);
    if (ib < 0 || ic < 0 || ib >= this.nb || ic >= this.nc) return;
    const cell = ib * this.nc + ic;
    const p = this.mesh.positions;
    const v = this.tris.verts;
    const a = this.axis;
    for (let i = this.cellStart[cell]; i < this.cellStart[cell + 1]; i++) {
      const t = this.cellTris[i];
      const i0 = v[t * 3] * 3;
      const i1 = v[t * 3 + 1] * 3;
      const i2 = v[t * 3 + 2] * 3;
      const b0 = p[i0 + this.b];
      const c0 = p[i0 + this.c];
      const e1b = p[i1 + this.b] - b0;
      const e1c = p[i1 + this.c] - c0;
      const e2b = p[i2 + this.b] - b0;
      const e2c = p[i2 + this.c] - c0;
      const den = e1b * e2c - e1c * e2b;
      if (den === 0 || !Number.isFinite(den)) continue; // parallel to the ray
      const qb = pb - b0;
      const qc = pc - c0;
      const w1 = (qb * e2c - qc * e2b) / den;
      const w2 = (e1b * qc - e1c * qb) / den;
      if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
      const coord = p[i0 + a] + w1 * (p[i1 + a] - p[i0 + a]) + w2 * (p[i2 + a] - p[i0 + a]);
      hit(t, w1, w2, coord);
    }
  }

  /** Sorted hit coordinates along the axis (for parity / inside tests). */
  hits(pb: number, pc: number): number[] {
    const out: number[] = [];
    this.forEachHit(pb, pc, (_t, _w1, _w2, coord) => out.push(coord));
    return out.sort((x, y) => x - y);
  }
}

/** Tiny irrational offsets that keep rays off shared edges and vertices of axis-aligned meshes. */
const NUDGE_B = 1.2345678e-7 * Math.SQRT2;
const NUDGE_C = 2.3456789e-7 * Math.sqrt(3);

function rayGridFor(
  mesh: MeshData,
  tris: SurfaceTriangles,
  box: { min: number[]; max: number[] },
  axis: number,
) {
  const b = (axis + 1) % 3;
  const c = (axis + 2) % 3;
  const eb = box.max[b] - box.min[b];
  const ec = box.max[c] - box.min[c];
  const n = Math.max(1, Math.min(256, Math.round(Math.sqrt(tris.count / 2))));
  const pad = 1e-9 * Math.max(eb, ec, 1e-30);
  return new AxisRayGrid(
    mesh,
    tris,
    axis,
    [box.min[b] - pad, box.min[c] - pad],
    [(eb + 2 * pad) / n, (ec + 2 * pad) / n],
    [n, n],
  );
}

/** Distributes the particles of one system over the emitter mesh (pure, deterministic). */
export function scatterParticles(input: ScatterInput): ScatterResult {
  const { mesh, settings: s } = input;
  const errors: string[] = [];
  const key = streamKey(s.seed, 0x5ca77e5);
  const out = new SampleBuilder();
  const filter = s.min_distance > 0 ? new MinDistanceFilter(s.min_distance, input.metric) : null;
  const target = s.distribution === 'GRID' ? MAX_INSTANCES : Math.min(MAX_INSTANCES, Math.max(0, s.count));
  let tris: SurfaceTriangles | null;
  const nv = Math.floor(mesh.positions.length / 3);

  if (s.distribution === 'GRID') {
    tris = s.emit_from === 'VERT' ? null : surfaceTriangles(mesh);
    gridScatter(mesh, tris, s, input.density, key, out, filter, errors);
    return { samples: out.finish(tris), errors };
  }
  if (target === 0) return { samples: out.finish(null), errors };

  const finishShort = (what: string) => {
    if (out.count < target) {
      if (filter)
        errors.push(
          `min_distance ${s.min_distance}: placed only ${out.count} of ${target} particles (no room left)`,
        );
      else errors.push(what);
    }
  };

  if (s.emit_from === 'FACE') {
    tris = surfaceTriangles(mesh);
    if (tris.count === 0) {
      errors.push('the emitter mesh has no faces to emit from');
      return { samples: out.finish(tris), errors };
    }
    const w = new Float64Array(tris.count);
    for (let t = 0; t < tris.count; t++) {
      let wt = s.use_even_distribution
        ? tris.area[t]
        : tris.faceArea[tris.face[t]] > 0
          ? tris.area[t] / tris.faceArea[tris.face[t]]
          : 0;
      if (input.density) {
        const d = input.density;
        wt *= (d[tris.verts[t * 3]] + d[tris.verts[t * 3 + 1]] + d[tris.verts[t * 3 + 2]]) / 3;
      }
      w[t] = wt;
    }
    const cdf = cumulative(w);
    if (!cdf) {
      errors.push(
        input.density
          ? 'nothing to emit: the density vertex group is zero on every face'
          : 'the emitter surface has zero area',
      );
      return { samples: out.finish(tris), errors };
    }
    const jittered = s.distribution === 'JITTERED';
    const perTri = jittered ? new Int32Array(tris.count) : null;
    const offset = hash01(key, 0, CH_OFFSET);
    const budget = filter ? Math.min(MAX_CANDIDATES, Math.max(target * 30, 5000)) : target;
    let stall = 0;
    for (let j = 0; j < budget && out.count < target; j++) {
      const u = jittered ? fract(offset + j * GOLDEN_1D) : hash01(key, j, CH_U);
      const t = pick(cdf.cum, cdf.total, u);
      let a: number;
      let b: number;
      if (perTri) {
        const k = perTri[t]++;
        a = fract(hash01(key, t, CH_TRI_A) + k * R2_A);
        b = fract(hash01(key, t, CH_TRI_B) + k * R2_B);
      } else {
        a = hash01(key, j, CH_A);
        b = hash01(key, j, CH_B);
      }
      if (a + b > 1) {
        a = 1 - a;
        b = 1 - b;
      }
      if (filter) {
        const p = mesh.positions;
        const i0 = tris.verts[t * 3] * 3;
        const i1 = tris.verts[t * 3 + 1] * 3;
        const i2 = tris.verts[t * 3 + 2] * 3;
        const w0 = 1 - a - b;
        const ok = filter.accept(
          w0 * p[i0] + a * p[i1] + b * p[i2],
          w0 * p[i0 + 1] + a * p[i1 + 1] + b * p[i2 + 1],
          w0 * p[i0 + 2] + a * p[i1 + 2] + b * p[i2 + 2],
        );
        if (!ok) {
          if (++stall > STALL_LIMIT) break;
          continue;
        }
        stall = 0;
      }
      out.add(j, SAMPLE_TRI, t, a, b);
    }
    finishShort(`placed only ${out.count} of ${target} particles`);
    return { samples: out.finish(tris), errors };
  }

  if (s.emit_from === 'VERT') {
    if (nv === 0) {
      errors.push('the emitter mesh has no vertices to emit from');
      return { samples: out.finish(null), errors };
    }
    const p = mesh.positions;
    const w = new Float64Array(nv);
    let uniform = !input.density;
    for (let v = 0; v < nv; v++) {
      const finite =
        Number.isFinite(p[v * 3]) && Number.isFinite(p[v * 3 + 1]) && Number.isFinite(p[v * 3 + 2]);
      if (!finite) uniform = false;
      w[v] = finite ? (input.density ? input.density[v] : 1) : 0;
    }
    const cdf = cumulative(w);
    if (!cdf) {
      errors.push('nothing to emit: the density vertex group is zero on every vertex');
      return { samples: out.finish(null), errors };
    }
    const jittered = s.distribution === 'JITTERED';
    const stride = goldenStride(nv);
    const start = Math.floor(hash01(key, 0, CH_OFFSET) * nv) % nv;
    const offset = hash01(key, 1, CH_OFFSET);
    const budget = filter ? Math.min(MAX_CANDIDATES, Math.max(target * 30, 5000)) : target;
    let stall = 0;
    for (let j = 0; j < budget && out.count < target; j++) {
      let v: number;
      if (jittered && uniform) v = (start + (((j % nv) * stride) % nv)) % nv;
      else v = pick(cdf.cum, cdf.total, jittered ? fract(offset + j * GOLDEN_1D) : hash01(key, j, CH_U));
      if (filter) {
        if (!filter.accept(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])) {
          if (++stall > STALL_LIMIT) break;
          continue;
        }
        stall = 0;
      }
      out.add(j, SAMPLE_VERT, v, 0, 0);
    }
    finishShort(`placed only ${out.count} of ${target} particles`);
    return { samples: out.finish(null), errors };
  }

  // VOLUME: rejection sampling inside the closed surface (parity of +X ray crossings)
  tris = surfaceTriangles(mesh);
  const box = bounds(mesh);
  const ext = box ? [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]] : [0, 0, 0];
  const maxExt = Math.max(ext[0], ext[1], ext[2]);
  if (!box || tris.count === 0 || !(maxExt > 0) || Math.min(ext[0], ext[1], ext[2]) <= maxExt * 1e-9) {
    errors.push('VOLUME emission needs a closed mesh that encloses a volume');
    return { samples: out.finish(tris), errors };
  }
  const grid = rayGridFor(mesh, tris, box, 0);
  const inside = (x: number, y: number, z: number): boolean => {
    let crossings = 0;
    grid.forEachHit(y + NUDGE_B * ext[1], z + NUDGE_C * ext[2], (_t, _a, _b, coord) => {
      if (coord > x) crossings++;
    });
    return (crossings & 1) === 1;
  };
  const jittered = s.distribution === 'JITTERED';
  const o1 = hash01(key, 0, CH_OFFSET);
  const o2 = hash01(key, 1, CH_OFFSET);
  const o3 = hash01(key, 2, CH_OFFSET);
  const budget = Math.min(MAX_CANDIDATES, target * (filter ? 200 : 64) + 1024);
  let stall = 0;
  for (let j = 0; j < budget && out.count < target; j++) {
    const rx = jittered ? fract(o1 + j * R3_A) : hash01(key, j, CH_A);
    const ry = jittered ? fract(o2 + j * R3_B) : hash01(key, j, CH_B);
    const rz = jittered ? fract(o3 + j * R3_C) : hash01(key, j, CH_C);
    const x = box.min[0] + rx * ext[0];
    const y = box.min[1] + ry * ext[1];
    const z = box.min[2] + rz * ext[2];
    if (!inside(x, y, z)) continue;
    if (filter) {
      if (!filter.accept(x, y, z)) {
        if (++stall > STALL_LIMIT) break;
        continue;
      }
      stall = 0;
    }
    out.add(j, SAMPLE_POINT, -1, 0, 0, x, y, z);
  }
  finishShort(`VOLUME emission placed only ${out.count} of ${target} particles (is the mesh closed?)`);
  return { samples: out.finish(tris), errors };
}

/**
 * GRID distribution (Blender-like): a regular lattice with `grid_resolution` cells along the
 * longest side of the bounding box. FACE: one particle per lattice cell crossed by the surface,
 * placed exactly on the surface where an axis-aligned lattice line pierces it; VOLUME: lattice
 * points inside the mesh; VERT: the first vertex in every occupied cell.
 */
function gridScatter(
  mesh: MeshData,
  tris: SurfaceTriangles | null,
  s: ParticleSettings,
  density: Float32Array | null,
  key: number,
  out: SampleBuilder,
  filter: MinDistanceFilter | null,
  errors: string[],
): void {
  const box = bounds(mesh);
  if (!box) {
    errors.push('the emitter mesh has no vertices');
    return;
  }
  const ext = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const maxExt = Math.max(ext[0], ext[1], ext[2]);
  const res = Math.max(1, Math.min(250, Math.round(s.grid_resolution)));
  const d = maxExt > 0 ? maxExt / res : 1;
  const n = ext.map((e) => Math.max(1, Math.min(res, Math.ceil(e / d - 1e-9))));
  const start = ext.map((e, a) => (box.min[a] + box.max[a]) / 2 - ((n[a] - 1) * d) / 2);
  const jitter = s.grid_random * d;
  let id = 0;
  let truncated = false;
  const emit = (
    kind: number,
    elem: number,
    b1: number,
    b2: number,
    x: number,
    y: number,
    z: number,
  ): boolean => {
    const pid = id++;
    if (density && kind !== SAMPLE_POINT) {
      let w: number;
      if (kind === SAMPLE_VERT) w = density[elem];
      else {
        const v = tris!.verts;
        w =
          (1 - b1 - b2) * density[v[elem * 3]] +
          b1 * density[v[elem * 3 + 1]] +
          b2 * density[v[elem * 3 + 2]];
      }
      if (!(hash01(key, pid, CH_DENSITY) < w)) return true;
    }
    if (filter && !filter.accept(x, y, z)) return true;
    if (out.count >= MAX_INSTANCES) {
      truncated = true;
      return false;
    }
    out.add(pid, kind, elem, b1, b2, x, y, z);
    return true;
  };
  const cellIndex = (a: number, coord: number) =>
    Math.max(0, Math.min(n[a] - 1, Math.floor((coord - (start[a] - d / 2)) / d)));

  if (s.emit_from === 'VERT') {
    const p = mesh.positions;
    const taken = new Set<number>();
    for (let v = 0; v * 3 + 2 < p.length; v++) {
      const x = p[v * 3];
      const y = p[v * 3 + 1];
      const z = p[v * 3 + 2];
      if (!Number.isFinite(x + y + z)) continue;
      const c = cellIndex(0, x) + n[0] * (cellIndex(1, y) + n[1] * cellIndex(2, z));
      if (taken.has(c)) continue;
      taken.add(c);
      if (!emit(SAMPLE_VERT, v, 0, 0, x, y, z)) break;
    }
  } else if (s.emit_from === 'FACE') {
    if (!tris || tris.count === 0) {
      errors.push('the emitter mesh has no faces to emit from');
      return;
    }
    const taken = new Set<number>();
    const p = mesh.positions;
    outer: for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      const c = (a + 2) % 3;
      const grid = new AxisRayGrid(mesh, tris, a, [start[b] - d / 2, start[c] - d / 2], [d, d], [n[b], n[c]]);
      for (let ib = 0; ib < n[b]; ib++)
        for (let ic = 0; ic < n[c]; ic++) {
          const col = ib * n[c] + ic + a * 65536 * 4;
          const pb = start[b] + ib * d + (jitter ? (hash01(key, col, CH_GRID) - 0.5) * jitter : 0);
          const pc = start[c] + ic * d + (jitter ? (hash01(key, col, CH_GRID + 1) - 0.5) * jitter : 0);
          const hits: [number, number, number, number][] = [];
          grid.forEachHit(pb, pc, (t, w1, w2, coord) => hits.push([coord, t, w1, w2]));
          hits.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
          for (const [coord, t, w1, w2] of hits) {
            const cell = [0, 0, 0];
            cell[a] = cellIndex(a, coord);
            cell[b] = ib;
            cell[c] = ic;
            const k = cell[0] + n[0] * (cell[1] + n[1] * cell[2]);
            if (taken.has(k)) continue;
            taken.add(k);
            const v = tris.verts;
            const w0 = 1 - w1 - w2;
            const i0 = v[t * 3] * 3;
            const i1 = v[t * 3 + 1] * 3;
            const i2 = v[t * 3 + 2] * 3;
            const x = w0 * p[i0] + w1 * p[i1] + w2 * p[i2];
            const y = w0 * p[i0 + 1] + w1 * p[i1 + 1] + w2 * p[i2 + 1];
            const z = w0 * p[i0 + 2] + w1 * p[i1 + 2] + w2 * p[i2 + 2];
            if (!emit(SAMPLE_TRI, t, w1, w2, x, y, z)) break outer;
          }
        }
    }
  } else {
    // VOLUME: classify lattice points by the parity of +X crossings along each lattice row
    if (!tris || tris.count === 0 || Math.min(ext[0], ext[1], ext[2]) <= maxExt * 1e-9) {
      errors.push('VOLUME emission needs a closed mesh that encloses a volume');
      return;
    }
    const grid = rayGridFor(mesh, tris, box, 0);
    outer: for (let iz = 0; iz < n[2]; iz++)
      for (let iy = 0; iy < n[1]; iy++) {
        const y = start[1] + iy * d;
        const z = start[2] + iz * d;
        const hits = grid.hits(y + NUDGE_B * ext[1], z + NUDGE_C * ext[2]);
        if (hits.length < 2) continue;
        let h = 0;
        for (let ix = 0; ix < n[0]; ix++) {
          const x = start[0] + ix * d;
          while (h < hits.length && hits[h] <= x) h++;
          if (((hits.length - h) & 1) === 0) continue; // even crossings ahead: outside
          const cell = ix + n[0] * (iy + n[1] * iz);
          let px = x;
          let py = y;
          let pz = z;
          if (jitter) {
            px += (hash01(key, cell, CH_GRID) - 0.5) * jitter;
            py += (hash01(key, cell, CH_GRID + 1) - 0.5) * jitter;
            pz += (hash01(key, cell, CH_GRID + 2) - 0.5) * jitter;
          }
          if (!emit(SAMPLE_POINT, -1, 0, 0, px, py, pz)) break outer;
        }
      }
  }
  if (truncated) errors.push(`GRID distribution truncated to ${MAX_INSTANCES} particles`);
}
