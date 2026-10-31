import type { Vec3 } from '../math/types';
import type { Polyhedron, Shape, TriMesh } from './shapes';
import { coreRadius, supportCore, supportingFace } from './shapes';
import { epa, gjk, type SupportFn } from './gjk';
import { clipFeatures, mergeContacts, reduceManifold, type ContactCandidate } from './manifold';
import { closestSegmentPoints, collidePolyhedra, transformPolyhedron } from './sat';
import type { Mat3 } from './vmath';

/*
 * Narrow phase: contact points between two bodies' collision shapes. Pairs are computed in the
 * frame of the first body and returned in world space with normals pointing from A to B.
 *
 * - sphere / capsule cores (point / segment) against each other: closed form;
 * - polyhedra (boxes, hulls, mesh triangles): separating axis test with clipped face manifolds;
 * - everything else (cylinders, cones, rounded cores against polyhedra): GJK distance, EPA for
 *   overlaps, then a manifold from the shapes' supporting faces;
 * - triangle meshes: per triangle (BVH query), with normals at internal (flat or concave) mesh
 *   edges replaced by the face normal so bodies slide over tessellated surfaces smoothly.
 */

/** What the narrow phase needs from a body: its shape and pose (body space → world). */
export interface CollisionPose {
  shape: Shape;
  /** Position of the body origin (centre of mass). */
  px: number;
  py: number;
  pz: number;
  /** Rotation, row-major 3x3 (world = R · body). */
  R: Mat3;
  /** Radius of an origin-centred sphere containing the shape. */
  boundingRadius: number;
}

/** SAT is used for polyhedron pairs up to this many edge pairs; larger hulls use GJK/EPA. */
const SAT_EDGE_PAIRS = 4096;

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Relative transform of B in A's frame: p_A = R · p_B + t. */
function relative(A: CollisionPose, B: CollisionPose): { r: Mat3; t: Vec3 } {
  const a = A.R;
  const b = B.R;
  const r: Mat3 = new Array<number>(9);
  // Rᵀ_A · R_B
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i] * b[j] + a[3 + i] * b[3 + j] + a[6 + i] * b[6 + j];
  const dx = B.px - A.px;
  const dy = B.py - A.py;
  const dz = B.pz - A.pz;
  return {
    r,
    t: [a[0] * dx + a[3] * dy + a[6] * dz, a[1] * dx + a[4] * dy + a[7] * dz, a[2] * dx + a[5] * dy + a[8] * dz],
  };
}

const xf = (r: Readonly<Mat3>, t: Readonly<Vec3>, p: Readonly<Vec3>): Vec3 => [
  r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + t[0],
  r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + t[1],
  r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + t[2],
];

function xfFlat(r: Readonly<Mat3>, t: Readonly<Vec3>, flat: number[]): number[] {
  const out = new Array<number>(flat.length);
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const x = flat[i];
    const y = flat[i + 1];
    const z = flat[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z + t[0];
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + t[1];
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + t[2];
  }
  return out;
}

/** A shape placed in another frame (rotation r, translation t), with its support mapping. */
interface Placed {
  shape: Shape;
  r: Mat3 | null;
  t: Vec3;
}

function placedSupport(p: Placed): SupportFn {
  const s = p.shape;
  if (!p.r) return (dx, dy, dz, out) => supportCore(s, dx, dy, dz, out);
  const r = p.r;
  const t = p.t;
  const tmp = new Float64Array(3);
  return (dx, dy, dz, out) => {
    supportCore(s, r[0] * dx + r[3] * dy + r[6] * dz, r[1] * dx + r[4] * dy + r[7] * dz, r[2] * dx + r[5] * dy + r[8] * dz, tmp);
    out[0] = r[0] * tmp[0] + r[1] * tmp[1] + r[2] * tmp[2] + t[0];
    out[1] = r[3] * tmp[0] + r[4] * tmp[1] + r[5] * tmp[2] + t[1];
    out[2] = r[6] * tmp[0] + r[7] * tmp[1] + r[8] * tmp[2] + t[2];
  };
}

function placedFace(p: Placed, d: Vec3): number[] {
  if (!p.r) return supportingFace(p.shape, d[0], d[1], d[2]);
  const r = p.r;
  const face = supportingFace(p.shape, r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]);
  return xfFlat(r, p.t, face);
}

function placedCenter(p: Placed): Vec3 {
  const s = p.shape;
  const c: Vec3 =
    s.kind === 'poly' ? s.poly.centroid : s.kind === 'mesh' ? [0, 0, 0] : s.kind === 'cone' ? [s.center[0], s.center[1], s.center[2] + s.height / 4] : s.center;
  return p.r ? xf(p.r, p.t, c) : [...c];
}

/** Contacts between two convex shapes in a common frame via GJK/EPA and supporting faces. */
function collideGeneric(a: Placed, b: Placed, maxSep: number, out: ContactCandidate[]): void {
  const rA = coreRadius(a.shape);
  const rB = coreRadius(b.shape);
  const supA = placedSupport(a);
  const supB = placedSupport(b);
  const ca = placedCenter(a);
  const cb = placedCenter(b);
  const g = gjk(supA, supB, [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]]);
  let n: Vec3;
  let pa: Vec3;
  let pb: Vec3;
  let sCore: number;
  if (!g.overlap && g.distance > 1e-9) {
    if (g.distance - rA - rB > maxSep) return;
    const d = g.distance;
    n = [(g.pb[0] - g.pa[0]) / d, (g.pb[1] - g.pa[1]) / d, (g.pb[2] - g.pa[2]) / d];
    pa = g.pa;
    pb = g.pb;
    sCore = d;
  } else {
    const e = epa(supA, supB, g.simplex);
    if (!e) return;
    n = e.normal;
    pa = e.pa;
    pb = e.pb;
    sCore = -e.depth;
  }
  const r = rA + rB;
  const tmp: ContactCandidate[] = [];
  const minus: Vec3 = [-n[0], -n[1], -n[2]];
  if (clipFeatures(placedFace(a, n), placedFace(b, minus), n, maxSep + r, tmp) > 0) {
    let added = 0;
    for (const c of tmp) {
      const s = c.s - r;
      if (s > maxSep) continue;
      out.push({
        pa: [c.pa[0] + n[0] * rA, c.pa[1] + n[1] * rA, c.pa[2] + n[2] * rA],
        pb: [c.pb[0] - n[0] * rB, c.pb[1] - n[1] * rB, c.pb[2] - n[2] * rB],
        n,
        s,
      });
      added++;
    }
    if (added) return;
  }
  if (sCore - r > maxSep) return;
  out.push({
    pa: [pa[0] + n[0] * rA, pa[1] + n[1] * rA, pa[2] + n[2] * rA],
    pb: [pb[0] - n[0] * rB, pb[1] - n[1] * rB, pb[2] - n[2] * rB],
    n,
    s: sCore - r,
  });
}

/** Core feature of a sphere (point) or capsule (segment) placed in a frame. */
function coreSegment(p: Placed): [Vec3, Vec3] {
  const s = p.shape as Extract<Shape, { kind: 'sphere' | 'capsule' }>;
  const h = s.kind === 'capsule' ? s.halfHeight : 0;
  const a: Vec3 = [s.center[0], s.center[1], s.center[2] + h];
  const b: Vec3 = [s.center[0], s.center[1], s.center[2] - h];
  return p.r ? [xf(p.r, p.t, a), xf(p.r, p.t, b)] : [a, b];
}

/** Sphere / capsule pairs: closest points of their core segments, plus a 2-point manifold for parallel capsules. */
function collideRounded(a: Placed, b: Placed, maxSep: number, out: ContactCandidate[]): void {
  const rA = coreRadius(a.shape);
  const rB = coreRadius(b.shape);
  const [a0, a1] = coreSegment(a);
  const [b0, b1] = coreSegment(b);
  const [pa, pb] = closestSegmentPoints(a0, a1, b0, b1);
  const d: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  if (dist - rA - rB > maxSep) return;
  let n: Vec3;
  if (dist > 1e-9) n = [d[0] / dist, d[1] / dist, d[2] / dist];
  else {
    // concentric cores: push apart perpendicular to A's axis (or along +Z)
    const ax: Vec3 = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
    const l = Math.hypot(ax[0], ax[1], ax[2]);
    n = l > 1e-9 ? (Math.abs(ax[0] / l) < 0.9 ? normalized([0, -ax[2], ax[1]]) : normalized([ax[2], 0, -ax[0]])) : [0, 0, 1];
  }
  const r = rA + rB;
  const lenA = Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
  const lenB = Math.hypot(b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]);
  if (lenA > 1e-9 && lenB > 1e-9) {
    const tmp: ContactCandidate[] = [];
    if (clipFeatures([...a0, ...a1], [...b0, ...b1], n, maxSep + r, tmp) > 1) {
      for (const c of tmp)
        out.push({
          pa: [c.pa[0] + n[0] * rA, c.pa[1] + n[1] * rA, c.pa[2] + n[2] * rA],
          pb: [c.pb[0] - n[0] * rB, c.pb[1] - n[1] * rB, c.pb[2] - n[2] * rB],
          n,
          s: c.s - r,
        });
      return;
    }
  }
  out.push({
    pa: [pa[0] + n[0] * rA, pa[1] + n[1] * rA, pa[2] + n[2] * rA],
    pb: [pb[0] - n[0] * rB, pb[1] - n[1] * rB, pb[2] - n[2] * rB],
    n,
    s: dist - r,
  });
}

function normalized(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function edgeCount(P: Polyhedron): number {
  return P.edges.length / 4;
}

const isRounded = (s: Shape) => s.kind === 'sphere' || s.kind === 'capsule';

/** Contacts between two convex shapes; B is placed in A's frame. */
function collideConvex(sa: Shape, b: Placed, maxSep: number, out: ContactCandidate[]): void {
  const a: Placed = { shape: sa, r: null, t: [0, 0, 0] };
  const sb = b.shape;
  if (isRounded(sa) && isRounded(sb)) return collideRounded(a, b, maxSep, out);
  if (sa.kind === 'poly' && sb.kind === 'poly' && edgeCount(sa.poly) * edgeCount(sb.poly) <= SAT_EDGE_PAIRS) {
    const pb = b.r ? transformPolyhedron(sb.poly, b.r, b.t) : sb.poly;
    collidePolyhedra(sa.poly, pb, maxSep, out);
    return;
  }
  const tmp: ContactCandidate[] = [];
  collideGeneric(a, b, maxSep, tmp);
  out.push(...reduceManifold(tmp));
}

// ---------------------------------------------------------------- triangle meshes

const TRI_FACES = [
  [0, 1, 2],
  [0, 2, 1],
];
const TRI_EDGES = Int32Array.from([0, 1, 0, 1, 1, 2, 0, 1, 2, 0, 0, 1]);

/** Flat two-sided polyhedron of one triangle (vertices given in the target frame). */
function trianglePolyhedron(v: Float64Array): Polyhedron {
  const ux = v[3] - v[0];
  const uy = v[4] - v[1];
  const uz = v[5] - v[2];
  const wx = v[6] - v[0];
  const wy = v[7] - v[1];
  const wz = v[8] - v[2];
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  const d = nx * v[0] + ny * v[1] + nz * v[2];
  return {
    verts: v,
    faces: TRI_FACES,
    planes: Float64Array.from([nx, ny, nz, d, -nx, -ny, -nz, -d]),
    edges: TRI_EDGES,
    flat: true,
    centroid: [(v[0] + v[3] + v[6]) / 3, (v[1] + v[4] + v[7]) / 3, (v[2] + v[5] + v[8]) / 3],
  };
}

/**
 * Validates a contact normal against a triangle's internal edges. `m` points from the triangle
 * towards the convex body, `nT` is the triangle normal on the body's side. Normals may only tilt
 * away from the face normal towards active (boundary / convex) edges.
 */
function normalAllowed(m: Vec3, nT: Vec3, tri: Float64Array, active: number): boolean {
  const k = dot(m, nT);
  const tx = m[0] - k * nT[0];
  const ty = m[1] - k * nT[1];
  const tz = m[2] - k * nT[2];
  const tl = Math.hypot(tx, ty, tz);
  if (tl < 0.02 && k > 0) return true;
  if (active === 0) return false;
  const cx = (tri[0] + tri[3] + tri[6]) / 3;
  const cy = (tri[1] + tri[4] + tri[7]) / 3;
  const cz = (tri[2] + tri[5] + tri[8]) / 3;
  let towardsActive = false;
  for (let e = 0; e < 3; e++) {
    const a = e * 3;
    const b = ((e + 1) % 3) * 3;
    const ex = tri[b] - tri[a];
    const ey = tri[b + 1] - tri[a + 1];
    const ez = tri[b + 2] - tri[a + 2];
    // in-plane outward normal of the edge
    let ox = ey * nT[2] - ez * nT[1];
    let oy = ez * nT[0] - ex * nT[2];
    let oz = ex * nT[1] - ey * nT[0];
    const mx = (tri[a] + tri[b]) / 2 - cx;
    const my = (tri[a + 1] + tri[b + 1]) / 2 - cy;
    const mz = (tri[a + 2] + tri[b + 2]) / 2 - cz;
    if (ox * mx + oy * my + oz * mz < 0) {
      ox = -ox;
      oy = -oy;
      oz = -oz;
    }
    const ol = Math.hypot(ox, oy, oz) || 1;
    const c = (tx * ox + ty * oy + tz * oz) / (tl * ol);
    if (c > 0.05) {
      if (!(active & (1 << e))) return false;
      towardsActive = true;
    }
  }
  return towardsActive;
}

/**
 * Contacts between a convex body C and a triangle mesh body M (normals from C to M), in C's frame.
 */
function collideMesh(C: CollisionPose, M: CollisionPose, maxSep: number, out: ContactCandidate[]): void {
  const mesh = (M.shape as { kind: 'mesh'; mesh: TriMesh }).mesh;
  const sc = C.shape;
  if (sc.kind === 'mesh') return;
  const { r, t } = relative(C, M); // mesh → C frame
  // C's bounding sphere in mesh space
  const rm = M.R;
  const dx = C.px - M.px;
  const dy = C.py - M.py;
  const dz = C.pz - M.pz;
  const cx = rm[0] * dx + rm[3] * dy + rm[6] * dz;
  const cy = rm[1] * dx + rm[4] * dy + rm[7] * dz;
  const cz = rm[2] * dx + rm[5] * dy + rm[8] * dz;
  const ext = C.boundingRadius + maxSep;
  const candidates = mesh.bvh.query(cx - ext, cy - ext, cz - ext, cx + ext, cy + ext, cz + ext, []);
  if (candidates.length === 0) return;
  const rC = coreRadius(sc);
  const center = placedCenter({ shape: sc, r: null, t: [0, 0, 0] });
  const all: ContactCandidate[] = [];
  const mv = mesh.verts;
  for (const tri of candidates) {
    const v = new Float64Array(9);
    for (let k = 0; k < 3; k++) {
      const vi = mesh.tris[tri * 3 + k] * 3;
      const p = xf(r, t, [mv[vi], mv[vi + 1], mv[vi + 2]]);
      v[k * 3] = p[0];
      v[k * 3 + 1] = p[1];
      v[k * 3 + 2] = p[2];
    }
    const tp = trianglePolyhedron(v);
    const active = mesh.activeEdges[tri];
    const tmp: ContactCandidate[] = [];
    if (sc.kind === 'poly' && edgeCount(sc.poly) * 3 <= SAT_EDGE_PAIRS)
      collidePolyhedra(sc.poly, tp, maxSep, tmp, (e) => !(active & (1 << e)));
    else collideGeneric({ shape: sc, r: null, t: [0, 0, 0] }, { shape: { kind: 'poly', poly: tp }, r: null, t: [0, 0, 0] }, maxSep, tmp);
    if (tmp.length === 0) continue;
    // triangle normal on the body's side
    let nT: Vec3 = [tp.planes[0], tp.planes[1], tp.planes[2]];
    const side = dot(nT, [center[0] - v[0], center[1] - v[1], center[2] - v[2]]);
    const m: Vec3 = [-tmp[0].n[0], -tmp[0].n[1], -tmp[0].n[2]];
    if (side < 0 || (Math.abs(side) < 1e-9 && dot(nT, m) < 0)) nT = [-nT[0], -nT[1], -nT[2]];
    if (normalAllowed(m, nT, v, active)) {
      all.push(...tmp);
      continue;
    }
    // internal edge: use the face normal and clip the body's supporting face against the triangle
    const n: Vec3 = [-nT[0], -nT[1], -nT[2]];
    const face = supportingFace(sc, n[0], n[1], n[2]);
    const fixed: ContactCandidate[] = [];
    clipFeatures(face, Array.from(v), n, maxSep + rC, fixed);
    for (const c of fixed) {
      const s = c.s - rC;
      if (s > maxSep) continue;
      all.push({ pa: [c.pa[0] + n[0] * rC, c.pa[1] + n[1] * rC, c.pa[2] + n[2] * rC], pb: c.pb, n, s });
    }
  }
  out.push(...mergeContacts(all));
}

// ---------------------------------------------------------------- entry point

function toWorld(A: CollisionPose, c: ContactCandidate): ContactCandidate {
  const R = A.R;
  const t: Vec3 = [A.px, A.py, A.pz];
  return {
    pa: xf(R, t, c.pa),
    pb: xf(R, t, c.pb),
    n: [
      R[0] * c.n[0] + R[1] * c.n[1] + R[2] * c.n[2],
      R[3] * c.n[0] + R[4] * c.n[1] + R[5] * c.n[2],
      R[6] * c.n[0] + R[7] * c.n[1] + R[8] * c.n[2],
    ],
    s: c.s,
  };
}

/**
 * Contact points between bodies A and B in world space (normals from A to B), including
 * speculative contacts separated by up to `maxSep`. Appends to `out`.
 */
export function collide(A: CollisionPose, B: CollisionPose, maxSep: number, out: ContactCandidate[]): void {
  const ka = A.shape.kind;
  const kb = B.shape.kind;
  if (ka === 'mesh' && kb === 'mesh') return;
  const local: ContactCandidate[] = [];
  if (kb === 'mesh') {
    collideMesh(A, B, maxSep, local);
    for (const c of local) out.push(toWorld(A, c));
    return;
  }
  if (ka === 'mesh') {
    collideMesh(B, A, maxSep, local);
    for (const c of local) {
      const w = toWorld(B, c);
      out.push({ pa: w.pb, pb: w.pa, n: [-w.n[0], -w.n[1], -w.n[2]], s: w.s });
    }
    return;
  }
  const { r, t } = relative(A, B);
  collideConvex(A.shape, { shape: B.shape, r, t }, maxSep, local);
  for (const c of local) out.push(toWorld(A, c));
}
