import type { Vec3 } from '../math/types';
import type { CollisionShape } from '../doc/types';
import type { MeshData } from '../mesh/types';
import { triangulateMesh } from '../mesh/triangulate';
import { convexHull, newellNormal } from './quickhull';
import {
  boundsMass,
  boxMass,
  capsuleMass,
  coneMass,
  cylinderMass,
  polyhedronMass,
  sphereMass,
  type MassProperties,
} from './mass';
import { TriangleBVH } from './bvh';
import type { BoxFrame } from './boxes';
import type { Mat3 } from './vmath';

/*
 * Collision shapes in body space (origin at the centre of mass, axes = object axes, object scale
 * applied). Dimensions follow Blender's rigid body rules: primitive shapes are fitted to the
 * object's bounding box (radius = largest X/Y half extent, height along local Z), CONVEX_HULL uses
 * the hull of the mesh vertices and MESH the triangles themselves. Unlike Blender the primitive
 * shapes are centred on the bounding box and bodies rotate about their true centre of mass,
 * which is identical for meshes whose origin is at their centre.
 */

/**
 * Largest minimal half thickness of convex collision geometry (see `minHalfExtent`): flat meshes
 * of a metre and more become 1 cm slabs.
 */
export const MIN_HALF_EXTENT = 5e-3;
/** Minimal half thickness relative to the largest half extent of a body (see `minHalfExtent`). */
export const THIN_RATIO = 2e-3;
/** Smallest minimal half thickness (m), for tiny bodies (see `minHalfExtent`). */
export const MIN_HALF_EXTENT_FLOOR = 1e-5;

/**
 * Smallest half thickness of convex collision geometry for a body whose largest half extent is
 * `maxHalf`: THIN_RATIO of it, between MIN_HALF_EXTENT_FLOOR and MIN_HALF_EXTENT. Flat or
 * degenerate meshes (a plane, a line) become slabs / rods this thick; like Bullet's collision
 * margin this keeps them from crossing (two-sided) triangle meshes, where a body without
 * thickness could not tell which side it came from. Real bodies keep their thickness down to
 * this limit (a 7.5 mm domino, a coin, a 0.3 mm playing card); thinner ones are thickened to it,
 * with a note.
 */
export function minHalfExtent(maxHalf: number): number {
  const m = Number.isFinite(maxHalf) ? THIN_RATIO * maxHalf : MIN_HALF_EXTENT;
  return Math.min(MIN_HALF_EXTENT, Math.max(MIN_HALF_EXTENT_FLOOR, m));
}

/** Millimetres for notes: two significant digits below 1 mm. */
function mm(m: number): string {
  const v = m * 1000;
  return `${v >= 1 ? +v.toFixed(1) : +v.toPrecision(2)} mm`;
}
/** Polyhedra with more vertices answer support queries by hill climbing (see `polySupport`). */
export const HILL_CLIMB_VERTICES = 32;
/** Vertex count of the polygon approximating cylinder / cone caps in contact manifolds. */
const CAP_SEGMENTS = 12;
/** `supportingFace` scans all faces of polyhedra with up to this many faces (exact). */
const LINEAR_FACE_SCAN = 512;

/** Convex polyhedron with face planes and edge adjacency (for SAT). */
export interface Polyhedron {
  /** Vertices, flat xyz. */
  verts: Float64Array;
  /** Polygons, counter-clockwise seen from outside. */
  faces: number[][];
  /** Face planes: nx, ny, nz, d (n · p = d) per face. */
  planes: Float64Array;
  /** Unique edges: v0, v1, face on the left of v0→v1, face on the right (-1 if none). */
  edges: Int32Array;
  /** Flat polygon (two opposite faces). */
  flat: boolean;
  /** Mean of the vertices (inside the polyhedron). */
  centroid: Vec3;
  /** Vertex graph of large polyhedra (more than HILL_CLIMB_VERTICES vertices), else absent. */
  graph?: VertexGraph;
}

/**
 * Neighbourhoods of a polyhedron's vertices (CSR lists). The neighbours of vertex i,
 * `adj[adjStart[i] … adjStart[i + 1])`, follow the edges of a triangulation of the faces, so the
 * edges at every vertex span its tangent cone: a vertex no neighbour of which is further along a
 * direction is the furthest of all (hill climbing finds support points exactly).
 */
export interface VertexGraph {
  adjStart: Int32Array;
  adj: Int32Array;
  /** Faces around vertex i: `faces[faceStart[i] … faceStart[i + 1])`. */
  faceStart: Int32Array;
  faces: Int32Array;
  /** Faces sharing an edge with face f: `faceAdj[faceAdjStart[f] … faceAdjStart[f + 1])`. */
  faceAdjStart: Int32Array;
  faceAdj: Int32Array;
  /** Start candidates for hill climbing: the extreme vertices along 26 fixed directions. */
  seeds: Int32Array;
}

/** Static triangle mesh (MESH collision shape). */
export interface TriMesh {
  verts: Float64Array;
  /** Vertex index triples. */
  tris: Int32Array;
  /** Unit normal per triangle. */
  normals: Float64Array;
  /** Bit i set when edge i (v[i] → v[i+1]) is a boundary or convex crease ("active" edge). */
  activeEdges: Uint8Array;
  bvh: TriangleBVH;
}

export type Shape =
  | { kind: 'sphere'; center: Vec3; radius: number }
  /** Capsule along local Z: segment center ± halfHeight, radius around it. */
  | { kind: 'capsule'; center: Vec3; radius: number; halfHeight: number }
  /** Cylinder along local Z. */
  | { kind: 'cylinder'; center: Vec3; radius: number; halfHeight: number }
  /** Cone along local Z: base circle at `center`, apex at center + (0, 0, height). */
  | { kind: 'cone'; center: Vec3; radius: number; height: number }
  /** Convex polyhedron; `box` is set when it is a cuboid (closed-form box tests apply). */
  | { kind: 'poly'; poly: Polyhedron; box?: BoxFrame }
  | { kind: 'mesh'; mesh: TriMesh };

export type ShapeKind = Shape['kind'];

export interface ShapeBuild {
  shape: Shape;
  /** The collision shape type actually used (after fallbacks). */
  type: CollisionShape;
  /** Centre of mass (= body origin) in scaled object coordinates. */
  com: Vec3;
  /** Inertia about the centre of mass for 1 kg, body axes. */
  inertia: Mat3;
  volume: number;
  /** Non-fatal notes (fallbacks, thickened thin meshes), for diagnostics. */
  notes: string[];
  /**
   * Set when the mesh is thinner than the minimum collision thickness (`minHalfExtent`) and the
   * convex shape was thickened: the mesh's thickness and the simulated one (m).
   */
  thickened?: { mesh: number; collision: number };
}

// ---------------------------------------------------------------- polyhedra

/** Builds a polyhedron (planes + edge adjacency) from polygons over flat xyz vertices. */
export function makePolyhedron(verts: ArrayLike<number>, faces: number[][], flat = false): Polyhedron {
  const v = Float64Array.from(verts);
  const n = v.length / 3;
  const planes = new Float64Array(faces.length * 4);
  faces.forEach((f, i) => {
    const nrm = newellNormal(v, f);
    let d = 0;
    for (const k of f) d += nrm[0] * v[k * 3] + nrm[1] * v[k * 3 + 1] + nrm[2] * v[k * 3 + 2];
    planes.set([nrm[0], nrm[1], nrm[2], d / f.length], i * 4);
  });
  // directed edge a → b keyed a·n + b (exact in doubles for any realistic vertex count)
  const left = new Map<number, number>();
  faces.forEach((f, fi) => f.forEach((a, k) => left.set(a * n + f[(k + 1) % f.length], fi)));
  const edges: number[] = [];
  const done = new Set<number>();
  faces.forEach((f, fi) =>
    f.forEach((a, k) => {
      const b = f[(k + 1) % f.length];
      const key = a < b ? a * n + b : b * n + a;
      if (done.has(key)) return;
      done.add(key);
      edges.push(a, b, fi, left.get(b * n + a) ?? -1);
    }),
  );
  const centroid: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) centroid[a] += v[i * 3 + a] / n;
  const poly: Polyhedron = { verts: v, faces, planes, edges: Int32Array.from(edges), flat, centroid };
  if (n > HILL_CLIMB_VERTICES) poly.graph = vertexGraph(v, faces, poly.edges);
  return poly;
}

/** Vertex graph of a polyhedron: triangulated face edges, incident and adjacent faces, seeds. */
function vertexGraph(v: Float64Array, faces: number[][], edges: Int32Array): VertexGraph {
  const n = v.length / 3;
  const nbrs: number[][] = Array.from({ length: n }, () => []);
  const around: number[][] = Array.from({ length: n }, () => []);
  const across: number[][] = Array.from({ length: faces.length }, () => []);
  for (let e = 0; e < edges.length; e += 4)
    if (edges[e + 3] >= 0) {
      across[edges[e + 2]].push(edges[e + 3]);
      across[edges[e + 3]].push(edges[e + 2]);
    }
  const link = (a: number, b: number) => {
    nbrs[a].push(b);
    nbrs[b].push(a);
  };
  // diagonals of a triangulation of the convex polygon f[lo … hi] (chord lo–hi present) by
  // recursive halving: vertex degrees stay O(log n), so climbs over large faces stay short
  const diagonals = (f: number[], lo: number, hi: number) => {
    const stack = [lo, hi];
    while (stack.length) {
      const b = stack.pop()!;
      const a = stack.pop()!;
      if (b - a < 2) continue;
      const mid = (a + b) >> 1;
      if (mid - a > 1) link(f[a], f[mid]);
      if (b - mid > 1) link(f[mid], f[b]);
      stack.push(a, mid, mid, b);
    }
  };
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      link(f[k], f[(k + 1) % f.length]);
      around[f[k]].push(fi);
    }
    diagonals(f, 0, f.length - 1);
  });
  const flatten = (lists: number[][]) => {
    const start = new Int32Array(lists.length + 1);
    const out: number[] = [];
    for (let i = 0; i < lists.length; i++) {
      const sorted = lists[i].sort((a, b) => a - b);
      sorted.forEach((x, k) => {
        if (k === 0 || x !== sorted[k - 1]) out.push(x);
      });
      start[i + 1] = out.length;
    }
    return { start, list: Int32Array.from(out) };
  };
  const adj = flatten(nbrs);
  const inc = flatten(around);
  const faceAdj = flatten(across);
  const seeds: number[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        let best = 0;
        let bestDot = -Infinity;
        for (let i = 0; i < n; i++) {
          const d = v[i * 3] * x + v[i * 3 + 1] * y + v[i * 3 + 2] * z;
          if (d > bestDot) {
            bestDot = d;
            best = i;
          }
        }
        if (!seeds.includes(best)) seeds.push(best);
      }
  return {
    adjStart: adj.start,
    adj: adj.list,
    faceStart: inc.start,
    faces: inc.list,
    faceAdjStart: faceAdj.start,
    faceAdj: faceAdj.list,
    seeds: Int32Array.from(seeds),
  };
}

/**
 * Index of a vertex of P with the largest projection on d: steepest-ascent hill climbing over
 * the vertex graph from the best seed for large polyhedra (exact, see `VertexGraph`), a linear
 * scan for small ones.
 */
export function polySupport(P: Polyhedron, dx: number, dy: number, dz: number): number {
  const v = P.verts;
  const g = P.graph;
  if (!g) {
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const d = v[i] * dx + v[i + 1] * dy + v[i + 2] * dz;
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    return best / 3;
  }
  const { adjStart, adj, seeds } = g;
  let best = seeds[0];
  let bestDot = v[best * 3] * dx + v[best * 3 + 1] * dy + v[best * 3 + 2] * dz;
  for (let s = 1; s < seeds.length; s++) {
    const i = seeds[s];
    const d = v[i * 3] * dx + v[i * 3 + 1] * dy + v[i * 3 + 2] * dz;
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  // every move strictly increases the projection, so this terminates
  for (;;) {
    let next = -1;
    for (let k = adjStart[best], e = adjStart[best + 1]; k < e; k++) {
      const j = adj[k];
      const d = v[j * 3] * dx + v[j * 3 + 1] * dy + v[j * 3 + 2] * dz;
      if (d > bestDot) {
        bestDot = d;
        next = j;
      }
    }
    if (next < 0) return best;
    best = next;
  }
}

const BOX_FACES = [
  [1, 3, 7, 5],
  [0, 4, 6, 2],
  [2, 6, 7, 3],
  [0, 1, 5, 4],
  [4, 5, 7, 6],
  [0, 2, 3, 1],
];

/** Box frame of an axis-aligned box centred at the body origin. */
export function alignedBox(h: Readonly<Vec3>): BoxFrame {
  return { center: [0, 0, 0], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [h[0], h[1], h[2]], aligned: true };
}

/**
 * The oriented box a polyhedron is when it is a cuboid (six quads in three orthogonal pairs of
 * opposite faces, eight corners), e.g. the convex hull of a cube mesh; null otherwise.
 */
export function cuboidFrame(p: Polyhedron): BoxFrame | null {
  if (p.flat || p.faces.length !== 6 || p.verts.length !== 24 || p.faces.some((f) => f.length !== 4))
    return null;
  const pl = p.planes;
  const n = (f: number): Vec3 => [pl[f * 4], pl[f * 4 + 1], pl[f * 4 + 2]];
  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const axes: Vec3[] = [];
  const half: number[] = [];
  const mid: number[] = [];
  const used = new Set<number>();
  for (let f = 0; f < 6; f++) {
    if (used.has(f)) continue;
    let opp = -1;
    for (let g = f + 1; g < 6 && opp < 0; g++) if (!used.has(g) && dot3(n(f), n(g)) < -1 + 1e-9) opp = g;
    if (opp < 0) return null;
    used.add(f);
    used.add(opp);
    // n·x ranges over [−d_opp, d_f] inside the box
    axes.push(n(f));
    half.push((pl[f * 4 + 3] + pl[opp * 4 + 3]) / 2);
    mid.push((pl[f * 4 + 3] - pl[opp * 4 + 3]) / 2);
  }
  if (axes.length !== 3 || half.some((h) => !(h > 0))) return null;
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++) if (Math.abs(dot3(axes[a], axes[b])) > 1e-9) return null;
  // canonical axes: positive dominant component, ordered by it (identity for axis-aligned boxes)
  const dominant = (v: Vec3) =>
    Math.abs(v[0]) >= Math.abs(v[1]) && Math.abs(v[0]) >= Math.abs(v[2])
      ? 0
      : Math.abs(v[1]) >= Math.abs(v[2])
        ? 1
        : 2;
  for (let a = 0; a < 3; a++)
    if (axes[a][dominant(axes[a])] < 0) {
      axes[a] = [-axes[a][0], -axes[a][1], -axes[a][2]];
      mid[a] = -mid[a];
    }
  const order = [0, 1, 2].sort((a, b) => dominant(axes[a]) - dominant(axes[b]));
  if (new Set(order.map((a) => dominant(axes[a]))).size === 3) {
    const [ax, hf, md] = [order.map((a) => axes[a]), order.map((a) => half[a]), order.map((a) => mid[a])];
    axes.splice(0, 3, ...ax);
    half.splice(0, 3, ...hf);
    mid.splice(0, 3, ...md);
  }
  const [x, y, z] = axes;
  const det =
    x[0] * (y[1] * z[2] - y[2] * z[1]) -
    x[1] * (y[0] * z[2] - y[2] * z[0]) +
    x[2] * (y[0] * z[1] - y[1] * z[0]);
  if (det < 0) {
    axes[2] = [-z[0], -z[1], -z[2]];
    mid[2] = -mid[2];
  }
  const center: Vec3 = [0, 1, 2].map(
    (k) => axes[0][k] * mid[0] + axes[1][k] * mid[1] + axes[2][k] * mid[2],
  ) as Vec3;
  // every corner must sit at ±half along the axes
  const size = Math.max(...half);
  for (let i = 0; i < 24; i += 3) {
    const v: Vec3 = [p.verts[i] - center[0], p.verts[i + 1] - center[1], p.verts[i + 2] - center[2]];
    for (let a = 0; a < 3; a++) if (Math.abs(Math.abs(dot3(v, axes[a])) - half[a]) > 1e-7 * size) return null;
  }
  const m: Mat3 = [
    axes[0][0],
    axes[1][0],
    axes[2][0],
    axes[0][1],
    axes[1][1],
    axes[2][1],
    axes[0][2],
    axes[1][2],
    axes[2][2],
  ];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const aligned =
    m.every((v, i) => Math.abs(v - identity[i]) < 1e-12) && center.every((c) => Math.abs(c) < 1e-12 * size);
  return { center, axes: m, half: [half[0], half[1], half[2]], aligned };
}

/** Axis-aligned box polyhedron with half extents h around `c`. */
export function boxPolyhedron(h: Readonly<Vec3>, c: Readonly<Vec3> = [0, 0, 0]): Polyhedron {
  const verts: number[] = [];
  for (let i = 0; i < 8; i++)
    verts.push(c[0] + (i & 1 ? h[0] : -h[0]), c[1] + (i & 2 ? h[1] : -h[1]), c[2] + (i & 4 ? h[2] : -h[2]));
  return makePolyhedron(verts, BOX_FACES);
}

// ---------------------------------------------------------------- support mapping

/** Radius of the rounded "core" of a shape (spheres and capsules are a point / segment plus radius). */
export function coreRadius(s: Shape): number {
  return s.kind === 'sphere' || s.kind === 'capsule' ? s.radius : 0;
}

/**
 * Support point of the shape's core in direction d (body space): the core point with the largest
 * projection on d. Writes into `out` (length ≥ 3) at offset `o`.
 */
export function supportCore(
  s: Shape,
  dx: number,
  dy: number,
  dz: number,
  out: number[] | Float64Array,
  o = 0,
): void {
  switch (s.kind) {
    case 'sphere':
      out[o] = s.center[0];
      out[o + 1] = s.center[1];
      out[o + 2] = s.center[2];
      return;
    case 'capsule':
      out[o] = s.center[0];
      out[o + 1] = s.center[1];
      out[o + 2] = s.center[2] + (dz >= 0 ? s.halfHeight : -s.halfHeight);
      return;
    case 'cylinder': {
      const l = Math.hypot(dx, dy);
      const k = l > 1e-12 ? s.radius / l : 0;
      out[o] = s.center[0] + dx * k;
      out[o + 1] = s.center[1] + dy * k;
      out[o + 2] = s.center[2] + (dz >= 0 ? s.halfHeight : -s.halfHeight);
      return;
    }
    case 'cone': {
      const l = Math.hypot(dx, dy);
      const k = l > 1e-12 ? s.radius / l : 0;
      // apex vs. the base rim point furthest along d
      const apex = dz * s.height;
      const rim = l * s.radius;
      if (apex >= rim) {
        out[o] = s.center[0];
        out[o + 1] = s.center[1];
        out[o + 2] = s.center[2] + s.height;
      } else {
        out[o] = s.center[0] + dx * k;
        out[o + 1] = s.center[1] + dy * k;
        out[o + 2] = s.center[2];
      }
      return;
    }
    case 'poly': {
      const v = s.poly.verts;
      const best = polySupport(s.poly, dx, dy, dz) * 3;
      out[o] = v[best];
      out[o + 1] = v[best + 1];
      out[o + 2] = v[best + 2];
      return;
    }
    case 'mesh':
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      return;
  }
}

/**
 * The face of the shape's core that is most aligned with direction d (body space, need not be
 * normalised), used to build multi-point contact manifolds: a polygon (counter-clockwise seen
 * from d), a segment (2 points) or a single point. Returns flat xyz points.
 */
export function supportingFace(s: Shape, dx: number, dy: number, dz: number): number[] {
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  switch (s.kind) {
    case 'sphere':
      return [...s.center];
    case 'capsule': {
      const [cx, cy, cz] = s.center;
      if (Math.abs(uz) < 0.5) return [cx, cy, cz + s.halfHeight, cx, cy, cz - s.halfHeight];
      return [cx, cy, cz + (uz >= 0 ? s.halfHeight : -s.halfHeight)];
    }
    case 'cylinder': {
      const [cx, cy, cz] = s.center;
      if (Math.abs(uz) > 0.7)
        return capPolygon(cx, cy, cz + (uz > 0 ? s.halfHeight : -s.halfHeight), s.radius, uz > 0);
      const l = Math.hypot(ux, uy) || 1;
      const rx = cx + (ux / l) * s.radius;
      const ry = cy + (uy / l) * s.radius;
      return [rx, ry, cz + s.halfHeight, rx, ry, cz - s.halfHeight];
    }
    case 'cone': {
      const [cx, cy, cz] = s.center;
      if (uz < -0.7) return capPolygon(cx, cy, cz, s.radius, false);
      const l = Math.hypot(ux, uy);
      if (l < 1e-6) return [cx, cy, cz + s.height];
      const rx = cx + (ux / l) * s.radius;
      const ry = cy + (uy / l) * s.radius;
      return [cx, cy, cz + s.height, rx, ry, cz];
    }
    case 'poly': {
      const p = s.poly;
      let best = 0;
      let bestDot = -Infinity;
      const consider = (f: number) => {
        const d = p.planes[f * 4] * ux + p.planes[f * 4 + 1] * uy + p.planes[f * 4 + 2] * uz;
        if (d > bestDot) {
          bestDot = d;
          best = f;
        }
      };
      const g = p.graph;
      if (g && p.faces.length > LINEAR_FACE_SCAN) {
        // many faces: start from the faces around the support vertex (d lies in its normal
        // cone), then move across edges while a neighbouring face is better aligned
        const vi = polySupport(p, ux, uy, uz);
        for (let k = g.faceStart[vi]; k < g.faceStart[vi + 1]; k++) consider(g.faces[k]);
        for (let cur = -1; cur !== best;) {
          cur = best;
          for (let k = g.faceAdjStart[cur]; k < g.faceAdjStart[cur + 1]; k++) consider(g.faceAdj[k]);
        }
      } else for (let f = 0; f < p.faces.length; f++) consider(f);
      const out: number[] = [];
      for (const k of p.faces[best]) out.push(p.verts[k * 3], p.verts[k * 3 + 1], p.verts[k * 3 + 2]);
      return out;
    }
    case 'mesh':
      return [];
  }
}

/** Regular polygon approximating a cap circle (counter-clockwise seen from +Z when `up`). */
function capPolygon(cx: number, cy: number, z: number, r: number, up: boolean): number[] {
  const out: number[] = [];
  for (let k = 0; k < CAP_SEGMENTS; k++) {
    const i = up ? k : CAP_SEGMENTS - 1 - k;
    const a = (2 * Math.PI * i) / CAP_SEGMENTS;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
  }
  return out;
}

/** Local (body space) bounds of a shape including its radius. */
export function shapeBounds(s: Shape): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number, r = 0) => {
    min[0] = Math.min(min[0], x - r);
    min[1] = Math.min(min[1], y - r);
    min[2] = Math.min(min[2], z - r);
    max[0] = Math.max(max[0], x + r);
    max[1] = Math.max(max[1], y + r);
    max[2] = Math.max(max[2], z + r);
  };
  switch (s.kind) {
    case 'sphere':
      grow(s.center[0], s.center[1], s.center[2], s.radius);
      break;
    case 'capsule':
      grow(s.center[0], s.center[1], s.center[2] + s.halfHeight, s.radius);
      grow(s.center[0], s.center[1], s.center[2] - s.halfHeight, s.radius);
      break;
    case 'cylinder':
      grow(s.center[0] - s.radius, s.center[1] - s.radius, s.center[2] - s.halfHeight);
      grow(s.center[0] + s.radius, s.center[1] + s.radius, s.center[2] + s.halfHeight);
      break;
    case 'cone':
      grow(s.center[0] - s.radius, s.center[1] - s.radius, s.center[2]);
      grow(s.center[0] + s.radius, s.center[1] + s.radius, s.center[2] + s.height);
      break;
    case 'poly': {
      const v = s.poly.verts;
      for (let i = 0; i < v.length; i += 3) grow(v[i], v[i + 1], v[i + 2]);
      break;
    }
    case 'mesh': {
      const v = s.mesh.verts;
      for (let i = 0; i < v.length; i += 3) grow(v[i], v[i + 1], v[i + 2]);
      break;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/**
 * Half the thickness of a convex shape in its thinnest direction (for polyhedra, along the face
 * normal with the smallest width); Infinity for triangle meshes, which have no inside. The solver
 * scales its penetration tolerances with it, so thin bodies cannot sink through each other.
 */
export function thinHalfExtent(s: Shape): number {
  switch (s.kind) {
    case 'sphere':
    case 'capsule':
      return s.radius;
    case 'cylinder':
      return Math.min(s.radius, s.halfHeight);
    case 'cone':
      return Math.min(s.radius, s.height / 2);
    case 'poly': {
      const { verts, planes } = s.poly;
      let best = Infinity;
      for (let f = 0; f < planes.length; f += 4) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < verts.length; i += 3) {
          const d = planes[f] * verts[i] + planes[f + 1] * verts[i + 1] + planes[f + 2] * verts[i + 2];
          if (d < lo) lo = d;
          if (d > hi) hi = d;
        }
        best = Math.min(best, (hi - lo) / 2);
      }
      return best;
    }
    case 'mesh':
      return Infinity;
  }
}

/** Radius of the smallest origin-centred sphere containing the shape. */
export function boundingRadius(s: Shape): number {
  const { min, max } = shapeBounds(s);
  let r = 0;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? max[0] : min[0];
    const y = i & 2 ? max[1] : min[1];
    const z = i & 4 ? max[2] : min[2];
    r = Math.max(r, Math.hypot(x, y, z));
  }
  return r;
}

// ---------------------------------------------------------------- construction from meshes

/** Mesh vertex positions multiplied by the object scale (non-finite vertices dropped). */
function scaledPositions(mesh: MeshData, scale: Readonly<Vec3>): { pts: number[]; valid: Int32Array } {
  const src = Array.isArray(mesh.positions) ? mesh.positions : [];
  const n = Math.floor(src.length / 3);
  const pts: number[] = [];
  const valid = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = src[i * 3] * scale[0];
    const y = src[i * 3 + 1] * scale[1];
    const z = src[i * 3 + 2] * scale[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    valid[i] = pts.length / 3;
    pts.push(x, y, z);
  }
  return { pts, valid };
}

function bounds(pts: number[]): { center: Vec3; half: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], pts[i + a]);
      hi[a] = Math.max(hi[a], pts[i + a]);
    }
  return {
    center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    half: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2],
  };
}

function result(
  shape: Shape,
  type: CollisionShape,
  mp: MassProperties,
  com: Vec3,
  notes: string[],
): ShapeBuild {
  return { shape, type, com, inertia: mp.inertia, volume: mp.volume, notes };
}

/**
 * Direction the faces of a mesh look to (unit, scaled object space), from their area-weighted
 * normal (half the sum of their Newell vectors): the front of an open mesh such as a plane, null
 * when the faces do not agree on one side (closed meshes, double-sided planes, no faces).
 */
function frontDirection(mesh: MeshData, pts: number[], valid: Int32Array, size: number): Vec3 | null {
  const n = areaNormal(mesh, pts, valid);
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 1e-6 * size * size ? [n[0] / l, n[1] / l, n[2] / l] : null;
}

function areaNormal(mesh: MeshData, pts: number[], valid: Int32Array): Vec3 {
  const out: Vec3 = [0, 0, 0];
  const faces = Array.isArray(mesh.faces) ? mesh.faces : [];
  for (const f of faces) {
    if (!Array.isArray(f) || f.length < 3) continue;
    const idx: number[] = [];
    for (const v of f) {
      const k = Number.isInteger(v) && v >= 0 && v < valid.length ? valid[v] : -1;
      if (k < 0) break;
      idx.push(k * 3);
    }
    if (idx.length !== f.length) continue;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i];
      const b = idx[(i + 1) % idx.length];
      out[0] += ((pts[a + 1] - pts[b + 1]) * (pts[a + 2] + pts[b + 2])) / 2;
      out[1] += ((pts[a + 2] - pts[b + 2]) * (pts[a] + pts[b])) / 2;
      out[2] += ((pts[a] - pts[b]) * (pts[a + 1] + pts[b + 1])) / 2;
    }
  }
  return out;
}

/**
 * Shapes built from equal inputs (`shapeKey`: mesh content, shape type, dynamic, scale), shared by
 * every simulation and every rigidbody operator call, most recently used last. A convex hull of a
 * high-poly mesh takes a while, so scenes with many unique meshes no longer rebuild every hull on
 * every call. Bounded by entries and by the input vertex coordinates the shapes were built from.
 */
const shapeCache = new Map<string, { built: ShapeBuild | { error: string }; weight: number }>();
let shapeCacheWeight = 0;
const SHAPE_CACHE_ENTRIES = 1024;
const SHAPE_CACHE_WEIGHT = 8_000_000;

/** The collision shape for `key` from the shared cache, built (and cached) when missing. */
export function cachedCollisionShape(
  key: string,
  mesh: MeshData,
  build: () => ShapeBuild | { error: string },
): ShapeBuild | { error: string } {
  const hit = shapeCache.get(key);
  if (hit) {
    shapeCache.delete(key);
    shapeCache.set(key, hit);
    return hit.built;
  }
  const built = build();
  const weight =
    Array.isArray(mesh.positions) || ArrayBuffer.isView(mesh.positions) ? mesh.positions.length : 0;
  if (weight <= SHAPE_CACHE_WEIGHT / 4) {
    shapeCache.set(key, { built, weight });
    shapeCacheWeight += weight;
    for (const [k, v] of shapeCache) {
      if (shapeCache.size <= SHAPE_CACHE_ENTRIES && shapeCacheWeight <= SHAPE_CACHE_WEIGHT) break;
      shapeCache.delete(k);
      shapeCacheWeight -= v.weight;
    }
  }
  return built;
}

/** Number of collision shapes in the shared cache (tests). */
export function collisionShapeCacheSize(): number {
  return shapeCache.size;
}

/** Drops every shared collision shape (rigidbody.cache_free starts from scratch). */
export function clearCollisionShapeCache(): void {
  shapeCache.clear();
  shapeCacheWeight = 0;
}

/**
 * Builds the collision shape of an object from its mesh (object space) and world scale.
 * `dynamic` bodies cannot use triangle meshes (Blender's MESH shape is unstable for active
 * bodies): they fall back to the convex hull. Convex shapes are at least `minHalfExtent` thick:
 * an open flat mesh (a plane) becomes a slab behind its faces, so its visible surface is where
 * things collide; a thinner closed mesh is thickened around its centre (both with a note).
 * Returns an error string for unusable meshes.
 */
export function buildCollisionShape(
  type: CollisionShape,
  mesh: MeshData,
  scale: Readonly<Vec3>,
  opts: { dynamic: boolean },
): ShapeBuild | { error: string } {
  const notes: string[] = [];
  const { pts, valid } = scaledPositions(mesh, scale);
  if (pts.length === 0) return { error: 'mesh has no (finite) vertices' };
  const { center, half } = bounds(pts);
  const size = Math.max(half[0], half[1], half[2]);
  const minHalf = minHalfExtent(size);
  const h: Vec3 = half.map((v) => Math.max(v, minHalf)) as Vec3;
  let thickened: ShapeBuild['thickened'];
  if (type === 'BOX' || type === 'CYLINDER' || type === 'CONE') {
    // bounds-fitted shapes: thin axes are thickened; a flat open mesh extends behind its faces
    const thin = [0, 1, 2].filter((a) => half[a] < minHalf && (type === 'BOX' || a === 2));
    if (thin.length) {
      const front = frontDirection(mesh, pts, valid, size);
      for (const a of thin) {
        const flat = half[a] <= 1e-9 * size;
        if (flat && front && Math.abs(front[a]) > 0.9) {
          center[a] -= Math.sign(front[a]) * (h[a] - half[a]);
          // only the back side changes; for a static floor or wall that is not worth a note
          if (opts.dynamic) notes.push(slabNote(minHalf, true));
        } else notes.push(flat ? slabNote(minHalf, false) : thinNote(half[a], minHalf, 'XYZ'[a]));
        thickened = { mesh: 2 * half[a], collision: 2 * h[a] };
      }
    }
  }
  const out = buildShape(type, mesh, pts, valid, scale, opts, center, h, minHalf, notes, size);
  if (thickened && !('error' in out)) out.thickened ??= thickened;
  return out;
}

/**
 * How the minimum collision thickness 2 · minHalf came about (see `minHalfExtent`): THIN_RATIO of the
 * body's largest dimension, or the cap / floor of that rule.
 */
function minThicknessRule(minHalf: number): string {
  const pct = `${+(THIN_RATIO * 100).toFixed(3)}% of its largest dimension`;
  if (minHalf >= MIN_HALF_EXTENT) return `${pct}, at most ${mm(2 * MIN_HALF_EXTENT)}`;
  if (minHalf <= MIN_HALF_EXTENT_FLOOR) return `${pct}, at least ${mm(2 * MIN_HALF_EXTENT_FLOOR)}`;
  return pct;
}

/** Note for a flat mesh simulated as a slab (behind its faces, or centred on it). */
function slabNote(minHalf: number, behind: boolean): string {
  return (
    `flat mesh: simulated as a ${mm(2 * minHalf)} thick slab ${behind ? 'behind its faces' : 'centred on it'} ` +
    `(minimum collision thickness: ${minThicknessRule(minHalf)})`
  );
}

/** Note for a closed mesh thinner than the minimum collision thickness. */
function thinNote(half: number, minHalf: number, axis?: string): string {
  return (
    `the mesh is only ${mm(2 * half)} thick${axis ? ` (${axis})` : ''}, below the minimum collision ` +
    `thickness of ${mm(2 * minHalf)} (${minThicknessRule(minHalf)}): it collides as if ` +
    `${mm(2 * minHalf)} thick`
  );
}

function buildShape(
  type: CollisionShape,
  mesh: MeshData,
  pts: number[],
  valid: Int32Array,
  scale: Readonly<Vec3>,
  opts: { dynamic: boolean },
  center: Vec3,
  h: Vec3,
  minHalf: number,
  notes: string[],
  size: number,
): ShapeBuild | { error: string } {
  switch (type) {
    case 'BOX':
      return result(
        { kind: 'poly', poly: boxPolyhedron(h), box: alignedBox(h) },
        type,
        boxMass(h, center),
        center,
        notes,
      );
    case 'SPHERE': {
      const r = Math.max(h[0], h[1], h[2]);
      return result(
        { kind: 'sphere', center: [0, 0, 0], radius: r },
        type,
        sphereMass(r, center),
        center,
        notes,
      );
    }
    case 'CAPSULE': {
      const r = Math.max(h[0], h[1]);
      const hh = Math.max(h[2] - r, 0);
      return result(
        { kind: 'capsule', center: [0, 0, 0], radius: r, halfHeight: hh },
        type,
        capsuleMass(r, hh, center),
        center,
        notes,
      );
    }
    case 'CYLINDER': {
      const r = Math.max(h[0], h[1]);
      return result(
        { kind: 'cylinder', center: [0, 0, 0], radius: r, halfHeight: h[2] },
        type,
        cylinderMass(r, h[2], center),
        center,
        notes,
      );
    }
    case 'CONE': {
      const r = Math.max(h[0], h[1]);
      const height = 2 * h[2];
      // centre of mass a quarter of the height above the base
      const com: Vec3 = [center[0], center[1], center[2] - h[2] / 2];
      return result(
        { kind: 'cone', center: [0, 0, -height / 4], radius: r, height },
        type,
        coneMass(r, height, com),
        com,
        notes,
      );
    }
    case 'MESH': {
      if (!opts.dynamic) {
        const tm = buildTriMesh(mesh, pts, valid, scale);
        if (tm) {
          const mp = boundsMass(pts, 2 * MIN_HALF_EXTENT);
          return {
            shape: { kind: 'mesh', mesh: tm },
            type: 'MESH',
            com: [0, 0, 0],
            inertia: mp.inertia,
            volume: 0,
            notes,
          };
        }
        notes.push('mesh has no faces, using its convex hull');
      } else notes.push('active rigid bodies cannot use the MESH shape, using CONVEX_HULL');
      return hullShape(pts, notes, minHalf, () => frontDirection(mesh, pts, valid, size), opts.dynamic);
    }
    case 'CONVEX_HULL':
    default:
      return hullShape(pts, notes, minHalf, () => frontDirection(mesh, pts, valid, size), opts.dynamic);
  }
}

/** Half the width of a convex polytope along its thinnest face normal, and that normal. */
function thinnestWidth(points: readonly number[], normals: readonly Vec3[]): { half: number; normal: Vec3 } {
  let half = Infinity;
  let normal: Vec3 = [0, 0, 1];
  for (const n of normals) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      const d = n[0] * points[i] + n[1] * points[i + 1] + n[2] * points[i + 2];
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    if ((hi - lo) / 2 < half) {
      half = (hi - lo) / 2;
      normal = n;
    }
  }
  return { half, normal };
}

/** Convex hull of the points moved `up` along n and `down` against it (a slab / thickened hull). */
function extrudedHull(points: readonly number[], n: Readonly<Vec3>, up: number, down: number) {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 3) {
    const [x, y, z] = [points[i], points[i + 1], points[i + 2]];
    out.push(x + n[0] * up, y + n[1] * up, z + n[2] * up, x - n[0] * down, y - n[1] * down, z - n[2] * down);
  }
  const hull = convexHull(out);
  return hull?.dimension === 3 ? hull : null;
}

function hullShape(
  pts: number[],
  notes: string[],
  minHalf: number,
  frontDir: () => Vec3 | null,
  dynamic: boolean,
): ShapeBuild {
  let hull = convexHull(pts);
  let thickened: ShapeBuild['thickened'];
  if (hull && hull.dimension === 2) {
    // flat mesh: a slab behind its faces (centred on it when the faces do not say which side is front)
    let n = hull.normals[0];
    const f = frontDir();
    const fn = f ? f[0] * n[0] + f[1] * n[1] + f[2] * n[2] : 0;
    const front = Math.abs(fn) > 0.9;
    if (fn < 0) n = [-n[0], -n[1], -n[2]];
    const thick = front
      ? extrudedHull(hull.points, n, 0, 2 * minHalf)
      : extrudedHull(hull.points, n, minHalf, minHalf);
    if (thick) {
      hull = thick;
      thickened = { mesh: 0, collision: 2 * minHalf };
      if (dynamic || !front) notes.push(slabNote(minHalf, front));
    }
  } else if (hull && hull.dimension === 3) {
    // closed but thinner than the minimum: thickened along its thinnest direction
    const w = thinnestWidth(hull.points, hull.normals);
    if (w.half < minHalf * (1 - 1e-9)) {
      const grow = minHalf - w.half;
      const thick = extrudedHull(hull.points, w.normal, grow, grow);
      if (thick) {
        hull = thick;
        thickened = { mesh: 2 * w.half, collision: 2 * minHalf };
        notes.push(thinNote(w.half, minHalf));
      }
    }
  }
  if (hull && hull.dimension === 3) {
    const mp = polyhedronMass(hull.points, hull.faces);
    if (mp) {
      const verts = hull.points.map((v, i) => v - mp.com[i % 3]);
      const poly = makePolyhedron(verts, hull.faces);
      const box = cuboidFrame(poly);
      return {
        shape: box ? { kind: 'poly', poly, box } : { kind: 'poly', poly },
        type: 'CONVEX_HULL',
        com: mp.com,
        inertia: mp.inertia,
        volume: mp.volume,
        notes,
        ...(thickened ? { thickened } : {}),
      };
    }
  }
  if (hull && hull.dimension === 2) {
    const mp = boundsMass(hull.points, 2 * minHalf);
    const verts = hull.points.map((v, i) => v - mp.com[i % 3]);
    return {
      shape: { kind: 'poly', poly: makePolyhedron(verts, hull.faces, true) },
      type: 'CONVEX_HULL',
      com: mp.com,
      inertia: mp.inertia,
      volume: 0,
      notes,
    };
  }
  // a point or a segment: thin box around it
  const { center, half } = bounds(hull?.points ?? pts);
  const h: Vec3 = half.map((v) => Math.max(v, minHalf)) as Vec3;
  notes.push(`mesh vertices are collinear, using a ${mm(2 * minHalf)} thin box`);
  return {
    ...result(
      { kind: 'poly', poly: boxPolyhedron(h), box: alignedBox(h) },
      'CONVEX_HULL',
      boxMass(h, center),
      center,
      notes,
    ),
    volume: 0,
  };
}

/** Triangle mesh with welded adjacency, active edge flags and a BVH; null without triangles. */
function buildTriMesh(
  mesh: MeshData,
  pts: number[],
  valid: Int32Array,
  scale: Readonly<Vec3>,
): TriMesh | null {
  let indices: number[];
  try {
    indices = triangulateMesh(mesh).indices;
  } catch {
    return null;
  }
  const flip = scale[0] * scale[1] * scale[2] < 0;
  // weld coincident vertices so split normals / UV seams do not create boundary edges
  const { center, half } = bounds(pts);
  const extent = Math.max(half[0], half[1], half[2], 1e-9);
  const cell = extent * 1e-6;
  const weld = new Map<string, number>();
  const canon = new Int32Array(pts.length / 3);
  for (let i = 0; i < canon.length; i++) {
    const key = `${Math.round((pts[i * 3] - center[0]) / cell)},${Math.round((pts[i * 3 + 1] - center[1]) / cell)},${Math.round((pts[i * 3 + 2] - center[2]) / cell)}`;
    const w = weld.get(key);
    if (w === undefined) {
      weld.set(key, i);
      canon[i] = i;
    } else canon[i] = w;
  }
  const tris: number[] = [];
  const normals: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t];
    const ib = indices[flip ? t + 2 : t + 1];
    const ic = indices[flip ? t + 1 : t + 2];
    if (!(ia < valid.length && ib < valid.length && ic < valid.length)) continue;
    const a = valid[ia] >= 0 ? canon[valid[ia]] : -1;
    const b = valid[ib] >= 0 ? canon[valid[ib]] : -1;
    const c = valid[ic] >= 0 ? canon[valid[ic]] : -1;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    const ux = pts[b * 3] - pts[a * 3];
    const uy = pts[b * 3 + 1] - pts[a * 3 + 1];
    const uz = pts[b * 3 + 2] - pts[a * 3 + 2];
    const vx = pts[c * 3] - pts[a * 3];
    const vy = pts[c * 3 + 1] - pts[a * 3 + 1];
    const vz = pts[c * 3 + 2] - pts[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-14 * extent * extent)) continue;
    tris.push(a, b, c);
    normals.push(nx / l, ny / l, nz / l);
  }
  const triCount = tris.length / 3;
  if (triCount === 0) return null;
  // edge adjacency → active edges (boundaries and convex creases)
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++)
    for (let e = 0; e < 3; e++) {
      const a = tris[t * 3 + e];
      const b = tris[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edgeTris.get(key);
      if (list) list.push(t * 3 + e);
      else edgeTris.set(key, [t * 3 + e]);
    }
  const active = new Uint8Array(triCount);
  const COS_FLAT = Math.cos((1 * Math.PI) / 180);
  for (let t = 0; t < triCount; t++)
    for (let e = 0; e < 3; e++) {
      const a = tris[t * 3 + e];
      const b = tris[t * 3 + ((e + 1) % 3)];
      const list = edgeTris.get(a < b ? `${a},${b}` : `${b},${a}`)!;
      let isActive = true;
      if (list.length === 2) {
        const other = list[0] === t * 3 + e ? list[1] : list[0];
        const u = Math.floor(other / 3);
        const oe = other % 3;
        // consistent winding traverses the shared edge in opposite directions
        const sameDir = tris[u * 3 + oe] === a;
        const s = sameDir ? -1 : 1;
        const d =
          s *
          (normals[t * 3] * normals[u * 3] +
            normals[t * 3 + 1] * normals[u * 3 + 1] +
            normals[t * 3 + 2] * normals[u * 3 + 2]);
        if (d > COS_FLAT) isActive = false;
        else {
          // opposite vertex of the neighbour above our plane → concave (valley) edge: contacts
          // with the two faces handle it, so only convex creases are active
          const ov = tris[u * 3 + ((oe + 2) % 3)];
          const h =
            normals[t * 3] * (pts[ov * 3] - pts[a * 3]) +
            normals[t * 3 + 1] * (pts[ov * 3 + 1] - pts[a * 3 + 1]) +
            normals[t * 3 + 2] * (pts[ov * 3 + 2] - pts[a * 3 + 2]);
          if (h > 0) isActive = false;
        }
      }
      if (isActive) active[t] |= 1 << e;
    }
  const verts = Float64Array.from(pts);
  const triArr = Int32Array.from(tris);
  return {
    verts,
    tris: triArr,
    normals: Float64Array.from(normals),
    activeEdges: active,
    bvh: new TriangleBVH(verts, triArr),
  };
}
