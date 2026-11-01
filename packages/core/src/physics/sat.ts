import type { Vec3 } from '../math/types';
import type { Polyhedron } from './shapes';
import { clipFeatures, reduceManifold, type ContactCandidate } from './manifold';
import { len3, type Mat3 } from './vmath';

/*
 * Separating axis test between convex polyhedra (boxes, convex hulls, mesh triangles), after
 * D. Gregorius, "The Separating Axis Test between Convex Polyhedra" (GDC 2013): face normals of
 * both shapes plus edge-edge axes that form faces of the Minkowski difference (Gauss map
 * pruning). Face contacts are clipped into full manifolds; edge contacts give one point. Flat
 * polyhedra (polygons) get Gauss map arcs through the outward edge normals so their edges are
 * handled exactly.
 */

/**
 * Transforms a polyhedron into another frame: p' = R · p + t. Writes into `out` when given
 * (its arrays are reused when large enough), so hot loops do not allocate.
 */
export function transformPolyhedron(
  P: Polyhedron,
  r: Readonly<Mat3>,
  t: Readonly<Vec3>,
  out?: Polyhedron,
): Polyhedron {
  const v = P.verts;
  const verts = out && out.verts.length === v.length ? out.verts : new Float64Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i];
    const y = v[i + 1];
    const z = v[i + 2];
    verts[i] = r[0] * x + r[1] * y + r[2] * z + t[0];
    verts[i + 1] = r[3] * x + r[4] * y + r[5] * z + t[1];
    verts[i + 2] = r[6] * x + r[7] * y + r[8] * z + t[2];
  }
  const pl = P.planes;
  const planes = out && out.planes.length === pl.length ? out.planes : new Float64Array(pl.length);
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
  const cx = r[0] * c[0] + r[1] * c[1] + r[2] * c[2] + t[0];
  const cy = r[3] * c[0] + r[4] * c[1] + r[5] * c[2] + t[1];
  const cz = r[6] * c[0] + r[7] * c[1] + r[8] * c[2] + t[2];
  if (!out)
    return {
      verts,
      faces: P.faces,
      planes,
      edges: P.edges,
      flat: P.flat,
      centroid: [cx, cy, cz],
      graph: P.graph,
    };
  out.verts = verts;
  out.planes = planes;
  out.faces = P.faces;
  out.edges = P.edges;
  out.flat = P.flat;
  out.centroid = [cx, cy, cz];
  out.graph = P.graph;
  return out;
}

interface FaceQuery {
  index: number;
  sep: number;
}

/** Largest separation of Q from the face planes of P. */
function queryFaces(P: Polyhedron, Q: Polyhedron, maxSep: number): FaceQuery {
  const pl = P.planes;
  const v = Q.verts;
  let index = -1;
  let best = -Infinity;
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
    if (sep > best) {
      best = sep;
      index = f;
    }
    if (sep > maxSep) break;
  }
  return { index, sep: best };
}

interface EdgeQuery {
  edgeA: number;
  edgeB: number;
  sep: number;
  axis: Vec3;
}

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function planeNormal(P: Polyhedron, f: number): Vec3 {
  return [P.planes[f * 4], P.planes[f * 4 + 1], P.planes[f * 4 + 2]];
}

/** Floats per edge in an arc buffer: two arcs (start xyz, end xyz); an unused second arc starts with NaN. */
const ARC_STRIDE = 12;
let arcScratchA = new Float64Array(64 * ARC_STRIDE);
let arcScratchB = new Float64Array(64 * ARC_STRIDE);

/**
 * Writes the Gauss map arcs of P's edges into `buf`: the arc between the edge's two face
 * normals, or for flat polygons the two arcs from the front normal through the outward in-plane
 * edge normal to the back normal. `negate` gives the arcs of −P (for the Minkowski difference).
 */
function fillArcs(P: Polyhedron, negate: boolean, buf: Float64Array): void {
  const E = P.edges;
  const pl = P.planes;
  const v = P.verts;
  const s = negate ? -1 : 1;
  const [cx, cy, cz] = P.centroid;
  for (let e = 0, o = 0; e < E.length / 4; e++, o += ARC_STRIDE) {
    const f0 = E[e * 4 + 2] * 4;
    const f1 = E[e * 4 + 3];
    const nx = pl[f0] * s;
    const ny = pl[f0 + 1] * s;
    const nz = pl[f0 + 2] * s;
    buf[o] = nx;
    buf[o + 1] = ny;
    buf[o + 2] = nz;
    if (!P.flat && f1 >= 0) {
      buf[o + 3] = pl[f1 * 4] * s;
      buf[o + 4] = pl[f1 * 4 + 1] * s;
      buf[o + 5] = pl[f1 * 4 + 2] * s;
      buf[o + 6] = NaN;
      continue;
    }
    const a = E[e * 4] * 3;
    const b = E[e * 4 + 1] * 3;
    const dx = v[b] - v[a];
    const dy = v[b + 1] - v[a + 1];
    const dz = v[b + 2] - v[a + 2];
    let ox = dy * nz - dz * ny;
    let oy = dz * nx - dx * nz;
    let oz = dx * ny - dy * nx;
    const ol = len3(ox, oy, oz) || 1;
    // outward in-plane edge normal (inward for −P)
    const side =
      (ox * ((v[a] + v[b]) / 2 - cx) +
        oy * ((v[a + 1] + v[b + 1]) / 2 - cy) +
        oz * ((v[a + 2] + v[b + 2]) / 2 - cz)) *
      s;
    const k = side < 0 ? -1 / ol : 1 / ol;
    ox *= k;
    oy *= k;
    oz *= k;
    buf[o + 3] = ox;
    buf[o + 4] = oy;
    buf[o + 5] = oz;
    buf[o + 6] = ox;
    buf[o + 7] = oy;
    buf[o + 8] = oz;
    buf[o + 9] = -nx;
    buf[o + 10] = -ny;
    buf[o + 11] = -nz;
  }
}

/** Whether the arcs AB (A[i..i+5]) and CD (B[j..j+5]) intersect on the unit sphere (Gregorius). */
function arcsCross(A: Float64Array, i: number, B: Float64Array, j: number): boolean {
  const ax = A[i];
  const ay = A[i + 1];
  const az = A[i + 2];
  const bx = A[i + 3];
  const by = A[i + 4];
  const bz = A[i + 5];
  const cx = B[j];
  const cy = B[j + 1];
  const cz = B[j + 2];
  const dx = B[j + 3];
  const dy = B[j + 4];
  const dz = B[j + 5];
  // b × a and d × c
  const bax = by * az - bz * ay;
  const bay = bz * ax - bx * az;
  const baz = bx * ay - by * ax;
  const dcx = dy * cz - dz * cy;
  const dcy = dz * cx - dx * cz;
  const dcz = dx * cy - dy * cx;
  const cba = cx * bax + cy * bay + cz * baz;
  const dba = dx * bax + dy * bay + dz * baz;
  const adc = ax * dcx + ay * dcy + az * dcz;
  const bdc = bx * dcx + by * dcy + bz * dcz;
  return cba * dba < 0 && adc * bdc < 0 && cba * bdc > 0;
}

function queryEdges(A: Polyhedron, B: Polyhedron, maxSep: number): EdgeQuery {
  let bestSep = -Infinity;
  let bestA = -1;
  let bestB = -1;
  let bx = 0;
  let by = 0;
  let bz = 0;
  const EA = A.edges;
  const EB = B.edges;
  const va = A.verts;
  const vb = B.verts;
  const nA = EA.length / 4;
  const nB = EB.length / 4;
  if (arcScratchA.length < nA * ARC_STRIDE) arcScratchA = new Float64Array(nA * ARC_STRIDE * 2);
  if (arcScratchB.length < nB * ARC_STRIDE) arcScratchB = new Float64Array(nB * ARC_STRIDE * 2);
  const arcsA = arcScratchA;
  const arcsB = arcScratchB;
  fillArcs(A, false, arcsA);
  fillArcs(B, true, arcsB);
  outer: for (let i = 0; i < nA; i++) {
    const a0 = EA[i * 4] * 3;
    const a1 = EA[i * 4 + 1] * 3;
    const ex = va[a1] - va[a0];
    const ey = va[a1 + 1] - va[a0 + 1];
    const ez = va[a1 + 2] - va[a0 + 2];
    const el = len3(ex, ey, ez);
    const oa = i * ARC_STRIDE;
    const twoA = !Number.isNaN(arcsA[oa + 6]);
    for (let j = 0; j < nB; j++) {
      const ob = j * ARC_STRIDE;
      const twoB = !Number.isNaN(arcsB[ob + 6]);
      // which of A's arcs crosses one of B's arcs (−1: none → not a face of the Minkowski difference)
      let arc = -1;
      if (arcsCross(arcsA, oa, arcsB, ob) || (twoB && arcsCross(arcsA, oa, arcsB, ob + 6))) arc = oa;
      else if (
        twoA &&
        (arcsCross(arcsA, oa + 6, arcsB, ob) || (twoB && arcsCross(arcsA, oa + 6, arcsB, ob + 6)))
      )
        arc = oa + 6;
      if (arc < 0) continue;
      const b0 = EB[j * 4] * 3;
      const b1 = EB[j * 4 + 1] * 3;
      const fx = vb[b1] - vb[b0];
      const fy = vb[b1 + 1] - vb[b0 + 1];
      const fz = vb[b1 + 2] - vb[b0 + 2];
      let ax = ey * fz - ez * fy;
      let ay = ez * fx - ex * fz;
      let az = ex * fy - ey * fx;
      const len = len3(ax, ay, az);
      // parallel edges: the face axes cover this case
      if (len < 1e-6 * el * len3(fx, fy, fz)) continue;
      ax /= len;
      ay /= len;
      az /= len;
      // the axis lies on A's Gauss arc (outward from A)
      if (
        ax * (arcsA[arc] + arcsA[arc + 3]) +
          ay * (arcsA[arc + 1] + arcsA[arc + 4]) +
          az * (arcsA[arc + 2] + arcsA[arc + 5]) <
        0
      ) {
        ax = -ax;
        ay = -ay;
        az = -az;
      }
      const sep = ax * (vb[b0] - va[a0]) + ay * (vb[b0 + 1] - va[a0 + 1]) + az * (vb[b0 + 2] - va[a0 + 2]);
      if (sep > bestSep) {
        bestSep = sep;
        bestA = i;
        bestB = j;
        bx = ax;
        by = ay;
        bz = az;
        if (sep > maxSep) break outer;
      }
    }
  }
  return { edgeA: bestA, edgeB: bestB, sep: bestSep, axis: [bx, by, bz] };
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
 * `skipEdgeB` marks edges of B that must not produce edge-edge contacts (internal mesh edges);
 * they still take part in the separation test. Returns false when a separating axis was found.
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
  const eq = queryEdges(A, B, maxSep);
  if (eq.sep > maxSep) return false;
  const maxFace = Math.max(fa.sep, fb.sep);
  const contacts: ContactCandidate[] = [];
  const edgeUsable = eq.edgeA >= 0 && !skipEdgeB?.(eq.edgeB);
  const edgeContact = (): boolean => {
    if (!edgeUsable) return false;
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
    // the segments' closest points must be the touching features (not ends far apart)
    const gap = len3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    if (gap > 1.5 * Math.abs(s) + Math.max(maxSep, 0) + 1e-3) return false;
    contacts.push({ pa, pb, n: eq.axis, s });
    return true;
  };
  // prefer face contacts (stable manifolds) unless an edge axis separates clearly better
  if (edgeUsable && eq.sep > maxFace + 0.05 * Math.abs(maxFace) + 1e-3) {
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
