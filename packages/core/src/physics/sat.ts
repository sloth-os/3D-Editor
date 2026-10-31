import type { Vec3 } from '../math/types';
import type { Polyhedron } from './shapes';
import { clipFeatures, reduceManifold, type ContactCandidate } from './manifold';
import type { Mat3 } from './vmath';

/*
 * Separating axis test between convex polyhedra (boxes, convex hulls, mesh triangles), after
 * D. Gregorius, "The Separating Axis Test between Convex Polyhedra" (GDC 2013): face normals of
 * both shapes plus edge-edge axes that form faces of the Minkowski difference (Gauss map
 * pruning). Face contacts are clipped into full manifolds; edge contacts give one point. Flat
 * polyhedra (polygons) get Gauss map arcs through the outward edge normals so their edges are
 * handled exactly.
 */

/** Transforms a polyhedron into another frame: p' = R · p + t. */
export function transformPolyhedron(P: Polyhedron, r: Readonly<Mat3>, t: Readonly<Vec3>): Polyhedron {
  const v = P.verts;
  const verts = new Float64Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i];
    const y = v[i + 1];
    const z = v[i + 2];
    verts[i] = r[0] * x + r[1] * y + r[2] * z + t[0];
    verts[i + 1] = r[3] * x + r[4] * y + r[5] * z + t[1];
    verts[i + 2] = r[6] * x + r[7] * y + r[8] * z + t[2];
  }
  const pl = P.planes;
  const planes = new Float64Array(pl.length);
  for (let i = 0; i < pl.length; i += 4) {
    const x = pl[i];
    const y = pl[i + 1];
    const z = pl[i + 2];
    const nx = r[0] * x + r[1] * y + r[2] * z;
    const ny = r[3] * x + r[4] * y + r[5] * z;
    const nz = r[6] * x + r[7] * y + r[8] * z;
    planes[i] = nx;
    planes[i + 1] = ny;
    planes[i + 2] = nz;
    planes[i + 3] = pl[i + 3] + nx * t[0] + ny * t[1] + nz * t[2];
  }
  const c = P.centroid;
  return {
    verts,
    faces: P.faces,
    planes,
    edges: P.edges,
    flat: P.flat,
    centroid: [
      r[0] * c[0] + r[1] * c[1] + r[2] * c[2] + t[0],
      r[3] * c[0] + r[4] * c[1] + r[5] * c[2] + t[1],
      r[6] * c[0] + r[7] * c[1] + r[8] * c[2] + t[2],
    ],
  };
}

interface FaceQuery {
  index: number;
  sep: number;
}

/** Largest separation of Q from the face planes of P. */
function queryFaces(P: Polyhedron, Q: Polyhedron, maxSep: number): FaceQuery {
  const pl = P.planes;
  const v = Q.verts;
  let best: FaceQuery = { index: -1, sep: -Infinity };
  for (let f = 0; f < P.faces.length; f++) {
    const nx = pl[f * 4];
    const ny = pl[f * 4 + 1];
    const nz = pl[f * 4 + 2];
    let min = Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const d = nx * v[i] + ny * v[i + 1] + nz * v[i + 2];
      if (d < min) min = d;
    }
    const sep = min - pl[f * 4 + 3];
    if (sep > best.sep) best = { index: f, sep };
    if (sep > maxSep) break;
  }
  return best;
}

interface EdgeQuery {
  edgeA: number;
  edgeB: number;
  sep: number;
  axis: Vec3;
}

type Arc = [Vec3, Vec3];

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function planeNormal(P: Polyhedron, f: number): Vec3 {
  return [P.planes[f * 4], P.planes[f * 4 + 1], P.planes[f * 4 + 2]];
}

/** Gauss map arcs of edge e: the arc between its two face normals (two arcs for flat polygons). */
function edgeArcs(P: Polyhedron, e: number, negate: boolean): Arc[] {
  const E = P.edges;
  const f0 = E[e * 4 + 2];
  const f1 = E[e * 4 + 3];
  const s = negate ? -1 : 1;
  const n0 = planeNormal(P, f0).map((x) => x * s) as Vec3;
  if (!P.flat && f1 >= 0) return [[n0, planeNormal(P, f1).map((x) => x * s) as Vec3]];
  // flat polygon: the arc from the front normal to the back normal through the outward edge normal
  const a = E[e * 4] * 3;
  const b = E[e * 4 + 1] * 3;
  const v = P.verts;
  const dir: Vec3 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
  let o = cross(dir, n0);
  const ol = Math.hypot(o[0], o[1], o[2]) || 1;
  o = [o[0] / ol, o[1] / ol, o[2] / ol];
  const mid: Vec3 = [
    (v[a] + v[b]) / 2 - P.centroid[0],
    (v[a + 1] + v[b + 1]) / 2 - P.centroid[1],
    (v[a + 2] + v[b + 2]) / 2 - P.centroid[2],
  ];
  // outward in-plane edge normal (inward when the arcs are negated for the Minkowski difference)
  if (dot(o, mid) * s < 0) o = [-o[0], -o[1], -o[2]];
  const back: Vec3 = [-n0[0], -n0[1], -n0[2]];
  return [
    [n0, o],
    [o, back],
  ];
}

/** Whether the arcs AB and CD intersect on the unit sphere (Gregorius). */
function isMinkowskiFace(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  const bxa = cross(b, a);
  const dxc = cross(d, c);
  const cba = dot(c, bxa);
  const dba = dot(d, bxa);
  const adc = dot(a, dxc);
  const bdc = dot(b, dxc);
  return cba * dba < 0 && adc * bdc < 0 && cba * bdc > 0;
}

function queryEdges(
  A: Polyhedron,
  B: Polyhedron,
  maxSep: number,
  skipEdgeB?: (e: number) => boolean,
): EdgeQuery {
  let best: EdgeQuery = { edgeA: -1, edgeB: -1, sep: -Infinity, axis: [0, 0, 0] };
  const EA = A.edges;
  const EB = B.edges;
  const va = A.verts;
  const vb = B.verts;
  const nA = EA.length / 4;
  const nB = EB.length / 4;
  const arcsB: Arc[][] = [];
  for (let j = 0; j < nB; j++) arcsB.push(skipEdgeB?.(j) ? [] : edgeArcs(B, j, true));
  for (let i = 0; i < nA; i++) {
    const a0 = EA[i * 4] * 3;
    const a1 = EA[i * 4 + 1] * 3;
    const ex = va[a1] - va[a0];
    const ey = va[a1 + 1] - va[a0 + 1];
    const ez = va[a1 + 2] - va[a0 + 2];
    const arcsA = edgeArcs(A, i, false);
    for (let j = 0; j < nB; j++) {
      const bArcs = arcsB[j];
      if (bArcs.length === 0) continue;
      let arcA: Arc | null = null;
      for (const pa of arcsA) {
        for (const pb of bArcs)
          if (isMinkowskiFace(pa[0], pa[1], pb[0], pb[1])) {
            arcA = pa;
            break;
          }
        if (arcA) break;
      }
      if (!arcA) continue;
      const b0 = EB[j * 4] * 3;
      const b1 = EB[j * 4 + 1] * 3;
      const fx = vb[b1] - vb[b0];
      const fy = vb[b1 + 1] - vb[b0 + 1];
      const fz = vb[b1 + 2] - vb[b0 + 2];
      let ax = ey * fz - ez * fy;
      let ay = ez * fx - ex * fz;
      let az = ex * fy - ey * fx;
      const len = Math.hypot(ax, ay, az);
      // parallel edges: the face axes cover this case
      if (len < 1e-6 * Math.hypot(ex, ey, ez) * Math.hypot(fx, fy, fz)) continue;
      ax /= len;
      ay /= len;
      az /= len;
      // the axis lies on A's Gauss arc (outward from A)
      if (ax * (arcA[0][0] + arcA[1][0]) + ay * (arcA[0][1] + arcA[1][1]) + az * (arcA[0][2] + arcA[1][2]) < 0) {
        ax = -ax;
        ay = -ay;
        az = -az;
      }
      const sep = ax * (vb[b0] - va[a0]) + ay * (vb[b0 + 1] - va[a0 + 1]) + az * (vb[b0 + 2] - va[a0 + 2]);
      if (sep > best.sep) {
        best = { edgeA: i, edgeB: j, sep, axis: [ax, ay, az] };
        if (sep > maxSep) return best;
      }
    }
  }
  return best;
}

/** Closest points between segments p1-q1 and p2-q2 (Ericson). */
export function closestSegmentPoints(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
  const d1: Vec3 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]];
  const d2: Vec3 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r: Vec3 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  const EPS = 1e-18;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS * a * e ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return [
    [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s],
    [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t],
  ];
}

function facePoints(P: Polyhedron, f: number): number[] {
  const out: number[] = [];
  for (const k of P.faces[f]) out.push(P.verts[k * 3], P.verts[k * 3 + 1], P.verts[k * 3 + 2]);
  return out;
}

/** The face of P whose normal is most anti-parallel to n. */
function incidentFace(P: Polyhedron, n: Vec3): number {
  let best = 0;
  let bestDot = Infinity;
  for (let f = 0; f < P.faces.length; f++) {
    const d = P.planes[f * 4] * n[0] + P.planes[f * 4 + 1] * n[1] + P.planes[f * 4 + 2] * n[2];
    if (d < bestDot) {
      bestDot = d;
      best = f;
    }
  }
  return best;
}

/**
 * Contacts between convex polyhedra A and B given in a common frame; normals point from A to B.
 * Contacts separated by more than `maxSep` (speculative distance) are not generated.
 * `skipEdgeB` excludes edges of B from the edge axes (inactive mesh edges).
 * Returns false when a separating axis was found.
 */
export function collidePolyhedra(
  A: Polyhedron,
  B: Polyhedron,
  maxSep: number,
  out: ContactCandidate[],
  skipEdgeB?: (e: number) => boolean,
): boolean {
  const fa = queryFaces(A, B, maxSep);
  if (fa.sep > maxSep) return false;
  const fb = queryFaces(B, A, maxSep);
  if (fb.sep > maxSep) return false;
  const eq = queryEdges(A, B, maxSep, skipEdgeB);
  if (eq.sep > maxSep) return false;
  const maxFace = Math.max(fa.sep, fb.sep);
  const contacts: ContactCandidate[] = [];
  const edgeContact = (): boolean => {
    if (eq.edgeA < 0) return false;
    const E = A.edges;
    const F = B.edges;
    const pv = (P: Polyhedron, i: number): Vec3 => [P.verts[i * 3], P.verts[i * 3 + 1], P.verts[i * 3 + 2]];
    const [pa, pb] = closestSegmentPoints(
      pv(A, E[eq.edgeA * 4]),
      pv(A, E[eq.edgeA * 4 + 1]),
      pv(B, F[eq.edgeB * 4]),
      pv(B, F[eq.edgeB * 4 + 1]),
    );
    const s = dot(eq.axis, [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
    if (!(s <= maxSep)) return false;
    contacts.push({ pa, pb, n: eq.axis, s });
    return true;
  };
  // prefer face contacts (stable manifolds) unless an edge axis separates clearly better
  if (eq.edgeA >= 0 && eq.sep > maxFace + 0.05 * Math.abs(maxFace) + 1e-3) {
    if (edgeContact()) {
      out.push(...contacts);
      return true;
    }
  }
  const useB = fb.sep > fa.sep + 0.02 * Math.abs(fa.sep) + 5e-4;
  if (useB) {
    const nB = planeNormal(B, fb.index);
    const inc = incidentFace(A, nB);
    clipFeatures(facePoints(A, inc), facePoints(B, fb.index), [-nB[0], -nB[1], -nB[2]], maxSep, contacts);
  } else {
    const nA = planeNormal(A, fa.index);
    const inc = incidentFace(B, nA);
    clipFeatures(facePoints(A, fa.index), facePoints(B, inc), nA, maxSep, contacts);
  }
  if (contacts.length === 0 && !edgeContact()) return false;
  out.push(...reduceManifold(contacts));
  return true;
}
