import type { Mat4, Vec3 } from '../math/types';
import { determinant4, invert4 } from '../math/mat4';
import type { MeshData } from '../mesh/types';
import { closestPointOnTriangle } from '../modifiers/bvh';
import { buildBVH, type BVH } from '../render/pathtrace/bvh';
import { surfaceTriangles, type SurfaceTriangles } from '../instancing/sampling';
import { type Bounds, extendBounds, emptyBounds, isEmptyBounds, pointsBounds } from './layout';

/*
 * Spatial queries over evaluated scene geometry for the layout tools: ray casts against many
 * transformed meshes (one object-space BVH per mesh, shared by every object and instance using
 * it), the exact closest distance between two meshes (both BVHs walked together, triangle pairs
 * compared edge to edge and vertex to face), and the drop solver of object.drop_to_ground.
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
      // relative epsilon: steps past this surface without repeating far hits
      const eps = 1e-7 * Math.max(1, hit.distance);
      // surfaces of other targets at the same distance (coincident faces, e.g. glass standing on a
      // slab): cast again within the epsilon band, leaving out the targets already hit there
      const band = new Set<RaycastTarget>([hit.target]);
      while (out.length < maxHits) {
        const same = this.cast(origin, direction, Math.min(maxDistance, hit.distance + eps), {
          minDistance: Math.max(from, hit.distance - eps),
          skip: (t) => band.has(t) || !!opts.skip?.(t),
        });
        if (!same) break;
        out.push(same);
        band.add(same.target);
      }
      from = hit.distance + eps;
    }
    out.sort((a, b) => a.distance - b.distance);
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

/** A mesh placed in the world (object → world matrix). */
export interface MeshPart {
  mesh: MeshData;
  matrix: Mat4;
}

/**
 * The triangles of one or more placed meshes in world space (a soup: 9 coordinates per
 * triangle) with a BVH over them, for closest-distance queries between meshes.
 */
export class WorldTriangles {
  /** Corner coordinates, `count` × 9. */
  readonly corners: Float64Array;
  readonly count: number;
  readonly bvh: BVH;

  constructor(parts: MeshPart | readonly MeshPart[]) {
    const list = Array.isArray(parts) ? parts : [parts as MeshPart];
    let total = 0;
    const tris = list.map((p) => {
      const t = surfaceTriangles(p.mesh);
      total += t.count;
      return t;
    });
    const C = new Float64Array(total * 9);
    let n = 0;
    list.forEach((part, pi) => {
      const P = part.mesh.positions;
      const m = part.matrix;
      const V = tris[pi].verts;
      for (let t = 0; t < tris[pi].count; t++) {
        const o = n * 9;
        let ok = true;
        for (let k = 0; k < 3; k++) {
          const v = V[t * 3 + k] * 3;
          const x = P[v];
          const y = P[v + 1];
          const z = P[v + 2];
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) ok = false;
          C[o + k * 3] = wx;
          C[o + k * 3 + 1] = wy;
          C[o + k * 3 + 2] = wz;
        }
        if (ok) n++;
      }
    });
    this.count = n;
    this.corners = C.subarray(0, n * 9);
    const boxes = new Float64Array(n * 6);
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      for (let a = 0; a < 3; a++) {
        boxes[t * 6 + a] = Math.min(C[o + a], C[o + 3 + a], C[o + 6 + a]);
        boxes[t * 6 + 3 + a] = Math.max(C[o + a], C[o + 3 + a], C[o + 6 + a]);
      }
    }
    this.bvh = buildBVH(boxes, n);
  }
}

/** Squared distance between box `i` of BVH `a` and box `j` of BVH `b` (0 when they overlap). */
function nodeGap2(a: BVH, i: number, b: BVH, j: number): number {
  const A = a.bounds;
  const B = b.bounds;
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(0, A[i * 6 + k] - B[j * 6 + 3 + k], B[j * 6 + k] - A[i * 6 + 3 + k]);
    s += d * d;
  }
  return s;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Relative margin keeping crossings off triangle boundaries and segment ends (touching contacts). */
const CROSS_EPS = 1e-9;

/**
 * Closest points of segments p + s·u and q + t·v (s, t in [0, 1]) into `out` [p', q'];
 * returns the squared distance.
 */
function segmentPair(
  px: number,
  py: number,
  pz: number,
  ux: number,
  uy: number,
  uz: number,
  qx: number,
  qy: number,
  qz: number,
  vx: number,
  vy: number,
  vz: number,
  out: Float64Array,
): number {
  // minimise |w + s·u - t·v|² with w = p - q
  const wx = px - qx;
  const wy = py - qy;
  const wz = pz - qz;
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  let s = 0;
  let t = 0;
  if (a > 1e-30 && c > 1e-30) {
    const den = a * c - b * b;
    // parallel segments: any s works for the line pair; start from s = 0 and clamp below
    s = den > 1e-12 * a * c ? clamp01((b * e - c * d) / den) : 0;
    t = (b * s + e) / c;
    if (t < 0) {
      t = 0;
      s = clamp01(-d / a);
    } else if (t > 1) {
      t = 1;
      s = clamp01((b - d) / a);
    }
  } else if (a > 1e-30) s = clamp01(-d / a);
  else if (c > 1e-30) t = clamp01(e / c);
  out[0] = px + ux * s;
  out[1] = py + uy * s;
  out[2] = pz + uz * s;
  out[3] = qx + vx * t;
  out[4] = qy + vy * t;
  out[5] = qz + vz * t;
  return (out[0] - out[3]) ** 2 + (out[1] - out[4]) ** 2 + (out[2] - out[5]) ** 2;
}

/**
 * Where segment p → p + d passes through the interior of triangle (a, b, c), excluding its end
 * points and the triangle's boundary (so surfaces that only touch, like stacked boxes, never count
 * as crossing); writes the point into `out` and returns true.
 */
function segmentCrossesTriangle(
  C: Float64Array,
  o: number,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  out: Float64Array,
): boolean {
  const e1x = C[o + 3] - C[o];
  const e1y = C[o + 4] - C[o + 1];
  const e1z = C[o + 5] - C[o + 2];
  const e2x = C[o + 6] - C[o];
  const e2y = C[o + 7] - C[o + 1];
  const e2z = C[o + 8] - C[o + 2];
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  // (parallel and coplanar segments never cross transversally)
  const scale = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z) * Math.hypot(dx, dy, dz);
  if (!(Math.abs(det) > 1e-12 * scale)) return false;
  const inv = 1 / det;
  const sx = px - C[o];
  const sy = py - C[o + 1];
  const sz = pz - C[o + 2];
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (!(u > CROSS_EPS && u < 1 - CROSS_EPS)) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (!(v > CROSS_EPS && u + v < 1 - CROSS_EPS)) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (!(t > CROSS_EPS && t < 1 - CROSS_EPS)) return false;
  out[0] = px + dx * t;
  out[1] = py + dy * t;
  out[2] = pz + dz * t;
  return true;
}

/**
 * Closest distance between the surfaces of two sets of world triangles: exact (the minimum over
 * triangle pairs of their distance, which is an edge-edge or vertex-face distance unless they
 * cross), found by walking both BVHs together nearest first. Distance 0 with intersecting=true when
 * an edge of one passes through a face of the other; touching surfaces (shared faces, resting
 * contact) give 0 with intersecting=false. Null when either set has no triangles.
 */
export function triangleSetDistance(A: WorldTriangles, B: WorldTriangles): MeshDistance | null {
  if (A.count === 0 || B.count === 0) return null;
  const CA = A.corners;
  const CB = B.corners;
  let best2 = Infinity;
  const pa: Vec3 = [0, 0, 0];
  const pb: Vec3 = [0, 0, 0];
  const seg = new Float64Array(6);
  const tmp = [0, 0, 0];
  const hit = new Float64Array(3);
  let crossing: Vec3 | null = null;
  const take = (d2: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    if (d2 < best2) {
      best2 = d2;
      pa[0] = ax;
      pa[1] = ay;
      pa[2] = az;
      pb[0] = bx;
      pb[1] = by;
      pb[2] = bz;
    }
  };
  /** Distance between triangle i of A and triangle j of B (records the best; finds crossings). */
  const pair = (i: number, j: number) => {
    const oa = i * 9;
    const ob = j * 9;
    // cheap reject: triangle boxes at least as far apart as the best distance so far
    let gap = 0;
    for (let k = 0; k < 3; k++) {
      const amin = Math.min(CA[oa + k], CA[oa + 3 + k], CA[oa + 6 + k]);
      const amax = Math.max(CA[oa + k], CA[oa + 3 + k], CA[oa + 6 + k]);
      const bmin = Math.min(CB[ob + k], CB[ob + 3 + k], CB[ob + 6 + k]);
      const bmax = Math.max(CB[ob + k], CB[ob + 3 + k], CB[ob + 6 + k]);
      const d = Math.max(0, amin - bmax, bmin - amax);
      gap += d * d;
    }
    if (gap > best2 || (gap === best2 && best2 > 0)) return;
    if (gap === 0)
      for (let k = 0; k < 3; k++) {
        const ka = oa + k * 3;
        const na = oa + ((k + 1) % 3) * 3;
        if (
          segmentCrossesTriangle(
            CB,
            ob,
            CA[ka],
            CA[ka + 1],
            CA[ka + 2],
            CA[na] - CA[ka],
            CA[na + 1] - CA[ka + 1],
            CA[na + 2] - CA[ka + 2],
            hit,
          )
        ) {
          crossing = [hit[0], hit[1], hit[2]];
          return;
        }
        const kb = ob + k * 3;
        const nb = ob + ((k + 1) % 3) * 3;
        if (
          segmentCrossesTriangle(
            CA,
            oa,
            CB[kb],
            CB[kb + 1],
            CB[kb + 2],
            CB[nb] - CB[kb],
            CB[nb + 1] - CB[kb + 1],
            CB[nb + 2] - CB[kb + 2],
            hit,
          )
        ) {
          crossing = [hit[0], hit[1], hit[2]];
          return;
        }
      }
    // edge pairs
    for (let k = 0; k < 3; k++) {
      const ka = oa + k * 3;
      const na = oa + ((k + 1) % 3) * 3;
      for (let l = 0; l < 3; l++) {
        const kb = ob + l * 3;
        const nb = ob + ((l + 1) % 3) * 3;
        const d2 = segmentPair(
          CA[ka],
          CA[ka + 1],
          CA[ka + 2],
          CA[na] - CA[ka],
          CA[na + 1] - CA[ka + 1],
          CA[na + 2] - CA[ka + 2],
          CB[kb],
          CB[kb + 1],
          CB[kb + 2],
          CB[nb] - CB[kb],
          CB[nb + 1] - CB[kb + 1],
          CB[nb + 2] - CB[kb + 2],
          seg,
        );
        take(d2, seg[0], seg[1], seg[2], seg[3], seg[4], seg[5]);
      }
    }
    // vertices against the other face
    for (let k = 0; k < 3; k++) {
      const va = oa + k * 3;
      closestPointOnTriangle(
        CA[va],
        CA[va + 1],
        CA[va + 2],
        CB[ob],
        CB[ob + 1],
        CB[ob + 2],
        CB[ob + 3],
        CB[ob + 4],
        CB[ob + 5],
        CB[ob + 6],
        CB[ob + 7],
        CB[ob + 8],
        tmp,
      );
      take(
        (tmp[0] - CA[va]) ** 2 + (tmp[1] - CA[va + 1]) ** 2 + (tmp[2] - CA[va + 2]) ** 2,
        CA[va],
        CA[va + 1],
        CA[va + 2],
        tmp[0],
        tmp[1],
        tmp[2],
      );
      const vb = ob + k * 3;
      closestPointOnTriangle(
        CB[vb],
        CB[vb + 1],
        CB[vb + 2],
        CA[oa],
        CA[oa + 1],
        CA[oa + 2],
        CA[oa + 3],
        CA[oa + 4],
        CA[oa + 5],
        CA[oa + 6],
        CA[oa + 7],
        CA[oa + 8],
        tmp,
      );
      take(
        (tmp[0] - CB[vb]) ** 2 + (tmp[1] - CB[vb + 1]) ** 2 + (tmp[2] - CB[vb + 2]) ** 2,
        tmp[0],
        tmp[1],
        tmp[2],
        CB[vb],
        CB[vb + 1],
        CB[vb + 2],
      );
    }
  };
  const a = A.bvh;
  const b = B.bvh;
  /** Sum of the edge lengths of a node's box (its size, to pick the node to split). */
  const sizeOf = (t: BVH, n: number) => {
    const o = n * 6;
    return (
      t.bounds[o + 3] -
      t.bounds[o] +
      (t.bounds[o + 4] - t.bounds[o + 1]) +
      (t.bounds[o + 5] - t.bounds[o + 2])
    );
  };
  // node pairs to visit with their box gap, nearest popped first
  const stack: number[] = [0, 0, nodeGap2(a, 0, b, 0)];
  while (stack.length && !crossing) {
    const g = stack.pop()!;
    const j = stack.pop()!;
    const i = stack.pop()!;
    // once touching, only overlapping boxes can still hold a crossing
    if (g > best2 || (g === best2 && best2 > 0)) continue;
    const leafA = a.count[i] > 0;
    const leafB = b.count[j] > 0;
    if (leafA && leafB) {
      for (let x = a.child[i]; x < a.child[i] + a.count[i] && !crossing; x++)
        for (let y = b.child[j]; y < b.child[j] + b.count[j] && !crossing; y++) pair(a.prims[x], b.prims[y]);
      continue;
    }
    // descend into the bigger box (or the one that is not a leaf)
    const splitA = leafB || (!leafA && sizeOf(a, i) >= sizeOf(b, j));
    const a0 = splitA ? a.child[i] : i;
    const a1 = splitA ? a0 + 1 : i;
    const b0 = splitA ? j : b.child[j];
    const b1 = splitA ? j : b0 + 1;
    const g0 = nodeGap2(a, a0, b, b0);
    const g1 = nodeGap2(a, a1, b, b1);
    // the farther pair goes first so the nearer one is visited next
    if (g0 <= g1) {
      if (g1 <= best2) stack.push(a1, b1, g1);
      if (g0 <= best2) stack.push(a0, b0, g0);
    } else {
      if (g0 <= best2) stack.push(a0, b0, g0);
      if (g1 <= best2) stack.push(a1, b1, g1);
    }
  }
  if (crossing) {
    const c = crossing as Vec3;
    return { distance: 0, pointA: c, pointB: [c[0], c[1], c[2]], intersecting: true };
  }
  if (!Number.isFinite(best2)) return null;
  return { distance: Math.sqrt(best2), pointA: pa, pointB: pb, intersecting: false };
}

/**
 * Closest distance between the surfaces of two transformed meshes (or groups of meshes, e.g. the
 * instances of a collection), see `triangleSetDistance`. Null when either has no faces.
 */
export function meshDistance(
  a: MeshPart | readonly MeshPart[],
  b: MeshPart | readonly MeshPart[],
): MeshDistance | null {
  return triangleSetDistance(new WorldTriangles(a), new WorldTriangles(b));
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

const UP: Vec3 = [0, 0, 1];
const DOWN: Vec3 = [0, 0, -1];

/**
 * Vertical offset that makes geometry rest on the surfaces beneath it. `points` are the world-space
 * vertices of the geometry (or just its origin). For every footprint column the supporting surface
 * is, in this order:
 *  1. the first surface below the top of the geometry whose outside faces up, so geometry hanging
 *     in the air drops down and geometry sunk into a surface is lifted out of it, while surfaces
 *     above the geometry (a table top over a stool) are ignored;
 *  2. where the column instead starts inside a solid, or under a surface whose outside faces up
 *     (buried: under a terrain, inside a rock), the surface above it: the geometry is lifted out;
 *  3. a surface below that faces down (flipped normals);
 *  4. with `groundPlane`, the plane z = 0 (which also lifts geometry that is below it).
 * When the geometry's own surface is given, rays also go up from every target vertex under the
 * footprint onto it (lowest first, following the geometry as it is lifted), so peaks between the
 * geometry's vertices are found too. The largest required offset wins. Null when nothing supports
 * the geometry. (Like every vertex-based test, a ridge or spike thinner than the vertex spacing of
 * both meshes, with no vertex inside the other mesh, can go unnoticed.)
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
  /** Supporting surface of the column through (x, y) (see above). */
  const support = (x: number, y: number): { z: number; n: Vec3; target: RaycastTarget | null } | null => {
    const below = targets.cast([x, y, top], DOWN);
    if (below && below.normal[2] > 0) return { z: below.point[2], n: below.normal, target: below.target };
    const above = targets.cast([x, y, top], UP);
    if (above && above.normal[2] > 0) return { z: above.point[2], n: above.normal, target: above.target };
    if (below) return { z: below.point[2], n: upward(below.normal), target: below.target };
    return groundPlane ? { z: 0, n: [0, 0, 1], target: null } : null;
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
    const s = support(x, y);
    if (s) consider(s.z - z, [x, y, s.z], s.n, s.target);
  }
  if (geometry && geometry.size > 0) {
    // target vertices under the footprint, lowest first: a vertex matters while it is below the
    // top of the geometry at its (lifted) position, and lifting brings higher ones into reach
    const from = b.min[2] - eps;
    const reach = top - from + eps;
    const all = targets.targets();
    const boxes = targets.boxes();
    const cand: { x: number; y: number; z: number; t: RaycastTarget }[] = [];
    for (let k = 0; k < all.length; k++) {
      const box = boxes[k];
      if (box.max[0] < b.min[0] || box.min[0] > b.max[0]) continue;
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
        if (!Number.isFinite(z) || x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1]) continue;
        cand.push({ x, y, z, t });
      }
    }
    cand.sort((p, q) => p.z - q.z);
    for (const { x, y, z, t } of cand) {
      const lift = best ? Math.max(0, (best as DropResult).dz) : 0;
      if (!(z < top + lift)) break;
      const hit = geometry.cast([x, y, from], UP, reach);
      if (hit) consider(z - hit.point[2], [x, y, z], upward(hit.normal), t);
    }
  }
  return best;
}
