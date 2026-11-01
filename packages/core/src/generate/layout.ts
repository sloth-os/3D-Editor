import type { Mat4, Vec3 } from '../math/types';
import { axisAngle4, determinant4, identity4 } from '../math/mat4';
import { anyPerpendicular3, cross3, dot3 } from '../math/vec3';
import type { MeshData } from '../mesh/types';
import { surfaceTriangles } from '../instancing/sampling';
import { matrixToCompatibleEuler } from '../constraints/math';
import { Rng } from './random';

/*
 * Scene layout math used by the object.align / distribute / look_at / scatter_on_surface tools:
 * axis-aligned bounds, distribution along an axis, tracking rotations and seeded surface sampling.
 */

// ------------------------------------------------------------------ bounds

/** Axis-aligned box. An empty box has min = +∞ and max = −∞. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function isEmptyBounds(b: Bounds): boolean {
  return !(b.min[0] <= b.max[0] && b.min[1] <= b.max[1] && b.min[2] <= b.max[2]);
}

/** Grows `b` to contain the point (non-finite points are ignored). */
export function extendBounds(b: Bounds, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
}

/** Bounds of flat xyz points, optionally transformed by `m` first. */
export function pointsBounds(points: ArrayLike<number>, m?: Readonly<Mat4>): Bounds {
  const b = emptyBounds();
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    if (m)
      extendBounds(
        b,
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      );
    else extendBounds(b, x, y, z);
  }
  return b;
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function boundsCenter(b: Bounds): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function boundsSize(b: Bounds): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** Shortest distance between two boxes (0 when they touch or overlap). */
export function boundsGap(a: Bounds, b: Bounds): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(0, a.min[k] - b.max[k], b.min[k] - a.max[k]);
    s += d * d;
  }
  return Math.sqrt(s);
}

export type AlignMode = 'MIN' | 'CENTER' | 'MAX';

/** The MIN side, centre or MAX side of a box along an axis (0 = X, 1 = Y, 2 = Z). */
export function boundsValue(b: Bounds, axis: number, mode: AlignMode): number {
  if (mode === 'MIN') return b.min[axis];
  if (mode === 'MAX') return b.max[axis];
  return (b.min[axis] + b.max[axis]) / 2;
}

// ------------------------------------------------------------------ distribution

/** Extent of an item along the distribution axis (lo = hi for origin-based distribution). */
export interface AxisExtent {
  lo: number;
  hi: number;
}

/**
 * Offsets along one axis that distribute items. Items are ordered by their centre (ties keep the
 * input order). EVEN keeps the first and the last item in place and makes the gaps between
 * consecutive extents equal (they become negative, i.e. even overlaps, when the items are longer
 * than the span); GAP keeps the first item and places every next one `gap` metres after the end of
 * the previous one. Returns the delta of every input item, the resulting gap and the order.
 */
export function distributeDeltas(
  items: readonly AxisExtent[],
  mode: 'EVEN' | 'GAP',
  gap = 0,
): { deltas: number[]; gap: number; order: number[] } {
  const n = items.length;
  const deltas = new Array<number>(n).fill(0);
  const order = items.map((_, i) => i);
  const centre = (i: number) => (items[i].lo + items[i].hi) / 2;
  order.sort((a, b) => centre(a) - centre(b) || a - b);
  if (n < 2) return { deltas, gap: mode === 'GAP' ? gap : 0, order };
  const size = (i: number) => Math.max(0, items[i].hi - items[i].lo);
  let g = gap;
  if (mode === 'EVEN') {
    const first = items[order[0]];
    const last = items[order[n - 1]];
    let total = 0;
    for (const i of order) total += size(i);
    g = (last.hi - first.lo - total) / (n - 1);
  }
  let cursor = items[order[0]].lo;
  for (const i of order) {
    deltas[i] = cursor - items[i].lo;
    cursor += size(i) + g;
  }
  return { deltas, gap: g, order };
}

// ------------------------------------------------------------------ rotations

function norm(v: Readonly<Vec3>): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/** Rotation (about the origin) turning direction `a` onto direction `b` along the shortest arc. */
export function rotationBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): Mat4 {
  const an = norm(a);
  const bn = norm(b);
  if (!an || !bn) return identity4();
  const c = Math.max(-1, Math.min(1, dot3(an, bn)));
  if (c > 1 - 1e-12) return identity4();
  if (c < -1 + 1e-12) return axisAngle4(anyPerpendicular3(an), Math.PI);
  const axis = norm(cross3(an, bn));
  return axis ? axisAngle4(axis, Math.acos(c)) : identity4();
}

export type TrackAxis = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';
export type UpAxis = 'X' | 'Y' | 'Z';

const AXIS_INDEX: Record<UpAxis, number> = { X: 0, Y: 1, Z: 2 };

/**
 * Rotation matrix (columns = the object's X, Y, Z axes in world space) whose `track` axis points
 * along `dir` and whose `up` axis points as close as possible to `worldUp` (Blender Track To).
 * When `dir` is parallel to `worldUp`, `fallbackUp` (e.g. the current up axis) is used instead.
 * Null when `dir` is zero or `track` and `up` name the same axis.
 */
export function trackRotation(
  dir: Readonly<Vec3>,
  track: TrackAxis,
  up: UpAxis,
  worldUp: Readonly<Vec3> = [0, 0, 1],
  fallbackUp?: Readonly<Vec3>,
): Mat4 | null {
  const d = norm(dir);
  const ti = AXIS_INDEX[track.slice(-1) as UpAxis];
  const ui = AXIS_INDEX[up];
  if (!d || ti === ui) return null;
  const sign = track.startsWith('-') ? -1 : 1;
  const perp = (v: Readonly<Vec3> | undefined): Vec3 | null => {
    if (!v) return null;
    const k = dot3(v, d);
    return norm([v[0] - d[0] * k, v[1] - d[1] * k, v[2] - d[2] * k]);
  };
  const u = perp(worldUp) ?? perp(fallbackUp) ?? anyPerpendicular3(d);
  const cols: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  cols[ti] = [d[0] * sign, d[1] * sign, d[2] * sign];
  cols[ui] = u;
  const k = 3 - ti - ui;
  cols[k] = cross3(cols[(k + 1) % 3], cols[(k + 2) % 3]);
  return [...cols[0], 0, ...cols[1], 0, ...cols[2], 0, 0, 0, 0, 1];
}

/**
 * Splits a (parent-relative) matrix into location, Euler XYZ rotation and scale the way Blender
 * applies a matrix to an object with compatible eulers: of the possible angle sets the one closest
 * to `prevRotation` is chosen (no 2π jumps between consecutive edits or keyframes), and the scale
 * keeps the signs of `prevScale` where the matrix allows it (a mirrored object stays mirrored on the
 * same axis; when the mirroring changes, the first negative axis, else X, flips). Shear is dropped.
 * Null for matrices with a zero-length axis or non-finite values.
 */
export function decomposeCompatible(
  m: Readonly<Mat4>,
  prevRotation: Readonly<Vec3>,
  prevScale: Readonly<Vec3>,
): { location: Vec3; rotation: Vec3; scale: Vec3 } | null {
  if (!m.every(Number.isFinite)) return null;
  const len = [0, 1, 2].map((c) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]));
  if (!len.every((l) => l > 1e-12)) return null;
  const sign = [0, 1, 2].map((k) => (prevScale[k] < 0 ? -1 : 1));
  const det = determinant4(m);
  if (sign[0] * sign[1] * sign[2] < 0 !== det < 0) {
    const k = sign.indexOf(-1);
    sign[k < 0 ? 0 : k] *= -1;
  }
  const rot = identity4();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) rot[c * 4 + r] = m[c * 4 + r] / (sign[c] * len[c]);
  const rotation = matrixToCompatibleEuler(rot, prevRotation);
  const scale: Vec3 = [sign[0] * len[0], sign[1] * len[1], sign[2] * len[2]];
  if (![...rotation, ...scale].every(Number.isFinite)) return null;
  return { location: [m[12], m[13], m[14]], rotation, scale };
}

// ------------------------------------------------------------------ surface sampling

export interface SurfaceSample {
  /** World-space point on the surface. */
  point: Vec3;
  /** Unit geometric normal (world space, facing the side the face winding faces in object space). */
  normal: Vec3;
  /** Face index in the mesh. */
  face: number;
}

export interface SurfaceSampleOptions {
  /** Minimum distance between samples in metres (0 = off). */
  minDistance?: number;
  /** Faces whose normal deviates more than this angle (radians) from world +Z are skipped (default π: none). */
  maxSlope?: number;
  /** Candidate budget (default 30 × count + 100); fewer samples are returned when it runs out. */
  maxAttempts?: number;
}

/**
 * Seeded, area-uniform random points on a transformed mesh (world space). With `minDistance` the
 * points are dart-thrown (rejected when closer than that to an earlier point), so fewer than
 * `count` may come back when the surface is full.
 */
export function sampleSurface(
  mesh: MeshData,
  matrix: Readonly<Mat4>,
  count: number,
  seed: number,
  opts: SurfaceSampleOptions = {},
): SurfaceSample[] {
  const want = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (want === 0) return [];
  const tris = surfaceTriangles(mesh);
  const P = mesh.positions;
  const m = matrix;
  const n = tris.count;
  const W = new Float64Array(n * 9);
  const N = new Float64Array(n * 3);
  const cdf = new Float64Array(n);
  const maxSlope = opts.maxSlope ?? Math.PI;
  const cosMax = Math.cos(Math.max(0, Math.min(Math.PI, Number.isFinite(maxSlope) ? maxSlope : Math.PI)));
  // a mirroring transform reverses the winding: flip the world-space cross products back so the
  // normals keep facing the mesh's outside (like the inverse transpose the ray caster uses)
  const flip = determinant4(m) < 0 ? -1 : 1;
  let total = 0;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tris.verts[t * 3 + k] * 3;
      const x = P[v];
      const y = P[v + 1];
      const z = P[v + 2];
      W[t * 9 + k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      W[t * 9 + k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      W[t * 9 + k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    const o = t * 9;
    const ux = W[o + 3] - W[o];
    const uy = W[o + 4] - W[o + 1];
    const uz = W[o + 5] - W[o + 2];
    const vx = W[o + 6] - W[o];
    const vy = W[o + 7] - W[o + 1];
    const vz = W[o + 8] - W[o + 2];
    const nx = (uy * vz - uz * vy) * flip;
    const ny = (uz * vx - ux * vz) * flip;
    const nz = (ux * vy - uy * vx) * flip;
    const l = Math.hypot(nx, ny, nz);
    let area = l / 2;
    if (!(area > 0) || !Number.isFinite(area) || nz / l < cosMax - 1e-12) area = 0;
    else {
      N[t * 3] = nx / l;
      N[t * 3 + 1] = ny / l;
      N[t * 3 + 2] = nz / l;
    }
    total += area;
    cdf[t] = total;
  }
  if (!(total > 0)) return [];
  const rng = new Rng(seed, 0x5ca77e);
  const minD = Math.max(0, Number.isFinite(opts.minDistance ?? 0) ? (opts.minDistance ?? 0) : 0);
  const cell = minD > 0 ? minD : 1;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const out: SurfaceSample[] = [];
  const budget = Math.max(1, Math.floor(opts.maxAttempts ?? want * 30 + 100));
  for (let attempt = 0; attempt < budget && out.length < want; attempt++) {
    const r = rng.next() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] > r) hi = mid;
      else lo = mid + 1;
    }
    const t = lo;
    const su = Math.sqrt(rng.next());
    const v = rng.next();
    const wa = 1 - su;
    const wb = su * (1 - v);
    const wc = su * v;
    const o = t * 9;
    const p: Vec3 = [
      W[o] * wa + W[o + 3] * wb + W[o + 6] * wc,
      W[o + 1] * wa + W[o + 4] * wb + W[o + 7] * wc,
      W[o + 2] * wa + W[o + 5] * wb + W[o + 8] * wc,
    ];
    if (minD > 0) {
      const cx = Math.floor(p[0] / cell);
      const cy = Math.floor(p[1] / cell);
      const cz = Math.floor(p[2] / cell);
      let close = false;
      for (let dx = -1; dx <= 1 && !close; dx++)
        for (let dy = -1; dy <= 1 && !close; dy++)
          for (let dz = -1; dz <= 1 && !close; dz++)
            for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
              const q = out[j].point;
              if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < minD * minD) {
                close = true;
                break;
              }
            }
      if (close) continue;
      const k = key(p[0], p[1], p[2]);
      const list = grid.get(k);
      if (list) list.push(out.length);
      else grid.set(k, [out.length]);
    }
    out.push({ point: p, normal: [N[t * 3], N[t * 3 + 1], N[t * 3 + 2]], face: tris.face[t] });
  }
  return out;
}
