import type { Mat4, Vec3 } from '../math/types';
import { determinant4, invert4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { Bvh } from '../modifiers/bvh';
import { buildBVH, type BVH } from '../render/pathtrace/bvh';
import { surfaceTriangles, type SurfaceTriangles } from '../instancing/sampling';
import { type Bounds, extendBounds, emptyBounds, isEmptyBounds, pointsBounds } from './layout';

/*
 * Spatial queries over evaluated scene geometry for the layout tools: ray casts against many
 * transformed meshes (one object-space BVH per mesh, shared by every object and instance using
 * it), and the closest distance between two meshes.
 *
 * Ray casts use a binned-SAH BVH (the path tracer's builder) traversed nearest child first, which
 * stays fast on meshes mixing long sliver triangles with fine detail (e.g. a terrain with a base).
 */

/** Object-space BVH over a mesh's (triangulated) faces. */
export interface MeshBvh {
  bvh: BVH;
  tris: SurfaceTriangles;
  /** Triangle (index into `tris`) of each BVH primitive; triangles with non-finite corners are left out. */
  triOf: Uint32Array;
  /** Object-space bounds of the triangles in the BVH (empty when there are none). */
  bounds: Bounds;
  /** Traversal stack (depth + 2 entries). */
  stackN: Int32Array;
  stackT: Float64Array;
}

// Cache keyed by the (immutable) mesh instance: evaluated and document meshes are shared objects.
const bvhCache = new WeakMap<MeshData, MeshBvh>();

/** BVH of a mesh's faces in object space (cached per mesh instance). */
export function meshBvh(mesh: MeshData): MeshBvh {
  let hit = bvhCache.get(mesh);
  if (!hit) {
    const tris = surfaceTriangles(mesh);
    const bounds = emptyBounds();
    const P = mesh.positions;
    const boxes = new Float64Array(tris.count * 6);
    const triOf = new Uint32Array(tris.count);
    let n = 0;
    for (let t = 0; t < tris.count; t++) {
      const o = n * 6;
      boxes[o] = boxes[o + 1] = boxes[o + 2] = Infinity;
      boxes[o + 3] = boxes[o + 4] = boxes[o + 5] = -Infinity;
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const v = tris.verts[t * 3 + k] * 3;
        for (let c = 0; c < 3; c++) {
          const x = P[v + c];
          if (!Number.isFinite(x)) ok = false;
          if (x < boxes[o + c]) boxes[o + c] = x;
          if (x > boxes[o + 3 + c]) boxes[o + 3 + c] = x;
        }
      }
      if (!ok) continue;
      extendBounds(bounds, boxes[o], boxes[o + 1], boxes[o + 2]);
      extendBounds(bounds, boxes[o + 3], boxes[o + 4], boxes[o + 5]);
      triOf[n++] = t;
    }
    const bvh = buildBVH(boxes, n);
    hit = {
      bvh,
      tris,
      triOf: triOf.subarray(0, n),
      bounds,
      stackN: new Int32Array(bvh.depth + 2),
      stackT: new Float64Array(bvh.depth + 2),
    };
    bvhCache.set(mesh, hit);
  }
  return hit;
}

const TINY = 1e-30;
/** Barycentric tolerance: rays through shared edges and vertices still hit. */
const EDGE_EPS = 1e-9;

/**
 * Closest triangle hit of an object-space ray `o + t·d` with `tMin < t < tMax` (both faces count).
 * Returns the triangle index (into `mb.tris`) and stores the distance in `out[0]`, or −1.
 */
export function raycastMeshBvh(
  mb: MeshBvh,
  P: ArrayLike<number>,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
  out: Float64Array | number[],
): number {
  const { bounds: B, child: C, count: K, prims } = mb.bvh;
  if (mb.triOf.length === 0) return -1;
  const V = mb.tris.verts;
  const ix = 1 / (Math.abs(dx) < TINY ? (dx < 0 ? -TINY : TINY) : dx);
  const iy = 1 / (Math.abs(dy) < TINY ? (dy < 0 ? -TINY : TINY) : dy);
  const iz = 1 / (Math.abs(dz) < TINY ? (dz < 0 ? -TINY : TINY) : dz);
  let best = tMax;
  let hit = -1;
  /** Entry distance into a node's box, or Infinity when the ray misses it before `best`. */
  const enter = (node: number): number => {
    const o = node * 6;
    let t0 = (B[o] - ox) * ix;
    let t1 = (B[o + 3] - ox) * ix;
    if (t0 > t1) [t0, t1] = [t1, t0];
    let a = (B[o + 1] - oy) * iy;
    let b = (B[o + 4] - oy) * iy;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    a = (B[o + 2] - oz) * iz;
    b = (B[o + 5] - oz) * iz;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (tMin > t0) t0 = tMin;
    if (best < t1) t1 = best;
    return t0 <= t1 ? t0 : Infinity;
  };
  const sN = mb.stackN;
  const sT = mb.stackT;
  let sp = 0;
  const root = enter(0);
  if (root === Infinity) return -1;
  sN[sp] = 0;
  sT[sp++] = root;
  while (sp > 0) {
    sp--;
    if (sT[sp] >= best) continue;
    const node = sN[sp];
    const cnt = K[node];
    if (cnt > 0) {
      for (let i = C[node]; i < C[node] + cnt; i++) {
        const tri = mb.triOf[prims[i]];
        const a = V[tri * 3] * 3;
        const b = V[tri * 3 + 1] * 3;
        const c = V[tri * 3 + 2] * 3;
        const e1x = P[b] - P[a];
        const e1y = P[b + 1] - P[a + 1];
        const e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a];
        const e2y = P[c + 1] - P[a + 1];
        const e2z = P[c + 2] - P[a + 2];
        const hx = dy * e2z - dz * e2y;
        const hy = dz * e2x - dx * e2z;
        const hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (det === 0 || !Number.isFinite(det)) continue;
        const inv = 1 / det;
        const sx = ox - P[a];
        const sy = oy - P[a + 1];
        const sz = oz - P[a + 2];
        const u = (sx * hx + sy * hy + sz * hz) * inv;
        if (u < -EDGE_EPS || u > 1 + EDGE_EPS) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -EDGE_EPS || u + v > 1 + EDGE_EPS) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > tMin && t < best) {
          best = t;
          hit = tri;
        }
      }
      continue;
    }
    // interior: visit the nearer child first (pushed last)
    const l = C[node];
    const tl = enter(l);
    const tr = enter(l + 1);
    if (tl <= tr) {
      if (tr < best) {
        sN[sp] = l + 1;
        sT[sp++] = tr;
      }
      if (tl < best) {
        sN[sp] = l;
        sT[sp++] = tl;
      }
    } else {
      if (tl < best) {
        sN[sp] = l;
        sT[sp++] = tl;
      }
      if (tr < best) {
        sN[sp] = l + 1;
        sT[sp++] = tr;
      }
    }
  }
  if (hit >= 0) out[0] = best;
  return hit;
}

/** A piece of geometry rays are cast against. */
export interface RaycastTarget {
  /** Id reported for hits: the object id, or the instance id for instances. */
  id: string;
  /** Object providing the geometry. */
  objectId: string;
  /** Instancer object for instances, null for real objects. */
  instancer: string | null;
  mesh: MeshData;
  /** Object → world matrix. */
  matrix: Mat4;
}

export interface SceneHit {
  target: RaycastTarget;
  /** Distance from the ray origin along the (normalized) direction, metres. */
  distance: number;
  point: Vec3;
  /** Unit geometric normal of the hit face in world space (follows the face winding). */
  normal: Vec3;
  /** True when the ray hit the front side of the face (normal facing the ray origin). */
  front: boolean;
  /** Face index in the target's mesh. */
  face: number;
}

interface Entry {
  target: RaycastTarget;
  bvh: MeshBvh;
  inv: Mat4;
  /** World-space AABB (conservative: transformed object-space box). */
  box: Bounds;
}

function transformBox(b: Bounds, m: Mat4): Bounds {
  const out = emptyBounds();
  if (isEmptyBounds(b)) return out;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? b.max[0] : b.min[0];
    const y = c & 2 ? b.max[1] : b.min[1];
    const z = c & 4 ? b.max[2] : b.min[2];
    extendBounds(
      out,
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    );
  }
  return out;
}

/** Entry distance of a ray into a box (Infinity when it misses within [0, tMax]). */
function rayBox(b: Bounds, o: Readonly<Vec3>, d: Readonly<Vec3>, tMax: number): number {
  let t0 = 0;
  let t1 = tMax;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-300) {
      if (o[k] < b.min[k] || o[k] > b.max[k]) return Infinity;
      continue;
    }
    let a = (b.min[k] - o[k]) / d[k];
    let c = (b.max[k] - o[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

function finite3(v: Readonly<Vec3>): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/** Below this many targets a linear scan beats a top-level BVH. */
const TLAS_MIN = 8;

/** Ray casts against many transformed meshes (top-level BVH over their world boxes). */
export class SceneRaycaster {
  private readonly entries: Entry[] = [];
  private readonly tOut = new Float64Array(1);
  private readonly tlas: BVH | null = null;
  private readonly stackN: Int32Array = new Int32Array(0);
  private readonly stackT: Float64Array = new Float64Array(0);

  constructor(targets: readonly RaycastTarget[]) {
    for (const target of targets) {
      // singular (zero-scale) transforms have no invertible object space to cast in
      if (
        !target.mesh ||
        !target.matrix.every(Number.isFinite) ||
        !(Math.abs(determinant4(target.matrix)) > 1e-30)
      )
        continue;
      const bvh = meshBvh(target.mesh);
      if (bvh.triOf.length === 0) continue;
      this.entries.push({
        target,
        bvh,
        inv: invert4(target.matrix),
        box: transformBox(bvh.bounds, target.matrix),
      });
    }
    if (this.entries.length >= TLAS_MIN) {
      const boxes = new Float64Array(this.entries.length * 6);
      this.entries.forEach((e, i) => {
        boxes.set(e.box.min, i * 6);
        boxes.set(e.box.max, i * 6 + 3);
      });
      this.tlas = buildBVH(boxes, this.entries.length);
      this.stackN = new Int32Array(this.tlas.depth + 2);
      this.stackT = new Float64Array(this.tlas.depth + 2);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** The targets that have geometry. */
  targets(): RaycastTarget[] {
    return this.entries.map((e) => e.target);
  }

  /** Union of the world boxes of all targets. */
  bounds(): Bounds {
    const out = emptyBounds();
    for (const e of this.entries) {
      if (isEmptyBounds(e.box)) continue;
      extendBounds(out, e.box.min[0], e.box.min[1], e.box.min[2]);
      extendBounds(out, e.box.max[0], e.box.max[1], e.box.max[2]);
    }
    return out;
  }

  /** World boxes of the targets (same order as `targets()`). */
  boxes(): Bounds[] {
    return this.entries.map((e) => e.box);
  }

  /**
   * Closest hit along `origin + t·dir` (dir is normalized here) with `minDistance < t < maxDistance`.
   * Both sides of faces count. `skip` filters targets.
   */
  cast(
    origin: Readonly<Vec3>,
    direction: Readonly<Vec3>,
    maxDistance = Infinity,
    opts: { minDistance?: number; skip?: (t: RaycastTarget) => boolean } = {},
  ): SceneHit | null {
    const len = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(len > 1e-300) || !finite3(origin) || !finite3(direction)) return null;
    const d: Vec3 = [direction[0] / len, direction[1] / len, direction[2] / len];
    const tMin = Math.max(0, opts.minDistance ?? 0);
    // (a holder: TypeScript does not track assignments made inside the `visit` closure)
    const found: { best: { e: Entry; t: number; tri: number } | null } = { best: null };
    let far = maxDistance > 0 ? maxDistance : 0;
    if (!(far > tMin)) return null;
    const visit = (e: Entry) => {
      if (opts.skip?.(e.target)) return;
      const m = e.inv;
      const ox = m[0] * origin[0] + m[4] * origin[1] + m[8] * origin[2] + m[12];
      const oy = m[1] * origin[0] + m[5] * origin[1] + m[9] * origin[2] + m[13];
      const oz = m[2] * origin[0] + m[6] * origin[1] + m[10] * origin[2] + m[14];
      // object-space direction keeps t in world units (the transform is affine)
      const dx = m[0] * d[0] + m[4] * d[1] + m[8] * d[2];
      const dy = m[1] * d[0] + m[5] * d[1] + m[9] * d[2];
      const dz = m[2] * d[0] + m[6] * d[1] + m[10] * d[2];
      const tri = raycastMeshBvh(
        e.bvh,
        e.target.mesh.positions,
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        tMin,
        far,
        this.tOut,
      );
      if (tri >= 0 && this.tOut[0] < far) {
        far = this.tOut[0];
        found.best = { e, t: far, tri };
      }
    };
    if (this.tlas) {
      // nearest-first over the target boxes; a box is skipped once it starts beyond the best hit
      const { bounds: B, child: C, count: K, prims } = this.tlas;
      const ix = 1 / (Math.abs(d[0]) < TINY ? TINY : d[0]);
      const iy = 1 / (Math.abs(d[1]) < TINY ? TINY : d[1]);
      const iz = 1 / (Math.abs(d[2]) < TINY ? TINY : d[2]);
      const enter = (node: number): number => {
        const o = node * 6;
        let t0 = (B[o] - origin[0]) * ix;
        let t1 = (B[o + 3] - origin[0]) * ix;
        if (t0 > t1) [t0, t1] = [t1, t0];
        let a = (B[o + 1] - origin[1]) * iy;
        let b = (B[o + 4] - origin[1]) * iy;
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        a = (B[o + 2] - origin[2]) * iz;
        b = (B[o + 5] - origin[2]) * iz;
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (tMin > t0) t0 = tMin;
        if (far < t1) t1 = far;
        return t0 <= t1 ? t0 : Infinity;
      };
      const sN = this.stackN;
      const sT = this.stackT;
      let sp = 0;
      const root = enter(0);
      if (root !== Infinity) {
        sN[sp] = 0;
        sT[sp++] = root;
      }
      while (sp > 0) {
        sp--;
        if (sT[sp] >= far) continue;
        const node = sN[sp];
        if (K[node] > 0) {
          for (let i = C[node]; i < C[node] + K[node]; i++) visit(this.entries[prims[i]]);
          continue;
        }
        const l = C[node];
        const tl = enter(l);
        const tr = enter(l + 1);
        const [n0, t0, n1, t1] = tl <= tr ? [l + 1, tr, l, tl] : [l, tl, l + 1, tr];
        if (t0 < far) {
          sN[sp] = n0;
          sT[sp++] = t0;
        }
        if (t1 < far) {
          sN[sp] = n1;
          sT[sp++] = t1;
        }
      }
    } else for (const e of this.entries) if (rayBox(e.box, origin, d, far) <= far) visit(e);
    if (!found.best) return null;
    const { e, t, tri } = found.best;
    const P = e.target.mesh.positions;
    const a = e.bvh.tris.verts[tri * 3] * 3;
    const b = e.bvh.tris.verts[tri * 3 + 1] * 3;
    const c = e.bvh.tris.verts[tri * 3 + 2] * 3;
    const ux = P[b] - P[a];
    const uy = P[b + 1] - P[a + 1];
    const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a];
    const vy = P[c + 1] - P[a + 1];
    const vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    // normals transform with the inverse transpose
    const m = e.inv;
    let wx = m[0] * nx + m[1] * ny + m[2] * nz;
    let wy = m[4] * nx + m[5] * ny + m[6] * nz;
    let wz = m[8] * nx + m[9] * ny + m[10] * nz;
    const nl = Math.hypot(wx, wy, wz);
    if (nl > 0) {
      wx /= nl;
      wy /= nl;
      wz /= nl;
    } else {
      wx = -d[0];
      wy = -d[1];
      wz = -d[2];
    }
    return {
      target: e.target,
      distance: t,
      point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t],
      normal: [wx, wy, wz],
      front: wx * d[0] + wy * d[1] + wz * d[2] < 0,
      face: e.bvh.tris.face[tri],
    };
  }

  /** Every hit along the ray (at most `maxHits`, nearest first). */
  castAll(
    origin: Readonly<Vec3>,
    direction: Readonly<Vec3>,
    maxDistance = Infinity,
    maxHits = 64,
    opts: { skip?: (t: RaycastTarget) => boolean } = {},
  ): SceneHit[] {
    const out: SceneHit[] = [];
    let from = 0;
    while (out.length < maxHits) {
      const hit = this.cast(origin, direction, maxDistance, { minDistance: from, skip: opts.skip });
      if (!hit) break;
      out.push(hit);
      // step past this surface (relative epsilon keeps far hits from repeating)
      from = hit.distance + 1e-7 * Math.max(1, hit.distance);
    }
    return out;
  }
}

/** World-space positions of a mesh's vertices (flat xyz). */
export function worldPositions(mesh: MeshData, m: Mat4): Float64Array {
  const P = mesh.positions;
  const out = new Float64Array(P.length - (P.length % 3));
  for (let i = 0; i + 2 < P.length; i += 3) {
    const x = P[i];
    const y = P[i + 1];
    const z = P[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Closest distance between two meshes (world space). */
export interface MeshDistance {
  /** Metres; 0 when the surfaces touch or intersect. */
  distance: number;
  /** Closest point on the first mesh. */
  pointA: Vec3;
  /** Closest point on the second mesh. */
  pointB: Vec3;
  /** True when the surfaces cross each other (an edge of one passes through a face of the other). */
  intersecting: boolean;
}

interface WorldMesh {
  positions: Float64Array;
  tris: SurfaceTriangles;
  bvh: Bvh;
  /** World bounds of the face vertices. */
  box: Bounds;
}

function worldMesh(mesh: MeshData, m: Mat4): WorldMesh | null {
  const tris = surfaceTriangles(mesh);
  if (tris.count === 0) return null;
  const positions = worldPositions(mesh, m);
  const box = emptyBounds();
  for (let i = 0; i < tris.verts.length; i++) {
    const v = tris.verts[i] * 3;
    extendBounds(box, positions[v], positions[v + 1], positions[v + 2]);
  }
  return { positions, tris, bvh: new Bvh(positions, tris.verts, 3), box };
}

/** Squared distance from a point to a box (0 inside). */
function boxDist2(b: Bounds, x: number, y: number, z: number): number {
  const dx = x < b.min[0] ? b.min[0] - x : x > b.max[0] ? x - b.max[0] : 0;
  const dy = y < b.min[1] ? b.min[1] - y : y > b.max[1] ? y - b.max[1] : 0;
  const dz = z < b.min[2] ? b.min[2] - z : z > b.max[2] ? z - b.max[2] : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** First crossing of an edge of `a` through a face of `b`, or null. */
function edgeCrossing(a: WorldMesh, b: WorldMesh): Vec3 | null {
  const P = a.positions;
  const seen = new Set<number>();
  const n = P.length / 3;
  const v = a.tris.verts;
  const bb = b.box;
  for (let t = 0; t < a.tris.count; t++)
    for (let k = 0; k < 3; k++) {
      const i = v[t * 3 + k];
      const j = v[t * 3 + ((k + 1) % 3)];
      // only edges whose box overlaps the other mesh can cross it
      let outside = false;
      for (let c = 0; c < 3 && !outside; c++)
        outside =
          Math.max(P[i * 3 + c], P[j * 3 + c]) < bb.min[c] ||
          Math.min(P[i * 3 + c], P[j * 3 + c]) > bb.max[c];
      if (outside) continue;
      const key = i < j ? i * n + j : j * n + i;
      if (seen.has(key)) continue;
      seen.add(key);
      const dx = P[j * 3] - P[i * 3];
      const dy = P[j * 3 + 1] - P[i * 3 + 1];
      const dz = P[j * 3 + 2] - P[i * 3 + 2];
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 1e-12)) continue;
      const hit = b.bvh.raycast(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], dx / len, dy / len, dz / len, 0, len);
      if (hit)
        return [
          P[i * 3] + (dx / len) * hit.t,
          P[i * 3 + 1] + (dy / len) * hit.t,
          P[i * 3 + 2] + (dz / len) * hit.t,
        ];
    }
  return null;
}

/**
 * Closest vertex of `a` to the surface of `b` (only when closer than `bound`², squared). Vertices
 * are visited by their distance to `b`'s box, a lower bound, so far-away ones are never queried.
 */
function closestVertexToSurface(
  a: WorldMesh,
  b: WorldMesh,
  bound = Infinity,
): { d2: number; pa: Vec3; pb: Vec3 } | null {
  const P = a.positions;
  const used = new Uint8Array(P.length / 3);
  for (let i = 0; i < a.tris.verts.length; i++) used[a.tris.verts[i]] = 1;
  const cand: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < used.length; i++) {
    if (!used[i]) continue;
    const lb = boxDist2(b.box, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    if (lb >= bound) continue;
    lower[i] = lb;
    cand.push(i);
  }
  cand.sort((p, q) => lower[p] - lower[q]);
  let best: { d2: number; pa: Vec3; pb: Vec3 } | null = null;
  for (const i of cand) {
    if (best && lower[i] >= best.d2) break;
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    const c = b.bvh.closest(x, y, z);
    if (c && c.dist2 < bound && (!best || c.dist2 < best.d2))
      best = { d2: c.dist2, pa: [x, y, z], pb: [c.x, c.y, c.z] };
  }
  return best;
}

/**
 * Closest distance between the surfaces of two transformed meshes: the minimum over the vertices of
 * each mesh of the distance to the other surface (exact up to the tessellation), and 0 when an
 * edge of one passes through a face of the other. Null when either mesh has no faces.
 */
export function meshDistance(
  a: { mesh: MeshData; matrix: Mat4 },
  b: { mesh: MeshData; matrix: Mat4 },
): MeshDistance | null {
  const A = worldMesh(a.mesh, a.matrix);
  const B = worldMesh(b.mesh, b.matrix);
  if (!A || !B) return null;
  const cross = edgeCrossing(A, B) ?? edgeCrossing(B, A);
  if (cross) return { distance: 0, pointA: cross, pointB: [...cross] as Vec3, intersecting: true };
  const ab = closestVertexToSurface(A, B);
  const ba = closestVertexToSurface(B, A, ab ? ab.d2 : Infinity);
  if (!ab && !ba) return null;
  if (ab && (!ba || ab.d2 <= ba.d2))
    return { distance: Math.sqrt(ab.d2), pointA: ab.pa, pointB: ab.pb, intersecting: false };
  return { distance: Math.sqrt(ba!.d2), pointA: ba!.pb, pointB: ba!.pa, intersecting: false };
}

// ------------------------------------------------------------------ drop to ground

/** How far to move geometry vertically so it rests on the surface below it. */
export interface DropResult {
  /** Vertical translation in metres (negative = down, positive = lifted out of the surface). */
  dz: number;
  /** Contact point on the surface (world space; where the moved geometry touches it). */
  point: Vec3;
  /** Unit surface normal at the contact, pointing up. */
  normal: Vec3;
  /** Surface touched, or null for the ground plane z = 0. */
  target: RaycastTarget | null;
}

function upward(n: Readonly<Vec3>): Vec3 {
  return n[2] < 0 ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
}

/**
 * Vertical offset that makes geometry rest on the surfaces beneath it. `points` are the world-space
 * vertices of the geometry (or just its origin). The supporting surface at each footprint position
 * is the first one below the top of the geometry, so geometry hanging in the air drops down and
 * geometry sunk into a surface is lifted out of it, while surfaces above the geometry (a table top
 * over a stool) are ignored. Rays go down from above every vertex onto `targets` and, when the
 * geometry's own surface is given, up from every target vertex under the footprint onto it (so
 * peaks between the vertices are found too); the largest required offset wins. With `groundPlane`
 * the plane z = 0 is the surface wherever no target lies below. Null when there is nothing below.
 */
export function computeDrop(
  points: ArrayLike<number>,
  geometry: SceneRaycaster | null,
  targets: SceneRaycaster,
  groundPlane: boolean,
): DropResult | null {
  const b = pointsBounds(points);
  if (isEmptyBounds(b)) return null;
  const eps = 1e-6 * Math.max(1, Math.abs(b.max[2]), Math.abs(b.min[2]));
  const top = b.max[2] + eps;
  let best: DropResult | null = null;
  const consider = (dz: number, point: Vec3, normal: Vec3, target: RaycastTarget | null) => {
    if (Number.isFinite(dz) && (!best || dz > best.dz)) best = { dz, point, normal, target };
  };
  const down: Vec3 = [0, 0, -1];
  /** Highest surface below `top` at (x, y). */
  const surfaceBelow = (
    x: number,
    y: number,
  ): { z: number; n: Vec3; target: RaycastTarget | null } | null => {
    const hit = targets.cast([x, y, top], down);
    let out: { z: number; n: Vec3; target: RaycastTarget | null } | null = hit
      ? { z: hit.point[2], n: upward(hit.normal), target: hit.target }
      : null;
    if (!out && groundPlane && top > 0) out = { z: 0, n: [0, 0, 1], target: null };
    return out;
  };
  // only the lowest point above each footprint position matters (walls stack many vertices)
  const lowest = new Map<string, number>();
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const key = `${x},${y}`;
    const prev = lowest.get(key);
    if (prev === undefined || z < prev) lowest.set(key, z);
  }
  for (const [key, z] of lowest) {
    const c = key.indexOf(',');
    const x = Number(key.slice(0, c));
    const y = Number(key.slice(c + 1));
    const s = surfaceBelow(x, y);
    if (s) consider(s.z - z, [x, y, s.z], s.n, s.target);
  }
  if (geometry && geometry.size > 0) {
    const from = b.min[2] - eps;
    const reach = top - from + eps;
    const all = targets.targets();
    const boxes = targets.boxes();
    for (let k = 0; k < all.length; k++) {
      const box = boxes[k];
      if (box.min[2] >= top || box.max[0] < b.min[0] || box.min[0] > b.max[0]) continue;
      if (box.max[1] < b.min[1] || box.min[1] > b.max[1]) continue;
      const t = all[k];
      const { tris } = meshBvh(t.mesh);
      const used = new Uint8Array(t.mesh.positions.length / 3);
      for (let i = 0; i < tris.verts.length; i++) used[tris.verts[i]] = 1;
      const P = t.mesh.positions;
      const m = t.matrix;
      for (let v = 0; v < used.length; v++) {
        if (!used[v]) continue;
        const lx = P[v * 3];
        const ly = P[v * 3 + 1];
        const lz = P[v * 3 + 2];
        const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
        if (!(z < top) || x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1]) continue;
        const hit = geometry.cast([x, y, from], [0, 0, 1], reach);
        if (hit) consider(z - hit.point[2], [x, y, z], upward(hit.normal), t);
      }
    }
  }
  return best;
}
