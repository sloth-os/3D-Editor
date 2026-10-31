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
import type { Mat3 } from './vmath';

/*
 * Collision shapes in body space (origin at the centre of mass, axes = object axes, object scale
 * applied). Dimensions follow Blender's rigid body rules: primitive shapes are fitted to the
 * object's bounding box (radius = largest X/Y half extent, height along local Z), CONVEX_HULL uses
 * the hull of the mesh vertices and MESH the triangles themselves. Unlike Blender the primitive
 * shapes are centred on the bounding box and bodies rotate about their true centre of mass,
 * which is identical for meshes whose origin is at their centre.
 */

/** Smallest half thickness of collision geometry (keeps flat meshes collidable). */
export const MIN_HALF_EXTENT = 5e-4;
/** Hull vertex budget (larger hulls are simplified to their extreme points). */
export const MAX_HULL_VERTICES = 64;
/** Vertex count of the polygon approximating cylinder / cone caps in contact manifolds. */
const CAP_SEGMENTS = 12;

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
  | { kind: 'poly'; poly: Polyhedron }
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
  /** Non-fatal notes (fallbacks), for diagnostics. */
  notes: string[];
}

// ---------------------------------------------------------------- polyhedra

/** Builds a polyhedron (planes + edge adjacency) from polygons over flat xyz vertices. */
export function makePolyhedron(verts: ArrayLike<number>, faces: number[][], flat = false): Polyhedron {
  const v = Float64Array.from(verts);
  const planes = new Float64Array(faces.length * 4);
  faces.forEach((f, i) => {
    const n = newellNormal(v, f);
    let d = 0;
    for (const k of f) d += n[0] * v[k * 3] + n[1] * v[k * 3 + 1] + n[2] * v[k * 3 + 2];
    planes.set([n[0], n[1], n[2], d / f.length], i * 4);
  });
  const left = new Map<string, number>();
  faces.forEach((f, fi) => f.forEach((a, k) => left.set(`${a},${f[(k + 1) % f.length]}`, fi)));
  const edges: number[] = [];
  const done = new Set<string>();
  faces.forEach((f, fi) =>
    f.forEach((a, k) => {
      const b = f[(k + 1) % f.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (done.has(key)) return;
      done.add(key);
      edges.push(a, b, fi, left.get(`${b},${a}`) ?? -1);
    }),
  );
  const n = v.length / 3;
  const centroid: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) centroid[a] += v[i * 3 + a] / n;
  return { verts: v, faces, planes, edges: Int32Array.from(edges), flat, centroid };
}

const BOX_FACES = [
  [1, 3, 7, 5],
  [0, 4, 6, 2],
  [2, 6, 7, 3],
  [0, 1, 5, 4],
  [4, 5, 7, 6],
  [0, 2, 3, 1],
];

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
export function supportCore(s: Shape, dx: number, dy: number, dz: number, out: number[] | Float64Array, o = 0): void {
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
      let best = 0;
      let bestDot = -Infinity;
      for (let i = 0; i < v.length; i += 3) {
        const d = v[i] * dx + v[i + 1] * dy + v[i + 2] * dz;
        if (d > bestDot) {
          bestDot = d;
          best = i;
        }
      }
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
      if (Math.abs(uz) > 0.7) return capPolygon(cx, cy, cz + (uz > 0 ? s.halfHeight : -s.halfHeight), s.radius, uz > 0);
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
      for (let f = 0; f < p.faces.length; f++) {
        const d = p.planes[f * 4] * ux + p.planes[f * 4 + 1] * uy + p.planes[f * 4 + 2] * uz;
        if (d > bestDot) {
          bestDot = d;
          best = f;
        }
      }
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

const sub3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function result(shape: Shape, type: CollisionShape, mp: MassProperties, com: Vec3, notes: string[]): ShapeBuild {
  return { shape, type, com, inertia: mp.inertia, volume: mp.volume, notes };
}

/**
 * Builds the collision shape of an object from its mesh (object space) and world scale.
 * `dynamic` bodies cannot use triangle meshes (Blender's MESH shape is unstable for active
 * bodies): they fall back to the convex hull. Returns an error string for unusable meshes.
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
  const h: Vec3 = half.map((v) => Math.max(v, MIN_HALF_EXTENT)) as Vec3;
  switch (type) {
    case 'BOX':
      return result({ kind: 'poly', poly: boxPolyhedron(h) }, type, boxMass(h, center), center, notes);
    case 'SPHERE': {
      const r = Math.max(h[0], h[1], h[2]);
      return result({ kind: 'sphere', center: [0, 0, 0], radius: r }, type, sphereMass(r, center), center, notes);
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
          return { shape: { kind: 'mesh', mesh: tm }, type: 'MESH', com: [0, 0, 0], inertia: mp.inertia, volume: 0, notes };
        }
        notes.push('mesh has no faces, using its convex hull');
      } else notes.push('active rigid bodies cannot use the MESH shape, using CONVEX_HULL');
      return hullShape(pts, notes);
    }
    case 'CONVEX_HULL':
    default:
      return hullShape(pts, notes);
  }
}

function hullShape(pts: number[], notes: string[]): ShapeBuild {
  const hull = convexHull(pts, MAX_HULL_VERTICES);
  const minT = 2 * MIN_HALF_EXTENT;
  if (hull && hull.dimension === 3) {
    const mp = polyhedronMass(hull.points, hull.faces);
    if (mp) {
      const verts = hull.points.map((v, i) => v - mp.com[i % 3]);
      return {
        shape: { kind: 'poly', poly: makePolyhedron(verts, hull.faces) },
        type: 'CONVEX_HULL',
        com: mp.com,
        inertia: mp.inertia,
        volume: mp.volume,
        notes,
      };
    }
  }
  if (hull && hull.dimension === 2) {
    const mp = boundsMass(hull.points, minT);
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
  const h: Vec3 = half.map((v) => Math.max(v, MIN_HALF_EXTENT)) as Vec3;
  notes.push('mesh vertices are collinear, using a thin box');
  return { ...result({ kind: 'poly', poly: boxPolyhedron(h) }, 'CONVEX_HULL', boxMass(h, center), center, notes), volume: 0 };
}

/** Triangle mesh with welded adjacency, active edge flags and a BVH; null without triangles. */
function buildTriMesh(mesh: MeshData, pts: number[], valid: Int32Array, scale: Readonly<Vec3>): TriMesh | null {
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
          s * (normals[t * 3] * normals[u * 3] + normals[t * 3 + 1] * normals[u * 3 + 1] + normals[t * 3 + 2] * normals[u * 3 + 2]);
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
