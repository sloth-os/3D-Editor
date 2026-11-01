import type { Mat4, Vec2, Vec3 } from '../math/types';
import { determinant4 } from '../math/mat4';
import { anyPerpendicular3, cross3, dot3, normalize3, transformPoint3 } from '../math/vec3';
import type { MeshData } from '../mesh/types';
import { createMesh, edgeKey } from '../mesh/types';
import { createIcoSphere } from '../mesh/primitives';
import { buildTopology } from '../mesh/topology';
import { faceNormal } from '../mesh/normals';
import { GeneratorLimitError, MAX_GENERATED_FACES } from './types';

/*
 * Mesh construction kit for the procedural generators. `MeshBuilder` accumulates polygons with
 * per-face material index, smooth flag and (optional) corner UVs; faces without explicit UVs get
 * a box projection in metres when the mesh is built. The shape helpers below emit closed,
 * consistently wound (outward facing) parts:
 *
 *   addBox / addBoxBetween   axis-aligned or oriented boxes
 *   addPrism                 extruded 2D outline (concave outlines allowed)
 *   addRingSurface           loft through a sequence of vertex rings (or poles)
 *   addLathe                 surface of revolution of an (r, z) profile
 *   addTube                  circle swept along a polyline (rotation minimizing frames)
 *   addBlade                 thin closed leaf/blade strip along a spine
 *   addIcoSphere             (displaced) ellipsoid from an icosphere
 */

/** Material and shading of the faces a helper emits. */
export interface SurfaceOpts {
  /** Material slot index of the faces (default 0). */
  mat?: number;
  /** Smooth shading (default false). */
  smooth?: boolean;
  /** Optional transform applied to every emitted vertex (mirroring transforms are handled). */
  matrix?: Mat4;
}

const KEY_PRECISION = 1e6;

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly faces: number[][] = [];
  readonly faceUVs: (number[] | null)[] = [];
  readonly faceMats: number[] = [];
  readonly faceSmooth: boolean[] = [];
  /** Edges (edgeKey) marked sharp. */
  readonly sharp = new Set<string>();
  private keyed: Map<string, number> | null = null;

  /**
   * @param limit most faces and most vertices the mesh may get; adding more throws a
   *   GeneratorLimitError, so oversized requests stop early instead of exhausting memory.
   */
  constructor(readonly limit = MAX_GENERATED_FACES) {}

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get faceCount(): number {
    return this.faces.length;
  }

  /** Appends a vertex; non-finite coordinates are replaced by 0. Returns its index. */
  vert(p: Readonly<Vec3>): number {
    const i = this.positions.length / 3;
    if (i >= this.limit) throw new GeneratorLimitError(null, this.limit);
    this.positions.push(fin(p[0]), fin(p[1]), fin(p[2]));
    return i;
  }

  /**
   * Vertex shared with every other `sharedVert` at the same position (rounded to a micrometre),
   * for welding parts that are built separately (e.g. facade grids meeting at building corners).
   */
  sharedVert(p: Readonly<Vec3>): number {
    if (!this.keyed) this.keyed = new Map();
    const k = `${Math.round(p[0] * KEY_PRECISION)},${Math.round(p[1] * KEY_PRECISION)},${Math.round(p[2] * KEY_PRECISION)}`;
    let i = this.keyed.get(k);
    if (i === undefined) {
      i = this.vert(p);
      this.keyed.set(k, i);
    }
    return i;
  }

  position(i: number): Vec3 {
    return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
  }

  /**
   * Adds a polygon (vertex loop, counter-clockwise seen from the front). Consecutive duplicate
   * vertices are collapsed; polygons with fewer than three distinct vertices (or that repeat a
   * vertex) are skipped. Returns the face index, or -1 when skipped.
   */
  face(verts: readonly number[], mat = 0, smooth = false, uv: readonly number[] | null = null): number {
    const vs: number[] = [];
    const uvs: number[] | null = uv && uv.length === verts.length * 2 ? [] : null;
    for (let i = 0; i < verts.length; i++) {
      if (vs.length && vs[vs.length - 1] === verts[i]) continue;
      vs.push(verts[i]);
      if (uvs && uv) uvs.push(uv[i * 2], uv[i * 2 + 1]);
    }
    while (vs.length > 1 && vs[0] === vs[vs.length - 1]) {
      vs.pop();
      if (uvs) uvs.splice(-2, 2);
    }
    if (vs.length < 3 || new Set(vs).size !== vs.length) return -1;
    if (this.faces.length >= this.limit) throw new GeneratorLimitError(null, this.limit);
    this.faces.push(vs);
    this.faceUVs.push(uvs);
    this.faceMats.push(Math.max(0, Math.floor(mat)));
    this.faceSmooth.push(smooth);
    return this.faces.length - 1;
  }

  markSharp(a: number, b: number): void {
    if (a !== b) this.sharp.add(edgeKey(a, b));
  }

  /** Moves every vertex by (dx, dy, dz). */
  translate(dx: number, dy: number, dz: number): void {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      p[i] += dx;
      p[i + 1] += dy;
      p[i + 2] += dz;
    }
  }

  /** Axis-aligned bounds of all vertices (zeros when empty). */
  bounds(): { min: Vec3; max: Vec3 } {
    return boundsOf(this.positions);
  }

  /**
   * Builds the mesh. Faces without explicit UVs get box-projected UVs (`uvScale` UV units per
   * metre).
   */
  build(uvScale = 1): MeshData {
    const uvs = this.faces.map((f, i) => this.faceUVs[i] ?? boxProjectUV(this.positions, f, uvScale));
    const mesh = createMesh({
      positions: this.positions.slice(),
      faces: this.faces.map((f) => f.slice()),
      faceMaterials: this.faceMats.slice(),
      faceSmooth: this.faceSmooth.slice(),
      uvs,
    });
    for (const k of this.sharp) mesh.edgeAttrs[k] = { sharp: true };
    // drop sharp marks on edges that do not exist (defensive; keeps the mesh valid)
    if (this.sharp.size) {
      const edges = new Set<string>();
      for (const f of mesh.faces)
        for (let i = 0; i < f.length; i++) edges.add(edgeKey(f[i], f[(i + 1) % f.length]));
      for (const k of Object.keys(mesh.edgeAttrs)) if (!edges.has(k)) delete mesh.edgeAttrs[k];
    }
    return mesh;
  }
}

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function boundsOf(p: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  if (p.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max };
}

/**
 * Box projection: each face is projected along its dominant normal axis, oriented so textures are
 * not mirrored when seen from the front. Coordinates are metres × `scale`.
 */
export function boxProjectUV(positions: readonly number[], face: readonly number[], scale = 1): number[] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i] * 3;
    const b = face[(i + 1) % face.length] * 3;
    nx += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
    ny += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
    nz += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
  }
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  const out: number[] = [];
  for (const v of face) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let u: number;
    let w: number;
    if (az >= ax && az >= ay) {
      u = x;
      w = nz >= 0 ? y : -y;
    } else if (ax >= ay) {
      u = nx >= 0 ? y : -y;
      w = z;
    } else {
      u = ny >= 0 ? -x : x;
      w = z;
    }
    out.push(u * scale, w * scale);
  }
  return out;
}

/** Signed area of a 2D polygon (positive when counter-clockwise). */
export function polygonArea2D(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Removes consecutive duplicate points (including the wrap-around pair) of a closed outline. */
export function dedupeLoop<T extends readonly number[]>(pts: readonly T[], eps = 1e-9): T[] {
  const out: T[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && p.every((v, k) => Math.abs(v - q[k]) <= eps)) continue;
    out.push(p);
  }
  while (out.length > 1 && out[0].every((v, k) => Math.abs(v - out[out.length - 1][k]) <= eps)) out.pop();
  return out;
}

function xform(m: Mat4 | undefined, p: Vec3): Vec3 {
  return m ? transformPoint3(m, p) : p;
}

function mirrored(m: Mat4 | undefined): boolean {
  return !!m && determinant4(m) < 0;
}

// Corner index = xi*4 + yi*2 + zi; every face is counter-clockwise seen from outside.
const BOX_FACES = [
  [0, 1, 3, 2],
  [4, 6, 7, 5],
  [0, 4, 5, 1],
  [2, 3, 7, 6],
  [0, 2, 6, 4],
  [1, 5, 7, 3],
];

/** Closed box spanning `min`..`max` (in the helper's local space, see `matrix`). */
export function addBox(
  b: MeshBuilder,
  min: Readonly<Vec3>,
  max: Readonly<Vec3>,
  opts: SurfaceOpts = {},
): void {
  const idx: number[] = [];
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [i & 4 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 1 ? max[2] : min[2]];
    idx.push(b.vert(xform(opts.matrix, p)));
  }
  const flip = ((mirrored(opts.matrix) !== max[0] < min[0]) !== max[1] < min[1]) !== max[2] < min[2];
  for (const f of BOX_FACES) {
    const vs = f.map((i) => idx[i]);
    b.face(flip ? vs.reverse() : vs, opts.mat ?? 0, opts.smooth ?? false);
  }
}

/**
 * Closed box along the segment p0 → p1 with a `width` × `height` cross-section. `up` orients the
 * height direction (it is made perpendicular to the segment).
 */
export function addBoxBetween(
  b: MeshBuilder,
  p0: Readonly<Vec3>,
  p1: Readonly<Vec3>,
  width: number,
  height: number,
  up: Readonly<Vec3> = [0, 0, 1],
  opts: Omit<SurfaceOpts, 'matrix'> = {},
): void {
  const d: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-9)) return;
  const x = normalize3(d);
  let z = normalize3(sub(up, scale(x, dot3(up, x))));
  if (Math.hypot(z[0], z[1], z[2]) < 0.5) z = anyPerpendicular3(x);
  const y = cross3(z, x);
  const c: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
  // columns: x·len, y·width, z·height (right handed: x × y = z)
  const m: Mat4 = [
    x[0] * len,
    x[1] * len,
    x[2] * len,
    0,
    y[0] * width,
    y[1] * width,
    y[2] * width,
    0,
    z[0] * height,
    z[1] * height,
    z[2] * height,
    0,
    c[0],
    c[1],
    c[2],
    1,
  ];
  addBox(b, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], { ...opts, matrix: m });
}

export interface PrismOpts extends SurfaceOpts {
  /** Material of the two caps (default: `mat`). */
  capMat?: number;
  /** Per outline edge (edge i joins point i and i+1 of the given outline): smooth side faces. */
  smoothEdge?: (i: number) => boolean;
  /** Per outline edge material (default: `mat`). */
  edgeMat?: (i: number) => number;
  /** Skip the bottom (z0) / top (z1) cap. */
  noBottom?: boolean;
  noTop?: boolean;
}

/**
 * Closed prism: a 2D outline (local XY, any winding, may be concave but must not self-intersect)
 * extruded from z0 to z1. Side faces get UVs that wrap around the outline (metres).
 */
export function addPrism(
  b: MeshBuilder,
  outline: readonly Vec2[],
  z0: number,
  z1: number,
  opts: PrismOpts = {},
): void {
  const pts = dedupeLoop(outline);
  const n = pts.length;
  if (n < 3 || !(Math.abs(z1 - z0) > 1e-12)) return;
  const area = polygonArea2D(pts);
  if (!(Math.abs(area) > 1e-14)) return;
  // work on a counter-clockwise copy; map edge callbacks back to the caller's edge indices
  const ccw = area > 0;
  const order = ccw ? pts.map((_, i) => i) : pts.map((_, i) => n - 1 - i);
  const P = order.map((i) => pts[i]);
  const origEdge = (j: number) => (ccw ? j : (n - 2 - j + n) % n);
  const lo = Math.min(z0, z1);
  const hi = Math.max(z0, z1);
  const m = opts.matrix;
  const bot = P.map((p) => b.vert(xform(m, [p[0], p[1], lo])));
  const top = P.map((p) => b.vert(xform(m, [p[0], p[1], hi])));
  const flip = mirrored(m);
  const add = (vs: number[], mat: number, smooth: boolean, uv: number[] | null) => {
    if (flip) {
      vs.reverse();
      if (uv) uv = reverseUV(uv);
    }
    b.face(vs, mat, smooth, uv);
  };
  const mat = opts.mat ?? 0;
  const capMat = opts.capMat ?? mat;
  if (!opts.noTop) add(top.slice(), capMat, false, null);
  if (!opts.noBottom) add(bot.slice().reverse(), capMat, false, null);
  let s = 0;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    const len = Math.hypot(P[k][0] - P[j][0], P[k][1] - P[j][1]);
    const e = origEdge(j);
    add(
      [bot[j], bot[k], top[k], top[j]],
      opts.edgeMat ? opts.edgeMat(e) : mat,
      opts.smoothEdge ? opts.smoothEdge(e) : (opts.smooth ?? false),
      [s, lo, s + len, lo, s + len, hi, s, hi],
    );
    s += len;
  }
}

function reverseUV(uv: number[]): number[] {
  const out: number[] = [];
  for (let i = uv.length - 2; i >= 0; i -= 2) out.push(uv[i], uv[i + 1]);
  return out;
}

export interface RingSurfaceOpts extends SurfaceOpts {
  /** Connect the last ring back to the first (closed profile, e.g. a torus). */
  loop?: boolean;
  /** Close the first / last ring with a flat polygon (ignored for poles and loops). */
  capStart?: boolean;
  capEnd?: boolean;
  capMat?: number;
  /** Reverse the winding of every face. */
  flip?: boolean;
  /** V texture coordinate per ring (default: ring index / (rings - 1)). */
  v?: readonly number[];
}

/**
 * Lofts a surface through a sequence of rings. Each ring is a closed loop of `n` points (all rings
 * the same `n`) or a single point (a pole). Rings must run counter-clockwise when viewed from the
 * direction the sequence advances towards; then all faces point outwards (use `flip` otherwise).
 * Side faces get UVs u = position around the ring (0..1), v = `opts.v`.
 */
export function addRingSurface(
  b: MeshBuilder,
  rings: readonly (readonly Vec3[])[],
  opts: RingSurfaceOpts = {},
): void {
  const R = rings.length;
  if (R < 2) return;
  // (a loop, not Math.max(...): spreading 100k+ rings would overflow the call stack)
  let n = 0;
  for (const r of rings) if (r.length > n) n = r.length;
  if (n < 3 || rings.some((r) => r.length !== 1 && r.length !== n)) return;
  const m = opts.matrix;
  const flip = !!opts.flip !== mirrored(m);
  const ids = rings.map((r) => r.map((p) => b.vert(xform(m, [p[0], p[1], p[2]]))));
  const mat = opts.mat ?? 0;
  const smooth = opts.smooth ?? false;
  const vOf = (i: number) => opts.v?.[i] ?? i / (R - 1);
  const emit = (vs: number[], uv: number[] | null, faceMat = mat, faceSmooth = smooth) => {
    if (flip) {
      vs.reverse();
      if (uv) uv = reverseUV(uv);
    }
    b.face(vs, faceMat, faceSmooth, uv);
  };
  const segs = opts.loop ? R : R - 1;
  for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % R;
    const A = ids[i];
    const B = ids[i1];
    const va = vOf(i);
    const vb = opts.loop && i1 === 0 ? vOf(R - 1) + (vOf(R - 1) - vOf(R - 2) || 1) : vOf(i1);
    if (A.length === 1 && B.length === 1) continue;
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      const u0 = j / n;
      const u1 = (j + 1) / n;
      if (A.length === 1) emit([A[0], B[j1], B[j]], [(u0 + u1) / 2, va, u1, vb, u0, vb]);
      else if (B.length === 1) emit([A[j], A[j1], B[0]], [u0, va, u1, va, (u0 + u1) / 2, vb]);
      else emit([A[j], A[j1], B[j1], B[j]], [u0, va, u1, va, u1, vb, u0, vb]);
    }
  }
  if (!opts.loop) {
    const capMat = opts.capMat ?? mat;
    if (opts.capStart && ids[0].length >= 3) emit(ids[0].slice().reverse(), null, capMat, false);
    if (opts.capEnd && ids[R - 1].length >= 3) emit(ids[R - 1].slice(), null, capMat, false);
  }
}

/**
 * Whether a lathe profile ([r, z] points; implicitly closed from the last point back to the
 * first) runs clockwise, i.e. its revolution needs flipped faces to point outwards.
 */
export function profileIsClockwise(profile: readonly Vec2[]): boolean {
  return polygonArea2D(profile) < 0;
}

export interface LatheOpts extends SurfaceOpts {
  /** The profile is a closed loop (torus-like ring); otherwise its ends are joined via the axis. */
  loop?: boolean;
  /** Angle of the first vertex column (radians). */
  angle0?: number;
}

/**
 * Surface of revolution around the local Z axis. `profile` lists [r, z] points; points with r ≈ 0
 * become poles. The winding is chosen from the profile's orientation so faces always point
 * outwards. UV: u around (0..1), v = profile arc length / (2π · max radius).
 */
export function addLathe(
  b: MeshBuilder,
  profile: readonly Vec2[],
  segments: number,
  opts: LatheOpts = {},
): void {
  const prof = dedupeOpen(profile);
  if (prof.length < 2) return;
  const n = Math.max(3, Math.floor(segments));
  const a0 = opts.angle0 ?? 0;
  const rings: Vec3[][] = prof.map(([r, z]) => {
    if (Math.abs(r) < 1e-9) return [[0, 0, z]];
    const ring: Vec3[] = [];
    for (let j = 0; j < n; j++) {
      const a = a0 + (2 * Math.PI * j) / n;
      ring.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    return ring;
  });
  let rMax = 1e-6;
  for (const q of prof) rMax = Math.max(rMax, Math.abs(q[0]));
  const v: number[] = [0];
  for (let i = 1; i < prof.length; i++)
    v.push(
      v[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]) / (2 * Math.PI * rMax),
    );
  addRingSurface(b, rings, { ...opts, loop: opts.loop, flip: profileIsClockwise(prof), v });
}

function dedupeOpen(pts: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

export interface Frames {
  /** Unit tangents. */
  t: Vec3[];
  /** Unit normals (N × B = T). */
  n: Vec3[];
  b: Vec3[];
}

/**
 * Rotation minimizing frames along a polyline (double reflection method). The first normal is
 * the component of `up` perpendicular to the first tangent. For cyclic paths the remaining twist
 * is distributed along the path so the frames close up.
 */
export function pathFrames(path: readonly Vec3[], cyclic = false, up: Readonly<Vec3> = [0, 0, 1]): Frames {
  const k = path.length;
  const t: Vec3[] = [];
  for (let i = 0; i < k; i++) {
    const prev = cyclic ? path[(i - 1 + k) % k] : path[Math.max(0, i - 1)];
    const next = cyclic ? path[(i + 1) % k] : path[Math.min(k - 1, i + 1)];
    const din = normalize3(sub(path[i], prev));
    const dout = normalize3(sub(next, path[i]));
    let tan = normalize3(add(din, dout));
    if (len(tan) < 0.5) tan = len(dout) > 0.5 ? dout : din;
    if (len(tan) < 0.5) tan = i > 0 ? t[i - 1] : [0, 0, 1];
    t.push(tan);
  }
  const n: Vec3[] = new Array(k);
  let r0 = sub(up, scale(t[0], dot3(up, t[0])));
  r0 = len(r0) > 1e-6 ? normalize3(r0) : anyPerpendicular3(t[0]);
  n[0] = r0;
  const reflect = (ri: Vec3, ti: Vec3, a: Readonly<Vec3>, bb: Readonly<Vec3>, tj: Vec3): Vec3 => {
    const v1 = sub(bb, a);
    const c1 = dot3(v1, v1);
    if (c1 < 1e-18) return orthoNormal(ri, tj);
    const rL = sub(ri, scale(v1, (2 / c1) * dot3(v1, ri)));
    const tL = sub(ti, scale(v1, (2 / c1) * dot3(v1, ti)));
    const v2 = sub(tj, tL);
    const c2 = dot3(v2, v2);
    const r = c2 < 1e-18 ? rL : sub(rL, scale(v2, (2 / c2) * dot3(v2, rL)));
    return orthoNormal(r, tj);
  };
  for (let i = 0; i + 1 < k; i++) n[i + 1] = reflect(n[i], t[i], path[i], path[i + 1], t[i + 1]);
  if (cyclic && k > 2) {
    // propagate once more back to the start and spread the angular mismatch along the path
    const end = reflect(n[k - 1], t[k - 1], path[k - 1], path[0], t[0]);
    const angle = Math.atan2(dot3(cross3(end, n[0]), t[0]), dot3(end, n[0]));
    const lens = [0];
    for (let i = 1; i < k; i++) lens.push(lens[i - 1] + len(sub(path[i], path[i - 1])));
    const total = lens[k - 1] + len(sub(path[0], path[k - 1])) || 1;
    for (let i = 1; i < k; i++) n[i] = rotateAbout(n[i], t[i], (angle * lens[i]) / total);
  }
  const bn = n.map((ni, i) => cross3(t[i], ni));
  return { t, n, b: bn };
}

function orthoNormal(r: Vec3, t: Vec3): Vec3 {
  const o = sub(r, scale(t, dot3(r, t)));
  return len(o) > 1e-9 ? normalize3(o) : anyPerpendicular3(t);
}

/** Rotates v about the unit axis by angle (Rodrigues). */
export function rotateAbout(v: Readonly<Vec3>, axis: Readonly<Vec3>, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(axis, v);
  const x = cross3(axis, v);
  return [
    v[0] * c + x[0] * s + axis[0] * d * (1 - c),
    v[1] * c + x[1] * s + axis[1] * d * (1 - c),
    v[2] * c + x[2] * s + axis[2] * d * (1 - c),
  ];
}

export interface TubeOpts extends SurfaceOpts {
  /** The path is a closed loop. */
  cyclic?: boolean;
  /** Close open ends with flat caps (default true). */
  caps?: boolean;
  capMat?: number;
  /** Miter the rings at path corners so the tube keeps its radius through sharp bends. */
  miter?: boolean;
  /** Reference direction for the first frame normal (default +Z). */
  up?: Vec3;
}

/**
 * Circle of `sides` vertices swept along `path`. `radius` is a constant or a per-point function.
 * UV: u around the tube, v = distance along the path / (2π · first radius).
 */
export function addTube(
  b: MeshBuilder,
  path: readonly Vec3[],
  radius: number | ((i: number) => number),
  sides: number,
  opts: TubeOpts = {},
): void {
  const t = tubeRings(path, radius, sides, opts);
  if (!t) return;
  const caps = opts.caps ?? true;
  addRingSurface(b, t.rings, {
    ...opts,
    loop: t.cyclic,
    capStart: caps,
    capEnd: caps,
    v: t.v,
  });
}

/**
 * The vertex rings `addTube` lofts through (one per distinct path point; a single point where the
 * radius is 0), with per-ring v coordinates. Null when the path has fewer than two distinct points.
 */
export function tubeRings(
  path: readonly Vec3[],
  radius: number | ((i: number) => number),
  sides: number,
  opts: Pick<TubeOpts, 'cyclic' | 'miter' | 'up'> = {},
): { rings: Vec3[][]; v: number[]; cyclic: boolean } | null {
  const pts = dedupeOpen3(path, !!opts.cyclic);
  if (pts.length < 2) return null;
  const cyclic = !!opts.cyclic && pts.length > 2;
  const n = Math.max(3, Math.floor(sides));
  const fr = pathFrames(pts, cyclic, opts.up ?? [0, 0, 1]);
  const rad = (i: number) => {
    const r = typeof radius === 'number' ? radius : radius(i);
    return Number.isFinite(r) ? Math.max(0, r) : 0;
  };
  const r0 = Math.max(1e-6, rad(0));
  const v: number[] = [0];
  for (let i = 1; i < pts.length; i++) v.push(v[i - 1] + len(sub(pts[i], pts[i - 1])) / (2 * Math.PI * r0));
  const rings = pts.map((p, i) => {
    const r = rad(i);
    if (r < 1e-9) return [p];
    let stretch = 1;
    let bend: Vec3 | null = null;
    if (opts.miter && (cyclic || (i > 0 && i < pts.length - 1))) {
      const din = normalize3(sub(p, pts[(i - 1 + pts.length) % pts.length]));
      const dout = normalize3(sub(pts[(i + 1) % pts.length], p));
      const c = dot3(fr.t[i], din);
      const k = sub(dout, din);
      if (c > 0.05 && len(k) > 1e-6) {
        stretch = 1 / c;
        bend = normalize3(sub(k, scale(fr.t[i], dot3(k, fr.t[i]))));
      }
    }
    const ring: Vec3[] = [];
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n;
      let o = add(scale(fr.n[i], Math.cos(a) * r), scale(fr.b[i], Math.sin(a) * r));
      if (bend) o = add(o, scale(bend, dot3(o, bend) * (stretch - 1)));
      ring.push(add(p, o));
    }
    return ring;
  });
  return { rings, v, cyclic };
}

function dedupeOpen3(path: readonly Vec3[], cyclic: boolean): Vec3[] {
  const out: Vec3[] = [];
  for (const p of path) {
    if (!p.every(Number.isFinite)) continue;
    const q = out[out.length - 1];
    if (q && len(sub(p, q)) < 1e-9) continue;
    out.push([p[0], p[1], p[2]]);
  }
  if (cyclic) while (out.length > 2 && len(sub(out[0], out[out.length - 1])) < 1e-9) out.pop();
  return out;
}

/**
 * Thin closed blade (leaf, petal, grass blade, palm frond) along a spine. The cross-section is a
 * flat diamond: `widths[i]` across and `thickness[i]` through; points where both are ~0 become a
 * single vertex (pointed ends). `normals[i]` is the direction the blade's top side should face.
 */
export function addBlade(
  b: MeshBuilder,
  spine: readonly Vec3[],
  widths: readonly number[],
  thickness: readonly number[],
  normals: readonly Vec3[],
  opts: SurfaceOpts = {},
): void {
  const k = spine.length;
  if (k < 2) return;
  const rings: Vec3[][] = [];
  for (let i = 0; i < k; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(k - 1, i + 1)];
    let t = normalize3(sub(next, prev));
    if (len(t) < 0.5) t = [0, 0, 1];
    let s = normalize3(cross3(normals[i] ?? [0, 0, 1], t));
    if (len(s) < 0.5) s = anyPerpendicular3(t);
    const u = cross3(t, s);
    const w = Math.max(0, widths[i] ?? 0) / 2;
    const h = Math.max(0, thickness[i] ?? 0) / 2;
    const p = spine[i];
    if (w < 1e-7 && h < 1e-7) rings.push([p]);
    else
      rings.push([
        add(p, scale(s, Math.max(w, 1e-6))),
        add(p, scale(u, Math.max(h, 1e-6))),
        sub(p, scale(s, Math.max(w, 1e-6))),
        sub(p, scale(u, Math.max(h, 1e-6))),
      ]);
  }
  addRingSurface(b, rings, { ...opts, capStart: true, capEnd: true });
}

/**
 * Ellipsoid from an icosphere (`levels` 1..6: 20·4^(levels-1) triangles) centred at `center`
 * with semi-axes `radii`; `displace(dir)` scales the radius along each unit direction.
 */
export function addIcoSphere(
  b: MeshBuilder,
  center: Readonly<Vec3>,
  radii: Readonly<Vec3>,
  levels: number,
  opts: SurfaceOpts & { displace?: (dir: Vec3) => number } = {},
): void {
  const ico = createIcoSphere({ subdivisions: Math.max(1, Math.min(6, Math.floor(levels))), radius: 1 });
  const base = b.vertexCount;
  const P = ico.positions;
  for (let i = 0; i < P.length; i += 3) {
    const d: Vec3 = [P[i], P[i + 1], P[i + 2]];
    const f = opts.displace ? Math.max(0.05, opts.displace(d)) : 1;
    b.vert(
      xform(opts.matrix, [
        center[0] + d[0] * radii[0] * f,
        center[1] + d[1] * radii[1] * f,
        center[2] + d[2] * radii[2] * f,
      ]),
    );
  }
  const flip = mirrored(opts.matrix) !== radii[0] * radii[1] * radii[2] < 0;
  for (let f = 0; f < ico.faces.length; f++) {
    const vs = ico.faces[f].map((v) => v + base);
    const uv = ico.uvs ? ico.uvs[f].slice() : null;
    b.face(flip ? vs.reverse() : vs, opts.mat ?? 0, opts.smooth ?? true, flip && uv ? reverseUV(uv) : uv);
  }
}

/**
 * Marks edges between faces whose normals differ by more than `angle` (radians) as sharp, so smooth
 * shaded meshes keep crisp creases (like Blender's Auto Smooth).
 */
export function markSharpEdges(mesh: MeshData, angle: number): void {
  const topo = buildTopology(mesh);
  const normals = mesh.faces.map((_, f) => faceNormal(mesh, f));
  const cos = Math.cos(angle);
  for (let e = 0; e < topo.edges.length; e++) {
    const ef = topo.edgeFaces[e];
    if (ef.length !== 2) continue;
    if (dot3(normals[ef[0]], normals[ef[1]]) < cos) {
      const [a, c] = topo.edges[e];
      mesh.edgeAttrs[edgeKey(a, c)] = { ...mesh.edgeAttrs[edgeKey(a, c)], sharp: true };
    }
  }
}

/**
 * Moves a mesh in place: `ground` puts its lowest point on z = 0, `centerXY` centres its bounding
 * box on the Z axis, `centerZ` centres it vertically. Returns the applied offset.
 */
export function placeMesh(
  mesh: MeshData,
  opts: { ground?: boolean; centerXY?: boolean; centerZ?: boolean },
): Vec3 {
  const { min, max } = boundsOf(mesh.positions);
  const d: Vec3 = [
    opts.centerXY ? -(min[0] + max[0]) / 2 : 0,
    opts.centerXY ? -(min[1] + max[1]) / 2 : 0,
    opts.ground ? -min[2] : opts.centerZ ? -(min[2] + max[2]) / 2 : 0,
  ];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] += d[0];
    p[i + 1] += d[1];
    p[i + 2] += d[2];
  }
  return d;
}

// ---------------------------------------------------------------- tiny vector helpers

export function add(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Readonly<Vec3>, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function len(a: Readonly<Vec3>): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** a + (b - a) · t */
export function mix(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function clampNum(v: number, lo: number, hi: number, fallback = lo): number {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clampNum((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
